#include "inkpane_net.h"

#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

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
    if (start != ESP_OK && start != ESP_ERR_WIFI_STATE) {
        return start;
    }

    EventBits_t bits = xEventGroupWaitBits(s_events, CONNECTED_BIT | FAILED_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    if ((bits & CONNECTED_BIT) == 0) {
        ESP_LOGW(TAG, "connect to %s failed", ssid);
        esp_wifi_stop();
        return ESP_FAIL;
    }
    esp_wifi_set_ps(WIFI_PS_NONE);
    ESP_LOGI(TAG, "connected to %s", ssid);
    return ESP_OK;
}

void inkpane_wifi_disconnect(void)
{
    if (!s_initialized) {
        return;
    }
    esp_wifi_disconnect();
    esp_wifi_stop();
    s_connected = false;
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
