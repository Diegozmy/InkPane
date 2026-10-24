#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "inkpane_board.h"
#include "inkpane_epd.h"
#include "inkpane_model.h"
#include "inkpane_net.h"
#include "inkpane_prov.h"
#include "inkpane_ui.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "inkpane";
#define FIRMWARE_VERSION "0.1.0"

#define JSON_ARENA_SIZE (1024 * 1024)
#define HTTP_BODY_SIZE (512 * 1024)
#define PERSIST_MAGIC 0x494E4B50u

typedef struct {
    uint32_t magic;
    int64_t next_net_epoch;
    int64_t last_net_epoch;
    int partial_count;
    int fail_count;
    /* Seconds until the next network attempt after a failure. Persisted in RTC
     * RAM because it also drives the sleep length when the RTC is not set. */
    int retry_seconds;
    int last_date_key;
    int tz_offset_minutes;
    int clock_x;
    int clock_y;
    int clock_w;
    int clock_h;
    bool clock_enabled;
    bool auth_error;
    /* ALDO3 stayed powered across the last deep sleep, so the panel controller
     * was never reset and can partial-refresh on the next wake. */
    bool panel_warm;
    /* Signature of the failure page currently on screen, so repeated failures
     * do not trigger a full-screen flash every retry. */
    uint32_t notice_signature;
    bool notice_shown;
    /* Zoom view: -1 = full overview, 0..5 = full-screen zoomed module id.
     * Persisted so button wakes resume from the same view instead of
     * snapping back to the overview every time. */
    int zoomed_module;
} persist_t;

static RTC_DATA_ATTR persist_t s_persist;

static uint8_t *s_framebuffer;
static char *s_json_arena;
static char *s_http_body;
static inkpane_screen_t *s_screen;

static void nvs_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

static int date_key_of(const inkpane_datetime_t *dt)
{
    return dt->year * 10000 + dt->month * 100 + dt->day;
}

static bool read_clock(inkpane_datetime_t *dt)
{
    if (!inkpane_board_time_valid()) {
        return false;
    }
    return inkpane_board_time_get(dt) == ESP_OK;
}

static void clock_from_datetime(const inkpane_datetime_t *dt, inkpane_clock_t *clock)
{
    memset(clock, 0, sizeof(*clock));
    clock->valid = true;
    clock->hour = dt->hour;
    clock->minute = dt->minute;
    clock->month = dt->month;
    clock->day = dt->day;
    clock->weekday = inkpane_weekday_of_date(dt->year, dt->month, dt->day);
    snprintf(clock->weekday_label, sizeof(clock->weekday_label), "%s",
             inkpane_weekday_label(clock->weekday));
    inkpane_date_label(dt->year, dt->month, dt->day, clock->date_label,
                       sizeof(clock->date_label));
}

static const inkpane_rect_t *clock_rect(const inkpane_config_t *config)
{
    static inkpane_rect_t rect;
    (void)config;
    if (s_persist.clock_enabled && s_persist.clock_w >= 80 && s_persist.clock_h >= 48) {
        rect.x = s_persist.clock_x;
        rect.y = s_persist.clock_y;
        rect.w = s_persist.clock_w;
        rect.h = s_persist.clock_h;
        rect.enabled = true;
        rect.present = true;
        return &rect;
    }
    return NULL;
}

static unsigned status_flags(void)
{
    unsigned status = 0;
    if (s_persist.auth_error) {
        status |= INKPANE_STATUS_AUTH;
    }
    if (s_persist.fail_count >= 3) {
        status |= INKPANE_STATUS_OFFLINE;
    }
    int battery = inkpane_board_battery_percent();
    if (battery >= 0 && battery < 20) {
        status |= INKPANE_STATUS_LOW_BATTERY;
    }
    return status;
}

/** Drop the cached ETag so the next request always gets a full 200 payload. */
static void clear_saved_etag(inkpane_config_t *config)
{
    config->etag[0] = '\0';
    inkpane_config_save_etag("");
}

/**
 * Below 20% extend the network interval to at least 2 hours. Applied to both
 * 200 and 304 responses: a 304 still has to move next_net_epoch forward.
 */
static void apply_battery_stretch(int64_t now_epoch)
{
    if (now_epoch <= 0) {
        return;
    }
    int battery = inkpane_board_battery_percent();
    if (battery < 0 || battery >= 20) {
        return;
    }
    int64_t stretched = now_epoch + 120 * 60;
    if (s_persist.next_net_epoch < stretched) {
        s_persist.next_net_epoch = stretched;
    }
}

/**
 * Retry delay after a failed attempt: 60 s, 120 s, 180 s ... capped at ten
 * minutes or the configured refresh interval. Keeping this short matters when
 * the RTC is unset, because then the sleep length is retry_seconds (a full
 * 30-minute sleep would leave the panel on the error page far too long).
 */
static int retry_delay_seconds(const inkpane_config_t *config)
{
    int attempt = s_persist.fail_count > 0 ? s_persist.fail_count : 1;
    int delay = 60 * attempt;
    int cap = config->refresh_minutes * 60;
    if (cap > 600) {
        cap = 600;
    }
    if (delay > cap) {
        delay = cap;
    }
    return delay;
}

/**
 * The panel has no trustworthy content yet (cold boot or RTC still unset), so
 * paint an actionable full-screen page instead of leaving only a "waiting for
 * time sync" clock module. Repeated identical failures skip the repaint: a
 * full refresh every retry would flash the panel and waste power.
 */
static void show_failure_notice(const inkpane_config_t *config)
{
    const char *title;
    const char *line1;
    const char *line2;
    const char *line3;
    const char *line4;
    char service[160];
    char local[48];

    snprintf(service, sizeof(service), "服务 %s", config->api_url);
    if (s_persist.auth_error) {
        title = "设备令牌无效";
        line1 = service;
        line2 = "到控制台“屏幕与设备”重新获取令牌";
        line3 = "长按中键开机可重新配网";
        line4 = "按任意键立即重试";
    } else {
        title = "无法连接日程服务";
        char ip[24] = {0};
        if (inkpane_wifi_ip(ip, sizeof(ip)) == ESP_OK) {
            snprintf(local, sizeof(local), "本机 %s", ip);
        } else {
            snprintf(local, sizeof(local), "本机 Wi-Fi 未连接");
        }
        line1 = local;
        line2 = service;
        line3 = "确认服务已启动且监听 0.0.0.0";
        line4 = "按任意键立即重试";
    }

    uint32_t signature = 2166136261u;
    const char *parts[] = {title, line1, line2, line3, line4};
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); ++i) {
        for (const char *cursor = parts[i]; cursor != NULL && *cursor != '\0'; ++cursor) {
            signature ^= (uint32_t)(unsigned char)*cursor;
            signature *= 16777619u;
        }
    }
    if (s_persist.notice_shown && s_persist.notice_signature == signature) {
        return;
    }

    inkpane_ui_render_notice(s_framebuffer, title, line1, line2, line3, line4);
    if (inkpane_epd_show_full(s_framebuffer) == ESP_OK) {
        s_persist.notice_shown = true;
        s_persist.notice_signature = signature;
    } else {
        s_persist.panel_warm = false;
    }
}

static void refresh_clock_partial(const inkpane_config_t *config)
{
    /* The mini-module clock rectangle only exists on the overview view. While
     * the panel is zoomed into a single module there is no partial rectangle
     * to refresh, so skip to avoid touching a region that is no longer drawn. */
    if (s_persist.zoomed_module >= 0) {
        return;
    }
    inkpane_datetime_t dt;
    bool valid = read_clock(&dt);
    inkpane_clock_t clock;
    if (valid) {
        clock_from_datetime(&dt, &clock);
    } else {
        memset(&clock, 0, sizeof(clock));
    }
    const inkpane_rect_t *rect = clock_rect(config);
    if (rect == NULL) {
        return;
    }
    s_persist.partial_count++;
    inkpane_ui_render_clock(s_framebuffer, rect, &clock, status_flags());
    esp_err_t err = inkpane_epd_show_region(s_framebuffer, rect->x, rect->y, rect->w, rect->h);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "clock partial refresh failed: %s", esp_err_to_name(err));
        /* The warm-panel assumption may be wrong (rail glitch, controller
         * reset): force a cold panel init + full refresh on the next wake. */
        s_persist.panel_warm = false;
    }
}

static void update_state_after_fetch(const inkpane_screen_t *screen, const inkpane_config_t *config,
                                     int64_t now_epoch)
{
    s_persist.partial_count = 0;
    s_persist.fail_count = 0;
    s_persist.auth_error = false;
    s_persist.retry_seconds = 0;
    s_persist.notice_shown = false;
    s_persist.tz_offset_minutes = screen->utc_offset_minutes;
    s_persist.last_date_key = 0;
    if (screen->now_valid) {
        s_persist.last_date_key = date_key_of(&screen->now_local);
    }
    s_persist.next_net_epoch = now_epoch + (int64_t)screen->refresh_minutes * 60;
    s_persist.last_net_epoch = now_epoch;

    const inkpane_rect_t *clock = &screen->modules[INKPANE_MODULE_CLOCK];
    s_persist.clock_enabled = clock->present && clock->enabled;
    if (clock->present && clock->w >= 80 && clock->h >= 48) {
        s_persist.clock_x = clock->x;
        s_persist.clock_y = clock->y;
        s_persist.clock_w = clock->w;
        s_persist.clock_h = clock->h;
    }
    (void)config;
}

static void calibrate_from_date_header(const char *date_header, int tz_offset_minutes)
{
    int64_t utc_epoch = 0;
    if (date_header == NULL || !inkpane_parse_http_date(date_header, &utc_epoch)) {
        return;
    }
    int64_t local_epoch = utc_epoch + (int64_t)tz_offset_minutes * 60;
    inkpane_datetime_t dt;
    inkpane_datetime_from_local_epoch(local_epoch, &dt);
    inkpane_board_time_set(&dt);
    ESP_LOGI(TAG, "rtc calibrated from HTTP Date: %04d-%02d-%02d %02d:%02d", dt.year, dt.month,
             dt.day, dt.hour, dt.minute);
}

static void post_telemetry(const inkpane_config_t *config)
{
    inkpane_env_t env;
    bool has_env = inkpane_board_read_env(&env);
    int battery = inkpane_board_battery_percent();
    int millivolt = inkpane_board_battery_millivolt();
    int rssi = inkpane_wifi_rssi();
    uint32_t uptime = (uint32_t)(esp_timer_get_time() / 1000000);
    inkpane_http_post_telemetry(config->api_url, config->token,
                                has_env ? env.temperature_c : -999.0f,
                                has_env ? env.humidity_pct : -1.0f, battery, millivolt, rssi,
                                FIRMWARE_VERSION, uptime);
}

static bool connect_wifi(const inkpane_config_t *config)
{
    for (int attempt = 0; attempt < 2; ++attempt) {
        if (inkpane_wifi_connect(config->ssid, config->password, 10000) == ESP_OK) {
            return true;
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
    return false;
}

static void fetch_and_render(inkpane_config_t *config, bool force_full, int64_t now_epoch,
                             bool rtc_ok, const inkpane_datetime_t *dt, bool paint_notice)
{
    char etag[INKPANE_ETAG_LEN] = {0};
    char date[40] = {0};
    size_t body_length = 0;
    const char *request_etag = (force_full || !rtc_ok) ? NULL : config->etag;
    inkpane_http_result_t result = INKPANE_HTTP_FAILED;
    for (int attempt = 0; attempt < 2; ++attempt) {
        result = inkpane_http_fetch_screen(config->api_url, config->token, request_etag, s_http_body,
                                           HTTP_BODY_SIZE, &body_length, etag, sizeof(etag), date,
                                           sizeof(date));
        if (result != INKPANE_HTTP_FAILED) {
            break;
        }
        ESP_LOGW(TAG, "screen request failed, retrying once");
        vTaskDelay(pdMS_TO_TICKS(2000));
    }

    if (result == INKPANE_HTTP_OK) {
        if (!inkpane_screen_parse(s_http_body, body_length, s_screen, s_json_arena, JSON_ARENA_SIZE)) {
            ESP_LOGE(TAG, "payload parse failed (%u bytes)", (unsigned)body_length);
            s_persist.fail_count++;
            s_persist.retry_seconds = retry_delay_seconds(config);
            clear_saved_etag(config);
            return;
        }
        inkpane_ui_render_full(s_framebuffer, s_screen);
        esp_err_t err = inkpane_epd_show_full(s_framebuffer);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "display refresh failed: %s", esp_err_to_name(err));
            s_persist.fail_count++;
            s_persist.retry_seconds = retry_delay_seconds(config);
            /* Drop the warm-panel assumption too: a failed full refresh usually
             * means the controller lost its state, so the next boot re-inits it. */
            s_persist.panel_warm = false;
            clear_saved_etag(config);
            return;
        }

        /* Persist the new state only after the frame actually reached the
         * panel; otherwise keep the old ETag/match state so the next wake
         * re-fetches and repaints instead of trusting a 304. */
        if (etag[0] != '\0') {
            snprintf(config->etag, sizeof(config->etag), "%s", etag);
            inkpane_config_save_etag(etag);
        }
        if (s_screen->refresh_minutes >= 5 && s_screen->refresh_minutes <= 720) {
            config->refresh_minutes = s_screen->refresh_minutes;
        }
        config->utc_offset_minutes = s_screen->utc_offset_minutes;
        inkpane_config_save_runtime(config->refresh_minutes, config->utc_offset_minutes);

        int64_t synced_epoch = now_epoch;
        if (s_screen->now_valid) {
            inkpane_board_time_set(&s_screen->now_local);
            synced_epoch = inkpane_local_epoch(&s_screen->now_local);
        }
        update_state_after_fetch(s_screen, config, synced_epoch);
        apply_battery_stretch(synced_epoch);
        ESP_LOGI(TAG, "screen updated: %d/%d events, %d/%d courses, %d/%d todos, refresh %d min",
                 s_screen->event_count, s_screen->event_total, s_screen->course_count,
                 s_screen->course_total, s_screen->todo_count, s_screen->todo_total,
                 s_screen->refresh_minutes);
        return;
    }

    if (result == INKPANE_HTTP_NOT_MODIFIED) {
        s_persist.fail_count = 0;
        s_persist.retry_seconds = 0;
        s_persist.notice_shown = false;
        int tz = s_persist.tz_offset_minutes;
        calibrate_from_date_header(date, tz);
        int64_t base = now_epoch;
        if (base == 0 && dt != NULL) {
            base = inkpane_local_epoch(dt);
        }
        s_persist.next_net_epoch = base + (int64_t)config->refresh_minutes * 60;
        apply_battery_stretch(base);
        refresh_clock_partial(config);
        ESP_LOGI(TAG, "304 not modified");
        return;
    }

    if (result == INKPANE_HTTP_UNAUTHORIZED) {
        s_persist.auth_error = true;
        s_persist.fail_count++;
        s_persist.retry_seconds = 6 * 3600;
        s_persist.next_net_epoch = now_epoch + s_persist.retry_seconds;
        ESP_LOGW(TAG, "device token rejected; re-provision to recover");
        if (paint_notice) {
            show_failure_notice(config);
        } else {
            refresh_clock_partial(config);
        }
        return;
    }

    s_persist.fail_count++;
    int backoff = retry_delay_seconds(config);
    s_persist.retry_seconds = backoff;
    s_persist.next_net_epoch = now_epoch + backoff;
    ESP_LOGW(TAG, "network fetch failed (attempt %d), retry in %d s", s_persist.fail_count,
             backoff);
    if (paint_notice) {
        show_failure_notice(config);
    } else {
        refresh_clock_partial(config);
    }
}

/**
 * Read which of the four user buttons is still held at wake time. Only the
 * most recently pressed button may still be low when the EXT1 wake fires, so
 * a short settle delay lets the others (if any) release first. Returns the
 * GPIO number (0/4/5/6) of the first still-held button, or -1 when none is
 * held any more (e.g. a very short tap that already de-bounced away).
 */
static int detect_pressed_button(void)
{
    const int pins[] = {0, 4, 5, 6};
    /* Let any bouncing settle so multi-key holds read stable values. */
    vTaskDelay(pdMS_TO_TICKS(80));
    for (int i = 0; i < (int)(sizeof(pins) / sizeof(pins[0])); ++i) {
        if (inkpane_board_button_held(pins[i])) {
            return pins[i];
        }
    }
    return -1;
}

/**
 * Render the full-screen zoomed view for `zoomed_module` into the framebuffer.
 * Data is the cached s_screen payload; a NULL s_screen (fetch has never
 * succeeded) falls back to the RTC clock for the clock page and empty-state
 * text for the others. `zoomed_module` must be 0..INKPANE_MODULE_COUNT-1.
 */
static void render_zoomed_module(int zoomed_module)
{
    if (s_framebuffer == NULL || s_screen == NULL) {
        return;
    }
    inkpane_screen_t *screen = s_screen;
    switch (zoomed_module) {
    case INKPANE_MODULE_CLOCK: {
        inkpane_clock_t clock;
        inkpane_datetime_t dt;
        if (read_clock(&dt)) {
            clock_from_datetime(&dt, &clock);
        } else if (screen->now_valid) {
            clock_from_datetime(&screen->now_local, &clock);
        } else {
            memset(&clock, 0, sizeof(clock));
        }
        inkpane_ui_render_clock_full(s_framebuffer, &clock, status_flags());
        break;
    }
    case INKPANE_MODULE_CALENDAR:
        inkpane_ui_render_calendar_full(s_framebuffer, &screen->month);
        break;
    case INKPANE_MODULE_WEATHER:
        inkpane_ui_render_weather_full(s_framebuffer, &screen->weather);
        break;
    case INKPANE_MODULE_SCHEDULE:
        inkpane_ui_render_events_full(s_framebuffer, screen->events, screen->event_count,
                                      screen->event_total, false);
        break;
    case INKPANE_MODULE_COURSES:
        inkpane_ui_render_events_full(s_framebuffer, screen->courses, screen->course_count,
                                      screen->course_total, true);
        break;
    case INKPANE_MODULE_TODOS:
        inkpane_ui_render_todos_full(s_framebuffer, screen->todos, screen->todo_count,
                                     screen->todo_total);
        break;
    default:
        return;
    }
    if (inkpane_epd_show_full(s_framebuffer) != ESP_OK) {
        /* A failed full refresh usually means the controller lost state; the
         * next boot re-inits it (same reasoning as fetch_and_render). */
        s_persist.panel_warm = false;
    }
}

/**
 * Render the full overview (all enabled mini modules) from the cached s_screen
 * payload. Used when zooming back out of a full-screen module view.
 */
static void render_overview(void)
{
    if (s_framebuffer == NULL || s_screen == NULL) {
        return;
    }
    inkpane_ui_render_full(s_framebuffer, s_screen);
    if (inkpane_epd_show_full(s_framebuffer) != ESP_OK) {
        s_persist.panel_warm = false;
    }
}

/**
 * Handle a button-wake zoom request. Returns true when the view has already
 * been refreshed locally and the normal network path can be skipped; false
 * when the caller should fall through to the regular fetch / refresh logic.
 *
 * Button mapping (active low):
 *   GPIO 4 = previous zoomed module (cycle backwards through the enabled
 *             modules, wrapping around the ring).
 *   GPIO 6 = next zoomed module (cycle forwards through the enabled modules,
 *             wrapping around the ring).
 *   GPIO 5 = toggle between the overview and the first enabled module's zoom
 *             view.
 */
static bool handle_zoom_button(int pressed_gpio)
{
    if (pressed_gpio < 0 || s_screen == NULL) {
        return false; /* No cached payload yet; let the normal path run. */
    }

    /* Build the list of enabled module ids in canvas order so "next/prev"
     * cycles through only the modules the server actually enabled. */
    int enabled[INKPANE_MAX_MODULES];
    int enabled_count = 0;
    for (int i = 0; i < INKPANE_MAX_MODULES; ++i) {
        if (s_screen->modules[i].enabled && s_screen->modules[i].present) {
            enabled[enabled_count++] = i;
        }
    }
    if (enabled_count == 0) {
        return false; /* Nothing to zoom into; fall back to the normal view. */
    }

    int current = s_persist.zoomed_module; /* -1 = overview */
    int next_view = current;

    switch (pressed_gpio) {
    case 4: /* previous module, wrap around the ring */
        if (current < 0) {
            next_view = enabled[enabled_count - 1];
        } else {
            int index = 0;
            while (index < enabled_count - 1 && enabled[index] != current) {
                ++index;
            }
            /* Move to the previous entry in the ring; wrap to the tail. */
            next_view = enabled[(index + enabled_count - 1) % enabled_count];
        }
        break;
    case 6: /* next module, wrap around the ring */
        if (current < 0) {
            next_view = enabled[0];
        } else {
            int index = 0;
            while (index < enabled_count - 1 && enabled[index] != current) {
                ++index;
            }
            /* Move to the next entry in the ring; wrap to the head. */
            next_view = enabled[(index + 1) % enabled_count];
        }
        break;
    case 5: /* toggle: overview <-> first enabled module */
        if (current < 0) {
            next_view = enabled[0];
        } else {
            next_view = -1;
        }
        break;
    default: /* GPIO 0 or anything unexpected: no zoom action */
        return false;
    }

    s_persist.zoomed_module = next_view;
    if (next_view < 0) {
        render_overview();
    } else {
        render_zoomed_module(next_view);
    }
    return true;
}

static void wait_for_buttons_released(void)
{
    const int pins[] = {0, 4, 5, 6};
    for (int attempt = 0; attempt < 50; ++attempt) {
        bool held = false;
        for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); ++i) {
            if (inkpane_board_button_held(pins[i])) {
                held = true;
                break;
            }
        }
        if (!held) {
            return;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static void go_to_sleep(const inkpane_config_t *config, bool rtc_ok, const inkpane_datetime_t *dt)
{
    /* ALDO3 (panel power) intentionally stays on: the controller keeps its RAM
     * and register state while the MCU is in deep sleep, so the next wake can
     * partial-refresh the clock without a hardware reset and without the
     * ~2 s black flash of a cold panel init. */
    inkpane_wifi_disconnect();
    /* Avoid an immediate EXT1 wake loop when a button is still held. */
    wait_for_buttons_released();

    uint64_t sleep_seconds;
    if (!rtc_ok || dt == NULL) {
        /* No RTC to compute an absolute deadline: retry after the failure
         * backoff instead of always sleeping a full refresh interval. */
        sleep_seconds = s_persist.retry_seconds > 0 ? (uint64_t)s_persist.retry_seconds
                                                    : (uint64_t)config->refresh_minutes * 60;
    } else {
        int seconds = 60 - dt->second + 1;
        int64_t now_epoch = inkpane_local_epoch(dt);
        if (s_persist.next_net_epoch > now_epoch) {
            int64_t delta = s_persist.next_net_epoch - now_epoch;
            if (delta < seconds) {
                seconds = (int)delta;
            }
        }
        if (seconds < 5) {
            seconds = 5;
        }
        sleep_seconds = (uint64_t)seconds;
    }
    ESP_LOGI(TAG, "deep sleep for %llu s", (unsigned long long)sleep_seconds);
    esp_sleep_enable_timer_wakeup(sleep_seconds * 1000000ULL);
    inkpane_board_configure_button_wakeup();
    esp_deep_sleep_start();
}

static bool provisioning_requested(bool cold_boot, const inkpane_config_t *config)
{
    if (!config->provisioned) {
        return true;
    }
    if (!cold_boot) {
        return false;
    }
    if (!inkpane_board_button_held(5)) {
        return false;
    }
    /* Hold the middle button while powering on to re-provision. */
    for (int i = 0; i < 20; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
        if (!inkpane_board_button_held(5)) {
            return false;
        }
    }
    return true;
}

static uint32_t wakeup_causes(void)
{
#if ESP_IDF_VERSION_MAJOR >= 6
    return esp_sleep_get_wakeup_causes();
#else
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();
    return cause == ESP_SLEEP_WAKEUP_UNDEFINED ? 0 : (1u << (unsigned)cause);
#endif
}

void app_main(void)
{
    uint32_t causes = wakeup_causes();
    bool cold_boot = causes == 0;
    bool button_wake = (causes & (1u << ESP_SLEEP_WAKEUP_EXT1)) != 0;
    bool deep_sleep_reset = esp_reset_reason() == ESP_RST_DEEPSLEEP;

    nvs_init();
    bool keep_state = deep_sleep_reset && s_persist.magic == PERSIST_MAGIC;
    if (!keep_state) {
        memset(&s_persist, 0, sizeof(s_persist));
        s_persist.magic = PERSIST_MAGIC;
        s_persist.tz_offset_minutes = 480;
        s_persist.zoomed_module = -1;
    }
    /* A warm panel means ALDO3 stayed powered through deep sleep and the
     * controller was never reset, so no panel init / full repaint is needed. */
    bool warm_boot = keep_state && s_persist.panel_warm;

    ESP_LOGI(TAG, "boot: causes=0x%08x cold=%d button=%d reason=%d", causes, cold_boot, button_wake,
             (int)esp_reset_reason());

    if (inkpane_board_init() != ESP_OK) {
        ESP_LOGE(TAG, "board init failed");
    }

    s_framebuffer = heap_caps_malloc(INKPANE_EPD_FB_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_json_arena = heap_caps_malloc(JSON_ARENA_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_http_body = heap_caps_malloc(HTTP_BODY_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_screen = heap_caps_malloc(sizeof(inkpane_screen_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s_framebuffer == NULL || s_json_arena == NULL || s_http_body == NULL || s_screen == NULL) {
        ESP_LOGE(TAG, "PSRAM allocation failed");
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_restart();
    }
    memset(s_framebuffer, 0xFF, INKPANE_EPD_FB_SIZE);

    if (inkpane_ui_init(NULL, 0) != ESP_OK) {
        ESP_LOGE(TAG, "font init failed");
    }

    inkpane_config_t config;
    inkpane_config_load(&config);

    esp_err_t epd = inkpane_epd_init(warm_boot);
    if (epd != ESP_OK) {
        ESP_LOGE(TAG, "epd init failed: %s", esp_err_to_name(epd));
        s_persist.panel_warm = false;
    } else {
        s_persist.panel_warm = true;
    }

    if (provisioning_requested(cold_boot, &config)) {
        char ssid[40];
        inkpane_prov_ap_ssid(ssid, sizeof(ssid));
        if (s_framebuffer != NULL) {
            inkpane_ui_render_setup(s_framebuffer, ssid, "http://192.168.4.1");
            inkpane_epd_show_full(s_framebuffer);
        }
        inkpane_prov_run(ssid);
    }

    inkpane_datetime_t dt = {0};
    bool rtc_ok = read_clock(&dt);
    int64_t now_epoch = rtc_ok ? inkpane_local_epoch(&dt) : 0;
    int date_key = rtc_ok ? date_key_of(&dt) : 0;
    bool date_changed = rtc_ok && s_persist.last_date_key != 0 && date_key != s_persist.last_date_key;

    const int full_interval = CONFIG_INKPANE_FULL_REFRESH_INTERVAL;
    bool network_due = !rtc_ok || s_persist.next_net_epoch == 0 || now_epoch >= s_persist.next_net_epoch;
    bool force_full = cold_boot || !warm_boot || epd != ESP_OK || date_changed ||
                      (network_due && s_persist.partial_count >= full_interval);

    /* After a cold boot the clock rectangle is unknown until the first 200. */
    if (s_persist.clock_enabled == false && s_persist.clock_w == 0) {
        s_persist.clock_enabled = true;
        const inkpane_rect_t *fallback = &inkpane_default_rects()[INKPANE_MODULE_CLOCK];
        s_persist.clock_x = fallback->x;
        s_persist.clock_y = fallback->y;
        s_persist.clock_w = fallback->w;
        s_persist.clock_h = fallback->h;
    }

    /* Button wake: check whether a zoom-control button is still held. If so,
     * refresh the view locally from the cached payload and only touch the
     * network when it was already due — a plain view switch should not cost
     * a Wi-Fi handshake every time. */
    bool zoom_handled = false;
    if (button_wake) {
        int pressed_gpio = detect_pressed_button();
        zoom_handled = handle_zoom_button(pressed_gpio);
        if (zoom_handled) {
            ESP_LOGI(TAG, "zoom view %d via gpio %d", s_persist.zoomed_module, pressed_gpio);
        }
    }
    /* A pure zoom view switch (button 4/5/6) does not force the network. The
     * regular fetch still happens whenever it was already due, cold-booted,
     * or the panel needs a forced full repaint. */
    bool need_network = !zoom_handled || cold_boot || network_due || date_changed || force_full;

    if (need_network) {
        bool paint_notice = cold_boot || !rtc_ok;
        if (connect_wifi(&config)) {
            char ip[24] = {0};
            if (inkpane_wifi_ip(ip, sizeof(ip)) == ESP_OK) {
                ESP_LOGI(TAG, "wifi ip %s -> api %s", ip, config.api_url);
            }
            fetch_and_render(&config, force_full, now_epoch, rtc_ok, &dt, paint_notice);
#if CONFIG_INKPANE_TELEMETRY
            if (!s_persist.auth_error) {
                post_telemetry(&config);
            }
#endif
        } else {
            s_persist.fail_count++;
            int backoff = retry_delay_seconds(&config);
            s_persist.retry_seconds = backoff;
            s_persist.next_net_epoch = now_epoch + backoff;
            ESP_LOGW(TAG, "wifi unavailable (attempt %d), retry in %d s", s_persist.fail_count,
                     backoff);
            if (paint_notice) {
                show_failure_notice(&config);
            } else if (s_persist.zoomed_module < 0) {
                refresh_clock_partial(&config);
            }
        }
        inkpane_wifi_disconnect();
    } else if (s_persist.zoomed_module < 0) {
        /* Timer-driven overview tick: keep the mini clock rectangle fresh.
         * While zoomed the panel already shows the full-screen module view. */
        refresh_clock_partial(&config);
    }

    rtc_ok = read_clock(&dt);
    go_to_sleep(&config, rtc_ok, rtc_ok ? &dt : NULL);
}
