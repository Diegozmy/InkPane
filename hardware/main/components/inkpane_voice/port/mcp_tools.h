#pragma once

/**
 * InkPane MCP tools (pure C11, host-testable).
 *
 * Each tool validates its arguments, calls the InkPane device HTTP API through
 * inkpane_api_request() and returns either a JSON text (raw API response) or a
 * Chinese error message (mcp_server wraps it into an isError=true result).
 *
 * Tool names:
 *   self.inkpane.context.get      GET  /api/device/context
 *   self.inkpane.device.status    local device status (battery/temp/RSSI/...)
 *   self.inkpane.event.create     POST /api/device/events
 *   self.inkpane.event.cancel     DELETE /api/device/events/{id}
 *   self.inkpane.todo.create      POST /api/device/todos
 *   self.inkpane.todo.complete    PATCH /api/device/todos/{id} {"done":true}
 *   self.inkpane.todo.delete      DELETE /api/device/todos/{id}
 *   self.inkpane.screen.refresh   triggers env->on_mutation
 *   self.inkpane.volume.set       sets the speaker volume (0-100)
 *
 * When allow_control is false only context.get and device.status are exposed
 * (read-only assistant); the server rejects the mutation tools as unknown.
 */

#include <stdbool.h>
#include <stddef.h>

#include "inkpane_json.h"
#include "mcp_server.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Maximum tool result text (raw JSON API body or Chinese error). */
#define MCP_TOOLS_TEXT_MAX 6144
/** Maximum tools/list JSON produced by mcp_tools_list_json(). */
#define MCP_TOOLS_LIST_MAX 8192

/**
 * Local device information providers installed by voice_app.
 *
 * The port layer cannot read the battery/SHTC3/RSSI state itself without
 * pulling board drivers into the voice component, so voice_app (which owns the
 * board handles) installs these hooks once. When no hook is installed:
 *  - device.status returns a minimal static JSON document;
 *  - volume.set reports that volume control is unavailable.
 *
 * status: fill `json` with a NUL-terminated JSON object, return its length
 *         (excluding NUL), or -1 on failure.
 * volume: apply 0-100, return 0 on success.
 */
typedef int (*mcp_tools_status_fn)(char *json, size_t capacity);
typedef int (*mcp_tools_volume_fn)(int volume);

void mcp_tools_set_device_hooks(mcp_tools_status_fn status, mcp_tools_volume_fn set_volume);

/** True when `name` is a known tool under the given allow_control setting. */
bool mcp_tools_is_known(const char *name, bool allow_control);

/**
 * Write the tools/list result ({"tools":[...]}) to out.
 *
 * @return the number of bytes written (excluding the NUL), or -1 when the
 *         output buffer is too small.
 */
int mcp_tools_list_json(bool allow_control, char *out, size_t out_size);

/**
 * Execute one tool call. `arguments` may be NULL (no arguments object).
 *
 * @param text_out  receives the result text (NUL-terminated). On success this
 *                  is the raw JSON API body (or a short Chinese confirmation);
 *                  on failure a Chinese error message.
 * @return 0 on success, -1 on failure (mcp_server sets result.isError=true).
 */
int mcp_tools_call(const mcp_tools_env_t *env, const char *name, const json_value_t *arguments,
                   char *text_out, size_t text_size);

/**
 * Escape `source` as the content of a JSON string (without the quotes).
 *
 * @return the number of bytes written (excluding the NUL), or -1 on overflow.
 */
int mcp_tools_escape_json(const char *source, char *out, size_t out_size);

#ifdef __cplusplus
}
#endif
