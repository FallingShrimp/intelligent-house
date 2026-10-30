/**
 * PB 联机对战冒烟测试（bun scripts/multi_smoke.ts）
 *
 * 与服务同进程启动（随机端口），覆盖联机世界模拟核心链路：
 * 1. 双 PF 客户端 hello（带 display_name）→ 各自分配 uuid + 不同随机颜色
 * 2. 世界快照：fp 玩家互见（10Hz 广播），free 玩家不在房间
 * 3. 房间内玩家点击台灯（mp_action lamp）→ PB 生成共享僵尸
 * 4. 玩家攻击僵尸 → dmg_z 事件（三段连击 90% = 9 伤害；开局关闭 A 暴击保证基线）
 * 5. 友伤：攻击其他玩家 → dmg_p 事件
 * 6. 完美格挡：对方 parry_start 后立即受击 → parry(perfect) + 攻击者 guardbreak
 * 7. 化气：完美格挡回复 格挡伤害×化气（9×30%=2.7，dmg_p sign=-1）
 * 8. 普通格挡（非完美窗口）：无伤扣体 = 普攻冲击力 3（parry.drain 随攻击类型动态）
 * 9. 退出第一人称（mode=free）→ 快照 fp=false（退出房间）
 * 10. 断开连接 → leave 事件 + 快照移除玩家
 * 11. 重击剑气蓄力：hold=0.5 → 伤害 15×dmgMul；hold=2 钳到蓄力上限 1.0 → 30×dmgMul
 * 12. 暴击：critRate=1 连击全部 sign=2（伤害 ×(1+critDmg)）；critRate=0 恢复 sign=1
 * 13. 冲击力：玩家 impact=1.5 → 僵尸落手扣体 10×1.5=15
 * 14. 僵尸死亡 → 场景经验 100 达阈值触发升级（level_up 事件 + 3s 提示期）→ 门处补员 level+1（hp 125）→ 升级三选一冻结与解除
 * 15. 苍弓普攻：射球状闪电 → 首中附着（orb_stop target）+ 0.1s×3 伤 tick（不暴击）+ 6s TTL 到期消失
 * 16. 苍弓激光：charge_start → 0.2s×15 伤 tick（穿透双僵尸）+ 蓄力中切武器被拒 + charge_stop 停止
 * 17. 蓄满自动爆发：charge ≥ chargeDur → 40 伤一次 + chargeStartAt 清空 + 激光停止
 * 18. 提前松手：charge_stop → 无爆发无残留 tick；松手后切武器生效
 * 19. 切回双手剑：shoot 走近战裁决（三段 90%=9 伤）且不再产生 orb
 *
 * 用例 11-13 通过同进程导出的 world 单例做确定性铺垫（关暴击 / 摆僵尸位 / 设词条），
 * 战斗结算本身仍走完整协议链路（mp_input / mp_action → PB 裁决 → 事件广播）。
 */
import { app, logger, startWorldLoop, world } from '../src/index'

logger.level = 'silent'

// ---------- 测试基建（与 smoke.ts 相同模式） ----------

type AnyMsg = Record<string, any>
type Timer = ReturnType<typeof setTimeout>

interface Waiter {
  pred: (m: AnyMsg) => boolean
  resolve: (m: AnyMsg) => void
  timer: Timer
}

interface TestConn {
  ws: WebSocket
  inbox: AnyMsg[]
  waiters: Waiter[]
  closed: boolean
  closedPromise: Promise<void>
  markClosed: () => void
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`断言失败: ${msg}`)
}

function connect(path: string): Promise<TestConn> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${port}${path}`
    const ws = new WebSocket(url)
    let notifyClosed: () => void = () => {}
    const closedPromise = new Promise<void>((r) => {
      notifyClosed = r
    })
    const conn: TestConn = {
      ws,
      inbox: [],
      waiters: [],
      closed: false,
      closedPromise,
      markClosed: () => {},
    }
    conn.markClosed = () => {
      conn.closed = true
      notifyClosed()
    }
    ws.onopen = () => resolve(conn)
    ws.onerror = () => reject(new Error(`WS 连接失败: ${url}`))
    ws.onclose = () => conn.markClosed()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as AnyMsg
      conn.inbox.push(msg)
      const i = conn.waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) {
        const [w] = conn.waiters.splice(i, 1)
        const idx = conn.inbox.indexOf(msg)
        if (idx >= 0) conn.inbox.splice(idx, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
      }
    }
  })
}

function recv(conn: TestConn, type: string, timeoutMs = 5000): Promise<AnyMsg> {
  const i = conn.inbox.findIndex((m) => m.type === type)
  if (i >= 0) return Promise.resolve(conn.inbox.splice(i, 1)[0])
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      pred: (m) => m.type === type,
      resolve,
      timer: setTimeout(() => {
        const idx = conn.waiters.indexOf(w)
        if (idx >= 0) {
          conn.waiters.splice(idx, 1)
          reject(new Error(`等待 ${type} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs),
    }
    conn.waiters.push(w)
  })
}

/** 按 pred 取出一条消息（事件类型匹配用） */
function recvWhere(conn: TestConn, pred: (m: AnyMsg) => boolean, desc: string, timeoutMs = 5000): Promise<AnyMsg> {
  const i = conn.inbox.findIndex(pred)
  if (i >= 0) return Promise.resolve(conn.inbox.splice(i, 1)[0])
  return new Promise((resolve, reject) => {
    const w: Waiter = {
      pred,
      resolve,
      timer: setTimeout(() => {
        const idx = conn.waiters.indexOf(w)
        if (idx >= 0) {
          conn.waiters.splice(idx, 1)
          reject(new Error(`等待 ${desc} 超时（${timeoutMs}ms）`))
        }
      }, timeoutMs),
    }
    conn.waiters.push(w)
  })
}

function send(conn: TestConn, type: string, seq: number, payload: AnyMsg): void {
  conn.ws.send(JSON.stringify({ v: 1, type, seq, ts: Date.now(), payload }))
}

let seq = 0
function nextSeq(): number {
  return ++seq
}

/** 上报 10Hz 输入（位置 / 朝向 / 模式） */
function input(conn: TestConn, p: [number, number, number], dir: [number, number], mode: 'fp' | 'free'): void {
  send(conn, 'mp_input', nextSeq(), { p, yaw: 0, dir, dir3: [dir[0], 0, dir[1]], mode, anim: null })
}

/** 轮询等待快照条件成立（10Hz world 消息） */
async function waitWorld(conn: TestConn, pred: (w: AnyMsg) => boolean, desc: string, timeoutMs = 6000): Promise<AnyMsg> {
  const deadline = Date.now() + timeoutMs
  // 先翻收件箱历史
  for (const m of conn.inbox) {
    if (m.type === 'world' && pred(m.payload)) {
      conn.inbox.splice(conn.inbox.indexOf(m), 1)
      return m
    }
  }
  conn.inbox = conn.inbox.filter((m) => m.type !== 'world')
  while (Date.now() < deadline) {
    const m = await recv(conn, 'world', deadline - Date.now()).catch(() => null)
    if (!m) break
    if (pred(m.payload)) return m
  }
  throw new Error(`等待世界条件超时（${timeoutMs}ms）: ${desc}`)
}

const allConns: TestConn[] = []

// ---------- 启动服务（随机端口） ----------

app.listen(0)
const port = app.server!.port
// 导入模式下 import.meta.main 为 false，需显式启动联机世界循环
const stopWorldLoop = startWorldLoop()

// ---------- 测试主体 ----------

let passed = 0

async function step(name: string, fn: () => Promise<void> | void): Promise<boolean> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
    return true
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err instanceof Error ? err.message : err)
    return false
  }
}

async function main(): Promise<void> {
  console.log(`▶ PB 联机冒烟测试启动（端口 ${port}）`)
  let a!: TestConn
  let b!: TestConn
  let uuidA = ''
  let uuidB = ''
  let ok = true

  ok =
    (await step('双客户端 hello（带 display_name）→ 各自获得 uuid 与互异颜色', async () => {
      a = await connect('/ws/pf')
      allConns.push(a)
      send(a, 'hello', nextSeq(), { role: 'pf', client_name: 'smoke-a', client_version: '0.1.0', display_name: '玩家A' })
      const wa = await recv(a, 'welcome')
      uuidA = wa.payload.you.uuid
      assert(typeof uuidA === 'string' && uuidA.length > 10, `A uuid: ${uuidA}`)
      assert(wa.payload.you.name === '玩家A', 'A 玩家名回显')

      b = await connect('/ws/pf')
      allConns.push(b)
      send(b, 'hello', nextSeq(), { role: 'pf', client_name: 'smoke-b', client_version: '0.1.0', display_name: '玩家B' })
      const wb = await recv(b, 'welcome')
      uuidB = wb.payload.you.uuid
      assert(uuidB !== uuidA, 'B uuid 与 A 不同')
      assert(wb.payload.you.color !== wa.payload.you.color, `颜色互异: ${wa.payload.you.color} vs ${wb.payload.you.color}`)
      // 彼此的 join 事件（10Hz tick 后广播）
      const joinAinB = await recvWhere(b, (m) => m.type === 'event' && m.payload.kind === 'join' && m.payload.uuid === uuidA, 'B 视角 A join')
      assert(joinAinB.payload.name === '玩家A', 'join 事件携带玩家名')
      await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'join' && m.payload.uuid === uuidB, 'A 视角 B join')
    })) && ok

  ok =
    (await step('free 模式不在房间；进入第一人称（mode=fp）后双方快照互见', async () => {
      // A 尚未上报任何输入：B 视角快照中 A 的 fp=false（join 默认 free）
      await waitWorld(b, (w) => w.players.some((p: AnyMsg) => p.uuid === uuidA && p.fp === false), 'A 默认 free')
      // A 上报 fp（站门口朝门廊）
      input(a, [-3.0, 1.6, 1.9], [-1, 0], 'fp')
      await waitWorld(b, (w) => w.players.some((p: AnyMsg) => p.uuid === uuidA && p.fp === true), 'A 进入房间 fp=true')
      // B 也进入房间
      input(b, [-2.4, 1.6, 1.9], [-1, 0], 'fp')
      const w = await waitWorld(a, (w) => {
        const pa = w.players.find((p: AnyMsg) => p.uuid === uuidA)
        const pb = w.players.find((p: AnyMsg) => p.uuid === uuidB)
        return pa?.fp === true && pb?.fp === true
      }, '双方 fp 互见')
      assert(w.payload.players.length === 2, '快照含 2 名玩家')
    })) && ok

  let zombieId = -1
  ok =
    (await step('房间内玩家点击台灯（mp_action lamp）→ PB 生成共享僵尸', async () => {
      input(a, [-3.0, 1.6, 1.9], [-1, 0], 'fp')
      send(a, 'mp_action', nextSeq(), { kind: 'lamp' })
      const w = await waitWorld(a, (w) => w.zombies.length > 0, '僵尸生成', 6000)
      zombieId = w.payload.zombies[0].id
      // 共享：B 的快照同样看得到
      await waitWorld(b, (w) => w.zombies.some((z: AnyMsg) => z.id === zombieId), 'B 看到同一只僵尸')
    })) && ok

  ok =
    (await step('玩家 A 攻击僵尸 → dmg_z 事件（三段连击 90% = 9 伤害）', async () => {
      // 关闭 A 暴击（默认 5% 会偶发 ×2 污染基线断言；暴击机制由后置专用用例验证）
      world.players.get(uuidA)!.stats.critRate = 0
      // 等僵尸 chase 靠近 A 至攻击距离内（REACH 3.0）
      await waitWorld(a, (w) => {
        const z = w.zombies.find((x: AnyMsg) => x.id === zombieId)
        if (!z || z.state === 'dead') return false
        const d = Math.hypot(z.p[0] - -3.0, z.p[2] - 1.9)
        return d <= 3.0
      }, '僵尸进入攻击距离', 8000)
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 })
      const dmg = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z', 'dmg_z 事件')
      assert(dmg.payload.amount === 9, `首段伤害 9（实际 ${dmg.payload.amount}）`)
      assert(dmg.payload.by === uuidA, '伤害归属 A')
      // 共享事件：B 也收到同一 dmg_z
      await recvWhere(b, (m) => m.type === 'event' && m.payload.kind === 'dmg_z', 'B 视角 dmg_z')
    })) && ok

  ok =
    (await step('友伤：A 攻击面前的 B → dmg_p 事件（顺带验证防御词条：def=110 → 9×500/600=7.5）', async () => {
      await sleep(400) // 服务端攻击最小间隔 0.3s
      // B 站到 A 前方 0.6m；A 转向 +x
      input(b, [-2.4, 1.6, 1.9], [-1, 0], 'fp')
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      await sleep(150) // 输入到达 PB
      const pbp = world.players.get(uuidB)!
      pbp.stats.def = 110 // 防御缩放：9 × 500/(490+110) = 7.5
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 1 })
      const dmg = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_p' && m.payload.uuid === uuidB, 'dmg_p(B)')
      assert(dmg.payload.amount === 7.5, `友伤 9×500/(490+110)=7.5（实际 ${dmg.payload.amount}）`)
      pbp.stats.def = 10 // 恢复基准，避免污染后续用例
      assert(dmg.payload.by === uuidA, '友伤来源 A')
    })) && ok

  ok =
    (await step('完美格挡：B parry_start 后立即受击 → parry(perfect) + A 被反噬 guardbreak', async () => {
      await sleep(400)
      send(b, 'mp_action', nextSeq(), { kind: 'parry_start' })
      await sleep(40) // parry_start 先落地
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 2 })
      const parry = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'parry' && m.payload.uuid === uuidB, 'parry 事件')
      assert(parry.payload.perfect === true, '0.3s 窗口内 → perfect=true')
      assert(parry.payload.byZombie === false, 'PVP 格挡')
      // 攻击者 A：-20 体力 + 0.5s 硬直事件
      const gb = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'guardbreak' && m.payload.uuid === uuidA, 'A guardbreak')
      assert(gb.payload.dur === 0.5, '攻击者硬直 0.5s')
      // 格挡者 B 无伤（快照 hp 不减）
      await waitWorld(a, (w) => {
        const pb = w.players.find((p: AnyMsg) => p.uuid === uuidB)
        return pb && pb.hp === 100
      }, 'B 满血（格挡成功）')
    })) && ok

  ok =
    (await step('化气：完美格挡回复 格挡伤害×化气（9×30%=2.7，dmg_p sign=-1 绿色飘字）', async () => {
      const pbp = world.players.get(uuidB)!
      const z = world.zombies[0]
      // 僵尸暂移远处，避免其攻击污染血量断言（后续剑气用例会重新摆位）
      z.x = 20; z.z = 1.9
      pbp.hp = 50 // 先掉血，回复量才可见
      // B 仍在格挡态但 blockStart 已过期 → parry_stop + 冷却 0.5s 后重新 parry_start
      send(b, 'mp_action', nextSeq(), { kind: 'parry_stop' })
      await sleep(600)
      send(b, 'mp_action', nextSeq(), { kind: 'parry_start' })
      await sleep(40) // parry_start 先落地（窗口 0.5s 内受击 → 完美格挡）
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 }) // 10×0.9=9
      const parry = await recvWhere(b, (m) => m.type === 'event' && m.payload.kind === 'parry' && m.payload.uuid === uuidB && m.payload.perfect === true, 'B 完美格挡')
      assert(parry.payload.byZombie === false, 'PVP 完美格挡')
      // 化气回复事件：dmg_p sign=-1（Heal）amount=2.7
      // （步骤 6 的完美格挡也会产生 4.5 的回复事件留在收件箱 → 必须按金额过滤旧事件）
      const heal = await recvWhere(b, (m) => m.type === 'event' && m.payload.kind === 'dmg_p' && m.payload.uuid === uuidB && m.payload.sign === -1 && m.payload.amount === 2.7, '化气治疗 dmg_p')
      assert(heal.payload.amount === 2.7, `回复 = 9×0.3=2.7（实际 ${heal.payload.amount}）`)
      assert(Math.abs(pbp.hp - 52.7) < 1e-6, `B 血量 50 → 52.7（实际 ${pbp.hp}）`)
    })) && ok

  ok =
    (await step('普通格挡（非完美窗口）：无伤扣体 = 普攻冲击力 3（parry.drain 随攻击类型动态）', async () => {
      // 僵尸挪到门廊最深处：case 7 曾把它摆到 x=20 被 zClamp 钉回 3.4（约 6.7s 追到 A），
      // 恰可能在本用例窗口内插手攻击产生干扰 parry 事件 → 拉开追击距离保证确定性
      const z8 = world.zombies.find((x) => x.state !== 'dead')
      if (z8) { z8.x = -5.0; z8.z = 1.9 }
      send(b, 'mp_action', nextSeq(), { kind: 'parry_stop' })
      await sleep(600) // 格挡起手冷却
      for (let i = 0; i < 5; i++) {
        send(b, 'mp_action', nextSeq(), { kind: 'parry_start' })
        await sleep(600) // 越过 0.5s 完美窗口（blockMaxS×parryPct），仍在 1.0s 格挡持续内
        send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 })
        const parry = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'parry' && m.payload.uuid === uuidB, 'parry 事件')
        send(b, 'mp_action', nextSeq(), { kind: 'parry_stop' })
        if (parry.payload.fail || parry.payload.perfect) {
          await sleep(600) // 25% 格挡失败 / 网络抖动误入完美窗口 → 重试
          continue
        }
        assert(parry.payload.drain === 3, `普通格挡扣体 = 普攻冲击力 3（实际 ${parry.payload.drain}）`)
        return
      }
      assert(false, '5 次重试内未获得普通格挡事件')
    })) && ok

  ok =
    (await step('退出第一人称（mode=free）→ 快照 fp=false（退出房间）', async () => {
      input(b, [-2.4, 1.6, 1.9], [-1, 0], 'free')
      await waitWorld(a, (w) => w.players.some((p: AnyMsg) => p.uuid === uuidB && p.fp === false), 'B fp=false')
      await waitWorld(b, (w) => w.players.some((p: AnyMsg) => p.uuid === uuidB && p.fp === false), 'B 自身 fp=false')
    })) && ok

  ok =
    (await step('断开连接 → leave 事件 + 快照移除玩家', async () => {
      b.ws.close()
      const leave = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'leave' && m.payload.uuid === uuidB, 'leave(B)')
      assert(leave.payload.name === '玩家B', 'leave 事件携带玩家名')
      await waitWorld(a, (w) => !w.players.some((p: AnyMsg) => p.uuid === uuidB), '快照移除 B')
    })) && ok

  // ---------- 用例 8-10：T2a/T2b/T2c 词条结算（同进程 world 铺垫 + 协议链路结算） ----------

  ok =
    (await step('重击剑气蓄力：hold=0.5 → 伤害 15；hold=2 钳到蓄力上限 1.0 → 30', async () => {
      const pa = world.players.get(uuidA)!
      const z = world.zombies[0]
      assert(!!pa && !!z, 'world 单例可读（A 玩家 + 僵尸存在）')
      z.hp = 10000; z.maxHp = 10000 // 铺垫：剑气 / 连击累计伤害不击杀僵尸（死亡会触发升级三选一冻结世界）
      pa.stats.critRate = 0 // 关闭暴击，伤害断言确定化（默认 5% 暴击会污染数值）
      // A 朝 +x，僵尸摆在正前方：剑气 12m/s、10Hz tick（步长 1.2m = 命中窗口宽），
      // 与僵尸距离存在 ~7% 相位错开概率 → 未命中则重摆僵尸重射（按期望伤害过滤事件）
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      const fireUntilHit = async (hold: number, expect: number, desc: string): Promise<AnyMsg> => {
        for (let i = 0; i < 8; i++) {
          z.x = -1.0; z.z = 1.9
          send(a, 'mp_action', nextSeq(), { kind: 'wave', hold })
          try {
            return await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' &&
              m.payload.by === uuidA && m.payload.amount === expect, desc, 700)
          } catch {
            // 本发相位错开未命中 → 重试（残留飞行中的剑气迟到命中也会被期望值过滤正确匹配）
          }
        }
        throw new Error(`剑气 8 次尝试均未命中: ${desc}`)
      }
      const d1 = await fireUntilHit(0.5, 15, '剑气 dmg_z(hold=0.5)')
      assert(d1.payload.amount === 15 && d1.payload.sign === 1, `10×3×0.5×dmgMul=15（实际 ${d1.payload.amount}, sign ${d1.payload.sign}）`)
      // 第二发：hold=2 → effHold = min(2×chargeSpd, chargeMax=1.0) = 1.0 → 10×3×1.0 = 30
      const d2 = await fireUntilHit(2, 30, '剑气 dmg_z(hold=2)')
      assert(d2.payload.amount === 30 && d2.payload.sign === 1, `蓄力钳制 → 10×3×1.0×dmgMul=30（实际 ${d2.payload.amount}, sign ${d2.payload.sign}）`)
    })) && ok

  ok =
    (await step('暴击：critRate=1 连击全暴（sign=2，伤害×(1+critDmg)）；critRate=0 恢复 sign=1', async () => {
      const pa = world.players.get(uuidA)!
      const z = world.zombies[0]
      pa.stats.critRate = 1
      // 瞄准僵尸当前位置再出手（近战为朝向锥形判定）
      const aim = () => {
        const dx = z.x - pa.x, dz = z.z - pa.z
        const l = Math.hypot(dx, dz) || 1
        input(a, [-3.0, 1.6, 1.9], [dx / l, dz / l], 'fp')
      }
      await sleep(400)
      aim()
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 }) // 10×0.9=9 → 暴击 18
      const c1 = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.by === uuidA, '暴击 dmg_z(seg0)')
      assert(c1.payload.sign === 2 && c1.payload.amount === 18, `seg0 暴击 9×(1+1.0)=18（实际 ${c1.payload.amount}, sign ${c1.payload.sign}）`)
      await sleep(400)
      aim()
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 2 }) // 10×1.5=15 → 暴击 30
      const c2 = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.by === uuidA, '暴击 dmg_z(seg2)')
      assert(c2.payload.sign === 2 && c2.payload.amount === 30, `seg2 暴击 15×(1+1.0)=30（实际 ${c2.payload.amount}, sign ${c2.payload.sign}）`)
      pa.stats.critRate = 0
      await sleep(400)
      aim()
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 })
      const n1 = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.by === uuidA, '正常 dmg_z')
      assert(n1.payload.sign === 1 && n1.payload.amount === 9, `critRate=0 恢复正常 9（实际 ${n1.payload.amount}, sign ${n1.payload.sign}）`)
    })) && ok

  ok =
    (await step('冲击力：玩家 impact=1.5 → 僵尸落手扣体 10×1.5=15', async () => {
      const pa = world.players.get(uuidA)!
      const z = world.zombies[0]
      pa.stats.impact = 1.5
      // 轮询本地 world（同进程）：chase 期间压制 sweep 请求，等一次普通挥击 windup
      // （windup 前摇 1s，落手时 spendZ(10)×impact 与伤害同 tick 结算，之后转 recover）
      const deadline = Date.now() + 10000
      let st0 = -1
      while (Date.now() < deadline) {
        await sleep(40)
        if (z.state === 'chase') z.requestSweep = false
        if (z.state === 'windup') { st0 = z.stamina; break }
      }
      assert(st0 >= 0, '僵尸进入 windup（10s 内）')
      while (z.state === 'windup') await sleep(20) // 等落手结束（状态离开 windup）
      const drop = Math.round((st0 - z.stamina) * 100)
      assert(drop === 1500, `僵尸扣体 = Z_ATTACK_COST 10 × 1.5 = 15（实际 ${st0.toFixed(2)} → ${z.stamina.toFixed(2)}，差 ${(drop / 100).toFixed(2)}）`)
      pa.stats.impact = 1
    })) && ok

  ok =
    (await step('僵尸死亡 → 经验达标场景升级（level_up + 3s 提示期）→ 补员 level+1（hp 125）→ 升级三选一冻结与解除', async () => {
      await sleep(400) // 攻击冷却
      // 等活僵尸进入 A 攻击距离（REACH 3.0）
      await waitWorld(a, (w) => {
        const z = w.zombies.find((x: AnyMsg) => x.state !== 'dead')
        if (!z) return false
        return Math.hypot(z.p[0] - -3.0, z.p[2] - 1.9) <= 3.0
      }, '僵尸进入攻击距离', 8000)
      const z0 = world.zombies.find((x) => x.state !== 'dead')!
      z0.hp = 1 // 直改血量：A 下一击必死（击杀结算走完整协议链路）
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 0 })
      const die = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'zdie' && m.payload.id === z0.id, 'zdie 事件')
      assert(die.payload.id === z0.id, `被击杀僵尸 id=${z0.id}`)
      // 经验结算：击杀 0 级僵尸 → 场景经验 +100×经验倍率(1) = 阈值 100+0×75 → 立即升级（exp 清零 / level=1）
      const lu = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'level_up', 'level_up 事件')
      assert(lu.payload.level === 1, `场景等级升至 1（实际 ${lu.payload.level}）`)
      await waitWorld(a, (w) => w.scene.level === 1 && w.scene.exp === 0, '快照 scene：level=1 / exp=0')
      // 补员：门处生成 level+1 僵尸（hp = 100+25×1 = 125）
      const z1 = world.zombies.find((x) => x.id !== z0.id)
      assert(z1 !== undefined, '补员僵尸已生成')
      assert(z1!.level === 1, `补员僵尸等级 = 上一只 +1（实际 ${z1!.level}）`)
      assert(z1!.hp === 125 && z1!.maxHp === 125, `补员血量 = 100+25×1（实际 ${z1!.hp}/${z1!.maxHp}）`)
      assert(z1!.x === -4.55 || Math.hypot(z1!.x - -4.55, z1!.z - 1.9) < 0.5, `补员出生在门处（提示期内已起步，容差 0.5m；实际 ${z1!.x},${z1!.z}）`)
      // 3s LEVEL UP 提示期内世界不冻结（可继续攻击），到期 → 进入升级三选一
      await sleep(400)
      assert(world.players.get(uuidA)!.pick === null, '提示期内尚未进入三选一')
      await waitWorld(a, (w) => w.pick_phase === true, '提示期结束 → pick_phase 开启', 5000)
      const pickSt = world.players.get(uuidA)!.pick!
      assert(pickSt !== null && pickSt.options.length === 3, '全员独立抽到 3 张增益卡牌')
      // A 选择第一张卡 → 房间内仅 A → 全员选完即结算并解除冻结
      send(a, 'mp_action', nextSeq(), { kind: 'pick', idx: 0 })
      await waitWorld(a, (w) => w.pick_phase === false, 'pick_phase 解除')
      assert(world.players.get(uuidA)!.pick === null, '选择结算后 pick 状态清空')
      // 确定性：重置可能被卡牌改动的词条，避免污染后续伤害断言（暴击率 / 伤害倍率 / 攻击力）
      const pa = world.players.get(uuidA)!
      pa.stats.critRate = 0
      pa.stats.dmgMul = 1
      pa.stats.atk = 10
    })) && ok

  // ---------- 用例 15-19：苍弓（球状闪电 / 巨型激光，PB 权威裁决） ----------

  ok =
    (await step('苍弓普攻：射球状闪电 → 首中附着 + 0.1s×3 伤 tick（不暴击）+ 6s TTL 到期消失', async () => {
      const z = world.zombies.find((x) => x.state !== 'dead')!
      z.hp = 10000; z.maxHp = 10000 // 铺垫：多段 tick 不击杀僵尸（死亡会触发升级三选一冻结世界）
      // A 切换苍弓（快照回写）
      send(a, 'mp_action', nextSeq(), { kind: 'weapon', weapon: 'bow' })
      await waitWorld(a, (w) => w.players.find((p: AnyMsg) => p.uuid === uuidA)?.weapon === 'bow', 'A weapon=bow')
      // 朝 +x 站位，僵尸摆在正前方 3.5m（射线 y=1.6 过僵尸头部采样点 1.75，垂距 0.15 ≤ 0.55）
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      await sleep(150)
      z.x = 0.5; z.z = 1.9
      send(a, 'mp_action', nextSeq(), { kind: 'shoot' })
      const orb = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'orb' && m.payload.by === uuidA, 'orb 事件')
      assert(typeof orb.payload.id === 'number', `orb 携带 id=${orb.payload.id}`)
      // 首中即停：orb_stop 携带僵尸目标 key，并立刻开始附着 tick
      const stop = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'orb_stop' && m.payload.id === orb.payload.id, 'orb_stop(附着)')
      assert(stop.payload.target === `z${z.id}`, `附着目标 key=z${z.id}（实际 ${stop.payload.target}）`)
      for (let i = 0; i < 3; i++) {
        const d = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.by === uuidA && m.payload.amount === 3, `球 tick 3 伤 (#${i + 1})`)
        assert(d.payload.sign === 1, `球 tick 不暴击 sign=1（实际 ${d.payload.sign}）`)
      }
      // TTL 6s（自发射起计）：附着跟随目标，到期 → orb_stop(target=null) 消失
      z.x = 3.0; z.z = 1.9
      const gone = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'orb_stop' && m.payload.id === orb.payload.id && m.payload.target === null, 'orb 到期消失', 10000)
      assert(gone.payload.target === null, '到期 orb_stop target=null')
      assert(!world.orbs.some((o) => o.id === orb.payload.id), 'world.orbs 已移除该球')
    })) && ok

  ok =
    (await step('苍弓激光：charge_start → 0.2s×15 伤 tick 穿透双僵尸；蓄力中切武器被拒；charge_stop 停止', async () => {
      const pa = world.players.get(uuidA)!
      pa.hp = 100; pa.stamina = 100; pa.stunUntil = 0; pa.exhaustUntil = 0; pa.guardBreakUntil = 0
      pa.stats.critRate = 0
      // 补第二只僵尸，等其进入 chase 后双双摆上射线（穿透断言）
      send(a, 'mp_action', nextSeq(), { kind: 'lamp' })
      await waitWorld(a, (w) => w.zombies.some((x: AnyMsg) => x.id !== world.zombies[0].id && x.state === 'chase'), '第二只僵尸 chase')
      const zs = world.zombies.filter((x) => x.state !== 'dead')
      for (const z of zs) z.vulnMul = 0 // 确定性：清掉可能的眩晕易伤倍率（伤害断言为固定值）
      for (const z of zs) { z.hp = 10000; z.maxHp = 10000 } // 铺垫：激光多段 tick 不击杀僵尸
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      await sleep(150)
      zs[0].x = 0.5; zs[0].z = 1.9
      zs[1].x = 1.5; zs[1].z = 1.9
      send(a, 'mp_action', nextSeq(), { kind: 'charge_start' })
      // 蓄力中切武器 → PB 拒绝（快照仍 bow）
      send(a, 'mp_action', nextSeq(), { kind: 'weapon', weapon: 'sword' })
      for (const z of zs) {
        const d = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.id === z.id && m.payload.amount === 15, `激光 tick 15 (z${z.id})`)
        assert(d.payload.by === uuidA, '激光伤害归属 A')
      }
      await waitWorld(a, (w) => w.players.find((p: AnyMsg) => p.uuid === uuidA)?.weapon === 'bow', '蓄力中切武器被拒（仍 bow）')
      send(a, 'mp_action', nextSeq(), { kind: 'charge_stop' })
      await sleep(350) // 让停止前最后一批在途事件落地
      const mark = a.inbox.length
      await sleep(600)
      const late = a.inbox.slice(mark).filter((m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.amount === 15)
      assert(late.length === 0, `charge_stop 后无激光 tick（发现 ${late.length} 条）`)
      assert(pa.chargeStartAt === -1, 'chargeStartAt 已清空')
    })) && ok

  ok =
    (await step('蓄满自动爆发：charge ≥ chargeDur(1s) → 40 伤一次 + chargeStartAt 清空 + 激光停止', async () => {
      const pa = world.players.get(uuidA)!
      pa.hp = 100; pa.stamina = 100; pa.stunUntil = 0; pa.exhaustUntil = 0; pa.guardBreakUntil = 0
      const zs = world.zombies.filter((x) => x.state !== 'dead')
      for (const z of zs) z.vulnMul = 0
      for (const z of zs) { z.hp = 10000; z.maxHp = 10000 } // 铺垫：40 伤爆发 / 残留 tick 不击杀僵尸
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      await sleep(150)
      zs[0].x = 2.5; zs[0].z = 1.9
      zs[1].x = 3.3; zs[1].z = 1.9
      send(a, 'mp_action', nextSeq(), { kind: 'charge_start' })
      // 不松手：World tick 轮询 maxChargeReached → 自动 heavyAttack 爆发（射线判定，穿透）
      const burst = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.amount === 40 && m.payload.by === uuidA, '爆发 40 伤', 4000)
      assert(burst.payload.sign === 1, `爆发不暴击 sign=1（实际 ${burst.payload.sign}）`)
      assert(pa.chargeStartAt === -1, '爆发后 chargeStartAt 清空（立刻停止）')
      await sleep(350)
      const mark = a.inbox.length
      await sleep(600)
      const late = a.inbox.slice(mark).filter((m) => m.type === 'event' && m.payload.kind === 'dmg_z' && (m.payload.amount === 40 || m.payload.amount === 15))
      assert(late.length === 0, `爆发后激光停止（发现 ${late.length} 条残留）`)
    })) && ok

  ok =
    (await step('提前松手：charge_stop → 无爆发无残留 tick；松手后切武器生效（对照蓄力中被拒）', async () => {
      const pa = world.players.get(uuidA)!
      pa.hp = 100; pa.stamina = 100; pa.stunUntil = 0; pa.exhaustUntil = 0; pa.guardBreakUntil = 0
      send(a, 'mp_action', nextSeq(), { kind: 'charge_start' })
      await sleep(250) // 激光 1-2 tick（僵尸在射线远端，伤害不影响断言）
      send(a, 'mp_action', nextSeq(), { kind: 'charge_stop' })
      await sleep(350) // 等动作落地 + 在途事件收口
      assert(pa.chargeStartAt === -1, 'charge_stop 清空蓄力')
      const mark = a.inbox.length
      await sleep(600)
      const late = a.inbox.slice(mark).filter((m) => m.type === 'event' && m.payload.kind === 'dmg_z' && (m.payload.amount === 40 || m.payload.amount === 15))
      assert(late.length === 0, `提前松手无爆发无 tick（发现 ${late.length} 条）`)
      // 松手（非蓄力）时切武器生效
      send(a, 'mp_action', nextSeq(), { kind: 'weapon', weapon: 'sword' })
      await waitWorld(a, (w) => w.players.find((p: AnyMsg) => p.uuid === uuidA)?.weapon === 'sword', '松手后切回 sword')
    })) && ok

  ok =
    (await step('切回双手剑回归：shoot 走近战裁决（三段 90%=9 伤）且不再产生 orb', async () => {
      const pa = world.players.get(uuidA)!
      pa.hp = 100; pa.stamina = 100; pa.stunUntil = 0; pa.guardBreakUntil = 0
      pa.stats.atk = 10 // 确定性：case 14 三选一可能加了攻击力词条，重置保证近战 9 伤断言
      const z = world.zombies.find((x) => x.state !== 'dead')!
      z.vulnMul = 0
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp')
      await sleep(150)
      z.x = -2.0; z.z = 1.9
      await sleep(400) // 攻击最小间隔
      const mark = a.inbox.length
      send(a, 'mp_action', nextSeq(), { kind: 'shoot' })
      await sleep(600)
      const hit = a.inbox.slice(mark).filter((m) => m.type === 'event' && m.payload.kind === 'dmg_z' && m.payload.by === uuidA && m.payload.amount === 9)
      assert(hit.length >= 1, `sword 的 shoot 走近战 9 伤（命中 ${hit.length} 条）`)
      const noOrb = a.inbox.slice(mark).filter((m) => m.type === 'event' && m.payload.kind === 'orb')
      assert(noOrb.length === 0, 'sword 的 shoot 不产生 orb')
      assert(pa.weapon === 'sword', 'A 当前武器 sword')
    })) && ok

  // ---------- 清理并退出 ----------
  for (const c of allConns) {
    try {
      c.ws.close()
    } catch {
      // 已关闭，忽略
    }
  }
  app.server?.stop(true)
  stopWorldLoop()

  if (!ok) {
    console.error(`\n❌ MULTI SMOKE FAIL — ${passed} 项通过，存在失败项`)
    process.exit(1)
  }
  console.log(`\n✅ MULTI SMOKE PASS — ${passed}/${passed} 项场景全部通过`)
  process.exit(0)
}

main()
