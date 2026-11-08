# game.md — 联机对战游戏系统总结（分离留档）

> 本文档是游戏系统从「脑控智能家居仿真平台」项目中分离前写的完整留档。
> 分离后游戏代码已删除，本文档为唯一还原依据。智能家居部分见 `docs.md`。

## 1. 系统总览

在智能家居 3D 客厅场景（PF/Three.js）内叠加的一套 **PB 权威联机 PVE 对战**：

- **PB**（`pb/src/world.ts`，Bun + TS）：唯一事实源。世界模拟 10Hz tick，裁决伤害 / 僵尸 AI / 格挡 / 体力 / 蓄力 / 弹道 / 经验升级；每 tick 广播 `world` 快照 + 瞬时 `event`。
- **PF**（`pf/src/three/`）：纯表现层。本地武器视模型动画 / 意图上报（`mp_action`）/ 输入状态上报（`mp_input` 10Hz）/ 快照插值渲染（僵尸、远程玩家、弹道）/ HUD。
- **玩法**：玩家进入第一人称（mode=fp）加入房间；点击室内台灯召唤共享僵尸（上限 3 只）；击杀得经验 → 场景升级 → 全员三选一抽卡强化；僵尸死亡后门口补员下一世代（等级 +1 成长）。玩家间有友伤。

## 2. 文件清单（分离前）

| 文件 | 性质 | 内容 |
|---|---|---|
| `pb/src/world.ts` | 纯游戏 | 权威世界模拟全部逻辑（约 1900 行） |
| `pb/scripts/multi_smoke.ts` | 纯游戏 | 冒烟测试 19 用例 |
| `pf/src/three/combat.ts` | 纯游戏 | PlayerCombat 编排器 + BaseWeapon + Sword/Bow 武器实现 |
| `pf/src/three/zombie.ts` | 纯游戏 | NetZombie 快照插值渲染（方块僵尸模型 + 状态动画） |
| `pf/src/three/RemotePlayers.ts` | 纯游戏 | 远程玩家渲染（彩色圆柱 + 名牌 + 血条 + 武器 + 激光 + 溅血） |
| `pf/src/three/audio.ts` | 纯游戏 | 战斗音效（静态资源 + WebAudio 合成 orbShot/beamBurst/beamLoop） |
| `pf/src/three/sword.ts` / `bow.ts` | 纯游戏 | 无锋剑 / 苍弓视模型（含远端简模 buildRemoteBow） |
| `pf/src/components/{ExpBar,StatPanel,BuffPickModal,LevelUpBanner,Leaderboard,DeathOverlay,DisplayNameModal}.vue` | 纯游戏 | 经验条 / 词条面板 / 三选一弹窗 / 升级横幅 / 排行榜 / 死亡覆盖层 / 名字输入 |
| `pf/src/assets/audio/*` | 纯游戏 | swing / parry / counter / dash / flashAlert / kick / sweep / lunge / roar 音频 |
| `pb/src/index.ts` | 混合 | 游戏部分：world 实例、`mp_input`/`mp_action` 路由、onClose world.leave、startWorldLoop（10Hz tick + world 快照 + event 广播） |
| `pb/src/protocol.ts` | 混合 | 游戏部分：hello 的 display_name、MpInputPayloadSchema、MpActionPayloadSchema |
| `pf/src/protocol/messages.ts` | 混合 | 游戏部分：PlayerYou、WorldPayload、MpEventPayload、NetPlayerState、NetZombieState、CardQuality、PickCardOption、SceneState、WeaponId、DamageSign 等 |
| `pf/src/ws/client.ts` | 混合 | 游戏部分：displayName / you / onWorld / onMpEvent / sendMpInput / sendMpAction |
| `pf/src/three/SceneManager.ts` | 混合 | 游戏部分：combat / RemotePlayers / NetZombie / 剑气 / 球状闪电 / 激光 / dash / stabLerp / 台灯召唤 / 10Hz mp_input / world+event 分发 / 复活 / 三选一 / 升级回调 |
| `pf/src/App.vue` | 混合 | 游戏部分：格斗 HUD 模板全部 + 游戏组件挂载 + combatHooks + 死亡 / 排行 / 三选一 / 升级状态 |
| `pf/src/main.ts` | 混合 | 游戏部分：localStorage DisplayName 才自动连接 |
| `pf/src/ws/protocol.test.ts` | 混合 | 游戏部分：`case 'world'`（WorldMsg 收窄检查） |
| `pf/src/three/room.ts` | 轻微混合 | 台灯模型为场景物件，`userData.interact='lamp'` 标签 + RoomRig.lamp 仅为游戏召唤入口 |
| 其余（devices.ts / tween.ts / stores / DevicePanel 等） | 纯智能家居 | 保留 |

## 3. 协议（游戏增量）

在 docs.md 7.x 智能家居协议之上的扩展消息：

- **hello**：PF 额外携带 `display_name`（必填，联机身份）。welcome 额外携带 `you: PlayerYou { uuid, color }`（uuid + 随机分配颜色）。
- **mp_input**（PF→PB，10Hz）：`{ fp, anim, p:[x,y,z], yaw, dir:[dirX,dirZ], dir3:[x,y,z] }`。位置 / 朝向 / 相机 3D 前向（剑气与弹道飞行方向）/ 动作标签（anim：swing0/1/2、counter、chase、block、shoot、beam、charge、stab|<pitch>）。
- **mp_action**（PF→PB，瞬时意图）：`kind` ∈
  - `attack`（segment: 0/1/2 三段、3 空中戳刺）
  - `shoot`（苍弓射球）· `charge_start` / `charge_stop`（苍弓蓄力）
  - `wave`（hold：剑气按住秒数）· `weapon`（切换武器）
  - `parry_start` / `parry_stop`（格挡起手 / 结束）
  - `lamp`（台灯召唤僵尸）· `pick`（idx：三选一选择）· `respawn` · `revive`（uuid：复活队友）· `dash`
- **world**（PB→PF，随 tick 10Hz）：WorldSnapshot（见 §7）。
- **event**（PB→PF，瞬时广播）：MpEvent 数组（见 §7）。

## 4. PB 世界模拟（world.ts）

### 4.1 核心常量

```ts
// 僵尸
Z_BASE_HP=100  Z_HP_PER_LEVEL=25  Z_DMG_PER_LEVEL=0.25   // HP=100+25×等级；伤害+0.25×等级
Z_MAX_ST=100  Z_CHASE_SPEED=0.95  Z_ENTER_SPEED=1.0
Z_ATTACK_RANGE=1.7  Z_STRIKE_RANGE=2.15
Z_WINDUP_S=1.0  Z_RECOVER_S=1.1  Z_STUN_S=5.0  Z_ATTACK_COST=10
SWEEP_COST=15  SWEEP_CD=8  SWEEP_RANGE=2.2
LUNGE_COST=20  LUNGE_CD=10  LUNGE_MIN=2.5  LUNGE_MAX=5.0  LUNGE_SPEED=8.0  LUNGE_HIT_R=1.2  LUNGE_TIMEOUT=1.2
ROAR_CD=25  ROAR_MAX_USES=2  ROAR_HEAL=30  ROAR_RADIUS=3.0
COUNTER_WINDOW_S=1.0  CHASE_WINDOW_S=2.0
SWEEP_TRACK_S=8  ZOMBIE_TTL_DEAD=2.0  MAX_ZOMBIES=3
ZOMBIE_SPAWN={x:-4.55, z:1.9}   // 门口补员点
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

- **enter**：从地面钻出（PF 0.45s 升起动画），向室内移动。
- **chase**：追最近目标（快照 `target` 字段）。攻击距离内 → windup；体力足够且冷却好时按条件触发技能。
- **windup**（1.0s 前摇）：举手发抖；PF 播 flashAlert 预警音（金四角星=可格挡普攻）。结束 → strike。
- **strike**：Z_STRIKE_RANGE 内对目标结算普攻伤害，扣 10 体力 → recover。
- **recover**（1.1s）→ 回 chase。短前摇期间被打会刷新 recExtra 延长。
- **sweep（横扫）**：多目标时触发（cost 15，cd 8s，范围 2.2）。前摇 PF 白色四角星预警——**不可格挡**（必须闪避），格挡中被打中则破防（guardbreak 0.55s）+ 扣 15 体力。命中后被横扫目标进入 Z 轴追踪（SWEEP_TRACK_S=8s 优先级）。
- **lungeWind → lungeDash（突进）**：目标距离 2.5–5.0m 时触发（cost 20，cd 10s）。蓄力 0.5s（紫色四角星预警）→ 以 8 m/s 冲刺 ≤1.2s，命中半径 1.2，命中则打断玩家动作 + 破防 + 剧烈击退；冲到 LUNGE_MAX 或超时未命中 → recover 硬直（recExtra 加长，PF 端可白嫖）。
- **roar（嘶吼）**：玩家使用格挡流时触发（cd 25s，最多 2 次）。前摇 PF 红圈预警（半径 3.0），结束对范围内玩家扣 25 体力 + 减速 + 破防，僵尸自身回 30 体力；被打断（roar_interrupt）则不结算。
- **stunned（眩晕）**：体力耗尽 → 眩晕 5s，**眩晕瞬间掷定易伤系数 vulnMul = 1.15~1.85**。眩晕后 1s 内（COUNTER_WINDOW_S）任一玩家攻击 → 反击 300% + 开启全局追击窗口。眩晕期间 PF 摇晃动画；体力耗尽型眩晕结束后体力回满。
- **dead**：hp≤0 → 后仰倒地淡出（PF 本地动画），2s 后移除；结算经验并门口补员 `level+1` 世代。

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
- **死亡**：hp≤0 强制结束格挡，渲染尸体（可被队友准星点击 revive）；点击「复活」→ respawn 到出生点。

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

### 4.5 刷怪 / 经验 / 升级

- **召唤**：任一 fp 玩家点击室内台灯（`lamp` action）→ 0 级僵尸在门附近钻出（上限 3 只，全员共享）。
- **补员**：僵尸死亡 → 门口 `ZOMBIE_SPAWN` 补 `level+1` 世代（HP 100+25×lv，伤害 +0.25×lv）。
- **经验**：击杀者获得场景经验 `(100 + 50×僵尸等级) × expMul`；阈值 `100 + level×75`，达标消耗并 `level++`、`pendingLevels++`。
- **升级流程**：`level_up` 事件（全员 LEVEL UP 橙色横幅，3s 提示期可继续攻击）→ `pickStartAt` 到期 → `startPickPhase()`：房间内所有 fp 玩家各自 `rollCards()` 抽 3 张 → 三选一（`pick` action 上报 idx）→ **全员选完** `applyPicks()` 结算 → `pendingLevels--`，仍有排队则开启下一轮（连续升级不吞）。

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
       │    准星指向交互物/队友尸体 → 返回 'scene'（交还场景层，不普攻不蓄力）
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

- **NetZombie**：10Hz 快照插值（lungeDash 收紧跟随 k=16）、状态动画（windup 发抖 / sweep 双臂横摆 / lunge 俯身冲刺 / roar 红圈 / stunned 摇晃 / enter 钻出 / dead 后仰倒地淡出）、受击闪红、技能预警四角星由 HUD 驱动。
- **RemotePlayers**：彩色圆柱 + 头顶半球 + 朝向鼻子 + Canvas 名牌（死亡 ☠）+ 世界层血条 + 手持武器（剑/弓互斥，anim 标签驱动手腕枢轴动画）+ 格挡护盾环 + 苍弓激光束（anim='beam'）+ 空中戳刺身体倾斜（tilt slerp）+ 溅血粒子。
- **SceneManager 游戏职责**：combat 实例化与回调桥接（CombatUiHooks → App.vue HUD/飘字/闪光）、pbClient.onWorld/onMpEvent 注册、10Hz sendMpInput、台灯 interact='lamp' 召唤入口、尸体 pickCorpse→revive、Q/E 切武器（cycleWeapon + sendMpAction weapon）、Shift dash、蓄力减速移动 chargeSlow、剑气/球状闪电/激光/爆发光束的视觉实体与更新、空中戳刺镜头 stabLerp、死亡/复活/三选一/升级/排行榜回调。
- **audio.ts**：静态 mp3/wav 音效（swing/parry 系列/counter/dash/flashAlert/kick/sweep/lunge/roar）+ WebAudio 合成（orbShot 方波下扫 / beamBurst 锯齿轰鸣+嘶声 / beamLoop 持续激光 72Hz+LFO）。

## 6. UI 组件（App.vue 挂载）

- **格斗 HUD**（准星系统）：第一人称准星 + 重击蓄力扇环（SVG，蓄满变金）+ 僵尸技能预警四角星（金=普攻可格挡/白=横扫/紫=突进）+ 格挡进度条（金色窗口段）+ 追击 ×N + 武器名 + 僵尸目标条（HP/体力/易伤）+ 玩家 HP/体力条 + 飘字（normal/crit/heal/blocked）+ 受击红闪 / 完美格挡金闪 + 眩晕遮罩。
- **Leaderboard**：击杀排行榜（Tab 切换显示/隐藏，与 StatPanel 同栈）。
- **StatPanel**：我的词条 + 场景属性（经验/等级/幸运/经验倍率）。
- **ExpBar**：底部经验进度条。
- **LevelUpBanner**：橙色 LEVEL UP 横幅（0.5s 渐显 + 2s 停留 + 0.5s 渐隐；seq 作组件 key 支持连续升级逐轮重播）。
- **BuffPickModal**：三选一卡牌弹窗（稀有度样式 / 标签展示 / 已选 done 态）。
- **DeathOverlay**：死亡覆盖层（复活按钮）。
- **DisplayNameModal**：首次连接输入 DisplayName（localStorage 持久化，PB hello 必带）。

## 7. 快照与事件结构

**WorldSnapshot**：`{ t, chase_left, pick_phase, scene:{exp,level,luck,exp_mul}, players[], zombies[] }`
- players[]：`{ uuid, name, color, p, yaw, fp, hp, st, max_hp, max_st, atk, dmg_mul, stun_for, blocking, anim, kills, max_block, parry_pct, charge_dur, thorn_pct, lifesteal, multi_wave, impact, stability, crit_rate, crit_dmg, weapon, pick:{options:PickCardView[], done}|null }`
- zombies[]：`{ id, p, yaw, hp, st, level, state, st_t, windup_dur, vuln, target }`

**MpEvent（18 种）**：`join / leave / dmg_z / dmg_p / parry(uuid,perfect,fail,drain,byZombie) / zstun(id,mul) / zdie / level_up(level) / knockback / slow / guardbreak / respawn / counter_open / roar_interrupt / wave(by,xyz,dir3,roll) / orb(by,id,xyz,dir3) / orb_stop(id,target) / beam_burst(by,xyz,dir3)`

## 8. 测试（multi_smoke.ts，19 用例）

双客户端 hello 接入 → fp 房间互见 → 台灯召唤共享僵尸 → 攻击僵尸 → 友伤 → 完美格挡 → 化气 → 普通格挡 → 退出房间 → 断开连接清理 → 重击剑气蓄力（hold 结算）→ 暴击 → 冲击力 → 僵尸死亡升级补员（经验/等级/pendingLevels）→ 苍弓射球 → 激光 tick → 蓄满爆发 → 提前松手取消 → 切回双手剑。

## 9. PB 接入点（index.ts 游戏部分，分离时删除）

- `import { World }` + `export const world = new World()`
- hello 中 display_name 校验 + `world.join(wsId, name)`
- `routeMessage` 的 `case 'mp_input'` / `case 'mp_action'`（lamp/attack/shoot/wave/charge_*/parry_*/weapon/pick/respawn/revive/dash）
- `onClose` → `world.leave(wsId)`
- `startWorldLoop()`：`setInterval` 100ms → `world.tick()` → 广播 `world` 快照（含 pick_phase）+ `events` 逐条 `event` 广播
