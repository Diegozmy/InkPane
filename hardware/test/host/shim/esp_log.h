#pragma once

/* Host-test shim for ESP-IDF logging. */
#include <stdio.h>

#define inkpane_host_log(tag, level, ...)      \
    do {                                       \
        fprintf(stderr, "[%s] %s: ", tag, level); \
        fprintf(stderr, __VA_ARGS__);          \
        fprintf(stderr, "\n");                 \
    } while (0)

#define ESP_LOGE(tag, ...) inkpane_host_log(tag, "E", __VA_ARGS__)
#define ESP_LOGW(tag, ...) inkpane_host_log(tag, "W", __VA_ARGS__)
#define ESP_LOGI(tag, ...) inkpane_host_log(tag, "I", __VA_ARGS__)
#define ESP_LOGD(tag, ...) inkpane_host_log(tag, "D", __VA_ARGS__)
