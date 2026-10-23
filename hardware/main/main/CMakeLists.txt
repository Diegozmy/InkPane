idf_component_register(
    SRCS "app_main.c"
    INCLUDE_DIRS "."
    REQUIRES inkpane_board inkpane_epd inkpane_model inkpane_ui inkpane_net inkpane_prov
             nvs_flash esp_timer esp_hw_support
)
