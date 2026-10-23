idf_component_register(
    SRCS "src/config.c" "src/wifi.c" "src/http.c"
    INCLUDE_DIRS "include"
    REQUIRES nvs_flash esp_wifi esp_event esp_netif esp_http_client esp_timer
)
