#include "inkpane_net.h"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "wifi";

#define CONNECTED_BIT BIT0
#define FAILED_BIT BIT1

static EventGroupHandle_t s_events;
static bool s_initialized;
static bool s_connected;

static void event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        s_connected = false;
        if (s_events != NULL) {
            xEventGroupSetBits(s_events, FAILED_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        s_connected = true;
        if (s_events != NULL) {
            xEventGroupSetBits(s_events, CONNECTED_BIT);
        }
    }
}

static esp_err_t ensure_initialized(void)
{
    if (s_initialized) {
        return ESP_OK;
    }
    if (s_events == NULL) {
        s_events = xEventGroupCreate();
        if (s_events == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "netif");
    esp_err_t err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        return err;
    }
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&init), TAG, "wifi init");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                            event_handler, NULL, NULL),
                        TAG, "wifi handler");
    ESP_RETURN_ON_ERROR(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                            event_handler, NULL, NULL),
                        TAG, "ip handler");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_RAM), TAG, "storage");
    s_initialized = true;
    return ESP_OK;
}

esp_err_t inkpane_wifi_connect(const char *ssid, const char *password, int timeout_ms)
{
    if (ssid == NULL || ssid[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    ESP_RETURN_ON_ERROR(ensure_initialized(), TAG, "init");
    if (s_connected) {
        return ESP_OK;
    }
    if (s_events != NULL) {
        xEventGroupClearBits(s_events, CONNECTED_BIT | FAILED_BIT);
    }

    wifi_config_t config = {0};
    strncpy((char *)config.sta.ssid, ssid, sizeof(config.sta.ssid) - 1);
    strncpy((char *)config.sta.password, password ? password : "", sizeof(config.sta.password) - 1);
    config.sta.threshold.authmode = password != NULL && password[0] != '\0' ? WIFI_AUTH_WPA2_PSK
                                                                            : WIFI_AUTH_OPEN;

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &config), TAG, "config");
    esp_err_t start = esp_wifi_start();
    if (start == ESP_ERR_WIFI_STATE) {
        /* Already started after a dropped link: kick a fresh association. */
        esp_wifi_connect();
    } else if (start != ESP_OK) {
        return start;
    }

    EventBits_t bits = xEventGroupWaitBits(s_events, CONNECTED_BIT | FAILED_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if ((bits & CONNECTED_BIT) == 0) {
        ESP_LOGW(TAG, "connect to %s failed", ssid);
        esp_wifi_stop();
        return ESP_FAIL;
    }
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    ESP_LOGI(TAG, "connected to %s", ssid);
    return ESP_OK;
}

void inkpane_wifi_set_power_save(bool enabled)
{
    if (!s_initialized) {
        return;
    }
    esp_wifi_set_ps(enabled ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
}

/* -------------------------------------------------------------------------
 * Time sync (SNTP)
 *
 * The previous one-shot implementation polled sntp_get_sync_status(), which is
 * latching: the read that observes SNTP_SYNC_STATUS_COMPLETED also clears it,
 * so the polling loop raced the real notification and could consume the flag
 * before it ever looked at it. On top of that lwIP added a random 0..5 s
 * startup delay (CONFIG_LWIP_SNTP_STARTUP_DELAY) and only retried a dead
 * server after SNTP_RECV_TIMEOUT = 15 s, while the caller's budget was 5 s --
 * so the first boot after a power cycle routinely lost the race and logged
 * "sntp sync timed out" ~9.5 s in. The esp_netif wrapper posts a binary
 * semaphore from the sync callback instead, which cannot be lost, and it can
 * keep polling the servers hourly once the clock is set.
 * ------------------------------------------------------------------------- */

#define INKPANE_SNTP_RETRY_MIN_MS 500
#define INKPANE_SNTP_RETRY_MAX_MS 1500
/* How long a second caller waits for another task's in-flight sync before
 * giving up. Long enough to cover a fast sync, short enough that a blocking
 * caller is not stalled for the full timeout+retry sequence. */
#define INKPANE_SNTP_LOCK_WAIT_MS 1000

/* String literals live for the life of the program: lwIP stores the pointer
 * (renew_servers_after_new_IP is off), so a stack-built table would dangle. */
static const char *const s_sntp_servers[] = {
    "ntp.aliyun.com",  /* lowest RTT from Chinese broadband */
    "ntp.tencent.com", /* independent operator: covers an Alibaba outage */
    "203.107.6.88",    /* literal IP: still works when DNS itself is broken */
};
#define INKPANE_SNTP_SERVER_COUNT (sizeof(s_sntp_servers) / sizeof(s_sntp_servers[0]))

/* esp_netif_sntp_init() refuses more servers than CONFIG_LWIP_SNTP_MAX_SERVERS
 * and the extra slots would silently swallow our table entries; fail the build
 * with a readable message instead of shipping a device that is missing its
 * DNS-free fallback. The casts keep the comparison signed/signed because
 * INKPANE_SNTP_SERVER_COUNT is a sizeof expression (size_t) and the component
 * builds with -Werror -Wsign-compare. */
_Static_assert((int)INKPANE_SNTP_SERVER_COUNT <= CONFIG_LWIP_SNTP_MAX_SERVERS,
               "CONFIG_LWIP_SNTP_MAX_SERVERS must cover every server in s_sntp_servers");
_Static_assert((int)INKPANE_SNTP_SERVER_COUNT == 3,
               "s_sntp_servers changed size: update the ESP_SNTP_SERVER_LIST below");

/* Resident mode calls into here from the app_main task and from the voice
 * task, both during the same boot window while the clock is still invalid.
 * Two callers must not race esp_netif_sntp_init() (the loser gets
 * ESP_ERR_INVALID_STATE) nor steal each other's sync_wait token. */
static SemaphoreHandle_t s_sntp_lock;
static bool s_sntp_started; /* service initialized; read/written with the lock */
static bool s_sntp_warned;  /* at most one timeout warning per process */

static SemaphoreHandle_t sntp_lock(void)
{
    /* Create-on-first-use, but without the classic "if (NULL) create" race:
     * a short critical section makes the check-and-create atomic, and static
     * allocation keeps the mutex off the heap. The lock is never deleted, so
     * it stays valid for the lifetime of the application. */
    static StaticSemaphore_t lock_buffer;
    static portMUX_TYPE lock_mux = portMUX_INITIALIZER_UNLOCKED;
    SemaphoreHandle_t lock;

    portENTER_CRITICAL(&lock_mux);
    if (s_sntp_lock == NULL) {
        s_sntp_lock = xSemaphoreCreateMutexStatic(&lock_buffer);
    }
    lock = s_sntp_lock;
    portEXIT_CRITICAL(&lock_mux);
    return lock;
}

/* Caller must hold sntp_lock(). Idempotent: keeps the service up across calls
 * so later syncs only have to wait instead of rebuilding the whole stack. */
static esp_err_t sntp_start_locked(void)
{
    if (s_sntp_started) {
        return ESP_OK;
    }
    esp_sntp_config_t config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        INKPANE_SNTP_SERVER_COUNT, ESP_SNTP_SERVER_LIST(s_sntp_servers[0],
                                                        s_sntp_servers[1],
                                                        s_sntp_servers[2]));
    esp_err_t err = esp_netif_sntp_init(&config);
    if (err == ESP_ERR_INVALID_STATE) {
        /* The module was already initialized (something else started SNTP
         * first). The service is running, which is all this caller needs. */
        err = ESP_OK;
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "sntp init failed: %s", esp_err_to_name(err));
        return err;
    }
    s_sntp_started = true;
    ESP_LOGI(TAG, "sntp service started (%d servers)",
             (int)INKPANE_SNTP_SERVER_COUNT);
    return ESP_OK;
}

/* A zero-tick wait is the only way to reach the wrapper's semaphore, and it
 * consumes one pending notification without blocking. Needed before a retry:
 * a late response from the expired attempt may already have posted a token,
 * and feeding that stale token to the second wait would report success without
 * a fresh answer. Bounded so an unexpected notification stream cannot spin. */
static void sntp_drain_sync_events(void)
{
    for (int i = 0; i < 3; i++) {
        if (esp_netif_sntp_sync_wait(0) != ESP_OK) {
            break;
        }
    }
}

/* Wait one slice and log the outcome. ESP_ERR_NOT_FINISHED can only come back
 * in smooth-sync mode, where the clock is already corrected and the remaining
 * adjtime drift is irrelevant for TLS; count it as success. */
static esp_err_t sntp_wait_and_report(int wait_ms)
{
    esp_err_t err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(wait_ms));
    if (err == ESP_ERR_NOT_FINISHED) {
        err = ESP_OK;
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "sntp synced: %lld", (long long)time(NULL));
    }
    return err;
}

bool inkpane_time_valid(void)
{
    /* 1700000000 is 2023-11-14T22:13:20Z. ESP-IDF boots with the clock at
     * 1970, so anything below that means no sync has ever succeeded. */
    return time(NULL) > (time_t)1700000000;
}

esp_err_t inkpane_time_sync_start(void)
{
    if (!s_connected) {
        return ESP_ERR_INVALID_STATE;
    }
    SemaphoreHandle_t lock = sntp_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }
    /* NON-blocking is part of the contract: inkpane_wifi_sync_time() holds the
     * mutex for its full timeout (seconds), and a caller that only wanted to
     * "make sure the service runs" must not queue behind that. A busy lock
     * means another task is already inside start-or-sync, so the service is
     * started or about to be -- exactly what this call wanted to achieve. */
    if (xSemaphoreTake(lock, 0) != pdTRUE) {
        return ESP_OK;
    }
    esp_err_t err = sntp_start_locked();
    xSemaphoreGive(lock);
    return err;
}

esp_err_t inkpane_wifi_sync_time(int timeout_ms)
{
    if (timeout_ms <= 0) {
        return ESP_ERR_INVALID_ARG;
    }
    /* Fast path: nothing to do once the clock is trustworthy. This also keeps
     * repeated callers (dashboard loop, voice session start) from queueing on
     * the mutex behind another task's in-flight sync. */
    if (inkpane_time_valid()) {
        return ESP_OK;
    }

    SemaphoreHandle_t lock = sntp_lock();
    if (lock == NULL) {
        return ESP_ERR_NO_MEM;
    }
    /* Wait for the lock with a bound instead of portMAX_DELAY: the holder may
     * be inside a full timeout+retry sequence (up to timeout_ms + 1.5 s), and
     * an unbounded wait would opaque that cost onto a caller that only asked
     * for a short sync. Bounding it means a second task gives up quickly and
     * can poll again later (the resident loop retries every 60 s), instead of
     * blocking e.g. the voice task for several seconds. */
    if (xSemaphoreTake(lock, pdMS_TO_TICKS(INKPANE_SNTP_LOCK_WAIT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    /* The other task may have finished the sync while we waited for the lock:
     * return instead of bringing the service up and waiting a second time. */
    if (inkpane_time_valid()) {
        xSemaphoreGive(lock);
        return ESP_OK;
    }
    if (!s_connected) {
        xSemaphoreGive(lock);
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = sntp_start_locked();
    if (err != ESP_OK) {
        xSemaphoreGive(lock);
        return err;
    }

    if (sntp_wait_and_report(timeout_ms) == ESP_OK) {
        xSemaphoreGive(lock);
        return ESP_OK;
    }
    /* The response can land between the timeout expiry and this point; the
     * clock itself is the authority, so a restart would only waste the caller's
     * remaining budget. */
    if (inkpane_time_valid()) {
        xSemaphoreGive(lock);
        return ESP_OK;
    }

    /* First slice expired. Restart SNTP for an immediate fresh request:
     * esp_netif_sntp_start() is sntp_stop()+sntp_init(), which resets the lwIP
     * retry backoff that otherwise grows to 150 s and gives the next probe a
     * clean one-shot attempt. Drain first, then wait a shorter slice on top of
     * the caller's budget rather than splitting it. */
    sntp_drain_sync_events();
    esp_err_t retry_err = esp_netif_sntp_start();
    if (retry_err == ESP_OK) {
        int retry_ms = timeout_ms / 3;
        if (retry_ms < INKPANE_SNTP_RETRY_MIN_MS) {
            retry_ms = INKPANE_SNTP_RETRY_MIN_MS;
        } else if (retry_ms > INKPANE_SNTP_RETRY_MAX_MS) {
            retry_ms = INKPANE_SNTP_RETRY_MAX_MS;
        }
        retry_err = sntp_wait_and_report(retry_ms);
    }
    if (retry_err == ESP_OK) {
        xSemaphoreGive(lock);
        return ESP_OK;
    }

    /* Both attempts are exhausted. The service deliberately stays in POLL
     * mode: lwIP keeps retrying (SNTP_RECV_TIMEOUT, backing off to 150 s) and
     * then polls hourly, so the clock still converges in the background.
     * The ESP_LOGW is emitted once per process because a resident device would
     * otherwise repeat it at every network tick and bury the rest of the log;
     * later failures still leave a DEBUG breadcrumb so field debugging is not
     * completely blind. */
    /* A response can still land during the drain/restart window; the clock is
     * the authority, so do not emit a timeout warning on a device that is now
     * correctly synced. */
    if (inkpane_time_valid()) {
        xSemaphoreGive(lock);
        return ESP_OK;
    }
    if (!s_sntp_warned) {
        s_sntp_warned = true;
        ESP_LOGW(TAG, "sntp sync timed out (will retry hourly in background)");
    } else {
        ESP_LOGD(TAG, "sntp still unsynced: %s", esp_err_to_name(retry_err));
    }
    xSemaphoreGive(lock);
    return retry_err;
}

void inkpane_wifi_disconnect(void)
{
    if (!s_initialized) {
        return;
    }
    esp_wifi_disconnect();
    esp_wifi_stop();
    s_connected = false;
    /* SNTP is intentionally left running. The system clock already holds the
     * synced value, and lwIP's poll timer simply keeps firing into a dead
     * interface at no cost; when the link comes back the very next probe
     * succeeds and the hourly cadence resumes. Calling esp_netif_sntp_deinit()
     * here would free the sync semaphore and server table and force a full
     * re-init on reconnect, reintroducing the init race this came to fix. */
}

bool inkpane_wifi_connected(void)
{
    return s_connected;
}

int inkpane_wifi_rssi(void)
{
    if (!s_connected) {
        return 0;
    }
    wifi_ap_record_t record = {0};
    if (esp_wifi_sta_get_ap_info(&record) != ESP_OK) {
        return 0;
    }
    return record.rssi;
}

esp_err_t inkpane_wifi_ip(char *out, size_t size)
{
    if (out == NULL || size == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    out[0] = '\0';
    if (!s_connected) {
        return ESP_ERR_INVALID_STATE;
    }
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif == NULL) {
        return ESP_ERR_NOT_FOUND;
    }
    esp_netif_ip_info_t info = {0};
    if (esp_netif_get_ip_info(netif, &info) != ESP_OK || info.ip.addr == 0) {
        return ESP_ERR_INVALID_STATE;
    }
    uint32_t ip = info.ip.addr;
    snprintf(out, size, "%u.%u.%u.%u", (unsigned)(ip & 0xFFu), (unsigned)((ip >> 8) & 0xFFu),
             (unsigned)((ip >> 16) & 0xFFu), (unsigned)((ip >> 24) & 0xFFu));
    return ESP_OK;
}
