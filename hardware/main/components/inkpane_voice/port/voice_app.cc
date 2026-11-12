#include "inkpane_voice.h"

#include "audio_codec.h"
#include "audio_service.h"
#include "voice_board.h"
#include "voice_identity.h"
#include "voice_ota.h"
#include "websocket_protocol.h"

extern "C" {
#include "inkpane_api.h"
#include "mcp_server.h"
#include "mcp_tools.h"
}

extern "C" {
#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "inkpane_board.h"
#include "inkpane_net.h"
#include "inkpane_time.h"
}

#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

#define TAG "voice"

#define VOICE_EVENT_QUEUE_LEN 16
#define VOICE_COMMAND_QUEUE_LEN 24
#define VOICE_MCP_QUEUE_LEN 2
#define VOICE_CONTROL_STACK 8192
#define VOICE_CONTROL_PRIORITY 5
#define VOICE_LISTEN_TIMEOUT_MS 20000
#define VOICE_THINK_TIMEOUT_MS 20000
#define VOICE_SPEAK_TIMEOUT_MS 60000
/* Silence after speech before the client ends the turn itself. Keeps the reply
 * latency independent of the server's (slower) VAD timeout. */
#define VOICE_END_OF_SPEECH_MS 800
/* Continuous conversation: after a reply, reopen the microphone once the
 * speaker has drained and listen for a follow-up without another wake word.
 * The delay starts when playback actually drains, not when the server sends
 * `tts stop`: the local queue can still hold seconds of audio, and reopening
 * the mic resets the decoder (cutting the reply off mid-sentence). */
#define VOICE_FOLLOWUP_DELAY_MS 900
#define VOICE_FOLLOWUP_TIMEOUT_MS 7000
/* Safety net: if the output queue never reports drained, do not leave the
 * microphone disabled forever. Local buffering is capped at ~1.2 s, so this is
 * far beyond any normal reply tail. */
#define VOICE_DRAIN_TIMEOUT_MS 6000
/* The control loop wakes this often so queued microphone audio is never far
 * behind, even when the command queue is busy. */
#define VOICE_LOOP_TICK_MS 20
#define VOICE_ERROR_PAGE_MS 12000

enum class VoiceCmd : uint8_t {
    WakeWord,
    SendAudio,
    ButtonShort,
    ButtonLong,
    NetworkUp,
    NetworkDown,
    ApplyConfig,
    TtsStart,
    TtsStop,
    SttText,
    ReplyText,
    ChannelClosed,
    Error,
    McpPayload,
    Stop,
};

struct VoiceCommand {
    VoiceCmd type;
    char text[512];
};

static std::mutex s_lock;
static inkpane_voice_snapshot_t s_snapshot;
static QueueHandle_t s_event_queue;
static QueueHandle_t s_cmd_queue;
static QueueHandle_t s_mcp_queue;
static TaskHandle_t s_control_task;
static AudioService* s_audio;
static AudioCodec* s_codec;
static WebsocketProtocol* s_protocol;
static mcp_server_t* s_mcp;
static mcp_tools_env_t s_mcp_env;
static volatile bool s_stop;
static volatile bool s_started;
static bool s_activated;
static bool s_muted;
static ListeningMode s_listening_mode = kListeningModeAutoStop;
static int64_t s_last_activity_ms;
static int64_t s_error_since_ms;

/* Microphone audio pending: set by the audio task, drained by the control task.
 * The flag makes audio delivery independent of command-queue space. */
static std::atomic<bool> s_audio_pending{false};
/* Client-side end-of-speech detection (see on_vad_change/control_tick). */
static std::atomic<bool> s_vad_speaking{false};
static std::atomic<bool> s_vad_heard_speech{false};
static std::atomic<int64_t> s_vad_silence_ms{0};
/* First reply packet of a turn; guards a single SPEAKING transition even when
 * the server's tts start message is missing. */
static std::atomic<bool> s_reply_audio_seen{false};
/* The server finished sending the reply, but the local speaker may still hold
 * buffered audio. The turn stays in SPEAKING until it drains (or the safety
 * timeout below fires) so the page never shows 待命 just before the follow-up
 * window reopens the microphone. */
static std::atomic<bool> s_reply_drain_pending{false};
/* Continuous conversation bookkeeping. */
static std::atomic<int64_t> s_followup_at_ms{0};
static std::atomic<bool> s_followup_active{false};
/* Wake word to re-arm after the speaker drains (used when a turn ends while
 * reply audio is still queued). */
static std::atomic<bool> s_wake_pending{false};
static std::atomic<int64_t> s_drain_since_ms{0};

/* Borrowed config strings copied so the caller may reuse its struct. */
static bool s_enabled;
static bool s_allow_control;
static char s_ota_url[INKPANE_VOICE_OTA_URL_LEN];
static char s_ws_url[INKPANE_VOICE_WS_URL_LEN];
static char s_ws_token[INKPANE_VOICE_WS_TOKEN_LEN];
static int s_ws_version = 1;
static char s_mac[18];
static char s_uuid[40];
static char s_timezone[40];
static char s_api_url[INKPANE_URL_LEN];
static char s_api_token[INKPANE_TOKEN_LEN];
static char s_firmware[16];
static char s_wake_words[INKPANE_VOICE_MAX_WAKE_WORDS][INKPANE_VOICE_WAKE_WORD_LEN];
static const char* s_wake_ptrs[INKPANE_VOICE_MAX_WAKE_WORDS];
static int s_wake_count;
static int s_threshold = 65;
static int s_volume = 60;
static int s_utc_offset = 480;

static int64_t now_ms()
{
    return esp_timer_get_time() / 1000;
}

static void copy_str(char* dst, size_t size, const char* src)
{
    if (size == 0) {
        return;
    }
    if (src == nullptr) {
        dst[0] = '\0';
        return;
    }
    size_t length = strlen(src);
    if (length >= size) {
        length = size - 1;
        while (length > 0 && (((unsigned char)src[length]) & 0xC0) == 0x80) {
            --length;
        }
    }
    memcpy(dst, src, length);
    dst[length] = '\0';
}

/* ------------------------------------------------------------------ */
/* Identity accessors used by the ported audio/protocol code           */
/* ------------------------------------------------------------------ */

extern "C" const char* inkpane_voice_device_mac(void) { return s_mac; }
extern "C" const char* inkpane_voice_device_uuid(void) { return s_uuid; }
extern "C" const char* const* inkpane_voice_wake_words(int* count)
{
    if (count != nullptr) {
        *count = s_wake_count;
    }
    return s_wake_ptrs;
}
extern "C" float inkpane_voice_wake_threshold(void)
{
    return (float)s_threshold / 100.0f;
}

/* ------------------------------------------------------------------ */
/* Snapshot + event helpers                                           */
/* ------------------------------------------------------------------ */

static void post_event(inkpane_voice_event_type_t type, const char* ws_url = nullptr,
                       const char* ws_token = nullptr, int version = 0, bool activated = false)
{
    if (s_event_queue == nullptr) {
        return;
    }
    inkpane_voice_event_t event;
    memset(&event, 0, sizeof(event));
    event.type = type;
    if (ws_url != nullptr) {
        copy_str(event.ws_url, sizeof(event.ws_url), ws_url);
    }
    if (ws_token != nullptr) {
        copy_str(event.ws_token, sizeof(event.ws_token), ws_token);
    }
    event.ws_version = version;
    event.activated = activated;
    xQueueSend(s_event_queue, &event, 0);
}

static void snapshot_set_state(inkpane_voice_state_t state)
{
    bool changed = false;
    inkpane_voice_state_t previous;
    {
        std::lock_guard<std::mutex> lock(s_lock);
        previous = s_snapshot.state;
        if (previous != state) {
            s_snapshot.state = state;
            changed = true;
        }
    }
    if (changed) {
        ESP_LOGI(TAG, "state %d -> %d", (int)previous, (int)state);
        post_event(INKPANE_VOICE_EVT_STATE);
    }
}

static inkpane_voice_state_t snapshot_state()
{
    std::lock_guard<std::mutex> lock(s_lock);
    return s_snapshot.state;
}

static void snapshot_reset_text()
{
    std::lock_guard<std::mutex> lock(s_lock);
    s_snapshot.user_text[0] = '\0';
    s_snapshot.reply_text[0] = '\0';
}

static void snapshot_set_user(const char* text)
{
    std::lock_guard<std::mutex> lock(s_lock);
    copy_str(s_snapshot.user_text, sizeof(s_snapshot.user_text), text);
    post_event(INKPANE_VOICE_EVT_TEXT);
}

/**
 * Append one chunk of the assistant's reply.
 *
 * The xiaozhi server delivers the answer as a sequence of `sentence_start`
 * chunks, and those chunks are *fragments of continuous prose*, not finished
 * lines: a single spoken sentence often arrives as "这句" + "话的意思是" +
 * "\"历经磨难\"" + ... . The previous version inserted a '\n' after every
 * chunk, which turned one sentence into one line per fragment: the six reply
 * lines were eaten up by a handful of fragments, leaving blank gaps between
 * them, and a longer answer got truncated after a few fragments.
 *
 * Chunk boundaries are therefore not line breaks. The text is concatenated
 * directly and the renderer wraps it by pixel width, so a long single sentence
 * flow-fills the whole reply area. Only a newline that the server itself puts
 * inside a chunk is preserved (it is a real paragraph break then).
 */
static void snapshot_append_reply(const char* text)
{
    std::lock_guard<std::mutex> lock(s_lock);
    size_t used = strlen(s_snapshot.reply_text);
    size_t capacity = sizeof(s_snapshot.reply_text);
    if (used >= capacity - 1) {
        /* Keep the latest text: drop the oldest half at a UTF-8 boundary. */
        size_t drop = used / 2;
        while (drop < used && (((unsigned char)s_snapshot.reply_text[drop]) & 0xC0) == 0x80) {
            ++drop;
        }
        memmove(s_snapshot.reply_text, s_snapshot.reply_text + drop, used - drop + 1);
        used = strlen(s_snapshot.reply_text);
    }
    /* Continuation fragments must not gain a space of their own; but a chunk
     * that legitimately starts with a space (ASCII prose split mid-phrase) does
     * need one when the buffer does not already end in whitespace. */
    while (*text == ' ') {
        if (used == 0 || s_snapshot.reply_text[used - 1] == ' ' ||
            s_snapshot.reply_text[used - 1] == '\n') {
            ++text;
        } else {
            break;
        }
    }
    /* A chunk-leading newline would create the blank gap this fixes. */
    while (*text == '\n' || *text == '\r') {
        ++text;
    }
    if (*text == '\0') {
        return;
    }
    copy_str(s_snapshot.reply_text + used, capacity - used, text);
    post_event(INKPANE_VOICE_EVT_TEXT);
}

static void snapshot_set_error(const char* text)
{
    std::lock_guard<std::mutex> lock(s_lock);
    copy_str(s_snapshot.error, sizeof(s_snapshot.error), text);
    post_event(INKPANE_VOICE_EVT_ERROR);
}

static void snapshot_set_activation(const char* code, const char* message)
{
    std::lock_guard<std::mutex> lock(s_lock);
    copy_str(s_snapshot.activation_code, sizeof(s_snapshot.activation_code), code);
    copy_str(s_snapshot.activation_message, sizeof(s_snapshot.activation_message), message);
    s_snapshot.activation_visible = true;
    post_event(INKPANE_VOICE_EVT_ACTIVATION);
}

static void snapshot_set_ws(bool connected)
{
    std::lock_guard<std::mutex> lock(s_lock);
    s_snapshot.ws_connected = connected;
}

static bool post_command(VoiceCmd type, const char* text = nullptr)
{
    if (s_cmd_queue == nullptr) {
        return false;
    }
    VoiceCommand command;
    memset(&command, 0, sizeof(command));
    command.type = type;
    if (text != nullptr) {
        copy_str(command.text, sizeof(command.text), text);
    }
    if (xQueueSend(s_cmd_queue, &command, 0) != pdTRUE) {
        /* Audio notifications are retried via s_audio_pending; every other
         * command carries data that would otherwise be lost silently. */
        if (type != VoiceCmd::SendAudio) {
            ESP_LOGW(TAG, "command queue full, dropped type %d", (int)type);
        }
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* MCP bridge                                                         */
/* ------------------------------------------------------------------ */

static int voice_mcp_send(void* context, const char* json, size_t len)
{
    (void)context;
    if (s_protocol == nullptr) {
        return -1;
    }
    s_protocol->SendMcpMessage(std::string(json, len));
    return 0;
}

static bool voice_mcp_time(void* context, int* year, int* month, int* day, int* hour, int* minute,
                           int* second, int* offset_minutes)
{
    (void)context;
    inkpane_datetime_t dt;
    if (!inkpane_board_time_valid() || inkpane_board_time_get(&dt) != ESP_OK) {
        return false;
    }
    *year = dt.year;
    *month = dt.month;
    *day = dt.day;
    *hour = dt.hour;
    *minute = dt.minute;
    *second = dt.second;
    *offset_minutes = s_utc_offset;
    return true;
}

static void voice_mcp_mutation(void* context)
{
    (void)context;
    post_event(INKPANE_VOICE_EVT_REFRESH);
}

/* self.inkpane.screen.zoom: hand the view change to app_main, which owns the
 * panel and the zoomed_module state. The request has to go through the event
 * queue rather than touch the framebuffer from the audio task. */
static int voice_mcp_zoom(void* context, int module)
{
    (void)context;
    if (s_event_queue == nullptr) {
        return -1;
    }
    inkpane_voice_event_t event;
    memset(&event, 0, sizeof(event));
    event.type = INKPANE_VOICE_EVT_ZOOM;
    event.zoom_module = module;
    if (xQueueSend(s_event_queue, &event, 0) != pdTRUE) {
        return -1;
    }
    return 0;
}

static void voice_init_mcp()
{
    memset(&s_mcp_env, 0, sizeof(s_mcp_env));
    s_mcp_env.allow_control = s_allow_control;
    s_mcp_env.get_local_time = voice_mcp_time;
    s_mcp_env.timezone = s_timezone;
    s_mcp_env.on_mutation = voice_mcp_mutation;
    s_mcp_env.on_zoom = voice_mcp_zoom;
    s_mcp = mcp_server_create(voice_mcp_send, nullptr, &s_mcp_env);
}

/* Local providers for the self.inkpane.device.status / volume.set tools. The
 * port layer cannot read board sensors, so voice_app installs them here. */
static int voice_status_json(char* json, size_t capacity)
{
    if (json == nullptr || capacity == 0) {
        return -1;
    }
    int battery = inkpane_board_battery_percent();
    int millivolt = inkpane_board_battery_millivolt();
    inkpane_env_t env;
    bool has_env = inkpane_board_read_env(&env);
    int rssi = inkpane_wifi_rssi();
    int written = snprintf(
        json, capacity,
        "{\"batteryPercent\":%d,\"batteryMillivolt\":%d,\"temperature\":%.1f,"
        "\"humidity\":%.1f,\"rssi\":%d,\"volume\":%d,\"wakeWords\":[\"%s\"],"
        "\"allowControl\":%s}",
        battery, millivolt, has_env ? env.temperature_c : -999.0f,
        has_env ? env.humidity_pct : -1.0f, rssi, s_volume, s_wake_ptrs[0],
        s_allow_control ? "true" : "false");
    if (written < 0 || (size_t)written >= capacity) {
        return -1;
    }
    return written;
}

static int voice_set_volume(int volume)
{
    if (volume < 0 || volume > 100) {
        return -1;
    }
    s_volume = volume;
    if (s_codec != nullptr) {
        s_codec->SetOutputVolume(volume);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Audio callbacks                                                    */
/* ------------------------------------------------------------------ */

static void on_send_queue_available()
{
    s_audio_pending.store(true);
    post_command(VoiceCmd::SendAudio);
}

static void on_wake_word(const std::string& wake_word)
{
    {
        std::lock_guard<std::mutex> lock(s_lock);
        copy_str(s_snapshot.wake_word, sizeof(s_snapshot.wake_word), wake_word.c_str());
    }
    post_command(VoiceCmd::WakeWord, wake_word.c_str());
}

static void on_vad_change(bool speaking)
{
    if (snapshot_state() != INKPANE_VOICE_LISTENING) {
        return;
    }
    if (speaking) {
        s_vad_speaking.store(true);
        s_vad_heard_speech.store(true);
        s_vad_silence_ms.store(0);
        /* A follow-up question arrived: this is a normal turn now. */
        s_followup_active.store(false);
    } else if (s_vad_speaking.load()) {
        s_vad_speaking.store(false);
        s_vad_silence_ms.store(now_ms());
    }
}

static void on_playback_drained() {}

/* ------------------------------------------------------------------ */
/* Protocol callbacks                                                 */
/* ------------------------------------------------------------------ */

static void on_incoming_audio(std::unique_ptr<AudioStreamPacket> packet)
{
    const inkpane_voice_state_t state = snapshot_state();
    if (state != INKPANE_VOICE_CONNECTING && state != INKPANE_VOICE_LISTENING &&
        state != INKPANE_VOICE_THINKING && state != INKPANE_VOICE_SPEAKING) {
        /* Server-initiated audio outside a turn (e.g. the session goodbye after
         * an idle channel): drop it instead of popping up the voice page. */
        ESP_LOGI(TAG, "ignoring stray audio in state %d", (int)state);
        return;
    }
    if (!s_reply_audio_seen.exchange(true)) {
        /* First reply packet of this turn: make sure the page leaves "listening"
         * and the microphone stops streaming, even if tts start was dropped. */
        post_command(VoiceCmd::TtsStart);
    }
    if (s_audio != nullptr) {
        s_audio->PushPacketToDecodeQueue(std::move(packet));
    }
}

static void on_incoming_json(const cJSON* root)
{
    s_last_activity_ms = now_ms();
    const cJSON* type = cJSON_GetObjectItem(root, "type");
    if (!cJSON_IsString(type)) {
        return;
    }
    const char* value = type->valuestring;
    ESP_LOGI(TAG, "ws message: %s", value);
    const inkpane_voice_state_t current = snapshot_state();
    const bool in_turn = current == INKPANE_VOICE_CONNECTING || current == INKPANE_VOICE_LISTENING ||
                         current == INKPANE_VOICE_THINKING || current == INKPANE_VOICE_SPEAKING;
    if (strcmp(value, "stt") == 0) {
        if (!in_turn) {
            ESP_LOGI(TAG, "ignoring stray stt in state %d", (int)current);
            return;
        }
        const cJSON* text = cJSON_GetObjectItem(root, "text");
        if (cJSON_IsString(text)) {
            post_command(VoiceCmd::SttText, text->valuestring);
        }
    } else if (strcmp(value, "tts") == 0) {
        if (!in_turn) {
            /* The server says goodbye when an idle session ends; without this
             * guard the device would pop up the voice page and play it. */
            ESP_LOGI(TAG, "ignoring stray tts in state %d", (int)current);
            return;
        }
        const cJSON* state = cJSON_GetObjectItem(root, "state");
        if (!cJSON_IsString(state)) {
            return;
        }
        if (strcmp(state->valuestring, "start") == 0) {
            post_command(VoiceCmd::TtsStart);
        } else if (strcmp(state->valuestring, "stop") == 0) {
            post_command(VoiceCmd::TtsStop);
        } else if (strcmp(state->valuestring, "sentence_start") == 0) {
            const cJSON* text = cJSON_GetObjectItem(root, "text");
            if (cJSON_IsString(text)) {
                post_command(VoiceCmd::ReplyText, text->valuestring);
            }
        }
    } else if (strcmp(value, "mcp") == 0) {
        const cJSON* payload = cJSON_GetObjectItem(root, "payload");
        if (cJSON_IsObject(payload) && s_mcp_queue != nullptr) {
            char* json = cJSON_PrintUnformatted(payload);
            if (json != nullptr) {
                size_t length = strlen(json);
                char* copy =
                    (char*)heap_caps_malloc(length + 1, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                if (copy == nullptr) {
                    copy = (char*)heap_caps_malloc(length + 1, MALLOC_CAP_INTERNAL);
                }
                if (copy != nullptr) {
                    memcpy(copy, json, length + 1);
                    if (xQueueSend(s_mcp_queue, &copy, 0) != pdTRUE) {
                        heap_caps_free(copy);
                    }
                }
                cJSON_free(json);
            }
        }
    } else if (strcmp(value, "alert") == 0) {
        const cJSON* message = cJSON_GetObjectItem(root, "message");
        if (cJSON_IsString(message)) {
            post_command(VoiceCmd::Error, message->valuestring);
        }
    } else if (strcmp(value, "system") == 0) {
        ESP_LOGI(TAG, "ignoring system command");
    }
}

static void on_audio_channel_opened()
{
    snapshot_set_ws(true);
    s_last_activity_ms = now_ms();
}

static void on_audio_channel_closed()
{
    snapshot_set_ws(false);
    post_command(VoiceCmd::ChannelClosed);
}

static void on_network_error(const std::string& message)
{
    snapshot_set_error(message.c_str());
    post_command(VoiceCmd::Error, message.c_str());
}

/* ------------------------------------------------------------------ */
/* Protocol lifecycle                                                 */
/* ------------------------------------------------------------------ */

/* Opens the WebSocket without touching the voice state: callers decide whether
 * this is a user-visible connect (start_listening) or a silent pre-open. */
static bool open_audio_channel(bool quiet)
{
    if (s_protocol == nullptr) {
        return false;
    }
    if (s_protocol->IsAudioChannelOpened()) {
        return true;
    }
    if (!s_protocol->OpenAudioChannel(quiet)) {
        return false;
    }
    snapshot_set_ws(true);
    return true;
}

/* Pre-open the channel while the assistant idles in READY, so the next wake word
 * only has to send "listen start" instead of a fresh TLS handshake (~1-2 s).
 * Failures stay quiet: the wake path retries and reports them. */
static void prewarm_audio_channel()
{
    if (s_protocol == nullptr || s_protocol->IsAudioChannelOpened()) {
        return;
    }
    if (open_audio_channel(true)) {
        ESP_LOGI(TAG, "audio channel pre-opened");
    }
}

static void send_pending_audio()
{
    if (s_audio == nullptr || s_protocol == nullptr || !s_protocol->IsAudioChannelOpened()) {
        /* Channel still opening: leave the packets queued (start_listening
         * flushes them once the server has been told to listen). */
        return;
    }
    while (auto packet = s_audio->PopPacketFromSendQueue()) {
        if (!s_protocol->SendAudio(std::move(packet))) {
            while (s_audio->PopPacketFromSendQueue()) {
            }
            break;
        }
    }
}

static void close_audio_channel(bool reenable_wake_word)
{
    if (s_protocol != nullptr) {
        s_protocol->CloseAudioChannel();
    }
    s_vad_heard_speech.store(false);
    s_vad_silence_ms.store(0);
    s_vad_speaking.store(false);
    s_reply_drain_pending.store(false);
    s_followup_at_ms.store(0);
    s_followup_active.store(false);
    s_wake_pending.store(false);
    s_drain_since_ms.store(0);
    if (s_audio != nullptr) {
        s_audio->EnableVoiceProcessing(false);
        const bool arm_wake_word = reenable_wake_word && !s_muted;
        if (arm_wake_word && !s_audio->IsPlaybackIdle()) {
            /* The reply may still be draining (e.g. ChannelClosed right after
             * tts stop). Keep the microphone quiet so the speaker tail cannot
             * self-trigger, and arm the wake word from control_tick. */
            s_audio->EnableWakeWordDetection(false);
            s_drain_since_ms.store(now_ms());
            s_wake_pending.store(true);
        } else {
            s_audio->EnableWakeWordDetection(arm_wake_word);
        }
    }
    snapshot_set_ws(false);
}

static void start_listening(ListeningMode mode)
{
    const bool channel_open = s_protocol != nullptr && s_protocol->IsAudioChannelOpened();
    if (!channel_open) {
        snapshot_set_state(INKPANE_VOICE_CONNECTING);
        if (!open_audio_channel(false)) {
            /* Wake capture already started; stop it again so the send queue does
             * not fill with audio for a channel that never opened. */
            s_audio->EnableVoiceProcessing(false);
            snapshot_set_state(INKPANE_VOICE_READY);
            /* A failed follow-up open must not leave the device deaf: the wake
             * word was turned off while the previous turn played. */
            s_audio->EnableWakeWordDetection(!s_muted);
            return;
        }
    }
    s_listening_mode = mode;
    s_vad_speaking.store(false);
    s_vad_heard_speech.store(false);
    s_vad_silence_ms.store(0);
    s_reply_audio_seen.store(false);
    s_reply_drain_pending.store(false);
    s_wake_pending.store(false);
    s_drain_since_ms.store(0);
    s_audio->EnableWakeWordDetection(false);
    s_audio->EnableVoiceProcessing(true);
    s_protocol->SendStartListening(mode);
    snapshot_set_state(INKPANE_VOICE_LISTENING);
    s_last_activity_ms = now_ms();
    /* Frames captured while the handshake ran are still queued; they are sent
     * now that the server has been told to listen, so the first sentence is not
     * lost. */
    post_command(VoiceCmd::SendAudio);
}

static void start_conversation(bool manual)
{
    inkpane_voice_state_t state = snapshot_state();
    if (state != INKPANE_VOICE_READY && state != INKPANE_VOICE_OFFLINE) {
        return;
    }
    if (s_audio == nullptr) {
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return;
    }
    snapshot_reset_text();
    s_reply_drain_pending.store(false);
    s_followup_at_ms.store(0);
    s_followup_active.store(false);
    s_wake_pending.store(false);
    s_drain_since_ms.store(0);
    /* Capture the microphone from the wake instant: if the channel still has to
     * connect, those frames wait in the send queue and are flushed afterwards. */
    s_audio->EnableVoiceProcessing(true);
    start_listening(manual ? kListeningModeManualStop : kListeningModeAutoStop);
}

/* ------------------------------------------------------------------ */
/* Command handling                                                   */
/* ------------------------------------------------------------------ */

static void handle_tts_start()
{
    snapshot_set_state(INKPANE_VOICE_SPEAKING);
    s_vad_heard_speech.store(false);
    s_vad_silence_ms.store(0);
    s_reply_drain_pending.store(false);
    s_followup_at_ms.store(0);
    s_wake_pending.store(false);
    s_drain_since_ms.store(0);
    s_audio->EnableVoiceProcessing(false);
#if CONFIG_INKPANE_VOICE_WAKE_DURING_PLAYBACK
    s_audio->EnableWakeWordDetection(!s_muted);
#else
    s_audio->EnableWakeWordDetection(false);
#endif
    s_last_activity_ms = now_ms();
}

/* The reply has fully played (or the server finished sending with no audio).
 * Either reopen the microphone for a follow-up question or hand control back to
 * the wake word. */
static void conclude_reply()
{
    s_reply_drain_pending.store(false);
    s_drain_since_ms.store(0);
    if (s_enabled && !s_muted && s_audio != nullptr) {
        /* Continuous conversation: keep SPEAKING through the short settle
         * delay, then control_tick reopens the microphone. Staying in SPEAKING
         * makes the page go 正在回答 -> 聆听中; flipping to READY first would
         * flash 待命 right before the follow-up window starts listening, which
         * looks like the device listens on its own after going idle. */
        s_followup_at_ms.store(now_ms() + VOICE_FOLLOWUP_DELAY_MS);
        return;
    }
    if (s_audio != nullptr) {
        s_audio->EnableWakeWordDetection(!s_muted);
    }
    snapshot_set_state(INKPANE_VOICE_READY);
}

static void handle_tts_stop()
{
    /* Keep the WebSocket open across turns: the next wake word then skips the
     * TLS handshake entirely. The server closes the channel when it goes idle,
     * which arrives as ChannelClosed and returns the assistant to READY. */
    s_audio->EnableVoiceProcessing(false);
    /* Do not re-arm the wake word yet. `tts stop` only means the server has
     * finished sending; the local playback queue can still hold seconds of
     * audio, and listening to the speaker tail would self-trigger. The wake
     * word (or the follow-up) is enabled once the output has drained. */
    s_audio->EnableWakeWordDetection(false);
    s_vad_heard_speech.store(false);
    s_vad_silence_ms.store(0);
    s_reply_audio_seen.store(false);
    s_followup_active.store(false);
    s_followup_at_ms.store(0);
    s_last_activity_ms = now_ms();
    /* Stay in SPEAKING until the local speaker is actually quiet: the server's
     * `tts stop` can arrive while seconds of audio are still queued. */
    if (s_audio->IsPlaybackIdle()) {
        conclude_reply();
    } else {
        s_reply_drain_pending.store(true);
        s_drain_since_ms.store(now_ms());
    }
}

static void handle_button_short()
{
    inkpane_voice_state_t state = snapshot_state();
    switch (state) {
    case INKPANE_VOICE_READY:
    case INKPANE_VOICE_OFFLINE:
        start_conversation(true);
        break;
    case INKPANE_VOICE_LISTENING:
        if (s_listening_mode == kListeningModeManualStop) {
            s_protocol->SendStopListening();
            s_audio->EnableVoiceProcessing(false);
            snapshot_set_state(INKPANE_VOICE_THINKING);
            s_last_activity_ms = now_ms();
        } else {
            close_audio_channel(true);
            snapshot_set_state(INKPANE_VOICE_READY);
        }
        break;
    case INKPANE_VOICE_SPEAKING:
        s_protocol->SendAbortSpeaking(kAbortReasonNone);
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
        break;
    case INKPANE_VOICE_THINKING:
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
        break;
    default:
        break;
    }
}

static void handle_button_long()
{
    s_muted = !s_muted;
    {
        std::lock_guard<std::mutex> lock(s_lock);
        s_snapshot.muted = s_muted;
    }
    post_event(INKPANE_VOICE_EVT_STATE);
    if (s_audio != nullptr) {
        if (s_muted) {
            s_audio->EnableWakeWordDetection(false);
            /* Any pending reply drain / follow-up stays in place so
             * control_tick can still take the turn back to READY; it just
             * will not reopen the microphone while muted. */
            if (snapshot_state() == INKPANE_VOICE_READY) {
                s_wake_pending.store(false);
                s_drain_since_ms.store(0);
            }
        } else if (snapshot_state() == INKPANE_VOICE_READY) {
            /* The reply may still be playing; let the drain path re-arm the
             * wake word once the output is quiet. */
            if (s_audio->IsPlaybackIdle()) {
                s_audio->EnableWakeWordDetection(true);
            } else {
                s_drain_since_ms.store(now_ms());
                s_wake_pending.store(true);
            }
        }
    }
}

static void handle_apply_config()
{
    if (s_codec != nullptr) {
        s_codec->SetOutputVolume(s_volume);
    }
    if (s_audio != nullptr) {
        s_audio->ReloadWakeWords();
    }
    if (s_mcp != nullptr) {
        s_mcp_env.allow_control = s_allow_control;
        mcp_server_set_env(s_mcp, &s_mcp_env);
    }
    std::lock_guard<std::mutex> lock(s_lock);
    s_snapshot.control_allowed = s_allow_control;
}

static void handle_error(const char* text)
{
    snapshot_set_error(text != nullptr ? text : "语音服务异常");
    if (s_error_since_ms == 0) {
        s_error_since_ms = now_ms();
    }
    if (snapshot_state() != INKPANE_VOICE_ERROR) {
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_ERROR);
    }
}

static void handle_mcp_payload()
{
    if (s_mcp == nullptr) {
        return;
    }
    char* payload = nullptr;
    if (xQueueReceive(s_mcp_queue, &payload, 0) == pdTRUE && payload != nullptr) {
        mcp_server_handle_json(s_mcp, payload, strlen(payload));
        heap_caps_free(payload);
    }
}

static void control_tick()
{
    int64_t current = now_ms();
    inkpane_voice_state_t state = snapshot_state();
    /* The server finished sending the reply, but the speaker may still hold
     * buffered audio. Only end the turn / reopen the microphone once the output
     * has drained: EnableVoiceProcessing(true) resets the decoder, which would
     * truncate the rest of the reply, and the speaker tail would look like a
     * wake word or user speech. */
    if (s_reply_drain_pending.load() && s_audio != nullptr) {
        if (s_audio->IsPlaybackIdle()) {
            conclude_reply();
            return;
        }
        if (s_drain_since_ms.load() != 0 &&
            current - s_drain_since_ms.load() >= VOICE_DRAIN_TIMEOUT_MS) {
            ESP_LOGW(TAG, "playback drain timeout, ending the turn");
            s_reply_drain_pending.store(false);
            s_followup_at_ms.store(0);
            s_drain_since_ms.store(0);
            snapshot_set_state(INKPANE_VOICE_READY);
            s_audio->EnableWakeWordDetection(!s_muted);
            return;
        }
    }
    /* A channel close can also arrive while reply audio is still queued; re-arm
     * the wake word only once the speaker is quiet. */
    if (s_wake_pending.load() && state == INKPANE_VOICE_READY && s_audio != nullptr &&
        s_audio->IsPlaybackIdle()) {
        s_wake_pending.store(false);
        s_drain_since_ms.store(0);
        s_audio->EnableWakeWordDetection(!s_muted);
        return;
    }
    if (s_wake_pending.load() && state == INKPANE_VOICE_READY && s_drain_since_ms.load() != 0 &&
        current - s_drain_since_ms.load() >= VOICE_DRAIN_TIMEOUT_MS) {
        ESP_LOGW(TAG, "playback drain timeout, re-arming wake word");
        s_wake_pending.store(false);
        s_drain_since_ms.store(0);
        s_audio->EnableWakeWordDetection(!s_muted);
        return;
    }
    /* Continuous conversation: reopen the microphone shortly after a reply,
     * then leave the conversation when nobody follows up. */
    const int64_t followup_at = s_followup_at_ms.load();
    if (followup_at != 0 && current >= followup_at) {
        s_followup_at_ms.store(0);
        if (state == INKPANE_VOICE_READY || state == INKPANE_VOICE_SPEAKING) {
            if (!s_enabled || s_muted) {
                if (s_audio != nullptr) {
                    s_audio->EnableWakeWordDetection(!s_muted);
                }
                snapshot_set_state(INKPANE_VOICE_READY);
                return;
            }
            ESP_LOGI(TAG, "continuous conversation: listening for a follow-up");
            s_followup_active.store(true);
            start_listening(kListeningModeAutoStop);
            s_last_activity_ms = current;
            return;
        }
    }
    if (state == INKPANE_VOICE_LISTENING && s_followup_active.load() &&
        !s_vad_heard_speech.load() &&
        current - s_last_activity_ms >= VOICE_FOLLOWUP_TIMEOUT_MS) {
        ESP_LOGI(TAG, "no follow-up, ending the conversation");
        s_followup_active.store(false);
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
        s_last_activity_ms = current;
        return;
    }
    if (state == INKPANE_VOICE_LISTENING && s_listening_mode == kListeningModeAutoStop &&
        s_vad_heard_speech.load() && !s_vad_speaking.load() && s_vad_silence_ms.load() != 0 &&
        current - s_vad_silence_ms.load() >= VOICE_END_OF_SPEECH_MS) {
        /* Client-side endpointing: the user stopped talking, so finalise the turn
         * now instead of waiting for the server's slower VAD timeout. */
        ESP_LOGI(TAG, "end of speech after %d ms of silence", (int)VOICE_END_OF_SPEECH_MS);
        s_vad_heard_speech.store(false);
        s_vad_silence_ms.store(0);
        s_audio->EnableVoiceProcessing(false);
        if (s_protocol != nullptr) {
            s_protocol->SendStopListening();
        }
        snapshot_set_state(INKPANE_VOICE_THINKING);
        s_last_activity_ms = current;
        return;
    }
    if (state == INKPANE_VOICE_LISTENING &&
        current - s_last_activity_ms > VOICE_LISTEN_TIMEOUT_MS) {
        if (s_listening_mode == kListeningModeManualStop) {
            s_protocol->SendStopListening();
        }
        s_audio->EnableVoiceProcessing(false);
        snapshot_set_state(INKPANE_VOICE_THINKING);
        s_last_activity_ms = current;
    } else if (state == INKPANE_VOICE_THINKING &&
               current - s_last_activity_ms > VOICE_THINK_TIMEOUT_MS) {
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
    } else if (state == INKPANE_VOICE_SPEAKING &&
               current - s_last_activity_ms > VOICE_SPEAK_TIMEOUT_MS) {
        s_protocol->SendAbortSpeaking(kAbortReasonNone);
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
    } else if (state == INKPANE_VOICE_ERROR && s_error_since_ms != 0 &&
               current - s_error_since_ms > VOICE_ERROR_PAGE_MS) {
        s_error_since_ms = 0;
        close_audio_channel(true);
        snapshot_set_state(INKPANE_VOICE_READY);
    }
}

/* ------------------------------------------------------------------ */
/* Init / activation / control task                                   */
/* ------------------------------------------------------------------ */

static bool copy_config(const inkpane_voice_config_t* config)
{
    if (config == nullptr) {
        return false;
    }
    s_enabled = config->enabled;
    s_allow_control = config->allow_control;
    copy_str(s_ota_url, sizeof(s_ota_url), config->ota_url);
    copy_str(s_ws_url, sizeof(s_ws_url), config->ws_url);
    copy_str(s_ws_token, sizeof(s_ws_token), config->ws_token);
    s_ws_version = config->ws_version >= 1 && config->ws_version <= 3 ? config->ws_version : 1;
    copy_str(s_mac, sizeof(s_mac), config->device_mac);
    copy_str(s_uuid, sizeof(s_uuid), config->device_uuid);
    copy_str(s_timezone, sizeof(s_timezone), config->timezone);
    copy_str(s_api_url, sizeof(s_api_url), config->api_url);
    copy_str(s_api_token, sizeof(s_api_token), config->api_token);
    copy_str(s_firmware, sizeof(s_firmware), config->firmware_version);
    s_threshold = config->wake_threshold;
    s_volume = config->volume;
    s_utc_offset = config->utc_offset_minutes;
    s_wake_count = config->wake_word_count;
    if (s_wake_count < 0) {
        s_wake_count = 0;
    }
    if (s_wake_count > INKPANE_VOICE_MAX_WAKE_WORDS) {
        s_wake_count = INKPANE_VOICE_MAX_WAKE_WORDS;
    }
    for (int i = 0; i < s_wake_count; ++i) {
        copy_str(s_wake_words[i], sizeof(s_wake_words[i]), config->wake_words[i]);
        s_wake_ptrs[i] = s_wake_words[i];
    }
    if (s_wake_count == 0) {
        copy_str(s_wake_words[0], sizeof(s_wake_words[0]), "da fen qi");
        s_wake_ptrs[0] = s_wake_words[0];
        s_wake_count = 1;
    }
    s_activated = s_ws_url[0] != '\0';
    return true;
}

static bool ensure_time_ready()
{
    if (time(nullptr) > 1700000000) {
        return true;
    }
    if (inkpane_wifi_sync_time(5000) != ESP_OK) {
        return false;
    }
    inkpane_datetime_t dt;
    int64_t local = (int64_t)time(nullptr) + (int64_t)s_utc_offset * 60;
    inkpane_datetime_from_local_epoch(local, &dt);
    return inkpane_board_time_set(&dt) == ESP_OK;
}

static bool save_session(const VoiceOtaResult& result)
{
    if (result.ws_url.empty()) {
        snapshot_set_error("语音服务未返回 WebSocket 地址");
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return false;
    }
    copy_str(s_ws_url, sizeof(s_ws_url), result.ws_url.c_str());
    copy_str(s_ws_token, sizeof(s_ws_token), result.ws_token.c_str());
    s_ws_version = result.ws_version >= 1 && result.ws_version <= 3 ? result.ws_version : 1;
    s_activated = true;
    {
        std::lock_guard<std::mutex> lock(s_lock);
        s_snapshot.activation_visible = false;
    }
    post_event(INKPANE_VOICE_EVT_SESSION, s_ws_url, s_ws_token, s_ws_version, true);
    ESP_LOGI(TAG, "voice session ready: %s (v%d)", s_ws_url, s_ws_version);
    return true;
}

static bool ensure_activated()
{
    if (s_activated && s_ws_url[0] != '\0') {
        return true;
    }
    if (s_ota_url[0] == '\0') {
        snapshot_set_error("未配置语音 OTA 地址");
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return false;
    }
    if (!ensure_time_ready()) {
        snapshot_set_error("系统时间未校准，无法校验 TLS 证书");
        snapshot_set_state(INKPANE_VOICE_OFFLINE);
        vTaskDelay(pdMS_TO_TICKS(20000));
        return false;
    }

    snapshot_set_state(INKPANE_VOICE_ACTIVATING);
    while (!s_stop) {
        VoiceOtaResult result = voice_ota_check(s_ota_url, s_mac, s_uuid, s_firmware);
        if (result.status == VoiceOtaResult::OK) {
            if (save_session(result)) {
                return true;
            }
            continue;
        }
        if (result.status == VoiceOtaResult::ACTIVATION_REQUIRED) {
            snapshot_set_activation(result.activation_code.c_str(),
                                    result.activation_message.c_str());
            for (int i = 0; i < 10 && !s_stop; ++i) {
                int activation = voice_ota_activate(s_ota_url, s_mac, s_uuid, s_firmware);
                if (activation == 0) {
                    break;
                }
                vTaskDelay(pdMS_TO_TICKS(activation == 1 ? 3000 : 10000));
            }
            continue;
        }
        const char* message = result.status == VoiceOtaResult::MQTT_ONLY
                                  ? "该语音服务仅返回 MQTT 配置，墨窗仅支持 WebSocket"
                                  : (result.error.empty() ? "语音服务暂时不可达"
                                                          : result.error.c_str());
        snapshot_set_error(message);
        snapshot_set_state(INKPANE_VOICE_OFFLINE);
        ESP_LOGW(TAG, "voice OTA failed: %s", message);
        for (int i = 0; i < 30 && !s_stop; ++i) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
    return false;
}

/* Two-note "ready" cue. The board has no UI sounds, so the chime is synthesised
 * as 24 kHz mono PCM and handed to the audio service, which serialises it with
 * TTS playback on the same output task. */
static void build_ready_chime(std::vector<int16_t>& pcm)
{
    constexpr int kRate = 24000;       /* ES8311 duplex rate */
    constexpr float kPi = 3.14159265358979f;
    constexpr float kAmplitude = 0.22f;
    constexpr int kFadeSamples = 144;  /* 6 ms, hides the click */
    constexpr int kGapSamples = 480;   /* 20 ms between notes */
    struct Note {
        float hz;
        int samples;
    };
    const Note notes[] = {{660.0f, 2160}, {990.0f, 3360}}; /* 90 ms + 140 ms */

    size_t total = 0;
    for (const Note& note : notes) {
        total += note.samples + kGapSamples;
    }
    pcm.clear();
    pcm.reserve(total);
    for (const Note& note : notes) {
        for (int i = 0; i < note.samples; ++i) {
            float envelope = 1.0f;
            if (i < kFadeSamples) {
                envelope = static_cast<float>(i) / kFadeSamples;
            } else if (i > note.samples - kFadeSamples) {
                envelope = static_cast<float>(note.samples - i) / kFadeSamples;
            }
            const float phase = 2.0f * kPi * note.hz * static_cast<float>(i) / kRate;
            pcm.push_back(static_cast<int16_t>(sinf(phase) * envelope * kAmplitude * 32767.0f));
        }
        pcm.insert(pcm.end(), kGapSamples, 0);
    }
}

static void play_ready_chime()
{
    if (s_audio == nullptr) {
        return;
    }
    std::vector<int16_t> pcm;
    build_ready_chime(pcm);
    if (!s_audio->PlayLocalPcm(std::move(pcm))) {
        ESP_LOGW(TAG, "ready chime dropped (playback queue busy)");
    }
}

static bool init_audio()
{
    ESP_LOGI(TAG, "audio init: ES8311 codec");
    s_codec = inkpane_voice_board_codec();
    if (s_codec == nullptr) {
        snapshot_set_error("音频编解码器初始化失败（ES8311）");
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return false;
    }
    s_codec->SetOutputVolume(s_volume);

    s_audio = new AudioService();
    if (s_audio == nullptr) {
        snapshot_set_error("音频服务内存不足");
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return false;
    }
    AudioServiceCallbacks callbacks;
    callbacks.on_send_queue_available = on_send_queue_available;
    callbacks.on_wake_word_detected = on_wake_word;
    callbacks.on_vad_change = on_vad_change;
    callbacks.on_playback_drained = on_playback_drained;
    s_audio->SetCallbacks(callbacks);
    ESP_LOGI(TAG, "audio init: starting input/output tasks");
    s_audio->Initialize(s_codec);
    s_audio->Start();
    ESP_LOGI(TAG, "audio init: enabling wake word detection");
    s_audio->EnableWakeWordDetection(true);
    if (!s_audio->IsWakeWordRunning() || s_audio->GetWakeWords().empty()) {
        snapshot_set_error("唤醒词模型未加载，请执行 idf.py flash 烧录 model 分区");
        snapshot_set_state(INKPANE_VOICE_ERROR);
        return false;
    }

    ESP_LOGI(TAG, "audio init: starting websocket protocol");
    s_protocol = new WebsocketProtocol();
    s_protocol->SetConfig(s_ws_url, s_ws_token, s_ws_version);
    s_protocol->OnIncomingAudio(on_incoming_audio);
    s_protocol->OnIncomingJson(on_incoming_json);
    s_protocol->OnAudioChannelOpened(on_audio_channel_opened);
    s_protocol->OnAudioChannelClosed(on_audio_channel_closed);
    s_protocol->OnNetworkError(on_network_error);
    s_protocol->Start();

    ESP_LOGI(TAG, "audio init: MCP server");
    voice_init_mcp();
    mcp_tools_set_device_hooks(voice_status_json, voice_set_volume);
    ESP_LOGI(TAG, "audio init: done");
    return true;
}

static void control_task(void* argument)
{
    (void)argument;
    ESP_LOGI(TAG, "voice control task started");

    if (s_enabled) {
        while (!s_stop && !ensure_activated()) {
            vTaskDelay(pdMS_TO_TICKS(30000));
        }
        if (!s_stop && init_audio()) {
            snapshot_set_state(INKPANE_VOICE_READY);
            post_event(INKPANE_VOICE_EVT_STATE);
            ESP_LOGI(TAG, "voice stack ready");
            play_ready_chime();
            /* Warm the WebSocket before the first wake word so that turn is
             * as fast as every later one. */
            prewarm_audio_channel();
        }
    } else {
        snapshot_set_state(INKPANE_VOICE_DISABLED);
    }

    VoiceCommand command;
    while (!s_stop) {
        if (xQueueReceive(s_cmd_queue, &command, pdMS_TO_TICKS(VOICE_LOOP_TICK_MS)) == pdTRUE) {
            switch (command.type) {
            case VoiceCmd::WakeWord:
                start_conversation(false);
                break;
            case VoiceCmd::SendAudio:
                send_pending_audio();
                break;
            case VoiceCmd::ButtonShort:
                handle_button_short();
                break;
            case VoiceCmd::ButtonLong:
                handle_button_long();
                break;
            case VoiceCmd::NetworkUp:
                if (snapshot_state() == INKPANE_VOICE_OFFLINE) {
                    snapshot_set_state(INKPANE_VOICE_READY);
                }
                break;
            case VoiceCmd::NetworkDown:
                close_audio_channel(false);
                snapshot_set_state(INKPANE_VOICE_OFFLINE);
                break;
            case VoiceCmd::ApplyConfig:
                handle_apply_config();
                break;
            case VoiceCmd::TtsStart:
                handle_tts_start();
                break;
            case VoiceCmd::TtsStop:
                handle_tts_stop();
                break;
            case VoiceCmd::SttText:
                snapshot_set_user(command.text);
                snapshot_set_state(INKPANE_VOICE_THINKING);
                s_last_activity_ms = now_ms();
                break;
            case VoiceCmd::ReplyText:
                snapshot_append_reply(command.text);
                snapshot_set_state(INKPANE_VOICE_SPEAKING);
                s_last_activity_ms = now_ms();
                break;
            case VoiceCmd::ChannelClosed:
                close_audio_channel(true);
                if (snapshot_state() != INKPANE_VOICE_ERROR &&
                    snapshot_state() != INKPANE_VOICE_OFFLINE) {
                    snapshot_set_state(INKPANE_VOICE_READY);
                }
                break;
            case VoiceCmd::Error:
                handle_error(command.text);
                break;
            case VoiceCmd::McpPayload:
                handle_mcp_payload();
                break;
            case VoiceCmd::Stop:
                break;
            default:
                break;
            }
        }
        if (s_audio_pending.exchange(false)) {
            send_pending_audio();
        }
        handle_mcp_payload();
        control_tick();
    }

    close_audio_channel(false);
    if (s_audio != nullptr) {
        s_audio->Stop();
    }
    s_control_task = nullptr;
    vTaskDelete(nullptr);
}

/* ------------------------------------------------------------------ */
/* Public C API                                                       */
/* ------------------------------------------------------------------ */

extern "C" esp_err_t inkpane_voice_init(const inkpane_voice_config_t* config)
{
    if (config == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!copy_config(config)) {
        return ESP_ERR_INVALID_ARG;
    }
    memset(&s_snapshot, 0, sizeof(s_snapshot));
    s_snapshot.state = s_enabled ? INKPANE_VOICE_OFFLINE : INKPANE_VOICE_DISABLED;
    s_snapshot.control_allowed = s_allow_control;
    s_snapshot.muted = false;

    inkpane_api_init(s_api_url, s_api_token);

    if (s_event_queue == nullptr) {
        s_event_queue = xQueueCreate(VOICE_EVENT_QUEUE_LEN, sizeof(inkpane_voice_event_t));
    }
    if (s_cmd_queue == nullptr) {
        s_cmd_queue = xQueueCreate(VOICE_COMMAND_QUEUE_LEN, sizeof(VoiceCommand));
    }
    if (s_mcp_queue == nullptr) {
        s_mcp_queue = xQueueCreate(VOICE_MCP_QUEUE_LEN, sizeof(char*));
    }
    if (s_event_queue == nullptr || s_cmd_queue == nullptr || s_mcp_queue == nullptr) {
        ESP_LOGE(TAG, "cannot create voice queues");
        return ESP_ERR_NO_MEM;
    }
    s_stop = false;
    if (!s_enabled) {
        return ESP_OK;
    }
    return ESP_OK;
}

extern "C" esp_err_t inkpane_voice_apply_config(const inkpane_voice_config_t* config)
{
    if (config == nullptr) {
        return ESP_ERR_INVALID_ARG;
    }
    bool was_activated = s_activated;
    if (!copy_config(config)) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_started) {
        return ESP_OK;
    }
    /* A changed OTA endpoint invalidates the old WebSocket credentials. */
    if (!was_activated || s_ws_url[0] == '\0') {
        s_activated = false;
    }
    post_command(VoiceCmd::ApplyConfig);
    return ESP_OK;
}

extern "C" esp_err_t inkpane_voice_start(void)
{
    if (!s_enabled) {
        return ESP_ERR_NOT_SUPPORTED;
    }
    if (s_started) {
        return ESP_OK;
    }
    if (s_cmd_queue == nullptr) {
        return ESP_ERR_INVALID_STATE;
    }
    s_started = true;
    BaseType_t created = xTaskCreate(control_task, "voice_control", VOICE_CONTROL_STACK, nullptr,
                                     VOICE_CONTROL_PRIORITY, &s_control_task);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

extern "C" void inkpane_voice_stop(void)
{
    s_stop = true;
    post_command(VoiceCmd::Stop);
}

extern "C" bool inkpane_voice_poll_event(inkpane_voice_event_t* out)
{
    if (out == nullptr || s_event_queue == nullptr) {
        return false;
    }
    return xQueueReceive(s_event_queue, out, 0) == pdTRUE;
}

extern "C" void inkpane_voice_get_snapshot(inkpane_voice_snapshot_t* out)
{
    if (out == nullptr) {
        return;
    }
    std::lock_guard<std::mutex> lock(s_lock);
    *out = s_snapshot;
}

extern "C" bool inkpane_voice_session_active(void)
{
    inkpane_voice_state_t state = snapshot_state();
    return state == INKPANE_VOICE_CONNECTING || state == INKPANE_VOICE_LISTENING ||
           state == INKPANE_VOICE_THINKING || state == INKPANE_VOICE_SPEAKING;
}

extern "C" void inkpane_voice_button(bool long_press)
{
    post_command(long_press ? VoiceCmd::ButtonLong : VoiceCmd::ButtonShort);
}

extern "C" void inkpane_voice_set_muted(bool muted)
{
    if (s_muted == muted) {
        return;
    }
    s_muted = muted;
    {
        std::lock_guard<std::mutex> lock(s_lock);
        s_snapshot.muted = muted;
    }
    post_event(INKPANE_VOICE_EVT_STATE);
    if (s_audio != nullptr) {
        if (muted) {
            s_audio->EnableWakeWordDetection(false);
        } else if (snapshot_state() == INKPANE_VOICE_READY) {
            s_audio->EnableWakeWordDetection(true);
        }
    }
}

extern "C" void inkpane_voice_notify_network(bool up)
{
    post_command(up ? VoiceCmd::NetworkUp : VoiceCmd::NetworkDown);
}

extern "C" void inkpane_voice_notify_time_ready(void)
{
    /* Time is validated lazily inside ensure_activated(); nothing to do. */
}

extern "C" void inkpane_voice_set_activation_visible(bool visible)
{
    std::lock_guard<std::mutex> lock(s_lock);
    s_snapshot.activation_visible = visible;
    post_event(INKPANE_VOICE_EVT_ACTIVATION);
}
