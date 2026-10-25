/**
 * PB 联机对战冒烟测试（bun scripts/multi_smoke.ts）
 *
 * 与服务同进程启动（随机端口），覆盖联机世界模拟核心链路：
 * 1. 双 PF 客户端 hello（带 display_name）→ 各自分配 uuid + 不同随机颜色
 * 2. 世界快照：fp 玩家互见（10Hz 广播），free 玩家不在房间
 * 3. 房间内玩家上报 door_open → PB 生成共享僵尸
 * 4. 玩家攻击僵尸 → dmg_z 事件（三段连击 90% = 9 伤害）
 * 5. 友伤：攻击其他玩家 → dmg_p 事件
 * 6. 完美格挡：对方 parry_start 后立即受击 → parry(perfect) + 攻击者 guardbreak
 * 7. 断开连接 → leave 事件 + 快照移除玩家
 */
import { app, logger, startWorldLoop } from '../src/index'

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

/** 上报 10Hz 输入（位置 / 朝向 / 模式 / 门） */
function input(conn: TestConn, p: [number, number, number], dir: [number, number], mode: 'fp' | 'free', door = false): void {
  send(conn, 'mp_input', nextSeq(), { p, yaw: 0, dir, mode, door_open: door, anim: null })
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
    (await step('房间内玩家上报开门（door_open）→ PB 生成共享僵尸', async () => {
      // A 客户端门本地视觉状态：开门（此处直接经 ui_command 同步门锁语义省略，door_open 由 mp_input 携带）
      input(a, [-3.0, 1.6, 1.9], [-1, 0], 'fp', true)
      const w = await waitWorld(a, (w) => w.zombies.length > 0, '僵尸生成', 6000)
      zombieId = w.payload.zombies[0].id
      // 共享：B 的快照同样看得到
      await waitWorld(b, (w) => w.zombies.some((z: AnyMsg) => z.id === zombieId), 'B 看到同一只僵尸')
    })) && ok

  ok =
    (await step('玩家 A 攻击僵尸 → dmg_z 事件（三段连击 90% = 9 伤害）', async () => {
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
    (await step('友伤：A 攻击面前的 B → dmg_p 事件', async () => {
      await sleep(400) // 服务端攻击最小间隔 0.3s
      // B 站到 A 前方 0.6m；A 转向 +x
      input(b, [-2.4, 1.6, 1.9], [-1, 0], 'fp')
      input(a, [-3.0, 1.6, 1.9], [1, 0], 'fp', true)
      await sleep(150) // 输入到达 PB
      send(a, 'mp_action', nextSeq(), { kind: 'attack', segment: 1 })
      const dmg = await recvWhere(a, (m) => m.type === 'event' && m.payload.kind === 'dmg_p' && m.payload.uuid === uuidB, 'dmg_p(B)')
      assert(dmg.payload.amount === 9, `友伤 9（实际 ${dmg.payload.amount}）`)
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
