#pragma once

#include <stddef.h>

#include "inkpane_net.h"

/** Build the provisioning AP SSID: <prefix>-<last 3 MAC bytes>. */
void inkpane_prov_ap_ssid(char *out, size_t size);

/**
 * Start the AP + captive portal and wait for the user to save credentials.
 * On success the device reboots; on timeout it also reboots. Never returns.
 */
void inkpane_prov_run(const char *ap_ssid) __attribute__((noreturn));
