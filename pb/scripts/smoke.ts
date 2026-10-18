/**
 * PB 冒烟测试（bun scripts/smoke.ts）
 *
 * 与服务同进程启动（import app 后 listen(0) 随机端口），覆盖 docs.md 7.9 交互时序：
 * 1. SCB 连接 /ws/scb → hello → welcome（全量快照 7 台设备）
 * 2. SCB 发 device_command CMD_01 → command_ack ok=true（含新状态）
 * 3. PF 连接 /ws/pf → hello → welcome → 收到 device_state_update 广播
 * 4. CMD_03 冷却命中 → COOLDOWN
 * 5. PF ui_command（不受冷却）推温度至 30 后越界 → OUT_OF_RANGE
 * 6. 非法 device_command（unknown device）→ error(UNKNOWN_DEVICE)
 * 7. hello.role 与端点不匹配 → error 并断开
 * 8. state_request / HTTP GET /api_state 调试接口
 * 9. 通道隔离：SCB 通道发 PF 专属 type → error(UNKNOWN_TYPE)
 */
import { app, logger } from '../src/index'

// 服务日志静默，保持测试输出干净
logger.level = 'silent'

// ---------- 测试基建 ----------

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

/** 打开 WebSocket 连接（自动收集入站消息供 recv 匹配） */
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
    ws.onopen = () => {
      allConns.push(conn)
      resolve(conn)
    }
    ws.onerror = () => reject(new Error(`WS 连接失败: ${url}`))
    ws.onclose = () => conn.markClosed()
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as AnyMsg
      conn.inbox.push(msg)
      const i = conn.waiters.findIndex((w) => w.pred(msg))
      if (i >= 0) {
        const [w] = conn.waiters.splice(i, 1)
        // 消息交给 waiter 时必须同时移出收件箱，避免后续 recv 重复消费旧消息
        const idx = conn.inbox.indexOf(msg)
        if (idx >= 0) conn.inbox.splice(idx, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
      }
    }
  })
}

/** 按消息 type 取出一条（先查收件箱，否则挂起等待），供顺序无关断言 */
function recv(conn: TestConn, type: string, timeoutMs = 3000): Promise<AnyMsg> {
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

/** 按协议信封发送上行消息 */
function send(conn: TestConn, type: string, seq: number, payload: AnyMsg): void {
  conn.ws.send(JSON.stringify({ v: 1, type, seq, ts: Date.now(), payload }))
}

const allConns: TestConn[] = []

// ---------- 启动服务（随机端口） ----------

app.listen(0)
const port = app.server!.port

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
  console.log(`▶ PB 冒烟测试启动（端口 ${port}）`)
  let scb!: TestConn
  let pf!: TestConn
  let ok = true

  ok =
    (await step('SCB 连接 /ws/scb + hello → welcome（client_id + 7 台设备快照）', async () => {
      scb = await connect('/ws/scb')
      send(scb, 'hello', 1, { role: 'scb', client_name: 'smoke-scb', client_version: '0.1.0' })
      const welcome = await recv(scb, 'welcome')
      assert(welcome.v === 1 && welcome.type === 'welcome', '信封 v=1 / type=welcome')
      assert(
        typeof welcome.payload.client_id === 'string' &&
          welcome.payload.client_id.startsWith('scb-'),
        `client_id 已分配: ${welcome.payload.client_id}`,
      )
      const snap = welcome.payload.snapshot
      assert(snap.devices.length === 7, `快照含 7 台设备（实际 ${snap.devices.length}）`)
      assert(snap.update_id === 0, '初始 update_id=0')
      const ids: string[] = snap.devices.map((d: AnyMsg) => d.device_id)
      const expected = [
        'living_room_light',
        'bedroom_light',
        'living_room_curtain',
        'air_conditioner',
        'tv',
        'door_lock',
        'emergency',
      ]
      for (const id of expected) assert(ids.includes(id), `注册表含 ${id}`)
      const light = snap.devices.find((d: AnyMsg) => d.device_id === 'living_room_light')
      assert(
        light.on === false && light.brightness === 80 && light.color_temp === 4000,
        'living_room_light 初始状态符合 7.4（on=false, brightness=80, color_temp=4000）',
      )
    })) && ok

  ok =
    (await step('PF 连接 /ws/pf + hello → welcome（角色隔离通过）', async () => {
      pf = await connect('/ws/pf')
      send(pf, 'hello', 1, { role: 'pf', client_name: 'smoke-pf', client_version: '0.1.0' })
      const welcome = await recv(pf, 'welcome')
      assert(welcome.payload.snapshot.devices.length === 7, 'PF welcome 快照 7 台设备')
      assert(welcome.payload.client_id.startsWith('pf-'), 'pf client_id 分配')
    })) && ok

  ok =
    (await step('SCB 发 device_command CMD_01（seq=2）→ command_ack ok=true（含新状态）', async () => {
      send(scb, 'device_command', 2, {
        cmd_id: 'CMD_01',
        device_id: 'living_room_light',
        action: 'toggle',
        confidence: 0.92,
        evidence: { freq_hz: 11.0, window_ms: 3000, confirm_count: 3 },
      })
      const ack = await recv(scb, 'command_ack')
      assert(ack.payload.ack_seq === 2, 'ack_seq 回显指令 seq=2')
      assert(ack.payload.ok === true && ack.payload.code === 'OK', 'ok=true / code=OK')
      assert(ack.payload.state.on === true, 'ack 携带新状态 on=true')
    })) && ok

  ok =
    (await step('PF 收到 device_state_update 广播（on=true, source=scb, trigger=CMD_01+seq2）', async () => {
      const upd = await recv(pf, 'device_state_update')
      assert(
        upd.payload.device_id === 'living_room_light' && upd.payload.state.on === true,
        '广播 living_room_light.on=true',
      )
      assert(upd.payload.source === 'scb', 'source=scb')
      assert(
        upd.payload.trigger?.cmd_id === 'CMD_01' && upd.payload.trigger?.cmd_seq === 2,
        'trigger 携带 cmd_id=CMD_01 + cmd_seq=2',
      )
      assert(upd.payload.update_id === 1, 'update_id=1（全局首次递增）')
      // SCB 调试显示复用同一广播（7.9 时序）
      const updScb = await recv(scb, 'device_state_update')
      assert(updScb.payload.update_id === upd.payload.update_id, 'SCB 同步收到同一广播')
    })) && ok

  ok =
    (await step('CMD_03 受理成功（26→27）；3s 内同指令重复触发 → command_ack COOLDOWN', async () => {
      send(scb, 'device_command', 3, {
        cmd_id: 'CMD_03',
        device_id: 'air_conditioner',
        action: 'temp_up',
        confidence: 0.88,
      })
      const ack1 = await recv(scb, 'command_ack')
      assert(ack1.payload.ok === true && ack1.payload.state.target_temp === 27, 'CMD_03 受理 26→27')
      send(scb, 'device_command', 4, {
        cmd_id: 'CMD_03',
        device_id: 'air_conditioner',
        action: 'temp_up',
        confidence: 0.88,
      })
      const ack2 = await recv(scb, 'command_ack')
      assert(
        ack2.payload.ack_seq === 4 && ack2.payload.ok === false && ack2.payload.code === 'COOLDOWN',
        '冷却命中：ok=false / code=COOLDOWN',
      )
    })) && ok

  ok =
    (await step('PF ui_command（不受冷却）推温度 28/29/30，再 +1 越界 → OUT_OF_RANGE', async () => {
      for (let s = 2; s <= 4; s++) {
        send(pf, 'ui_command', s, { device_id: 'air_conditioner', action: 'temp_up' })
        const ack = await recv(pf, 'command_ack')
        assert(ack.payload.ok === true, `ui_command #${s - 1} 成功`)
        assert(ack.payload.state.target_temp === 26 + s, `温度递增至 ${26 + s}`)
      }
      send(pf, 'ui_command', 5, { device_id: 'air_conditioner', action: 'temp_up' })
      const ack = await recv(pf, 'command_ack')
      assert(ack.payload.ok === false && ack.payload.code === 'OUT_OF_RANGE', 'target_temp=31 越界回 OUT_OF_RANGE')
      assert(String(ack.payload.message).includes('31'), '错误消息包含越界值')
    })) && ok

  ok =
    (await step('非法 device_command（unknown device）→ error(UNKNOWN_DEVICE) 且 ref_seq 回显', async () => {
      send(scb, 'device_command', 5, {
        cmd_id: 'CMD_01',
        device_id: 'nonexistent_device',
        action: 'toggle',
        confidence: 0.9,
      })
      const err = await recv(scb, 'error')
      assert(err.payload.code === 'UNKNOWN_DEVICE', 'code=UNKNOWN_DEVICE')
      assert(err.payload.ref_seq === 5, 'ref_seq=5（关联出错消息）')
      assert(String(err.payload.message).includes('nonexistent_device'), '错误消息含非法 device_id')
    })) && ok

  ok =
    (await step('角色二次校验：/ws/scb 上发 hello(role=pf) → error(INVALID_FORMAT) 并断开', async () => {
      const bad = await connect('/ws/scb')
      send(bad, 'hello', 1, { role: 'pf', client_name: 'impostor', client_version: '0.1.0' })
      const err = await recv(bad, 'error')
      assert(err.payload.code === 'INVALID_FORMAT', 'code=INVALID_FORMAT')
      await Promise.race([
        bad.closedPromise,
        sleep(1500).then(() => {
          throw new Error('连接未被服务端断开')
        }),
      ])
      assert(bad.closed, '服务端已断开不匹配连接')
    })) && ok

  ok =
    (await step('PF state_request → state_snapshot（7 台设备，反映最新状态）', async () => {
      send(pf, 'state_request', 6, {})
      const snap = await recv(pf, 'state_snapshot')
      assert(snap.payload.devices.length === 7, '7 台设备')
      assert(
        snap.payload.devices.find((d: AnyMsg) => d.device_id === 'living_room_light').on === true,
        '快照反映最新状态（灯 on=true）',
      )
    })) && ok

  ok =
    (await step('通道隔离：SCB 通道发 PF 专属 ui_command → error(UNKNOWN_TYPE)', async () => {
      send(scb, 'ui_command', 6, { device_id: 'tv', action: 'toggle' })
      const err = await recv(scb, 'error')
      assert(err.payload.code === 'UNKNOWN_TYPE', 'code=UNKNOWN_TYPE')
    })) && ok

  ok =
    (await step('HTTP GET /api/state 返回当前快照（调试接口，update_id=5 精确单调）', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`)
      assert(res.status === 200, 'HTTP 200')
      const body = (await res.json()) as AnyMsg
      assert(body.devices.length === 7, '7 台设备')
      assert(
        body.devices.find((d: AnyMsg) => d.device_id === 'air_conditioner').target_temp === 30,
        '空调温度为最新值 30',
      )
      assert(
        body.devices.find((d: AnyMsg) => d.device_id === 'living_room_light').on === true,
        '客厅灯 on=true',
      )
      // 成功迁移恰好 5 次（CMD_01 / CMD_03 / ui_command×3），失败指令不产生广播
      assert(body.update_id === 5, `update_id=5（实际 ${body.update_id}），失败指令不递增`)
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

  if (!ok) {
    console.error(`\n❌ SMOKE FAIL — ${passed} 项通过，存在失败项`)
    process.exit(1)
  }
  console.log(`\n✅ SMOKE PASS — ${passed}/${passed} 项场景全部通过`)
  process.exit(0)
}

main()
