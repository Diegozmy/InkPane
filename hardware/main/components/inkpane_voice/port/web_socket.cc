#include "web_socket.h"

#include <cstdint>
#include <cstring>
#include <string>
#include <utility>

#include <esp_crt_bundle.h>
#include <esp_event.h>
#include <esp_log.h>
#include <esp_transport_ws.h>
#include <esp_websocket_client.h>
#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#define TAG "voice_ws"

namespace {

constexpr EventBits_t kConnectedBit = BIT0;
constexpr EventBits_t kDisconnectedBit = BIT1;
constexpr EventBits_t kErrorBit = BIT2;

constexpr int kConnectTimeoutMs = 10000;
constexpr int kSendTimeoutMs = 5000;
constexpr int kPongTimeoutMs = 2000;
constexpr int kRxBufferSize = 4096;
constexpr int kTaskStackSize = 6144;

}  // namespace

struct WebSocket::Impl {
    esp_websocket_client_handle_t client = nullptr;
    EventGroupHandle_t events = nullptr;

    std::string url;
    std::string headers;

    DataCallback on_data;
    PingCallback on_ping;
    DisconnectedCallback on_disconnected;

    bool connected = false;

    /* Reassembly buffer for WebSocket messages larger than the rx buffer. */
    std::string rx_message;
    bool rx_binary = false;
    int rx_payload_len = 0;

    static void EventHandler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data);

    void HandleConnected();
    void HandleDisconnected();
    void HandleDataEvent(const esp_websocket_event_data_t &event);
    void DeliverMessage();

    void NotifyDisconnected();
    bool StartClient();
    void StopClient();
};

void WebSocket::Impl::NotifyDisconnected()
{
    if (!connected) {
        return;
    }
    connected = false;
    if (on_disconnected) {
        on_disconnected();
    }
}

void WebSocket::Impl::HandleConnected()
{
    connected = true;
    rx_message.clear();
    rx_payload_len = 0;
    if (events != nullptr) {
        xEventGroupSetBits(events, kConnectedBit);
    }
    ESP_LOGI(TAG, "connected to %s", url.c_str());
}

void WebSocket::Impl::HandleDisconnected()
{
    const bool was_connected = connected;
    NotifyDisconnected();
    if (events != nullptr) {
        xEventGroupSetBits(events, kDisconnectedBit);
    }
    ESP_LOGI(TAG, "disconnected from %s (was_connected=%d)", url.c_str(), was_connected ? 1 : 0);
}

void WebSocket::Impl::DeliverMessage()
{
    if (on_data) {
        on_data(rx_message.data(), rx_message.size(), rx_binary);
    }
    rx_message.clear();
    rx_payload_len = 0;
}

void WebSocket::Impl::HandleDataEvent(const esp_websocket_event_data_t &event)
{
    const char *data = event.data_ptr;
    const size_t length = event.data_len > 0 ? static_cast<size_t>(event.data_len) : 0;

    switch (event.op_code) {
    case WS_TRANSPORT_OPCODES_PING:
        if (on_ping) {
            on_ping(length > 0 && data != nullptr ? data : "", length);
        }
        break;
    case WS_TRANSPORT_OPCODES_PONG:
    case WS_TRANSPORT_OPCODES_CLOSE:
    case WS_TRANSPORT_OPCODES_FIN:
        break;
    case WS_TRANSPORT_OPCODES_TEXT:
    case WS_TRANSPORT_OPCODES_BINARY:
    case WS_TRANSPORT_OPCODES_CONT:
        if (event.op_code != WS_TRANSPORT_OPCODES_CONT) {
            rx_binary = event.op_code == WS_TRANSPORT_OPCODES_BINARY;
            rx_payload_len = event.payload_len > 0 ? event.payload_len : event.data_len;
            rx_message.clear();
        } else if (rx_payload_len == 0) {
            rx_payload_len = event.payload_len > 0 ? event.payload_len : 0;
        }
        if (length > 0 && data != nullptr) {
            rx_message.append(data, length);
        }
        if (event.payload_offset + event.data_len >= rx_payload_len) {
            DeliverMessage();
        }
        break;
    default:
        ESP_LOGD(TAG, "ignoring websocket opcode 0x%02x", event.op_code);
        break;
    }
}

void WebSocket::Impl::EventHandler(void *arg, esp_event_base_t base, int32_t event_id,
                                   void *event_data)
{
    (void)base;
    auto *self = static_cast<Impl *>(arg);
    if (self == nullptr) {
        return;
    }
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        self->HandleConnected();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        self->HandleDisconnected();
        break;
    case WEBSOCKET_EVENT_CLOSED:
        /* Server-initiated clean close: esp_websocket_client reports CLOSED
         * instead of DISCONNECTED, but the state machine must still see it. */
        self->HandleDisconnected();
        break;
    case WEBSOCKET_EVENT_ERROR: {
        const auto *event = static_cast<esp_websocket_event_data_t *>(event_data);
        if (event != nullptr && event->data_ptr != nullptr) {
            ESP_LOGE(TAG, "websocket error: %.*s", event->data_len, event->data_ptr);
        } else {
            ESP_LOGE(TAG, "websocket error");
        }
        if (event != nullptr) {
            ESP_LOGE(TAG, "  type=%d handshake_status=%d tls_err=%d tls_flags=%d sock_errno=%d",
                     static_cast<int>(event->error_handle.error_type),
                     event->error_handle.esp_ws_handshake_status_code,
                     event->error_handle.esp_tls_last_esp_err,
                     event->error_handle.esp_tls_cert_verify_flags,
                     event->error_handle.esp_transport_sock_errno);
        }
        if (self->events != nullptr) {
            xEventGroupSetBits(self->events, kErrorBit);
        }
        break;
    }
    case WEBSOCKET_EVENT_DATA:
        if (event_data != nullptr) {
            self->HandleDataEvent(*static_cast<esp_websocket_event_data_t *>(event_data));
        }
        break;
    default:
        break;
    }
}

bool WebSocket::Impl::StartClient()
{
    if (client != nullptr) {
        return true;
    }
    if (url.empty()) {
        ESP_LOGE(TAG, "cannot connect: empty websocket url");
        return false;
    }

    esp_websocket_client_config_t config = {};
    config.uri = url.c_str();
    config.headers = headers.empty() ? nullptr : headers.c_str();
    config.disable_auto_reconnect = true;
    config.enable_close_reconnect = false;
    config.network_timeout_ms = kConnectTimeoutMs;
    config.reconnect_timeout_ms = kConnectTimeoutMs;
    config.buffer_size = kRxBufferSize;
    config.task_stack = kTaskStackSize;
    config.user_context = this;
    config.crt_bundle_attach = esp_crt_bundle_attach;

    client = esp_websocket_client_init(&config);
    if (client == nullptr) {
        ESP_LOGE(TAG, "esp_websocket_client_init failed for %s", url.c_str());
        return false;
    }
    esp_err_t err = esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY,
                                                  &Impl::EventHandler, this);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_websocket_register_events failed: %s", esp_err_to_name(err));
        esp_websocket_client_destroy(client);
        client = nullptr;
        return false;
    }
    err = esp_websocket_client_start(client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_websocket_client_start failed: %s", esp_err_to_name(err));
        esp_websocket_client_destroy(client);
        client = nullptr;
        return false;
    }
    return true;
}

void WebSocket::Impl::StopClient()
{
    if (client == nullptr) {
        return;
    }
    esp_websocket_client_stop(client);
    esp_websocket_client_destroy(client);
    client = nullptr;
}

WebSocket::WebSocket() : impl_(new Impl())
{
    impl_->events = xEventGroupCreate();
    if (impl_->events == nullptr) {
        ESP_LOGE(TAG, "failed to create websocket event group");
    }
}

WebSocket::~WebSocket()
{
    if (impl_ == nullptr) {
        return;
    }
    impl_->StopClient();
    if (impl_->events != nullptr) {
        vEventGroupDelete(impl_->events);
        impl_->events = nullptr;
    }
}

std::unique_ptr<WebSocket> WebSocket::Create()
{
    return std::unique_ptr<WebSocket>(new WebSocket());
}

void WebSocket::SetHeader(const char *key, const char *value)
{
    if (impl_ == nullptr || key == nullptr || key[0] == '\0' || value == nullptr) {
        return;
    }
    if (impl_->client != nullptr) {
        ESP_LOGW(TAG, "SetHeader('%s') ignored: client already created", key);
        return;
    }
    impl_->headers.append(key);
    impl_->headers.append(": ");
    impl_->headers.append(value);
    impl_->headers.append("\r\n");
}

bool WebSocket::Connect(const char *url)
{
    if (impl_ == nullptr || url == nullptr || url[0] == '\0') {
        return false;
    }
    if (impl_->connected) {
        return true;
    }
    if (impl_->events == nullptr) {
        return false;
    }

    impl_->url = url;
    impl_->connected = false;
    /* Connect() always means "start a fresh connection": drop any previous
     * client (failed attempt or dropped link) so the retry really reconnects. */
    impl_->StopClient();
    xEventGroupClearBits(impl_->events, kConnectedBit | kDisconnectedBit | kErrorBit);

    if (!impl_->StartClient()) {
        return false;
    }

    ESP_LOGI(TAG, "connecting to %s", url);
    EventBits_t bits = xEventGroupWaitBits(impl_->events, kConnectedBit | kDisconnectedBit | kErrorBit,
                                           pdTRUE, pdFALSE, pdMS_TO_TICKS(kConnectTimeoutMs));
    if ((bits & kConnectedBit) != 0) {
        return true;
    }
    if ((bits & kErrorBit) != 0) {
        ESP_LOGE(TAG, "websocket handshake failed: %s", url);
    } else if ((bits & kDisconnectedBit) != 0) {
        ESP_LOGE(TAG, "websocket disconnected before handshake completed: %s", url);
    } else {
        ESP_LOGE(TAG, "websocket connect timed out (%d ms): %s", kConnectTimeoutMs, url);
    }
    impl_->StopClient();
    return false;
}

bool WebSocket::Send(const char *data, size_t len, bool binary)
{
    if (impl_ == nullptr || impl_->client == nullptr || data == nullptr || len == 0) {
        return false;
    }
    if (!IsConnected()) {
        return false;
    }
    if (len > static_cast<size_t>(INT32_MAX)) {
        ESP_LOGE(TAG, "refusing to send %u bytes in one websocket frame", static_cast<unsigned>(len));
        return false;
    }
    const int length = static_cast<int>(len);
    const TickType_t timeout = pdMS_TO_TICKS(kSendTimeoutMs);
    const int sent = binary ? esp_websocket_client_send_bin(impl_->client, data, length, timeout)
                            : esp_websocket_client_send_text(impl_->client, data, length, timeout);
    if (sent != length) {
        ESP_LOGE(TAG, "websocket send failed (%d/%d, binary=%d)", sent, length, binary ? 1 : 0);
        return false;
    }
    return true;
}

bool WebSocket::Send(const std::string &text)
{
    return Send(text.data(), text.size(), false);
}

bool WebSocket::SendPong(const char *data, size_t len)
{
    if (impl_ == nullptr || impl_->client == nullptr || !IsConnected()) {
        return false;
    }
    if (len > static_cast<size_t>(INT32_MAX)) {
        return false;
    }
    const int sent = esp_websocket_client_send_with_opcode(
        impl_->client, WS_TRANSPORT_OPCODES_PONG,
        len > 0 ? reinterpret_cast<const uint8_t *>(data) : nullptr, static_cast<int>(len),
        pdMS_TO_TICKS(kPongTimeoutMs));
    return sent == static_cast<int>(len);
}

bool WebSocket::IsConnected() const
{
    if (impl_ == nullptr || impl_->client == nullptr || !impl_->connected) {
        return false;
    }
    return esp_websocket_client_is_connected(impl_->client);
}

void WebSocket::OnData(DataCallback callback)
{
    if (impl_ != nullptr) {
        impl_->on_data = std::move(callback);
    }
}

void WebSocket::OnPing(PingCallback callback)
{
    if (impl_ != nullptr) {
        impl_->on_ping = std::move(callback);
    }
}

void WebSocket::OnDisconnected(DisconnectedCallback callback)
{
    if (impl_ != nullptr) {
        impl_->on_disconnected = std::move(callback);
    }
}
