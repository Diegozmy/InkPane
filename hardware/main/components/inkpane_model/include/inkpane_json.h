#pragma once

#include <stdbool.h>
#include <stddef.h>

/**
 * Minimal JSON reader used by the device payload parser.
 *
 * It is deliberately small (no printing, no mutation) and allocates every
 * node and string from a caller-provided arena, so parsing never fragments the
 * main heap and can be reused every wake-up.
 */

typedef enum {
    JSON_NULL,
    JSON_BOOL,
    JSON_NUMBER,
    JSON_STRING,
    JSON_ARRAY,
    JSON_OBJECT,
} json_type_t;

typedef struct json_value {
    json_type_t type;
    bool boolean;
    double number;
    const char *string;
    const char *key;
    struct json_value *first;
    struct json_value *next;
} json_value_t;

typedef struct {
    char *arena;
    size_t capacity;
    size_t used;
    json_value_t *root;
} json_doc_t;

/** Parse `text` (must be NUL-terminated within `len`). Returns false on error. */
bool json_parse(json_doc_t *doc, const char *text, size_t len, char *arena, size_t arena_size);

/** Look up a key in an object; returns NULL when absent or not an object. */
const json_value_t *json_object_get(const json_value_t *object, const char *key);

const char *json_string(const json_value_t *value);
double json_number(const json_value_t *value, double fallback);
bool json_bool(const json_value_t *value, bool fallback);
int json_array_size(const json_value_t *value);
const json_value_t *json_array_at(const json_value_t *value, int index);
