idf_component_register(
    SRCS "src/canvas.c" "src/font.c" "src/ui.c"
    INCLUDE_DIRS "include"
    REQUIRES inkpane_model
    EMBED_FILES "fonts/inkpane_fonts.bin"
)

# The UI formats bounded screen values (months, days, temperatures); the
# compiler cannot see those bounds and flags harmless truncation warnings.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-format-truncation)
