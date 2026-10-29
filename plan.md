# 武器系统重构计划：BaseWeapon 抽象 / 双手剑解耦 / 新武器「苍弓」

> 依据 todo.md 拆解，供审核。当前架构：PB（`pb/src/world.ts`）为唯一权威（伤害 / 弹道 / 体力全部裁决），PF（`pf/src/three/combat.ts` + `SceneManager.ts`）只做表现与意图上报；协议两端各一份（PB `protocol.ts` zod strict ↔ PF `messages.ts`），字段必须成对同步。

---

## 〇、现状链路（调研结论）

**输入生命周期（PF `SceneManager.ts`）**
- 按下左键（L388-391）：`combat.beginCharge(now)` 成功 → `charging = true`（移动减速 50%，L971-979）
- 松开左键（L411-435）：charging → `combat.fireWave(now)`（hold < chargeDur 视为未蓄满，返回 false 回落普攻链：复活尸体 → `onLeftClick`（反击 / 追击 / 空中戳刺 / 三段连击）→ 场景交互 → `whiffSwing` 空挥）；拖拽视角 → `endCharge`
- 蓄满仅播提示音（`combat.ts` L407-410），**不会**自动释放 → 双手剑 `maxChargeReached` 语义应为 false

**PB 裁决（`world.ts`）**
- `action()` L345：mp_action 分发（attack / parry / wave / pick / revive / lamp / respawn）
- `playerAttack()` L493：普攻裁决——眩晕窗口内反击 300%（开全局追击窗口）→ 追击 120% → 三段 90/90/150 × atk × dmgMul；segment 3 = 空中戳刺（impact 25）
- `fireWave()` L398 + `tickWaves()` L433：重击剑气——effHold = min(hold × chargeSpd, chargeMax)，伤害 = atk × 300% × effHold × dmgMul，体力 10 × effHold，multiWave 连发队列（tick L1189 追发）；弹道 WAVE_SPEED 12 / TTL 1.2s / 扇形碰撞箱穿透 / `wave` 事件（3D 向量 + roll）→ 各 PF 渲染
- `useStamina()` L847：扣体力 = 基值 × 攻击者冲击力 / 受击者稳定性；`playerHit()` L526：暴击掷点 + impact；`damageZombie` / `damagePlayer` / `hurtPlayer` 统一走 `DamageSource`

**结论**：BaseWeapon 抽象需要**两端各一个**（同名抽象、各自职责）——PB 侧负责**裁决**（伤害结算入口），PF 侧负责**输入编排**（点击 / 按住 / 松开 → 意图上报 + 动画）。协议只传意图与事件，武器逻辑不进协议。

---

## 一、任务树与依赖关系

```
W1 武器基础设施：协议扩展 + 切换机制（最先做，两端协议同步）
├── W2 PB 侧 BaseWeapon 抽象 + 双手剑解耦（依赖 W1 的 weapon 字段）
├── W3 PF 侧 BaseWeapon 抽象 + 双手剑解耦（依赖 W1；与 W2 无耦合可并行）
│   └── W5 苍弓 PF 表现（依赖 W3 的武器化编排 + W4 的事件定稿 + W1 协议）
└── W4 苍弓 PB 裁决：球状闪电 + 巨型激光（依赖 W2 的武器实例挂载）

W6 集成验证与回归（依赖全部）
```

**实施顺序**：W1 → W2 ∥ W3 → W4 → W5 → W6。
每任务完成后跑：cd pb `bunx tsc --noEmit` + `bun run smoke` + `bun scripts/multi_smoke.ts`；cd pf `npm run build`。W2/W3 为**行为等价重构**（回归绿即过），W4/W5 新增功能断言。

---

## 二、各任务具体修改点

### W1 武器基础设施：协议扩展 + 切换机制

**PB `protocol.ts`**
- `MpActionPayloadSchema.kind` 枚举扩展（L239）：新增 `'weapon' | 'shoot' | 'charge_start' | 'charge_stop'`；新增可选字段 `weapon: z.enum(['sword', 'bow'])`（weapon 专用）。

**PB `world.ts`**
- 新增 `type WeaponId = 'sword' | 'bow'`；`MpPlayer` 增字段 `weapon: WeaponId`（join 默认 `'sword'`）、`chargeStartAt: number`（苍弓重击开始时刻，-1 = 未蓄力）。
- `action()` L345：签名同步新增 kind；`'weapon'` → 校验后 `p.weapon = d.weapon`（蓄力 / 激光中禁止切换，直接拒绝）；`'shoot'` / `'charge_start'` / `'charge_stop'` → 路由到 `p.weapon` 对应武器实例（W2 落地后接通）。
- `snapshot()` L1227：players 增 `weapon` 字段。
- 常量：`ORB_SPEED`（16 m/s，可调）、`ORB_TTL_S = 6`（球状闪电持续 6 秒）、`ORB_TICK_S = 0.1`、`BEAM_TICK_S = 0.2`。

**PF `messages.ts`**
- `MpActionPayload`（L153）同步 kind 枚举 + `weapon` 字段；`NetPlayerState`（L169）增 `weapon: 'sword' | 'bow'`。

**PF 切换交互**
- `SceneManager.ts`：Q / E 键（handleKeyDown，已按下方向 Q=上一把 / E=下一把，循环切换）→ 锁定且存活时 `pbClient.sendMpAction({ kind: 'weapon', weapon: 目标武器 })` + 本地乐观提示 toast；PB 快照回写后 `combat.setWeapon(...)` 生效（以 PB 为准，不做本地预切）。当前 2 把武器时 Q/E 效果相同，但按键语义按上/下一个实现，武器扩容后天然可用。
- `App.vue`：HUD 显示当前武器名（读快照），切换 toast。

**验收**：tsc / smoke / multi / build 全绿；Q/E 切换后快照 weapon 变化、断线重连不丢。

---

### W2 PB 侧：BaseWeapon 抽象 + 双手剑解耦（行为等价重构）

**`world.ts` 新增**（武器裁决挂载）：

```ts
abstract class BaseWeapon {
	abstract weaponName: string
	/** 普攻裁决（点击） */
	abstract normalAttack(p: MpPlayer, segment: number, now: number): void
	/** 开始重击蓄力 */
	abstract startCharge(p: MpPlayer, now: number): void
	/** 提前松手（未蓄满） */
	abstract stopCharge(p: MpPlayer, now: number): void
	/** 重击蓄力完成（松开满蓄 / tick 轮询蓄满自动触发） */
	abstract heavyAttack(p: MpPlayer, timeCharged: number, now: number): void
	/** tick 轮询：蓄力达到上限时返回 true → 调用方立刻 heavyAttack 并停止重击 */
	abstract maxChargeReached(p: MpPlayer, now: number): boolean
	/** 持续行为钩子（激光 tick / 连发剑气队列），可选 */
	tick?(p: MpPlayer, dt: number, now: number): void
}
```

- `World` 增 `private weapons: Record<WeaponId, BaseWeapon>`（构造时注入 Sword / Bow 实例，Bow 本任务先空壳占位）。
- `action()` 分发改造：`'attack'` → `weapons[p.weapon].normalAttack(p, segment, now)`；`'wave'` → 视为「蓄满松手」→ `heavyAttack(p, hold, now)`；`'shoot'` / `'charge_start'` / `'charge_stop'` → 同名方法。
- `tick()` L1182 玩家循环内：`weapons[p.weapon].tick?.(p, dt, now)`；`maxChargeReached(p, now)` 为 true 时 → `heavyAttack(p, 蓄满时长, now)` 并清 `chargeStartAt`。

**`SwordWeapon extends BaseWeapon`（双手剑）**
- `normalAttack` = 现 `playerAttack()` L493-523 原逻辑平移（反击 300% / 追击 120% / 三段 / segment 3 空中戳刺，含 `findMeleeTarget` / `playerHit` 调用，不动）。
- `heavyAttack(p, timeCharged, now)` = 现 `fireWave()` L398-410 原逻辑（effHold = min(timeCharged × chargeSpd, chargeMax)、`emitWave`、体力 10 × effHold、multiWave 入队），**行为完全不变**。
- `startCharge` / `stopCharge` = 空实现（剑的蓄力是纯 PF 本地概念，PB 只在 wave 上报时用 hold 结算）。
- `maxChargeReached` = `false`（保持现行为：蓄满不自动释放，松手才发）。
- `tick` = 现 tick L1189-1197 的 waveQueue 连发剑气逻辑平移（每 0.1s 追发满蓄剑气）。

**验证**：现有 smoke（12）/ multi_smoke 全部断言不变全绿（数值行为与重构前一致）；删除 `fireWave` / `playerAttack` 原方法（无兼容残留）。

---

### W3 PF 侧：BaseWeapon 抽象 + 双手剑解耦（行为等价重构）

**`combat.ts` 新增**（输入编排挂载）：

```ts
export interface AttackCtx {
	zombies: NetZombie[]
	remotes: RemoteCenter[]
	camera: THREE.PerspectiveCamera
	onGround: boolean
}
export abstract class BaseWeapon {
	abstract weaponName: string
	/** 点击普攻：返回 true = 已消费本次点击 */
	abstract normalAttack(now: number, ctx: AttackCtx): boolean
	/** 按下左键开始蓄力：返回 true = SceneManager 冻结移动 */
	abstract startCharge(now: number): boolean
	/** 松开（编排层已算好 hold）：返回 true = 本次松开被武器消费 */
	abstract heavyAttack(timeCharged: number, now: number): boolean
	/** update 每帧轮询：蓄满是否立即停手并触发 heavyAttack */
	abstract maxChargeReached(now: number): boolean
	/** 武器视模型（剑 / 弓）切换挂载 */
	abstract attach(camera: THREE.Camera): void
	abstract setVisible(v: boolean): void
	abstract dispose(): void
	abstract updatePose(dt: number, now: number): void
}
```

- `PlayerCombat` 改造为**编排器**：持有 `weapon: BaseWeapon`（按快照 `setNet` 中 `mine.weapon` 切换实例）；保留共用状态（hp / 体力 / 眩晕 / 格挡 / chargeStart / chargeNotified / 飘字 / HUD）。
- `SceneManager.ts` 调用点改造：
  - L389 `beginCharge` → `combat.weapon.startCharge(now)`（剑 = 现 beginCharge 逻辑；返回 true 才 charging）
  - L412-415 `fireWave` → `combat.weapon.heavyAttack(combat.chargeHold(now), now)`（剑内部判定未蓄满返回 false 回落普攻链）
  - L424 `onLeftClick` → `combat.weapon.normalAttack(now, ctx)`
  - `combat.update()` L405-410：每帧 `if (charging && weapon.maxChargeReached(now)) { charging = false; weapon.heavyAttack(chargeHold(now), now) }`（苍弓自动爆发挂点；剑恒 false 不触发）
- `SwordWeapon`（双手剑）= 现逻辑平移：`normalAttack` = 反击 / 追击 / 空中戳刺 / 三段 / 缓冲连段（L254-303 + update L413-425 缓冲发放保留在编排器）；`startCharge` = 现 beginCharge；`heavyAttack` = 现 fireWave（SWING_CHASE 动画 + `wave` 上报）；`maxChargeReached` = false；视模型 = 现 buildSword + SWING_L/R/CHOP/THRUST/CHASE 关键帧 + ghosts。

**验证**：build 通过 + 双开手测双手剑行为与现版本一致（三段 / 反击 / 追击 / 空中戳刺 / 蓄力剑气 / 连发）。

---

### W4 苍弓 PB 裁决（依赖 W2）

**`BowWeapon extends BaseWeapon`**

- `normalAttack`（'shoot' 上报触发）：准星 3D 方向（复用 `waveDir()`）发射**球状闪电**：
  - 新弹道类型 `Orb { owner, id, x/y/z, dx/dy/dz, target: string | null, tickAt, t }`，直线飞行 `ORB_SPEED`，无穿透（**首中即停**）；
  - 命中判定复用现有采样：僵尸用 `Z_HIT_SAMPLES` 圆柱采样点到弹道距离 ≤ 0.55；玩家用中心点（y=1.0）距离 ≤ 0.6；撞墙 / 撞地 / TTL 到期消失（复用 `region()` 拦截 + y 边界逻辑）；
  - 首次命中（僵尸或玩家）→ 停止前进并**附着目标**（`target` 记目标 key，之后跟随目标中心位置），每 `0.1s` 结算 `DamageSource { amount: 3, sign: Normal, impact: 1 }`（不掷暴击，见 Q1/Q7）；附着目标死亡或 **6 秒**（`ORB_TTL_S = 6`）到期 → 消失；
  - 事件：`orb`（发射：by / id / x,y,z / dx,dy,dz）+ `orb_stop`（停止：id / x,y,z / 目标 key）；附着期间 tick 伤害走现有 `dmg_z` / `dmg_p` 事件（PF 飘字自动工作）。
- `startCharge`（'charge_start'）：`p.chargeStartAt = now`（行动校验同 fireWave：眩晕 / 破防拒绝）。
- `stopCharge`（'charge_stop'，提前松手）：清 `chargeStartAt`，激光停止，**无爆发**。
- `heavyAttack(p, timeCharged, now)`：**爆发激光**——沿准星射线一次性 `DamageSource { amount: 40, impact: 11 }`（命中判定同下方射线，见 Q3），清 `chargeStartAt`；事件 `beam_burst`（by / x,y,z / dx,dy,dz，PF 播爆发特效）。
- `maxChargeReached(p, now)`：`p.chargeStartAt >= 0 && now - p.chargeStartAt >= chargeDur(p)`（chargeDur = chargeMax / chargeSpd，与剑同公式）→ true，由 World tick 触发 `heavyAttack` + 停止。
- `tick`（激光持续）：`chargeStartAt >= 0` 时每 `0.2s` 对**准星射线**上的目标结算 `DamageSource { amount: 15, impact: 3 }`（不掷暴击）：
  - 射线命中判定（新私有函数 `beamHits(p, tx, ty, tz)`）：目标采样点到射线（原点 = 玩家位置，方向 = look3）垂距 ≤ 0.55（僵尸圆柱采样）/ ≤ 0.6（玩家 1.0 高中心），且沿射线正方向、距离 ≤ 20m；
  - **穿透**：射线上所有命中目标都结算（Q3 待确认）；
  - 被墙拦截：目标与发射者 region 跨界且隔门口墙（复用 `meleeCheck` L565 的隔墙判断）→ 不命中；
  - 眩晕 / 死亡 / pickPhase → 由 World tick 侧中止蓄力（清 chargeStartAt）。

**`world.ts` 集成**
- `tick()`：Orb 弹道推进 `tickOrbs(dt, now)`（与 tickWaves 并列）；tick 玩家循环中眩晕 / 死亡时清 `chargeStartAt`（同 waveQueue L1190 的中止规则）。
- `MpEvent` 增 `orb` / `orb_stop` / `beam_burst` 三个事件类型。

**验收**：multi_smoke 新增断言（见 §四）。

---

### W5 苍弓 PF 表现（依赖 W1/W3/W4 协议与事件定稿）

**`combat.ts` / 新文件 `bow.ts`**
- `BowWeapon` 视图实现：`buildBow()` 弓视模型（simple 几何合成，同 buildSword 风格，挂相机）；姿态关键帧：待机持弓 / 蓄力拉弓（准星蓄力环 `hud.charge` 复用）/ 射球松弦 / 爆发后摆。
- `normalAttack`：射球动画（拉弓关键帧短放）+ `sendMpAction({ kind: 'shoot' })` + 音效；**无目标也射**（远程武器），交互优先级保持：复活尸体 → 场景交互物 → 射球（不吞台灯 / 开门）。
- `startCharge`：拉弓姿态 + `sendMpAction({ kind: 'charge_start' })`；`currentAnimTag` 蓄力中返回 `'beam'`（远端渲染挂点，方向走 mp_input dir3 已有）。
- `heavyAttack`：蓄满松手 → 若未达蓄满且非自动触发则等同 stopCharge（`charge_stop`）；爆发由 **PB `beam_burst` 事件**驱动本地特效（避免双端双重触发）+ `beam_stop`。
- `maxChargeReached`：本地镜像 `hold >= chargeDur` → true（编排层自动停手；爆发特效仍等 PB 事件，双保险防视觉漂移）。

**`SceneManager.ts`**
- 事件渲染：`orb`（发光球体 + 拖尾飞行，同 wavesVis 管理）、`orb_stop`（附着点闪烁小球，目标跟随）、`beam_burst`（粗光束闪光 0.3s + 屏幕微震）；持续激光：本地 `weapon` 为弓且 charging → 从相机沿准星渲染细光束圆柱；远端玩家 `anim === 'beam'` → 按其快照位置 + dir3 渲染光束。
- `RemotePlayers.ts`：`weapon` 快照字段 → 远端玩家切换武器渲染（弓为简模或暂用隐藏剑 + 蓄力姿态，Q8 可确认）。

**`audio.ts`**
- `SfxName` 增 `'orbShot' | 'beamLoop' | 'beamBurst'`。项目音效均为静态资源——**建议用 WebAudio 合成**（振荡器 + 包络，无资源依赖）实现，避免等音频文件；若你提供 mp3 资源则改为静态导入（见 Q6）。

**验收**：build 通过 + 双开手测清单（§四）。

---

### W6 集成验证与回归

- 全量：pb `bunx tsc --noEmit` + `bun run smoke` + `bun scripts/multi_smoke.ts`；pf `npm run build`。
- multi_smoke 新增用例：
  1. 苍弓普攻：发射 orb → 飞行命中僵尸 → 停止 + 0.1s × N tick 断言每 tick 3 伤、impact 1 扣体；
  2. 激光：charge_start → 0.2s × N tick 断言每 tick 15 伤（穿透双目标断言，视 Q3）；
  3. 蓄满自动爆发：charge_start 后推进时间 ≥ chargeDur → 断言 40 伤一次 + `chargeStartAt` 清空 + 后续无 tick；
  4. 提前松手：charge_stop → 无爆发无 tick；
  5. 切武器：weapon action → 快照 weapon 变化 + 弓普攻不再触发三段连击裁决。
- 手测清单：Q/E 切换武器（上一把/下一把）、弓普攻射球（命中停止 + 持续伤害飘字 + 6s 后消失）、按住激光（松手停 / 蓄满自动爆发停）、双手剑全行为回归、远端玩家激光 / 弓渲染。

---

## 三、协议字段汇总（PB protocol.ts ↔ PF messages.ts 成对改）

| 位置 | 变更 |
|---|---|
| `mp_action.kind` | +`'weapon' / 'shoot' / 'charge_start' / 'charge_stop'` |
| `mp_action.weapon` | 新增可选字段 `z.enum(['sword','bow'])`（weapon 专用） |
| 快照 players | +`weapon: 'sword' \| 'bow'` |
| MpEvent | +`orb` / `orb_stop` / `beam_burst` |
| mp_input.anim | 值域新增 `'beam'`（仍为 string，远端激光渲染挂点） |

---

## 四、验证计划

见各任务验收 + W6 汇总。每任务四件套：pb tsc / smoke（12）/ multi_smoke / pf build；W4 起新增 5 个 multi_smoke 断言用例。

## 五、风险与注意

- **W2/W3 是双端行为等价重构**，务必单独完成并全量回归后再动 W4/W5，避免「重构 + 新功能」混在一个不可 bisect 的提交里。
- `combat.ts` 编排层改动大（onLeftClick / beginCharge / fireWave 调用点全部改为武器生命周期回调），SceneManager 调用点同步改，注意短按普攻回落链（未蓄满 → 普攻）语义保留在编排层而非武器内部。
- 激光射线判定是新几何函数（射线-点垂距），与剑气扇形（waveHit）互不复用；隔墙拦截复用 meleeCheck L565 判断。
- 苍弓 tick 伤害高频（球 10Hz / 激光 5Hz）→ dmg_z / dmg_p 事件量增大，PF 飘字有投影节流，需手测确认不刷屏（必要时飘字合并）。
- atk 词条对苍弓固定伤害无效（见 Q1），三选一 atk 档位对弓玩家贬值——plan 建议苍弓伤害 × dmgMul 联动全局伤害词条缓解。

## 六、待确认决策点

- **Q1 苍弓伤害是否吃词条**：todo 字面为固定值（球 3 / 激光 15 / 爆发 40）。我建议：固定基值 × `dmgMul`（吃全局伤害倍率，不吃 atk）；备选：随 atk 缩放（基值 × atk/10）。
- **Q2 球状闪电停止后的行为**：字面「停止前进」，持续时间 6 秒已确认。我建议**附着命中目标**（跟随目标移动持续 0.1s/3 伤，目标死亡或 6s 到期后消失）；备选：停在命中点原地 tick（目标走开即空转）。
- **Q3 激光命中**：我建议**穿透**（射线上所有目标都结算）+ 被室内外墙拦截；备选：只打最近一个目标。
- **Q4 激光按住时移速**：沿用现蓄力减速 50%（chargeSlow）；备选：完全冻结移动。
- **Q5 弓的体力消耗**：todo 未提。我建议弓重击**不耗体力**（激光高频扣血已是代价）；备选：对齐剑气 10×effHold 一次结算。
- **Q6 苍弓音效**：WebAudio 合成（无需音频文件）还是你提供 mp3 资源走静态导入？
- **Q7 弓是否暴击 / 吃吸血**：我建议 tick 类伤害（球 / 激光）**不掷暴击**（否则 0.1s/3 伤×2.0 暴击过于滚雪球），但**吃吸血**（走统一 DamageSource 结算，天然生效）；爆发 40 可掷暴击。可改。
- **Q8 远端玩家武器渲染精度**：弓视模型是完整新模型，还是先复用简化占位（隐藏剑 + 姿态标签）？影响 W5 工作量。
