# 第三方组件与参考资料

本目录的固件只引入许可证清晰的代码与数据。

| 项目 | 用途 | 许可证 | 说明 |
| --- | --- | --- | --- |
| [ESP-IDF](https://github.com/espressif/esp-idf) | 构建系统、Wi-Fi、HTTP、NVS、TLS | Apache-2.0 | 通过工具链引用，不复制源码 |
| [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) | 生成 1-bit 中文点阵字库 | SIL OFL 1.1 | `tools/genfont.py` 的输入；生成的 `inkpane_fonts.bin` 为派生的位图数据 |
| [XPowersLib](https://github.com/lewisxhe/XPowersLib) | AXP2101 寄存器定义参考 | MIT | 仅参考寄存器地址与换算，代码为本项目自行实现 |
| [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) | 语音音频/协议栈（AudioService、AFE、MultiNet、Opus、WebSocket 协议） | MIT | **有源码复制**：`components/inkpane_voice/upstream/`，源 commit 与补丁见 `upstream/PROVENANCE.md`；MIT 全文见 `upstream/LICENSE.xiaozhi` |
| [ESP-SR](https://github.com/espressif/esp-sr) | AFE / VADNet / MultiNet 唤醒词模型 | Espressif ESP-SR License | 通过 IDF Component Manager 引用，不复制源码；`model` 分区内的模型随固件烧录，再分发前请确认 ESP-SR 许可条款 |
| [esp_audio_codec](https://components.espressif.com/components/espressif/esp_audio_codec) | Opus 编码/解码 | Apache-2.0 | IDF Component Manager 依赖 |
| [esp_codec_dev](https://components.espressif.com/components/espressif/esp_codec_dev) | ES8311 编解码器驱动 | Apache-2.0 | IDF Component Manager 依赖 |
| [esp_audio_effects](https://components.espressif.com/components/espressif/esp_audio_effects) | 采样率转换 | Apache-2.0 | IDF Component Manager 依赖 |
| [esp_websocket_client](https://components.espressif.com/components/espressif/esp_websocket_client) | 小智 WebSocket 传输 | Apache-2.0 | IDF Component Manager 依赖 |
| 微雪 ESP32-S3-ePaper-3.97 示例 | 面板初始化/局刷寄存器时序参考 | 未声明 | 只参考硬件时序与引脚事实，不复制示例源码；示例整包未入库 |

> 本地可能保留一份 `hardware/ESP32-S3_ePaper-3.97-demo/` 作为只读参考，
> 该目录已被 `.gitignore` 排除，不会进入仓库，也不属于本项目再分发内容。

## 字体声明

`components/inkpane_ui/fonts/inkpane_fonts.bin` 由 Noto Sans SC 渲染而来。Noto Sans SC
采用 SIL Open Font License 1.1，允许嵌入、修改与再分发；本仓库随附本说明作为归属声明。
OFL 全文见 <https://openfontlicense.org/open-font-license-official-text/>。

如果替换为其他字体，请同步更新本文件，并确认新字体的再分发条款。

## 语音组件声明

`components/inkpane_voice/upstream/` 中的源码来自 xiaozhi-esp32（MIT）。该目录保留
`LICENSE.xiaozhi` 全文与 `PROVENANCE.md`（源 commit、文件映射、补丁清单）。修改这些
文件时请继续保留版权声明。

ESP-SR 模型（`model` 分区中的 `srmodels.bin`）由 ESP-IDF Component Manager 在构建时
根据 `sdkconfig` 生成并烧录，不属于本仓库源码；其许可为 Espressif ESP-SR License，
商业再分发前请阅读 <https://github.com/espressif/esp-sr> 的许可说明。

如果替换为其他字体，请同步更新本文件，并确认新字体的再分发条款。
