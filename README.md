<p align="center">
  <img src="assets/images/device-hero.webp" alt="InkPane 墨窗：3.97 英寸电子墨水桌面信息屏" width="880">
</p>

<h1 align="center">InkPane · 墨窗</h1>

<p align="center">
  <strong>一窗墨色，一日清明。</strong><br>
  <sub>One pane of ink — a day made clear.</sub>
</p>

<p align="center">
  <sub>ESP32-S3 · 3.97″ 电子墨水 · 800 × 480 · 桌面常显 · 超低功耗</sub>
</p>

---

> 于方寸桌面，辟一窗静境。
> 窗内收纳时序流转、阴晴气象，排布课业日程，罗列未竟事项。

InkPane 墨窗，以电子墨水为纸，以规整窗格为形，将整日行程从容铺展于桌面。
无背光、无频闪、无信息侵扰；不抢夺视线，不制造光污染，唯有目光落处，信息清晰浮现。

**Ink**，是墨色纸屏的沉静；**Pane**，是信息之窗的通透。
墨窗，是书桌之上的一方静谧窗口，亦是人与日常之间温和克制的交互界面。

*A quiet pane of electronic ink for your desk — time, weather, classes and to-dos, always in view, never in the way.*

---

## 核心能力

整合时间日历、实时天气、课程日程、待办清单，支持自定义模块自由排布。

| 窗格 | 内容 |
| --- | --- |
| **时间日历** | 今日日期、星期与当月小日历，配合当日时间线，一眼看清「今天走到哪一步」 |
| **实时天气** | 室外温度、体感与阴晴趋势；机身板载温湿度传感器，室内读数本地直采 |
| **课程日程** | 当日课表、上课时间与地点；整学期课表可导入并定时自动同步 |
| **待办清单** | 未竟事项按优先级罗列，完成即勾去，不堆积、不轰炸 |

四块窗格可增删、互换与调整尺寸，排布结果保存在设备上，断电不丢。
你看到的永远是「此刻需要的那一屏」，而不是又一个需要照顾的信息源。

## 产品理念

- **纸本观感** —— 墨色文字落在哑光纸面上，对比度来自环境光，而非背光。
- **极简窗格** —— 以规整栅格组织信息，留白也是内容的一部分；没有动画争夺注意力。
- **护眼常显** —— 无背光、无频闪，画面静止时不耗电，久看不累，也不需要「息屏」。
- **超低功耗** —— 只在内容变化时刷新，其余时间深度休眠，长久待机无电量焦虑。
- **不打扰** —— 没有推送、没有红点、没有广告位。信息安静地待在那里，等你看它。

## 适用场景

| 场景 | 说明 |
| --- | --- |
| **学生书桌** | 课表、作业与倒计时就摆在台灯旁边，抬眼即知下一节课在哪间教室 |
| **职场办公桌** | 日程、会议与待办常显，不必反复点亮手机或切换窗口 |
| **卧室床头柜** | 时间与天气一眼可读，临睡前不必再面对发光屏幕 |
| **家庭信息角** | 全家的日程与备忘并列一屏，纸质便签的秩序感，电子化的即时性 |

## 硬件平台

墨窗运行在 **微雪 ESP32-S3-ePaper-3.97** 开发板上：一块 3.97 英寸、800 × 480 的电子墨水屏，
配上 ESP32-S3 的双核算力与 Wi-Fi / BLE 连接，以及一套刚好够用的传感器与电源管理。

<p align="center">
  <img src="assets/images/board-resources.webp" alt="ESP32-S3-ePaper-3.97 板载资源" width="760">
</p>
<p align="center"><sub>板载资源（编号对应微雪官方文档）</sub></p>

| 项目 | 规格 |
| --- | --- |
| 主控 | ESP32-S3R8，Xtensa<sup>®</sup> 32 位 LX7 双核，最高 240 MHz |
| 内存 / 存储 | 512 KB SRAM + 384 KB ROM，叠封 8 MB PSRAM；16 MB Flash，另带 Micro SD 卡槽（FAT32） |
| 无线 | 2.4 GHz Wi-Fi（802.11 b/g/n）+ Bluetooth 5 (LE)，板载天线 |
| 屏幕 | 3.97 英寸电子墨水屏，800 × 480，高对比度、宽视角 |
| 传感 | SHTC3 温湿度传感器 · QMI8658 六轴 IMU · PCF85063 RTC 实时时钟 |
| 音频 | ES8311 低功耗音频编解码 + NS4150B 功放，板载麦克风与喇叭接口 |
| 电源 | TG28 电源管理，3.7 V MX1.25 锂电池供电并支持充放电，另留 RTC 备用电池接口 |
| 交互 | 拨轮按键（三向）+ BOOT + PWR 侧键，可自定义按键功能 |
| 接口 | USB Type-C，用于烧录与日志输出 |

<p align="center">
  <img src="assets/images/board-interfaces.webp" alt="ESP32-S3-ePaper-3.97 接口示意" width="760">
</p>
<p align="center"><sub>板载接口与连接器</sub></p>

硬件资料、原理图与示例固件见微雪官方文档：
[ESP32-S3-ePaper-3.97](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/) ·
[相关资料](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/Resources-And-Documents) ·
[产品页](https://www.waveshare.net/shop/ESP32-S3-ePaper-3.97.htm)

## 配套控制台

墨水屏打字不便，所以墨窗把「录入与整理」交给桌面端控制台：日程、课程、待办、天气与屏幕布局
都在这里调整，设备端只负责把整理好的内容，以最安静的方式铺到屏幕上。

<p align="center">
  <img src="website/docs/screenshots/01-dashboard.png" alt="InkPane 控制台总览" width="900">
</p>
<p align="center"><sub>总览：今日日程、天气、待办与桌面屏幕的实时缩略预览</sub></p>

- **总览** —— 一屏看完今天：日程、课程、待办、天气与设备状态，并实时预览设备上的那一屏。
- **待办清单** —— 优先级、截止日期、完成即勾去；设备端只取未完成的前 8 条，不堆积、不轰炸。
- **天气** —— 当前实况、未来三天、城市搜索与经纬度手填；失败自动回退缓存，不让屏幕空掉。
- **屏幕与设备** —— 800 × 480 窗格布局编辑、四套预设、模块开关、刷新间隔、设备令牌与遥测状态。
- **日历** —— 月 / 周 / 日 / 列表四种视图；拖拽即改期、重复日程、分类标签、提醒与课程同步。
- **主题与键盘** —— 深色 / 浅色 / 跟随系统，首屏不闪白；`T` 今天、`M/W/D` 视图、`N` 新建、`/` 搜索。

<p align="center">
  <img src="website/docs/screenshots/02-month-light.png" alt="月视图" width="440">
  <img src="website/docs/screenshots/05-agenda-light.png" alt="列表视图" width="440">
</p>
<p align="center"><sub>月视图与列表视图</sub></p>

<p align="center">
  <img src="website/docs/screenshots/08-todos.png" alt="待办清单" width="440">
  <img src="website/docs/screenshots/09-weather.png" alt="天气" width="440">
</p>
<p align="center"><sub>待办清单与天气</sub></p>

<p align="center">
  <img src="website/docs/screenshots/10-device.png" alt="屏幕与设备" width="900">
</p>
<p align="center"><sub>屏幕与设备：布局编辑、实时预览、令牌与遥测</sub></p>

**数据留在本机。** 日程、待办、天气缓存与设备令牌都存于本地 SQLite，不依赖任何云账号；
课程密码以 AES-256-GCM 密文保存，接口永不回传明文。

技术栈与工程细节（分层设计、重复日程引擎、时区处理、测试与静态检查）见
[website/README.md](website/README.md)。

## 硬件对接

设备端与本地服务之间是一套稳定、可离线重试的 HTTP 契约，完整说明见
**[设备端 API 与硬件对接指南](website/docs/DEVICE-API.md)**（含数据契约、1-bit 渲染规范、
低功耗策略、ESP-IDF 示例与 curl 调试步骤）。

```text
设备唤醒 ──► GET /api/device/screen（带 X-Device-Token + If-None-Match）
              │  304 ──► 内容未变，不重绘，直接休眠
              │  200 ──► 按 screen.layout 渲染 800×480 窗格
              ├──► POST /api/device/telemetry 上报 SHTC3 温湿度与电量
              └──► 按 refreshMinutes 深度休眠，RTC 定时唤醒
```

| 接口 | 说明 |
| --- | --- |
| `GET /api/device/screen` | 屏幕数据：布局、时钟、月历、天气、今日日程 / 课程 / 待办；带 ETag，内容未变返回 304 |
| `POST /api/device/telemetry` | 上报温度、湿度、电量、信号、固件版本与运行时长 |
| `GET /api/display`、`PUT /api/display` | 读取 / 保存 6 个模块的窗格坐标与刷新间隔 |
| `GET /api/device/token`、`POST /api/device/token` | 获取 / 轮换设备令牌（旧令牌立即失效） |

设备令牌在控制台「设备」页获取；默认服务只监听 `127.0.0.1`，设备接入时需在
`website/server/.env` 中设置 `HOST=0.0.0.0` 后重启。

## 目录结构

```text
InkPane/
├── README.md               # 你正在读的这个文件
├── LICENSE
├── assets/images/          # 产品图与硬件资源图
├── hardware/               # 设备端固件与硬件资料（开发中）
└── website/                # InkPane 控制台
    ├── server/             # Express + node:sqlite，REST API
    ├── web/                # React 18 + TypeScript + Vite
    ├── docs/               # 架构说明、REST API、设备对接文档、界面截图
    └── scripts/            # 工程脚本
```

## 快速开始

**运行控制台**（需要 Node.js >= 22.5，使用内置 `node:sqlite`，无需任何原生编译依赖）：

```bash
cd website
npm install          # 安装前后端全部依赖（npm workspaces）
npm run dev          # 同时启动 API（:4000）与前端（:5173）
```

打开 <http://localhost:5173> 。首次启动会自动建库、执行迁移并写入一批演示日程，界面不会是空的。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 并行启动前后端（开发模式，热更新） |
| `npm run verify` | lint + 类型检查 + 测试 + 生产构建，提交前跑一遍 |
| `npm test` | 前后端单元测试与接口集成测试 |
| `npm run build` | 构建前端产物与后端 JS |
| `npm start` | 以生产模式启动后端（设置 `SERVE_STATIC=true` 可同时托管前端） |

数据默认落在 `website/data/inkpane.sqlite`，运行期配置见 `website/server/.env.example`。

**接入设备**：打开控制台「设备」页获取令牌与拉取地址，再把它们写进设备固件；完整字段、
错误码与 ESP-IDF 示例见 [设备端 API 与硬件对接指南](website/docs/DEVICE-API.md)。
设备在同一局域网访问时，需要在 `website/server/.env` 中设置 `HOST=0.0.0.0`。

**点亮屏幕**：设备端固件位于 [`hardware/`](hardware/README.md)，开发中，开发计划与平台说明见该目录 README。
当前可先按微雪官方
[ESP-IDF](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/ESP-IDF) /
[Arduino](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/Arduino) 教程跑通屏幕与 Wi-Fi。

## 项目状态

- [x] 产品定义、视觉规范与控制台信息架构
- [x] 控制台：总览、日历、待办、天气、屏幕布局编辑与课程同步
- [x] 设备对接协议：屏幕数据、ETag / 304、遥测、令牌与完整硬件对接文档
- [x] 硬件平台选型：ESP32-S3-ePaper-3.97
- [ ] 设备端固件：800 × 480 窗格渲染、深度休眠与 RTC 唤醒
- [ ] 屏幕端 1-bit 字库、局刷策略与残影调优

## 参考与致谢

- 硬件参考设计、产品图片与规格数据来自 [微雪电子 ESP32-S3-ePaper-3.97 官方文档](https://docs.waveshare.net/ESP32-S3-ePaper-3.97/)，
  相关版权归深圳市微雪电子有限公司所有。InkPane 是独立项目，与微雪电子无隶属关系。
- 设备对接细节见 [DEVICE-API.md](website/docs/DEVICE-API.md)，REST 接口全集见 [API.md](website/docs/API.md)，
  分层设计见 [ARCHITECTURE.md](website/docs/ARCHITECTURE.md)。
- 固件开发基于 [ESP-IDF](https://docs.espressif.com/projects/esp-idf/zh_CN/latest/) 与 ESP32-S3 生态。
- 控制台界面图标来自 [Phosphor Icons](https://phosphoricons.com/)，日期处理使用 [date-fns](https://date-fns.org/)。

## 品牌标语

> 一窗墨色，一日清明。

## License

本项目以 [MIT](LICENSE) 许可证开源。
