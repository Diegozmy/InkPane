# API 文档

Base URL：`http://127.0.0.1:4000/api`（开发期前端通过 Vite 代理访问 `/api`）

## 接口概览

| 前缀 | 说明 | 详见 |
| --- | --- | --- |
| `/api/health` | 服务存活、结构版本与事件数 | 本文「健康检查」 |
| `/api/categories` | 分类的增删改查与排序 | 本文「分类」 |
| `/api/events` | 日程主记录（未展开）与实例级操作 | 本文「日程主体」「实例级操作」 |
| `/api/occurrences` | 展开后的日历实例 | 本文「展开后的实例」 |
| `/api/stats` | 统计汇总 | 本文「统计」 |
| `/api/reminders` | 待触发提醒 | 本文「提醒」 |
| `/api/courses` | 学校课程同步 | 本文「课程同步」 |
| `/api/todos` | 待办清单 | 本文「待办」 |
| `/api/weather` | 天气快照、设置与城市搜索 | 本文「天气」 |
| `/api/display` | 墨水屏布局与预览 | 本文「屏幕布局」 |
| `/api/device` | 设备端拉屏、遥测与令牌 | 本文「设备」 |

其中 `/api/device/screen` 使用 `X-Device-Token` 鉴权并支持 `ETag` / `304`，
`/api/device/telemetry` 同样需要令牌；设备端的完整对接说明（ESP-IDF 示例、屏幕渲染规范、
低功耗策略）见 [DEVICE-API.md](DEVICE-API.md)。

## 通用约定

### 成功响应

```json
{ "data": { "…": "…" }, "meta": { "…": "…" } }
```

`meta` 只在列表类接口出现，携带分页或区间信息。`DELETE` 成功返回 `204 No Content`（无响应体）。

### 错误响应

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求数据校验未通过",
    "details": [{ "path": "endAt", "message": "不是合法的时间格式", "code": "custom" }],
    "requestId": "3f2c9d18-…"
  }
}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数语义不合法（如区间终点早于起点、区间跨度过大、JSON 解析失败） |
| 401 | `UNAUTHORIZED` | 设备令牌缺失或无效，仅设备拉屏与遥测接口返回 |
| 404 | `NOT_FOUND` | 资源或接口不存在 |
| 409 | `CONFLICT` | 唯一约束冲突（如分类重名） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超出上限 |
| 422 | `VALIDATION_FAILED` | 数据结构校验未通过，`details` 给出字段级原因 |
| 500 | `INTERNAL_ERROR` | 服务端异常，`message` 不暴露内部细节 |

### 请求头

| 名称 | 说明 |
| --- | --- |
| `X-Request-Id` | 可选。客户端传入则原样回写，便于把前端报错与后端日志对上 |
| `Content-Type` | 写操作需 `application/json` |
| `X-Device-Token` | `/api/device/screen`、`/api/device/telemetry` 必填；其余接口不需要 |
| `If-None-Match` | 可选。`GET /api/device/screen` 上使用，命中时返回 `304` |

### 时间格式

| 场景 | 格式 | 示例 |
| --- | --- | --- |
| 定时事件 | 可解析的时间串，服务端统一规范化为 ISO-8601 UTC | `2025-06-02T01:00:00.000Z`、`2025-06-02T09:00:00+08:00` |
| 全天事件 | `YYYY-MM-DD`，原样保留不做时区换算 | `2025-06-02` |
| 查询区间 `from` / `to` | 时间串，`from` 含、`to` 不含 | `2025-06-01T00:00:00.000Z` |
| 重复规则 `until` | 日期串或时间串，闭区间 | `2025-12-31` |

---

## 健康检查

### `GET /api/health`

```json
{
  "data": {
    "status": "ok",
    "env": "development",
    "schemaVersion": 1,
    "eventCount": 10,
    "uptimeSeconds": 42,
    "serverTime": "2025-06-02T01:00:00.000Z"
  }
}
```

---

## 分类

### `GET /api/categories`

按 `sortOrder`、`id` 升序返回全部分类。

```json
{
  "data": [
    {
      "id": 1,
      "name": "工作",
      "color": "#3b6fd4",
      "icon": "briefcase",
      "sortOrder": 10,
      "createdAt": "2025-06-01T00:00:00.000Z",
      "updatedAt": "2025-06-01T00:00:00.000Z"
    }
  ]
}
```

### `POST /api/categories`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | string | 是 | 1–30 字符，全局唯一 |
| `color` | string | 是 | `#RRGGBB` |
| `icon` | string \| null | 否 | 图标名，仅作展示 |
| `sortOrder` | integer | 否 | 缺省时追加到末尾（步长 10） |

`201` 返回创建后的分类；重名返回 `409 CONFLICT`。

### `GET /api/categories/:id`

`200` 返回单个分类，不存在返回 `404`。

### `PATCH /api/categories/:id`

接受 `name` / `color` / `icon` / `sortOrder` 的任意子集，至少提供一个字段。
返回更新后的分类。

### `PUT /api/categories/order`

```json
{ "ids": [3, 1, 2] }
```

按数组顺序重排，返回重排后的完整列表。

### `DELETE /api/categories/:id`

```json
{ "data": { "id": 1, "detachedEventCount": 4 } }
```

关联日程不会被删除，只会变为「未分类」（`categoryId` 变成 `null`）。

---

## 日程主体

### `GET /api/events`

分页浏览**主记录**（未展开）。日历视图请使用 `/api/occurrences`。

| 查询参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `q` | string | — | 匹配标题、备注、地点、标签 |
| `categoryId` | 逗号分隔整数 | — | 多个为「或」关系 |
| `priority` | 逗号分隔枚举 | — | `low` / `normal` / `high` / `urgent` |
| `status` | 逗号分隔枚举 | — | `confirmed` / `tentative` / `cancelled` |
| `tag` | 逗号分隔字符串 | — | 命中任意标签即可 |
| `sort` | 枚举 | `startAt` | `startAt` / `-startAt` / `createdAt` / `-createdAt` / `title` / `-title` |
| `limit` | 1–500 | 50 | 每页条数 |
| `offset` | ≥0 | 0 | 偏移量 |

```json
{
  "data": [{ "id": 7, "title": "项目评审", "rrule": null, "…": "…" }],
  "meta": { "total": 12, "limit": 50, "offset": 0 }
}
```

### `POST /api/events`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `title` | string | 是 | — | 1–120 字符 |
| `startAt` | string | 是 | — | 见「时间格式」 |
| `endAt` | string | 是 | — | 定时事件必须晚于 `startAt`，字符数 ≤4000 |
| `allDay` | boolean | 否 | `false` | 为 `true` 时 `startAt` / `endAt` 用日期串 |
| `description` | string | 否 | `""` | ≤4000 字符 |
| `location` | string | 否 | `""` | ≤200 字符 |
| `categoryId` | integer \| null | 否 | `null` | 必须存在，否则 `422` |
| `priority` | 枚举 | 否 | `normal` | |
| `status` | 枚举 | 否 | `confirmed` | |
| `timezone` | IANA 名称 | 否 | 服务端时区 | 决定重复规则的展开时区 |
| `tags` | string[] | 否 | `[]` | 每项 ≤30 字符，最多 20 个 |
| `rrule` | object \| null | 否 | `null` | 见下 |
| `color` | `#RRGGBB` \| null | 否 | `null` | 为空时跟随分类色 |
| `remindMinutesBefore` | integer \| null | 否 | `null` | 0–20160（14 天） |

`rrule` 结构：

```json
{
  "freq": "WEEKLY",
  "interval": 1,
  "byWeekday": [1, 3],
  "count": 10
}
```

| 字段 | 说明 |
| --- | --- |
| `freq` | `DAILY` / `WEEKLY` / `MONTHLY` / `YEARLY` |
| `interval` | 1–365，默认 1 |
| `byWeekday` | `0`=周日 … `6`=周六，仅 `WEEKLY` 有效 |
| `count` | 1–500，与 `until` 互斥且优先级更高 |
| `until` | 日期串或时间串，闭区间 |

`201` 返回创建后的主记录。

### `GET /api/events/:id`

返回单个主记录（未展开）。

### `PATCH /api/events/:id`

接受上述字段的任意子集，至少提供一个。把 `rrule` 显式设为 `null` 会关闭重复，
并同时清理该日程的历史实例覆盖记录。

### `DELETE /api/events/:id`

删除整条日程及其全部实例覆盖记录。返回 `204`。

### `GET /api/events/:id/overrides`

返回该日程的全部实例覆盖记录（含已取消的），用于排查「哪些次被单独改过」。

---

## 实例级操作

### `POST /api/events/:id/move`

改期。`scope` 决定作用范围：

| `scope` | 语义 |
| --- | --- |
| `single` | 只改这一次，写入实例覆盖 |
| `all` | 整条序列按时间差平移，已有实例覆盖同步平移 |
| `future` | 序列在此一分为二，创建新主记录并迁移后续覆盖 |

```json
{
  "occurrenceKey": "2025-06-16T01:00:00.000Z",
  "scope": "future",
  "startAt": "2025-06-17T01:00:00.000Z",
  "endAt": "2025-06-17T02:00:00.000Z",
  "allDay": false
}
```

- `occurrenceKey`：目标实例在**原始序列**中的开始时刻（全天事件用日期串）。
  可以从 `/api/occurrences` 返回的 `occurrenceKey` 字段直接取。
- 非重复日程会忽略 `scope`，直接修改时间。
- `scope: "future"` 且目标就是首个实例时，等价于 `all`。

```json
{
  "data": {
    "scope": "future",
    "event": { "id": 7, "title": "周会", "rrule": { "freq": "WEEKLY", "interval": 1, "until": "2025-06-15" } },
    "createdEventId": 8,
    "override": null
  }
}
```

### `POST /api/events/:id/cancel-occurrence`

取消某一次或此后所有。

```json
{ "occurrenceKey": "2025-06-16T01:00:00.000Z", "scope": "single" }
```

| `scope` | 语义 |
| --- | --- |
| `single` | 取消这一次，其余实例保留 |
| `future` | 从这次起截断序列；若目标是首个实例则删除整条日程 |

返回 `{ scope, event, deleted }`，`deleted: true` 表示主记录已被删除。

### `PUT /api/events/:id/override`

按字段覆盖某一次实例。字段均可选，显式传 `null` 表示清空该项：

```json
{
  "occurrenceKey": "2025-06-16T01:00:00.000Z",
  "title": "特别版周会",
  "location": "线上",
  "startAt": "2025-06-16T06:00:00.000Z",
  "endAt": "2025-06-16T07:00:00.000Z"
}
```

### `DELETE /api/events/:id/override/:occurrenceKey`

删除覆盖记录，该实例恢复为序列默认值。`occurrenceKey` 需 URL 编码。

```json
{ "data": { "removed": true } }
```

---

## 展开后的实例

### `GET /api/occurrences`

日历四种视图与搜索都走这个接口。返回区间内所有实例，已应用重复规则与实例覆盖。

| 查询参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `from` | 时间串 | 当月 1 日 00:00 UTC | 区间起点（含） |
| `to` | 时间串 | 下月 1 日 00:00 UTC | 区间终点（不含） |
| `q` | string | — | 匹配标题、备注、地点、标签 |
| `categoryId` | 逗号分隔整数 | — | |
| `priority` | 逗号分隔枚举 | — | |
| `status` | 逗号分隔枚举 | — | |
| `tag` | 逗号分隔字符串 | — | |
| `includeCancelled` | boolean | `false` | 是否返回已取消的实例 |
| `limit` | 1–2000 | 1200 | 实例上限 |

约束：`to` 必须晚于 `from`，区间跨度不超过 **400 天**，否则返回 `400`。

```json
{
  "data": [
    {
      "id": "7:2025-06-02T01:00:00.000Z",
      "eventId": 7,
      "occurrenceKey": "2025-06-02T01:00:00.000Z",
      "title": "周会",
      "description": "同步进度",
      "location": "三号会议室",
      "categoryId": 1,
      "priority": "high",
      "status": "confirmed",
      "allDay": false,
      "startAt": "2025-06-02T01:00:00.000Z",
      "endAt": "2025-06-02T02:00:00.000Z",
      "timezone": "Asia/Shanghai",
      "tags": ["例行"],
      "color": null,
      "remindMinutesBefore": 15,
      "isRecurring": true,
      "isModified": false,
      "rrule": { "freq": "WEEKLY", "interval": 1, "byWeekday": [1] }
    }
  ],
  "meta": {
    "range": { "from": "2025-06-01T00:00:00.000Z", "to": "2025-07-01T00:00:00.000Z" },
    "timezone": "Asia/Shanghai",
    "count": 5,
    "truncated": false
  }
}
```

排序规则：先按实例所在日期升序，同一天内**全天事件在前**，其余按开始时刻升序，最后按标题。

字段补充说明：

- `id`：`${eventId}:${occurrenceKey}`，前端列表渲染的稳定 key。
- `occurrenceKey`：实例在原始序列中的开始时刻，改期 / 取消 / 覆盖时回传该值。
- `isModified`：该次是否被单独修改过（提示用户「本次已单独调整」）。
- `meta.truncated`：结果为 `true` 表示超出 `limit` 被截断，前端会提示用户缩小范围。

---

## 统计

### `GET /api/stats/summary`

| 查询参数 | 类型 | 默认 |
| --- | --- | --- |
| `from` / `to` | 时间串 | 当月 |
| `timezone` | IANA 名称 | 服务端时区 |

```json
{
  "data": {
    "rangeFrom": "2025-06-01T00:00:00.000Z",
    "rangeTo": "2025-07-01T00:00:00.000Z",
    "totalOccurrences": 12,
    "totalMinutes": 780,
    "allDayCount": 2,
    "recurringCount": 8,
    "byCategory": [{ "categoryId": 1, "name": "工作", "color": "#3b6fd4", "count": 9 }],
    "byPriority": [{ "priority": "urgent", "count": 2 }],
    "byDay": [{ "date": "2025-06-02", "count": 3 }],
    "upcoming": [{ "id": "7:…", "title": "周会", "…": "…" }]
  }
}
```

`byPriority` 先按数量降序，数量相同时按紧急程度降序排列，保证输出顺序稳定。
`upcoming` 最多返回 6 条尚未开始的实例。

---

## 提醒

### `GET /api/reminders/due`

返回**提醒触发时刻**落在窗口内的日程，供前端定时轮询后弹出系统通知。

| 查询参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `from` | 时间串 | 当前时刻 | 窗口起点（含） |
| `to` | 时间串 | `from + windowMinutes` | 窗口终点（不含） |
| `windowMinutes` | 1–20160 | 60 | 窗口长度 |

```json
{
  "data": [
    {
      "id": "7:2025-06-02T01:00:00.000Z",
      "eventId": 7,
      "occurrenceKey": "2025-06-02T01:00:00.000Z",
      "title": "周会",
      "location": "三号会议室",
      "categoryId": 1,
      "startAt": "2025-06-02T01:00:00.000Z",
      "allDay": false,
      "fireAt": "2025-06-02T00:30:00.000Z",
      "minutesBefore": 30
    }
  ]
}
```

说明：

- `fireAt = startAt - minutesBefore × 60s`，接口按 `fireAt` 是否落在窗口内筛选。
- 服务端会自动向后预读「库中配置的最大提醒提前量」，因此提前一天甚至一周的提醒也不会漏报。
- 全天事件没有具体时刻，不参与提醒。
- 未设置提醒的日程不会出现。
- 接口是无状态的，**不记录「已提醒」状态**；去重由前端用 `id + fireAt` 在 localStorage 完成。

---

## 课程同步

对接学校课程管理系统（默认 `http://ws8.yucai.sh.cn`，可在设置里改）。
服务端负责登录、抓取、解析，并把每个课表条目换算成一条每周重复的日程。

### 登录链路（逆向自官网前端，逐字节对齐）

1. `GET /` → 登录页里下发**本次随机**的 AES `key` 与 `iv`（每次加载都不同，不能缓存）
2. 明文 `username=<账号>&passwd=<密码>` 用 **AES-CBC/PKCS7** 加密后 Base64，作为 `data` 字段
3. `POST /Login-checkLogin` → `{"status":1}` 表示成功

两个必须注意的点：

- 内层明文**不能 URL 编码**。服务端按 `&`、`=` 手工切分且不做 urldecode，
  编码后的 `@` 会变成 `%40` 而被当成错误密码（已实测确认）。因此密码含 `&` 或 `=` 时会提前拒绝并提示。
- 业务接口必须用 **POST**，GET 会被控制器守卫返回「非法请求！」。

### `GET /api/courses/status`

```json
{
  "data": {
    "credentials": {
      "username": "20240116",
      "hasPassword": true,
      "passwordMask": "W•••••••7",
      "remember": true,
      "updatedAt": "2025-06-02T01:00:00.000Z"
    },
    "settings": { "…": "…" },
    "lastRun": {
      "id": 3,
      "status": "success",
      "message": "2026-2027学年第一学程：新建 38、更新 0、删除 0",
      "created": 38,
      "updated": 0,
      "removed": 0,
      "total": 38,
      "startedAt": "2025-06-02T01:00:00.000Z",
      "finishedAt": "2025-06-02T01:00:02.000Z"
    },
    "linkedCount": 38,
    "autoSyncEnabled": false,
    "schedulerIntervalMs": 21600000,
    "serverTime": "2025-06-02T01:00:03.000Z"
  }
}
```

**任何接口都不会返回密码明文**，只返回 `passwordMask` 这类脱敏信息。

### `PUT /api/courses/credentials`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `username` | string | 是 | 学号 |
| `password` | string | 是 | 密码；含 `&` 或 `=` 会被拒绝（校方接口无法处理） |
| `remember` | boolean | 否 | 是否落库保存；默认 `true` |

密码以 AES-256-GCM 密文写入 `sync_credentials`，密钥保存在
`data/.sync-key`（尽力设为仅本用户可读）。

`DELETE /api/courses/credentials` 清除已保存的账号。

### `POST /api/courses/test-login`

只验证账号可用性，不保存。

```json
{ "username": "20240116", "password": "…" }
```

成功返回 `{ "ok": true, "baseUrl": "…" }`；失败返回 `422` 并带上学校系统给出的原因。

### `GET /api/courses/settings` / `PATCH /api/courses/settings`

```json
{
  "baseUrl": "http://ws8.yucai.sh.cn",
  "periods": [{ "index": 1, "start": "08:00", "end": "08:40" }],
  "fridaySeparate": false,
  "fridayPeriods": [{ "index": 1, "start": "09:30", "end": "10:10" }],
  "termStartDate": "2026-10-12",
  "totalWeeks": 20,
  "autoSync": false,
  "syncIntervalHours": 6,
  "includeTeacher": true,
  "includeRoom": true,
  "categoryId": 6
}
```

| 字段 | 说明 |
| --- | --- |
| `periods` | 周一至周四、周六、周日共用的每节课起止时间，`index` 即「第几节」 |
| `fridaySeparate` | 勾选后周五使用下面那整套独立时间表 |
| `fridayPeriods` | 周五专用时间表，与 `periods` 互不影响 |
| `termStartDate` | 本学期第一周周一。校方系统只给「当周日期」，无法得知学程第一周，必须由用户确认 |
| `totalWeeks` | 重复日程在哪一周结束 |
| `syncIntervalHours` | 自动同步间隔，1–168 小时 |

学校系统的课表只包含「第几节」，不含时间，因此这些时间必须由用户配置。
若课表出现了未配置的节次，会按每节 50 分钟顺延估算并在预览里标注「时间估算」。

### `POST /api/courses/preview`

抓取课表但不写入任何数据，用于导入前确认。

```json
{ "username": "…", "password": "…" }
```

- `username` / `password` 可省略，此时使用已保存的凭据
- 也支持 `{ "rawHtml": "…" }` 直接解析一段课表 HTML（用于排查与测试，不走网络）

```json
{
  "data": {
    "termId": "102",
    "termName": "2026-2027学年第一学程",
    "weekDates": [{ "weekday": 1, "weekdayLabel": "周一", "dateKey": "2026-10-12" }],
    "periodNumbers": [1, 2, 3, 4, 5, 6, 7, 8, 9],
    "termStartDate": "2026-10-12",
    "termStartInferred": false,
    "totalWeeks": 20,
    "warnings": [],
    "slots": [
      {
        "externalKey": "102:1:1",
        "weekday": 1,
        "weekdayLabel": "周一",
        "period": 1,
        "courseName": "高三语文1-1",
        "teacher": "朱英杰",
        "room": "301",
        "firstStartAt": "2026-10-12T00:00:00.000Z",
        "firstEndAt": "2026-10-12T00:40:00.000Z",
        "timeFallback": false,
        "willUpdate": false
      }
    ],
    "fetchedAt": "2026-10-16T15:00:00.000Z"
  }
}
```

`externalKey` 形如 `<学程id>:<星期>:<节次>`，是对外条目在本地日程中的稳定身份标识。

### `POST /api/courses/import`

请求体同 `preview`，返回体在预览结果上追加同步计数：

```json
{ "data": { "…": "预览字段…", "created": 38, "updated": 0, "removed": 0, "categoryId": 6 } }
```

**幂等**：重复导入只会更新已有日程，不会产生重复；课表里消失的条目会被删除。
整段写在事务里，失败不会留下半套数据。

生成的日程规则：

| 项目 | 取值 |
| --- | --- |
| 标题 | 课程名 |
| 时间 | 该条目在学期第一周对应星期几 + 配置的节次时间 |
| 重复 | `WEEKLY`，`interval: 1`，`until` = 学期起始 + 总周数 − 1 天 |
| 分类 | 自动创建/复用名为「课程」的分类（颜色 `#2f6e9e`） |
| 地点 | 教室（可在设置里关闭） |
| 备注 | 教师、教室、节次，以及「下次同步会覆盖」的说明 |
| 标签 | `课程` |
| 提醒 | 提前 10 分钟 |

### `POST /api/courses/sync-now`

按已保存的凭据与设置立即同步一轮。

```json
{ "data": { "created": 0, "updated": 38, "removed": 0, "total": 38 } }
```

### 自动同步

开启 `autoSync` 后，服务端每分钟检查一次是否到达 `syncIntervalHours` 间隔，
到点则自动抓取并更新。设置改动立即生效，无需重启；
上一轮未跑完时不会并发启动第二轮；失败不会被抛出到服务层，只记录日志并在下一周期重试，
已有日程保持不动。

### 错误码补充

| 场景 | HTTP | 说明 |
| --- | --- | --- |
| 未保存凭据却要联网 | 422 | 提示先在课程同步页填写 |
| 账号密码被校方拒绝 | 422 | 原样带出校方提示，并给出「核对密码 / 是否需校园网」的建议 |
| 密码含 `&` 或 `=` | 422 | 校方登录表单无法处理，建议先改密码 |
| 网络不可达 | 400 | 提示检查网络是否能访问学校系统 |
| 课表结构变化 / 未排课 | 400 | 提示可能尚未排课或页面结构已变，并保留原始响应供排查 |

---

## 待办

待办与日程相互独立：日程有起止时间，待办只有「做没做完」与可选的截止日期。
两者共用分类，因此待办也可以挂到某个分类上。

`Todo` 结构：

```json
{
  "id": 31,
  "title": "订正物理周测卷",
  "notes": "错题按知识点归类，周五前交给课代表",
  "done": false,
  "priority": "high",
  "dueDate": "2026-10-18",
  "categoryId": 2,
  "sortOrder": 10,
  "completedAt": null,
  "createdAt": "2026-10-16T13:20:11.000Z",
  "updatedAt": "2026-10-17T01:05:42.000Z"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 主键 |
| `title` | string | 1–200 字符 |
| `notes` | string | 备注，默认 `""`，≤4000 字符 |
| `done` | boolean | 是否已完成 |
| `priority` | 枚举 | `low` / `normal` / `high` / `urgent`，默认 `normal` |
| `dueDate` | string \| null | 截止日期 `YYYY-MM-DD`，无截止日期为 `null` |
| `categoryId` | integer \| null | 分类 id，未分类为 `null` |
| `sortOrder` | integer | 手动排序值，升序排列 |
| `completedAt` | string \| null | 完成时刻（ISO-8601 UTC）；未完成或从未完成为 `null` |
| `createdAt` | string | 创建时刻 |
| `updatedAt` | string | 最后修改时刻 |

### `GET /api/todos`

| 查询参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `done` | boolean | — | 省略返回全部；`true` 只返回已完成，`false` 只返回未完成（也接受 `1` / `0`） |
| `due` | 枚举 | — | `today` 只返回今天到期的；`week` 返回今天起 7 天内到期的；无截止日期的不参与筛选 |
| `limit` | 1–500 | 200 | 每页条数 |
| `offset` | ≥0 | 0 | 偏移量 |

排序：`done` 升序（未完成在前）→ `sortOrder` 升序 → `createdAt` 降序。

```json
{
  "data": [
    {
      "id": 31,
      "title": "订正物理周测卷",
      "notes": "错题按知识点归类，周五前交给课代表",
      "done": false,
      "priority": "high",
      "dueDate": "2026-10-18",
      "categoryId": 2,
      "sortOrder": 10,
      "completedAt": null,
      "createdAt": "2026-10-16T13:20:11.000Z",
      "updatedAt": "2026-10-17T01:05:42.000Z"
    },
    {
      "id": 33,
      "title": "归还图书馆借书",
      "notes": "",
      "done": true,
      "priority": "low",
      "dueDate": null,
      "categoryId": null,
      "sortOrder": 20,
      "completedAt": "2026-10-18T06:12:03.000Z",
      "createdAt": "2026-10-14T09:41:26.000Z",
      "updatedAt": "2026-10-18T06:12:03.000Z"
    }
  ],
  "meta": { "total": 2, "limit": 200, "offset": 0 }
}
```

`meta.total` 是**筛选后的总数**（不受 `limit` / `offset` 影响），前端据此显示「共 N 项」。

### `GET /api/todos/:id`

`200` 返回单个待办，不存在返回 `404 NOT_FOUND`。

### `POST /api/todos`

| 字段 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `title` | string | 是 | — | 1–200 字符 |
| `notes` | string | 否 | `""` | ≤4000 字符 |
| `priority` | 枚举 | 否 | `normal` | `low` / `normal` / `high` / `urgent` |
| `dueDate` | string \| null | 否 | `null` | `YYYY-MM-DD`，必须是真实存在的日期 |
| `categoryId` | integer \| null | 否 | `null` | 必须存在，否则 `422` |
| `sortOrder` | integer | 否 | 追加到末尾（步长 10） | -1000000 至 1000000 |

`201` 返回创建后的待办。

创建入参里**没有** `done`：新建待办一律为未完成，要标记完成请用 `PATCH`。

### `PATCH /api/todos/:id`

接受 `title` / `notes` / `done` / `priority` / `dueDate` / `categoryId` / `sortOrder`
的任意子集，至少提供一个字段。

```json
{ "done": true }
```

`done` 语义：

| 传入 | 行为 |
| --- | --- |
| `done: true` | 置为已完成，同时把 `completedAt` 写成当前时刻 |
| `done: false` | 置为未完成，同时把 `completedAt` 清空为 `null` |

返回更新后的待办。`done: true` 时重试不会产生第二份记录，也不会删除历史记录。

### `DELETE /api/todos/:id`

删除待办，返回 `204 No Content`。不存在返回 `404`。

### `PUT /api/todos/order`

```json
{ "ids": [33, 31, 32] }
```

按数组顺序重写 `sortOrder`（数组下标即新的展示顺序），返回重排后的完整待办列表。
`ids` 最多 2000 项，只允许正整数；不存在的 id 会被忽略。

```json
{
  "data": [
    {
      "id": 33,
      "title": "归还图书馆借书",
      "notes": "",
      "done": false,
      "priority": "low",
      "dueDate": null,
      "categoryId": null,
      "sortOrder": 10,
      "completedAt": null,
      "createdAt": "2026-10-14T09:41:26.000Z",
      "updatedAt": "2026-10-18T03:20:44.000Z"
    }
  ]
}
```

响应包含按新顺序排列的全部待办，此处仅示一项。

---

## 天气

天气由服务端向 Open-Meteo 取数并缓存，控制台与设备端拿到的是同一个快照结构。
**缓存 TTL 为 15 分钟**：`GET /api/weather` 命中缓存时直接返回，不会每次都请求外网。
设备拉屏时**只读缓存、绝不联网**，因此设备数据里的 `source` 恒为 `cache`（或 `weather` 为 `null`），`open-meteo` 只会出现在本接口的实时刷新结果里。

`WeatherSnapshot` 结构（完整示例见下）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `provider` | string | 固定 `open-meteo` |
| `city` | string | 城市名，来自天气设置 |
| `latitude` / `longitude` | number | 取数坐标 |
| `observedAt` | string | 观测时刻（ISO-8601 UTC） |
| `fetchedAt` | string | 写入缓存的时刻（ISO-8601 UTC） |
| `stale` | boolean | `true` 表示缓存已过期且刷新失败，正在用旧数据 |
| `source` | 枚举 | `open-meteo`（本次实时取数）/ `cache`（命中 15 分钟缓存）/ `fallback`（从未成功） |
| `message` | string | 可选。降级原因说明，正常取数时不出现 |
| `current` | object | 实况：`temperature` / `apparentTemperature` / `humidity` / `weatherCode` / `condition` / `icon` / `windSpeed` / `isDay` |
| `today` | object | 今日：`date` / `min` / `max` / `precipitationProbability` / `condition` / `icon` |
| `forecast` | object[] | 3 天，**含今天**；每项 `date` / `weekday` / `min` / `max` / `condition` / `icon` / `precipitationProbability` |

单位：温度 °C、风速 km/h、湿度与降水概率 %，`weatherCode` 为 WMO 天气代码。

### `GET /api/weather`

读取当前天气快照。命中缓存时 `source: "cache"`；缓存过期会尝试刷新，刷新失败则返回
旧快照并置 `stale: true`。

```json
{
  "data": {
    "provider": "open-meteo",
    "city": "上海",
    "latitude": 31.2304,
    "longitude": 121.4737,
    "observedAt": "2026-10-18T03:00:00.000Z",
    "fetchedAt": "2026-10-18T03:32:10.000Z",
    "stale": false,
    "source": "cache",
    "current": {
      "temperature": 22.4,
      "apparentTemperature": 23.1,
      "humidity": 68,
      "weatherCode": 2,
      "condition": "多云",
      "icon": "partly-cloudy",
      "windSpeed": 12.6,
      "isDay": true
    },
    "today": {
      "date": "2026-10-18",
      "min": 17.2,
      "max": 24.8,
      "precipitationProbability": 20,
      "condition": "多云",
      "icon": "partly-cloudy"
    },
    "forecast": [
      {
        "date": "2026-10-18",
        "weekday": "周日",
        "min": 17.2,
        "max": 24.8,
        "condition": "多云",
        "icon": "partly-cloudy",
        "precipitationProbability": 20
      },
      {
        "date": "2026-10-19",
        "weekday": "周一",
        "min": 16.5,
        "max": 23.4,
        "condition": "晴",
        "icon": "clear",
        "precipitationProbability": 5
      },
      {
        "date": "2026-10-20",
        "weekday": "周二",
        "min": 17.8,
        "max": 22.6,
        "condition": "雨",
        "icon": "rain",
        "precipitationProbability": 70
      }
    ]
  }
}
```

`icon` 取值：`clear` / `partly-cloudy` / `cloudy` / `fog` / `drizzle` / `rain` /
`snow` / `thunderstorm`。

**失败不返回 500。** 外网不可达时：有旧缓存则返回旧缓存（`stale: true`，带 `message`）；
从未成功过则返回 `source: "fallback"` 的占位快照（同样带 `message`），控制台据此
显示「天气暂不可用」，而不是把整个接口判为故障。

### `POST /api/weather/refresh`

忽略 15 分钟 TTL，立即重新取数。成功时 `source: "open-meteo"`；失败时与
`GET /api/weather` 的降级行为一致（返回旧缓存或 `fallback` 快照），HTTP 状态仍为 `200`。

请求体：无。响应体：`WeatherSnapshot`。

### `GET /api/weather/settings` / `PUT /api/weather/settings`

```json
{
  "data": {
    "city": "上海",
    "latitude": 31.2304,
    "longitude": 121.4737,
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "updatedAt": "2026-10-15T09:12:44.000Z"
  }
}
```

`PUT` 接受 `city`（1–60 字符）、`latitude`（-90–90）、`longitude`（-180–180）、
`enabled` 的任意子集，至少提供一个字段。

`timezone` 由服务端时区决定（默认 `Asia/Shanghai`），不接受单独修改；它决定 `today`
与 `forecast` 的日期归属。

### `GET /api/weather/search?q=`

按关键词搜索城市，返回 Open-Meteo 地理编码结果，供设置页选择城市后填入经纬度。

| 查询参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `q` | string | 是 | 1–50 字符，中英文均可 |

```json
{
  "data": {
    "results": [
      {
        "name": "上海",
        "admin1": "上海市",
        "country": "中国",
        "latitude": 31.2304,
        "longitude": 121.4737,
        "timezone": "Asia/Shanghai"
      }
    ]
  }
}
```

`admin1`（一级行政区）与 `country` 在 Open-Meteo 未提供时为空字符串。搜索失败时**不返回 5xx**，而是：

```json
{
  "data": { "results": [] },
  "meta": { "warning": "城市搜索服务暂不可达，可直接填写经纬度" }
}
```

---

## 屏幕布局

800 × 480 墨水屏的布局由六个模块组成，每个模块有固定的 `id` 与可调矩形。
坐标单位为像素，设备端按矩形裁剪绘制。

`DisplayModule`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | 枚举 | `clock` / `calendar` / `weather` / `schedule` / `courses` / `todos` |
| `enabled` | boolean | 是否绘制 |
| `x` / `y` | integer | 左上角坐标，≥0 且为 4 的倍数 |
| `w` / `h` | integer | 宽高，`w >= 80`、`h >= 48`，且为 4 的倍数 |

`DisplayLayout`：`width`（固定 800）、`height`（固定 480）、`updatedAt`、`modules`（6 项）。

### `GET /api/display`

返回当前布局、刷新间隔，以及模块目录（名称、说明与默认矩形），供布局编辑器渲染。

```json
{
  "data": {
    "layout": {
      "width": 800,
      "height": 480,
      "updatedAt": "2026-10-15T09:12:44.000Z",
      "modules": [
        { "id": "clock", "enabled": true, "x": 16, "y": 16, "w": 220, "h": 100 },
        { "id": "calendar", "enabled": true, "x": 16, "y": 128, "w": 220, "h": 180 },
        { "id": "weather", "enabled": true, "x": 248, "y": 16, "w": 240, "h": 288 },
        { "id": "schedule", "enabled": true, "x": 500, "y": 16, "w": 284, "h": 448 },
        { "id": "courses", "enabled": true, "x": 248, "y": 316, "w": 240, "h": 148 },
        { "id": "todos", "enabled": true, "x": 16, "y": 320, "w": 220, "h": 144 }
      ]
    },
    "refreshMinutes": 30,
    "modules": [
      { "id": "clock", "name": "时钟", "description": "大字时间、星期与日期", "defaultRect": { "x": 16, "y": 16, "w": 220, "h": 100 } },
      { "id": "calendar", "name": "月历", "description": "当月月历，并标记有日程的日期", "defaultRect": { "x": 16, "y": 128, "w": 220, "h": 180 } },
      { "id": "weather", "name": "天气", "description": "当前天气与未来三天预报", "defaultRect": { "x": 248, "y": 16, "w": 240, "h": 288 } },
      { "id": "schedule", "name": "今日日程", "description": "今天的时间安排", "defaultRect": { "x": 500, "y": 16, "w": 284, "h": 448 } },
      { "id": "courses", "name": "今日课程", "description": "今天要上的课程", "defaultRect": { "x": 248, "y": 316, "w": 240, "h": 148 } },
      { "id": "todos", "name": "待办", "description": "未完成的待办事项", "defaultRect": { "x": 16, "y": 320, "w": 220, "h": 144 } }
    ],
    "width": 800,
    "height": 480
  }
}
```

### `PUT /api/display`

```json
{
  "refreshMinutes": 30,
  "layout": {
    "width": 800,
    "height": 480,
    "modules": [
      { "id": "clock", "enabled": true, "x": 16, "y": 16, "w": 220, "h": 100 },
      { "id": "calendar", "enabled": true, "x": 16, "y": 128, "w": 220, "h": 180 },
      { "id": "weather", "enabled": true, "x": 248, "y": 16, "w": 240, "h": 288 },
      { "id": "schedule", "enabled": true, "x": 500, "y": 16, "w": 284, "h": 448 },
      { "id": "courses", "enabled": true, "x": 248, "y": 316, "w": 240, "h": 148 },
      { "id": "todos", "enabled": true, "x": 16, "y": 320, "w": 220, "h": 144 }
    ]
  }
}
```

`layout` 与 `refreshMinutes` 均可选，只传其一即可。校验规则（不满足返回 `400 VALIDATION_FAILED`）：

- `width` / `height` 必须分别是 `800` / `480`，`modules` 必须正好 6 项；
- 六个 `id` 齐全且唯一；每个模块的 `id`、`enabled`、`x`、`y`、`w`、`h` 均为必填；
- `x`、`y`、`w`、`h` 为整数且是 4 的倍数；`x >= 0`、`y >= 0`、`w >= 80`、`h >= 48`；
- `x + w <= 800`、`y + h <= 480`；
- `refreshMinutes` 为 5–720 的整数（设备端据此设置休眠间隔）；
- 服务端不校验模块是否重叠。

响应体与 `GET /api/display` 的 `data` 一致。

### `GET /api/display/screen`

控制台预览用：返回设备将看到的完整屏幕数据（`DeviceScreenPayload`），**免鉴权**。
字段定义、ETag 语义与完整示例见 [DEVICE-API.md](DEVICE-API.md) 第 7 节。

设备端请使用 `GET /api/device/screen`，它支持 `If-None-Match` / `304`，能省掉重复渲染。

---

## 设备

设备接口供墨水屏固件调用。其中**拉屏与遥测**使用共享令牌 `X-Device-Token` 鉴权，
其余（状态、设置、令牌读取与轮换）供控制台使用，不需要令牌。设备端的完整对接说明见
[DEVICE-API.md](DEVICE-API.md)。

### `GET /api/device/status`

返回设备与控制台共享的状态汇总。**不需要令牌**，控制台直接读取，设备也可用它确认
服务端认定的刷新间隔与屏幕版本。

```json
{
  "data": {
    "paired": true,
    "name": "书桌墨窗",
    "tokenPreview": "7f3a...c153",
    "lastSeenAt": "2026-10-18T03:40:12.480Z",
    "firmware": "0.1.0",
    "batteryPercent": 87,
    "batteryVoltage": 4.06,
    "rssi": -56,
    "indoorTemperature": 24.3,
    "indoorHumidity": 46.8,
    "screenVersion": "9f2c1b7e4a6d0c3f8b5e2a91d47c6f03b8e5a1d2",
    "refreshMinutes": 30,
    "layoutUpdatedAt": "2026-10-15T09:12:44.000Z",
    "serverTime": "2026-10-18T03:40:15.002Z"
  }
}
```

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `paired` | boolean | 否 | 是否收到过设备遥测（`lastSeenAt` 非空即为 `true`） |
| `name` | string | 否 | 设备名，默认「InkPane 墨窗」 |
| `tokenPreview` | string | 否 | 令牌脱敏预览：前 4 位 + `...` + 后 4 位 |
| `lastSeenAt` | string | 是 | 最后一次遥测时间；从未上报为 `null` |
| `firmware` | string | 是 | 最后一次上报的固件版本 |
| `batteryPercent` / `batteryVoltage` / `rssi` | number | 是 | 最后一次上报的电量与信号 |
| `indoorTemperature` / `indoorHumidity` | number | 是 | 最后一次上报的室内温湿度 |
| `screenVersion` | string | 否 | 当前屏幕数据哈希（等同 ETag 去引号） |
| `refreshMinutes` | integer | 否 | 刷新间隔（分钟） |
| `layoutUpdatedAt` | string | 否 | 布局最后修改时间 |
| `serverTime` | string | 否 | 服务端当前时间 |

### `PUT /api/device/settings`

| 字段 | 类型 | 必填 | 校验 |
| --- | --- | --- | --- |
| `name` | string | 否 | 1–40 字符 |
| `refreshMinutes` | integer | 否 | 5–720 |

至少提供一个字段，返回更新后的 `status` 数据。**不需要令牌**（控制台使用）。

### `GET /api/device/token` / `POST /api/device/token`

- `GET`：读取当前令牌；从未生成时生成一个并持久化，重复调用返回同一值。
- `POST`：轮换令牌。**旧令牌立即失效**，正在使用旧令牌的设备下一次请求即 `401`。

```json
{ "data": { "token": "7f3a9c2e5b8d4a61c0f9e2d7b4a8c153" } }
```

两个接口都不需要鉴权（否则轮换后将无法取回新令牌），但只应暴露在可信局域网内。

### `GET /api/device/screen`

设备拉屏接口，需要 `X-Device-Token`。

- 支持 `If-None-Match: <上次的 ETag>`，内容未变时返回 `304`（无响应体，`ETag` 照常返回）；
- `200` 响应头带 `ETag`（40 位 sha1，带双引号）与 `Cache-Control: no-cache`；
- ETag 只对数据内容做哈希，**不含** `generatedAt`、`now.time`、`now.iso`，因此分钟变化
  不会触发重绘。

响应体顶层字段：`generatedAt`（不参与 ETag）、`timezone`、`etag`（含双引号，可直接作为
`If-None-Match` 的值）、`screen`（宽高、`refreshMinutes`、`layout`）、`now`
（`iso` / `time` / `weekday` / `date` / `dateLabel`）、`month`（`year` / `month` /
`firstWeekday` / `daysInMonth` / `today` / `marks`）、`weather`（`WeatherSnapshot` 或
`null`）、`events`、`courses`、`todos`。完整字段说明、ETag 计算范围与完整示例见
[DEVICE-API.md](DEVICE-API.md) 第 6.2、7 节。

### `POST /api/device/telemetry`

上报设备侧采集的温湿度、电量与信号，需要 `X-Device-Token` 与
`Content-Type: application/json`。全部字段可选：

| 字段 | 类型 | 范围 / 单位 |
| --- | --- | --- |
| `temperature` | number | °C |
| `humidity` | number | % |
| `batteryVoltage` | number | V |
| `batteryPercent` | integer | 0–100 |
| `rssi` | integer | -120–0（dBm） |
| `firmware` | string | 1–64 字符 |
| `uptimeSeconds` | integer | ≥0 |

未提供的字段保留上一次上报的值，`lastSeenAt` 每次都会刷新。

```json
{ "temperature": 24.3, "humidity": 46.8, "batteryPercent": 87, "batteryVoltage": 4.06, "rssi": -56, "firmware": "0.1.0", "uptimeSeconds": 182 }
```

```json
{ "data": { "receivedAt": "2026-10-18T03:40:12.480Z" } }
```

`200` 返回 `receivedAt`；字段超范围返回 `422 VALIDATION_FAILED`；令牌无效返回 `401`。

