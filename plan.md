# 重构计划：词条系统 / 伤害系统 / 战斗行为 / 运维按钮

> 依据 todo.md 拆解，供审核。当前架构：PB（`pb/src/world.ts`）为唯一权威，PF（`pf/`）只做表现与意图上报；协议两端各有一份（PB `protocol.ts` zod strict ↔ PF `messages.ts`），字段必须同步。

---

## 一、任务树与依赖关系

```
T1 词条 Record 化（基础设施，最先做）
├── T2 新词条（依赖 T1 的 Record + 快照字段）
│   ├── T2a 蓄力上限 + 重击伤害公式改造
│   ├── T2b 冲击力 / 稳定性（依赖 T3 的 DamageSource.impact 通道）
│   └── T2c 暴击率 / 暴击伤害（依赖 T3 的 sign 通道）
├── T5 三选一池扩展（依赖 T1/T2：新词条入池档位）
└── （快照 / PF HUD 同步随各任务走）

T3 伤害系统 DamageSource 重构（依赖 T1：impact/stability 取自词条）
└── T2b / T2c 建立在其之上

T4 闪避 Bug 修复（独立，可随时做）
T6 空中戳刺（独立；删 airMul 与 T3 同文件，排在 T3 之后减少冲突）
T7 重启 PB 按钮（完全独立，PB index.ts + StatusBar.vue + protocol）
```

**实施顺序**：T1 → T3 → T2a → T2b → T2c → T5 → T4 → T6 → T7。
每个任务完成后跑：`bunx tsc --noEmit` + `bun run smoke` + `bun scripts/multi_smoke.ts`（pb 目录）；`npm run build`（pf 目录）。

---

## 二、各任务具体修改点

### T1 词条系统：玩家数值统一 Record 管理

**PB `world.ts`**

- 新增类型与默认表（模块级）：

```ts
type StatKey =
  | 'atk' | 'maxHp' | 'maxSt' | 'parryPct' | 'blockMaxS' | 'dmgMul'
  | 'chargeSpd' | 'chargeMax' | 'thorn' | 'lifesteal' | 'multiWave'
  | 'impact' | 'stability' | 'critRate' | 'critDmg'

const STAT_DEFAULTS: Record<StatKey, number> = {
  atk: 10, maxHp: 100, maxSt: 100, parryPct: 0.5, blockMaxS: 1.0,
  dmgMul: 1, chargeSpd: 1, chargeMax: 1.0, thorn: 0, lifesteal: 0,
  multiWave: 0, impact: 1, stability: 1, critRate: 0.05, critDmg: 1.0,
}
```

- `MpPlayer`：删除 `atk/maxHp/parryPct/maxSt/blockMaxS/dmgMul/chargeSpd/thorn/lifesteal/multiWave` 10 个散字段 → 一个 `stats: Record<StatKey, number>`（`join()` 里 `stats: { ...STAT_DEFAULTS }`）。
- 全文替换引用：`p.atk` → `p.stats.atk` 等（约 40+ 处，含 `damageZombie` 吸血、`applyPicks`、`fireWave`、`snapshot`、`playerAttack` 三段、体力公式等）。提供私有 helper `private st(p: MpPlayer, k: StatKey): number` 可选——直接 `p.stats[k]` 即可，不引入多余抽象。
- `snapshot()` 字段名与数值不变（PF 端无感知），仅新增 T2 的字段。

**PF 侧**：本任务无改动（快照字段不变）。

**验收**：tsc 通过；smoke / multi_smoke 全绿（数值行为与重构前完全一致）。

---

### T3 伤害系统：DamageSource 对象

**PB `world.ts`**

- 新增：

```ts
/** 伤害符号：治疗 / 被闪避·格挡 / 正常 / 暴击 */
enum DamageSign {
  Heal = -1,
  Blocked = 0,
  Normal = 1,
  Crit = 2,
}

interface DamageSource {
  from: string          // 'p:<uuid>' | 'z:<id>' | 'sys'
  amount: number        // 绝对值，>0
  sign: DamageSign
  impact: number        // 受击者扣除的体力基值
}
```

- 统一结算入口（新增私有方法）：
  - `applyDamageToZombie(z, dmg: DamageSource, by: MpPlayer, now)` —— 由现 `damageZombie` 改造（吼叫打断、易伤、击退、`dmg_z` 事件带 `sign`、吸血结算移入此处）。
  - `applyDamageToPlayer(v, dmg: DamageSource, byPlayer, byZombie, now)` —— 现格挡评估（完美→`DamageSign.Blocked`；25% 失败→`DamageSign.Normal`）仍在这层，落血 + 荆棘反伤 + 吸血 + `dmg_p` 事件带 `sign` 收敛到现 `hurtPlayer`（签名改为接收 DamageSource）。
  - `reflectDamage` 改为构造 `sign: DamageSign.Normal`、from=荆棘持有者的 DamageSource 复用同一落血函数。
- 现有调用点全部改为「构造 DamageSource 再调入口」：
  - `playerAttack` 三段（L439/L451 附近）、`tickWaves` 剑气命中（L415-416）、`damagePlayerByZombie`（L906 附近的僵尸普攻 10 伤）、横扫 / 突进 / 嘶吼路径。
- 事件扩展：`dmg_z` / `dmg_p` 增加 `sign: DamageSign` 字段（`crit: boolean` 字段删除，由 `sign === DamageSign.Crit` 取代——PF messages.ts 同步）。
- **僵尸体力扣除通道**（T2b 的挂点）：`useStamina(p, n, now)` 改签名为 `useStamina(target, dmg: DamageSource | { base, attacker }, now)` 或新增第三参 `attacker?: MpPlayer | MpZombie | null`——推荐后者：`n = base × attackerImpact / targetStability`（见 T2b）。所有 `useStamina` 调用点传入来源信息。

**PF `messages.ts` / 表现层**

- `dmg_z` / `dmg_p` 类型同步 `sign: DamageSign`（PF 侧定义同构枚举）、删 `crit`。
- 飘字按 sign 着色：`Crit`=暴击（大号橙红 + 放大）、`Heal`=治疗（绿 +「+」）、`Blocked`=格挡（灰「格挡」）、`Normal`=普通（现状白）。改 `combat.pushFloat` / `SceneManager.handleMpEvent` 飘字分支。

**验收**：multi_smoke 现有 8 项全过；为数值正确性新增 2 个 smoke 断言用例（见 §五）。

---

### T2a 蓄力上限词条 + 重击公式

**语义（关键决策，见 §六 Q1）**：有效蓄力时长 `effHold = min(hold × chargeSpd, chargeMax)`；伤害 = `atk × 300% × effHold × dmgMul`。chargeSpd=1、hold=1 时 = 3×atk = 30，与现行 WAVE_DMG=30 基准一致。

**PB `world.ts`**

- `fireWave(p, now, hold)`：
  - `effHold = Math.min((hold ?? 1) * p.stats.chargeSpd, p.stats.chargeMax)`
  - 剑气伤害改为 `p.stats.atk * 3 * effHold * p.stats.dmgMul`（现 `WAVE_DMG * atk/10 * dmgMul` 删除；`WAVE_DMG` 常量删除）
  - 体力消耗 `useStamina(p, 10 * effHold, now)`（现 `10 * min(5, hold)` 的上限保护由 chargeMax 天然承担）
- `tickWaves` 剑气伤害值同步改（或 fireWave 时把伤害存进 Wave 对象，tick 直接取——推荐后者，避免二次计算不一致）。

**PF**

- `combat.ts`：`chargeDur = 1/chargeSpd` 改为 `chargeDur = chargeMax / chargeSpd`（202 行附近 `mine.charge_dur` → 快照新增 `charge_max`）；HUD 蓄力进度公式不变（`hold/chargeDur`）。
- `releaseCharge` 上报 hold 不设上限（PB 端钳制）——现 `Math.min(5, …)` 删除。
- `messages.ts`：`NetPlayerState` 加 `charge_max`。

**验收**：multi_smoke 新用例：hold=0.5 → 伤害 15×dmgMul；hold=2、chargeMax=1 → 伤害 30×dmgMul。

---

### T2b 冲击力 / 稳定性

**公式**：`扣除体力 = 基值 × 攻击者冲击力 / 受击者稳定性`；无攻击者 → 冲击力按 100%。僵尸无词条：攻击者/受击者为僵尸时恒 1。

**PB `world.ts`**

- `useStamina(target, base, now, attacker?)`（attacker: `MpPlayer | MpZombie | null`）：
  - `const ai = attacker && 'stats' in attacker ? attacker.stats.impact : 1`
  - `const tv = 'stats' in target ? target.stats.stability : 1`
  - `n = base × ai / tv`
- 全部调用点传入攻击者（约 12 处）：
  - 剑气命中玩家（L639/660/664/669）→ attacker = 发射者
  - 完美格挡反噬玩家攻击者（L648，SWEEP/ROAR 反噬 933/996）→ attacker = 攻击方
  - 僵尸普攻/横扫/嘶吼命中玩家 → attacker = 僵尸（impact 恒 1）
  - 玩家攻击扣僵尸体力 `spendZ`（L908/938/983）→ attacker = 玩家，target=僵尸（双方恒 1，数值不变但通道打通）
  - `fireWave` 自扣（L359）→ attacker = null（100%）
- `applyDamageToPlayer` 内部统一走该签名（impact 取 DamageSource.impact）。

**PF**：仅快照字段 `impact` / `stability` 下发（HUD 可选展示，本次不加 UI）。

**验收**：multi_smoke 新用例：impact=1.5 的玩家攻击 → 僵尸扣体力 = 基值×1.5。

---

### T2c 暴击率 / 暴击伤害

**公式**：掷点 `Math.random() < critRate` → `sign: DamageSign.Crit`，`amount = base × (1 + critDmg)`。初始 5% / 100%。

**PB `world.ts`**

- 暴击掷点位置：`playerAttack` 三段与 `fireWave`（构造 DamageSource 时）；**荆棘反伤 / 僵尸攻击不暴击**（僵尸无词条，天然不触发）。
- `dmg_z`/`dmg_p` 的 `sign` 已由 T3 携带，本任务仅加掷点逻辑。

**PF**

- 飘字暴击样式（T3 已铺好，本任务联调样式）。
- 快照 `crit_rate` / `crit_dmg`（HUD 可选）。

**验收**：smoke 无法断言随机暴击——multi_smoke 连续攻击 30 次断言至少出现一次 `sign === DamageSign.Crit`（统计性断言）。

---

### T5 三选一池扩展（依赖 T1/T2 全部就绪）

**PB `world.ts`**：`PICK_OPTIONS` 由 `string[]` 改为 `{ label: string; key: StatKey; add: number }[]`（表驱动），`applyPicks` 变查表：

- 特殊项保留定制逻辑：`maxHp`/`maxSt` 按百分比回补当前值；`parryPct`/`dmgMul`/百分比项 ×100 取整防浮漂。
- 新增档位建议（**待确认，见 §六 Q3**）：
  `蓄力上限 +0.25s`、`冲击力 +15%`、`稳定性 +15%`、`暴击率 +5%`、`暴击伤害 +25%`
- `protocol.ts` idx 上限同步 `max(N-1)`。

**PF**：`BuffPickModal.vue` LABELS 追加对应文案（索引对齐）。

---

### T4 闪避 Bug 修复（独立）

**根因（已定位）**：`tryDash` 把 `vel` 设为 8.5 m/s，但渲染循环每帧的水平**软上限**把速度钳回 `maxSpeed = 3.0`（`SceneManager.ts` L953-958），闪避瞬间被掐灭，视觉等于没触发。

**修复（`SceneManager.ts`）**

- 新增 `dashFreeUntil`：`tryDash` 成功时 `= now + 0.25`；软上限判断改为 `if (hSpeed > maxSpeed && now > this.dashFreeUntil)`。
- 同时修时序边角：`keys.add(e.code)` 移到 Shift 分支**之前**（当前在 L869，Shift 同帧早于方向键按下时 keys 还没有方向）。

**验收**：手动测试（Shift+W 明显位移 + dash 音效）；构建通过。

---

### T6 空中戳刺（独立，排 T3 后）

**PB `world.ts`（改动很小）**

- `playerAttack` 删除 `airMul`（L433-434 与 L439 引用）——空中左键就是一次普通近战裁决（PB 已按 `findMeleeTarget` 找最近敌人）。
- 空中重击：现流程已支持（蓄力→wave），无特殊动作，不改。

**PF（主要工作量）**

- `combat.ts`：
  - 左键按下时若处于空中（`!onGround`，用相机高度 / vy 判断，`SceneManager` 提供查询或回调）且非蓄力 → **空中戳刺**：目标池 = 存活 `NetZombie` + `remotePlayers.centers()`，取最近且 ≤ 3.4m 者；有目标：播放戳刺动画（复用现成 `SWING_THRUST`）+ 上报 `attack segment 0`（PB 正常裁决）+ 通知 SceneManager 做摄像机 lerp；无目标在 3.4m 内 → 普通挥砍。
  - `anim` 标签新增 `'stab'`，携带俯仰：`stab|<pitch>`（如 `stab|0.62`，pitch = 顶面法向量俯仰角弧度）。
- `SceneManager.ts`：
  - 摄像机 3D lerp：新增 `stabLerp = { quat: Quaternion, until }` 状态，期间 `lockCtl.pointerSpeed = 0` 并每帧 `camera.quaternion.slerp(目标四元数, min(1, dt*10))`；结束（落地或 0.4s）恢复 pointerSpeed=1。**注意 PointerLockControls 直接写 camera.rotation，slerp 期间必须压掉其输入**（已验证其有 pointerSpeed 属性可控）。
  - `sendMpInput` 的 `anim` 字段透传 `stab|pitch` 格式。
- `RemotePlayers.ts`：
  - 解析 `stab|pitch`：播放戳刺手臂动作，同时整个玩家 group 从直立 slerp 到「顶面法向量指向 (yaw 水平角, pitch 俯仰)」的倾斜姿态（用四元数 `setFromUnitVectors(+Y, dir)`），动画期结束 slerp 回直立。死亡倒地（rotation.z）与 stab 互斥，不冲突。
- `messages.ts`：`anim` 仍为 string，无结构变更。

**验收**：构建通过 + 双开浏览器手测：空中左键镜头转向目标、其他窗口可见圆柱体倾斜指向目标；空中重击正常出剑气。

---

### T7 重启 PB 按钮（独立）

**现状**：PB 单进程（`index.ts`）同时服务 `/ws/scb`、`/ws/pf`、`/api/state`；SCB（智能家居本体）是连接 `/ws/scb` 的**外部客户端**。「仅重启 PB」= 重启该 Bun 进程；PF 已有断线自动重连（指数退避，client.ts）。

**方案（PB 自接管重启，无外部依赖）**

1. `protocol.ts`：PF 载荷新增 `admin_restart`（空对象）；PB 事件新增广播 `admin_restarting`。
2. `index.ts`：
   - 收到 `admin_restart` → 向所有连接广播 `admin_restarting` → 300ms 后 `Bun.spawn([process.execPath, 'src/index.ts'], { env: { ...process.env, PB_TAKEOVER_PORT: String(PORT) }, stdio: ['ignore','inherit','inherit'] })` → `process.exit(0)`。
   - 启动时若存在 `PB_TAKEOVER_PORT`：listen 失败（EADDRINUSE）则重试（200ms × 最多 60 次）。
3. `StatusBar.vue`：红色「重启服务器」按钮 + **二次确认**（首次点击变「确认重启？」，3s 未确认还原），确认后 `pbClient.send({ type: 'admin_restart', ... })`；收 `admin_restarting` → conn store 置提示态「PB 重启中」。
4. `client.ts`：`admin_restarting` 消息分发（onMpEvent 之外的通知通道或复用现有 message 回调链）。

**已知影响（写入实现注释与 UI 提示）**：PB 内存中的设备状态机随进程重置为初始快照，SCB 重连后以其实际状态重新同步；SCB 若无自动重连需其自身支持（不属于本次改动范围）。

**备选方案 B**（若 spawn detached 在 Windows 上不稳）：PB 暴露 `POST /api/restart` → `process.exit(0)`，依赖 `bun --watch` 拉起；作为降级路径。

---

## 三、协议字段汇总（PB protocol.ts ↔ PF messages.ts 必须成对改）

| 位置 | 变更 |
|---|---|
| `dmg_z` / `dmg_p` 事件 | +`sign`，−`crit` |
| 快照 players | +`charge_max`、`impact`、`stability`、`crit_rate`、`crit_dmg` |
| mp_input.anim | 值域新增 `stab\|<pitch>`（仍为 string） |
| PF 载荷 | +`admin_restart`；广播 +`admin_restarting` |
| mp_action pick | idx max 更新为新池长度−1 |

---

## 四、验证计划

1. 每任务：`bunx tsc --noEmit` → `bun run smoke`（12 项）→ `bun scripts/multi_smoke.ts`（8 项）→ `npm run build`。
2. multi_smoke 新增用例（随 T2/T3 一起加）：
   - 蓄力伤害：hold=0.5 / hold=2（钳到 chargeMax）两个断言
   - 冲击力：改 impact 后断言僵尸扣体量
   - 暴击：30 次攻击至少 1 次 `sign === DamageSign.Crit`（统计性断言）
3. 人工手测清单：闪避位移、空中戳刺（含远端圆柱倾斜）、重启按钮（双浏览器在线时一台点重启、另一台自动恢复）。

## 五、风险与注意

- T1 是大面积机械替换（40+ 处），靠 tsc 兜底，单独提交便于回溯。
- T3 动了所有伤害路径，务必在 T3 落地后先全量回归再加新词条，避免「重构 + 新功能」混在一个不可 bisect 的提交里。
- 蓄力体力消耗公式变化（10×effHold）会改变手感（原 1s 蓄力扣 10，现在一样；但 chargeSpd>1 时 effHold 变大扣得更多）——语义上「更快蓄满=更贵」，合理。
- 重启按钮是运维性质破坏性操作，二次确认 + 仅 PF 通道可发（SCB 通道 schema 不含 admin_restart，天然隔离）。

## 六、待确认决策点

- **Q1 蓄力公式**：我按 `effHold = min(hold × chargeSpd, chargeMax)` 设计（chargeSpd 语义 = 加速蓄满，与现有「蓄力速度+15%」兼容）。若你想要「chargeSpd 完全废弃 / 或蓄力时间就是裸按住秒数」，请指出。
- **Q2 空中戳刺的暴击/荆棘**：戳刺即普通近战攻击，走同一伤害管线（可暴击、可触发荆棘吸血），无特殊倍率——确认无误？
- **Q3 新词条入池档位**：§T5 的 5 个建议档位（蓄力上限+0.25s / 冲击力+15% / 稳定性+15% / 暴击率+5% / 暴伤+25%）是否照此入池？池子将到 15 项。
- **Q4 重启影响**：设备状态在 PB 内存中，重启后回初始快照（SCB 重连后重同步）。可接受？
