# InkPane 固件说明

本文写给要改固件或排查设备问题的人。构建/烧录/配网的快速步骤见
[hardware/README](../README.md)，语音助手见 [VOICE.md](VOICE.md)。

## 0. 两种运行模式

`main/Kconfig.projbuild` 的 `INKPANE_POWER_MODE` 决定 `app_main` 走哪条路径：

- **RESIDENT（默认）**：常驻语音模式。Wi-Fi 与麦克风常开，`inkpane_voice` 运行
  OTA/激活、MultiNet 唤醒词、WebSocket 对话与 MCP 工具；主任务每 20 ms 轮询按键与
  语音事件，按 `refreshMinutes` 拉屏、每分钟局刷时钟。不进入深睡。联网后若 RTC 尚未
  校准，立刻在后台拉起 SNTP，失败每 60 s 补校（见「时间同步（SNTP）与 RTC」）。
- **LOW_POWER**：原「每分钟唤醒 + 深睡」看板；语音不初始化、不占用音频/AFE 资源
  （组件仍参与链接，以保留看板状态位接口）。下面第 1 节的流程描述的是这条路径；
  两条路径共享渲染、网络与配置代码。

常驻模式的页面切换：看板 ↔ 对话页（状态/识别文本/回复）↔ 激活页 ↔ 错误页。语音会话
期间暂停看板定时刷新，回到待命后停留约 6 秒再重绘看板（`RESIDENT_VOICE_LINGER_MS`）；
MCP 写入会清 ETag 并强制下一次拉屏。对话页不再整屏闪刷，见「对话页的损坏带局刷」。

### 时间同步（SNTP）与 RTC

激活/TLS 需要可信时钟，所以时间同步是语音的前置条件。旧实现是「一次性」的：
`esp_sntp_init()` 之后每 200 ms 轮询 `sntp_get_sync_status()`，超时就 `esp_sntp_stop()`。
四个问题叠加，开机约 9.5 s 常见 `W wifi: sntp sync timed out`：

- `sntp_get_sync_status()` 是**读清**的：轮询读到 `COMPLETED` 的同时就把它清掉了，
  真正的回调事件反而可能被轮询吞掉；
- `CONFIG_LWIP_SNTP_STARTUP_DELAY` 给首个请求加了随机 0–5 s 延迟，正好吃掉 5 s 的
  开机预算；
- 服务器不应答时 lwIP 要等 `SNTP_RECV_TIMEOUT`（15 s）才重试，远超等待窗口；
- 只配了 `ntp.aliyun.com` 一个服务器（DNS 抖动或丢一个 UDP 包就必然失败），而且每次
  超时都 `esp_sntp_stop()`，下一次又从零走一遍。

现在的实现（`components/inkpane_net/src/wifi.c`）改用 ESP-IDF 的 `esp_netif_sntp` 封装：

- 同步回调里 post 一个二值信号量，`esp_netif_sntp_sync_wait()` 等它，事件不会丢；
- 静态服务器表三家：`ntp.aliyun.com`、`ntp.tencent.com`、字面 IP `203.107.6.88`
  （DNS 本身坏掉时仍可用）；`sdkconfig.defaults` 里 `CONFIG_LWIP_SNTP_MAX_SERVERS=3`，
  编译期断言保证表长不超过它；
- 关掉 `CONFIG_LWIP_SNTP_STARTUP_DELAY`，首个请求立刻发出；
- 服务常驻，POLL 模式每小时重同步，不再 stop/deinit；`inkpane_wifi_disconnect()`
  也不停它（系统时钟已同步过，重连后下一次探测即可恢复）；
- 首次等待超时后 `esp_netif_sntp_start()` 立刻重发一次请求（先排空上一轮可能残留的
  信号量），再等 `timeout_ms/3`（钳在 500–1500 ms）；两次都超时才打
  `sntp sync timed out (will retry hourly in background)`，且每进程只打一次。

API 在 `inkpane_net.h`：`inkpane_time_valid()`（系统时钟是否已过 1700000000）、
`inkpane_time_sync_start()`（非阻塞、幂等，只拉起服务）、
`inkpane_wifi_sync_time(int)`（拉起并等待，成功返回 `ESP_OK`）。app_main 与语音任务会
在同一个开机窗口里调用，用静态 FreeRTOS 互斥锁串行化，避免两边抢
`esp_netif_sntp_init()`。SNTP 只负责把**系统时钟**设成 UTC；换算本地时间、写
PCF85063 是调用方的事（`utc_offset_minutes`）。

常驻模式的补校：Wi-Fi 起来后主循环每秒调用 `resident_time_tick()`，RTC 尚未校准时每
60 s `inkpane_time_sync_start()` 一次（非阻塞，20 ms 的 UI 循环不会被卡住）；等
`inkpane_time_valid()` 为真后，下一次 tick 再调 `resident_store_system_time_in_rtc()`
把系统时钟换算成本地时间写进 RTC（日志 `rtc calibrated from sntp: ...`）。语音初始化
成功后、语音任务启动前还有一次 5 s 的阻塞尝试（`resident_sync_time_to_rtc()`），那只是
优化：常驻模式不按定时重启，开机那次失败也不会永久失败。因此 RTC 校时**不再只有**看板
的 200/304 两条路径。

注意调用顺序：`resident_network_tick()`（看板 HTTP 拉取，200 的 `now_local` 会直接校准
RTC）先跑，`resident_time_tick()` 后跑。所以看板 200 成功时 RTC 已经被校准，常驻模式
一般不会再去启 SNTP——SNTP 在这里是看板路径失败（服务不可达、只监听回环、令牌失效）时
的**兜底**，以及语音侧 `ensure_time_ready()` 在访问 HTTPS OTA 前时间仍不可信时的补校。
两者一个成功就够了。

### 对话页的损坏带局刷

对话页每收到一次状态/文本变化，只重画**和屏上现有画面不同的水平带**，不再整屏闪刷。
依据是渲染缓冲 `s_framebuffer` 与「屏幕当前显示内容」的影子缓冲 `s_panel_frame`
（PSRAM 里多一份 `INKPANE_EPD_FB_SIZE`，即 800 × 480 的 1-bit 帧、48000 字节）逐行比较。

- 影子缓冲在每次全刷成功、每次带区局刷成功后整体更新；时钟矩形局刷成功后也把该矩形
  抄进影子缓冲（否则下一轮会把陈旧的时钟像素当成损坏）。任何一次面板写入失败（画面
  可能是「写了一半」的）都会把影子标记为无效，下一次强制全刷。
- 比较函数是 `components/inkpane_epd/src/frame_diff.c` 的
  `inkpane_frame_diff_bands()`：1-bit 帧缓冲、逐行 `memcmp`，把连续脏行并成一条带，
  间距小于合并间隙的两条带合成一条（一条带 = 一次硬件复位 + 一次窗口刷新，吸收几行
  干净行比多开一个窗口便宜）。全宽窗口按字节对齐，所以带总是整宽。
- 预算（`app_main.c` 的 `INKPANE_PARTIAL_*`）：最多 **3 条带**、覆盖行数最多 **340 行**、
  合并间隙 **12 行**。超预算、影子无效、页面刚进入时一律走全刷。12 行是按对话页的文本块
  间距挑的（见 `app_main.c` 里 `INKPANE_PARTIAL_MAX_BANDS` 上方的注释）：状态标签与
  「你的话」之间约 22 行干净行，不会被并成一条带；「你的话」与回复之间只隔几行，会被
  并进同一条带——一条带要付一次硬件复位 + 一次窗口刷新，多吸收几行干净行更划算。
- 累计 `RESIDENT_VOICE_FULL_EVERY`（**40**）次带区局刷后，下一次对话页更新强制全刷去残影；
  无可见变化的那次不计数，而 diff 自己回落的整屏刷新会把计数清零。
- 局部窗口每次都会硬件复位控制器（厂商行为），寄存器配置因此失效：驱动用 `s_config_stale`
  标记，跨深睡则靠持久化的 `panel_needs_init`，下一次全刷先跑 `panel_init()` 再写帧。

为什么以前不行：早期「大窗口局刷出来是空白/只更新一半」的根因不在「局刷不可靠」，而在
`epd.c` 的窗口编程——每次局刷前缺少硬件复位（厂商 `EPD_Display_Partial` 会先 `EPD_Reset()`），
控制器内部 Y 地址状态是上一轮的，内容就落在请求原点的下方；以及 `0x45/0x4F` 发的是可见 Y
（面板栅极自下而上，RAM Y 是镜像的）。三处分别在 `1a2496a`（补硬件复位）、`5d154c4`
（`0x45` 改 Ystart/Yend 顺序）、`23cbf58`（按栅极顺序镜像 Y）修掉。修完后任意高度的
带区窗口才是安全的，也才谈得上按带刷新。

重绘节流从 1500 ms 降到 **700 ms**（`RESIDENT_VOICE_RENDER_MS`）：带区刷新是几百毫秒
量级而不是整屏几秒的闪刷，文本能更贴近实时。host 模拟器上（真实渲染器 + 真实 diff）的
典型值：状态标签变化 = 1 条带，约 30 行；回复多出一行 = 1–2 条带，约 30–60 行；
一轮里状态和回复同时变（`app_main.c` 预算注释按真实字高估算）= 2 条带、约 294 行，
仍在预算内；整轮都变（新问题 + 新回答 + 状态）= 3 条带、约 370 行，超过 340 行预算，
于是回落全刷——正好每轮一次，同时充当那次去残影。

## 1. 运行模型（LOW_POWER）

固件没有常驻业务线程：每次唤醒跑完一轮就深睡，屏幕由墨水屏自身保持。

```
上电 / 定时唤醒 / 按键唤醒
  │
  ├─ NVS + board_init（I2C、AXP2101、PCF85063、SHTC3、按键）
  ├─ 从 RTC 快照重建 s_screen（按键放大可离线渲染）
  ├─ 读 RTC，判断是否需要联网
  │
  ├─ 按键唤醒且仍按住滚轮键 ──► 本地渲染放大/总览视图（网络到期时才联网）
  │
  ├─ 需要联网 ──► Wi-Fi STA ──► GET /api/device/screen
  │                              ├─ 200：解析 → 全屏渲染 → 全刷；只有刷屏成功才存 ETag/间隔/时区，
  │                              │        并捕获 RTC 快照供下次按键唤醒离线放大
  │                              │        刷屏或解析失败：fail_count++、清空 ETag、提前返回
  │                              ├─ 304：用 Date 头校准 RTC → 低电拉长间隔 → 局刷时钟
  │                              └─ 401：显示「令牌无效」，退避 6 小时
  │                             └─ 遥测 POST /api/device/telemetry
  │
  └─ 不需要联网 ──► 读 RTC → 只重画时钟矩形 → 局刷
  │
  ├─ 画状态角标（离线 / 令牌无效 / 低电）
  └─ Wi-Fi 停止 → 定时器 + 按键唤醒 → 深睡（ALDO3 保持供电，面板控制器不复位）
```

### 双周期

- **时钟周期**：每分钟（`60 - 当前秒 + 1` 秒后）唤醒一次，只读 PCF85063、局刷
  `clock` 模块矩形，不联网。深睡期间 ALDO3 保持供电，面板控制器 RAM 与图像保留；
  每次局刷沿用厂商驱动的硬件复位（只清寄存器、不闪屏），所以下一次全刷会先重新
  `panel_init`。这个「配置已失效」标记同时持久化到 RTC RAM，跨深睡仍然有效。
- **网络周期**：按 `screen.refreshMinutes`（5–720，默认 30）。下一次唤醒取两者中较早者。
- **残影**：每 `CONFIG_INKPANE_FULL_REFRESH_INTERVAL`（默认 60）次局刷后，下一次联网
  跳过 `If-None-Match` 强制 200 并全屏刷新；跨天后的第一次 200、以及非 warm（冷启动）
  唤醒的第一次 200 也会全刷。
- **低电**：电量低于 20% 时把联网间隔拉长到至少 120 分钟，并在时钟区右下角显示「低电」；
  该调整对 200 与 304 两条路径都执行。
- **离线**：连续 3 次拉取失败显示「离线」，成功后自动清除；任何失败都不清屏。
- **失败重试**：拉取 / 解析 / 刷屏失败后按 60 s × 失败次数退避，上限 10 分钟或
  `screen.refreshMinutes`；RTC 未校准时深睡时长直接用这个退避值（不再固定睡满刷新间隔），
  所以服务端修好后一分钟内就能恢复。
- **失败提示页**：冷启动或 RTC 未校准期间失败，会整屏绘制「无法连接日程服务 / 设备令牌无效」，
  含本机 IP、服务地址与重试提示；已有可信画面时只局刷时钟，不清屏。

### 按键放大（RTC 快照）

滚轮三向键用于切换视图，全部走本地渲染、不联网：

- **GPIO 4 / 6**：在已启用模块之间循环（总览时按 4 跳到最后一个模块，按 6 跳到第一个）。
- **GPIO 5**：总览 ↔ 第一个已启用模块之间切换。
- 按键是深睡唤醒源，唤醒后要**继续按住约一秒**：`detect_pressed_button()` 在启动约
  80 ms 后采样，按得太快会判成普通唤醒并走联网刷新。按下后屏幕刷新完成再松手即可。

视图数据来自 RTC 慢内存里的 `inkpane_snapshot_t`（约 4.8 KB，
`components/inkpane_model/src/snapshot.c`）：每次 200 且全刷成功后捕获一次浓缩快照
（模块矩形、事件/课程标题与开始时间、待办、月历、天气），唤醒后由
`inkpane_snapshot_restore()` 重建可渲染的 `s_screen`。因此按键翻页不依赖 PSRAM 里的
上一次启动残留（深睡后 PSRAM 内容不可信），离线也能放大。没有快照时（首次运行、刚配网、
固件升级后 ETag 还在）按键回落到联网刷新；304 且快照缺失时会清空 ETag，下一次强制 200
重建快照。

快照带 FNV-1a 校验和：RTC 内存没有保持或内容损坏时 `inkpane_snapshot_valid()` 直接失败，
`restore` 返回清零后的屏幕，按键回落到联网刷新，**不会**把损坏内容画成「负数 + 方框」乱码页。
月历 `mark_count` / 天气 `forecast_count` 在捕获与还原时按数组上界钳制，渲染器里也有同样的
上限保护，避免异常计数让循环跑满触发看门狗。

### 串口调试会话（按键诊断）

深睡会切断 USB CDC，串口监视器随之掉线，排查按键问题时用驻留调试会话：

- **进入**：上电时按住滚轮「下」键（GPIO 6）约 2 秒；或在深睡时**按住 BOOT（GPIO 0）唤醒**。
  设备照常完成一次联网刷新（保证 RTC 快照就绪），然后**保持唤醒**并轮询按键。
- **操作**：滚轮上/下/中直接切换视图，每一步打印
  `zoom: gpio=4 0 -> 5 (enabled=0x3f, snapshot=1)` 与 `DEBUG gpio=4 handled=1 zoomed=5 ...`。
- **退出**：长按 BOOT 3 秒回到深睡；或静置 5 分钟自动深睡；复位/断电亦可。
- 读日志：`enabled=0x??` 是已启用模块位图；`enabled=0x01` 表示控制台只启用了一个模块，
  上/下键没有可切换目标（固件会跳过这次刷新，不再空闪）；`snapshot=0` 表示快照无效、
  本次按键回落到联网刷新。

### 冷启动、热面板与深睡

`esp_reset_reason()` 为 `ESP_RST_DEEPSLEEP` 且 `s_persist.panel_warm` 为真时走**热面板**
路径：`inkpane_epd_init(true)` 只重建 SPI/GPIO，跳过 `hardware_reset()` 与 `panel_init()`；
深睡期间 ALDO3 未断电，控制器保留 RAM 与配置，可直接局刷时钟。

局刷（`show_region()`）每次都会硬件复位控制器，寄存器配置因此失效；驱动用静态
`s_config_stale` 标记，但它跨深睡会丢失。`s_persist.panel_needs_init` 把这个标记持久化到
RTC RAM：下一次热启动时调用 `inkpane_epd_mark_config_stale()` 重新武装驱动，保证之后
第一次全刷（`full_refresh()`）先执行 `panel_init()`；只有全刷成功后才清除该标记。

上电、软件重启、看门狗重启都会重置状态并按**冷启动**处理：`inkpane_epd_init(false)`
重新复位并初始化面板，并强制一次不带 ETag 的 200 + 全刷，避免「屏幕空白但服务端说没变」。
`go_to_sleep()` 不再调用 `inkpane_epd_sleep()`，也不切断 ALDO3。`RTC_DATA_ATTR` 里保存
下次联网时间、局刷计数、时钟矩形、失败次数、重试间隔、`panel_warm` 与
`panel_needs_init`。

## 2. 板级与引脚

| 功能 | 引脚 / 参数 |
| --- | --- |
| EPD SPI | SCLK 11、MOSI 12、CS 10、DC 9、RST 46、BUSY 3；SPI3，20 MHz，mode 0 |
| I²C | SCL 42、SDA 41，400 kHz |
| AXP2101 | 地址 0x34；DC1/ALDO1/ALDO2 3.3 V；**ALDO3 是屏幕电源**，冷启动初始化时开，深睡期间保持供电（面板 warm），仅在配网/拆机等 teardown 时才关 |
| PCF85063 | 地址 0x51；本地墙上时间（无时区）；OS 位保留，未校时前 `time_valid()` 返回 false；常驻模式由 SNTP、LOW_POWER 模式由 200/304 校准并清 OS |
| SHTC3 | 地址 0x70；读后立即休眠 |
| 按键 | GPIO0（BOOT）、4、5、6，低有效；深睡用 EXT1 任一低唤醒；4/6 = 上一个/下一个模块，5 = 放大 ↔ 总览 |
| 配网触发 | 上电时按住 GPIO5 两秒（GPIO0 是下载模式 strapping，不能用于上电长按） |

> 面板 CS 在整机上是常低的（与微雪 demo 一致），驱动里保持 CS 低电平。

## 3. 数据契约

固件只调用两个接口，字段与错误码以
[DEVICE-API.md](../../website/docs/DEVICE-API.md) 为准：

- `GET {api_url}/api/device/screen`
  - 请求头：`X-Device-Token`、`If-None-Match`（仅在 ETag 存在且非强制全刷时）
  - 记录响应头：`ETag`（含双引号，原样保存，**仅在全刷成功后写入**）、`Date`（用于 304 校时）
  - 状态：200 解析渲染；304 不解析；401 视为配置错误
  - 事件数组上限 32 / 课程 16 / 待办 8；`eventTotal` / `courseTotal` / `todoTotal`
    是服务端真实总数，缺失时回落数组长度（实现见 `inkpane_model`），界面用总数显示
    「N 项」与「还有 N 项」
- `POST {api_url}/api/device/telemetry`
  - 字段：`temperature / humidity / batteryVoltage / batteryPercent / rssi / firmware / uptimeSeconds`
  - 服务端是 `.strict()`，不要多发字段；没有的字段直接省略

解析器是 `components/inkpane_model/src/json.c`，不带第三方依赖；所有节点和字符串都从
1 MB PSRAM arena 分配，解析完即可复用（HTTP body 上限 512 KB）。

## 4. 渲染与字库

- 画布：800 × 480，1 bit，1 = 白、0 = 黑；stride 100 字节。
- 六个模块按 `screen.layout.modules` 的矩形绘制，坐标是 4 的倍数；模块内留 6 px 边距，
  文本按像素宽度截断并追加 `…`。
- 字库：`components/inkpane_ui/fonts/inkpane_fonts.bin`，由 `tools/genfont.py` 从
  **Noto Sans SC**（OFL）生成，覆盖 GB2312 6763 字 + ASCII + 中文标点，16/24/32 px 三档。
  单字为按行打包的 1-bit 位图，索引按码点二分查找；缺字画空心方框。
- 时钟数字用字库里的 `digit_advance` 做等宽排版，避免分钟跳动时整行左右晃。
- 局部刷新前把矩形按 8 px 对齐后打包，只发送该区域；与厂商驱动一致，局刷发送前会
  硬件复位控制器（面板图像保留、不黑闪），但会清掉寄存器配置，所以下一次全刷必须先
  重新 `panel_init`（`show_region()` 把窗口按 RAM 镜像发送：`0x45` 写
  `HEIGHT-1-y .. HEIGHT-y-height`）。全刷写 0x24 + 0x26 后 `0x22=0xF7`，且写 RAM 前
  用 `set_full_window()` 恢复整屏窗口与光标。
- 常驻模式的对话页不用矩形局刷，而是「损坏带」局刷：整宽的水平带（`frame_diff` 计算，
  见第 0 节「对话页的损坏带局刷」），每带一次 `show_region()`。
- 非 warm（冷启动）时强制全刷：只有全刷才会把控制器 RAM 与 framebuffer 对齐。

重新生成字库：

```powershell
python hardware/tools/genfont.py --font C:/Windows/Fonts/NotoSansSC-VF.ttf `
  --out hardware/main/components/inkpane_ui/fonts/inkpane_fonts.bin
```

脚本是确定性的；改字号、字重或字符集后重新生成并提交 bin。不要手工编辑二进制。

## 5. NVS

namespace `inkpane`：

| key | 类型 | 说明 |
| --- | --- | --- |
| `ssid` / `pass` | str | Wi-Fi |
| `api_url` | str | `http://<host>:<port>`，末尾不要带 `/api` |
| `token` | str | 32 位十六进制设备令牌 |
| `etag` | str | 原样保存的 ETag（含引号）；刷屏/解析失败时清空，强制下次 200 |
| `tz_offset` | i32 | 用户时区偏移分钟，默认 480 |
| `refresh_min` | i32 | 5–720，默认 30 |
| `schema` | u8 | 预留 |

重新配网会先擦除整个 namespace，避免旧 ETag 让新服务返回 304。

## 6. 构建配置

- `main/partitions.csv`：NVS 24 KB、phy 4 KB、factory 6 MB、storage 1 MB。
- `main/sdkconfig.defaults`：16 MB flash、PSRAM OCT 80 MHz、240 MHz、自定义分区表、日志 INFO。
  其中 `CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER_NUM=16` 在 ESP-IDF v6.0.2 下会被 kconfgen 归入
  「Disabled Symbols/Choices With User-Set Value」而回落默认值，属于已知的 v6.1↔v6.0.2
  配置漂移，不影响构建与运行，暂不改配置。
  SNTP 相关的两项是 `CONFIG_LWIP_SNTP_MAX_SERVERS=3`（够放三家服务器）和显式关掉
  `CONFIG_LWIP_SNTP_STARTUP_DELAY`（不要随机 0–5 s 启动延迟）。`sdkconfig` 是生成文件且
  已 gitignore，但构建实际读它，所以同样应用了这两项。
- `main/main/Kconfig.projbuild`：默认 API 地址、默认令牌、AP 前缀、全刷间隔、遥测开关。
- 字库 bin 通过组件的 `EMBED_FILES` 编进固件（约 1.9 MB），因此 app 分区必须 ≥ 4 MB。

## 7. 排障

| 现象 | 排查 |
| --- | --- |
| 屏幕全白 / 无反应 | 3.3 V 与 ALDO3 是否正常；SPI 引脚；BUSY 是否一直高（面板未接好）；串口是否有 `epd init failed` |
| 开机就进配网 | NVS 里没有 `ssid`/`token`/`api_url`；或上电时 GPIO5 被按住 |
| 一直 401 | 令牌被轮换/写错；控制台重新添加设备并配网。令牌轮换后旧令牌立即失效 |
| 一直 304 但内容旧 | ETag 被写坏（缺引号会一直 200，不是 304）；重新配网清空 ETag |
| 返回 200 但白屏 | 解析失败看串口 `payload parse failed`；检查服务端是否返回 `{data:...}` |
| 时钟不走 | PCF85063 的 OS 位（秒寄存器 bit7）是否被置位；固件保留该位，未校时前显示「等待校时」。校准来源有三种：常驻模式的 SNTP（`rtc calibrated from sntp`）、LOW_POWER 模式 200 的 `now.localIso`、304 的 `Date` 头；任一成功都会清 OS |
| 开机一直显示「等待校时」/ 时间从 2000 年开始 | OS 位为 1 且还没有成功校准过；看板模式下检查网络与令牌，200/304 任一成功路径都会写 RTC；常驻模式还会在后台走 SNTP（`sntp service started (3 servers)` → `sntp synced:` → `rtc calibrated from sntp`），串口没有这几行说明 Wi-Fi 没通或 NTP 出网被拦；屏幕上的失败提示页会给出本机 IP 与服务地址 |
| 串口反复出现 `W wifi: sntp sync timed out` | 旧版本每次超时都会打；新版本每进程最多打一次，且只在「首次等待 + 一次立即重试」都失败之后。看到它说明三家服务器在这段时间都不通（UDP 123 被防火墙拦、AP 隔离、DNS + 字面 IP 都不通）。服务仍在 POLL 模式后台每小时重试，时钟会自己收敛；长期不收敛就检查出网 |
| 对话页某条带更新后位置偏移/出界 | 带区窗口同样走 `show_region()` 的 Y 镜像；检查带坐标是可见行而不是 RAM 行，以及局刷前是否做了硬件复位。带来自 `frame_diff`，`y/height` 都是可见坐标 |
| 深睡唤醒后整屏黑闪、重新全刷 | 说明走了非 warm 冷初始化；检查 ALDO3 是否在深睡时掉电、`panel_warm` 是否丢失（看串口日志） |
| 分钟级局刷把时钟画到待办区、屏幕下缘（甚至只剩字头） | 这块 800×480 面板是 **SSD1677**，栅极线是自下而上接的，控制器 RAM 的 Y 与可见画面上下镜像：可见第 `y` 行对应 RAM 第 `HEIGHT-1-y` 行。配合数据进入模式 `0x11=0x01`（X 增、Y 减），局刷窗口必须按镜像后的 RAM 坐标发送：`0x45` 先发 `HEIGHT-1-y`、再发 `HEIGHT-y-height`，`0x4F` 设为 `HEIGHT-1-y`。直接发可见坐标 `y..y+height-1` 会让扫描越过 RAM 第 0 行后从底部回卷，刷新带就跑到屏幕下缘。已在 `epd.c` 的 `show_region()` 按此修正（与 GxEPD2 的 800×480 SSD1677 驱动 `GxEPD2_426_GDEQ0426T82` 一致）；`set_full_window()` 本就是 `HEIGHT-1..0` 的镜像窗口，保持不变。刷入后冷启动全刷会清掉残留错位内容 |
| 局刷之后按键放大/翻页画面错乱、多帧叠影、停在旧画面 | 局刷（`show_region`）会把 SSD1677 的 RAM 窗口 `0x44/0x45` 与光标 `0x4E/0x4F` 设成时钟矩形；全刷若直接写 48000 字节，会全部绕进那个小窗口，大块区域保持旧画面。已在 `epd.c` 让 `inkpane_epd_show_full()` 在写 RAM 前调用 `set_full_window()` 恢复整屏窗口与光标（`panel_init` 也复用同一函数）。刷入后冷启动一次即可恢复干净画面 |
| 刷屏失败后持续收到 200 | 属预期：全刷/解析失败会清空已存 ETag，下一次强制全量重取重绘 |
| 滚轮按键没反应 / 不能放大 | 唤醒后要按住约 1 秒；串口看 `zoom snapshot restored` 与 `zoom view N via gpio X`。若看到 `zoom snapshot empty`，说明还没有成功 200，先让设备联网拉一次屏幕；若按键被判为普通唤醒（无 `zoom view` 行），通常是松手太快 |
| 按键放大显示乱码（负数、方框） | 几乎都是烧到了旧固件：`hardware/main/build/` 是历史的本地构建目录（已 gitignore），那里的产物不带 RTC 快照。用 `build.ps1 -Flash` 烧 `%TEMP%\inkpane-build` 的固件；新固件启动日志有 `zoom snapshot ...` 一行，旧固件没有。新固件即使 RTC 快照损坏也会因校验和失败回落联网，不会画出乱码页 |
| 中文方框 | 字库没覆盖该码点；用 `genfont.py` 扩充字符集后重新生成 |
| 局刷残影重 | 降低 `CONFIG_INKPANE_FULL_REFRESH_INTERVAL`；低温环境更明显，属面板特性 |
| 构建报 `No such file or directory` + `.obj.d` | 构建路径超过 260 字符；用 `build.ps1` 的 `%TEMP%` 短路径 |
| 构建卡住不动 | 后台构建把 stdout 接了管道时 ninja 可能挂起；重定向到日志文件（`build.ps1` 已处理） |

## 8. 已知限制

- 只支持简体中文与 GB2312 字符集；生僻字/emoji 会显示为空心方框。
- 只支持 `http://`，不含 TLS；设备与服务的信任边界仍是可信局域网。
- 不持久化帧缓冲：深睡期间画面由面板自身保持，MCU 只在 RTC 慢内存保留一份约 4.9 KB 的
  浓缩快照，用于按键唤醒后离线切换放大视图（总览 + 六个模块页）；新数据仍必须等下一次 200。
- 深睡期间 ALDO3 保持供电以支持 warm 局刷，待机电流会高于「彻底断电面板」的方案；
  实际数值需上真机测量。
- 没有 OTA、SD 卡、音频、QMI8658 手势；这些属于后续阶段。
- 真机上的局刷残影、低温响应与深睡电流尚未实测。
