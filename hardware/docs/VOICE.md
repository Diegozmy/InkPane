# InkPane 语音助手

本文说明墨窗的语音助手：怎么配置、怎么用、怎么排障，以及真机验收清单。
语音栈参考 [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32)（MIT），
固件通过小智 WebSocket 协议连接语音服务，并用 MCP 工具修改 InkPane 的日程与待办。

## 1. 能力与限制

| 能力 | 说明 |
| --- | --- |
| 常驻唤醒 | 设备保持唤醒，Wi-Fi 与麦克风常开；默认唤醒词拼音 `da fen qi`（达芬奇） |
| 自定义唤醒词 | 控制台或配网页填写，1–8 条拼音音节（小写、空格分隔、无声调）；由 ESP-SR MultiNet 运行时命令词实现 |
| 对话 | 唤醒后自动聆听；BOOT 短按=按住说话/停止/打断；长按 BOOT 3 秒=唤醒词静音 |
| 屏幕 | 对话中显示状态、你的话和回复；局刷只重画变化的损坏带，重绘节流 700 ms；未激活时显示 6 位激活码 |
| 语音控制 | 新增/取消日程、新增/完成/删除待办、查询今天安排、刷新屏幕、调音量 |
| 看板 | 语音不可用时看板照常工作；`refreshMinutes` 到点拉屏、每分钟局刷时钟不变 |
| 隐私 | 唤醒前后音频不上传、不落盘；没有「常驻录音」文件；不需要时可在控制台关闭语音 |

已知限制：

- 本板单麦克风、没有回放参考通道，**硬件 AEC 不可用**。默认播放回复时关闭唤醒词检测，
  用 BOOT 打断；开启 `CONFIG_INKPANE_VOICE_WAKE_DURING_PLAYBACK` 可能被喇叭回声自触发。
- MultiNet 只识别模型词表能解码的中文短语；任意生僻短语不保证识别。未被识别的词会
  回退默认词并打日志，请按第 5 节逐词验收。
- 常驻监听功耗远高于深睡看板（预计 100–200 mA 量级），建议 USB 供电；电池供电时
  把 `CONFIG_INKPANE_POWER_MODE` 切到 `LOW_POWER` 可编译回原深睡看板（语音不初始化）。
- InkPane 只支持 WebSocket；语音服务只返回 MQTT 配置时会报错，不会静默降级。

## 2. 首次配置

1. **配网**：上电时按住滚轮中键 2 秒（或首次无配置）进入 `InkPane-XXXXXX` 热点，
   浏览器打开 `http://192.168.4.1`，填写 Wi-Fi、控制台服务地址、设备令牌；同页可填
   语音 OTA 地址、唤醒词、灵敏度、音量，或先留空（之后在控制台改）。
2. **控制台**：`屏幕与设备 → 语音助手` 打开「启用语音助手」，确认/修改 OTA 地址
   （默认 `https://api.tenclass.net/xiaozhi/ota/`），保存。设备下一次拉屏后生效。
   修改「启用开关」或「OTA 地址」后设备会自动重启一次以重新初始化音频/激活；
   唤醒词、灵敏度、音量、允许控制会即时生效，无需重启。
3. **激活**：设备屏幕显示 6 位激活码与 `xiaozhi.me`；在 xiaozhi.me 登录并输入激活码
   绑定设备。绑定成功后设备自动进入「待命」，无需重启。
4. **自建服务**：把 OTA 地址改成自建 `xiaozhi-esp32-server` 的 OTA 地址（局域网通常
   是 `http://<主机>:<端口>/xiaozhi/ota/`），重新配网/等待拉屏，激活流程由该服务决定。

> 激活依赖 TLS 证书校验，因此设备必须先有有效时间。看板走明文 HTTP，拉一次成功后
> 用 `localIso`/`Date` 头校准 RTC；语音侧在访问 HTTPS OTA 前会先确认时间（不够新就直接
> 走 SNTP），两者都失败时语音显示「网络未连接/时间未校准」，看板继续工作并周期重试。
>
> 常驻模式的 SNTP 不是一次性的：RTC 未校准时联网后后台就拉起服务，启动日志先有
> `sntp service started (3 servers)`（`ntp.aliyun.com`、`ntp.tencent.com` 与字面 IP
> `203.107.6.88` 兜底 DNS），成功后有 `sntp synced: <epoch>`，随后是
> `rtc calibrated from sntp: ...`。首次等待 + 一次立即重试都失败才会打
> `sntp sync timed out (will retry hourly in background)`，且每进程只打一次；服务继续按
> 小时重同步，主循环也每 60 s 在 RTC 未校准前补一次（非阻塞，不卡 UI）。所以开机那次
> 没同步上也不会永久失败，只是校准要等下一次后台重试。
>
> 注意 SNTP 是**兜底**：主循环先跑看板 HTTP 拉取，200 的 `now_local` 会直接校准 RTC；
> 只有看板路径失败（服务不可达、令牌失效等）时 SNTP 才真正被需要。语音侧在访问 HTTPS
> OTA 前也会自己确认时间（`ensure_time_ready()`，不够新就同步一次）。

## 3. 使用

| 操作 | 行为 |
| --- | --- |
| 说唤醒词 | 开始一轮对话（自动聆听，服务端判断说话结束） |
| BOOT 短按（待命） | 按住说话（手动模式，再按停止） |
| BOOT 短按（聆听/回答） | 停止聆听 / 打断回答 |
| BOOT 长按 3 秒 | 切换唤醒词静音（屏幕时钟状态显示「语音静音」） |
| 滚轮 4 / 6 | 看板：上一个 / 下一个模块放大 |
| 滚轮 5 | 看板：总览 ↔ 首个模块；激活页：返回看板 |
| 冷启动按住滚轮 5 | 重新配网 |

对话超时：聆听/思考 20 秒无消息、回答 60 秒未结束会自动收尾回待命；服务端 120 秒
无消息也会关闭通道。

## 4. 语音控制（MCP）

设备向小智注册以下工具；`屏幕与设备 → 语音助手 → 允许语音修改日程与待办` 关闭时只保留
只读工具。

| 工具 | 例子 |
| --- | --- |
| `self.inkpane.context.get` | 「今天有什么安排？」（读取当前时间/时区/今日日程/待办） |
| `self.inkpane.event.create` | 「明天下午三点开组会，在 302」 |
| `self.inkpane.event.cancel` | 「取消明天三点那个会」（需要确认） |
| `self.inkpane.todo.create` | 「加一个待办：周五前交实验报告」 |
| `self.inkpane.todo.complete` | 「把交报告那个待办标记完成」 |
| `self.inkpane.todo.delete` | 「删掉买牛奶这个待办」（需要确认） |
| `self.inkpane.screen.refresh` | 「刷新一下屏幕」 |
| `self.inkpane.device.status` | 「你还有多少电？」 |
| `self.inkpane.volume.set` | 「音量调到 40」 |

实现路径：小智服务下发 `type=mcp` 的 JSON-RPC 请求 → 设备 `mcp_server` 校验参数 →
`mcp_tools` 调用 `X-Device-Token` 的 `/api/device/events|todos|context` → Node 服务写
SQLite（按用户隔离、写接口 20 次/60 秒限流）→ 设备清 ETag，回到看板后强制重绘。
每次会话最多 10 次写调用；失败会以中文错误回给模型。

安全边界：

- 设备令牌现在既能读屏也能写日程/待办；泄露后请到控制台「轮换令牌」并重新配网。
- 服务端按设备令牌解析 userId，跨用户 id 返回 404；参数走 strict zod 校验。
- `allowControl` 是设备侧策略（关闭后不注册写工具）；服务端仍以设备令牌为信任边界。
- 所有写操作在服务端 `logger.info` 记录 requestId/deviceId/userId/action。

## 5. 自定义唤醒词

- 来源优先级：控制台 `voice.wakeWords` → NVS `wake_words` → Kconfig
  `CONFIG_INKPANE_VOICE_WAKE_WORDS`。
- 格式：1–8 条，每条是 **拼音音节**，小写、用空格分隔、不带声调，例如
  `da fen qi`（对应「达芬奇」）。MultiNet 只认拼音：写汉字会得到
  `invalid command, please check format` 并导致**唤醒词完全失效**，设备日志里会提示
  `wake phrase "…" is not MultiNet pinyin`。老固件/NVS 里的汉字唤醒词会在加载时自动
  换成默认拼音。
- 生效：待命态 `AudioService::ReloadWakeWords()` 直接重配 MultiNet 命令词，无需重启。
- 验收：每个词在安静环境与播放音乐/说话时各测 10 次；识别率低时把灵敏度从 65 调到
  75–85，或换更常见的词。启动日志确认 `N wake command(s) active`（N≥1），唤醒时出现
  `Custom wake word detected`。

## 6. 构建与烧录

前置与普通固件相同（ESP-IDF v6.0.2）。语音会额外引入 ESP-SR、Opus、ES8311 驱动与
WebSocket 组件，首次构建需要联网让 IDF Component Manager 下载依赖。

```powershell
# 构建（自动下载 managed components）
powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1

# 全量烧录：会同时写入 model 分区的 srmodels.bin
powershell -ExecutionPolicy Bypass -File hardware/tools/build.ps1 -Flash -Port COM5

# 只烧应用不会更新模型；换唤醒词模型后必须全量 flash
```

分区：`factory` 11.25 MB（应用，含 5.35 MB 字库）、`model` 4 MB（ESP-SR 模型）。
本次验证构建产物：`inkpane.bin` 7.04 MB（factory 剩余 37%）、`srmodels.bin` 2.83 MB
（model 分区剩余约 1.2 MB）；`LOW_POWER` 模式同源构建 `inkpane.bin` 6.22 MB，验证原深睡
路径仍可编译。`idf.py app-flash` 不更新模型；模型缺失时语音页会提示「请执行 idf.py flash
烧录 model 分区」。

## 7. 排障

| 现象 | 处理 |
| --- | --- |
| 屏幕一直「正在连接日程服务」 | 看板服务不可达；先解决 Wi-Fi/服务地址，与语音无关 |
| 「语音助手未激活」+ 6 位码 | 到 xiaozhi.me 输入；确认设备时间正确（TLS 依赖时间） |
| 「系统时间未校准，无法校验 TLS 证书」 | 先让设备联网；常驻模式会走 SNTP（3 台服务器，含字面 IP 兜底 DNS）并每小时重同步，日志里应出现 `sntp service started (3 servers)` 与 `sntp synced:`。仍失败说明 UDP 123 被防火墙/路由器拦了，或根本不通外网；`sntp sync timed out` 每进程最多出现一次，出现后后台仍在重试，可等一分钟再看 RTC 是否被校准 |
| 「语音模型未加载」 | 重新全量 `-Flash`，确认 `model` 分区写入成功 |
| 唤醒词没反应 | 控制台确认语音已启用、未静音；**唤醒词必须是拼音**（`da fen qi`，不是汉字）；日志里找 `N wake command(s) active` 与 `Custom wake word detected` |
| 日志出现 `invalid command, please check format` | 唤醒词写成了汉字；MultiNet 只接受拼音音节 |
| 按侧键没反应且没有日志 | 侧键长按超过 1.5 秒会被忽略（无动作）；短按才会切视图 |
| 回答没声音 | 检查喇叭接线、音量；看日志 ES8311/Opus 错误；确认未在 BOOT 打断 |
| 回答时自己触发唤醒 | 关闭 `CONFIG_INKPANE_VOICE_WAKE_DURING_PLAYBACK`（默认已关） |
| 「墨窗服务不可达」 | 语音控制调用的 `/api/device/*` 失败；检查局域网与控制台服务 |
| 「设备令牌无效」 | 控制台轮换令牌后重新配网；看板也会显示「令牌无效」 |
| 「该语音服务仅支持 MQTT」 | InkPane 只支持 WebSocket；更换 OTA 地址或服务端配置 |
| WebSocket 频繁断 | 检查 2.4G 信号/AP 隔离；设备会退避重连，3 次失败显示错误页 |

串口日志：`build.ps1 -Monitor`；语音相关 TAG 为 `voice`、`WS`、`AudioService`、`AfeAudioEngine`、
`CustomWakeWord`、`voice_board`、`voice_ota`、`MCP`。

## 8. 真机验收清单

> 当前自动化只能验证构建、host 测试与网站测试；以下项目必须接上设备逐项确认。

1. 上电：看板正常；日志出现 `creating ES8311 codec`、AFE feed/fetch 尺寸、MultiNet 模型名。
2. 音频：唤醒提示/回答可闻；麦克风在 30 cm 内正常识别；无持续爆音/电流声。
3. 激活：屏幕 6 位码；xiaozhi.me 绑定后自动待命；重启后仍已激活。
4. 唤醒词：默认词 + 控制台新增词各 10 次；改词不重启生效；静音手势生效。
5. 对话：单轮、多轮、打断、20/60 秒超时、服务端断线恢复。
6. 语音控制：按第 4 节例子逐项验证；控制台出现数据；回到看板后屏幕更新；
   `allowControl=false` 时写工具不可用。
7. 屏幕：对话页局刷按损坏带更新、无明显残影，窗口不偏移——状态标签变化只闪一条带
   （约 30 行），回复多一行 1–2 条带；整轮变化（新问题 + 新回答 + 状态）应**回落全刷**
   （日志 `voice page refresh (full=... state=... outcome=...)`，带区路径另打
   `voice page partial refresh: N band(s), R rows, M ms`）；连续 40 次带区局刷后下一次
   强制全刷去残影；激活页/错误页/回看板全刷正常。
8. 网络：拔网、改错 OTA、MQTT-only、令牌失效、限流 429 的错误提示。
9. 电源：待命/对话/播放电流；低电 <15% 静音、<5% 关机；USB 供电不关机。
10. 24 小时稳定性：无内存泄漏/看门狗复位；唤醒词仍可用；看板仍按时刷新。
