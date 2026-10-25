#pragma once

/**
 * InkPane device-token HTTP client (plain HTTP on the LAN).
 *
 * Used by the voice MCP tools to call the same `/api/device/` endpoints the
 * dashboard uses for `/api/device/screen` and `/api/device/telemetry`. The base
 * URL and the device token are set once by voice_app (from inkpane_config_t).
 *
 * This file is plain C so it can be compiled on the host as well; the ESP-IDF
 * implementation is guarded by INKPANE_HOST_TEST and the host test build links
 * mcp_mock.c against these declarations instead.
 */

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** 8 s network timeout, matching the dashboard's screen/telemetry requests. */
#define INKPANE_API_TIMEOUT_MS 8000
/** Maximum accepted response body; longer answers are reported as errors. */
#define INKPANE_API_RESPONSE_MAX 8192

/** Return codes of inkpane_api_request(). */
#define INKPANE_API_OK 0
#define INKPANE_API_ERR_TRANSPORT (-1)
#define INKPANE_API_ERR_TOO_LARGE (-2)
#define INKPANE_API_ERR_INVALID (-3)

/**
 * Set/replace the API base URL ("http://192.168.1.20:4000") and device token.
 * Either argument may be NULL/empty to clear it (requests then fail).
 */
void inkpane_api_init(const char *base_url, const char *token);

/**
 * Perform one request.
 *
 * @param method        "GET", "POST", "PATCH", "DELETE" (case-sensitive)
 * @param path          Absolute device path, e.g. "/api/device/todos/42"
 * @param body          Optional request body (Content-Type: application/json)
 * @param resp          Optional response buffer; NUL-terminated on return
 * @param resp_cap      Capacity of resp in bytes (0 when resp is NULL)
 * @param status_code   Optional; HTTP status, or -1 on transport failure
 *
 * @return INKPANE_API_OK on a completed HTTP exchange (any HTTP status), or one
 *         of the negative INKPANE_API_ERR_* codes. The caller must check
 *         `status_code` to know whether the server accepted the request.
 */
int inkpane_api_request(const char *method, const char *path, const char *body,
                        char *resp, size_t resp_cap, int *status_code);

#ifdef __cplusplus
}
#endif
