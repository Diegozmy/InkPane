# inkpane_voice

InkPane 的语音助手组件：常驻唤醒词、小智协议对话、MCP 语音控制日程/待办。

## 结构

```
include/inkpane_voice.h   # 对外 C API（app_main 只依赖它）
port/                     # InkPane 自有的适配层
  voice_app.cc            # 状态机、事件队列、OTA/激活、协议/MCP 装配
  voice_board.cc          # ES8311 + I2S + PA 板级初始化
  voice_identity.*        # MAC/UUID/唤醒词/阈值 供 vendored 代码读取
  voice_ota.*             # 小智 OTA / activate HTTP(S) 客户端
  web_socket.*            # esp_websocket_client 封装
  settings.*              # NVS Settings shim
  mcp_server.c            # JSON-RPC 2.0 MCP 服务器（纯 C，host 可测）
  mcp_tools.c             # self.inkpane.* 工具实现（纯 C，host 可测）
  inkpane_api.c           # 设备令牌 HTTP 客户端
upstream/                 # 从 xiaozhi-esp32 引入（MIT，见 PROVENANCE.md）
```

## 数据流

```
ES8311 麦 → I2S → AudioService → AFE(MultiNet 唤醒词 / VAD) → Opus → WebSocket → 小智
小智 → WebSocket → Opus → I2S → ES8311/NS4150B
WebSocket(type=mcp) → mcp_server → mcp_tools → InkPane /api/device/* → SQLite
```

`voice_app` 通过 `inkpane_voice_event_queue()` 的 C API 把状态/文本/会话信息交给
app_main；app_main 是唯一访问电子墨水屏的任务，也是唯一写 `inkpane` NVS 配置的任务。
MCP 工具在独立控制任务里执行，避免阻塞音频。

## 关键约束

- 本板单麦、没有硬件回采参考通道。`CONFIG_INKPANE_VOICE_BARGE_IN=y`（默认）时，
  `Es8311AudioCodec` 把送往喇叭的 PCM 作为虚拟参考通道（输入第二声道）交给 AFE AEC；
  播放中检测到持续说话就中止回答。外壳共振仍可能自触发，可关闭该项改用 BOOT 键打断。
  `CONFIG_INKPANE_VOICE_WAKE_DURING_PLAYBACK` 是另一条实验路径，默认关闭。
- 自定义唤醒词由 MultiNet 运行时命令词实现，只支持模型可解码的中文短语；
  改词通过 `AudioService::ReloadWakeWords()` 在待命态应用，无需重启。
- 语音服务不可达、模型缺失、令牌失效都只影响语音，看板继续工作。

## Host tests

`mcp_server.c` / `mcp_tools.c` 不依赖 ESP-IDF（`inkpane_api_request` 在 host 构建里
由 `hardware/test/host/mcp_mock.c` 替换），测试入口见 `hardware/test/host/mcp_test.c`。
