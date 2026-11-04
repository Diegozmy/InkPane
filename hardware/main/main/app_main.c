#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_attr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_idf_version.h"
#include "esp_log.h"
#include "esp_mac.h"
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
#include "inkpane_snapshot.h"
#include "inkpane_ui.h"
#include "inkpane_voice.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "inkpane";
#define FIRMWARE_VERSION "0.1.0"

#define JSON_ARENA_SIZE (1024 * 1024)
#define HTTP_BODY_SIZE (512 * 1024)
#define PERSIST_MAGIC 0x494E4B50u
/* Serial debug session: how long the device idles before sleeping again. */
#define DEBUG_IDLE_SECONDS 300

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
/* Condensed copy of the last rendered screen, kept in RTC slow memory so a
 * deep-sleep button wake can re-render zoomed views offline. */
static RTC_DATA_ATTR inkpane_snapshot_t s_snapshot;

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

/** Fill the cached-screen clock fields straight from the RTC (offline render). */
static void fill_screen_now_from_rtc(inkpane_screen_t *screen)
{
    inkpane_datetime_t dt;
    if (!read_clock(&dt)) {
        return;
    }
    screen->now_valid = true;
    screen->now_local = dt;
    screen->now_hour = dt.hour;
    screen->now_minute = dt.minute;
    snprintf(screen->now_time, sizeof(screen->now_time), "%02d:%02d", dt.hour, dt.minute);
    snprintf(screen->now_date, sizeof(screen->now_date), "%04d-%02d-%02d", dt.year, dt.month,
             dt.day);
    snprintf(screen->now_weekday, sizeof(screen->now_weekday), "%s",
             inkpane_weekday_label(inkpane_weekday_of_date(dt.year, dt.month, dt.day)));
    inkpane_date_label(dt.year, dt.month, dt.day, screen->now_date_label,
                       sizeof(screen->now_date_label));
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
    inkpane_voice_snapshot_t voice;
    inkpane_voice_get_snapshot(&voice);
    if (voice.muted) {
        status |= INKPANE_STATUS_VOICE_MUTED;
    }
    if (voice.state == INKPANE_VOICE_ERROR) {
        status |= INKPANE_STATUS_VOICE_ERROR;
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

/* Rendering entry points, defined after the fetch path that uses them. */
static esp_err_t render_zoomed_module(int zoomed_module);
static esp_err_t render_overview(void);

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
        /* Keep a zoomed view across scheduled refreshes: while the panel is
         * zoomed into a module, repaint that module instead of the overview.
         * If the module vanished from the new layout, fall back to overview. */
        int zoom_view = s_persist.zoomed_module;
        if (zoom_view < 0 || zoom_view >= INKPANE_MODULE_COUNT ||
            !s_screen->modules[zoom_view].enabled || !s_screen->modules[zoom_view].present) {
            zoom_view = -1;
            s_persist.zoomed_module = -1;
        }
        esp_err_t err;
        if (zoom_view >= 0) {
            err = render_zoomed_module(zoom_view);
        } else {
            inkpane_ui_render_full(s_framebuffer, s_screen);
            err = inkpane_epd_show_full(s_framebuffer);
        }
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

        /* The frame reached the panel; cache the payload for offline button
         * zooms. Snapshot and ETag both commit only after a successful refresh. */
        inkpane_snapshot_capture(&s_snapshot, s_screen);

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
        if (!inkpane_snapshot_valid(&s_snapshot)) {
            /* The ETag survived (e.g. firmware update) but the RTC snapshot
             * did not: drop it so the next cycle gets a full 200 payload and
             * rebuilds the snapshot. */
            clear_saved_etag(config);
        }
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
 * Data comes from s_screen, which is rebuilt from the RTC zoom snapshot
 * captured after the last successful full refresh; with no snapshot the screen
 * is zeroed and the renderers show their empty states. Clock data is read
 * fresh from the RTC. `zoomed_module` must be 0..INKPANE_MODULE_COUNT-1.
 * Returns the panel refresh result so callers can react to a failure.
 */
static esp_err_t render_zoomed_module(int zoomed_module)
{
    if (s_framebuffer == NULL || s_screen == NULL) {
        return ESP_ERR_INVALID_STATE;
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
        return ESP_ERR_INVALID_ARG;
    }
    return inkpane_epd_show_full(s_framebuffer);
}

/**
 * Render the full overview (all enabled mini modules) from the cached s_screen
 * payload rebuilt from the RTC snapshot. Used when zooming back out of a
 * full-screen module view. Returns the panel refresh result.
 */
static esp_err_t render_overview(void)
{
    if (s_framebuffer == NULL || s_screen == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    inkpane_ui_render_full(s_framebuffer, s_screen);
    return inkpane_epd_show_full(s_framebuffer);
}

/** Bitmask of enabled+present modules, for logs and diagnostics. */
static int zoom_enabled_mask(void)
{
    if (s_screen == NULL) {
        return 0;
    }
    int mask = 0;
    for (int i = 0; i < INKPANE_MAX_MODULES; ++i) {
        if (s_screen->modules[i].enabled && s_screen->modules[i].present) {
            mask |= 1 << i;
        }
    }
    return mask;
}

/**
 * Handle a button-wake zoom request. Returns true when the view has already
 * been refreshed locally and the normal network path can be skipped; false
 * when the caller should fall through to the regular fetch / refresh logic.
 *
 * Data comes from s_screen, rebuilt from the RTC zoom snapshot captured after
 * the last successful full refresh — so switching views costs no network and
 * no Wi-Fi handshake. Without a snapshot (first run, re-provision) the screen
 * is zeroed, nothing is enabled, and the request falls back to the network.
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
        ESP_LOGW(TAG, "zoom: gpio %d but no enabled module (snapshot empty?)", pressed_gpio);
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

    ESP_LOGI(TAG, "zoom: gpio=%d %d -> %d (enabled=0x%02x, snapshot=%d)", pressed_gpio, current,
             next_view, zoom_enabled_mask(), (int)inkpane_snapshot_valid(&s_snapshot));
    if (next_view == current) {
        /* Only one module is enabled: prev/next would repaint the very same
         * page. Skip the full refresh instead of flashing for nothing. */
        ESP_LOGI(TAG, "zoom: nothing to switch to (%d enabled module(s))", enabled_count);
        return true;
    }

    s_persist.zoomed_module = next_view;
    esp_err_t rendered =
        next_view < 0 ? render_overview() : render_zoomed_module(next_view);
    if (rendered != ESP_OK) {
        /* A failed full refresh usually means the controller lost state; force
         * the regular network path so the next attempt repaints the panel. */
        s_persist.panel_warm = false;
        return false;
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

/**
 * Hold the roller "down" key (GPIO 6) for two seconds while powering on to
 * request the serial debug session. Cold boot only: while deep sleeping the
 * device has no serial link, so this is the way to get a monitor that survives
 * several button presses.
 */
static bool debug_power_hold_requested(void)
{
    if (!inkpane_board_button_held(6)) {
        return false;
    }
    for (int i = 0; i < 20; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
        if (!inkpane_board_button_held(6)) {
            return false;
        }
    }
    return true;
}

/**
 * Serial debug session: instead of deep sleeping, stay awake and poll the
 * roller keys so a serial monitor can follow every zoom decision:
 *   GPIO 4 / 6 = previous / next module, GPIO 5 = overview <-> first module,
 *   BOOT (GPIO 0) held 3 s = back to deep sleep, 5 min idle = deep sleep.
 * Enter it by holding roller "down" while powering on, or by waking the device
 * with BOOT held (see app_main). The regular refresh cycle already ran, so the
 * RTC snapshot is populated and zoom behaves exactly like a normal wake.
 */
static void debug_session_loop(void)
{
    ESP_LOGI(TAG, "DEBUG session: awake; snapshot=%d zoomed=%d enabled=0x%02x",
             (int)inkpane_snapshot_valid(&s_snapshot), s_persist.zoomed_module,
             zoom_enabled_mask());
    ESP_LOGI(TAG, "DEBUG session: roller keys polled, hold BOOT 3 s to sleep, %d s idle timeout",
             DEBUG_IDLE_SECONDS);
    int idle = 0;
    while (idle < DEBUG_IDLE_SECONDS) {
        int pressed = -1;
        const int pins[] = {0, 4, 5, 6};
        for (size_t i = 0; i < sizeof(pins) / sizeof(pins[0]); ++i) {
            if (inkpane_board_button_held(pins[i])) {
                pressed = pins[i];
                break;
            }
        }
        if (pressed == 0) {
            int held_ms = 0;
            while (inkpane_board_button_held(0) && held_ms < 3000) {
                vTaskDelay(pdMS_TO_TICKS(100));
                held_ms += 100;
            }
            if (held_ms >= 3000) {
                ESP_LOGI(TAG, "DEBUG session: BOOT held -> next wake deep sleeps");
                return;
            }
            wait_for_buttons_released();
            idle = 0;
            continue;
        }
        if (pressed > 0) {
            bool handled = handle_zoom_button(pressed);
            ESP_LOGI(TAG, "DEBUG gpio=%d handled=%d zoomed=%d enabled=0x%02x", pressed,
                     (int)handled, s_persist.zoomed_module, zoom_enabled_mask());
            wait_for_buttons_released();
            idle = 0;
            continue;
        }
        vTaskDelay(pdMS_TO_TICKS(100));
        ++idle;
    }
    ESP_LOGI(TAG, "DEBUG session: idle timeout, deep sleeping");
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
        ESP_LOGI(TAG, "provisioning: required (no saved config)");
        return true;
    }
    if (!cold_boot) {
        return false;
    }

    ESP_LOGI(TAG, "provisioning: middle-key GPIO 5 level=%d",
             inkpane_board_button_held(5));
    if (!inkpane_board_button_held(5)) {
        return false;
    }

    /* Hold the middle button while powering on to re-provision. */
    for (int i = 0; i < 20; ++i) {
        vTaskDelay(pdMS_TO_TICKS(100));
        if (!inkpane_board_button_held(5)) {
            ESP_LOGI(TAG, "provisioning: middle-key released before 2 s (sample %d)", i + 1);
            return false;
        }
    }
    ESP_LOGI(TAG, "provisioning: middle-key held for 2 s");
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

#if CONFIG_INKPANE_POWER_MODE_LOW_POWER
static void low_power_cycle(void)
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
        inkpane_snapshot_invalidate(&s_snapshot);
    }
    /* A warm panel means ALDO3 stayed powered through deep sleep and the
     * controller was never reset, so no panel init / full repaint is needed. */
    bool warm_boot = keep_state && s_persist.panel_warm;

    ESP_LOGI(TAG, "boot: causes=0x%08x cold=%d button=%d reason=%d", causes, cold_boot, button_wake,
             (int)esp_reset_reason());

    if (inkpane_board_init() != ESP_OK) {
        ESP_LOGE(TAG, "board init failed");
    }

    /* Serial debug session: holding the roller "down" key while powering on
     * keeps the device awake after this cycle (see debug_session_loop). */
    bool debug_session = false;
    if (cold_boot && debug_power_hold_requested()) {
        debug_session = true;
        ESP_LOGI(TAG, "DEBUG session requested (roller down held at power-on)");
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

    /* s_screen lives in PSRAM and holds garbage after deep sleep; rebuild it
     * from the RTC zoom snapshot. Without a valid snapshot the screen is left
     * zeroed (nothing enabled) and button zooms fall back to the network. */
    bool snapshot_ok = inkpane_snapshot_restore(&s_snapshot, s_screen);
    if (snapshot_ok) {
        fill_screen_now_from_rtc(s_screen);
    }
    ESP_LOGI(TAG, "zoom snapshot %s", snapshot_ok ? "restored" : "empty");

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
        if (pressed_gpio == 0) {
            /* BOOT held at wake: stay awake for the serial debug session. */
            debug_session = true;
            ESP_LOGI(TAG, "DEBUG session requested (BOOT held at wake)");
        }
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

    if (debug_session) {
        debug_session_loop();
    }

    rtc_ok = read_clock(&dt);
    go_to_sleep(&config, rtc_ok, rtc_ok ? &dt : NULL);
}

void app_main(void)
{
    low_power_cycle();
}
#endif /* CONFIG_INKPANE_POWER_MODE_LOW_POWER */

/* ------------------------------------------------------------------ */
/* Resident mode: always-on dashboard + voice assistant                */
/* ------------------------------------------------------------------ */

#if !CONFIG_INKPANE_POWER_MODE_LOW_POWER

#define RESIDENT_TICK_MS 20
#define RESIDENT_BATTERY_CHECK_MS (60 * 1000)
#define RESIDENT_WIFI_RETRY_MS (30 * 1000)
#define RESIDENT_VOICE_RENDER_MS 1500
#define RESIDENT_ERROR_PAGE_MS (15 * 1000)
#define RESIDENT_ACTIVATION_PAGE_MS (5 * 60 * 1000)
/* Keep the finished answer on screen a few seconds before the dashboard returns. */
#define RESIDENT_VOICE_LINGER_MS (6 * 1000)

/* Field diagnostics: a low-priority task keeps logging while the main loop is
 * stuck, so "no serial output" can be told apart from "main task blocked". */
#define RESIDENT_DIAG_TASK 1
#define RESIDENT_DIAG_PERIOD_MS (10 * 1000)
static volatile uint32_t s_main_loop_ticks;
static volatile int64_t s_main_loop_last_ms;

static void resident_diag_task(void *argument)
{
    (void)argument;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(RESIDENT_DIAG_PERIOD_MS));
        const int64_t now_ms = esp_timer_get_time() / 1000;
        ESP_LOGI(TAG, "diag: loop_ticks=%lu stalled=%d ms internal=%u psram=%u", 
                 (unsigned long)s_main_loop_ticks, (int)(now_ms - s_main_loop_last_ms),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
}

typedef struct {
    bool down;
    bool long_sent;
    int64_t down_ms;
} resident_button_t;

static resident_button_t s_buttons[4];
static bool s_dashboard_ready;
static bool s_screen_dirty;
static bool s_voice_page;
static bool s_activation_page;
static bool s_error_page;
static bool s_error_dismissed;
static int64_t s_error_until_ms;
static int64_t s_activation_until_ms;
static bool s_voice_dirty;
static uint32_t s_voice_signature;
static bool s_voice_in_turn;
static int64_t s_voice_linger_until_ms;
static int64_t s_last_voice_render_ms;
static int64_t s_last_wifi_attempt_ms = -RESIDENT_WIFI_RETRY_MS;
static int64_t s_last_battery_check_ms;
static bool s_last_network_up;
static char s_wake_words[INKPANE_VOICE_MAX_WAKE_WORDS][INKPANE_VOICE_WAKE_WORD_LEN];
static char s_device_mac[18];
static char s_firmware_version[16] = FIRMWARE_VERSION;
static char s_timezone[40];

static const int RESIDENT_BUTTON_PINS[] = {0, 4, 5, 6};

static bool voice_state_is_conversation(inkpane_voice_state_t state)
{
    return state == INKPANE_VOICE_CONNECTING || state == INKPANE_VOICE_LISTENING ||
           state == INKPANE_VOICE_THINKING || state == INKPANE_VOICE_SPEAKING;
}

static const char *voice_state_label(inkpane_voice_state_t state)
{
    switch (state) {
    case INKPANE_VOICE_OFFLINE:
        return "网络未连接";
    case INKPANE_VOICE_ACTIVATING:
        return "等待激活";
    case INKPANE_VOICE_READY:
        return "待命";
    case INKPANE_VOICE_CONNECTING:
        return "正在连接";
    case INKPANE_VOICE_LISTENING:
        return "聆听中";
    case INKPANE_VOICE_THINKING:
        return "思考中";
    case INKPANE_VOICE_SPEAKING:
        return "正在回答";
    case INKPANE_VOICE_ERROR:
        return "语音出错";
    case INKPANE_VOICE_DISABLED:
    default:
        return "未启用";
    }
}

static void resident_read_mac(void)
{
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) {
        memset(mac, 0, sizeof(mac));
    }
    snprintf(s_device_mac, sizeof(s_device_mac), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1],
             mac[2], mac[3], mac[4], mac[5]);
}

/** Full-width Chinese comma (U+FF0C) is three UTF-8 bytes. */
static bool resident_is_cjk_comma(const char *cursor)
{
    if (cursor[0] == '\0' || cursor[1] == '\0' || cursor[2] == '\0') {
        return false;
    }
    return (unsigned char)cursor[0] == 0xEF && (unsigned char)cursor[1] == 0xBC &&
           (unsigned char)cursor[2] == 0x8C;
}

/** Split the comma-separated wake word config into the array the voice API uses. */
static int resident_parse_wake_words(const char *source)
{
    int count = 0;
    const char *cursor = source != NULL ? source : "";
    while (*cursor != '\0' && count < INKPANE_VOICE_MAX_WAKE_WORDS) {
        while (*cursor == ' ' || *cursor == '\t' || *cursor == ',' || resident_is_cjk_comma(cursor)) {
            if (resident_is_cjk_comma(cursor)) {
                cursor += 3;
            } else {
                ++cursor;
            }
        }
        const char *start = cursor;
        while (*cursor != '\0' && *cursor != ',' && !resident_is_cjk_comma(cursor)) {
            ++cursor;
        }
        const char *end = cursor;
        while (end > start && (end[-1] == ' ' || end[-1] == '\t')) {
            --end;
        }
        size_t length = (size_t)(end - start);
        if (length >= INKPANE_VOICE_WAKE_WORD_LEN) {
            length = INKPANE_VOICE_WAKE_WORD_LEN - 1;
            while (length > 0 && (((unsigned char)start[length]) & 0xC0) == 0x80) {
                --length;
            }
        }
        if (length > 0) {
            memcpy(s_wake_words[count], start, length);
            s_wake_words[count][length] = '\0';
            ++count;
        }
        if (*cursor == ',') {
            ++cursor;
        } else if (resident_is_cjk_comma(cursor)) {
            cursor += 3;
        }
    }
    if (count == 0) {
        snprintf(s_wake_words[0], INKPANE_VOICE_WAKE_WORD_LEN, "你好小智");
        count = 1;
    }
    return count;
}

static void resident_build_voice_config(const inkpane_config_t *config,
                                        inkpane_voice_config_t *voice)
{
    memset(voice, 0, sizeof(*voice));
    voice->enabled = config->voice_enabled;
    voice->allow_control = config->voice_allow_control;
    voice->ota_url = config->voice_ota_url;
    voice->ws_url = config->voice_ws_url;
    voice->ws_token = config->voice_ws_token;
    voice->ws_version = config->voice_ws_version;
    voice->wake_word_count = resident_parse_wake_words(config->voice_wake_words);
    for (int i = 0; i < voice->wake_word_count; ++i) {
        voice->wake_words[i] = s_wake_words[i];
    }
    voice->wake_threshold = config->voice_wake_threshold;
    voice->volume = config->voice_volume;
    voice->device_mac = s_device_mac;
    voice->device_uuid = config->voice_uuid;
    voice->firmware_version = s_firmware_version;
    voice->timezone = s_timezone[0] != '\0' ? s_timezone : "Asia/Shanghai";
    voice->api_url = config->api_url;
    voice->api_token = config->token;
    voice->utc_offset_minutes = config->utc_offset_minutes;
}

static void resident_apply_voice_settings(const inkpane_config_t *config)
{
    inkpane_voice_config_t voice;
    resident_build_voice_config(config, &voice);
    inkpane_voice_apply_config(&voice);
}

/** Join the payload wake words back into the comma-separated NVS format. */
static void resident_join_wake_words(const inkpane_voice_settings_t *voice, char *out, size_t size)
{
    size_t used = 0;
    out[0] = '\0';
    for (int i = 0; i < voice->wake_word_count && i < INKPANE_MAX_WAKE_WORDS; ++i) {
        const char *word = voice->wake_words[i];
        if (word[0] == '\0' || size == 0) {
            continue;
        }
        int written = snprintf(out + used, size - used, "%s%s", used > 0 ? "," : "", word);
        if (written < 0 || (size_t)written >= size - used) {
            break;
        }
        used += (size_t)written;
    }
}

/**
 * Apply the voice block delivered with the screen payload. Live-tunable fields
 * (wake words, threshold, volume, allowControl) are applied immediately; a
 * change of enable state or OTA endpoint restarts the device so activation and
 * the audio engine start from a clean state.
 */
static void resident_apply_server_voice(inkpane_config_t *config)
{
    const inkpane_voice_settings_t *voice = &s_screen->voice;
    if (!voice->present) {
        return;
    }
    bool changed = false;
    bool restart = false;

    if (voice->enabled != config->voice_enabled) {
        config->voice_enabled = voice->enabled;
        changed = true;
        restart = true;
    }
    if (voice->allow_control != config->voice_allow_control) {
        config->voice_allow_control = voice->allow_control;
        changed = true;
    }
    if (voice->ota_url[0] != '\0' && strcmp(voice->ota_url, config->voice_ota_url) != 0) {
        snprintf(config->voice_ota_url, sizeof(config->voice_ota_url), "%s", voice->ota_url);
        config->voice_ws_url[0] = '\0';
        config->voice_ws_token[0] = '\0';
        config->voice_ws_version = 1;
        config->voice_activated = false;
        inkpane_config_update_voice("", "", 1, false);
        changed = true;
        restart = true;
    }
    if (voice->wake_threshold >= 0 &&
        voice->wake_threshold != config->voice_wake_threshold) {
        config->voice_wake_threshold = voice->wake_threshold;
        changed = true;
    }
    if (voice->volume >= 0 && voice->volume != config->voice_volume) {
        config->voice_volume = voice->volume;
        changed = true;
    }
    if (voice->wake_word_count > 0) {
        char words[INKPANE_WAKE_WORDS_LEN];
        resident_join_wake_words(voice, words, sizeof(words));
        if (words[0] != '\0' && strcmp(words, config->voice_wake_words) != 0) {
            snprintf(config->voice_wake_words, sizeof(config->voice_wake_words), "%s", words);
            changed = true;
        }
    }
    if (!changed) {
        return;
    }

    ESP_LOGI(TAG, "voice settings from server: enabled=%d ctrl=%d words=%s", (int)config->voice_enabled,
             (int)config->voice_allow_control, config->voice_wake_words);
    if (inkpane_config_save_voice(config) != ESP_OK) {
        ESP_LOGW(TAG, "cannot persist voice settings; keeping runtime values");
        return;
    }
    if (restart) {
        ESP_LOGW(TAG, "voice enable/OTA changed; restarting to apply");
        vTaskDelay(pdMS_TO_TICKS(300));
        esp_restart();
    }
    resident_apply_voice_settings(config);
}

/** Ask the panel for a fresh dashboard after a voice-driven mutation. */
static void resident_handle_voice_event(const inkpane_voice_event_t *event,
                                        inkpane_config_t *config)
{
    s_voice_dirty = true;
    switch (event->type) {
    case INKPANE_VOICE_EVT_SESSION:
        snprintf(config->voice_ws_url, sizeof(config->voice_ws_url), "%s", event->ws_url);
        snprintf(config->voice_ws_token, sizeof(config->voice_ws_token), "%s", event->ws_token);
        config->voice_ws_version = event->ws_version;
        config->voice_activated = event->activated;
        if (inkpane_config_update_voice(config->voice_ws_url, config->voice_ws_token,
                                        config->voice_ws_version, config->voice_activated) == ESP_OK) {
            ESP_LOGI(TAG, "voice websocket config saved (version %d)", event->ws_version);
        }
        resident_apply_voice_settings(config);
        break;
    case INKPANE_VOICE_EVT_REFRESH:
        /* The assistant changed a todo/event: force a full 200 payload so the
         * dashboard reflects it as soon as the conversation page goes away. */
        clear_saved_etag(config);
        s_screen_dirty = true;
        ESP_LOGI(TAG, "voice mutation -> screen refresh queued");
        break;
    case INKPANE_VOICE_EVT_ERROR:
        s_error_until_ms = esp_timer_get_time() / 1000 + RESIDENT_ERROR_PAGE_MS;
        break;
    default:
        break;
    }
}

static void resident_render_notice(const char *title, const char *line1, const char *line2,
                                   const char *line3)
{
    if (s_framebuffer == NULL) {
        return;
    }
    inkpane_ui_render_notice(s_framebuffer, title, line1, line2, line3, NULL);
    if (inkpane_epd_show_full(s_framebuffer) != ESP_OK) {
        s_persist.panel_warm = false;
    }
}

static void resident_render_dashboard(void)
{
    if (!s_dashboard_ready || s_screen == NULL) {
        resident_render_notice("正在连接日程服务", "设备保持常驻，请稍候", "首次连接可能需要几秒",
                               NULL);
        return;
    }
    if (s_persist.zoomed_module >= 0) {
        if (render_zoomed_module(s_persist.zoomed_module) == ESP_OK) {
            return;
        }
        s_persist.panel_warm = false;
    }
    render_overview();
}

/** FNV-1a over what the voice page shows, so identical frames are not repainted. */
static uint32_t voice_hash_text(uint32_t hash, const char *text)
{
    if (text == NULL) {
        return hash;
    }
    for (const char *cursor = text; *cursor != '\0'; ++cursor) {
        hash = (hash ^ (uint32_t)(unsigned char)*cursor) * 16777619u;
    }
    return hash;
}

static uint32_t voice_page_signature(const inkpane_voice_snapshot_t *snapshot)
{
    uint32_t hash = 2166136261u;
    hash = (hash ^ (uint32_t)snapshot->state) * 16777619u;
    hash = voice_hash_text(hash, snapshot->user_text);
    hash = (hash ^ 0x1Fu) * 16777619u;
    hash = voice_hash_text(hash, snapshot->reply_text);
    return hash;
}

static void resident_render_voice(const inkpane_voice_snapshot_t *snapshot, bool full)
{
    if (s_framebuffer == NULL) {
        return;
    }
    inkpane_voice_view_t view = {
        .state_label = voice_state_label(snapshot->state),
        .user_text = snapshot->user_text,
        .reply_text = snapshot->reply_text,
        .footer_hint = snapshot->control_allowed
                           ? "BOOT 打断 · 长按 BOOT 静音唤醒词"
                           : "BOOT 打断 · 语音修改已关闭",
    };
    inkpane_ui_render_voice(s_framebuffer, &view);
    /* The partial-refresh window proved unreliable for this page (large windows
     * came out blank or half updated), so every update is a full refresh. */
    const int64_t start_ms = esp_timer_get_time() / 1000;
    esp_err_t err = inkpane_epd_show_full(s_framebuffer);
    const int elapsed_ms = (int)(esp_timer_get_time() / 1000 - start_ms);
    ESP_LOGI(TAG, "voice page refresh (full=%d state=%d) %s in %d ms", (int)full,
             (int)snapshot->state, esp_err_to_name(err), elapsed_ms);
    if (err != ESP_OK) {
        s_persist.panel_warm = false;
    }
}

static void resident_render_activation(const inkpane_voice_snapshot_t *snapshot)
{
    if (s_framebuffer == NULL) {
        return;
    }
    inkpane_ui_render_voice_activation(s_framebuffer, snapshot->activation_code,
                                       snapshot->activation_message, "xiaozhi.me");
    if (inkpane_epd_show_full(s_framebuffer) != ESP_OK) {
        s_persist.panel_warm = false;
    }
}

static void resident_render_voice_error(const inkpane_voice_snapshot_t *snapshot)
{
    if (s_framebuffer == NULL) {
        return;
    }
    const char *reason = snapshot->error[0] != '\0' ? snapshot->error : "语音服务暂时不可用";
    inkpane_ui_render_voice_error(s_framebuffer, "语音助手不可用", reason,
                                  "看板功能不受影响 · BOOT 返回");
    if (inkpane_epd_show_full(s_framebuffer) != ESP_OK) {
        s_persist.panel_warm = false;
    }
}

static void resident_poll_buttons(inkpane_config_t *config)
{
    int64_t now_ms = esp_timer_get_time() / 1000;
    for (size_t i = 0; i < sizeof(RESIDENT_BUTTON_PINS) / sizeof(RESIDENT_BUTTON_PINS[0]); ++i) {
        int pin = RESIDENT_BUTTON_PINS[i];
        resident_button_t *button = &s_buttons[i];
        bool down = inkpane_board_button_held(pin);
        if (down && !button->down) {
            button->down = true;
            button->down_ms = now_ms;
            button->long_sent = false;
            ESP_LOGI(TAG, "button %d down", pin);
        } else if (down && button->down && !button->long_sent && pin == 0 &&
                   now_ms - button->down_ms >= 3000) {
            button->long_sent = true;
            inkpane_voice_button(true);
            s_voice_dirty = true;
            ESP_LOGI(TAG, "BOOT long press: wake word mute toggle");
        } else if (!down && button->down) {
            button->down = false;
            int64_t held_ms = now_ms - button->down_ms;
            ESP_LOGI(TAG, "button %d up after %d ms (voice_page=%d error_page=%d)", pin,
                     (int)held_ms, (int)s_voice_page, (int)s_error_page);
            if (pin == 0) {
                if (!button->long_sent) {
                    if (s_error_page) {
                        s_error_dismissed = true;
                        s_error_page = false;
                        s_voice_dirty = true;
                    }
                    inkpane_voice_button(false);
                    s_voice_dirty = true;
                }
                continue;
            }
            if (s_activation_page && pin == 5) {
                inkpane_voice_set_activation_visible(false);
                s_voice_dirty = true;
                continue;
            }
            if (s_voice_page || s_error_page || held_ms >= 1500) {
                /* Holds longer than 1.5 s have no action on the side keys; the
                 * log makes that visible instead of looking like a dead board. */
                ESP_LOGI(TAG, "button %d ignored (voice_page=%d error_page=%d held=%d ms)", pin,
                         (int)s_voice_page, (int)s_error_page, (int)held_ms);
                continue;
            }
            bool handled = handle_zoom_button(pin);
            if (handled) {
                s_dashboard_ready = true;
            }
        }
    }
    (void)config;
}

static void resident_sync_time_to_rtc(const inkpane_config_t *config)
{
    if (inkpane_wifi_sync_time(5000) != ESP_OK) {
        return;
    }
    time_t now = time(NULL);
    inkpane_datetime_t dt;
    int64_t local = (int64_t)now + (int64_t)config->utc_offset_minutes * 60;
    inkpane_datetime_from_local_epoch(local, &dt);
    if (inkpane_board_time_set(&dt) == ESP_OK) {
        ESP_LOGI(TAG, "rtc calibrated from sntp: %04d-%02d-%02d %02d:%02d", dt.year, dt.month,
                 dt.day, dt.hour, dt.minute);
    }
}

static void resident_network_tick(inkpane_config_t *config)
{
    bool connected = inkpane_wifi_connected();
    if (connected != s_last_network_up) {
        s_last_network_up = connected;
        inkpane_voice_notify_network(connected);
    }

    int64_t now_ms = esp_timer_get_time() / 1000;
    if (!connected) {
        if (now_ms - s_last_wifi_attempt_ms < RESIDENT_WIFI_RETRY_MS) {
            return;
        }
        s_last_wifi_attempt_ms = now_ms;
        ESP_LOGI(TAG, "wifi reconnect attempt");
        if (!connect_wifi(config)) {
            s_persist.fail_count++;
            s_persist.retry_seconds = retry_delay_seconds(config);
            return;
        }
    }

    inkpane_datetime_t dt = {0};
    bool rtc_ok = read_clock(&dt);
    int64_t now_epoch = rtc_ok ? inkpane_local_epoch(&dt) : 0;
    bool due = !rtc_ok || s_persist.next_net_epoch == 0 ||
               now_epoch >= s_persist.next_net_epoch || s_screen_dirty;
    if (!due) {
        return;
    }
    if (s_voice_page || s_activation_page || s_error_page ||
        inkpane_voice_session_active()) {
        /* Do not repaint the dashboard over a conversation/activation/error
         * page; the refresh runs as soon as that page is dismissed. */
        return;
    }

    bool force_full = !rtc_ok || s_screen_dirty ||
                      (s_persist.partial_count >= CONFIG_INKPANE_FULL_REFRESH_INTERVAL) ||
                      !s_dashboard_ready;
    bool paint_notice = !s_dashboard_ready;
    fetch_and_render(config, force_full, now_epoch, rtc_ok, &dt, paint_notice);
    if (!s_persist.auth_error && s_persist.fail_count == 0) {
        s_dashboard_ready = true;
        s_screen_dirty = false;
#if CONFIG_INKPANE_TELEMETRY
        post_telemetry(config);
#endif
    }
    if (s_screen->timezone[0] != '\0') {
        snprintf(s_timezone, sizeof(s_timezone), "%s", s_screen->timezone);
    }
    resident_apply_server_voice(config);
    resident_apply_voice_settings(config);
}

static void resident_battery_check(void)
{
    int64_t now_ms = esp_timer_get_time() / 1000;
    if (now_ms - s_last_battery_check_ms < RESIDENT_BATTERY_CHECK_MS) {
        return;
    }
    s_last_battery_check_ms = now_ms;
    int battery = inkpane_board_battery_percent();
    if (battery < 0) {
        return;
    }
    if (battery < 15) {
        inkpane_voice_set_muted(true);
    }
    if (battery < 5 && !inkpane_board_vbus_present()) {
        ESP_LOGW(TAG, "battery critical (%d%%), powering off", battery);
        resident_render_notice("电量过低", "设备即将关机以保护电池", "请连接 USB 充电", NULL);
        vTaskDelay(pdMS_TO_TICKS(3000));
        inkpane_board_power_off();
    }
}

static void resident_main(void)
{
    nvs_init();

    /* Always start from a clean view: the first successful fetch rebuilds it. */
    memset(&s_persist, 0, sizeof(s_persist));
    s_persist.magic = PERSIST_MAGIC;
    s_persist.tz_offset_minutes = 480;
    s_persist.zoomed_module = -1;
    inkpane_snapshot_invalidate(&s_snapshot);
    s_last_battery_check_ms = esp_timer_get_time() / 1000;

    ESP_LOGI(TAG, "resident boot: reason=%d", (int)esp_reset_reason());
    if (inkpane_board_init() != ESP_OK) {
        ESP_LOGE(TAG, "board init failed");
    }
    resident_read_mac();

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
    inkpane_screen_reset(s_screen);

    if (inkpane_ui_init(NULL, 0) != ESP_OK) {
        ESP_LOGE(TAG, "font init failed");
    }

    inkpane_config_t config;
    inkpane_config_load(&config);
    snprintf(s_timezone, sizeof(s_timezone), "Asia/Shanghai");

    esp_err_t epd = inkpane_epd_init(false);
    if (epd != ESP_OK) {
        ESP_LOGE(TAG, "epd init failed: %s", esp_err_to_name(epd));
        s_persist.panel_warm = false;
    } else {
        s_persist.panel_warm = true;
    }

    if (provisioning_requested(true, &config)) {
        char ssid[40];
        inkpane_prov_ap_ssid(ssid, sizeof(ssid));
        if (s_framebuffer != NULL) {
            inkpane_ui_render_setup(s_framebuffer, ssid, "http://192.168.4.1");
            inkpane_epd_show_full(s_framebuffer);
        }
        inkpane_prov_run(ssid);
    }

    resident_render_notice("正在连接日程服务", config.ssid, "设备保持常驻，请稍候", NULL);

    bool online = connect_wifi(&config);
    if (!online) {
        s_persist.fail_count = 1;
        s_persist.retry_seconds = retry_delay_seconds(&config);
        resident_render_notice("无法连接 Wi-Fi", config.ssid, "确认路由器与密码后重启",
                               "长按中键重新配网");
    } else {
        resident_network_tick(&config);
    }

    inkpane_voice_config_t voice_config;
    resident_build_voice_config(&config, &voice_config);
    esp_err_t voice_err = ESP_ERR_NOT_SUPPORTED;
    if (config.voice_enabled) {
        voice_err = inkpane_voice_init(&voice_config);
    }
    if (voice_err == ESP_OK) {
        resident_sync_time_to_rtc(&config);
        if (inkpane_voice_start() != ESP_OK) {
            ESP_LOGW(TAG, "voice start failed; dashboard continues");
        }
    } else {
        ESP_LOGW(TAG, "voice unavailable (%s); dashboard-only", esp_err_to_name(voice_err));
    }

    int64_t last_tick_ms = esp_timer_get_time() / 1000;
    int64_t last_heartbeat_ms = last_tick_ms;
#if RESIDENT_DIAG_TASK
    xTaskCreate(resident_diag_task, "diag", 3072, NULL, 2, NULL);
#endif
    while (true) {
        int64_t now_ms = esp_timer_get_time() / 1000;
        ++s_main_loop_ticks;
        s_main_loop_last_ms = now_ms;
        resident_poll_buttons(&config);

        inkpane_voice_event_t event;
        while (inkpane_voice_poll_event(&event)) {
            resident_handle_voice_event(&event, &config);
        }

        inkpane_voice_snapshot_t snapshot;
        inkpane_voice_get_snapshot(&snapshot);
        bool want_voice = voice_state_is_conversation(snapshot.state);
        bool want_activation = snapshot.state == INKPANE_VOICE_ACTIVATING &&
                               snapshot.activation_visible;
        bool want_error = snapshot.state == INKPANE_VOICE_ERROR;
        if (!want_error) {
            s_error_dismissed = false;
        }
        /* Keep the finished turn on screen long enough to read the answer. */
        if (!want_voice && s_voice_in_turn) {
            s_voice_linger_until_ms = now_ms + RESIDENT_VOICE_LINGER_MS;
        }
        s_voice_in_turn = want_voice;
        const bool linger_voice = !want_voice && !want_error && !want_activation &&
                                  now_ms < s_voice_linger_until_ms;
        bool show_voice = want_voice || linger_voice;
        bool show_activation = want_activation && !want_voice;
        bool show_error = want_error && !want_voice && !want_activation && !s_error_dismissed;

        if (s_error_page && now_ms > s_error_until_ms) {
            s_error_dismissed = true;
            show_error = false;
        }
        if (s_activation_page && now_ms > s_activation_until_ms) {
            inkpane_voice_set_activation_visible(false);
            show_activation = false;
        }

        if (show_voice != s_voice_page || show_activation != s_activation_page ||
            show_error != s_error_page) {
            ESP_LOGI(TAG, "page: voice=%d activation=%d error=%d (state=%d)", (int)show_voice,
                     (int)show_activation, (int)show_error, (int)snapshot.state);
            s_voice_page = show_voice;
            s_activation_page = show_activation;
            s_error_page = show_error;
            s_voice_dirty = false;
            if (s_voice_page) {
                resident_render_voice(&snapshot, true);
                s_voice_signature = voice_page_signature(&snapshot);
                s_last_voice_render_ms = now_ms;
            } else if (s_activation_page) {
                s_activation_until_ms = now_ms + RESIDENT_ACTIVATION_PAGE_MS;
                resident_render_activation(&snapshot);
            } else if (s_error_page) {
                s_error_until_ms = now_ms + RESIDENT_ERROR_PAGE_MS;
                resident_render_voice_error(&snapshot);
            } else {
                s_dashboard_ready = s_dashboard_ready || inkpane_snapshot_valid(&s_snapshot);
                resident_render_dashboard();
            }
        } else if (s_voice_page && s_voice_dirty &&
                   now_ms - s_last_voice_render_ms >= RESIDENT_VOICE_RENDER_MS) {
            const uint32_t signature = voice_page_signature(&snapshot);
            if (signature != s_voice_signature) {
                s_voice_signature = signature;
                resident_render_voice(&snapshot, false);
            }
            s_last_voice_render_ms = now_ms;
            s_voice_dirty = false;
        }

        if (now_ms - last_tick_ms >= 1000) {
            last_tick_ms = now_ms;
            if (!s_voice_page && !s_activation_page && !s_error_page && s_dashboard_ready &&
                s_persist.zoomed_module < 0) {
                refresh_clock_partial(&config);
            }
            resident_network_tick(&config);
            resident_battery_check();
        }

        if (now_ms - last_heartbeat_ms >= 30000) {
            last_heartbeat_ms = now_ms;
            ESP_LOGI(TAG, "loop alive: state=%d voice_page=%d error_page=%d internal=%u",
                     (int)snapshot.state, (int)s_voice_page, (int)s_error_page,
                     (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
        }

        vTaskDelay(pdMS_TO_TICKS(RESIDENT_TICK_MS));
    }
}

void app_main(void)
{
    resident_main();
}

#endif /* !CONFIG_INKPANE_POWER_MODE_LOW_POWER */
