#pragma once

/**
 * WebSocket transport used by the vendored xiaozhi protocol code.
 *
 * This is a thin wrapper over the managed `espressif/esp_websocket_client`
 * component (include <esp_websocket_client.h>). It exposes exactly the surface
 * the upstream `websocket_protocol.cc` expects:
 *
 *     auto ws = WebSocket::Create();
 *     ws->SetHeader("Authorization", "Bearer ...");
 *     ws->OnData([](const char* data, size_t len, bool binary) { ... });
 *     ws->OnPing([](const char* data, size_t len) { ... });
 *     ws->OnDisconnected([]() { ... });
 *     if (!ws->Connect(url)) { ... }
 *
 * Notes:
 *  - ws:// and wss:// are both supported; wss:// verifies the server with the
 *    ESP-IDF certificate bundle (esp_crt_bundle_attach).
 *  - Automatic reconnection is disabled on purpose: the voice state machine
 *    decides when to reconnect (and may rotate the URL/token first).
 *  - Callbacks run on the WebSocket client task. Keep them short and do not
 *    destroy/reset the WebSocket from inside a callback.
 *  - Data callbacks receive one complete WebSocket message: fragmented frames
 *    are reassembled before OnData() is invoked.
 *  - Ping frames are answered automatically by esp_websocket_client; OnPing is
 *    only a notification hook (the upstream code uses it to schedule a manual
 *    SendPong() from the application task).
 */

#include <cstddef>
#include <functional>
#include <memory>
#include <string>

class WebSocket {
public:
    using DataCallback = std::function<void(const char *data, size_t len, bool binary)>;
    using PingCallback = std::function<void(const char *data, size_t len)>;
    using DisconnectedCallback = std::function<void()>;

    static std::unique_ptr<WebSocket> Create();
    ~WebSocket();

    WebSocket(const WebSocket &) = delete;
    WebSocket &operator=(const WebSocket &) = delete;

    /** Add a header sent with the HTTP upgrade request. Must be called before Connect(). */
    void SetHeader(const char *key, const char *value);

    /**
     * Connect and block until the WebSocket handshake succeeds (or fails).
     * Returns false on a bad URL, handshake failure, or 10 s timeout.
     */
    bool Connect(const char *url);

    bool Send(const char *data, size_t len, bool binary);
    bool Send(const std::string &text);
    bool SendPong(const char *data, size_t len);

    bool IsConnected() const;

    void OnData(DataCallback callback);
    void OnPing(PingCallback callback);
    void OnDisconnected(DisconnectedCallback callback);

private:
    WebSocket();

    struct Impl;
    std::unique_ptr<Impl> impl_;
};
