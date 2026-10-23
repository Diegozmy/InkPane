# InkPane 固件说明

本文写给要改固件或排查设备问题的人。构建/烧录/配网的快速步骤见
[hardware/README](../README.md)。

## 1. 运行模型

固件没有常驻业务线程：每次唤醒跑完一轮就深睡，屏幕由墨水屏自身保持。

```
上电 / 定时唤醒 / 按键唤醒
  │
  ├─ NVS + board_init（I2C、AXP2101、PCF85063、SHTC3、按键）
  ├─ 读 RTC，判断是否需要联网
  │
  ├─ 需要联网 ──► Wi-Fi STA ──► GET /api/device/screen
  │                              ├─ 200：解析 → 全屏渲染 → 全刷 → 存 ETag
  │                              ├─ 304：用 Date 头校准 RTC → 局刷时钟
  │                              └─ 401：显示「令牌无效」，退避 6 小时
  │                             └─ 遥测 POST /api/device/telemetry
  │
  └─ 不需要联网 ──► 读 RTC → 只重画时钟矩形 → 局刷
  │
  ├─ 画状态角标（离线 / 令牌无效 / 低电）
  └─ EPD 休眠 → Wi-Fi 停止 → 定时器 + 按键唤醒 → deep sleep
```

### 双周期

- **时钟周期**：每分钟（`60 - 当前秒 + 1` 秒后）唤醒一次，只读 PCF85063、局刷
  `clock` 模块矩形，不联网。
- **网络周期**：按 `screen.refreshMinutes`（5–720，默认 30）。下一次唤醒取两者中较早者。
- **残影**：每 `CONFIG_INKPANE_FULL_REFRESH_INTERVAL`（默认 60）次局刷后，下一次联网
  跳过 `If-None-Match` 强制 200 并全屏刷新；跨天后的第一次 200 也会全刷。
- **低电**：电量低于 20% 时把联网间隔拉长到至少 120 分钟，并在时钟区右下角显示「低电」。
- **离线**：连续 3 次拉取失败显示「离线」，成功后自动清除；任何失败都不清屏。

### 冷启动与深睡

`esp_reset_reason()` 为 `ESP_RST_DEEPSLEEP` 时沿用 `RTC_DATA_ATTR` 里的状态
（下次联网时间、局刷计数、时钟矩形、失败次数）。上电、软件重启、看门狗重启都会重置状态，
并按冷启动处理：强制一次不带 ETag 的 200 + 全刷，避免「屏幕空白但服务端说没变」。

## 2. 板级与引脚

| 功能 | 引脚 / 参数 |
| --- | --- |
| EPD SPI | SCLK 11、MOSI 12、CS 10、DC 9、RST 46、BUSY 3；SPI3，20 MHz，mode 0 |
| I²C | SCL 42、SDA 41，400 kHz |
| AXP2101 | 地址 0x34；DC1/ALDO1/ALDO2 3.3 V；**ALDO3 是屏幕电源**，刷新时开、休眠时关 |
| PCF85063 | 地址 0x51；本地墙上时间（无时区） |
| SHTC3 | 地址 0x70；读后立即休眠 |
| 按键 | GPIO0（BOOT）、4、5、6，低有效；深睡用 EXT1 任一低唤醒 |
| 配网触发 | 上电时按住 GPIO5 两秒（GPIO0 是下载模式 strapping，不能用于上电长按） |

> 面板 CS 在整机上是常低的（与微雪 demo 一致），驱动里保持 CS 低电平。

## 3. 数据契约

固件只调用两个接口，字段与错误码以
[DEVICE-API.md](../../website/docs/DEVICE-API.md) 为准：

- `GET {api_url}/api/device/screen`
  - 请求头：`X-Device-Token`、`If-None-Match`（仅在 ETag 存在且非强制全刷时）
  - 记录响应头：`ETag`（含双引号，原样保存）、`Date`（用于 304 校时）
  - 状态：200 解析渲染；304 不解析；401 视为配置错误
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
- 局部刷新前把矩形按 8 px 对齐后打包，只发送该区域；全刷写 0x24 + 0x26 后 `0x22=0xF7`。

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
| `etag` | str | 原样保存的 ETag（含引号） |
| `tz_offset` | i32 | 用户时区偏移分钟，默认 480 |
| `refresh_min` | i32 | 5–720，默认 30 |
| `schema` | u8 | 预留 |

重新配网会先擦除整个 namespace，避免旧 ETag 让新服务返回 304。

## 6. 构建配置

- `main/partitions.csv`：NVS 24 KB、phy 4 KB、factory 6 MB、storage 1 MB。
- `main/sdkconfig.defaults`：16 MB flash、PSRAM OCT 80 MHz、240 MHz、自定义分区表、日志 INFO。
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
| 时钟不走 | PCF85063 的 OS 位（秒寄存器 bit7）是否被置位；首次联网会用 `now.localIso` 校准 |
| 中文方框 | 字库没覆盖该码点；用 `genfont.py` 扩充字符集后重新生成 |
| 局刷残影重 | 降低 `CONFIG_INKPANE_FULL_REFRESH_INTERVAL`；低温环境更明显，属面板特性 |
| 构建报 `No such file or directory` + `.obj.d` | 构建路径超过 260 字符；用 `build.ps1` 的 `%TEMP%` 短路径 |
| 构建卡住不动 | 后台构建把 stdout 接了管道时 ninja 可能挂起；重定向到日志文件（`build.ps1` 已处理） |

## 8. 已知限制

- 只支持简体中文与 GB2312 字符集；生僻字/emoji 会显示为空心方框。
- 只支持 `http://`，不含 TLS；设备与服务的信任边界仍是可信局域网。
- 不持久化帧缓冲：深睡后只有时钟区能局刷，整屏重绘必须等下一次 200。
- 没有 OTA、SD 卡、音频、QMI8658 手势；这些属于后续阶段。
- 真机上的局刷残影、低温响应与深睡电流尚未实测。
