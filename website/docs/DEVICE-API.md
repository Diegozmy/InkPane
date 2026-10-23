# 设备端 API 与硬件对接指南

本文档面向 **InkPane 墨窗设备端固件**（ESP32-S3-ePaper-3.97，ESP-IDF v5.x），
描述设备与本地 InkPane 服务之间的全部契约：鉴权方式、接口语义、屏幕数据格式、
800 × 480 单色渲染约定、低功耗刷新策略、错误处理与一种可用的 ESP-IDF 接法。

控制台使用的一般 REST 接口（分类、日程、统计、课程同步等）见 [API.md](API.md)，
后端分层与请求生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 文档说明与版本

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v2（多用户/多设备） |
| 生效时间 | 2026-10 起 |
| 适用固件 | ESP-IDF v6.1（参考实现位于 `hardware/main`；v5.2+ 理论兼容，未验证） |
| 适用服务端 | `website/server`（Express + `node:sqlite`） |
| 契约范围 | `/api/device/*`、`/api/health` |

三条约定先写在前面：

- **字段名、默认值、状态码属于稳定契约。** 改动会被视为破坏性变更；新增字段时设备端
  必须忽略不认识的字段，而不是解析失败。
- **不要依赖响应中字段的排列顺序。** JSON 对象无序，示例中的顺序只为便于阅读。
- **每台设备一个令牌。** 一个后端可以服务多个用户；设备令牌绑定到某台设备，再解析出
  所属用户。设备端只读 `/api/device/screen`、只写 `/api/device/telemetry`。

下文所有时间均为 **ISO-8601**；日期为 `YYYY-MM-DD`；时区由用户在控制台配置，默认 `Asia/Shanghai`。

## 2. 系统架构与时序

设备不直接访问互联网上的日程或天气服务，只与局域网内的本地 InkPane 服务通信；
天气由服务端向 Open-Meteo 取数并缓存，日程、课程、待办来自本地 SQLite。

```
 ┌───────────────────────┐          ┌──────────────────────────────────────┐
 │  ESP32-S3（设备端）    │          │  本地 InkPane 服务（Express）         │
 │                       │          │                                      │
 │  1. RTC 定时唤醒       │          │  GET  /api/device/screen             │
 │  2. Wi-Fi STA 连接     │ ───────► │  POST /api/device/telemetry          │
 │  3. GET /api/device/   │          │  GET  /api/health                    │
 │     screen             │ ◄─────── │                                      │
 │  4. 比对 ETag          │          │                                      │
 │  5. 1-bit 渲染刷新      │          │  ┌──────────────┐  ┌───────────────┐ │
 │  6. POST 遥测          │          │  │ SQLite       │  │ Open-Meteo    │ │
 │  7. 深度休眠           │          │  │ 日程/课程/待办│  │ 天气（15 分钟）│ │
 └───────────────────────┘          │  └──────────────┘  └───────────────┘ │
                                    └──────────────────────────────────────┘
```

一次完整的唤醒循环：

```
唤醒（RTC 定时 / 拨轮按键 / 定时器到期）
  │
  ├─ 连接 Wi-Fi（保存的 SSID，超时 10 s 放弃本次联网）
  │
  ├─ GET /api/device/screen
  │    X-Device-Token: <令牌>
  │    If-None-Match: <上次响应的 ETag>（首次不带）
  │
  ├─ 304 Not Modified ──► 不重绘，跳到「上报遥测」或直接休眠
  │
  └─ 200 OK ──► 解析 JSON ──► 按 layout 排版 ──► 差分/全屏刷新
                        │
                        └─ 记录新的 ETag 与 screenVersion

上报遥测（可选，建议每 N 次唤醒上报一次以省电）
  │
  └─ POST /api/device/telemetry（温度、湿度、电量、RSSI、固件版本、运行时长）

深度休眠
  └─ esp_deep_sleep_start()，由 RTC 定时器在 refreshMinutes 后唤醒
```

要点：

- **ETag 是省电的关键。** 数据没变时服务端返回 `304` 且没有响应体，设备不必渲染、
  不必刷屏，只花一次 HTTP 往返的电量。
- **时钟不走网络。** 分钟级走时由板载 PCF85063 RTC 与局部刷新完成，不需要为每分钟
  刷新整屏，也不需要每分钟联网。
- **离线可用。** 网络失败时保留上一屏内容（墨水屏断电不丢画面），下次唤醒再试。

## 3. 快速开始

五步之内把一块开发板接上本地服务。

**第 1 步：启动服务**

```bash
cd website
npm install
npm run dev          # API: http://127.0.0.1:4000 ，前端: http://127.0.0.1:5173
```

默认监听 `127.0.0.1`，只有本机可访问。设备在局域网内，必须让服务监听所有网卡：

```bash
# 方式一：临时用环境变量（bash / zsh）
HOST=0.0.0.0 npm run dev:api

# Windows PowerShell 下等价写法
$env:HOST='0.0.0.0'; npm run dev:api

# 方式二（推荐）：复制 website/server/.env.example 为 website/server/.env，
# 把 HOST 改为 0.0.0.0 后重启。其余配置项（PORT、CORS_ORIGIN 等）见该文件注释。
```

改完后用 `http://<本机局域网 IP>:4000` 访问；Windows 首次监听时需在防火墙提示中允许
Node.js 的专用网络访问。

**第 2 步：在控制台创建设备并获取令牌**

打开控制台「屏幕与设备」→「添加设备」，完整令牌只会在创建后显示一次。
如果使用旧版数据库，v4 迁移会保留原令牌，无需重新配置。

```json
{ "data": { "device": { "id": 1, "name": "书桌墨窗" }, "token": "7f3a9c2e5b8d4a61c0f9e2d7b4a8c153" } }
```

令牌等同设备密码，不要贴到公开渠道；丢失只能轮换。

**第 3 步：把令牌与 API 地址写入设备 NVS**

```text
namespace: inkpane
key:       api_url   -> http://192.168.1.10:4000
key:       token     -> 7f3a9c2e5b8d4a61c0f9e2d7b4a8c153
key:       etag      -> （首次为空，成功拉取后写入）
key:       ssid/pass -> Wi-Fi 凭据
```

也可以用 `idf.py menuconfig` 编译期内置默认值（见第 11 节），但令牌仍建议保存在 NVS，
以便轮换后不下线重刷固件。

> `hardware/main` 的参考固件已经内置 AP 配网：首次上电（或按住 GPIO5 两秒上电）会打开
> `InkPane-XXXXXX` 热点，用手机在 `http://192.168.4.1` 填写 Wi-Fi、`api_url` 与令牌即可，
> 不需要手工写 NVS 或重新编译固件。下面的 NVS 键仍然是同一套。

**第 4 步：首次拉取屏幕数据**

```bash
curl -s -H "X-Device-Token: 7f3a9c2e5b8d4a61c0f9e2d7b4a8c153" \
  http://127.0.0.1:4000/api/device/screen
```

返回 `200` 与完整的 `DeviceScreenPayload`（结构见第 7 节），响应头带 `ETag`。
把它解析出来、按 `layout.modules` 排版并刷到屏幕上。

**第 5 步：上报一次遥测**

```bash
curl -s -X POST http://127.0.0.1:4000/api/device/telemetry \
  -H "X-Device-Token: 7f3a9c2e5b8d4a61c0f9e2d7b4a8c153" \
  -H "Content-Type: application/json" \
  -d '{"temperature":24.3,"humidity":46.8,"batteryPercent":87,"batteryVoltage":4.06,"rssi":-56,"firmware":"0.1.0","uptimeSeconds":182}'
```

返回 `{ "data": { "receivedAt": "2026-10-18T03:40:12.480Z" } }`。此后控制台的设备页
即可看到 `lastSeenAt`、电量与室内温湿度。

## 4. 鉴权

拉屏与遥测两个设备接口使用**每设备独立令牌**，令牌放在请求头 `X-Device-Token` 中：

```http
GET /api/device/screen HTTP/1.1
Host: 192.168.1.10:4000
X-Device-Token: 7f3a9c2e5b8d4a61c0f9e2d7b4a8c153
If-None-Match: "9f2c1b7e4a6d0c3f8b5e2a91d47c6f03b8e5a1d2"
```

| 项目 | 说明 |
| --- | --- |
| 头名称 | `X-Device-Token` |
| 令牌形态 | 32 位小写十六进制（16 字节随机数，服务端生成，长度固定） |
| 生效范围 | `/api/device/screen`、`/api/device/telemetry` |
| 绑定关系 | 每个令牌对应一台 `devices` 行，进而解析出所属用户；A 的令牌只能拉 A 的数据 |
| 不需要令牌 | `/api/health`、`/api/setup/*`、`/api/auth/*` |

**生成与轮换**

- 在控制台「屏幕与设备」里创建一台设备；完整令牌只在创建响应里返回一次。
- `POST /api/devices/:id/rotate` 轮换。**旧令牌立即失效**，新令牌只返回一次；
  请立刻写入设备 NVS，丢失只能再次轮换。
- 数据库只保存令牌的 SHA-256 与首尾 4 位前缀；没有任何接口能读回完整旧令牌。
- v4 迁移会把旧版单例 `device.token` 迁入 `devices`，旧固件无需改配置即可继续拉取。

**401 响应体**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "设备令牌无效",
    "requestId": "c1a7f3e2-9b4d-4f6a-8e15-2d7c9b0a4f63"
  }
}
```

设备端处理建议：`401` 属于配置错误，重试无意义。停在当前画面、按最长退避间隔再试一次，
或等待人工重新配对；不要把令牌打日志，也不要通过明文 HTTP 之外的渠道传输。

**安全边界（请如实告知使用者）**

- 本服务定位是**本地/可信局域网工具**；管理接口已要求登录，但服务本身不内置 TLS。
- 令牌等同设备密码：拿到令牌即可读取该用户的屏幕数据、伪造该设备的遥测。
- 若需要跨网访问，请在前面放一层反向代理（Nginx / Caddy）并启用 HTTPS，
  只暴露 `/api/device/*`，控制台走独立入口。
- 设备端固件不应在串口日志里打印完整令牌；打印 `tokenPrefix`（前 4 后 4 位）即可。
- 停用用户会立即撤销其会话；该用户的设备令牌在下次请求时返回 `401`。

## 5. 接口一览表

| 方法 | 路径 | 鉴权 | 说明 | 幂等性 |
| --- | --- | --- | --- | --- |
| `GET` | `/api/health` | 否 | 服务存活与结构版本 | 幂等 |
| `GET` | `/api/device/screen` | 设备令牌 | 拉取屏幕数据，支持 `If-None-Match` / `304` | 幂等 |
| `POST` | `/api/device/telemetry` | 设备令牌 | 上报设备状态（温湿度、电量、RSSI 等） | 非幂等（每次上报产生新的 `receivedAt`） |
| `GET` | `/api/devices` | 控制台会话 | 当前账号的设备列表与遥测 | 幂等 |
| `POST` | `/api/devices` | 控制台会话 | 创建设备，完整令牌只返回一次 | 非幂等 |
| `POST` | `/api/devices/:id/rotate` | 控制台会话 | 轮换令牌，旧令牌立即失效 | 非幂等 |
| `DELETE` | `/api/devices/:id` | 控制台会话 | 撤销设备 | 幂等 |
| `GET` | `/api/display` | 控制台会话 | 读取布局、刷新间隔与时区 | 幂等 |
| `PUT` | `/api/display` | 控制台会话 | 修改布局、刷新间隔与时区 | 幂等 |
| `GET` | `/api/display/screen` | 控制台会话 | 控制台预览用屏幕数据（无 ETag） | 幂等 |

请求体上限默认 `256kb`（`BODY_LIMIT`），遥测与设置请求体远小于该值。

## 6. 接口详情

> **v2 变更：** 旧版 `/api/device/token`、`/api/device/status`、`/api/device/settings`
> 已移除。设备只使用 6.2 / 6.3；令牌与状态由控制台的 `/api/devices` 管理。
> 下文 6.4–6.7 仅作为旧版迁移参考保留，设备端不应再调用。

### 6.1 `GET /api/health`

用途：设备联网后的连通性探针，也可用于判断服务是否已启动。

请求：无参数、无鉴权。

```json
{
  "data": {
    "status": "ok",
    "env": "development",
    "schemaVersion": 3,
    "eventCount": 10,
    "uptimeSeconds": 8642,
    "serverTime": "2026-10-18T03:40:00.000Z"
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | string | 固定 `ok` |
| `env` | string | `development` / `production` / `test` |
| `schemaVersion` | integer | 数据库结构版本，便于诊断升级问题 |
| `eventCount` | integer | 库内事件主记录数 |
| `uptimeSeconds` | integer | 服务进程已运行秒数 |
| `serverTime` | string | 服务端当前时间（ISO-8601 UTC） |

状态码：`200`。错误：无（数据库不可用时各字段降级为 `0`，不会 500）。

### 6.2 `GET /api/device/screen`

用途：拉取当前应显示的全部数据。**这是设备端唯一需要周期性调用的接口。**

请求头：

| 头 | 必填 | 说明 |
| --- | --- | --- |
| `X-Device-Token` | 是 | 设备令牌 |
| `If-None-Match` | 否 | 上次响应头中的 `ETag`（含双引号，原样回传）。带此头且内容未变时返回 `304` |

请求参数：无。

响应（`200`）：

| 头 | 值 |
| --- | --- |
| `ETag` | `"9f2c1b7e4a6d0c3f8b5e2a91d47c6f03b8e5a1d2"`（40 位十六进制 sha1，带双引号） |
| `Cache-Control` | `no-cache` |
| `Content-Type` | `application/json; charset=utf-8` |

响应体为 `DeviceScreenPayload`，字段定义见第 7 节，完整示例见 7.8。

响应（`304`）：无响应体，`ETag` 头照常返回。设备端此时**不应重绘**。

**ETag 语义（务必按此实现，否则会频繁误刷新）**

服务端对「数据内容」做 sha1：已移除 `generatedAt`、`now.time`、`now.iso` 这三个与
时间相关、但不会改变画面的字段。因此：

- 只是分钟数变化 → ETag 不变 → `304`，设备不重绘（时钟由本地 RTC 走时）。
- 日程、待办、天气、布局、`refreshMinutes` 任一变化 → ETag 变化 → `200`，设备重绘。
- `now.date` / `now.weekday` / `now.dateLabel` / `month` 参与哈希，跨天时 ETag 必然变化。

状态码：`200`、`304`、`401 UNAUTHORIZED`、`500 INTERNAL_ERROR`。

### 6.3 `POST /api/device/telemetry`

用途：上报设备侧采集到的环境与电源信息，供控制台「设备」页展示，也用于判断设备是否在线。

请求头：`X-Device-Token`（必填）、`Content-Type: application/json`。

请求体（全部字段可选；未提供的字段保留上一次上报的值，至少提供一个才有意义）：

| 字段 | 类型 | 范围 / 单位 | 说明 |
| --- | --- | --- | --- |
| `temperature` | number | °C | 室内温度，来自板载 SHTC3 |
| `humidity` | number | % | 室内相对湿度，来自板载 SHTC3 |
| `batteryVoltage` | number | V | 电池电压，如 `4.06` |
| `batteryPercent` | integer | 0–100 | 电量百分比（估算值） |
| `rssi` | integer | -120–0 | Wi-Fi 信号强度，dBm |
| `firmware` | string | | 固件版本，如 `0.1.0` |
| `uptimeSeconds` | integer | ≥0 | 本次上电后的运行秒数（休眠唤醒会重置，属正常） |

```json
{
  "temperature": 24.3,
  "humidity": 46.8,
  "batteryVoltage": 4.06,
  "batteryPercent": 87,
  "rssi": -56,
  "firmware": "0.1.0",
  "uptimeSeconds": 182
}
```

响应（`200`）：

```json
{ "data": { "receivedAt": "2026-10-18T03:40:12.480Z" } }
```

状态码：`200`、`401 UNAUTHORIZED`、`422 VALIDATION_FAILED`（字段超范围或类型不符）、
`413 PAYLOAD_TOO_LARGE`、`500 INTERNAL_ERROR`。

### 6.4 `GET /api/device/token`

用途：读取当前设备令牌；从未生成时生成一个并持久化。用于首次配对与人工核对。

请求：无鉴权、无参数。

```json
{ "data": { "token": "7f3a9c2e5b8d4a61c0f9e2d7b4a8c153" } }
```

状态码：`200`、`500 INTERNAL_ERROR`。

### 6.5 `POST /api/device/token`

用途：**轮换**令牌。生成新令牌并立即生效，旧令牌在同一瞬间失效。

请求：无鉴权、无请求体。

```json
{ "data": { "token": "2b6d0f9a4c7e1358d2a0b9c6e4f71a38" } }
```

状态码：`200`、`500 INTERNAL_ERROR`。

轮换后的操作顺序（顺序反了设备会短暂失联，属预期）：

1. 调用本接口拿到新令牌；
2. 把新令牌写入设备 NVS（可通过控制台重新配网，或临时用串口命令）；
3. 设备下一次唤醒即用新令牌；
4. 旧令牌的请求全部返回 `401`，可在控制台日志中确认设备已切换。

### 6.6 `GET /api/device/status`

用途：设备与控制台共享的状态汇总。设备可用它确认服务端认定的刷新间隔、
屏幕版本与自己的最后上报时间。

请求头：无鉴权要求（控制台直接读取；设备读取时同样无需令牌）。

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
| `tokenPreview` | string | 否 | 令牌脱敏预览：前 4 位 + `...` + 后 4 位，如 `7f3a...c153` |
| `lastSeenAt` | string | 是 | 最后一次遥测时间；从未上报为 `null` |
| `firmware` | string | 是 | 最后一次上报的固件版本 |
| `batteryPercent` | integer | 是 | 最后一次上报的电量百分比 |
| `batteryVoltage` | number | 是 | 最后一次上报的电池电压（V） |
| `rssi` | integer | 是 | 最后一次上报的信号强度（dBm） |
| `indoorTemperature` | number | 是 | 最后一次上报的室内温度（°C） |
| `indoorHumidity` | number | 是 | 最后一次上报的室内湿度（%） |
| `screenVersion` | string | 否 | 当前屏幕数据的 ETag 哈希（不含双引号） |
| `refreshMinutes` | integer | 否 | 当前刷新间隔（分钟） |
| `layoutUpdatedAt` | string | 否 | 布局最后修改时间 |
| `serverTime` | string | 否 | 服务端当前时间 |

状态码：`200`、`500 INTERNAL_ERROR`。

### 6.7 `PUT /api/device/settings`

用途：修改设备名与刷新间隔。控制台使用；设备一般不需要调用，但可用它把自己算出的
推荐间隔写回服务端。

请求头：`Content-Type: application/json`（无鉴权要求，控制台使用）。

| 字段 | 类型 | 必填 | 校验 |
| --- | --- | --- | --- |
| `name` | string | 否 | 1–40 字符 |
| `refreshMinutes` | integer | 否 | 5–720 |

```json
{ "name": "书桌墨窗", "refreshMinutes": 15 }
```

响应体与 `GET /api/device/status` 的 `data` 完全一致（返回更新后的状态）。

状态码：`200`、`422 VALIDATION_FAILED`、`500 INTERNAL_ERROR`。

### 6.8 `GET /api/display`（布局元数据）

用途：读取当前布局、刷新间隔，以及六个模块的可选值与默认矩形。控制台布局编辑器使用；
设备端可选读一次以校验自己的渲染实现。

请求：无鉴权、无参数。

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

`modules` 数组共 6 项（`clock`、`calendar`、`weather`、`schedule`、`courses`、`todos`），
名称与职责见第 8 节。数组顺序**不构成契约**，请按 `id` 索引。

状态码：`200`、`500 INTERNAL_ERROR`。

### 6.9 `PUT /api/display`

用途：保存布局与刷新间隔。两个字段均可选，只传其一即可。

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

校验规则（不满足返回 `400 VALIDATION_FAILED`，`details[].path` 指向具体模块）：

- 传了 `layout` 时，`width` / `height` 必须分别是 `800` / `480`，`modules` 必须正好 6 项；
- 6 个 `id` 必须齐全且唯一：`clock` / `calendar` / `weather` / `schedule` / `courses` / `todos`；
- `x`、`y`、`w`、`h` 均为整数，且都是 **4 的倍数**；
- `x >= 0`、`y >= 0`、`w >= 80`、`h >= 48`；
- `x + w <= 800`、`y + h <= 480`；
- `refreshMinutes` 为 5–720 的整数；
- `layout.updatedAt` 即使传了也会被忽略，由服务端刷新；
- 服务端只校验边界与对齐，**不校验模块重叠**，重叠与否由布局编辑器自行约束。

响应体与 `GET /api/display` 的 `data` 一致。

状态码：`200`、`400 VALIDATION_FAILED`、`500 INTERNAL_ERROR`。

### 6.10 `GET /api/display/screen`（控制台预览）

用途：控制台预览当前用户设备将看到的画面。**需要控制台会话、忽略 `If-None-Match`、总是返回 `200`。**

响应体与 `GET /api/device/screen` 完全相同（`DeviceScreenPayload`），但：

- 不返回 `ETag` / `Cache-Control: no-cache`；
- 不更新设备 `lastSeenAt`。

> 设备端请使用 `GET /api/device/screen`。使用预览接口会失去 `304` 省电能力，
> 也无法被服务端识别为设备流量。

状态码：`200`、`500 INTERNAL_ERROR`。

## 7. 数据契约

### 7.1 `DeviceScreenPayload`（顶层）

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `schemaVersion` | integer | 否 | 当前为 `1`；不认识的版本应先提示升级固件 |
| `generatedAt` | string | 否 | 快照生成时刻，ISO-8601 UTC。**不参与 ETag** |
| `timezone` | string | 否 | IANA 时区名，由用户配置；`now` 与 `month` 均按此计算 |
| `etag` | string | 否 | 数据内容哈希（40 位小写十六进制 sha1，**含双引号**），与响应头 `ETag` 完全一致，可直接作为 `If-None-Match` 的值 |
| `device` | object \| null | 是 | 当前设备 `{ id, name }`；**不参与 ETag** |
| `screen` | object | 否 | 屏幕尺寸、刷新间隔与当前布局，见 7.2 |
| `now` | object | 否 | 当前时间信息，见 7.3 |
| `month` | object | 否 | 当月日历信息，见 7.4 |
| `weather` | object \| null | 是 | 天气快照，见 7.7；关闭天气或从未成功取数时为 `null` |
| `events` | `DeviceEvent[]` | 否 | 当日日程（含全天事件，不含课程；课程在 `courses` 中），见 7.5 |
| `courses` | `DeviceEvent[]` | 否 | 当日课程，元素结构与 `events` 相同、`isCourse` 为 `true` |
| `todos` | `DeviceTodo[]` | 否 | 未完成待办，最多 8 条（按 `sortOrder` 升序），见 7.6 |

### 7.2 `screen` / `DisplayLayout` / `DisplayModule`

`screen`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `width` | integer | 固定 `800` |
| `height` | integer | 固定 `480` |
| `refreshMinutes` | integer | 5–720，默认 `30`；设备应据此设置休眠时长 |
| `layout` | `DisplayLayout` | 当前布局 |

`DisplayLayout`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `width` | integer | 固定 `800` |
| `height` | integer | 固定 `480` |
| `updatedAt` | string | 布局最后修改时间，ISO-8601 UTC |
| `modules` | `DisplayModule[]` | 6 项，`id` 唯一且齐全；顺序不构成契约，请按 `id` 索引 |

`DisplayModule`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `clock` / `calendar` / `weather` / `schedule` / `courses` / `todos` |
| `enabled` | boolean | 为 `false` 时不绘制该模块，但矩形仍然有效 |
| `x` | integer | 左上角横坐标，像素，4 的倍数 |
| `y` | integer | 左上角纵坐标，像素，4 的倍数 |
| `w` | integer | 宽度，像素，≥80 且为 4 的倍数 |
| `h` | integer | 高度，像素，≥48 且为 4 的倍数 |

### 7.3 `now`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `iso` | string | 当前时刻，ISO-8601 UTC（`toISOString()` 形式）。**不参与 ETag** |
| `time` | string | `HH:MM`，24 小时制。**不参与 ETag** |
| `weekday` | string | `周一` … `周日` |
| `date` | string | `YYYY-MM-DD` |
| `dateLabel` | string | 可直接绘制的日期标签，形如 `10月18日`（不含年份）；设备端原样绘制，不要反向解析 |
| `epochSeconds` | integer | 服务端当前 Unix 秒。**不参与 ETag**；用于校准 RTC |
| `utcOffsetMinutes` | integer | 用户时区相对 UTC 的偏移分钟数（东八区 `480`） |
| `localIso` | string | 用户时区下的本地墙上时间，`YYYY-MM-DDTHH:mm:ss`。**不参与 ETag**；可直接写入 RTC |

### 7.4 `month`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `year` | integer | 年份 |
| `month` | integer | 月份，1–12 |
| `firstWeekday` | integer | 当月 1 日是星期几，**0 = 周日**，1 = 周一 … 6 = 周六 |
| `daysInMonth` | integer | 当月天数，28–31 |
| `today` | integer | 今天在本月的日号（1–31） |
| `marks` | `number[]` | 当月有日程的日号（升序、去重），供小日历打点 |

绘制小日历时的列序为「周日 周一 … 周六」，即第 0 列是周日，与 `firstWeekday` 对齐。

### 7.5 `DeviceEvent`

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 否 | `${eventId}:${occurrenceKey}`，渲染列表时的稳定 key |
| `eventId` | integer | 否 | 日程主记录 id |
| `occurrenceKey` | string | 否 | 实例在原始序列中的开始时刻；全天事件为 `YYYY-MM-DD` |
| `title` | string | 否 | 标题 |
| `location` | string | 否 | 地点，可为空串 |
| `startAt` | string | 否 | 开始时刻；全天事件为 `YYYY-MM-DD` |
| `endAt` | string | 否 | 结束时刻；全天事件为 `YYYY-MM-DD` |
| `allDay` | boolean | 否 | 是否全天事件 |
| `categoryId` | integer \| null | 是 | 分类 id，未分类为 `null` |
| `color` | string \| null | 是 | `#RRGGBB`。已解析：事件自身颜色优先，否则取分类色；未分类或分类已删除时为 `null` |
| `priority` | string | 否 | `low` / `normal` / `high` / `urgent` |
| `isCourse` | boolean | 否 | 是否来自课程同步（`courses` 中恒为 `true`） |

### 7.6 `DeviceTodo`

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `id` | integer | 否 | 待办 id |
| `title` | string | 否 | 标题 |
| `priority` | string | 否 | `low` / `normal` / `high` / `urgent` |
| `dueDate` | string \| null | 是 | 截止日期 `YYYY-MM-DD`；无截止日期为 `null` |

### 7.7 `WeatherSnapshot`

| 字段 | 类型 | 可空 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | 否 | 固定 `open-meteo` |
| `city` | string | 否 | 城市名，来自天气设置 |
| `latitude` | number | 否 | 纬度 |
| `longitude` | number | 否 | 经度 |
| `observedAt` | string | 否 | 数据观测时刻，ISO-8601 UTC |
| `fetchedAt` | string | 否 | 本次取数（或缓存写入）时刻，ISO-8601 UTC |
| `stale` | boolean | 否 | `true` 表示缓存已过期且刷新失败，正在用旧数据 |
| `source` | string | 否 | `open-meteo`（实时取数）/ `cache`（命中 15 分钟缓存）/ `fallback`（从未成功） |
| `message` | string | 是 | 降级或失败时的说明文字，正常取数时不出现 |
| `current` | object | 否 | 实况，见下 |
| `today` | object | 否 | 今日概览，见下 |
| `forecast` | object[] | 否 | 3 天预报，**含今天**，`forecast[0].date === today.date` |

设备拉屏时天气**只读服务端缓存**，不会因为设备唤醒而联网：`weather` 要么是 `null`
（开关关闭或从未成功取数），要么 `source` 为 `cache`（可能 `stale: true`，表示缓存已过期）。
`source: "open-meteo"` 只会出现在控制台直连 `/api/weather` 的响应里。

`current`：

| 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `temperature` | number | °C | 温度 |
| `apparentTemperature` | number | °C | 体感温度 |
| `humidity` | integer | % | 相对湿度 |
| `weatherCode` | integer | | WMO 天气代码 |
| `condition` | string | | 中文天气描述，如「多云」 |
| `icon` | string | | 图标标识，如 `clear` / `partly-cloudy` / `rain` / `snow` / `fog` / `thunder` |
| `windSpeed` | number | km/h | 风速 |
| `isDay` | boolean | | 是否白天 |

`today`：

| 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `date` | string | | `YYYY-MM-DD` |
| `min` | number | °C | 最低温 |
| `max` | number | °C | 最高温 |
| `precipitationProbability` | integer | % | 降水概率 |
| `condition` | string | | 中文描述 |
| `icon` | string | | 图标标识 |

`forecast[]` 元素：

| 字段 | 类型 | 单位 | 说明 |
| --- | --- | --- | --- |
| `date` | string | | `YYYY-MM-DD` |
| `weekday` | string | | `周一` … `周日` |
| `min` | number | °C | 最低温 |
| `max` | number | °C | 最高温 |
| `condition` | string | | 中文描述 |
| `icon` | string | | 图标标识 |
| `precipitationProbability` | integer | % | 降水概率 |

### 7.8 完整示例

场景：`2026-10-18T11:40:00+08:00`（周日），刷新间隔 30 分钟，天气正常取数。
以下为 `GET /api/device/screen` 的完整响应体（`{ "data": … }` 信封一并给出）。
注意 `courses` 为空数组——示例日期是周日，没有课程；工作日会出现与 `events`
同结构的条目，`isCourse` 为 `true`，见 7.9。

```json
{
  "data": {
    "generatedAt": "2026-10-18T03:40:00.042Z",
    "timezone": "Asia/Shanghai",
    "etag": "\"9f2c1b7e4a6d0c3f8b5e2a91d47c6f03b8e5a1d2\"",
    "screen": {
      "width": 800,
      "height": 480,
      "refreshMinutes": 30,
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
      }
    },
    "now": {
      "iso": "2026-10-18T03:40:00.000Z",
      "time": "11:40",
      "weekday": "周日",
      "date": "2026-10-18",
      "dateLabel": "10月18日"
    },
    "month": {
      "year": 2026,
      "month": 10,
      "firstWeekday": 4,
      "daysInMonth": 31,
      "today": 18,
      "marks": [2, 5, 8, 12, 15, 18, 21, 26, 29]
    },
    "weather": {
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
    },
    "events": [
      {
        "id": "1042:2026-10-18T01:00:00.000Z",
        "eventId": 1042,
        "occurrenceKey": "2026-10-18T01:00:00.000Z",
        "title": "数学竞赛辅导",
        "location": "实验楼 302",
        "startAt": "2026-10-18T01:00:00.000Z",
        "endAt": "2026-10-18T02:30:00.000Z",
        "allDay": false,
        "categoryId": 1,
        "color": "#3b6fd4",
        "priority": "high",
        "isCourse": false
      },
      {
        "id": "1043:2026-10-18",
        "eventId": 1043,
        "occurrenceKey": "2026-10-18",
        "title": "整理下周错题本",
        "location": "",
        "startAt": "2026-10-18",
        "endAt": "2026-10-18",
        "allDay": true,
        "categoryId": 2,
        "color": "#0f766e",
        "priority": "normal",
        "isCourse": false
      },
      {
        "id": "1044:2026-10-18T10:00:00.000Z",
        "eventId": 1044,
        "occurrenceKey": "2026-10-18T10:00:00.000Z",
        "title": "家庭晚餐",
        "location": "家",
        "startAt": "2026-10-18T10:00:00.000Z",
        "endAt": "2026-10-18T11:30:00.000Z",
        "allDay": false,
        "categoryId": 3,
        "color": "#b45309",
        "priority": "normal",
        "isCourse": false
      }
    ],
    "courses": [],
    "todos": [
      { "id": 31, "title": "订正物理周测卷", "priority": "high", "dueDate": "2026-10-18" },
      { "id": 32, "title": "准备英语演讲提纲", "priority": "normal", "dueDate": "2026-10-20" },
      { "id": 33, "title": "归还图书馆借书", "priority": "low", "dueDate": null }
    ]
  }
}
```

### 7.9 `courses` 元素示例

工作日（例如 `2026-10-19` 周一）的 `courses` 会包含当日课程。课程条目与 `events`
元素同构，只是 `isCourse` 为 `true`，且 `id` 同样由 `eventId` 与 `occurrenceKey` 拼成：

```json
{
  "id": "1102:2026-10-19T00:00:00.000Z",
  "eventId": 1102,
  "occurrenceKey": "2026-10-19T00:00:00.000Z",
  "title": "高三语文1-1",
  "location": "301",
  "startAt": "2026-10-19T00:00:00.000Z",
  "endAt": "2026-10-19T00:40:00.000Z",
  "allDay": false,
  "categoryId": 6,
  "color": "#2f6e9e",
  "priority": "normal",
  "isCourse": true
}
```

`startAt` 为 `2026-10-19T00:00:00.000Z` 即北京时间当天 08:00，与课程同步中配置的
「第一节 08:00–08:40」对应。

## 8. 屏幕与渲染规范

### 8.1 面板参数

| 项目 | 值 |
| --- | --- |
| 分辨率 | 800 × 480 |
| 颜色 | 单色 1-bit（黑 / 白） |
| 单帧缓冲 | `800 × 480 / 8 = 48000` 字节 |
| 建议驱动 | 微雪官方 e-paper 驱动（SPI），详见硬件文档 |
| 坐标系 | 原点在左上角，x 向右、y 向下，单位为像素 |

### 8.2 模块 id 与默认矩形

六个模块的 id 是稳定契约，设备端按 id 决定绘制内容，按矩形决定绘制区域。
默认布局如下（表中按所在位置分组；`modules` 数组本身按 `clock`、`calendar`、`weather`、
`schedule`、`courses`、`todos` 排列）。`GET /api/display` 的 `modules[].defaultRect` 与之一致：

| id | 名称 | 默认矩形 `(x, y, w, h)` | 内容 |
| --- | --- | --- | --- |
| `clock` | 时钟 | `16, 16, 220, 100` | 大字时间、星期与日期；数字用等宽 |
| `calendar` | 月历 | `16, 128, 220, 180` | 当月月历，`marks` 打点，`today` 高亮 |
| `todos` | 待办 | `16, 320, 220, 144` | 未完成待办，按 `sortOrder` 排序 |
| `weather` | 天气 | `248, 16, 240, 288` | 当前天气与 3 天预报；室内温湿度可一并用遥测值 |
| `courses` | 今日课程 | `248, 316, 240, 148` | 当天课程时间、名称、教室 |
| `schedule` | 今日日程 | `500, 16, 284, 448` | 当天时间线，`events` 按开始时刻排列 |

布局约束（服务端在 `PUT /api/display` 时校验）：

- 坐标为像素整数，且必须是 **4 的倍数**（与墨水屏按字节寻址的刷屏方式对齐，避免半字节偏移）；
- `w >= 80`、`h >= 48`，保证至少能画下一行 24 点阵中文；
- `x + w <= 800`、`y + h <= 480`；
- 默认布局四周留 **16 px 安全边距**，模块之间默认留 12 px 间距（见上表坐标）；
- 模块之间**不要重叠**（服务端不校验，渲染重叠会互相覆盖）。

### 8.3 1-bit 渲染约定

- **白底黑字。** 面板底色为白，文字与分隔线为黑；反色块（黑底白字）只用于强调，
  面积不宜超过模块的三分之一。
- **无灰阶。** 需要「灰」时用 2 × 2 或 4 × 4 抖动图案，不要依赖灰度；抖动图案在
  3.97 英寸屏的观看距离下会显得脏，能不用就不用。
- **字体**：建议 16 / 24 / 32 三档点阵字（或思源黑体子集按档位点阵化）。
  - 16 点：次要信息、地点、说明文字；
  - 24 点：正文与列表项；
  - 32 点：模块标题、时间；
  - 时间数字必须等宽（tabular），否则分钟跳动时整行会左右晃。
- **分隔线** 1 px，颜色为黑；模块标题下可用一条 1 px 线建立层级。
- **对齐**：同一模块内左对齐为主，数字右对齐；行与行之间留 4–8 px。
- 不要在屏幕上做动画或渐变，刷新一次即静止。

### 8.4 中文绘制注意点

- 源码与 JSON 均为 **UTF-8**；设备端解析后按 UTF-8 逐码点查字库，不要先转 GBK。
- 字库必须做**子集裁剪**：GB2312 一二级字（约 6763 字）+ 常用标点足够覆盖日程与课程名；
  整套中日韩字库会占掉数 MB Flash，没有必要。
- 字库建议放在 Flash 的只读分区（`ESP_PARTITION_TYPE_DATA` + `spiffs`/`fat` 或直接
  编译进固件），按码点二分查找字形位图。
- **行高**：16 点字行高 20 px，24 点字行高 30 px，32 点字行高 40 px；不要用 16 px 行高
  压 16 点字，中文会粘连。
- **截断**：模块宽度放不下时按字截断并追加省略号（`…`），不要从中间切断多字节字符。
- 日程与课程标题里可能出现全角括号、破折号、间隔号，字库子集要一并包含，
  否则会画成空白方框。

## 9. 低功耗刷新策略

### 9.1 `refreshMinutes` 与双周期休眠

- `refreshMinutes` 取值为 **5–720** 的整数，默认 **30**，可通过 `PUT /api/display` 修改。
  它只决定**联网拉取**的周期，不决定时钟走时。
- 设备端应使用两个独立的唤醒周期：
  - **时钟周期**：约每分钟（或活跃时段每分钟、夜间 5 分钟）唤醒，只读 RTC、局部刷新
    `clock` 矩形；
  - **网络周期**：按 `screen.refreshMinutes` 唤醒，连 Wi-Fi、拉取 `/api/device/screen`、
    上报遥测。
- 每次计算下一次唤醒时取两者中较早的时间；不要用 30 分钟网络周期直接代替时钟周期，
  否则分钟数会明显滞后。

```c
/* 网络周期 */
esp_sleep_enable_timer_wakeup((uint64_t)refresh_minutes * 60ULL * 1000000ULL);
/* 实际实现还需要把定时器设为 min(下一次分钟边界, 下一次网络拉取) */
esp_deep_sleep_start();
```

- 深度休眠期间屏幕**保持显示**（墨水屏断电不丢画面），这是墨水屏相对 LCD 的核心优势：
  待机电流取决于板卡（TG28 + 外设断电），以实测为准，通常在几十 µA 量级。
- 唤醒源可以叠加：RTC 定时器 + 拨轮按键（RTC GPIO）+ PCF85063 的闹钟中断。
  按键唤醒时立即刷新一次，能让「按下即更新」的交互成立。
- 分钟级局部刷新会累积残影并消耗面板刷新寿命：每天首次唤醒做一次全刷，
  连续局刷 12–24 次后插入全刷，低温环境缩短全刷周期。

### 9.2 时钟由本地 RTC 走时

- **不要为了分钟跳变而每分钟刷新整屏。** 时钟模块的走时由 PCF85063 RTC 提供，
  设备端只在分钟边界做一次**局部刷新**，只重画 `clock` 模块的矩形。
- PCF85063 通过 I²C 读取，掉电由纽扣电池维持；联网后可用 `now.epochSeconds` +
  `now.utcOffsetMinutes` 校准，或直接把 `now.localIso` 写入 RTC（均为本地墙上时间）。
- 304 响应没有 body，但 HTTP `Date` 头仍在；可用它加已保存的时区偏移做低成本校准。
- 时区：`screen` 数据中的 `now` 已按 `timezone` 换算好，设备端不需要自己做时区换算。

### 9.3 ETag 命中 304 时不重绘

- 每次成功拉取后，把响应头 `ETag`（含双引号，原样）写入 NVS。
- 下次请求带上 `If-None-Match: <ETag>`；返回 `304` 时**跳过解析与渲染**，
  直接进入遥测/休眠流程。
- 这样一天 48 次唤醒（30 分钟间隔）里，真正刷屏的通常只有几次：
  跨天、日程变动、天气更新、布局调整。

### 9.4 刷新模式与残影

| 模式 | 适用 | 代价 |
| --- | --- | --- |
| 全屏刷新（full） | 首次上电、跨天、布局变化、大面积内容变化 | 约 2 s 级黑闪，观感明显 |
| 局部刷新（partial） | 时钟分钟、单项待办勾选、温度变化 | 快、无黑闪，但会累积残影 |

建议策略：

- 时钟分钟用局部刷新；每天首次唤醒做一次全屏刷新，清掉前一天残影。
- 局部刷新连续超过 **12–24 次**，或局部区域面积超过屏幕 1/3 时，插入一次全屏刷新。
- 环境温度低时墨水屏响应变慢、残影更重，低温环境下应缩短全刷间隔。
- 若发现局部刷新后出现「鬼影」，优先缩短全刷周期，而不是反复局部刷新同一区域。

### 9.5 电池与充电

- 电池为 **3.7 V 锂电**，接口 **MX1.25**（2 pin），板载 **TG28** 电源管理负责充放电与
  电压监测；USB Type-C 插入时自动充电。
- 通过 TG28 读取电池电压后上报 `batteryVoltage`；`batteryPercent` 为按电压估算的
  近似值，仅供控制台概览，不宜用于精确电量计。
- 建议策略：电量低于 20% 时把 `refreshMinutes` 调大（减少唤醒），并在 `clock` 或
  `weather` 模块一角显示低电量标记。
- 长期插电使用时，锂电池应避免长期满电高温存放；这是电池化学特性，不是固件问题。

## 10. 错误处理与重试

### 10.1 错误体

所有错误统一为：

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "设备令牌缺失或无效",
    "details": [{ "path": "batteryPercent", "message": "必须小于等于 100", "code": "too_big" }],
    "requestId": "c1a7f3e2-9b4d-4f6a-8e15-2d7c9b0a4f63"
  }
}
```

`details` 仅在 `VALIDATION_FAILED` 时出现。`requestId` 同时出现在响应头
`X-Request-Id` 中，排查问题时把它一起带上。

### 10.2 错误码表

| HTTP | code | 设备端处理 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 请求体不是合法 JSON 或参数语义非法；修正固件，不重试 |
| 401 | `UNAUTHORIZED` | 令牌缺失/失效；检查 NVS 中令牌，不要盲目重试 |
| 404 | `NOT_FOUND` | 接口路径错误（多半是 `api_url` 少写或多写了路径）；修正配置 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超限；检查是否误传了大数组 |
| 422 | `VALIDATION_FAILED` | 字段校验失败；按 `details[].path` 修正，不重试 |
| 429 | `RATE_LIMITED` | 请求过于频繁；退避到 `refreshMinutes` 之后再试 |
| 500 | `INTERNAL_ERROR` | 服务端异常；按退避重试，保留上一屏 |
| 503 | `SERVICE_UNAVAILABLE` | 服务未就绪（如迁移中）；按退避重试 |

`429` 与 `503` 属于约定：当前实现不会主动限流，但设备端应把这两种状态按
「需退避」处理，以便服务端将来加入限流时不改固件。

### 10.3 超时与退避

| 项目 | 建议值 |
| --- | --- |
| DNS / 连接超时 | 5 s |
| 整体请求超时 | 8 s（`esp_http_client_config_t.timeout_ms`） |
| 遥测请求超时 | 5 s |
| 首次退避 | 5 s |
| 退避倍数 | ×3 |
| 退避上限 | 5 min 或 `refreshMinutes`（取较大者） |
| 单次唤醒最多重试 | 2 次（含首次共 3 次） |

重试序列示例：`5 s → 15 s → 45 s → 放弃，休眠`。**不要在同一唤醒周期内无限重试**，
电池会被耗尽；把「这次没拉到」当作正常分支，保持上一屏即可。

### 10.4 离线降级

- 拉取失败时**保留上一屏**，绝不刷白屏或画错误页。
- 若连续失败超过 3 个唤醒周期，可在屏幕角落叠加一个小的「离线」标记（16 点字，
  局部刷新），恢复后立即清除。
- Wi-Fi 连接失败时不要反复重连带崩电源：一次唤醒最多尝试 3 次连接，单次 10 s 超时，
  失败直接休眠。
- 时间仍在走：RTC 与本机时钟不受联网影响，离线时时钟模块照常显示。

## 11. ESP-IDF 对接示例

以下为伪代码，但调用的 API 均为 ESP-IDF v5.x / v6.x 真实存在的接口，可直接照着落地。
完整固件工程位于仓库 [`hardware/main`](../../hardware/main)（ESP-IDF v6.1，已实现本文全部
设备端契约；构建、配网与验收步骤见 [hardware/README.md](../../hardware/README.md)）。

示例中出现的 `board_init()`、`inkpane_draw_module()`、`inkpane_refresh_minutes()`、
`battery_percent()`、`battery_millivolt()`、`wifi_rssi()`、`BUTTON_WAKE_PIN_MASK`
等为本项目自定义函数与常量，需要自行实现（`inkpane_sleep` 在使用前需前置声明）。

### 11.1 menuconfig 配置项

在固件的 `Kconfig.projbuild` 中声明：

```text
menu "InkPane"

    config INKPANE_API_URL
        string "本地 InkPane 服务地址"
        default "http://192.168.1.10:4000"
        help
            设备启动时用作默认 API 地址；NVS 中存在 api_url 时以 NVS 为准。

    config INKPANE_DEVICE_TOKEN
        string "设备令牌（编译期默认值，可留空）"
        default ""
        help
            留空表示只从 NVS 读取。令牌等同密码，不要把真实令牌提交进仓库。

endmenu
```

对应 `sdkconfig.defaults`：

```text
CONFIG_INKPANE_API_URL="http://192.168.1.10:4000"
CONFIG_INKPANE_DEVICE_TOKEN=""
```

### 11.2 NVS 读写令牌与 ETag

```c
#include "nvs.h"
#include "nvs_flash.h"

#define NVS_NS "inkpane"

static char s_token[80];
static char s_etag[80];

static esp_err_t load_str(const char *key, char *out, size_t out_len)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READONLY, &h);
    if (err != ESP_OK) return err;
    size_t len = out_len;
    err = nvs_get_str(h, key, out, &len);
    nvs_close(h);
    return err;
}

static esp_err_t save_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NVS_NS, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, key, value);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

/* 启动时：令牌优先取 NVS，其次取编译期默认值 */
void inkpane_load_config(void)
{
    if (load_str("token", s_token, sizeof(s_token)) != ESP_OK) {
        strlcpy(s_token, CONFIG_INKPANE_DEVICE_TOKEN, sizeof(s_token));
    }
    if (load_str("etag", s_etag, sizeof(s_etag)) != ESP_OK) {
        s_etag[0] = '\0';   /* 首次拉取不带 If-None-Match */
    }
}
```

### 11.3 Wi-Fi STA 连接

```c
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"

static EventGroupHandle_t s_wifi_events;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupSetBits(s_wifi_events, WIFI_FAIL_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

bool wifi_connect(uint32_t timeout_ms)
{
    /* esp_netif_init / esp_event_loop_create_default / esp_wifi_init 已在 app_main 完成 */
    wifi_config_t cfg = { 0 };
    strlcpy((char *)cfg.sta.ssid, CONFIG_INKPANE_WIFI_SSID, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, CONFIG_INKPANE_WIFI_PASSWORD, sizeof(cfg.sta.password));
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    esp_wifi_start();

    EventBits_t bits = xEventGroupWaitBits(
        s_wifi_events, WIFI_CONNECTED_BIT | WIFI_FAIL_BIT, pdFALSE, pdFALSE,
        pdMS_TO_TICKS(timeout_ms));
    return (bits & WIFI_CONNECTED_BIT) != 0;
}
```

### 11.4 拉取屏幕数据并读取 ETag

```c
#include "esp_http_client.h"
#include "cJSON.h"

typedef struct {
    char *body;        /* 由 HTTP_EVENT_ON_DATA 累积的响应体 */
    size_t len;
    char etag[80];     /* 由 HTTP_EVENT_ON_HEADER 捕获的 ETag，含双引号 */
} http_ctx_t;

static esp_err_t http_event_handler(esp_http_client_event_t *evt)
{
    http_ctx_t *ctx = evt->user_data;
    if (ctx == NULL) return ESP_OK;

    switch (evt->event_id) {
    case HTTP_EVENT_ON_HEADER:
        if (evt->header_key != NULL && evt->header_value != NULL &&
            strcasecmp(evt->header_key, "ETag") == 0) {
            strlcpy(ctx->etag, evt->header_value, sizeof(ctx->etag));
        }
        break;
    case HTTP_EVENT_ON_DATA:
        if (evt->data_len > 0) {
            char *grown = realloc(ctx->body, ctx->len + evt->data_len + 1);
            if (grown == NULL) return ESP_FAIL;
            ctx->body = grown;
            memcpy(ctx->body + ctx->len, evt->data, evt->data_len);
            ctx->len += evt->data_len;
            ctx->body[ctx->len] = '\0';
        }
        break;
    default:
        break;
    }
    return ESP_OK;
}

/* 返回 200 表示已拿到新数据，304 表示无需重绘，-1 表示网络层失败 */
int inkpane_fetch_screen(char **out_body)
{
    http_ctx_t ctx = { .body = NULL, .len = 0, .etag = { 0 } };
    char url[192];
    snprintf(url, sizeof(url), "%s/api/device/screen", CONFIG_INKPANE_API_URL);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 8000,
        .event_handler = http_event_handler,
        .user_data = &ctx,
        .keep_alive_enable = false,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    if (client == NULL) return -1;

    esp_http_client_set_header(client, "X-Device-Token", s_token);
    if (s_etag[0] != '\0') {
        esp_http_client_set_header(client, "If-None-Match", s_etag);
    }

    esp_err_t err = esp_http_client_perform(client);
    int status = (err == ESP_OK) ? esp_http_client_get_status_code(client) : -1;

    if (status == 200 && ctx.etag[0] != '\0') {
        strlcpy(s_etag, ctx.etag, sizeof(s_etag));   /* 含双引号，原样保存 */
        save_str("etag", s_etag);
        *out_body = ctx.body;                        /* 交给渲染层，用完 free */
    } else {
        free(ctx.body);
        *out_body = NULL;
    }

    esp_http_client_cleanup(client);
    return status;
}
```

`esp_http_client_perform()` 一次完成 open / fetch headers / read / close，`ETag` 在
`HTTP_EVENT_ON_HEADER` 里取，不依赖中间状态；`304` 时服务端不返回响应体，
`ctx.body` 为 `NULL`，直接释放即可。

### 11.5 cJSON 解析关键字段

```c
/* body 为校验过的 DeviceScreenPayload：{"data":{...}} */
void inkpane_render_from_json(const char *body)
{
    cJSON *root = cJSON_Parse(body);
    if (root == NULL) return;
    cJSON *data = cJSON_GetObjectItemCaseSensitive(root, "data");
    if (data == NULL) { cJSON_Delete(root); return; }

    cJSON *now = cJSON_GetObjectItemCaseSensitive(data, "now");
    const char *time_str   = cJSON_GetStringValue(
        cJSON_GetObjectItemCaseSensitive(now, "time"));      /* "11:40" */
    const char *date_label = cJSON_GetStringValue(
        cJSON_GetObjectItemCaseSensitive(now, "dateLabel"));
    const char *weekday    = cJSON_GetStringValue(
        cJSON_GetObjectItemCaseSensitive(now, "weekday"));   /* "周日" */

    cJSON *screen = cJSON_GetObjectItemCaseSensitive(data, "screen");
    int refresh_minutes = cJSON_GetObjectItemCaseSensitive(
        screen, "refreshMinutes")->valueint;

    cJSON *layout = cJSON_GetObjectItemCaseSensitive(screen, "layout");
    cJSON *modules = cJSON_GetObjectItemCaseSensitive(layout, "modules");
    cJSON *module = NULL;
    cJSON_ArrayForEach(module, modules) {
        const char *id = cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(module, "id"));
        bool enabled = cJSON_IsTrue(
            cJSON_GetObjectItemCaseSensitive(module, "enabled"));
        int x = cJSON_GetObjectItemCaseSensitive(module, "x")->valueint;
        int y = cJSON_GetObjectItemCaseSensitive(module, "y")->valueint;
        int w = cJSON_GetObjectItemCaseSensitive(module, "w")->valueint;
        int h = cJSON_GetObjectItemCaseSensitive(module, "h")->valueint;
        if (enabled) inkpane_draw_module(id, x, y, w, h, data);  /* 按 id 分派 */
    }

    /* todos / events / courses / weather 均为数组，用 cJSON_GetArraySize 判断空 */
    cJSON *todos = cJSON_GetObjectItemCaseSensitive(data, "todos");
    for (int i = 0; i < cJSON_GetArraySize(todos); i += 1) {
        cJSON *todo = cJSON_GetArrayItem(todos, i);
        const char *title = cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(todo, "title"));
        const char *priority = cJSON_GetStringValue(
            cJSON_GetObjectItemCaseSensitive(todo, "priority"));
        cJSON *due = cJSON_GetObjectItemCaseSensitive(todo, "dueDate");
        /* due 可能为 cJSON_NULL：先 cJSON_IsString(due) 再取字符串 */
        (void)title; (void)priority; (void)due;
    }

    cJSON_Delete(root);
}
```

注意：`weather` 可能为 `null`（`cJSON_IsNull()` 为真），`todos[].dueDate` 也可能为 `null`。
所有可空字段都要先判类型再取值，不要直接 `->valuestring`。

### 11.6 SHTC3 读取室内温湿度

```c
#include "driver/i2c_master.h"

/* dev 为在 i2c_master_bus 上通过 i2c_master_bus_add_device() 创建好的设备句柄。
 * 下列接口来自 ESP-IDF v5.2 起的新版 I2C 主设备驱动（driver/i2c_master.h）；
 * 若使用 v5.0 / v5.1，请换成 driver/i2c.h 的 i2c_master_cmd_begin() 写法。 */

#define SHTC3_ADDR 0x70
#define SHTC3_WAKE 0x3517
#define SHTC3_SLEEP 0xB098
#define SHTC3_MEASURE 0x7866   /* 温度在前，时钟拉伸关闭 */

bool shtc3_read(float *temperature_c, float *humidity_pct)
{
    uint8_t cmd[2];
    uint8_t raw[6] = { 0 };

    cmd[0] = SHTC3_WAKE >> 8; cmd[1] = SHTC3_WAKE & 0xFF;
    if (i2c_master_transmit(dev, cmd, 2, 100) != ESP_OK) return false;
    vTaskDelay(pdMS_TO_TICKS(1));

    cmd[0] = SHTC3_MEASURE >> 8; cmd[1] = SHTC3_MEASURE & 0xFF;
    if (i2c_master_transmit(dev, cmd, 2, 100) != ESP_OK) return false;
    vTaskDelay(pdMS_TO_TICKS(13));            /* 最大转换时间 12.1 ms */

    if (i2c_master_receive(dev, raw, 6, 100) != ESP_OK) return false;

    uint16_t t_raw = (uint16_t)((raw[0] << 8) | raw[1]);
    uint16_t h_raw = (uint16_t)((raw[3] << 8) | raw[4]);
    *temperature_c = -45.0f + 175.0f * (float)t_raw / 65536.0f;
    *humidity_pct  = 100.0f * (float)h_raw / 65536.0f;

    cmd[0] = SHTC3_SLEEP >> 8; cmd[1] = SHTC3_SLEEP & 0xFF;
    i2c_master_transmit(dev, cmd, 2, 100);
    return true;
}
```

读完即休眠（`SHTC3_SLEEP`），否则传感器会持续耗电，一天几十次唤醒下差别可观。

### 11.7 上报遥测

```c
int inkpane_post_telemetry(float temp_c, float hum_pct, int battery_pct,
                           int battery_mv, int rssi, uint32_t uptime_s)
{
    cJSON *root = cJSON_CreateObject();
    cJSON_AddNumberToObject(root, "temperature", temp_c);
    cJSON_AddNumberToObject(root, "humidity", hum_pct);
    cJSON_AddNumberToObject(root, "batteryPercent", battery_pct);
    cJSON_AddNumberToObject(root, "batteryVoltage", battery_mv / 1000.0);
    cJSON_AddNumberToObject(root, "rssi", rssi);
    cJSON_AddStringToObject(root, "firmware", "0.1.0");
    cJSON_AddNumberToObject(root, "uptimeSeconds", uptime_s);
    char *payload = cJSON_PrintUnformatted(root);

    char url[192];
    snprintf(url, sizeof(url), "%s/api/device/telemetry", CONFIG_INKPANE_API_URL);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 5000,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "X-Device-Token", s_token);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, payload, strlen(payload));
    esp_err_t err = esp_http_client_perform(client);
    int status = err == ESP_OK ? esp_http_client_get_status_code(client) : -1;

    esp_http_client_cleanup(client);
    cJSON_free(payload);
    cJSON_Delete(root);
    return status;
}
```

### 11.8 主循环与深度休眠

```c
void app_main(void)
{
    /* 1. NVS 与板级初始化（e-paper、I2C、RTC、电源管理） */
    ESP_ERROR_CHECK(nvs_flash_init());
    board_init();
    inkpane_load_config();

    /* 2. 联网（失败直接休眠，保留上一屏） */
    bool online = wifi_connect(10000);
    if (!online) {
        inkpane_sleep(30);
    }

    /* 3. 拉屏：304 不重绘 */
    char *body = NULL;
    int status = inkpane_fetch_screen(&body);
    if (status == 200) {
        inkpane_render_from_json(body);   /* 内部完成 1-bit 渲染与刷屏 */
        free(body);
        save_str("last_ok", "1");
    }
    /* status == 304 或 -1：保持当前画面 */

    /* 4. 读传感器并上报（失败不影响显示） */
    float t = 0.0f, h = 0.0f;
    if (shtc3_read(&t, &h)) {
        inkpane_post_telemetry(t, h, battery_percent(), battery_millivolt(),
                               wifi_rssi(), (uint32_t)(esp_timer_get_time() / 1000000));
    }

    /* 5. 深度休眠，由 RTC 定时器唤醒 */
    inkpane_sleep(inkpane_refresh_minutes());
}

void inkpane_sleep(uint32_t minutes)
{
    esp_wifi_stop();
    esp_sleep_enable_timer_wakeup((uint64_t)minutes * 60ULL * 1000000ULL);
    /* 可选：拨轮按键唤醒 */
    esp_sleep_enable_ext1_wakeup(BUTTON_WAKE_PIN_MASK, ESP_EXT1_WAKEUP_ANY_LOW);
    esp_deep_sleep_start();
}
```

## 12. curl 调试示例

以下命令在服务所在机器上执行；`jq` 仅用于取字段，没有也可以直接看输出。

```bash
BASE=http://127.0.0.1:4000

# 1. 服务是否在线
curl -s "$BASE/api/health"

# 2. 从控制台「屏幕与设备 → 添加设备」复制令牌（只显示一次）
TOKEN=7f3a9c2e5b8d4a61c0f9e2d7b4a8c153

# 3. 拉取屏幕数据，同时保存响应头
curl -s -D headers.txt -o screen.json \
  -H "X-Device-Token: $TOKEN" \
  "$BASE/api/device/screen"

# 4. 取出 ETag（保留双引号）
ETAG=$(grep -i '^etag:' headers.txt | sed 's/^[Ee][Tt][Aa][Gg]: //' | tr -d '\r')
echo "$ETAG"

# 5. 带 If-None-Match 再请求一次，内容未变应返回 304
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Device-Token: $TOKEN" \
  -H "If-None-Match: $ETAG" \
  "$BASE/api/device/screen"
# 输出：304

# 6. 在控制台改一条待办/日程或布局，再请求会返回 200 与新 ETag
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Device-Token: $TOKEN" \
  -H "If-None-Match: $ETAG" \
  "$BASE/api/device/screen"
# 输出：200

# 7. 上报一次遥测
curl -s -X POST "$BASE/api/device/telemetry" \
  -H "X-Device-Token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"temperature":24.3,"humidity":46.8,"batteryPercent":87,"batteryVoltage":4.06,"rssi":-56,"firmware":"0.1.0","uptimeSeconds":182}'

# 8. 设备状态与令牌轮换在控制台「屏幕与设备」页完成；
#    轮换后旧令牌立即失效，再拉屏会返回 401。
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Device-Token: $TOKEN" \
  "$BASE/api/device/screen"
# 在控制台轮换后，这里输出：401
```

Windows PowerShell 下把 `curl` 换成 `curl.exe`，`grep`/`sed` 用 PowerShell 等价写法；
若只需要确认状态码，`curl.exe -s -o NUL -w "%{http_code}"` 即可。

## 13. 常见问题 FAQ

**Q1：设备一直返回 401。**

按顺序检查：NVS 里是否写入了令牌、请求头名是否为 `X-Device-Token`（不是
`Authorization`）、令牌是否被轮换过。轮换后旧令牌**立即**失效，这是最常踩的一脚。
另外确认 `api_url` 没有多写 `/api`（正确形态是 `http://<ip>:4000`，接口路径里已含 `/api`）。

**Q2：返回 304，但屏幕内容不该是最新的吗？**

`304` 表示服务端数据与上次一致，这是正常且省电的路径。若怀疑漏更新，先确认设备保存的
`ETag` 是**上次 200 响应头里的原值（含双引号）**；若把引号丢了，服务端会比较失败并
每次返回 `200`（表现为频繁刷新）。反过来，如果设备把 ETag 存成了 `now.time` 相关的值，
就会出现「该刷新时不刷新」。

**Q3：`weather` 是 `null`，或者 `stale: true`。**

设备的屏幕数据里天气**只会来自缓存**：`null` 表示天气模块被关闭或从未成功取数，
`source` 恒为 `cache`；`stale: true` 表示缓存已过期且后台刷新尚未成功，此时
`message` 会给出原因。设备应隐藏天气模块或只显示占位文字，不要显示 0 °C。
控制台的 `GET /api/weather` 还会出现 `source: "open-meteo"`（本次实时取数）与
`source: "fallback"`（从未成功过的占位快照），排查方向：本机能否访问
`api.open-meteo.com`、天气设置里的城市与经纬度是否已配置。

**Q4：屏幕上的时间差了 8 小时。**

设备端把 UTC 当成了本地时间。`now.time` 与 `now.dateLabel` 已按 `timezone`（默认
`Asia/Shanghai`）换算好，直接绘制即可；只有需要给 RTC 写时间时，才处理偏移。
反向的错法也存在：把 `now.iso` 直接塞进 RTC 而不做本地化，RTC 会走 UTC。

**Q5：局域网里连不上服务。**

三件事：服务是否以 `HOST=0.0.0.0` 启动（默认只听 `127.0.0.1`）、Windows 防火墙是否
放行 Node.js 的专用网络访问、设备与电脑是否在同一网段（很多校园网与访客 Wi-Fi 做了
客户端隔离，设备之间不可互访）。用手机浏览器打开 `http://<电脑IP>:4000/api/health`
可以快速分辨是服务问题还是网络问题。

**Q6：中文显示成方框或乱码。**

字库子集没有覆盖用到的字符。JSON 是 UTF-8，若按 GBK 解码会得到乱码；字库里缺字则
渲染为方框或空白。先打印收到的 `title` 的字节确认编码，再检查字库是否包含该码点
（生僻字、全角标点、间隔号最容易漏）。另外确认绘制时按 UTF-8 解码后再查表，
不要把 UTF-8 字节当成单字节字符逐个绘制。

**Q7：轮换令牌后设备失联。**

这是设计行为：控制台 `POST /api/devices/:id/rotate` 会让旧令牌立即失效。需要重新把新令牌
写入设备 NVS（串口命令或重新配网），设备下一次唤醒即可恢复。若设备已无法联网配置，
只能重新烧录带新令牌的固件。为避免这种情况，轮换前先确认能把新令牌送进设备。

**Q8：一天要唤醒多少次？会不会很耗电？**

按 `refreshMinutes = 30` 计算，一天约 48 次**联网**唤醒；时钟还需要独立的分钟级唤醒，
只做局部刷新。真正整屏刷新的通常只有个位数（跨天、日程变动、天气更新）。每次联网唤醒的
耗电主要来自 Wi-Fi 连接与 HTTP 往返，而不是刷新本身。想更省电：调大 `refreshMinutes`、
把遥测改为每 N 次唤醒上报一次、夜间降低时钟唤醒频率。

**Q9：屏幕上有残影怎么办。**

局部刷新累积所致。按第 9.4 节的策略插入全屏刷新；跨天后的第一次刷新做全刷效果最好。
低温环境下残影会更明显，属面板特性。

## 14. 相关文档

- [API 文档](API.md)：控制台使用的一般 REST 接口（分类、日程、统计、课程同步，以及
  待办、天气、屏幕布局、设备的完整字段说明）
- [架构说明](ARCHITECTURE.md)：后端分层、请求生命周期、错误体与数据库结构
- [项目 README](../../README.md)：产品定位、硬件平台规格与控制台能力
- [设备端目录](../../hardware/README.md)：固件开发计划与开发环境说明
- [微雪 ESP32-S3-ePaper-3.97 官方文档](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/)：
  原理图、规格书、示例固件与烧录方式
- [ESP-IDF 编程指南](https://docs.espressif.com/projects/esp-idf/zh_CN/latest/)：
  Wi-Fi、HTTP 客户端、深度休眠、NVS 与 I²C 驱动的权威说明
