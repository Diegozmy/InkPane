#pragma once

/**
 * Minimal JSON-RPC 2.0 MCP server for the InkPane voice assistant.
 *
 * Pure C11 with no FreeRTOS / ESP-IDF dependency so it can be exercised by the
 * host unit tests (see hardware/test/host/mcp_test.c). Requests are parsed with
 * inkpane_model's inkpane_json.h reader; responses are assembled in a fixed
 * buffer and handed to a caller-provided send function (the WebSocket
 * transport, which wraps them in the xiaozhi {"type":"mcp","payload":...}
 * envelope).
 *
 * Supported methods:
 *   initialize   -> protocolVersion 2024-11-05, serverInfo
 *   tools/list   -> {"tools":[...]} filtered by env->allow_control
 *   tools/call   -> {"content":[{"type":"text","text":...}],"isError":bool}
 * Unknown methods answer with JSON-RPC error -32601. Tool execution and
 * argument-validation failures are tool results with isError=true (as required
 * by the MCP spec); malformed JSON-RPC requests use the standard -32xxx errors.
 */

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Environment/hooks injected by voice_app. */
typedef struct mcp_tools_env {
    /** Expose mutation tools (event/todo/screen/volume) to the model. */
    bool allow_control;
    /**
     * Local wall-clock time used to build event timestamps.
     * Return false when the RTC is not valid yet.
     */
    bool (*get_local_time)(void *ctx, int *year, int *month, int *day, int *hour, int *minute,
                           int *second, int *offset_minutes);
    void *time_ctx;
    /** IANA timezone name (e.g. "Asia/Shanghai"); may be NULL. */
    const char *timezone;
    /**
     * Called by self.inkpane.screen.refresh: voice_app marks the dashboard dirty
     * so the next e-paper refresh picks up the mutation.
     */
    void (*on_mutation)(void *ctx);
    void *mutation_ctx;
    /**
     * Called by self.inkpane.screen.zoom to change the displayed view.
     *
     * `module` is an inkpane_module_id_t (0..INKPANE_MODULE_COUNT-1) to zoom
     * into that module, or -1 to return to the overview. The port layer does
     * not include the model headers, so this stays an int. Return 0 when the
     * device accepted the request, -1 when it cannot (e.g. the module is not
     * enabled by the current layout).
     */
    int (*on_zoom)(void *ctx, int module);
    void *zoom_ctx;
} mcp_tools_env_t;

/**
 * Send one complete JSON-RPC response. The payload is NUL-terminated but not
 * necessarily; len bytes are always valid.
 *
 * @return 0 on success, non-zero when the transport rejected the message.
 */
typedef int (*mcp_send_fn)(void *ctx, const char *json, size_t len);

typedef struct mcp_server mcp_server_t;

/**
 * Create a server. `env` is copied, so it may be a stack object; NULL enables a
 * default environment (allow_control=false, no callbacks).
 */
mcp_server_t *mcp_server_create(mcp_send_fn send, void *send_ctx, const mcp_tools_env_t *env);

/**
 * Replace the environment (e.g. after voice_app applied a new configuration).
 * The struct is copied; NULL resets to the read-only default environment.
 */
void mcp_server_set_env(mcp_server_t *server, const mcp_tools_env_t *env);

void mcp_server_destroy(mcp_server_t *server);

/**
 * Handle one JSON-RPC payload synchronously and invoke the send callback.
 * Notifications (no "id") produce no response, per JSON-RPC 2.0.
 */
void mcp_server_handle_json(mcp_server_t *server, const char *payload, size_t len);

#ifdef __cplusplus
}
#endif
