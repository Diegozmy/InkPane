#include "mcp_tools.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "inkpane_api.h"

#ifdef INKPANE_HOST_TEST
#define MCP_TOOLS_LOGW(...) ((void)0)
#define MCP_TOOLS_LOGE(...) ((void)0)
#else
#include "esp_log.h"
static const char *TAG = "mcp_tools";
#define MCP_TOOLS_LOGW(...) ESP_LOGW(TAG, __VA_ARGS__)
#define MCP_TOOLS_LOGE(...) ESP_LOGE(TAG, __VA_ARGS__)
#endif

/* ------------------------------------------------------------------ */
/* Tool table                                                          */
/* ------------------------------------------------------------------ */

/* Set for the duration of one tools/call, so a successful write can queue a
 * panel refresh without threading the env through every helper. */
static const mcp_tools_env_t *s_call_env;

typedef struct {
    const char *name;
    const char *schema;
    bool control_only;
} tool_def_t;

static const tool_def_t kTools[] = {
    {
        "self.inkpane.context.get",
        "{\"name\":\"self.inkpane.context.get\","
        "\"description\":\"读取今天的日程、课程和未完成待办，并给出当前时间与星期。"
        "回答“今天有什么安排”或修改日程/待办之前先调用它。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}",
        false,
    },
    {
        "self.inkpane.device.status",
        "{\"name\":\"self.inkpane.device.status\","
        "\"description\":\"读取设备本地状态：电量、温度、湿度、Wi-Fi 信号强度、唤醒词和音量。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}",
        false,
    },
    {
        "self.inkpane.event.create",
        "{\"name\":\"self.inkpane.event.create\","
        "\"description\":\"创建一条日程。date 为开始日期，startTime 为 24 小时制开始时间，"
        "durationMinutes 默认 60 分钟；allDay 为 true 时创建全天事件（忽略时间）。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"title\":{\"type\":\"string\",\"maxLength\":120,\"description\":\"日程标题\"},"
        "\"date\":{\"type\":\"string\",\"pattern\":\"^\\\\d{4}-\\\\d{2}-\\\\d{2}$\","
        "\"description\":\"开始日期，格式 YYYY-MM-DD\"},"
        "\"startTime\":{\"type\":\"string\",\"pattern\":\"^\\\\d{2}:\\\\d{2}$\","
        "\"description\":\"开始时间，24 小时制 HH:mm\"},"
        "\"durationMinutes\":{\"type\":\"integer\",\"default\":60,\"minimum\":1,\"maximum\":1440},"
        "\"location\":{\"type\":\"string\",\"maxLength\":200,\"description\":\"地点（可选）\"},"
        "\"allDay\":{\"type\":\"boolean\",\"default\":false}},"
        "\"required\":[\"title\",\"date\",\"startTime\"]}}",
        true,
    },
    {
        "self.inkpane.event.cancel",
        "{\"name\":\"self.inkpane.event.cancel\","
        "\"description\":\"取消（删除）指定日程。eventId 可从 context.get 返回的日程列表中获取。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"eventId\":{\"type\":\"integer\",\"minimum\":1,\"description\":\"日程 ID\"}},"
        "\"required\":[\"eventId\"]}}",
        true,
    },
    {
        "self.inkpane.todo.create",
        "{\"name\":\"self.inkpane.todo.create\","
        "\"description\":\"创建一条待办。dueDate 为可选截止日期（YYYY-MM-DD），"
        "priority 可选 low/normal/high/urgent。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"title\":{\"type\":\"string\",\"maxLength\":200,\"description\":\"待办内容\"},"
        "\"dueDate\":{\"type\":\"string\",\"pattern\":\"^\\\\d{4}-\\\\d{2}-\\\\d{2}$\","
        "\"description\":\"截止日期，格式 YYYY-MM-DD（可选）\"},"
        "\"priority\":{\"type\":\"string\",\"enum\":[\"low\",\"normal\",\"high\",\"urgent\"]}},"
        "\"required\":[\"title\"]}}",
        true,
    },
    {
        "self.inkpane.todo.complete",
        "{\"name\":\"self.inkpane.todo.complete\","
        "\"description\":\"把待办标记为已完成。todoId 可从 context.get 返回的待办列表中获取。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"todoId\":{\"type\":\"integer\",\"minimum\":1,\"description\":\"待办 ID\"}},"
        "\"required\":[\"todoId\"]}}",
        true,
    },
    {
        "self.inkpane.todo.delete",
        "{\"name\":\"self.inkpane.todo.delete\","
        "\"description\":\"删除一条待办。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"todoId\":{\"type\":\"integer\",\"minimum\":1,\"description\":\"待办 ID\"}},"
        "\"required\":[\"todoId\"]}}",
        true,
    },
    {
        "self.inkpane.screen.refresh",
        "{\"name\":\"self.inkpane.screen.refresh\","
        "\"description\":\"请求墨水屏刷新为最新看板数据。修改日程或待办后可调用一次。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{},\"required\":[]}}",
        true,
    },
    {
        "self.inkpane.screen.zoom",
        "{\"name\":\"self.inkpane.screen.zoom\","
        "\"description\":\"切换墨水屏的显示视图：放大某一个模块（时钟/日历/天气/日程/课程/待办），"
        "或返回总览。用户说“放大时钟”“看看日程”“放回总览”“退出放大”时调用。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"module\":{\"type\":\"string\","
        "\"enum\":[\"clock\",\"calendar\",\"weather\",\"schedule\",\"courses\",\"todos\",\"overview\"],"
        "\"description\":\"要放大的模块；overview 表示返回总览\"}},"
        "\"required\":[\"module\"]}}",
        true,
    },
    {
        "self.inkpane.volume.set",
        "{\"name\":\"self.inkpane.volume.set\","
        "\"description\":\"设置扬声器音量，0 为静音，100 为最大。\","
        "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
        "\"volume\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":100,\"description\":\"音量百分比\"}},"
        "\"required\":[\"volume\"]}}",
        true,
    },
};

#define TOOL_COUNT (sizeof(kTools) / sizeof(kTools[0]))

/* Hooks installed by voice_app (see mcp_tools_set_device_hooks). */
static mcp_tools_status_fn s_status_hook;
static mcp_tools_volume_fn s_volume_hook;

static const char *const kBasicStatusJson =
    "{\"board\":\"inkpane-s3-epaper-3.97\",\"batteryPercent\":null,\"temperatureC\":null,"
    "\"humidityPercent\":null,\"rssi\":null,\"wakeWords\":[],\"volume\":null}";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

static const tool_def_t *find_tool(const char *name)
{
    if (name == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < TOOL_COUNT; ++i) {
        if (strcmp(kTools[i].name, name) == 0) {
            return &kTools[i];
        }
    }
    return NULL;
}

static int append_raw(char *buffer, size_t capacity, size_t *used, const char *text)
{
    size_t length = strlen(text);
    if (*used + length + 1 > capacity) {
        return -1;
    }
    memcpy(buffer + *used, text, length);
    *used += length;
    buffer[*used] = '\0';
    return 0;
}

static int append_escaped(char *buffer, size_t capacity, size_t *used, const char *source)
{
    int length = mcp_tools_escape_json(source, buffer + *used, capacity - *used);
    if (length < 0) {
        return -1;
    }
    *used += (size_t)length;
    return 0;
}

/** Number of UTF-8 code points (bytes that are not continuation bytes). */
static size_t utf8_length(const char *text)
{
    size_t count = 0;
    for (const unsigned char *cursor = (const unsigned char *)text; cursor != NULL && *cursor != '\0';
         ++cursor) {
        if ((*cursor & 0xC0) != 0x80) {
            ++count;
        }
    }
    return count;
}

static void copy_snippet(char *out, size_t out_size, const char *source)
{
    if (out == NULL || out_size == 0) {
        return;
    }
    out[0] = '\0';
    if (source == NULL) {
        return;
    }
    size_t length = strlen(source);
    if (length > out_size - 1) {
        length = out_size - 1;
    }
    /* Never cut in the middle of a UTF-8 sequence. */
    while (length > 0 && ((unsigned char)source[length] & 0xC0) == 0x80) {
        --length;
    }
    memcpy(out, source, length);
    out[length] = '\0';
}

/* ------------------------------------------------------------------ */
/* Argument parsing                                                    */
/* ------------------------------------------------------------------ */

static int get_string_arg(const json_value_t *args, const char *key, bool required,
                          const char *fallback, size_t max_chars, char *out, size_t out_size,
                          char *err, size_t err_size)
{
    const json_value_t *value = json_object_get(args, key);
    if (value == NULL || value->type == JSON_NULL) {
        if (!required) {
            snprintf(out, out_size, "%s", fallback != NULL ? fallback : "");
            return 0;
        }
        snprintf(err, err_size, "缺少必填参数：%s", key);
        return -1;
    }
    const char *text = json_string(value);
    if (text == NULL) {
        snprintf(err, err_size, "参数 %s 必须是字符串", key);
        return -1;
    }
    if (text[0] == '\0') {
        if (required) {
            snprintf(err, err_size, "参数 %s 不能为空", key);
            return -1;
        }
        snprintf(out, out_size, "%s", fallback != NULL ? fallback : "");
        return 0;
    }
    if (strlen(text) >= out_size) {
        snprintf(err, err_size, "参数 %s 过长", key);
        return -1;
    }
    if (utf8_length(text) > max_chars) {
        snprintf(err, err_size, "参数 %s 过长（最多 %u 个字符）", key, (unsigned)max_chars);
        return -1;
    }
    snprintf(out, out_size, "%s", text);
    return 0;
}

static int get_int_arg(const json_value_t *args, const char *key, bool required, long fallback,
                       long minimum, long maximum, long *out, char *err, size_t err_size)
{
    const json_value_t *value = json_object_get(args, key);
    if (value == NULL || value->type == JSON_NULL) {
        if (!required) {
            *out = fallback;
            return 0;
        }
        snprintf(err, err_size, "缺少必填参数：%s", key);
        return -1;
    }
    if (value->type != JSON_NUMBER) {
        snprintf(err, err_size, "参数 %s 必须是整数", key);
        return -1;
    }
    const double number = value->number;
    const long integer = (long)number;
    if ((double)integer != number) {
        snprintf(err, err_size, "参数 %s 必须是整数", key);
        return -1;
    }
    if (integer < minimum || integer > maximum) {
        snprintf(err, err_size, "参数 %s 必须在 %ld-%ld 之间", key, minimum, maximum);
        return -1;
    }
    *out = integer;
    return 0;
}

static int get_bool_arg(const json_value_t *args, const char *key, bool fallback, bool *out,
                        char *err, size_t err_size)
{
    const json_value_t *value = json_object_get(args, key);
    if (value == NULL || value->type == JSON_NULL) {
        *out = fallback;
        return 0;
    }
    if (value->type != JSON_BOOL) {
        snprintf(err, err_size, "参数 %s 必须是布尔值", key);
        return -1;
    }
    *out = value->boolean;
    return 0;
}

/** Positive integer ID; accepts both 12 and "12" for model friendliness. */
static int get_id_arg(const json_value_t *args, const char *key, long *out, char *err,
                      size_t err_size)
{
    const json_value_t *value = json_object_get(args, key);
    if (value == NULL || value->type == JSON_NULL) {
        snprintf(err, err_size, "缺少必填参数：%s", key);
        return -1;
    }
    if (value->type == JSON_NUMBER) {
        const double number = value->number;
        if (number < 1.0 || number > 100000000.0) {
            snprintf(err, err_size, "参数 %s 必须是正整数", key);
            return -1;
        }
        const long integer = (long)number;
        if ((double)integer != number) {
            snprintf(err, err_size, "参数 %s 必须是正整数", key);
            return -1;
        }
        *out = integer;
        return 0;
    }
    if (value->type == JSON_STRING) {
        const char *text = value->string;
        if (text == NULL || text[0] == '\0') {
            snprintf(err, err_size, "参数 %s 必须是正整数", key);
            return -1;
        }
        long integer = 0;
        for (const char *cursor = text; *cursor != '\0'; ++cursor) {
            if (*cursor < '0' || *cursor > '9') {
                snprintf(err, err_size, "参数 %s 必须是正整数", key);
                return -1;
            }
            integer = integer * 10 + (*cursor - '0');
            if (integer > 100000000L) {
                snprintf(err, err_size, "参数 %s 超出范围", key);
                return -1;
            }
        }
        if (integer <= 0) {
            snprintf(err, err_size, "参数 %s 必须是正整数", key);
            return -1;
        }
        *out = integer;
        return 0;
    }
    snprintf(err, err_size, "参数 %s 必须是正整数", key);
    return -1;
}

/* ------------------------------------------------------------------ */
/* Date / time handling                                                */
/* ------------------------------------------------------------------ */

static bool is_leap_year(int year)
{
    return (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
}

static int days_in_month(int year, int month)
{
    static const int kDays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) {
        return 0;
    }
    if (month == 2 && is_leap_year(year)) {
        return 29;
    }
    return kDays[month - 1];
}

static bool all_digits(const char *text, size_t length)
{
    for (size_t i = 0; i < length; ++i) {
        if (text[i] < '0' || text[i] > '9') {
            return false;
        }
    }
    return true;
}

static bool parse_date_value(const char *text, int *year, int *month, int *day)
{
    if (text == NULL || strlen(text) != 10 || text[4] != '-' || text[7] != '-') {
        return false;
    }
    if (!all_digits(text, 4) || !all_digits(text + 5, 2) || !all_digits(text + 8, 2)) {
        return false;
    }
    const int y = (text[0] - '0') * 1000 + (text[1] - '0') * 100 + (text[2] - '0') * 10 +
                  (text[3] - '0');
    const int m = (text[5] - '0') * 10 + (text[6] - '0');
    const int d = (text[8] - '0') * 10 + (text[9] - '0');
    if (y < 1970 || y > 2199 || m < 1 || m > 12) {
        return false;
    }
    if (d < 1 || d > days_in_month(y, m)) {
        return false;
    }
    *year = y;
    *month = m;
    *day = d;
    return true;
}

static bool parse_time_value(const char *text, int *hour, int *minute, int *second)
{
    if (text == NULL) {
        return false;
    }
    const size_t length = strlen(text);
    if (length != 5 && length != 8) {
        return false;
    }
    if (text[2] != ':' || (length == 8 && text[5] != ':')) {
        return false;
    }
    if (!all_digits(text, 2) || !all_digits(text + 3, 2) ||
        (length == 8 && !all_digits(text + 6, 2))) {
        return false;
    }
    const int h = (text[0] - '0') * 10 + (text[1] - '0');
    const int mi = (text[3] - '0') * 10 + (text[4] - '0');
    const int s = length == 8 ? (text[6] - '0') * 10 + (text[7] - '0') : 0;
    if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) {
        return false;
    }
    *hour = h;
    *minute = mi;
    *second = s;
    return true;
}

/* Howard Hinnant's civil-from-days algorithms (proleptic Gregorian). */
static int64_t days_from_civil(int year, int month, int day)
{
    year -= month <= 2;
    const int64_t era = (year >= 0 ? year : year - 399) / 400;
    const unsigned year_of_era = (unsigned)(year - era * 400);
    const unsigned day_of_year =
        (unsigned)((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1);
    const unsigned day_of_era =
        year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    return era * 146097 + (int64_t)day_of_era - 719468;
}

static void civil_from_days(int64_t days, int *year, int *month, int *day)
{
    days += 719468;
    const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
    const unsigned day_of_era = (unsigned)(days - era * 146097);
    const unsigned year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    const int64_t y = (int64_t)year_of_era + era * 400;
    const unsigned day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 -
                                               year_of_era / 100);
    const unsigned mp = (5 * day_of_year + 2) / 153;
    const unsigned d = day_of_year - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp + (mp < 10 ? 3 : -9);
    *year = (int)(y + (m <= 2));
    *month = (int)m;
    *day = (int)d;
}

static int format_rfc3339(char *out, size_t out_size, int year, int month, int day, int hour,
                          int minute, int second, int offset_minutes)
{
    int offset = offset_minutes;
    if (offset < -720 || offset > 840) {
        offset = 0;
    }
    const char sign = offset < 0 ? '-' : '+';
    const int absolute = offset < 0 ? -offset : offset;
    const int written = snprintf(out, out_size, "%04d-%02d-%02dT%02d:%02d:%02d%c%02d:%02d", year,
                                 month, day, hour, minute, second, sign, absolute / 60,
                                 absolute % 60);
    return written > 0 && (size_t)written < out_size ? 0 : -1;
}

/** UTC offset (minutes east) reported by the env hook, 0 when unavailable. */
static int env_offset_minutes(const mcp_tools_env_t *env)
{
    if (env == NULL || env->get_local_time == NULL) {
        return 0;
    }
    int year = 0;
    int month = 0;
    int day = 0;
    int hour = 0;
    int minute = 0;
    int second = 0;
    int offset = 0;
    if (!env->get_local_time(env->time_ctx, &year, &month, &day, &hour, &minute, &second,
                             &offset)) {
        return 0;
    }
    if (offset < -720 || offset > 840) {
        return 0;
    }
    return offset;
}

/**
 * Build startAt/endAt for event.create.
 * allDay: both values are plain YYYY-MM-DD strings.
 * Otherwise: RFC3339 with the device UTC offset, end = start + durationMinutes.
 */
static int build_event_times(const mcp_tools_env_t *env, const char *date,
                             const char *start_time, long duration_minutes, bool all_day,
                             char *start_out, size_t start_size, char *end_out, size_t end_size,
                             char *err, size_t err_size)
{
    int year = 0;
    int month = 0;
    int day = 0;
    if (!parse_date_value(date, &year, &month, &day)) {
        snprintf(err, err_size, "参数 date 必须是合法的 YYYY-MM-DD 日期");
        return -1;
    }
    if (all_day) {
        if (strlen(date) + 1 > start_size || strlen(date) + 1 > end_size) {
            snprintf(err, err_size, "参数 date 过长");
            return -1;
        }
        snprintf(start_out, start_size, "%s", date);
        snprintf(end_out, end_size, "%s", date);
        return 0;
    }

    int hour = 0;
    int minute = 0;
    int second = 0;
    if (!parse_time_value(start_time, &hour, &minute, &second)) {
        snprintf(err, err_size, "参数 startTime 必须是 HH:mm 格式的 24 小时制时间");
        return -1;
    }

    const int offset = env_offset_minutes(env);
    const int64_t start_minutes =
        days_from_civil(year, month, day) * 1440 + hour * 60 + minute;
    const int64_t end_minutes = start_minutes + duration_minutes;

    if (format_rfc3339(start_out, start_size, year, month, day, hour, minute, second, offset) !=
        0) {
        snprintf(err, err_size, "无法生成开始时间");
        return -1;
    }

    int64_t end_days = end_minutes / 1440;
    int end_remainder = (int)(end_minutes % 1440);
    if (end_remainder < 0) {
        end_remainder += 1440;
        --end_days;
    }
    int end_year = 0;
    int end_month = 0;
    int end_day = 0;
    civil_from_days(end_days, &end_year, &end_month, &end_day);
    if (format_rfc3339(end_out, end_size, end_year, end_month, end_day, end_remainder / 60,
                       end_remainder % 60, second, offset) != 0) {
        snprintf(err, err_size, "无法生成结束时间");
        return -1;
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

static int fail_with_status(char *text, size_t text_size, int result, int status,
                            const char *body, const char *action)
{
    if (result == INKPANE_API_ERR_TRANSPORT) {
        snprintf(text, text_size, "无法连接 InkPane 服务，请检查网络后重试");
        return -1;
    }
    if (result == INKPANE_API_ERR_TOO_LARGE) {
        snprintf(text, text_size, "InkPane 返回的数据过大，请稍后再试");
        return -1;
    }
    if (result == INKPANE_API_ERR_INVALID) {
        snprintf(text, text_size, "InkPane 接口配置无效");
        return -1;
    }
    char snippet[192];
    copy_snippet(snippet, sizeof(snippet), body);
    if (status == 401) {
        snprintf(text, text_size, "设备令牌无效或已过期，请在网站重新配网");
    } else if (status == 404) {
        snprintf(text, text_size, "目标不存在或已被删除（HTTP 404）");
    } else if (status == 429) {
        snprintf(text, text_size, "操作过于频繁，请稍后再试（HTTP 429）");
    } else if (status >= 500) {
        snprintf(text, text_size, "InkPane 服务暂时不可用（HTTP %d）", status);
    } else if (status >= 400) {
        if (snippet[0] != '\0') {
            snprintf(text, text_size, "%s被拒绝（HTTP %d）：%s", action != NULL ? action : "请求",
                     status, snippet);
        } else {
            snprintf(text, text_size, "%s被拒绝（HTTP %d）", action != NULL ? action : "请求",
                     status);
        }
    } else {
        snprintf(text, text_size, "%s失败（HTTP %d）", action != NULL ? action : "请求", status);
    }
    return -1;
}

static int accept_status(int status)
{
    return status >= 200 && status < 300;
}

/**
 * Perform an API call and copy the response into text_out.
 * On error returns -1 with a Chinese message in text_out.
 */
static int do_api_call(const char *method, const char *path, const char *body, char *text_out,
                       size_t text_size, const char *success_fallback, const char *action)
{
    char *response = (char *)malloc(INKPANE_API_RESPONSE_MAX);
    if (response == NULL) {
        snprintf(text_out, text_size, "内存不足，无法完成请求");
        return -1;
    }
    response[0] = '\0';
    int status = -1;
    int result = inkpane_api_request(method, path, body, response, INKPANE_API_RESPONSE_MAX, &status);
    if (result != INKPANE_API_OK) {
        fail_with_status(text_out, text_size, result, status, response, action);
        free(response);
        return -1;
    }
    if (!accept_status(status)) {
        fail_with_status(text_out, text_size, result, status, response, action);
        free(response);
        return -1;
    }

    const size_t length = strlen(response);
    if (length == 0) {
        snprintf(text_out, text_size, "%s",
                 success_fallback != NULL ? success_fallback : "操作成功");
    } else if (length >= text_size) {
        snprintf(text_out, text_size, "返回数据过大（%u 字节）", (unsigned)length);
        free(response);
        return -1;
    } else {
        memcpy(text_out, response, length + 1);
    }
    free(response);
    /* Every successful mutation repaints the dashboard, so a voice-driven todo
     * or event change is visible without the model also asking for a refresh. */
    if (strcmp(method, "GET") != 0 && s_call_env != NULL && s_call_env->on_mutation != NULL) {
        s_call_env->on_mutation(s_call_env->mutation_ctx);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Individual tools                                                    */
/* ------------------------------------------------------------------ */

static int tool_context_get(char *text, size_t text_size)
{
    return do_api_call("GET", "/api/device/context", NULL, text, text_size, "{}", "查询上下文");
}

static int tool_device_status(char *text, size_t text_size)
{
    if (s_status_hook != NULL) {
        const int written = s_status_hook(text, text_size);
        if (written >= 0) {
            if (written == 0) {
                snprintf(text, text_size, "{}");
            }
            return 0;
        }
        MCP_TOOLS_LOGW("device status hook failed; falling back to basic status");
    }
    snprintf(text, text_size, "%s", kBasicStatusJson);
    return 0;
}

static int tool_event_create(const mcp_tools_env_t *env, const json_value_t *args, char *text,
                             size_t text_size)
{
    char title[640];
    char date[16];
    char start_time[16];
    char location[640];
    char start_at[40];
    char end_at[40];
    char err[192];
    err[0] = '\0';

    if (get_string_arg(args, "title", true, NULL, 120, title, sizeof(title), err, sizeof(err)) !=
        0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    bool all_day = false;
    if (get_bool_arg(args, "allDay", false, &all_day, err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    if (get_string_arg(args, "date", true, NULL, 10, date, sizeof(date), err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (get_string_arg(args, "startTime", !all_day, all_day ? "00:00" : NULL, 8, start_time,
                       sizeof(start_time), err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (get_string_arg(args, "location", false, "", 200, location, sizeof(location), err,
                       sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    long duration_minutes = 60;
    if (get_int_arg(args, "durationMinutes", false, 60, 1, 1440, &duration_minutes, err,
                    sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    if (build_event_times(env, date, start_time, duration_minutes, all_day, start_at,
                          sizeof(start_at), end_at, sizeof(end_at), err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    char *body = (char *)malloc(2048);
    if (body == NULL) {
        snprintf(text, text_size, "内存不足，无法创建日程");
        return -1;
    }
    size_t used = 0;
    body[0] = '\0';
    if (append_raw(body, 2048, &used, "{\"title\":\"") != 0 ||
        append_escaped(body, 2048, &used, title) != 0 ||
        append_raw(body, 2048, &used, "\",\"startAt\":\"") != 0 ||
        append_escaped(body, 2048, &used, start_at) != 0 ||
        append_raw(body, 2048, &used, "\",\"endAt\":\"") != 0 ||
        append_escaped(body, 2048, &used, end_at) != 0 ||
        append_raw(body, 2048, &used, all_day ? "\",\"allDay\":true" : "\",\"allDay\":false") != 0) {
        free(body);
        snprintf(text, text_size, "日程内容过长");
        return -1;
    }
    if (location[0] != '\0') {
        if (append_raw(body, 2048, &used, ",\"location\":\"") != 0 ||
            append_escaped(body, 2048, &used, location) != 0 ||
            append_raw(body, 2048, &used, "\"") != 0) {
            free(body);
            snprintf(text, text_size, "日程内容过长");
            return -1;
        }
    }
    if (append_raw(body, 2048, &used, "}") != 0) {
        free(body);
        snprintf(text, text_size, "日程内容过长");
        return -1;
    }

    const int result =
        do_api_call("POST", "/api/device/events", body, text, text_size, "日程已创建", "创建日程");
    free(body);
    return result;
}

static int tool_event_cancel(const json_value_t *args, char *text, size_t text_size)
{
    char err[192];
    long event_id = 0;
    if (get_id_arg(args, "eventId", &event_id, err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    char path[64];
    snprintf(path, sizeof(path), "/api/device/events/%ld", event_id);
    char fallback[64];
    snprintf(fallback, sizeof(fallback), "已取消日程 #%ld", event_id);
    return do_api_call("DELETE", path, NULL, text, text_size, fallback, "取消日程");
}

static int tool_todo_create(const json_value_t *args, char *text, size_t text_size)
{
    char title[640];
    char due_date[16];
    char priority[16];
    char err[192];
    err[0] = '\0';

    if (get_string_arg(args, "title", true, NULL, 200, title, sizeof(title), err, sizeof(err)) !=
        0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (get_string_arg(args, "dueDate", false, "", 10, due_date, sizeof(due_date), err,
                       sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (get_string_arg(args, "priority", false, "", 8, priority, sizeof(priority), err,
                       sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (due_date[0] != '\0') {
        int year = 0;
        int month = 0;
        int day = 0;
        if (!parse_date_value(due_date, &year, &month, &day)) {
            snprintf(text, text_size, "参数 dueDate 必须是合法的 YYYY-MM-DD 日期");
            return -1;
        }
    }
    if (priority[0] != '\0' && strcmp(priority, "low") != 0 && strcmp(priority, "normal") != 0 &&
        strcmp(priority, "high") != 0 && strcmp(priority, "urgent") != 0) {
        snprintf(text, text_size, "参数 priority 必须是 low/normal/high/urgent 之一");
        return -1;
    }

    char *body = (char *)malloc(1024);
    if (body == NULL) {
        snprintf(text, text_size, "内存不足，无法创建待办");
        return -1;
    }
    size_t used = 0;
    body[0] = '\0';
    if (append_raw(body, 1024, &used, "{\"title\":\"") != 0 ||
        append_escaped(body, 1024, &used, title) != 0 ||
        append_raw(body, 1024, &used, "\"") != 0) {
        free(body);
        snprintf(text, text_size, "待办内容过长");
        return -1;
    }
    if (due_date[0] != '\0') {
        if (append_raw(body, 1024, &used, ",\"dueDate\":\"") != 0 ||
            append_escaped(body, 1024, &used, due_date) != 0 ||
            append_raw(body, 1024, &used, "\"") != 0) {
            free(body);
            snprintf(text, text_size, "待办内容过长");
            return -1;
        }
    }
    if (priority[0] != '\0') {
        if (append_raw(body, 1024, &used, ",\"priority\":\"") != 0 ||
            append_escaped(body, 1024, &used, priority) != 0 ||
            append_raw(body, 1024, &used, "\"") != 0) {
            free(body);
            snprintf(text, text_size, "待办内容过长");
            return -1;
        }
    }
    if (append_raw(body, 1024, &used, "}") != 0) {
        free(body);
        snprintf(text, text_size, "待办内容过长");
        return -1;
    }

    const int result =
        do_api_call("POST", "/api/device/todos", body, text, text_size, "待办已创建", "创建待办");
    free(body);
    return result;
}

static int tool_todo_complete(const json_value_t *args, char *text, size_t text_size)
{
    char err[192];
    long todo_id = 0;
    if (get_id_arg(args, "todoId", &todo_id, err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    char path[64];
    snprintf(path, sizeof(path), "/api/device/todos/%ld", todo_id);
    char fallback[64];
    snprintf(fallback, sizeof(fallback), "已完成待办 #%ld", todo_id);
    return do_api_call("PATCH", path, "{\"done\":true}", text, text_size, fallback, "完成待办");
}

static int tool_todo_delete(const json_value_t *args, char *text, size_t text_size)
{
    char err[192];
    long todo_id = 0;
    if (get_id_arg(args, "todoId", &todo_id, err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    char path[64];
    snprintf(path, sizeof(path), "/api/device/todos/%ld", todo_id);
    char fallback[64];
    snprintf(fallback, sizeof(fallback), "已删除待办 #%ld", todo_id);
    return do_api_call("DELETE", path, NULL, text, text_size, fallback, "删除待办");
}

static int tool_screen_refresh(const mcp_tools_env_t *env, char *text, size_t text_size)
{
    if (env != NULL && env->on_mutation != NULL) {
        env->on_mutation(env->mutation_ctx);
    }
    snprintf(text, text_size, "已请求刷新墨水屏，稍后会显示最新数据");
    return 0;
}

/* Display module names as the model writes them, in inkpane_module_id_t order
 * (clock=0, calendar=1, weather=2, schedule=3, courses=4, todos=5). Keeping
 * the order identical to the enum means no lookup table is needed on the device
 * side: the index *is* the module id. */
static const char *const kZoomModuleNames[] = {
    "clock", "calendar", "weather", "schedule", "courses", "todos",
};

/** "overview" sentinel: the port layer passes -1 to env->on_zoom. */
#define MCP_ZOOM_OVERVIEW (-1)

static int tool_screen_zoom(const mcp_tools_env_t *env, const json_value_t *args, char *text,
                            size_t text_size)
{
    char err[192];
    char module[16];
    err[0] = '\0';
    if (get_string_arg(args, "module", true, NULL, 15, module, sizeof(module), err,
                       sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }

    int target = MCP_ZOOM_OVERVIEW;
    if (strcmp(module, "overview") != 0) {
        const size_t count = sizeof(kZoomModuleNames) / sizeof(kZoomModuleNames[0]);
        bool found = false;
        for (size_t i = 0; i < count; ++i) {
            if (strcmp(module, kZoomModuleNames[i]) == 0) {
                target = (int)i;
                found = true;
                break;
            }
        }
        if (!found) {
            snprintf(text, text_size,
                     "参数 module 必须是 clock/calendar/weather/schedule/courses/todos/overview "
                     "之一");
            return -1;
        }
    }

    if (env == NULL || env->on_zoom == NULL) {
        snprintf(text, text_size, "设备显示控制不可用");
        return -1;
    }
    if (env->on_zoom(env->zoom_ctx, target) != 0) {
        if (target == MCP_ZOOM_OVERVIEW) {
            snprintf(text, text_size, "返回总览失败：当前看板不可用");
        } else {
            snprintf(text, text_size, "无法放大该模块：控制台未启用该模块");
        }
        return -1;
    }

    if (target == MCP_ZOOM_OVERVIEW) {
        snprintf(text, text_size, "已返回看板总览");
    } else {
        snprintf(text, text_size, "已放大显示%s", kZoomModuleNames[target]);
    }
    return 0;
}

static int tool_volume_set(const json_value_t *args, char *text, size_t text_size)
{
    char err[192];
    long volume = 0;
    if (get_int_arg(args, "volume", true, 0, 0, 100, &volume, err, sizeof(err)) != 0) {
        snprintf(text, text_size, "%s", err);
        return -1;
    }
    if (s_volume_hook == NULL) {
        snprintf(text, text_size, "设备音量控制不可用");
        return -1;
    }
    if (s_volume_hook((int)volume) != 0) {
        snprintf(text, text_size, "设置音量失败");
        return -1;
    }
    snprintf(text, text_size, "音量已设置为 %ld", volume);
    return 0;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

void mcp_tools_set_device_hooks(mcp_tools_status_fn status, mcp_tools_volume_fn set_volume)
{
    s_status_hook = status;
    s_volume_hook = set_volume;
}

bool mcp_tools_is_known(const char *name, bool allow_control)
{
    const tool_def_t *tool = find_tool(name);
    if (tool == NULL) {
        return false;
    }
    return allow_control || !tool->control_only;
}

int mcp_tools_list_json(bool allow_control, char *out, size_t out_size)
{
    if (out == NULL || out_size == 0) {
        return -1;
    }
    size_t used = 0;
    out[0] = '\0';
    if (append_raw(out, out_size, &used, "{\"tools\":[") != 0) {
        return -1;
    }
    bool first = true;
    for (size_t i = 0; i < TOOL_COUNT; ++i) {
        if (!allow_control && kTools[i].control_only) {
            continue;
        }
        if (!first && append_raw(out, out_size, &used, ",") != 0) {
            return -1;
        }
        first = false;
        if (append_raw(out, out_size, &used, kTools[i].schema) != 0) {
            return -1;
        }
    }
    if (append_raw(out, out_size, &used, "]}") != 0) {
        return -1;
    }
    return (int)used;
}

int mcp_tools_call(const mcp_tools_env_t *env, const char *name, const json_value_t *arguments,
                   char *text_out, size_t text_size)
{
    if (text_out == NULL || text_size == 0) {
        return -1;
    }
    text_out[0] = '\0';
    if (name == NULL) {
        snprintf(text_out, text_size, "缺少工具名称");
        return -1;
    }
    s_call_env = env;
    const tool_def_t *tool = find_tool(name);
    if (tool == NULL) {
        snprintf(text_out, text_size, "未知工具：%s", name);
        return -1;
    }
    const bool allow_control = env != NULL && env->allow_control;
    if (tool->control_only && !allow_control) {
        snprintf(text_out, text_size, "该工具未启用：设备处于只读模式");
        return -1;
    }

    if (strcmp(name, "self.inkpane.context.get") == 0) {
        return tool_context_get(text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.device.status") == 0) {
        return tool_device_status(text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.event.create") == 0) {
        return tool_event_create(env, arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.event.cancel") == 0) {
        return tool_event_cancel(arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.todo.create") == 0) {
        return tool_todo_create(arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.todo.complete") == 0) {
        return tool_todo_complete(arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.todo.delete") == 0) {
        return tool_todo_delete(arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.screen.refresh") == 0) {
        return tool_screen_refresh(env, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.screen.zoom") == 0) {
        return tool_screen_zoom(env, arguments, text_out, text_size);
    }
    if (strcmp(name, "self.inkpane.volume.set") == 0) {
        return tool_volume_set(arguments, text_out, text_size);
    }

    snprintf(text_out, text_size, "未知工具：%s", name);
    return -1;
}

int mcp_tools_escape_json(const char *source, char *out, size_t out_size)
{
    if (out == NULL || out_size == 0) {
        return -1;
    }
    size_t used = 0;
    if (source != NULL) {
        for (const unsigned char *cursor = (const unsigned char *)source; *cursor != '\0';
             ++cursor) {
            const char *piece = NULL;
            char escape[8];
            switch (*cursor) {
            case '"':
                piece = "\\\"";
                break;
            case '\\':
                piece = "\\\\";
                break;
            case '\b':
                piece = "\\b";
                break;
            case '\f':
                piece = "\\f";
                break;
            case '\n':
                piece = "\\n";
                break;
            case '\r':
                piece = "\\r";
                break;
            case '\t':
                piece = "\\t";
                break;
            default:
                if (*cursor < 0x20) {
                    snprintf(escape, sizeof(escape), "\\u%04x", *cursor);
                    piece = escape;
                }
                break;
            }
            if (piece != NULL) {
                const size_t length = strlen(piece);
                if (used + length + 1 > out_size) {
                    return -1;
                }
                memcpy(out + used, piece, length);
                used += length;
            } else {
                if (used + 2 > out_size) {
                    return -1;
                }
                out[used++] = (char)*cursor;
            }
        }
    }
    out[used] = '\0';
    return (int)used;
}
