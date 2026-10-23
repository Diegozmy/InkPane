idf_component_register(
    SRCS "src/prov.c"
    INCLUDE_DIRS "include"
    REQUIRES inkpane_net nvs_flash esp_wifi esp_event esp_netif esp_http_server lwip
             esp_hw_support esp_system
)
