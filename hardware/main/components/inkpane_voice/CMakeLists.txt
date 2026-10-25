# InkPane voice assistant component.
#
# Layout:
#   upstream/  verbatim xiaozhi-esp32 audio/protocol sources (MIT, see
#              upstream/PROVENANCE.md) with only the documented shims applied.
#   port/      InkPane-owned adapters: ES8311 board bring-up, OTA/activation,
#              WebSocket transport, NVS settings, MCP server/tools and the
#              voice_app state machine.
idf_component_register(
    SRCS
        "port/voice_app.cc"
        "port/voice_board.cc"
        "port/settings.cc"
        "port/web_socket.cc"
        "port/voice_ota.cc"
        "port/inkpane_api.c"
        "port/mcp_server.c"
        "port/mcp_tools.c"
        "upstream/audio/audio_codec.cc"
        "upstream/audio/audio_debugger.cc"
        "upstream/audio/audio_service.cc"
        "upstream/audio/codecs/es8311_audio_codec.cc"
        "upstream/audio/engines/afe_audio_engine.cc"
        "upstream/audio/wake_words/custom_wake_word.cc"
        "upstream/audio/wake_words/wake_word_audio_cache.cc"
        "upstream/protocols/protocol.cc"
        "upstream/protocols/websocket_protocol.cc"
    INCLUDE_DIRS
        "include"
        "port"
        "upstream"
        "upstream/audio"
        "upstream/audio/codecs"
        "upstream/audio/engines"
        "upstream/audio/wake_words"
        "upstream/protocols"
    REQUIRES
        inkpane_board
        inkpane_net
        inkpane_model
        esp_timer
        esp_driver_i2s
        esp_http_client
        mbedtls
        esp_netif
        nvs_flash
        app_update
        esp_partition
        tcp_transport
)

target_compile_features(${COMPONENT_LIB} PRIVATE cxx_std_17)

# The vendored xiaozhi codebase is warning-noisy under InkPane's -Werror build.
# Keep real compile errors, but do not fail the build on upstream warnings.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-error)

# Capability macros normally provided by xiaozhi's Kconfig. InkPane always uses
# the AFE for VAD/uplink, supports the server-side AEC timestamp protocol, has no
# playback reference channel, and does not upload wake-word audio.
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    CONFIG_USE_AUDIO_PROCESSOR=1
    CONFIG_USE_SERVER_AEC=1
    CONFIG_USE_DEVICE_AEC=0
    CONFIG_SEND_WAKE_WORD_DATA=0
)
