# 基于 SSVEP 脑机接口的智能家居 3D 仿真平台技术方案文档

---

## 一、项目概述

### 1.1 项目背景

本团队为 4 人高中生团队，现有 EEG 脑电采集设备，但缺乏实体智能家居硬件。为验证基于稳态视觉诱发电位（Steady-State Visual Evoked Potential, SSVEP）的脑机接口控制方案，拟构建一套纯软件仿真平台：通过 Three.js 构建高保真 3D 室内场景，将 SSVEP 解码结果映射为虚拟环境中的设备控制指令，实现从脑电信号到家居控制的完整闭环验证。

**开发模式说明**：仿真渲染层与仿真状态层代码由 AI 辅助生成；SCF 刺激呈现与 SCB 采集/解码复用开源项目 NDDrone-SDK（见 6.5），团队人工开发核心模块为 SSVEP 频率标定、决策引擎及 BCI 客户端（SCB → PB WebSocket 桥接）模块。

### 1.2 核心目标

| 目标     | 说明                                             |
|----------|--------------------------------------------------|
| 范式验证 | 验证 SSVEP 在 4–8 指令集下的识别准确率与响应延迟 |
| 交互闭环 | 打通「脑电采集 → 意图解码 → 3D 场景响应」全链路  |
| 算法实践 | 实现 FBCCA 解码算法，完成从理论到工程落地        |
| 演示展示 | 形成可公开展示的交互式演示系统                   |

### 1.3 文档范围

本文档涵盖系统总体架构、各层模块设计、通信协议及开发计划。不包含具体代码实现，仅提供技术选型与设计方案。

---

## 二、系统总体架构

### 2.1 架构分层

平台采用五层架构，各层职责明确，通过标准化接口解耦。

```plain
┌─────────────────────────────────────────────────────────────┐
│  仿真渲染层（PF，Presentation Frontend）                     │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Three.js 3D 室内场景（客厅 / 卧室 / 厨房）            │  │
│  │  · 虚拟家具模型（灯光、窗帘、空调、电视、门锁）         │  │
│  │  · 设备状态实时渲染（光照变化、窗帘开合动画）           │  │
│  │  · 设备状态面板（当前温度、亮度、开关状态）             │  │
│  └───────────────────────────────────────────────────────┘  │
│  技术栈：Vue 3 + Vite + Three.js（AI 辅助生成）               │
├─────────────────────────────────────────────────────────────┤
│  仿真状态层（PB，Presentation Backend）                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  · WebSocket 服务端（接收意图抽象层指令，广播至仿真渲染层）│  │
│  │  · 设备状态机（维护虚拟设备当前状态）                   │  │
│  │  · 消息路由与转发（PF ↔ SCB）                          │  │
│  │  · 日志记录（指令流水、状态变更历史）                   │  │
│  └───────────────────────────────────────────────────────┘  │
│  技术栈：ElysiaJS + WebSocket（AI 辅助生成）                  │
├─────────────────────────────────────────────────────────────┤
│  辅助意图层（SCF，Stimulus Client Frontend）                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  · SSVEP 闪烁刺激面板（复用 NDDrone-SDK 刺激模块）      │  │
│  │  · 4–8 个闪烁区块，按预设频率正弦调制                   │  │
│  │  · 区块标注设备图标与文字提示                           │  │
│  │  · 刺激参数配置界面（频率、亮度、对比度）               │  │
│  └───────────────────────────────────────────────────────┘  │
│  技术栈：Python + PsychoPy（复用 NDDrone-SDK 刺激模块）       │
├─────────────────────────────────────────────────────────────┤
│  意图抽象层（SCB，Stimulus Client Backend）                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  · WebSocket 客户端（连接仿真状态层，上报解码指令）     │  │
│  │  · 采集层：ND8 TCP 数据流接入（复用 NDDrone-SDK）       │  │
│  │  · 解码层：FBCCA 算法基线（复用 NDDrone-SDK）           │  │
│  └───────────────────────────────────────────────────────┘  │
│  技术栈：Python + aiohttp（复用 NDDrone-SDK 采集与解码）      │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```plain
用户注视辅助意图层（SCF）中的闪烁刺激块
        ↓
ND8 设备采集枕叶脑电（Oz, O1, O2, POz）
        ↓
意图抽象层（SCB）采集层：通过 TCP 接收实时数据流
        ↓
意图抽象层（SCB）解码层：预处理 → FBCCA 频率识别（2–4 秒滑动窗口）
        ↓
决策引擎判定有效指令（置信度 ≥ 阈值，连续 N 次一致）
        ↓
意图抽象层（SCB）WebSocket 客户端发送指令至仿真状态层（PB）
        ↓
仿真状态层（PB）更新设备状态机，广播至仿真渲染层（PF）
        ↓
仿真渲染层（PF）3D 场景执行状态变更（灯光渐暗、窗帘滑动、空调温度数字跳动）
        ↓
仿真渲染层（PF）状态面板同步显示当前设备状态
```

---

## 三、仿真渲染层（PF）

### 3.1 功能模块

| 模块        | 功能描述                                              |
|-------------|-------------------------------------------------------|
| 3D 场景渲染 | Three.js 构建室内环境，支持第一人称漫游与固定视角切换 |
| 设备模型    | 灯光、窗帘、空调、电视、门锁等可交互家具的 3D 模型    |
| 状态动画    | 设备状态变更时的过渡动画（灯光渐暗、窗帘滑动等）      |
| 状态面板    | 2D UI 面板显示当前设备状态（温度、亮度、开关状态）    |
| 场景切换    | 支持客厅 / 卧室 / 厨房 / 玄关等多区域切换             |

### 3.2 设备状态可视化

| 设备     | 状态变更动画            | 技术实现                                                 |
|----------|-------------------------|----------------------------------------------------------|
| 灯光     | 亮度渐变（0.5–1 秒）    | 调整 PointLight / SpotLight 的 intensity 与材质 emissive |
| 色温     | 颜色插值（暖黄 ↔ 冷白） | Color.lerpColors() 在 2700K–6500K 色温间插值             |
| 窗帘     | 开合滑动（2–3 秒）      | 布料模型沿轨道平移，或使用骨骼动画                       |
| 空调     | 温度数字跳动、风口摆动  | 数字贴图切换 + 风口叶片旋转动画                          |
| 电视     | 屏幕内容切换、音量条    | 视频纹理播放 / 音量条 UI 缩放                            |
| 门锁     | 锁舌伸缩、指示灯变色    | 机械部件位移 + 自发光材质颜色切换                        |
| 紧急呼叫 | 全屋灯光红色闪烁        | 全局光照颜色循环 + 警报音效                              |

### 3.3 技术栈

| 模块     | 技术选型          | 说明                                       |
|----------|-------------------|--------------------------------------------|
| 3D 引擎  | Three.js（r160+） | WebGL 渲染，支持 PBR 材质与实时光影        |
| 前端框架 | Vue 3 + Vite      | 组件化管理 UI 面板与状态                   |
| 状态管理 | Pinia             | 轻量级状态管理，适合中小型项目             |
| 通信协议 | WebSocket（原生） | 连接仿真状态层，接收设备控制指令与状态更新 |

---

## 四、仿真状态层（PB）

### 4.1 功能模块

| 模块             | 功能描述                                     |
|------------------|----------------------------------------------|
| WebSocket 服务端 | 监听仿真渲染层与意图抽象层的连接，维护连接池 |
| 消息路由         | 识别消息来源（PF/SCB），转发至目标客户端     |
| 设备状态机       | 维护虚拟设备当前状态，处理状态变更请求       |
| 指令校验         | 验证指令合法性（设备 ID 存在、参数范围有效） |
| 日志记录         | 记录指令流水、状态变更历史、连接事件         |

### 4.2 消息处理流程

```plain
意图抽象层（SCB）发送指令 → 仿真状态层（PB）接收 → 校验指令格式 
→ 更新设备状态机 → 广播状态变更至仿真渲染层（PF） 
→ PF 执行动画并回传确认 → PB 记录日志
```

### 4.3 技术栈

| 模块      | 技术选型                  | 说明                           |
|-----------|---------------------------|--------------------------------|
| 后端框架  | ElysiaJS                  | 高性能 TypeScript 后端，轻量级 |
| WebSocket | ElysiaJS WebSocket Plugin | 原生支持 WebSocket，自动重连   |
| 数据存储  | 内存 Map（或 Redis）      | 设备状态实时存储，支持快速读写 |
| 日志      | Pino / Winston            | 结构化日志，便于调试与审计     |

---

## 五、辅助意图层（SCF）

### 5.1 功能模块

| 模块         | 功能描述                                     |
|--------------|----------------------------------------------|
| 闪烁刺激面板 | 独立窗口全屏呈现 4–8 个闪烁区块              |
| 频率调制     | 各区块按预设频率进行亮度正弦调制             |
| 视觉反馈     | 区块下方标注设备图标与文字（如"灯光""窗帘"） |
| 参数配置     | 刺激频率、亮度、对比度、区块布局可调         |
| 校准模式     | 辅助校准模式，显示当前实际刷新率与频率误差   |

### 5.2 刺激呈现方案

**呈现方式**：独立窗口或副屏呈现，与仿真渲染层 3D 场景分离，避免浏览器帧率不稳定对刺激频率的干扰。

**频率调制**：刺激呈现复用 [NDDrone-SDK](https://github.com/FallingShrimp/NDDrone-SDK) 的预渲染帧闪烁方案（每帧一张 PNG，逐帧播放）；正弦调制通过帧图亮度包络实现，以减少谐波干扰与视觉不适。

**刷新率要求**：显示器刷新率 ≥ 120 Hz recommended，最低 60 Hz（频率误差需校准）。SDK 原实现为 1920×1080@60 Hz 配合 `waitBlanking` 垂直同步，刺激频率与帧序强耦合，本项目需按新频率表与刷新率重新标定帧数与帧序。

### 5.3 技术栈

| 模块       | 技术选型          | 说明                                            |
|------------|-------------------|-------------------------------------------------|
| 刺激呈现   | PsychoPy          | 复用 NDDrone-SDK 刺激窗口（`SimulationWindow`） |
| 渲染后端   | Pyglet / OpenGL   | 底层 OpenGL 渲染，`waitBlanking` 垂直同步       |
| 刺激块生成 | Node.js CLI + PIL | 复用 NDDrone-SDK 帧图生成器，重新生成指令帧图   |
| 频率控制   | 帧序 / Clock      | 预渲染帧逐帧播放，或基于时间戳驱动相位          |

---

## 六、意图抽象层（SCB）

### 6.1 采集层

| 参数     | 配置                                            |
|----------|-------------------------------------------------|
| 设备型号 | 广东神舞科技 ND8                                |
| 数据接口 | TCP                                             |
| 电极位置 | Oz（主）、O1、O2、POz、PO3、PO4（6–8 通道）     |
| 参考电极 | 双耳乳突（M1/M2）或 FCz                         |
| 采样率   | ≥ 250 Hz                                        |
| 同步标记 | 接收辅助意图层刺激开始/结束时间戳，用于离线分析 |

**采集实现说明**：ND8 采集与预处理复用 [NDDrone-SDK](https://github.com/FallingShrimp/NDDrone-SDK) 的 `NDThread`——轮询式二进制取数请求、按数据包 `timestamp` 切分并维护滑动缓存、以 1000 Hz 内部记录率入库后重采样至 250 Hz，内置 50 Hz 陷波（IIR notch，Q=30）与 90 Hz 五阶巴特沃斯低通。团队不再从零实现 TCP 协议解析与滤波管线，仅需适配设备地址、通道映射与刺激起止时间戳的同步标记（模块清单见 6.5）。

### 6.2 解码层

1. **算法管线**

 ```plain
 原始 EEG → 0.5–40 Hz 带通滤波 → 50 Hz 陷波 
 → 共平均参考（CAR）→ 滑动窗口分段（3s 窗口，0.25s 步长）
 → FBCCA 频率识别
 → 置信度评估 → 决策引擎
 → 输出指令
 ```

| 算法  | 特点                 | 适用阶段 |
|-------|----------------------|----------|
| FBCCA | 子频带加权，抗噪性强 | 主用算法 |

**解码实现说明**：FBCCA 复用 [NDDrone-SDK](https://github.com/FallingShrimp/NDDrone-SDK) 的 `analyzer/spatialFilter.py` 作为算法基线——3 个子频带（Chebyshev-I 带通滤波组）、3 次谐波正弦参考、子频带权重 `k^-1.25 + 0.25`、按加权相关系数取最大类别；其默认频率表为 8–16 Hz 步长 1 Hz（共 9 类），本项目需按 7.2 的 8 条家居指令重新标定。需注意 SDK 原实现为单窗口 `argmax` 输出，既无共平均参考（CAR）也无置信度/连续确认等保护，本节 6.2 的 CAR、决策与防误触逻辑均为本项目新增。

1. **决策与防误触**

- **置信度阈值**：典型相关系数 ρ ≥ 0.45（可调）
- **连续确认**：需连续 3 个窗口识别结果一致（约 0.75 秒额外延迟）
- **时间约束**：3 次确认须在 5 秒内完成，超时重置
- **指令冷却**：同一指令触发后 3 秒内不再重复触发
- **空闲保护**：检测到眨眼/眼电伪迹（frontal 电极辅助）时暂停解码

### 6.3 WebSocket 客户端

| 功能     | 描述                                               |
|----------|----------------------------------------------------|
| 连接管理 | 自动连接仿真状态层，断线重连，心跳保活             |
| 指令封装 | 将解码结果封装为 JSON 指令，发送至仿真状态层       |
| 状态同步 | 接收仿真状态层回传的设备状态，用于调试显示         |
| 参数配置 | 接收仿真状态层下发的解码参数调整指令（如阈值修改） |

### 6.4 技术栈

| 模块         | 技术选型                                   | 说明                                                  |
|--------------|--------------------------------------------|-------------------------------------------------------|
| 编程语言     | Python 3.10+                               | 团队熟悉，生态丰富                                    |
| 信号处理     | SciPy / NumPy                              | 标准科学计算库                                        |
| WebSocket    | aiohttp                                    | 异步 WebSocket 客户端                                 |
| 采集与预处理 | NDDrone-SDK（`NDThread`）                  | 复用现有开源项目：ND8 TCP 取数、陷波/低通滤波、重采样 |
| 解码算法     | NDDrone-SDK（`analyzer/spatialFilter.py`） | 复用 FBCCA 基线实现，团队负责频率标定与决策增强       |

### 6.5 复用开源项目：NDDrone-SDK

SCB 及其上游 SCF 的刺激呈现、采集与解码实现，复用开源项目 [NDDrone-SDK](https://github.com/FallingShrimp/NDDrone-SDK)（原 flymode，基于脑机接口的意念无人机控制系统）。该 SDK 已实现完整的 SSVEP 闭环链路，模块复用边界如下。

| SDK 模块                                           | 代码位置                                                   | 对应层     | 复用方式                                        |
|----------------------------------------------------|------------------------------------------------------------|------------|-------------------------------------------------|
| PsychoPy 刺激窗口（预渲染帧闪烁 + `waitBlanking`） | `src/engine/window/simulation.py`                          | SCF        | 直接复用，替换区块布局与设备图标                |
| 刺激块帧图生成 CLI（Node.js + TypeScript）         | `cli/src/generator/`                                       | SCF        | 直接复用，重新生成家居指令帧图与频率表          |
| ND8 采集与预处理                                   | `src/engine/thread/NDThread.py`                            | SCB 采集层 | 直接复用，适配设备地址与通道映射                |
| FBCCA 解码                                         | `src/analyzer/spatialFilter.py`                            | SCB 解码层 | 作为算法基线，重新标定频率并新增 CAR / 决策逻辑 |
| 行为映射框架（识别结果 → 动作）                    | `src/analyzer/behaviour/`                                  | SCB 决策层 | 参考其映射机制，改为家居指令映射                |
| NeuroAPI 本地 TCP 服务（`PREDICT_MIND` 请求/应答） | `src/neuroApi.py`                                          | SCB        | **不复用**，改由 SCB → PB 的 WebSocket 协议替代 |
| 无人机飞控（RoboMaster SDK / UDP 8889）            | `src/flymode.py`、`src/engine/thread/SendMessageThread.py` | —          | **剥离**，替换为 PB 设备状态机                  |

**关键差异**：SDK 由 `neuroApi`（采集 + 解码，本地 TCP 服务端 :11000）与 `flymode`（刺激窗口 + 飞控，TCP 客户端）两个进程组成，二者以本地 TCP 文本命令通信，输出直接映射为无人机动作。本项目 SCB 与 PB 之间改用 WebSocket + JSON（协议见第七章），因此**团队真正的人工开发工作量在于新写桥接层**：接收 SDK 解码输出 → 按 7.2 指令映射封装为 `device_command` → 经 WebSocket 上报 PB。

---

## 七、通信协议设计

### 7.1 连接拓扑

```plain
辅助意图层（SCF，PsychoPy）──┐
                             │
意图抽象层（SCB，Python）────┼──→ 仿真状态层（PB，ElysiaJS WebSocket Server）──→ 仿真渲染层（PF，浏览器）
                             │
                             └──→ PB 日志/调试接口
```

- 辅助意图层（SCF）与意图抽象层（SCB）同机运行，通过本地文件或 HTTP 同步刺激参数
- 意图抽象层（SCB）与仿真状态层（PB）建立长连接，上报解码指令
- 仿真渲染层（PF）与仿真状态层（PB）建立长连接，接收设备状态更新

### 7.2 设备指令集

| 指令编码 | 对应 SSVEP 频率 | 目标设备 | 动作      |
|----------|-----------------|----------|-----------|
| CMD_01   | 【待确定】      | 客厅主灯 | 开关切换  |
| CMD_02   | 【待确定】      | 客厅窗帘 | 开/合切换 |
| CMD_03   | 【待确定】      | 空调     | 温度 +1℃  |
| CMD_04   | 【待确定】      | 空调     | 温度 -1℃  |
| CMD_05   | 【待确定】      | 电视     | 开关切换  |
| CMD_06   | 【待确定】      | 全屋     | 紧急呼叫  |
| CMD_07   | 【待确定】      | 卧室灯   | 亮度循环  |
| CMD_08   | 【待确定】      | 门锁     | 开/关切换 |

**注**：具体 SSVEP 刺激频率需团队人工测试确定，考虑因素包括显示器刷新率、被试视觉敏感度、频率间干扰等。

### 7.3 消息封装格式（Envelope）

所有 WebSocket 帧均为**单条 JSON 消息**，采用「统一信封 + 分类型 payload」两级结构：

```json
{
  "v": 1,
  "type": "device_command",
  "seq": 42,
  "ts": 1760000000000,
  "payload": { }
}
```

| 字段    | 类型   | 说明                                          |
|---------|--------|-----------------------------------------------|
| v       | int    | 协议版本号，当前固定为 1                      |
| type    | string | 消息类型，见 7.5 消息目录                     |
| seq     | int    | 发送端连接内单调递增序号，用于 ACK 关联与去重 |
| ts      | int    | 发送时刻，UTC epoch 毫秒                      |
| payload | object | 按 type 约定的负载，见 7.6 / 7.7              |

### 7.4 设备状态模型

**设备注册表**（PB 状态机初始化，PB 为设备状态唯一事实源）

| device_id           | device_type | 初始状态                                  |
|---------------------|-------------|-------------------------------------------|
| living_room_light   | light       | on=false, brightness=80, color_temp=4000  |
| bedroom_light       | light       | on=false, brightness=80, color_temp=4000  |
| living_room_curtain | curtain     | position=0（全合）                        |
| air_conditioner     | ac          | on=false, target_temp=26, fan_swing=false |
| tv                  | tv          | on=false, volume=30                       |
| door_lock           | door_lock   | locked=true                               |
| emergency           | emergency   | active=false, triggered_at=null           |

**状态字段约束**_

| 设备类型  | 字段         | 约束                         |
|-----------|--------------|------------------------------|
| light     | on           | bool                         |
| light     | brightness   | 0–100（%）                   |
| light     | color_temp   | 2700–6500（K）               |
| curtain   | position     | 0–100（%，0=全合，100=全开） |
| ac        | on           | bool                         |
| ac        | target_temp  | 16–30（℃），步长 1           |
| ac        | fan_swing    | bool                         |
| tv        | on           | bool                         |
| tv        | volume       | 0–100                        |
| door_lock | locked       | bool                         |
| emergency | active       | bool                         |
| emergency | triggered_at | epoch 毫秒 / null            |

**指令 → 状态迁移映射**（与 7.2 指令集对应，由 PB 状态机执行）

| cmd_id | device_id           | action            | 状态迁移                                   |
|--------|---------------------|-------------------|--------------------------------------------|
| CMD_01 | living_room_light   | toggle            | on 取反                                    |
| CMD_02 | living_room_curtain | toggle            | position 在 0 ↔ 100 间切换（PF 动画插值）  |
| CMD_03 | air_conditioner     | temp_up(step=1)   | target_temp +1，超过 30 返回 OUT_OF_RANGE  |
| CMD_04 | air_conditioner     | temp_down(step=1) | target_temp -1，低于 16 返回 OUT_OF_RANGE  |
| CMD_05 | tv                  | toggle            | on 取反                                    |
| CMD_06 | emergency           | emergency         | active=true，记录 triggered_at             |
| CMD_07 | bedroom_light       | brightness_cycle  | brightness 在 0 / 40 / 70 / 100 档位间循环 |
| CMD_08 | door_lock           | toggle            | locked 取反                                |

### 7.5 消息类型总览

| 通道 | 方向 | type                | payload                  | 说明                              |
|------|------|---------------------|--------------------------|-----------------------------------|
| SCB  | →    | hello               | HelloPayload             | 接入注册（role=scb）              |
| SCB  | →    | heartbeat           | HeartbeatPayload         | 心跳 + 采集在线状态，建议 5s 周期 |
| SCB  | →    | device_command      | DeviceCommandPayload     | SSVEP 解码指令（核心上行）        |
| SCB  | →    | decode_status       | DecodeStatusPayload      | 解码参数上报（连接后 / 变更时）   |
| SCB  | ←    | welcome             | WelcomePayload           | 注册确认 + 全量快照               |
| SCB  | ←    | command_ack         | CommandAckPayload        | 指令受理结果（点对点）            |
| SCB  | ←    | device_state_update | DeviceStateUpdatePayload | 状态广播（SCB 调试显示复用）      |
| SCB  | ←    | state_snapshot      | StateSnapshotPayload     | 全量快照                          |
| SCB  | ←    | config_update       | ConfigUpdatePayload      | 下发解码参数调整                  |
| SCB  | ←    | error               | ErrorPayload             | 协议错误                          |
| PF   | →    | hello               | HelloPayload             | 接入注册（role=pf）               |
| PF   | →    | state_request       | StateRequestPayload      | 请求全量快照（payload 为空对象）  |
| PF   | →    | ui_command          | UiCommandPayload         | 手动控制（调试 / 演示降级）       |
| PF   | ←    | welcome             | WelcomePayload           | 注册确认 + 全量快照               |
| PF   | ←    | state_snapshot      | StateSnapshotPayload     | 全量快照                          |
| PF   | ←    | device_state_update | DeviceStateUpdatePayload | 状态广播（核心下行）              |
| PF   | ←    | command_ack         | CommandAckPayload        | ui_command 受理结果               |
| PF   | ←    | error               | ErrorPayload             | 协议错误                          |

**端点约定**：PB 暴露两个 WebSocket 端点 `/ws/scb` 与 `/ws/pf` 做角色隔离，`hello.role` 作为二次校验。`welcome` 已携带全量快照，`state_request` 仅用于手动刷新。

### 7.6 SCB ↔ PB：Pydantic Schema（SCB 侧）

```python
"""
SCB ↔ PB WebSocket 协议 Schema（SCB 侧，Pydantic v2，Python >= 3.10）

- SCBOutbound：SCB → PB 上行消息集合
- SCBInbound ：PB → SCB 下行消息集合
序列化：msg.model_dump_json()
解析：TypeAdapter(SCBInbound).validate_json(raw)（按 type 自动分发到具体模型）
与 PB/PF 侧的 TypeScript 定义（见 7.7）字段一一对应，修改需双端同步。
"""
from __future__ import annotations

from enum import Enum
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

PROTOCOL_VERSION = 1


class StrictModel(BaseModel):
    """所有模型禁止未知字段，尽早暴露双端协议不一致"""
    model_config = ConfigDict(extra="forbid")


# ---------------- 1. 枚举 ----------------

class Role(str, Enum):
    SCB = "scb"
    PF = "pf"


class DeviceType(str, Enum):
    LIGHT = "light"
    CURTAIN = "curtain"
    AC = "ac"
    TV = "tv"
    DOOR_LOCK = "door_lock"
    EMERGENCY = "emergency"


class DeviceId(str, Enum):
    LIVING_ROOM_LIGHT = "living_room_light"      # 客厅主灯
    BEDROOM_LIGHT = "bedroom_light"              # 卧室灯
    LIVING_ROOM_CURTAIN = "living_room_curtain"  # 客厅窗帘
    AIR_CONDITIONER = "air_conditioner"          # 空调
    TV = "tv"                                    # 电视
    DOOR_LOCK = "door_lock"                      # 门锁
    EMERGENCY = "emergency"                      # 全屋紧急呼叫


class CommandId(str, Enum):
    """SSVEP 解码输出的 8 个固定指令（对应 7.2 指令集）"""
    CMD_01 = "CMD_01"
    CMD_02 = "CMD_02"
    CMD_03 = "CMD_03"
    CMD_04 = "CMD_04"
    CMD_05 = "CMD_05"
    CMD_06 = "CMD_06"
    CMD_07 = "CMD_07"
    CMD_08 = "CMD_08"


class Action(str, Enum):
    TOGGLE = "toggle"                      # 开关 / 开合 / 锁舌切换
    TEMP_UP = "temp_up"                    # 空调温度 +step ℃
    TEMP_DOWN = "temp_down"                # 空调温度 -step ℃
    BRIGHTNESS_CYCLE = "brightness_cycle"  # 灯光亮度档位循环
    EMERGENCY = "emergency"                # 触发紧急呼叫
    EMERGENCY_RESET = "emergency_reset"    # 解除紧急呼叫（仅手动 / 调试）


class ErrorCode(str, Enum):
    OK = "OK"
    INVALID_FORMAT = "INVALID_FORMAT"          # JSON 非法 / 字段校验失败
    UNKNOWN_TYPE = "UNKNOWN_TYPE"              # 未知的 type
    UNKNOWN_DEVICE = "UNKNOWN_DEVICE"          # device_id 不在注册表
    OUT_OF_RANGE = "OUT_OF_RANGE"              # 参数越界（如温度超 16–30）
    INVALID_TRANSITION = "INVALID_TRANSITION"  # 非法状态迁移
    COOLDOWN = "COOLDOWN"                      # 指令冷却中被拒绝
    INTERNAL = "INTERNAL"                      # 服务端内部错误


# ---------------- 2. 设备状态（PB 为唯一事实源） ----------------

class LightState(StrictModel):
    device_type: Literal[DeviceType.LIGHT]
    device_id: DeviceId
    on: bool
    brightness: int = Field(ge=0, le=100)      # %
    color_temp: int = Field(ge=2700, le=6500)  # K


class CurtainState(StrictModel):
    device_type: Literal[DeviceType.CURTAIN]
    device_id: DeviceId
    position: int = Field(ge=0, le=100)  # % 0=全合 100=全开


class AcState(StrictModel):
    device_type: Literal[DeviceType.AC]
    device_id: DeviceId
    on: bool
    target_temp: int = Field(ge=16, le=30)  # ℃
    fan_swing: bool = False                 # 风口摆动


class TvState(StrictModel):
    device_type: Literal[DeviceType.TV]
    device_id: DeviceId
    on: bool
    volume: int = Field(ge=0, le=100)


class DoorLockState(StrictModel):
    device_type: Literal[DeviceType.DOOR_LOCK]
    device_id: DeviceId
    locked: bool


class EmergencyState(StrictModel):
    device_type: Literal[DeviceType.EMERGENCY]
    device_id: DeviceId
    active: bool
    triggered_at: Optional[int] = None  # 触发时刻 epoch ms


DeviceState = Annotated[
    Union[LightState, CurtainState, AcState, TvState, DoorLockState, EmergencyState],
    Field(discriminator="device_type"),
]


# ---------------- 3. Payload ----------------

class HelloPayload(StrictModel):
    role: Role
    client_name: str     # 如 "scb"
    client_version: str  # 如 "0.1.0"


class HeartbeatPayload(StrictModel):
    """SCB 周期心跳（建议 5s），兼报采集在线状态"""
    acq_connected: bool                     # ND8 TCP 是否在线
    decode_rate_hz: Optional[float] = None  # 实际解码频率


class DecodeStatusPayload(StrictModel):
    """解码运行参数上报（连接后及参数变更时发送）"""
    acq_connected: bool
    sample_rate: int = Field(ge=100)  # Hz
    channels: list[str]               # ["Oz", "O1", "O2", "POz"]
    decode_window_s: float = Field(gt=0)
    threshold: float = Field(ge=0, le=1)


class CommandParams(StrictModel):
    step: int = Field(default=1, ge=1, le=5)  # 空调温度步长 ℃


class Evidence(StrictModel):
    """解码证据（PB 仅记录日志，不参与路由）"""
    freq_hz: float      # FBCCA 识别出的刺激频率
    window_ms: int
    confirm_count: int  # 连续一致窗口数


class DeviceCommandPayload(StrictModel):
    """SSVEP 解码指令（SCB 核心上行消息）"""
    cmd_id: CommandId
    device_id: DeviceId
    action: Action
    params: CommandParams = Field(default_factory=CommandParams)
    confidence: float = Field(ge=0, le=1)  # 相关系数 ρ
    evidence: Optional[Evidence] = None


class StateRequestPayload(StrictModel):
    """请求全量快照（重连 / 手动刷新），payload 为空对象"""
    pass


class UiCommandPayload(StrictModel):
    """PF 手动控制（调试 / 无 BCI 演示降级），语义与 device_command 一致"""
    device_id: DeviceId
    action: Action
    params: CommandParams = Field(default_factory=CommandParams)


class TriggerInfo(StrictModel):
    cmd_id: CommandId  # 触发本次变更的指令
    cmd_seq: int       # 该指令在发送端连接内的 seq


class CommandAckPayload(StrictModel):
    """指令受理结果（仅回给指令发送方）"""
    ack_seq: int                         # 被确认消息的 seq
    ok: bool
    code: ErrorCode = ErrorCode.OK
    message: str = ""
    state: Optional[DeviceState] = None  # 受理成功时返回新状态


class DeviceStateUpdatePayload(StrictModel):
    """设备状态变更广播（PB → 全部 PF 与 SCB）"""
    update_id: int      # PB 全局单调递增，接收方用于乱序 / 丢包检测
    device_id: DeviceId
    state: DeviceState  # 变更后的完整状态
    source: Literal["scb", "manual"]
    trigger: Optional[TriggerInfo] = None


class StateSnapshotPayload(StrictModel):
    """全量状态快照（welcome 携带 / state_request 应答）"""
    update_id: int
    server_ts: int
    devices: list[DeviceState]


class ConfigUpdatePayload(StrictModel):
    """PB → SCB 下发解码参数（仅携带需修改的字段）"""
    threshold: Optional[float] = Field(default=None, ge=0, le=1)
    confirm_count: Optional[int] = Field(default=None, ge=1, le=10)
    cooldown_s: Optional[float] = Field(default=None, ge=0, le=30)
    decode_window_s: Optional[float] = Field(default=None, gt=0, le=8)


class WelcomePayload(StrictModel):
    """hello 应答，携带分配的 client_id 与全量快照"""
    client_id: str
    server_ts: int
    snapshot: StateSnapshotPayload


class ErrorPayload(StrictModel):
    """协议级错误（校验失败 / 无法路由时回给发送方）"""
    code: ErrorCode
    message: str
    ref_seq: Optional[int] = None  # 关联的出错消息 seq


# ---------------- 4. 消息信封 ----------------

class MessageBase(StrictModel):
    v: Literal[PROTOCOL_VERSION] = PROTOCOL_VERSION
    seq: int = Field(ge=0, description="发送端连接内单调递增")
    ts: int = Field(ge=0, description="发送时刻 epoch 毫秒")


# ---- SCB → PB ----

class HelloMsg(MessageBase):
    type: Literal["hello"]
    payload: HelloPayload


class HeartbeatMsg(MessageBase):
    type: Literal["heartbeat"]
    payload: HeartbeatPayload


class DeviceCommandMsg(MessageBase):
    type: Literal["device_command"]
    payload: DeviceCommandPayload


class DecodeStatusMsg(MessageBase):
    type: Literal["decode_status"]
    payload: DecodeStatusPayload


# ---- PB → SCB（welcome / state_update / snapshot / ack / error 与 PF 通道复用）----

class WelcomeMsg(MessageBase):
    type: Literal["welcome"]
    payload: WelcomePayload


class CommandAckMsg(MessageBase):
    type: Literal["command_ack"]
    payload: CommandAckPayload


class DeviceStateUpdateMsg(MessageBase):
    type: Literal["device_state_update"]
    payload: DeviceStateUpdatePayload


class StateSnapshotMsg(MessageBase):
    type: Literal["state_snapshot"]
    payload: StateSnapshotPayload


class ConfigUpdateMsg(MessageBase):
    type: Literal["config_update"]
    payload: ConfigUpdatePayload


class ErrorMsg(MessageBase):
    type: Literal["error"]
    payload: ErrorPayload


# ---------------- 5. 通道消息集合（判别联合） ----------------

SCBOutbound = Annotated[  # SCB → PB
    Union[HelloMsg, HeartbeatMsg, DeviceCommandMsg, DecodeStatusMsg],
    Field(discriminator="type"),
]

SCBInbound = Annotated[  # PB → SCB
    Union[WelcomeMsg, CommandAckMsg, DeviceStateUpdateMsg,
          StateSnapshotMsg, ConfigUpdateMsg, ErrorMsg],
    Field(discriminator="type"),
]
```

**SCB 侧收发示例**_

```python
# 发送：模型 → JSON
import time

cmd = DeviceCommandMsg(
    seq=next_seq(),                      # 连接内自增计数器
    ts=time.time_ns() // 1_000_000,
    payload=DeviceCommandPayload(
        cmd_id=CommandId.CMD_03,
        device_id=DeviceId.AIR_CONDITIONER,
        action=Action.TEMP_UP,
        confidence=0.87,
        evidence=Evidence(freq_hz=11.0, window_ms=3000, confirm_count=3),
    ),
)
await ws.send_str(cmd.model_dump_json())

# 接收：JSON → 模型（按 type 自动分发）
adapter = TypeAdapter(SCBInbound)
event = adapter.validate_json(raw)
match event:
    case CommandAckMsg():
        ...  # 核对 ack_seq / code
    case DeviceStateUpdateMsg():
        ...  # 调试面板显示
    case _:
        ...
```

### 7.7 PB ↔ PF：TypeScript 接口（PB / PF 侧共用）

```typescript
/**
 * WebSocket 通信协议类型定义（PB 仿真状态层 / PF 仿真渲染层共用）
 *
 * 说明：TS 接口为编译期约束；PB 收到 SCB/PF 消息时建议用 zod 等
 * 做一次运行时校验（可选），以对齐 Pydantic 的 extra=forbid 行为。
 */

// ---------- 1. 枚举与常量 ----------

export const PROTOCOL_VERSION = 1;

export type Role = 'scb' | 'pf';

export type DeviceType =
  | 'light' | 'curtain' | 'ac' | 'tv' | 'door_lock' | 'emergency';

export type DeviceId =
  | 'living_room_light'
  | 'bedroom_light'
  | 'living_room_curtain'
  | 'air_conditioner'
  | 'tv'
  | 'door_lock'
  | 'emergency';

export type CommandId =
  | 'CMD_01' | 'CMD_02' | 'CMD_03' | 'CMD_04'
  | 'CMD_05' | 'CMD_06' | 'CMD_07' | 'CMD_08';

export type Action =
  | 'toggle'
  | 'temp_up'
  | 'temp_down'
  | 'brightness_cycle'
  | 'emergency'
  | 'emergency_reset';

export type ErrorCode =
  | 'OK'
  | 'INVALID_FORMAT'
  | 'UNKNOWN_TYPE'
  | 'UNKNOWN_DEVICE'
  | 'OUT_OF_RANGE'
  | 'INVALID_TRANSITION'
  | 'COOLDOWN'
  | 'INTERNAL';

/** CMD_xx → (device_id, action) 映射，PB 状态机据此路由（对应 7.4 迁移表） */
export const COMMAND_MAP: Record<CommandId, { device_id: DeviceId; action: Action }> = {
  CMD_01: { device_id: 'living_room_light', action: 'toggle' },
  CMD_02: { device_id: 'living_room_curtain', action: 'toggle' },
  CMD_03: { device_id: 'air_conditioner', action: 'temp_up' },
  CMD_04: { device_id: 'air_conditioner', action: 'temp_down' },
  CMD_05: { device_id: 'tv', action: 'toggle' },
  CMD_06: { device_id: 'emergency', action: 'emergency' },
  CMD_07: { device_id: 'bedroom_light', action: 'brightness_cycle' },
  CMD_08: { device_id: 'door_lock', action: 'toggle' },
};

// ---------- 2. 设备状态 ----------

export interface LightState {
  device_type: 'light';
  device_id: DeviceId;
  on: boolean;
  brightness: number;   // 0–100
  color_temp: number;   // 2700–6500 K
}

export interface CurtainState {
  device_type: 'curtain';
  device_id: DeviceId;
  position: number;     // 0–100，0=全合 100=全开
}

export interface AcState {
  device_type: 'ac';
  device_id: DeviceId;
  on: boolean;
  target_temp: number;  // 16–30 ℃
  fan_swing: boolean;
}

export interface TvState {
  device_type: 'tv';
  device_id: DeviceId;
  on: boolean;
  volume: number;       // 0–100
}

export interface DoorLockState {
  device_type: 'door_lock';
  device_id: DeviceId;
  locked: boolean;
}

export interface EmergencyState {
  device_type: 'emergency';
  device_id: DeviceId;
  active: boolean;
  triggered_at: number | null;  // epoch ms
}

export type DeviceState =
  | LightState
  | CurtainState
  | AcState
  | TvState
  | DoorLockState
  | EmergencyState;

// ---------- 3. Payload ----------

export interface HelloPayload {
  role: Role;
  client_name: string;
  client_version: string;
}

export interface WelcomePayload {
  client_id: string;
  server_ts: number;
  snapshot: StateSnapshotPayload;
}

export interface HeartbeatPayload {
  acq_connected: boolean;
  decode_rate_hz?: number;
}

export interface DecodeStatusPayload {
  acq_connected: boolean;
  sample_rate: number;    // Hz
  channels: string[];     // ["Oz", "O1", "O2", "POz"]
  decode_window_s: number;
  threshold: number;      // 0–1
}

export interface CommandParams {
  step?: number;          // 空调温度步长，默认 1
}

export interface Evidence {
  freq_hz: number;
  window_ms: number;
  confirm_count: number;
}

export interface DeviceCommandPayload {
  cmd_id: CommandId;
  device_id: DeviceId;
  action: Action;
  params?: CommandParams;
  confidence: number;     // 0–1
  evidence?: Evidence;
}

export interface StateRequestPayload {
  // 空对象
}

export interface UiCommandPayload {
  device_id: DeviceId;
  action: Action;
  params?: CommandParams;
}

export interface TriggerInfo {
  cmd_id: CommandId;
  cmd_seq: number;
}

export interface CommandAckPayload {
  ack_seq: number;
  ok: boolean;
  code: ErrorCode;
  message: string;
  state?: DeviceState;
}

export interface DeviceStateUpdatePayload {
  update_id: number;      // PB 全局单调递增
  device_id: DeviceId;
  state: DeviceState;
  source: 'scb' | 'manual';
  trigger?: TriggerInfo;
}

export interface StateSnapshotPayload {
  update_id: number;
  server_ts: number;
  devices: DeviceState[];
}

export interface ConfigUpdatePayload {
  threshold?: number;
  confirm_count?: number;
  cooldown_s?: number;
  decode_window_s?: number;
}

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  ref_seq?: number;
}

// ---------- 4. 消息信封 ----------

export interface BaseMessage {
  v: typeof PROTOCOL_VERSION;
  /** 发送端连接内单调递增 */
  seq: number;
  /** 发送时刻 epoch 毫秒 */
  ts: number;
}

// ---- 通用（两通道复用） ----

export interface HelloMsg extends BaseMessage { type: 'hello'; payload: HelloPayload; }
export interface WelcomeMsg extends BaseMessage { type: 'welcome'; payload: WelcomePayload; }
export interface CommandAckMsg extends BaseMessage { type: 'command_ack'; payload: CommandAckPayload; }
export interface DeviceStateUpdateMsg extends BaseMessage { type: 'device_state_update'; payload: DeviceStateUpdatePayload; }
export interface StateSnapshotMsg extends BaseMessage { type: 'state_snapshot'; payload: StateSnapshotPayload; }
export interface ErrorMsg extends BaseMessage { type: 'error'; payload: ErrorPayload; }

// ---- SCB → PB ----

export interface HeartbeatMsg extends BaseMessage { type: 'heartbeat'; payload: HeartbeatPayload; }
export interface DeviceCommandMsg extends BaseMessage { type: 'device_command'; payload: DeviceCommandPayload; }
export interface DecodeStatusMsg extends BaseMessage { type: 'decode_status'; payload: DecodeStatusPayload; }

// ---- PF → PB ----

export interface StateRequestMsg extends BaseMessage { type: 'state_request'; payload: StateRequestPayload; }
export interface UiCommandMsg extends BaseMessage { type: 'ui_command'; payload: UiCommandPayload; }

// ---- PB → SCB ----

export interface ConfigUpdateMsg extends BaseMessage { type: 'config_update'; payload: ConfigUpdatePayload; }

// ---------- 5. 通道消息集合 ----------

/** PB 视角：从 SCB 接收 */
export type FromScb = HelloMsg | HeartbeatMsg | DeviceCommandMsg | DecodeStatusMsg;
/** PB 视角：发送给 SCB */
export type ToScb = WelcomeMsg | CommandAckMsg | DeviceStateUpdateMsg | StateSnapshotMsg | ConfigUpdateMsg | ErrorMsg;
/** PB 视角：从 PF 接收 */
export type FromPf = HelloMsg | StateRequestMsg | UiCommandMsg;
/** PB 视角：发送给 PF */
export type ToPf = WelcomeMsg | StateSnapshotMsg | DeviceStateUpdateMsg | CommandAckMsg | ErrorMsg;

/** 按类型收窄消息（PF 侧常用） */
export function isType<T extends ToPf['type']>(msg: ToPf, type: T): msg is Extract<ToPf, { type: T }> {
  return msg.type === type;
}
```

**PF 侧消息处理示例**_

```typescript
// WebSocket onmessage → Pinia 状态 → Three.js 动画
const msg = JSON.parse(raw) as ToPf;

switch (msg.type) {
  case 'state_snapshot':
    deviceStore.replaceAll(msg.payload.devices);
    break;
  case 'device_state_update':
    deviceStore.apply(msg.payload.state);  // 按 device_id 更新，驱动 3D 过渡动画
    break;
  case 'command_ack':
    if (!msg.payload.ok) console.warn('指令被拒绝:', msg.payload.code);
    break;
  case 'error':
    console.error('协议错误:', msg.payload.code, msg.payload.message);
    break;
}
```

### 7.8 报文示例

```json
// SCB → PB：解码指令
{
  "v": 1,
  "type": "device_command",
  "seq": 42,
  "ts": 1760000000000,
  "payload": {
    "cmd_id": "CMD_03",
    "device_id": "air_conditioner",
    "action": "temp_up",
    "params": { "step": 1 },
    "confidence": 0.87,
    "evidence": { "freq_hz": 11.0, "window_ms": 3000, "confirm_count": 3 }
  }
}
```

```json
// PB → PF：状态变更广播
{
  "v": 1,
  "type": "device_state_update",
  "seq": 1024,
  "ts": 1760000000150,
  "payload": {
    "update_id": 87,
    "device_id": "air_conditioner",
    "state": {
      "device_type": "ac",
      "device_id": "air_conditioner",
      "on": true,
      "target_temp": 27,
      "fan_swing": false
    },
    "source": "scb",
    "trigger": { "cmd_id": "CMD_03", "cmd_seq": 42 }
  }
}
```

```json
// PB → SCB：指令受理确认
{
  "v": 1,
  "type": "command_ack",
  "seq": 1025,
  "ts": 1760000000151,
  "payload": {
    "ack_seq": 42,
    "ok": true,
    "code": "OK",
    "message": "",
    "state": {
      "device_type": "ac",
      "device_id": "air_conditioner",
      "on": true,
      "target_temp": 27,
      "fan_swing": false
    }
  }
}
```

### 7.9 交互时序与通用约定

**指令执行时序**_

```plain
SCB（意图抽象层）              PB（仿真状态层）                PF（仿真渲染层）
     │ ws 连接 /ws/scb              │                               │ ws 连接 /ws/pf
     │ ── hello(scb) ─────────────► │                               │
     │ ◄─ welcome(含全量快照) ───── │                               │ ── hello(pf) ─────────────►
     │                              │                               │ ◄─ welcome(含全量快照) ────
     │                              │                               │
     │ ── device_command(seq=42) ─► │ 校验 → 冷却检查 → 状态机迁移  │
     │                              │ ── device_state_update ─────► │ 3D 动画 + 状态面板刷新
     │ ◄─ command_ack(ack_seq=42) ─ │                               │
     │ ◄─ device_state_update ───── │ （SCB 调试显示复用同一广播）   │
     │                              │                               │
     │ ── heartbeat(每 5s) ───────► │                               │
```

**通用约定**_

1. 编码 UTF-8，字段命名 snake_case，单帧单消息（WebSocket 按帧边界解析）。
2. `ts` 为 UTC epoch 毫秒；`seq` 连接内递增；`update_id` 由 PB 全局递增，接收方据此检测乱序 / 丢包。
3. PB 是设备状态唯一事实源（SSOT），PF / SCB 不做本地状态推导，一律以 `device_state_update` / `state_snapshot` 为准。
4. `ui_command`（手动控制）不受指令冷却约束（便于调试），但走完整校验与状态机流程。
5. 紧急呼叫（`emergency.active=true`）触发后，通过 `ui_command(emergency_reset)` 复位，PB 记录完整指令流水。
6. 协议演进：新增可选字段为向后兼容（`v` 不变）；删除或改名字段必须升级 `v`，并同步更新 7.6 / 7.7 双端定义。

**错误码表**_

| 错误码             | 触发场景                     | 发送方处理建议     |
|--------------------|------------------------------|--------------------|
| OK                 | 受理成功                     | —                  |
| INVALID_FORMAT     | JSON 解析失败 / 字段校验失败 | 检查协议版本与字段 |
| UNKNOWN_TYPE       | type 未注册                  | 升级协议 / 忽略    |
| UNKNOWN_DEVICE     | device_id 不在注册表         | 校对设备 ID        |
| OUT_OF_RANGE       | 状态迁移越界（如温度超限）   | 提示用户 / 忽略    |
| INVALID_TRANSITION | 当前状态不允许该操作         | 忽略               |
| COOLDOWN           | 命中指令冷却窗口             | 提示用户稍候       |
| INTERNAL           | PB 内部异常                  | 记录日志后重试     |

---

## 八、开发实施计划

### 8.1 里程碑

| 阶段                  | 周期 | 交付物                                                                                  | 负责模块                          |
|-----------------------|------|-----------------------------------------------------------------------------------------|-----------------------------------|
| M1：辅助意图层（SCF） | 2 周 | 复用 NDDrone-SDK 刺激模块：重生成帧图、适配区块布局与参数配置                           | SDK 复用 + AI 辅助适配            |
| M2：意图抽象层（SCB） | 3 周 | 复用 NDDrone-SDK 采集/解码基线、频率重标定、CAR 与决策引擎、SCB→PB WebSocket 桥接客户端 | **团队人工开发（基于 SDK 复用）** |
| M3：仿真状态层（PB）  | 2 周 | WebSocket 服务端、设备状态机、消息路由                                                  | AI 辅助生成                       |
| M4：仿真渲染层（PF）  | 3 周 | Three.js 室内场景、设备模型、状态动画                                                   | AI 辅助生成                       |
| M5：系统联调          | 2 周 | 端到端联调、延迟优化、防误触调参                                                        | 团队协作                          |
| M6：演示封装          | 1 周 | Docker 部署、演示脚本、操作手册                                                         | 团队协作                          |

### 8.2 团队分工（4 人）

| 角色   | 职责           | 备注                                                       |
|--------|----------------|------------------------------------------------------------|
| 成员 A | SCB 算法负责人 | FBCCA 频率重标定、预处理适配（CAR）、决策引擎与防误触      |
| 成员 B | SCB 客户端开发 | NDDrone-SDK 采集接入适配、aiohttp WebSocket 桥接、指令封装 |
| 成员 C | PF 前端协调    | Vue + Three.js 场景联调、UI 状态管理、与 PB 接口对接       |
| 成员 D | PB 后端协调    | ElysiaJS 服务维护、WebSocket 路由、设备状态机、部署运维    |

---

## 九、验证指标

| 指标             | 目标值                   | 测量方法                 |
|------------------|--------------------------|--------------------------|
| SSVEP 识别准确率 | ≥ 90%（4 指令，3s 窗口） | 10 名被试 × 每指令 20 次 |
| 端到端延迟       | ≤ 4 秒（注视到场景响应） | 高速摄像/日志时间戳      |
| 误触发率         | ≤ 3%                     | 自由使用场景 30 分钟统计 |
| SCF 频率误差     | ≤ 0.1 Hz                 | 光电传感器实测校准       |
| PF 场景帧率      | ≥ 60 FPS                 | Chrome Performance 面板  |

---

## 十、风险与应对

| 风险                   | 影响                         | 应对策略                                                                           |
|------------------------|------------------------------|------------------------------------------------------------------------------------|
| SCF 渲染帧率不稳定     | 刺激频率漂移，解码准确率下降 | 使用 PsychoPy 独立窗口呈现；基于时间戳驱动相位；定期校准                           |
| ND8 TCP 连接中断       | 数据丢失，解码失败           | TCP 自动重连；本地缓存未处理数据；连接状态实时显示                                 |
| 被试个体差异大         | 识别率低                     | 提供个体校准流程；刺激频率按被试敏感度自适应调整                                   |
| 第三方/AI 代码可维护性 | 后期调试困难                 | 桥接层等核心新增逻辑人工开发；NDDrone-SDK 复用代码与 AI 生成代码需充分测试与文档化 |
| 多设备网络延迟         | 端到端延迟超标               | 局域网部署；SCB 与 PB 同机或近端部署；禁用 Nagle 算法                              |

---

## 十一、附录

### 11.1 与真实硬件系统的迁移路径

本仿真平台采用与真实智能家居一致的 MQTT 风格主题命名与 JSON 指令格式。未来接入实体硬件时，仅需将仿真状态层（PB）的 WebSocket 消息桥接至 MQTT Broker（如 Mosquitto），并将仿真渲染层（PF）的 Three.js 场景状态与真实设备状态双向同步，无需修改意图抽象层（SCB）解码端与辅助意图层（SCF）刺激端逻辑。

### 11.2 参考标准

- Three.js 官方文档（r160+）
- PsychoPy 官方文档
- 广东神舞科技 ND8 设备技术手册
- [NDDrone-SDK](https://github.com/FallingShrimp/NDDrone-SDK)：SSVEP 意念无人机开源系统，本项目 SCF/SCB 刺激、采集与解码模块的复用来源
- IEEE Std 2048.1-2021《脑机接口系统性能评估标准》
- 《稳态视觉诱发电位脑机接口技术规范》团体标准（T/CESA 相关）
