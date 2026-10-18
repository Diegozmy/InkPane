# hardware · 设备端

InkPane 墨窗的设备端固件与硬件资料。

当前状态：**平台选型已完成，固件开发中**。本目录先记录开发计划与参考资料，
固件工程落地后会直接放在这里。

## 硬件平台

墨窗运行在 [微雪 ESP32-S3-ePaper-3.97](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/) 上，
完整的规格表、板载资源图与接口说明见[根目录 README](../README.md#硬件平台)。

一句话概括选它的理由：

- **3.97″ / 800 × 480 电子墨水屏** —— 静态显示零功耗，纸面观感，无背光无频闪
- **ESP32-S3R8 + 16 MB Flash / 8 MB PSRAM** —— 双核 240 MHz，足够跑栅格布局与局部刷新
- **SHTC3 + PCF85063** —— 室内温湿度与走时不需要联网，离网也能显示
- **TG28 电源管理 + 3.7 V 锂电池** —— 充电、稳压与深度休眠一套解决

## 开发计划

- [ ] 点亮 e-paper：全屏刷新、局部刷新与灰阶表现验证
- [ ] 窗格布局引擎：时间日历 / 天气 / 课程 / 待办四模块的栅格排布与尺寸调整
- [ ] Wi-Fi 配网，从本地 InkPane 服务拉取日程与课程数据
- [ ] 天气模块：室外天气接口 + SHTC3 室内温湿度
- [ ] 低功耗策略：深度休眠、定时唤醒、按内容变化触发刷新
- [ ] 断电记忆：布局与配网信息写入 NVS

## 开发环境

- ESP-IDF v5.x，target `esp32s3`
- 上手参考：[ESP-IDF 开发教程](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/ESP-IDF) ·
  [Arduino 开发教程](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/Arduino) ·
  [Flash 固件烧录](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/Firmware-Flashing)
- 原理图、规格书与示例代码：[相关资料](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/Resources-And-Documents)
