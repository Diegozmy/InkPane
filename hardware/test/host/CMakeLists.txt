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

add_library(inkpane_host_core STATIC
    "${MODEL_DIR}/src/json.c"
    "${MODEL_DIR}/src/time.c"
    "${MODEL_DIR}/src/model.c"
    "${MODEL_DIR}/src/schedule.c"
    "${UI_DIR}/src/canvas.c"
    "${UI_DIR}/src/font.c"
    "${UI_DIR}/src/ui.c"
)

target_include_directories(inkpane_host_core PUBLIC
    "${MODEL_DIR}/include"
    "${UI_DIR}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}/shim"
)

target_compile_definitions(inkpane_host_core PUBLIC INKPANE_HOST_TEST=1)

add_executable(inkpane_tests test_main.c)
target_link_libraries(inkpane_tests PRIVATE inkpane_host_core)

add_executable(inkpane_preview preview.c)
target_link_libraries(inkpane_preview PRIVATE inkpane_host_core)

set(FONT_BLOB "${UI_DIR}/fonts/inkpane_fonts.bin")
set(FIXTURES "${CMAKE_CURRENT_SOURCE_DIR}/../fixtures")

enable_testing()
add_test(NAME inkpane_host COMMAND inkpane_tests "${FONT_BLOB}" "${FIXTURES}")
