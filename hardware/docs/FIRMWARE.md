# InkPane 固件说明

本文写给要改固件或排查设备问题的人。构建/烧录/配网的快速步骤见
[hardware/README](../README.md)，语音助手见 [VOICE.md](VOICE.md)。

## 0. 两种运行模式

`main/Kconfig.projbuild` 的 `INKPANE_POWER_MODE` 决定 `app_main` 走哪条路径：

- **RESIDENT（默认）**：常驻语音模式。Wi-Fi 与麦克风常开，`inkpane_voice` 运行
  OTA/激活、MultiNet 唤醒词、WebSocket 对话与 MCP 工具；主任务每 20 ms 轮询按键与
  语音事件，按 `refreshMinutes` 拉屏、每分钟局刷时钟。不进入深睡。
- **LOW_POWER**：原「每分钟唤醒 + 深睡」看板；语音不初始化、不占用音频/AFE 资源
  （组件仍参与链接，以保留看板状态位接口）。下面第 1 节的流程描述的是这条路径；
  两条路径共享渲染、网络与配置代码。

常驻模式的页面切换：看板 ↔ 对话页（状态/识别文本/回复）↔ 激活页 ↔ 错误页。语音会话
期间暂停看板定时刷新，回到待命 3 秒内重绘看板；MCP 写入会清 ETag 并强制下一次拉屏。

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
  `clock` 模块矩形，不联网。深睡期间 ALDO3 保持供电，面板控制器 RAM/寄存器不复位，
  因此局刷不会触发硬件复位或黑闪。
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

上电、软件重启、看门狗重启都会重置状态并按**冷启动**处理：`inkpane_epd_init(false)`
重新复位并初始化面板，并强制一次不带 ETag 的 200 + 全刷，避免「屏幕空白但服务端说没变」。
`go_to_sleep()` 不再调用 `inkpane_epd_sleep()`，也不切断 ALDO3。`RTC_DATA_ATTR` 里保存
下次联网时间、局刷计数、时钟矩形、失败次数、重试间隔与 `panel_warm`。

## 2. 板级与引脚

| 功能 | 引脚 / 参数 |
| --- | --- |
| EPD SPI | SCLK 11、MOSI 12、CS 10、DC 9、RST 46、BUSY 3；SPI3，20 MHz，mode 0 |
| I²C | SCL 42、SDA 41，400 kHz |
| AXP2101 | 地址 0x34；DC1/ALDO1/ALDO2 3.3 V；**ALDO3 是屏幕电源**，冷启动初始化时开，深睡期间保持供电（面板 warm），仅在配网/拆机等 teardown 时才关 |
| PCF85063 | 地址 0x51；本地墙上时间（无时区）；OS 位保留，未校时前 `time_valid()` 返回 false |
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
- 局部刷新前把矩形按 8 px 对齐后打包，只发送该区域；局刷**不发送硬件复位、不重新
  `panel_init`**，依赖 warm 面板保留的控制器状态。全刷写 0x24 + 0x26 后 `0x22=0xF7`。
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
| 时钟不走 | PCF85063 的 OS 位（秒寄存器 bit7）是否被置位；固件保留该位，未校时前显示「等待校时」，联网后由 `now.localIso` 或 `Date` 头校准并清 OS |
| 开机一直显示「等待校时」/ 时间从 2000 年开始 | OS 位为 1 且还没有成功校准过；检查网络与令牌，200/304 任一成功路径都会写 RTC；屏幕上的失败提示页会给出本机 IP 与服务地址 |
| 深睡唤醒后整屏黑闪、重新全刷 | 说明走了非 warm 冷初始化；检查 ALDO3 是否在深睡时掉电、`panel_warm` 是否丢失（看串口日志） |
| 分钟级局刷把时钟画到别的区域（例如待办下方） | SSD1683 的 `0x45` 必须按 **Ystart, Yend** 顺序发送（datasheet 与官方 Arduino 示例一致）。原实现按 Yend,Ystart 发送，控制器解出反向窗口，整条刷新带被镜像到下半屏（实测落在 y≈480-116 = 364 处）。已在 `epd.c` 修正；刷入后冷启动全刷会清掉残留的错位内容 |
| 局刷之后按键放大/翻页画面错乱、多帧叠影、停在旧画面 | 局刷（`show_region`）会把 SSD1683 的 RAM 窗口 `0x44/0x45` 与光标 `0x4E/0x4F` 设成时钟矩形；全刷若直接写 48000 字节，会全部绕进那个小窗口，大块区域保持旧画面。已在 `epd.c` 让 `inkpane_epd_show_full()` 在写 RAM 前调用 `set_full_window()` 恢复整屏窗口与光标（`panel_init` 也复用同一函数）。刷入后冷启动一次即可恢复干净画面 |
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
