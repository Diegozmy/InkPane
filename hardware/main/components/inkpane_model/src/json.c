#include "inkpane_json.h"

#include <stdlib.h>
#include <string.h>

#define JSON_MAX_DEPTH 32

typedef struct {
    const char *cursor;
    const char *end;
    json_doc_t *doc;
    int depth;
} parser_t;

static void *arena_alloc(json_doc_t *doc, size_t size)
{
    size = (size + 7u) & ~(size_t)7u;
    if (doc->used + size > doc->capacity) {
        return NULL;
    }
    void *pointer = doc->arena + doc->used;
    doc->used += size;
    memset(pointer, 0, size);
    return pointer;
}

static void skip_space(parser_t *parser)
{
    while (parser->cursor < parser->end) {
        char ch = *parser->cursor;
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
            parser->cursor++;
        } else {
            break;
        }
    }
}

static bool parse_value(parser_t *parser, json_value_t **out);

static int hex_value(char ch)
{
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static bool read_hex4(const char *p, unsigned *out)
{
    unsigned value = 0;
    for (int i = 0; i < 4; ++i) {
        int digit = hex_value(p[i]);
        if (digit < 0) return false;
        value = (value << 4) | (unsigned)digit;
    }
    *out = value;
    return true;
}

static size_t utf8_encode(unsigned codepoint, char *out)
{
    if (codepoint < 0x80) {
        out[0] = (char)codepoint;
        return 1;
    }
    if (codepoint < 0x800) {
        out[0] = (char)(0xC0 | (codepoint >> 6));
        out[1] = (char)(0x80 | (codepoint & 0x3F));
        return 2;
    }
    if (codepoint < 0x10000) {
        out[0] = (char)(0xE0 | (codepoint >> 12));
        out[1] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
        out[2] = (char)(0x80 | (codepoint & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (codepoint >> 18));
    out[1] = (char)(0x80 | ((codepoint >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((codepoint >> 6) & 0x3F));
    out[3] = (char)(0x80 | (codepoint & 0x3F));
    return 4;
}

/* First pass: validate the literal and return its decoded byte length. */
static bool scan_string(const char *start, const char *end, size_t *decoded_len, const char **after)
{
    const char *p = start;
    size_t length = 0;
    while (p < end) {
        unsigned char ch = (unsigned char)*p;
        if (ch == '"') {
            *decoded_len = length;
            *after = p + 1;
            return true;
        }
        if (ch < 0x20) {
            return false;
        }
        if (ch != '\\') {
            length += 1;
            p += 1;
            continue;
        }
        p += 1;
        if (p >= end) return false;
        char escape = *p++;
        switch (escape) {
        case '"': case '\\': case '/': case 'b': case 'f': case 'n': case 'r': case 't':
            length += 1;
            break;
        case 'u': {
            if (p + 4 > end) return false;
            unsigned codepoint = 0;
            if (!read_hex4(p, &codepoint)) return false;
            p += 4;
            if (codepoint >= 0xD800 && codepoint <= 0xDBFF) {
                if (p + 6 > end || p[0] != '\\' || p[1] != 'u') return false;
                unsigned low = 0;
                if (!read_hex4(p + 2, &low)) return false;
                if (low < 0xDC00 || low > 0xDFFF) return false;
                codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00);
                p += 6;
            }
            length += codepoint < 0x80 ? 1 : (codepoint < 0x800 ? 2 : (codepoint < 0x10000 ? 3 : 4));
            break;
        }
        default:
            return false;
        }
    }
    return false;
}

static char *decode_string(parser_t *parser)
{
    const char *start = parser->cursor;
    size_t decoded_len = 0;
    const char *after = NULL;
    if (!scan_string(start, parser->end, &decoded_len, &after)) {
        return NULL;
    }
    char *buffer = arena_alloc(parser->doc, decoded_len + 1);
    if (buffer == NULL) {
        return NULL;
    }
    char *out = buffer;
    const char *p = start;
    while (p < after - 1) {
        unsigned char ch = (unsigned char)*p;
        if (ch != '\\') {
            *out++ = (char)ch;
            p += 1;
            continue;
        }
        p += 1;
        char escape = *p++;
        switch (escape) {
        case '"': *out++ = '"'; break;
        case '\\': *out++ = '\\'; break;
        case '/': *out++ = '/'; break;
        case 'b': *out++ = '\b'; break;
        case 'f': *out++ = '\f'; break;
        case 'n': *out++ = '\n'; break;
        case 'r': *out++ = '\r'; break;
        case 't': *out++ = '\t'; break;
        case 'u': {
            unsigned codepoint = 0;
            read_hex4(p, &codepoint);
            p += 4;
            if (codepoint >= 0xD800 && codepoint <= 0xDBFF) {
                unsigned low = 0;
                read_hex4(p + 2, &low);
                p += 6;
                codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00);
            }
            out += utf8_encode(codepoint, out);
            break;
        }
        default:
            return NULL;
        }
    }
    *out = '\0';
    parser->cursor = after;
    return buffer;
}

static json_value_t *new_value(parser_t *parser, json_type_t type)
{
    json_value_t *value = arena_alloc(parser->doc, sizeof(json_value_t));
    if (value != NULL) {
        value->type = type;
    }
    return value;
}

static bool parse_object(parser_t *parser, json_value_t *object)
{
    json_value_t *tail = NULL;
    parser->cursor++; /* '{' */
    skip_space(parser);
    if (parser->cursor < parser->end && *parser->cursor == '}') {
        parser->cursor++;
        return true;
    }
    for (;;) {
        skip_space(parser);
        if (parser->cursor >= parser->end || *parser->cursor != '"') {
            return false;
        }
        parser->cursor++;
        char *key = decode_string(parser);
        if (key == NULL) {
            return false;
        }
        skip_space(parser);
        if (parser->cursor >= parser->end || *parser->cursor != ':') {
            return false;
        }
        parser->cursor++;
        json_value_t *child = NULL;
        if (!parse_value(parser, &child)) {
            return false;
        }
        child->key = key;
        if (tail == NULL) {
            object->first = child;
        } else {
            tail->next = child;
        }
        tail = child;
        skip_space(parser);
        if (parser->cursor >= parser->end) {
            return false;
        }
        if (*parser->cursor == ',') {
            parser->cursor++;
            continue;
        }
        if (*parser->cursor == '}') {
            parser->cursor++;
            return true;
        }
        return false;
    }
}

static bool parse_array(parser_t *parser, json_value_t *array)
{
    json_value_t *tail = NULL;
    parser->cursor++; /* '[' */
    skip_space(parser);
    if (parser->cursor < parser->end && *parser->cursor == ']') {
        parser->cursor++;
        return true;
    }
    for (;;) {
        json_value_t *child = NULL;
        if (!parse_value(parser, &child)) {
            return false;
        }
        if (tail == NULL) {
            array->first = child;
        } else {
            tail->next = child;
        }
        tail = child;
        skip_space(parser);
        if (parser->cursor >= parser->end) {
            return false;
        }
        if (*parser->cursor == ',') {
            parser->cursor++;
            continue;
        }
        if (*parser->cursor == ']') {
            parser->cursor++;
            return true;
        }
        return false;
    }
}

static bool parse_number(parser_t *parser, json_value_t *value)
{
    char *after = NULL;
    double number = strtod(parser->cursor, &after);
    if (after == NULL || after == parser->cursor || after > parser->end) {
        return false;
    }
    value->type = JSON_NUMBER;
    value->number = number;
    parser->cursor = after;
    return true;
}

static bool parse_literal(parser_t *parser, const char *literal, json_type_t type, bool boolean,
                          json_value_t **out)
{
    size_t length = strlen(literal);
    if ((size_t)(parser->end - parser->cursor) < length ||
        strncmp(parser->cursor, literal, length) != 0) {
        return false;
    }
    parser->cursor += length;
    json_value_t *value = new_value(parser, type);
    if (value == NULL) {
        return false;
    }
    value->boolean = boolean;
    *out = value;
    return true;
}

static bool parse_value(parser_t *parser, json_value_t **out)
{
    if (parser->depth >= JSON_MAX_DEPTH) {
        return false;
    }
    skip_space(parser);
    if (parser->cursor >= parser->end) {
        return false;
    }
    char ch = *parser->cursor;
    json_value_t *value = NULL;

    if (ch == '{') {
        value = new_value(parser, JSON_OBJECT);
        if (value == NULL) return false;
        parser->depth++;
        bool ok = parse_object(parser, value);
        parser->depth--;
        if (!ok) return false;
        *out = value;
        return true;
    }
    if (ch == '[') {
        value = new_value(parser, JSON_ARRAY);
        if (value == NULL) return false;
        parser->depth++;
        bool ok = parse_array(parser, value);
        parser->depth--;
        if (!ok) return false;
        *out = value;
        return true;
    }
    if (ch == '"') {
        parser->cursor++;
        char *text = decode_string(parser);
        if (text == NULL) return false;
        value = new_value(parser, JSON_STRING);
        if (value == NULL) return false;
        value->string = text;
        *out = value;
        return true;
    }
    if (ch == 't') {
        return parse_literal(parser, "true", JSON_BOOL, true, out);
    }
    if (ch == 'f') {
        return parse_literal(parser, "false", JSON_BOOL, false, out);
    }
    if (ch == 'n') {
        return parse_literal(parser, "null", JSON_NULL, false, out);
    }
    value = new_value(parser, JSON_NUMBER);
    if (value == NULL) {
        return false;
    }
    if (!parse_number(parser, value)) {
        return false;
    }
    *out = value;
    return true;
}

bool json_parse(json_doc_t *doc, const char *text, size_t len, char *arena, size_t arena_size)
{
    if (doc == NULL || text == NULL || arena == NULL || arena_size < 64) {
        return false;
    }
    doc->arena = arena;
    doc->capacity = arena_size;
    doc->used = 0;
    doc->root = NULL;

    parser_t parser = {
        .cursor = text,
        .end = text + len,
        .doc = doc,
        .depth = 0,
    };
    json_value_t *root = NULL;
    if (!parse_value(&parser, &root)) {
        doc->root = NULL;
        return false;
    }
    skip_space(&parser);
    if (parser.cursor != parser.end) {
        doc->root = NULL;
        return false;
    }
    doc->root = root;
    return true;
}

const json_value_t *json_object_get(const json_value_t *object, const char *key)
{
    if (object == NULL || object->type != JSON_OBJECT || key == NULL) {
        return NULL;
    }
    for (const json_value_t *child = object->first; child != NULL; child = child->next) {
        if (child->key != NULL && strcmp(child->key, key) == 0) {
            return child;
        }
    }
    return NULL;
}

const char *json_string(const json_value_t *value)
{
    return (value != NULL && value->type == JSON_STRING) ? value->string : NULL;
}

double json_number(const json_value_t *value, double fallback)
{
    return (value != NULL && value->type == JSON_NUMBER) ? value->number : fallback;
}

bool json_bool(const json_value_t *value, bool fallback)
{
    if (value == NULL) return fallback;
    if (value->type == JSON_BOOL) return value->boolean;
    return fallback;
}

int json_array_size(const json_value_t *value)
{
    if (value == NULL || value->type != JSON_ARRAY) return 0;
    int count = 0;
    for (const json_value_t *child = value->first; child != NULL; child = child->next) {
        count++;
    }
    return count;
}

const json_value_t *json_array_at(const json_value_t *value, int index)
{
    if (value == NULL || value->type != JSON_ARRAY || index < 0) return NULL;
    const json_value_t *child = value->first;
    for (int i = 0; child != NULL && i < index; ++i) {
        child = child->next;
    }
    return child;
}
