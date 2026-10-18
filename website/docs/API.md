# API 文档

Base URL：`http://127.0.0.1:4000/api`（开发期前端通过 Vite 代理访问 `/api`）

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
