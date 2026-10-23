idf_component_register(
    SRCS "src/board.c" "src/axp2101.c" "src/pcf85063.c" "src/shtc3.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS "src"
    REQUIRES esp_driver_i2c esp_driver_gpio esp_hw_support inkpane_model
)
