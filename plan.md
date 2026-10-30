# plan.md — 词条/升级/卡牌/UI 大重构

事实源：`pb/src/world.ts`（PB 权威裁决）；PF 只做表现。协议同步改 `pf/src/protocol/messages.ts`。

## 任务拆解与依赖

```
P1 武器改名+基类拓展 ─┐
P2 闪避/格挡冷却 ─────┼─→ P3 僵尸 level/全可格挡 ─→ P4 词条基建 ─→ P5 升级系统 ─→ P6 卡牌系统 ─→ P7 UI ─→ P8 测试+验证
                      └（P1/P2/P3 均只动 world.ts+combat.ts，可连续做）
```

## P1 武器：改名 + attackTime + parry 提取
- PB `world.ts`：SwordWeapon.weaponName `'双手剑'→'无锋剑'`；BaseWeapon 加 `attackTime: number`（剑 0.3 / 弓 0.3），normalAttack 的 `ATTACK_MIN_INTERVAL` 改用 `this.attackTime`（删常量）；BaseWeapon 加 `parry(p, now)`（默认空实现），SwordWeapon 实现现格挡起手（原 action 里 parry_start 分支逻辑迁入），`action()` 的 `parry_start` 路由到 `this.weapons[p.weapon].parry(...)`。
- PF `combat.ts`：WEAPON_NAMES.sword→`'无锋剑'`；PF BaseWeapon 加 `attackTime` + `parry(now): boolean`（剑=现 startBlock 逻辑迁入返回 true；弓=返回 false 不可格挡）；PlayerCombat.startBlock 委托 weapon.parry。

## P2 闪避重构 + 格挡冷却新规则
- PF `SceneManager.ts`：`tryDash` → 公开 `dash(now, invincible = false)`（现行为不变）；invincible=true 时上报新 action `'dash'`。
- PB：MpActionPayload 加 `'dash'` → `p.dashInvulnUntil = now + 0.3`；damagePlayer / damagePlayerByZombie 入口检查 `now < v.dashInvulnUntil` → 无伤（dmg_p sign=0 飘「格挡」）。
- 格挡冷却（PB 两处格挡评估 + PF 同步）：
  - 完美格挡：退出格挡 + **不进冷却**（可立即再格挡）；
  - 普通格挡成功：退出格挡 + 冷却 `BLOCK_CD_S`；
  - `parry_stop` 维持现冷却；PF `handleMpEvent('parry')`：!fail → 本地 blocking=false，perfect ? 无 CD : CD 0.5s（与 PB 对齐）。

## P3 僵尸 level / 新公式 / 全攻击可格挡
- `MpZombie` 加 `level`（台灯召唤=0）；`spawnZombie(level)`：hp=maxHp=100+25*level（删 Z_TIER_HP/Z_TIER_DMG/zTier/dmgBonus）；死亡补员 = `spawnZombie(z.level+1)`；三系伤害 `10/12/14 + 0.25*level`。
- 全可格挡：sweep 原直伤+破防 → `damagePlayerByZombie`(impact 15)；lunge → `damagePlayerByZombie`(impact 10)，未格挡才击退；roar → 格挡中则免体力损失与 slow（parry 事件 + registerBlock）。
- 快照 zombie 加 `level`；PF NetZombieState/NetZombie 存 level，准星目标栏显示 `Lv.n`。

## P4 词条基建
- PB：`enum DataFormat { INT, VALUE, PERCENT, FREQUENCY, ANGLE }`；`STAT_DEFS: Record<StatKey, { format; name; after?(p, old) }>`（maxHp→hp 同比例回补、maxSt→stamina 同比例、parryPct/critRate 封顶 1）；删 PCT_STAT_KEYS，按 format===PERCENT 取整。
- 场景共享：`world.luck=1`（VALUE）、`world.expMul=1`（PERCENT）为场景词条；`world.exp=0`、`world.level=0` 为场景属性（非词条）。快照加 `scene: { exp, level, luck, exp_mul }`。
- 统一入口 `applyStatChange(p, key, add)`（改值 + 钩子），applyPicks 改走它。

## P5 升级系统
- 僵尸死亡：`exp += (100 + 50*z.level) * expMul`，**不再直接 startPickPhase**；删 death 里的 zTier/补员逻辑移至 P3 版本。
- 经验阈值：死亡结算后若 `exp >= 100 + level*75` → 扣除、`level++`、广播 `level_up` 事件、`pickStartAt = now + 3.0`（提示期 2.5s 动画内可继续攻击）；tick 检查到期 → startPickPhase。
- LEVEL UP 动画（PF）：0.5s 缓出（2x→1x、渐显）+ 停留 2s + 0.5s 缓入（1x→0、渐隐），橙色。

## P6 卡牌系统
- `enum CardQuality { WASTE(50,-5) NORMAL(100,-3) RARE(60,0) EPIC(20,+3) LEGENDARY(8,+4) INFINITY(1,+5) }`（初始权重, 幸运加权）。
- 标签池：通用/生存/暴击/专精-无锋剑/苍弓/圣金源盾/星尘溶液/AK47，初始权重 30，`tagWeights: Record<string, number>`。
- 卡牌 DB：`{ id, label, labels[], quality, apply(world, p) }`；现有 17 选项全 NORMAL+`['通用']`；新卡：幸运+1、经验倍率+13%、出现[标签]卡牌概率提高（每个标签一张，apply=tagWeights+10，NORMAL）。
- 抽卡 rollCards(luck)：①权重抽 3 标签 → ②各按 `max(1, 初始+luck*加权)` 抽稀有度 → ③每项筛「含该标签」的卡随机选（不加权；空池回退：该标签任意稀有度 → 通用卡）；④得 3 张。
- `p.pick.options` 从索引数组改为卡牌对象数组（协议 `{ id, label, quality, labels }`）；pickChoose 收 0-2；applyPicks 执行 card.apply。

## P7 UI 重构
- 击杀排行榜移至屏幕顶部中心；其下新增词条面板（我的词条：17 词条 + 场景 幸运/经验倍率/经验/等级，按 DataFormat 格式化）；**Tab 切换两者同生死**（App.vue 键盘监听 + v-show 同一状态）。
- BuffPickModal：标题改「升级」，渲染卡牌对象（稀有度配色：灰/白/蓝/紫/金/彩虹渐变，labels 标签 chips），上报 0-2。
- SceneManager：level_up 事件 → onLevelUp 回调；pick options 透传卡牌对象；scene 透传。
- 新组件 `StatPanel.vue`、`LevelUpBanner.vue`；combat.getHud target 加 level。

## P8 测试更新 + 全量验证
- multi_smoke：case14 断言补员 hp 540→125（level1）、dmgBonus→level===1；pick idx 改发 0-2；击杀 0 级僵尸得 100 exp = 阈值 100 → level_up 后 ~3s pick_phase 开启（等待窗口足够）；快照 scene 断言。
- 验证：`cd pb; .\node_modules\.bin\tsc.exe --noEmit`；`bun run smoke`；`bun scripts/multi_smoke.ts` ×3；`cd pf; npm run build`。
- 全绿后 `shutdown /s /t 30`（可 `shutdown /a` 取消）。

## 需修改文件清单
| 文件 | 改动 |
|---|---|
| pb/src/world.ts | P1-P6 全部裁决逻辑 |
| pf/src/protocol/messages.ts | dash action、zombie.level、scene、卡牌 pick、level_up 事件 |
| pf/src/three/combat.ts | 无锋剑名、parry/attackTime、目标栏 Lv、parry 事件同步 |
| pf/src/three/SceneManager.ts | dash 重构、level_up/scene/pick 透传 |
| pf/src/three/zombie.ts | level 存储 |
| pf/src/components/BuffPickModal.vue | 卡牌化重写 |
| pf/src/components/Leaderboard.vue | 顶部居中 |
| pf/src/components/StatPanel.vue | 新增 |
| pf/src/components/LevelUpBanner.vue | 新增 |
| pf/src/App.vue | Tab 切换 / 新组件接线 |
| pb/scripts/multi_smoke.ts | 断言更新 |
