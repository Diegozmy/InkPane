cmake_minimum_required(VERSION 3.20)
project(inkpane_host_tests C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(MSVC)
    add_compile_options(/utf-8 /W3)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS)
else()
    add_compile_options(-Wall -Wextra)
endif()

set(MODEL_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../main/components/inkpane_model")
set(UI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../main/components/inkpane_ui")
set(EPD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../main/components/inkpane_epd")

add_library(inkpane_host_core STATIC
    "${MODEL_DIR}/src/json.c"
    "${MODEL_DIR}/src/time.c"
    "${MODEL_DIR}/src/model.c"
    "${MODEL_DIR}/src/schedule.c"
    "${MODEL_DIR}/src/snapshot.c"
    "${UI_DIR}/src/canvas.c"
    "${UI_DIR}/src/font.c"
    "${UI_DIR}/src/ui.c"
    # ESP-IDF-free geometry helpers of the panel driver (frame_diff has no
    # hardware dependencies, so the host can diff framebuffers too).
    "${EPD_DIR}/src/frame_diff.c"
)

target_include_directories(inkpane_host_core PUBLIC
    "${MODEL_DIR}/include"
    "${UI_DIR}/include"
    "${EPD_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/shim"
)

target_compile_definitions(inkpane_host_core PUBLIC INKPANE_HOST_TEST=1)

add_executable(inkpane_tests test_main.c)
target_link_libraries(inkpane_tests PRIVATE inkpane_host_core)

add_executable(inkpane_preview preview.c)
target_link_libraries(inkpane_preview PRIVATE inkpane_host_core)

# Voice MCP port layer: pure C, no ESP-IDF. mcp_mock.c replaces the device HTTP
# client so tool calls can be asserted without a network.
set(VOICE_PORT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../main/components/inkpane_voice/port")
add_executable(inkpane_mcp_tests
    mcp_test.c
    mcp_mock.c
    "${VOICE_PORT_DIR}/mcp_server.c"
    "${VOICE_PORT_DIR}/mcp_tools.c"
)
target_include_directories(inkpane_mcp_tests PRIVATE "${VOICE_PORT_DIR}")
target_link_libraries(inkpane_mcp_tests PRIVATE inkpane_host_core)
target_compile_definitions(inkpane_mcp_tests PRIVATE INKPANE_HOST_TEST=1)

set(FONT_BLOB "${UI_DIR}/fonts/inkpane_fonts.bin")
set(FIXTURES "${CMAKE_CURRENT_SOURCE_DIR}/../fixtures")

enable_testing()
add_test(NAME inkpane_host COMMAND inkpane_tests "${FONT_BLOB}" "${FIXTURES}")
add_test(NAME inkpane_mcp COMMAND inkpane_mcp_tests)
