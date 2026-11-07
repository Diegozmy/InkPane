idf_component_register(
    SRCS "src/epd.c" "src/frame_diff.c"
    INCLUDE_DIRS "include"
    # esp_timer: refresh latency logging in show_full_impl().
    REQUIRES esp_driver_spi esp_driver_gpio esp_hw_support inkpane_board esp_timer
)
