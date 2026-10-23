# 第三方组件与参考资料

本目录的固件只引入许可证清晰的代码与数据。

| 项目 | 用途 | 许可证 | 说明 |
| --- | --- | --- | --- |
| [ESP-IDF](https://github.com/espressif/esp-idf) | 构建系统、Wi-Fi、HTTP、NVS | Apache-2.0 | 通过工具链引用，不复制源码 |
| [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC) | 生成 1-bit 中文点阵字库 | SIL OFL 1.1 | `tools/genfont.py` 的输入；生成的 `inkpane_fonts.bin` 为派生的位图数据 |
| [XPowersLib](https://github.com/lewisxhe/XPowersLib) | AXP2101 寄存器定义参考 | MIT | 仅参考寄存器地址与换算，代码为本项目自行实现 |
| 微雪 ESP32-S3-ePaper-3.97 示例 | 面板初始化/局刷寄存器时序参考 | 未声明 | 只参考硬件时序与引脚事实，不复制示例源码；示例整包未入库 |

> 本地可能保留一份 `hardware/ESP32-S3_ePaper-3.97-demo/` 作为只读参考，
> 该目录已被 `.gitignore` 排除，不会进入仓库，也不属于本项目再分发内容。

## 字体声明

`components/inkpane_ui/fonts/inkpane_fonts.bin` 由 Noto Sans SC 渲染而来。Noto Sans SC
采用 SIL Open Font License 1.1，允许嵌入、修改与再分发；本仓库随附本说明作为归属声明。
OFL 全文见 <https://openfontlicense.org/open-font-license-official-text/>。

如果替换为其他字体，请同步更新本文件，并确认新字体的再分发条款。
