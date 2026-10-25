/*
 * Host-test double for the InkPane device HTTP API.
 *
 * mcp_tools.c calls inkpane_api_request(); the host test build links this file
 * instead of port/inkpane_api.c (whose ESP-IDF implementation is compiled out
 * under INKPANE_HOST_TEST). The mock records the last request and returns a
 * canned status/body, so the MCP tools can be tested without a network.
 */

#include "inkpane_api.h"

#include <stdio.h>
#include <string.h>

#define MOCK_METHOD_MAX 8
#define MOCK_PATH_MAX 256
#define MOCK_BODY_MAX 4096
#define MOCK_RESPONSE_MAX 8192

static char s_method[MOCK_METHOD_MAX];
static char s_path[MOCK_PATH_MAX];
static char s_body[MOCK_BODY_MAX];
static char s_response[MOCK_RESPONSE_MAX];
static int s_calls;
static int s_result;
static int s_status;

static void mock_copy(char *dst, size_t dst_size, const char *src)
{
    if (dst_size == 0) {
        return;
    }
    if (src == NULL) {
        dst[0] = '\0';
        return;
    }
    size_t length = strlen(src);
    if (length >= dst_size) {
        length = dst_size - 1;
    }
    memcpy(dst, src, length);
    dst[length] = '\0';
}

void mcp_mock_reset(void)
{
    s_method[0] = '\0';
    s_path[0] = '\0';
    s_body[0] = '\0';
    s_response[0] = '\0';
    s_calls = 0;
    s_result = INKPANE_API_OK;
    s_status = 200;
}

void mcp_mock_set_response(int status, const char *body)
{
    s_status = status;
    mock_copy(s_response, sizeof(s_response), body);
}

void mcp_mock_set_failure(int result)
{
    s_result = result;
}

int mcp_mock_call_count(void)
{
    return s_calls;
}

const char *mcp_mock_last_method(void)
{
    return s_method;
}

const char *mcp_mock_last_path(void)
{
    return s_path;
}

const char *mcp_mock_last_body(void)
{
    return s_body;
}

void inkpane_api_init(const char *base_url, const char *token)
{
    (void)base_url;
    (void)token;
}

int inkpane_api_request(const char *method, const char *path, const char *body,
                        char *resp, size_t resp_cap, int *status_code)
{
    ++s_calls;
    mock_copy(s_method, sizeof(s_method), method);
    mock_copy(s_path, sizeof(s_path), path);
    mock_copy(s_body, sizeof(s_body), body);

    if (status_code != NULL) {
        *status_code = s_result == INKPANE_API_OK ? s_status : -1;
    }
    if (resp != NULL && resp_cap > 0) {
        resp[0] = '\0';
    }
    if (s_result != INKPANE_API_OK) {
        return s_result;
    }
    if (resp != NULL && resp_cap > 0) {
        mock_copy(resp, resp_cap, s_response);
    }
    return INKPANE_API_OK;
}
