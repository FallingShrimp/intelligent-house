# game.md — 圆盘竞技场联机对战（独立项目设计）

> 本文档描述从「脑控智能家居仿真平台」中提取出的联机对战游戏，作为**独立新项目**的机制设计与还原依据。
> 战斗 / 词条 / 卡牌 / 升级等子系统完整继承自已分离的旧实现（数值与逻辑均以此为准），场景与刷怪机制按新设计执行。

## 1. 系统总览

一套 **PB 权威联机 PVE 割草竞技场**，不再依赖智能家居 3D 场景：

- **PB**（`pb/src/world.ts`，Bun + TS）：唯一事实源。世界模拟 10Hz tick，裁决伤害 / 僵尸 AI / 格挡 / 体力 / 蓄力 / 弹道 / 经验升级；每 tick 广播 `world` 快照 + 瞬时 `event`。
- **PF**（`pf/src/three/`）：纯表现层。本地武器视模型动画 / 意图上报（`mp_action`）/ 输入状态上报（`mp_input` 10Hz）/ 快照插值渲染（僵尸、远程玩家、弹道）/ HUD。
- **场景**：**圆盘形竞技场**（平坦圆盘地面，半径 `ARENA_RADIUS` 暂定 14m，边缘外为虚空/雾）。**场地中心是一座祭坛，祭坛上方悬浮一把红色巨剑**。
- **开局**：玩家进入第一人称后，**准星点击祭坛上的红剑 → 游戏开始**（`start` 意图上报，PB 权威启动刷怪计时）。开局前世界处于 idle（无僵尸、不刷怪、可自由跑动熟悉地图）。
- **刷怪**：游戏开始后，**每 3 秒从圆盘边缘随机角度生成一只僵尸**，朝场内玩家进攻。
- **成长**：**每次玩家击杀一只僵尸，之后生成的僵尸等级 +1**（全局击杀数即下一只僵尸的等级，全员共享、逐只递增）。击杀得经验 → 场景升级 → 全员三选一抽卡强化。
- 玩家间有友伤；死亡可等待队友复活（点击尸体）或清场后手动复活。

## 2. 项目结构（独立新项目）

延续 PB/PF 双端架构（协议、消息信封、连接管理直接复用旧实现）：

| 文件 | 内容 |
|---|---|
| `pb/src/index.ts` | WS 服务（/ws/scb、/ws/pf）、hello/welcome、mp_input/mp_action 路由、10Hz world loop |
| `pb/src/world.ts` | 权威世界模拟（战斗 / 僵尸 AI / 弹道 / 经验升级 / 刷怪） |
| `pb/src/protocol.ts` | 消息 Schema（hello display_name、MpInput、MpAction） |
| `pb/scripts/multi_smoke.ts` | 冒烟测试（接入 / 开局 / 刷怪 / 战斗链路） |
| `pf/src/three/arena.ts` | **新**：圆盘竞技场静态场景（盘面 / 祭坛 / 悬浮红剑 / 边缘雾） |
| `pf/src/three/combat.ts` | PlayerCombat 编排器 + BaseWeapon + Sword/Bow 武器实现 |
| `pf/src/three/zombie.ts` / `RemotePlayers.ts` / `audio.ts` / `sword.ts` / `bow.ts` | 表现层（整体复用） |
| `pf/src/three/SceneManager.ts` | 场景管理（去掉智能家居设备/交互，新增祭坛红剑交互） |
| `pf/src/components/*` | HUD / 排行榜 / 词条面板 / ExpBar / LevelUpBanner / BuffPickModal / DeathOverlay / DisplayNameModal（整体复用） |

相比旧项目删除：devices.ts / room.ts（智能家居房间与设备）、tween.ts 设备动画部分、DevicePanel / EmergencyBanner / MockCommandPanel / StatusBar 及 Pinia 设备 store。

## 3. 协议（游戏增量）

在通用消息信封（v/type/seq/ts/payload）之上的游戏消息：

- **hello**：PF 携带 `display_name`（必填，联机身份）。welcome 额外携带 `you: PlayerYou { uuid, name, color }`。
- **mp_input**（PF→PB，10Hz）：`{ fp, anim, p:[x,y,z], yaw, dir:[dirX,dirZ], dir3:[x,y,z] }`。位置 / 朝向 / 相机 3D 前向（剑气与弹道飞行方向）/ 动作标签（anim：swing0/1/2、counter、chase、block、shoot、beam、charge、stab|<pitch>）。
- **mp_action**（PF→PB，瞬时意图）：`kind` ∈
  - `start`（点击祭坛红剑：请求开局，PB 校验 idle 态）
  - `attack`（segment: 0/1/2 三段、3 空中戳刺）
  - `shoot`（苍弓射球）· `charge_start` / `charge_stop`（苍弓蓄力）
  - `wave`（hold：剑气按住秒数）· `weapon`（切换武器）
  - `parry_start` / `parry_stop`（格挡起手 / 结束）
  - `pick`（idx：三选一选择）· `respawn` · `revive`（uuid：复活队友）· `dash`
- **world**（PB→PF，随 tick 10Hz）：WorldSnapshot（见 §7，含 `phase: idle|running|pick`）。
- **event**（PB→PF，瞬时广播）：MpEvent 数组（见 §7）。

## 4. PB 世界模拟（world.ts）

### 4.1 核心常量

```ts
// 竞技场 / 刷怪（新机制）
ARENA_RADIUS=14          // 圆盘半径 m（PF 盘面 / 出界判定对齐）
SPAWN_INTERVAL_S=3.0     // 刷怪间隔（phase=running 时每 3s 一只）
MAX_ZOMBIES=8            // 场上僵尸上限（超出则跳过该次生成，暂定可调）
Z_SPAWN_R=ARENA_RADIUS   // 生成点：圆盘边缘随机角度（极坐标 r=R, θ=2π×rand）
// 僵尸
Z_BASE_HP=100  Z_HP_PER_LEVEL=25  Z_DMG_PER_LEVEL=0.25   // HP=100+25×等级；伤害+0.25×等级
Z_MAX_ST=100  Z_CHASE_SPEED=0.95  Z_ENTER_SPEED=1.0
Z_ATTACK_RANGE=1.7  Z_STRIKE_RANGE=2.15
Z_WINDUP_S=1.0  Z_RECOVER_S=1.1  Z_STUN_S=5.0  Z_ATTACK_COST=10
SWEEP_COST=15  SWEEP_CD=8  SWEEP_RANGE=2.2
LUNGE_COST=20  LUNGE_CD=10  LUNGE_MIN=2.5  LUNGE_MAX=5.0  LUNGE_SPEED=8.0  LUNGE_HIT_R=1.2  LUNGE_TIMEOUT=1.2
ROAR_CD=25  ROAR_MAX_USES=2  ROAR_HEAL=30  ROAR_RADIUS=3.0
COUNTER_WINDOW_S=1.0  CHASE_WINDOW_S=2.0
SWEEP_TRACK_S=8  ZOMBIE_TTL_DEAD=2.0
Z_HIT_R=0.55  Z_HIT_H=1.9      // 碰撞圆柱：3 层×5 采样点判定
// 玩家
P_MAX_HP=100  P_MAX_ST=100  P_STUN_S=3  P_REGEN=10  P_REGEN_DELAY=1.5
BLOCK_MAX_S=1.0  BLOCK_CD_S=0.5  GUARD_BREAK_S=0.55
SWEEP_BLOCK_STAMINA=15  ROAR_STAMINA=25
COMBO_MUL=[0.9, 0.9, 1.5]      // 三段倍率，伤害 = atk×倍率×dmgMul
REACH=3.0  REACH_ANGLE=0.55  COUNTER_REACH=3.4
// 弹道
WAVE_SPEED=12  WAVE_TTL_S=1.2  WAVE_RADIUS=0.9          // 剑气
ORB_SPEED=16  ORB_TTL_S=6  ORB_TICK_S=0.1  ORB_HIT_Z=0.55  ORB_HIT_P=0.6   // 球状闪电
BEAM_TICK_S=0.2  BEAM_RANGE=20  BEAM_HIT_Z=0.55  BEAM_HIT_P=0.6            // 激光
```

### 4.2 僵尸 AI 状态机

状态：`enter → chase → windup → strike → recover`（循环）+ `sweep` / `lungeWind → lungeDash` / `roar` / `stunned` / `dead`。

- **enter**：在圆盘边缘生成点从地面钻出（PF 0.45s 升起动画），向场内移动。
- **chase**：追最近目标（快照 `target` 字段）。攻击距离内 → windup；体力足够且冷却好时按条件触发技能。
- **windup**（1.0s 前摇）：举手发抖；PF 播 flashAlert 预警音（金四角星=可格挡普攻）。结束 → strike。
- **strike**：Z_STRIKE_RANGE 内对目标结算普攻伤害，扣 10 体力 → recover。
- **recover**（1.1s）→ 回 chase。短前摇期间被打会刷新 recExtra 延长。
- **sweep（横扫）**：多目标时触发（cost 15，cd 8s，范围 2.2）。前摇 PF 白色四角星预警——**不可格挡**（必须闪避），格挡中被打中则破防（guardbreak 0.55s）+ 扣 15 体力。命中后被横扫目标进入 Z 轴追踪（SWEEP_TRACK_S=8s 优先级）。
- **lungeWind → lungeDash（突进）**：目标距离 2.5–5.0m 时触发（cost 20，cd 10s）。蓄力 0.5s（紫色四角星预警）→ 以 8 m/s 冲刺 ≤1.2s，命中半径 1.2，命中则打断玩家动作 + 破防 + 剧烈击退；冲到 LUNGE_MAX 或超时未命中 → recover 硬直（recExtra 加长，PF 端可白嫖）。
- **roar（嘶吼）**：玩家使用格挡流时触发（cd 25s，最多 2 次）。前摇 PF 红圈预警（半径 3.0），结束对范围内玩家扣 25 体力 + 减速 + 破防，僵尸自身回 30 体力；被打断（roar_interrupt）则不结算。
- **stunned（眩晕）**：体力耗尽 → 眩晕 5s，**眩晕瞬间掷定易伤系数 vulnMul = 1.15~1.85**。眩晕后 1s 内（COUNTER_WINDOW_S）任一玩家攻击 → 反击 300% + 开启全局追击窗口。眩晕期间 PF 摇晃动画；体力耗尽型眩晕结束后体力回满。
- **dead**：hp≤0 → 后仰倒地淡出（PF 本地动画），2s 后移除；结算经验，**全局击杀数 +1（下一只生成僵尸等级 = 击杀数）**。

### 4.3 玩家与伤害体系

- 伤害统一走 `DamageSource { from, amount, sign: DamageSign(Heal/Blocked/Normal/Crit), impact }` 结算；impact 为受击者扣体力基值（普攻段 3、空中戳刺 25；受击者按 稳定性/冲击力 公式折算）。
- **攻击力**：`atk 初始 10`；各段伤害 = `atk × COMBO_MUL[i] × dmgMul`（普攻）；反击 `atk×3`；追击 `atk×1.2`；空中戳刺同首段。
- **暴击**：critRate 初始 5%，critDmg 初始 +100%（即 2 倍）；暴击 DamageSign.Crit（PF 金色飘字）。
- **防御 def**（初始 10）与 **稳定性 stability**（初始 100%）参与受伤折算。
- **荆棘 thorn**：近战受击反伤；**吸血 lifesteal**：造成近战伤害回血。
- **体力**：上限 100；耗尽 → exhaust 眩晕（结束后回满）；1.5s 未用体力后 10/s 回复。
- **格挡（仅无锋剑，parry_start/parry_stop）**：
  - 最长持续 `blockMaxS`（初始 1.0s）；结束后冷却 `BLOCK_CD_S=0.5s`。
  - **完美格挡窗口 = blockMaxS × parryPct**（parryPct 初始 50%）：窗口内格挡普攻 → 完美（PF 金闪光 + perfectParry 音效），不进冷却可立即再格挡；僵尸普攻被完美格挡额外扣体力（加速眩晕）。
  - 窗口外普通格挡：25% 概率失败（不完美），成功则扣体力并退出格挡进冷却（`endBlockSuccess` 决定是否进冷却）；**化气 huaqi（初始 30%）**：格挡时将部分伤害转化恢复。
  - 横扫 / 嘶吼不可格挡：命中 → guardbreak（0.55s 硬直，吞输入）。
- **闪避 dash**：Shift+方向，PF 本地位移爆发（DASH_SPEED=8.5，CD 0.6s），PB 侧 `dash` 上报后 0.3s 无敌帧（dashInvulnUntil）。
- **死亡**：hp≤0 强制结束格挡，渲染尸体（可被队友准星点击 revive）；点击「复活」→ respawn 到祭坛旁出生点。
- **出界**：玩家与僵尸位置钳制在圆盘内（`r ≤ ARENA_RADIUS - Z_HIT_R/P_HIT_R`），击退不推出盘外。

### 4.4 武器系统（PB 侧 BaseWeapon）

```
BaseWeapon { weaponName, attackTime, normalAttack, parry?, startCharge, stopCharge, heavyAttack, maxChargeReached, tick? }
```

**无锋剑 SwordWeapon**（attackTime=0.3s）：
- 三段连击 0.9/0.9/1.5；反击 300% / 追击 120%（见 4.3）；空中戳刺 segment=3。
- 蓄力重击 = **剑气**：`heavyAttack(hold)` → `effHold = min(hold × chargeSpd, chargeMax)`，伤害 = `atk × 300% × effHold × dmgMul`；发射扇形弹道 Wave（速度 12、寿命 1.2s≈14m、命中半径 0.9、面基随机 roll）。**蓄力时长 = chargeMax / chargeSpd**（蓄力速度越快充满越快）。`chargeMax` 初始 1.0、`chargeSpd` 初始 100%。
- 连发剑气队列：multiWave 词条 >0 时，wave 后按 0.1s 间隔追加发射（waveQueue/waveNextAt）。
- PB 侧无蓄力状态（剑蓄力纯 PF 本地概念，wave 上报时用 hold 结算）。

**苍弓 BowWeapon**（attackTime=0.3s，不可格挡）：
- **普攻射球**：`shoot` → 球状闪电 Orb（速度 16，寿命 6s）；飞行中逐帧采样命中（僵尸 0.55 / 玩家 0.6 阈值）→ **附着目标**，每 0.1s tick 结算伤害并推 `orb_stop`（target=附着 key，PF 球跟随目标渲染）。
- **蓄力激光**：`charge_start` 记录 chargeStartAt → 每帧 `maxChargeReached`（**蓄力时长 = chargeMax，不受 chargeSpd 影响**）→ 蓄满自动爆发 `heavyAttack`：`beam_burst` 事件（一道 40 伤巨型激光沿 3D 方向，射程 20m，射线命中裁决），PF 播爆发特效。蓄力期间每 `BEAM_TICK_S / chargeSpd` 一个 laser tick（**蓄力速度只决定激光出伤频率**），对射线垂距内目标持续伤害。
- **charge_dur 快照下发**：`snapshot.charge_dur = bow ? chargeMax : chargeMax / chargeSpd`，PF 无需自行计算蓄力循环。
- 提前松手 `charge_stop` → 停激光取消（无重击）。

### 4.5 开局 / 刷怪 / 经验 / 升级

- **开局**：世界 `phase=idle`（不刷怪）。任一 fp 存活玩家准星点击祭坛红剑（`start` action）→ PB 校验后 `phase=running`，`spawnAt = now + 3.0`，广播 `game_start` 事件（全员提示）。
- **刷怪**：`phase=running` 时每 `SPAWN_INTERVAL_S=3s` 生成一只僵尸：等级 = 当前全局击杀数（首只 0 级，**每次击杀后生成的僵尸等级 +1**），生成点为圆盘边缘随机角度（enter 钻出）。场上达到 `MAX_ZOMBIES` 时跳过本次生成（计时器继续）。
- **经验**：击杀者获得场景经验 `(100 + 50×僵尸等级) × expMul`；阈值 `100 + level×75`，达标消耗并 `level++`、`pendingLevels++`。
- **升级流程**：`level_up` 事件（全员 LEVEL UP 橙色横幅，3s 提示期可继续攻击）→ `pickStartAt` 到期 → `startPickPhase()`：房间内所有 fp 玩家各自 `rollCards()` 抽 3 张 → 三选一（`pick` action 上报 idx）→ **全员选完** `applyPicks()` 结算 → `pendingLevels--`，仍有排队则开启下一轮（连续升级不吞；期间刷怪暂停计时，选完恢复）。

### 4.6 词条系统（17 项）

玩家词条挂 `MpPlayer.stats`；场景词条（luck/expMul）挂 World。`DataFormat`（INT/VALUE/PERCENT/FREQUENCY/ANGLE）决定展示格式与取整（PERCENT ×100 取整防浮漂）；`STAT_DEFS.after` 为值变更钩子（maxHp/maxSt 按比例回补当前值，parryPct/critRate 封顶 1）。

| key | 展示名 | 初始值 | 卡牌档位 |
|---|---|---|---|
| atk | 攻击力 | 10 | +5（通用） |
| maxHp | 生命上限 | 100 | +20（生命） |
| parryPct | 完美格挡窗口 | 50% | +2%（防御） |
| maxSt | 体力上限 | 100 | +10（防御+通用） |
| blockMaxS | 格挡最大持续 | 1.0s | +0.25s（防御） |
| dmgMul | 伤害倍率 | 100% | +10%（通用） |
| chargeSpd | 蓄力速度 | 100% | +15%（专精-无锋剑） |
| thorn | 荆棘 | 0 | +15%（生命+防御） |
| lifesteal | 吸血 | 0 | +2（生命） |
| multiWave | 连续剑气 | 0 | +1（专精-无锋剑） |
| chargeMax | 蓄力上限 | 1.0s | +0.25s（通用） |
| impact | 冲击力 | 100% | +15%（防御+通用） |
| stability | 稳定性 | 100% | +15%（防御） |
| critRate | 暴击率 | 5% | +5%（暴击） |
| critDmg | 暴击伤害 | 100% | +25%（暴击） |
| huaqi | 化气 | 30% | +10%（防御+生命） |
| def | 防御 | 10 | +30（防御） |

### 4.7 卡牌系统

**标签池 TAG_POOL**（9 个，初始权重均 30）：`通用、生命、防御、暴击、专精-无锋剑、专精-苍弓、专精-圣金源盾、专精-星尘溶液、专精-AK47`。另有**「强化」标签固定权重 15**，不在池内、无对应概率卡（场景词条卡 / 标签权重卡专属）。「出现[X]卡牌的概率提高」卡使对应标签权重 +10。

**稀有度 QUALITY_META**：实际权重 = `max(1, init + luck × luckAdj)`：

| 稀有度 | init | luckAdj |
|---|---|---|
| WASTE | 50 | -5 |
| NORMAL | 100 | -3 |
| RARE | 60 | 0 |
| EPIC | 20 | +3 |
| LEGENDARY | 8 | +4 |
| INFINITY | 1 | +5 |

**CARD_DB（28 张）**：
- 17 张玩家词条卡：`stat_<key>`，全部 NORMAL，标签见 4.6 表。
- 2 张场景词条卡（标签「强化」）：`luck_1`（幸运 +1）、`exp_mul_13`（经验倍率 +13%）。
- 9 张标签概率卡（标签「强化」）：`tag_<标签>`（出现[X]卡牌的概率提高）。

**rollCards 三层算法**：
1. 抽 3 个 (标签, 稀有度) 条件对——**任一重复则整体重抽**；
2. 按条件对筛卡：先筛「稀有度+标签」，无则回退该标签任意稀有度，再回退全卡池；**出重复卡牌 → conds 不变重抽，最多 3 次**；
3. 3 次仍重复 → 条件对不合适，回到第 1 步整体重抽。

## 5. PF 侧实现

### 5.1 输入管线（最终语义）

```
SceneManager（原始输入转发，不含游戏语义）
  └─ PlayerCombat（编排器：模板化状态机）
       ├─ onLeftPress(now, ctx)：死亡/眩晕/破防吞掉 → 格挡中先收刀 →
       │    准星指向交互物（祭坛红剑 / 队友尸体）→ 返回 'scene'（交还场景层，不普攻不蓄力）
       │    否则按下立即普攻 normalAttack（无目标空挥），记录 pressAt → 返回 'attack'
       ├─ update：按住 ≥ CHARGE_PRESS_S(0.2s) → beginCharge 进入蓄力
       ├─ onLeftRelease：仅结算蓄力线 → releaseCharge(held)
       │    未蓄满 = 取消（弓上报 charge_stop）；蓄满 = 重击（剑 wave / 弓 PB 自动爆发）
       ├─ onLeftCancel（拖拽视角）：取消按压与蓄力
       └─ 状态失效（死亡/眩晕/破防）自动 endCharge
```

### 5.2 BaseWeapon 抽象（PF 侧）

`weaponName / attackTime / normalAttack / parry / beginCharge / releaseCharge(held) / whiff / animTag / interrupt / update / updatePose / onChargeCancel / consumeRelease / onBeamBurst`。

- **SwordWeapon**：三段连击关键帧动画（SWING_L/R/CHOP）+ 残影幽灵（0.035s 间隔克隆加色）+ 反击戳刺（SWING_THRUST，镜头 slerp 转向目标 onStabAim）+ 追击（SWING_CHASE）+ 蓄力举剑发抖姿态 + 空中戳刺 stab|pitch 上报。
- **BowWeapon**：射球动画 + 拉弓瞄准姿态 + 搭弦能量球随蓄力增大 + 蓄满自动停手（fullStop，之后的松手为余波吞掉 consumeRelease）+ 激光循环音 setBeamLoop。

### 5.3 表现层模块

- **arena.ts（新）**：圆盘竞技场静态场景——盘面（半径 ARENA_RADIUS 圆形地面）、中心祭坛（石台基座）、祭坛上方**悬浮红剑**（缓慢自旋 + 上下浮动 + 微光，`userData.interact='altar_sword'` 注册为交互物）、盘缘雾化渐隐。phase=idle 时红剑高亮提示可点击，开局后转为纯装饰（不再可交互）。
- **NetZombie**：10Hz 快照插值（lungeDash 收紧跟随 k=16）、状态动画（windup 发抖 / sweep 双臂横摆 / lunge 俯身冲刺 / roar 红圈 / stunned 摇晃 / enter 钻出 / dead 后仰倒地淡出）、受击闪红、技能预警四角星由 HUD 驱动。
- **RemotePlayers**：彩色圆柱 + 头顶半球 + 朝向鼻子 + Canvas 名牌（死亡 ☠）+ 世界层血条 + 手持武器（剑/弓互斥，anim 标签驱动手腕枢轴动画）+ 格挡护盾环 + 苍弓激光束（anim='beam'）+ 空中戳刺身体倾斜（tilt slerp）+ 溅血粒子。
- **SceneManager 游戏职责**：combat 实例化与回调桥接（CombatUiHooks → App.vue HUD/飘字/闪光）、pbClient.onWorld/onMpEvent 注册、10Hz sendMpInput、祭坛红剑点击 → `start` 意图、尸体 pickCorpse→revive、Q/E 切武器（cycleWeapon + sendMpAction weapon）、Shift dash、蓄力减速移动 chargeSlow、剑气/球状闪电/激光/爆发光束的视觉实体与更新、空中戳刺镜头 stabLerp、死亡/复活/三选一/升级/排行榜回调。
- **audio.ts**：静态 mp3/wav 音效（swing/parry 系列/counter/dash/flashAlert/kick/sweep/lunge/roar）+ WebAudio 合成（orbShot 方波下扫 / beamBurst 锯齿轰鸣+嘶声 / beamLoop 持续激光 72Hz+LFO）。

## 6. UI 组件（App.vue 挂载）

- **格斗 HUD**（准星系统）：第一人称准星 + 重击蓄力扇环（SVG，蓄满变金）+ 僵尸技能预警四角星（金=普攻可格挡/白=横扫/紫=突进）+ 格挡进度条（金色窗口段）+ 追击 ×N + 武器名 + 僵尸目标条（HP/体力/易伤）+ 玩家 HP/体力条 + 飘字（normal/crit/heal/blocked）+ 受击红闪 / 完美格挡金闪 + 眩晕遮罩。
- **Leaderboard**：击杀排行榜（Tab 切换显示/隐藏，与 StatPanel 同栈；同时展示当前僵尸等级=击杀数）。
- **StatPanel**：我的词条 + 场景属性（经验/等级/幸运/经验倍率）。
- **ExpBar**：底部经验进度条。
- **LevelUpBanner**：橙色 LEVEL UP 横幅（0.5s 渐显 + 2s 停留 + 0.5s 渐隐；seq 作组件 key 支持连续升级逐轮重播）。
- **BuffPickModal**：三选一卡牌弹窗（稀有度样式 / 标签展示 / 已选 done 态）。
- **DeathOverlay**：死亡覆盖层（复活按钮）。
- **DisplayNameModal**：首次连接输入 DisplayName（localStorage 持久化，PB hello 必带）。
- **StartOverlay（新）**：phase=idle 时准星指向红剑显示「点击拔剑开始」提示（或屏幕中央提示条）。

## 7. 快照与事件结构

**WorldSnapshot**：`{ t, phase, chase_left, pick_phase, kills, scene:{exp,level,luck,exp_mul}, players[], zombies[] }`
- `phase`：`idle | running | pick`（开局前 / 战斗中 / 三选一结算中）。
- `kills`：全局击杀数（= 下一只生成僵尸的等级，UI 展示用）。
- players[]：`{ uuid, name, color, p, yaw, fp, hp, st, max_hp, max_st, atk, dmg_mul, stun_for, blocking, anim, kills, max_block, parry_pct, charge_dur, thorn_pct, lifesteal, multi_wave, impact, stability, crit_rate, crit_dmg, weapon, pick:{options:PickCardView[], done}|null }`
- zombies[]：`{ id, p, yaw, hp, st, level, state, st_t, windup_dur, vuln, target }`

**MpEvent（19 种）**：`game_start / join / leave / dmg_z / dmg_p / parry(uuid,perfect,fail,drain,byZombie) / zstun(id,mul) / zdie / level_up(level) / knockback / slow / guardbreak / respawn / counter_open / roar_interrupt / wave(by,xyz,dir3,roll) / orb(by,id,xyz,dir3) / orb_stop(id,target) / beam_burst(by,xyz,dir3)`

## 8. 测试（multi_smoke.ts，用例规划）

双客户端 hello 接入 → fp 房间互见 → idle 态无刷怪 → 点击祭坛红剑开局（game_start）→ 3s 间隔边缘刷怪（等级=kills）→ 攻击僵尸 → 友伤 → 完美格挡 → 化气 → 普通格挡 → 退出房间 → 断开连接清理 → 重击剑气蓄力（hold 结算）→ 暴击 → 冲击力 → 击杀后经验/升级/pendingLevels 且 kills+1（下一只等级+1）→ MAX_ZOMBIES 上限跳过 → 苍弓射球 → 激光 tick → 蓄满爆发 → 提前松手取消 → 切回双手剑。

## 9. PB 接入点（index.ts）

- `import { World }` + `export const world = new World()`
- hello 中 display_name 校验 + `world.join(wsId, name)`
- `routeMessage` 的 `case 'mp_input'` / `case 'mp_action'`（start/attack/shoot/wave/charge_*/parry_*/weapon/pick/respawn/revive/dash）
- `onClose` → `world.leave(wsId)`
- `startWorldLoop()`：`setInterval` 100ms → `world.tick(dt)`（内部按 SPAWN_INTERVAL_S 计时刷怪）→ 广播 `world` 快照（含 phase/kills/pick_phase）+ `events` 逐条 `event` 广播

---

以下章节为**从零独立开发补充细节**：无本仓库上下文的开发者按 §1–§9 + §10–§16 即可实现全部功能，无需查阅旧代码。

## 10. 技术栈、脚手架与工程命令

### 10.1 技术栈

| 端 | 技术 | 关键依赖 |
|---|---|---|
| PB（服务端） | Bun + TypeScript（strict） | `elysia`（HTTP+WS 服务）、`zod`（payload 校验）、`pino`（日志） |
| PF（前端） | Vue 3 + Vite + TypeScript（strict） | `vue`、`pinia`（连接状态 store）、`three`（渲染） |

两端各自独立目录 `pb/`、`pf/`，互不共享代码，仅靠 WebSocket 协议（§3/§7）耦合。PF 与 PB 的类型各自手写一份（保持同构），不做跨端共享包。

### 10.2 工程命令

```
# PB
cd pb
bun install
bun src/index.ts                  # 启动服务（默认端口 3000）
.\node_modules\.bin\tsc.exe --noEmit   # 类型检查（Windows）
bun scripts/multi_smoke.ts        # 冒烟测试（必须全过才算完成）

# PF
cd pf
npm install
npm run dev                       # 开发（Vite，/ws 代理转发到 PB）
npm run build                     # vue-tsc -b && vite build（必须 0 错误）
```

Vite 开发代理：`server.proxy = { '/ws': { target: 'ws://localhost:3000', ws: true } }`；PB 地址可用 `VITE_PB_URL` 环境变量覆盖，默认按 `location.host` 同源推导（局域网/穿透场景免配置）。

### 10.3 目录结构

```
pb/
  src/
    index.ts        # Elysia 服务：/ws 端点、hello/welcome、消息路由、10Hz loop、优雅关闭
    world.ts        # World 类：全部权威模拟（§4）
    protocol.ts     # zod Schema：HelloPayload / MpInput / MpAction + 消息类型导出
  scripts/
    multi_smoke.ts  # 同进程冒烟测试（import app 后 listen(0) 随机端口）
pf/
  src/
    main.ts               # createApp + pinia + pbClient.connect()
    App.vue               # 画布挂载 + HUD/组件 + Pinia→SceneManager 桥接
    protocol/messages.ts  # TS 消息类型（与 pb protocol.ts 同构）+ isType() 收窄
    ws/client.ts          # PbClient：连接/重连退避/hello/dispatch
    stores/connection.ts  # 连接状态 Pinia store
    three/
      SceneManager.ts     # 渲染器/双视角/移动/输入分发/游戏视觉实体（§5.3）
      arena.ts            # 圆盘+祭坛+红剑静态场景
      combat.ts           # PlayerCombat + BaseWeapon + SwordWeapon/BowWeapon
      zombie.ts           # NetZombie 插值渲染
      RemotePlayers.ts    # 远程玩家渲染
      sword.ts / bow.ts   # 武器视模型
      audio.ts            # 音效
    components/           # HUD 与弹窗组件（§6）
```

## 11. 消息信封、错误码与连接生命周期

### 11.1 信封

所有消息统一信封：`{ v: 1, type: string, seq: number, ts: number, payload: object }`。`seq` 为发送端连接内单调递增整数。PB 主动推送（welcome/world/event/state_snapshot 等）同样带 seq（PB 侧自增）。

### 11.2 错误消息与错误码

校验失败回 `error`：`payload = { code, message, ref_seq? }`，`ref_seq` 回显出错消息的 seq（无则为 null）。错误码：

| code | 触发场景 |
|---|---|
| `INVALID_FORMAT` | payload 不符合 Schema（含 hello 缺 display_name、role 与端点不匹配） |
| `UNKNOWN_TYPE` | 该通道不允许的消息 type（如未注册连接发游戏消息） |
| `COOLDOWN` | 重击剑气体力不足等高频意图被拒（游戏内一般静默丢弃，不回 error） |

游戏内非法意图（非本方回合选卡、revive 目标不存在等）**不回 error，直接静默丢弃**——PF 是不可信输入源，PB 只做权威校验。

### 11.3 连接生命周期

1. PF 连接 `ws://<host>/ws/pf` → 发 `hello { role:'pf', client_name:'pf', client_version, display_name }`。
2. PB 校验（role 匹配、display_name 非空 ≤24 字符）→ `world.join(wsId, name)` 分配 uuid + 随机颜色 `hsl(x,70%,55%)` → 回 `welcome { client_id, server_ts, you }`。
3. 10Hz loop 随后持续向所有已注册 PF 推 `world` 快照；瞬时事件逐条 `event` 推送。
4. 断开：PF 侧指数退避重连（`min(5000, 400×2^n) + rand×200` ms），重连成功重新 hello；PB 侧 `world.leave(wsId)` 移除玩家并广播 `leave` 事件。
5. 未 hello 的连接只允许发 hello，其余一律 `error(UNKNOWN_TYPE)`。

## 12. 坐标系、场景布局与出生点

- 右手系，**Y 轴向上**，单位米。地面为 y=0 的圆盘，圆心在原点。
- **祭坛**：位于 (0, 0)（盘心），石台基座（圆柱，顶面 y≈0.9），红剑竖直悬浮于基座上方约 1.2m 处（自旋 + 浮动动画，见 §5.3）。
- **玩家出生点**：(0, 1.6, 3.5)，面向祭坛（朝 -Z）；EYE_HEIGHT=1.6。
- **僵尸生成点**：极坐标 `r = ARENA_RADIUS(14) - 0.6`、`θ = 2π × rand()`，y=0，enter 态从地面钻出后向场内（最近玩家）移动。
- **出界钳制**：每 tick 把玩家与僵尸的水平坐标钳到 `r ≤ ARENA_RADIUS - 0.55`（击退也钳制，不飞出盘外）。
- 视觉：盘面用圆形几何 + 网格/石纹材质，边缘外背景雾（`scene.fog`）渐隐；环境光 + 一盏平行光（投影）+ 祭坛点光源（红色，呼应红剑）。

## 13. World tick 顺序与关键判定细节

### 13.1 每 tick（dt 钳制 ≤0.25s）按序执行

1. 升级提示期：`level_up` 后 3s 内只走计时；`pickStartAt` 到期 → `startPickPhase()`（全员 rollCards，`phase='pick'`，**暂停刷怪计时**）。
2. 三选一：全员已选 → `applyPicks()` 结算（含 after 钩子）→ `pendingLevels--` → 仍有排队则重开下一轮，否则恢复 `phase='running'`。
3. 空场清理：无存活玩家时清空全部僵尸。
4. 玩家：位置用 `mp_input` 最新值（不做航位推算）；exhaust/眩晕计时；体力回复（1.5s 未用后 10/s）；武器 tick（弓激光 beamNextAt）；蓄力自动触发（弓 `maxChargeReached` → 蓄满爆发）；dash 无敌帧到期。
5. 僵尸 AI 状态机（§4.2）：逐只推进状态计时、移动（chase 追最近存活玩家）、技能触发判定、strike/lunge/roar 命中裁决。
6. 尸体清理：dead 超过 `ZOMBIE_TTL_DEAD=2s` 移除。
7. 弹道：剑气 Wave（直线 12m/s，采样命中圆柱）→ 球状闪电 Orb（飞行/附着 tick）→ 激光 tick 伤害。
8. 全局追击窗口计时（`counter_open` 后 `CHASE_WINDOW_S=2s`，最多 3 次追击，伤害 ×1.2）。
9. 组装快照（§7）+ drainEvents() → 逐连接广播。

### 13.2 判定公式

- **受伤减免**：`最终伤害 = 原始 × 500 / (490 + def)`（def=10 → ×1 基准；def=30 卡 → ×0.96）。
- **体力扣减**：`体力损失 = impact基值 × 攻击者.impact / 受击者.stability`（普攻段 impact基值=3、空中戳刺=25、重击剑气=11；僵尸普攻=10）。
- **暴击**：`rand() < critRate` 时 `伤害 × (1 + critDmg)`，sign=Crit。
- **吸血**：近战命中后 `回复 = min(造成伤害, lifesteal)`。
- **荆棘**：被近战命中后对攻击者反弹 `原始伤害 × thorn`（sign=Normal，不受 def 影响也可简化为同公式）。
- **化气**：格挡成功时 `回复血量 = 本次格挡掉的伤害 × huaqi`（sign=Heal 飘字）。
- **僵尸命中采样**：僵尸碰撞圆柱（r=0.55，h=1.9）分 3 层 × 每层 5 个采样点，弹道逐帧步进（步长 ≤0.25m）检测采样点与弹道轴垂距 ≤ 命中阈值。
- **近战扇形判定**：目标水平距离 ≤ REACH(3.0)，且目标方向与相机水平前向夹角 ≤ REACH_ANGLE(0.55 rad)；反击 REACH 放宽到 3.4。
- **追击/反击规则**：僵尸被击晕（体力耗尽）→ 眩晕 5s + 掷 vulnMul；眩晕起 1s 内首个命中的玩家攻击 = 反击（×3）并广播 `counter_open`；窗口内（2s）其他玩家命中 = 追击（×1.2，最多 3 次）。
- **格挡判定顺序**（僵尸普攻命中格挡中玩家时）：`blockAge ≤ 完美窗口(blockMaxS×parryPct)` → 完美（僵尸额外扣体力、玩家不进冷却）；否则 25% 失败（伤害照常，drain 扣体力）；成功则玩家退出格挡进 0.5s 冷却 + 化气回复。
- **数值上报截断**：所有快照浮点 `round(n×1000)/1000`（3 位小数）。

## 14. PF 端从零实现细节

### 14.1 控制与键位（全量）

| 输入 | 行为 |
|---|---|
| V | 固定视角（OrbitControls 观战）⇄ 第一人称（PointerLockControls）切换 |
| WASD | 移动（惯性模型：MAX_SPEED=3，疾跑 5，加速度 20/28，摩擦阻尼 exp 衰减） |
| 双击 W（按住） | 疾跑（FOV 60→68 过渡） |
| 空格 / 双击空格 | 跳（冲量 4.2）/ 起飞降落（飞行高度 0.5–7.0，空格升 Ctrl 降） |
| Shift + 方向 | 闪避（爆发 8.5 m/s，CD 0.6s，上报 dash 意图获得 0.3s 无敌） |
| 左键（第一人称锁定） | 按下立即普攻；按住 ≥0.2s 进蓄力；松手结算蓄力（§5.1） |
| 右键（按住） | 无锋剑格挡 |
| Q / E | 切换上一把/下一把武器 |
| Tab | 排行榜/词条面板 显示⇄隐藏 |
| ESC | 释放鼠标（浏览器 PointerLock 默认行为） |

固定视角下左键点击 = 场景交互（红剑开局/复活队友）；第一人称下交互经 `onLeftPress` 的 `'scene'` 返回路径（准星屏幕中心射线）。

### 14.2 渲染要点

- **NetZombie 模型**：纯 BoxGeometry 组装的方块僵尸（躯干/头/双臂/双腿，暗绿材质）+ 头顶世界层血条（HP 红 + 体力蓝）+ 等级标签；快照插值 `pos.lerp(target, min(1, dt×k))`（常规 k=8，lungeDash k=16 收紧跟随）+ yaw 插值；状态动画全部本地驱动（windup 手臂发抖、sweep 双臂横摆、lunge 俯身、stunned 摇晃、enter 自地下 0.45s 升起、dead 后仰倒地 0.5s + 1.2s 淡出）；受击闪红 0.1s（材质 emissive 脉冲）。
- **武器视模型**：挂在相机下的 Group（SwordWeapon 挂右手位、BowWeapon 居中拉弓位）；动作 = 关键帧姿态插值（自实现小型姿态补间即可，不引动画库）；挥剑残影 = 0.035s 间隔克隆剑体 + 加色材质 + 快速淡出。
- **弹道视觉**：剑气 = 双平面十字交叉 + Canvas 月牙贴图（additive，绕飞行轴 roll 随机旋转，面内 sin 挥摆）；球状闪电 = 核心球 + 径向渐变 Sprite 光晕（附着后跟随目标插值缩小脉动）；激光 = 细圆柱沿准星（粗细/亮度随蓄力增强）；爆发 = 粗圆柱 0.3s 淡出 + FOV 脉冲 3.5°。
- **10Hz 上报**：`setInterval` 语义用渲染循环计时（`time - lastSent >= 0.1`），内容 = 相机位置/yaw/水平前向/3D 前向/mode/当前 anim 标签，浮点截断 3 位。
- **重连**：重连成功后快照自然恢复全部状态；本地视觉实体（僵尸/远程玩家/弹道）按新快照对账增删。

## 15. 代码风格约定（两端统一）

- Tab 缩进；全部显式静态类型，禁 `:=`/any（协议边界经 zod/类型收窄）。
- 命名：PB 端协议字段与快照 **snake_case**（网络格式），TS 侧变量/函数 camelCase、类/组件 PascalCase、常量 UPPER_SNAKE；文件名小驼峰（组件 PascalCase.vue）。
- 注释用中文，写「为什么」与协议对齐点（如「与 PB ORB_SPEED 一致」），不写流水账。
- 纯函数优先：World 的判定子逻辑（伤害折算、扇形判定、抽卡）写成独立纯函数便于测试。
- 单一数据流：PB 快照 → PF 只读渲染；PF 永不本地裁决数值，本地动画仅为表现。

## 16. 开发里程碑与验收

| # | 里程碑 | 验收标准 |
|---|---|---|
| M1 | PB 骨架 | Elysia 服务 + hello/welcome + 10Hz loop 空转；tsc 0 错误；两个浏览器各开一个 PF 可互相看到对方圆柱 |
| M2 | 移动与视角 | 双视角切换/惯性移动/飞行/出界钳制；mp_input 10Hz 上报且快照可见 |
| M3 | 竞技场与开局 | arena.ts 场景 + 红剑点击 → phase=running → 每 3s 边缘刷怪（等级=kills） |
| M4 | 战斗核心 | 三段普攻/反击/追击/格挡体系/体力/眩晕易伤；伤害飘字与血条正确 |
| M5 | 武器齐备 | 剑气蓄力（chargeMax/chargeSpd）+ multiWave；苍弓射球附着/激光/蓄满爆发 |
| M6 | 成长循环 | 经验/升级/pendingLevels/三选一抽卡（三层去重）/17 词条生效 |
| M7 | 收尾 | 死亡/复活/队友 revive/断线重连对账；multi_smoke 全过 + pf build 0 错误 |

冒烟测试基建（沿用旧模式）：测试脚本 `import { app }` 后 `app.listen(0)` 同进程起服务，开两个 WebSocket 客户端（各持 inbox + 按 type 等待的 waiter），逐步断言协议时序与 world 快照字段；用例清单见 §8。
