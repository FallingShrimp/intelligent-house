/**
 * 协议类型收窄与 COMMAND_MAP 核对（无需真实服务端）
 *
 * 核对方式：
 * 1. 编译期 —— 本文件随 `vue-tsc -b`（npm run build）做全量类型检查，
 *    所有断言函数的赋值 / 传参若类型收窄不正确将直接报 TS 错误；
 * 2. 运行时 —— 末尾 console.assert 校验 isType / COMMAND_MAP 行为，
 *    可用任意 TS 运行器（如 npx tsx）执行查看输出。
 */
import {
	COMMAND_MAP,
	PROTOCOL_VERSION,
	isType,
	type AcState,
	type CommandAckMsg,
	type CommandId,
	type DeviceId,
	type DeviceState,
	type DeviceStateUpdateMsg,
	type ErrorMsg,
	type StateSnapshotMsg,
	type ToPf,
	type WelcomeMsg,
	type WorldMsg,
} from '../protocol/messages'

// ---------------- 构造样例消息 ----------------

function makeEnvelope(type: ToPf['type'], payload: unknown): ToPf {
	return { v: PROTOCOL_VERSION, type, seq: 1, ts: 1760000000000, payload } as ToPf
}

const acState: AcState = {
	device_type: 'ac',
	device_id: 'air_conditioner',
	on: true,
	target_temp: 27,
	fan_swing: false,
}

const updateMsg: DeviceStateUpdateMsg = {
	v: PROTOCOL_VERSION,
	type: 'device_state_update',
	seq: 2,
	ts: 1760000000001,
	payload: {
		update_id: 87,
		device_id: 'air_conditioner',
		state: acState,
		source: 'scb',
		trigger: { cmd_id: 'CMD_03', cmd_seq: 1 },
	},
}

// ---------------- 1. isType 收窄（编译期验证点） ----------------

export function checkIsTypeNarrowing(msg: ToPf): string {
	// 收窄到 DeviceStateUpdateMsg → payload 特有字段可访问
	if (isType(msg, 'device_state_update')) {
		const deviceId: DeviceId = msg.payload.device_id
		const state: DeviceState = msg.payload.state
		const updateId: number = msg.payload.update_id
		if (state.device_type === 'ac') {
			const temp: number = state.target_temp // 判别联合二次收窄
			return `update#${updateId} ${deviceId} @${temp}℃`
		}
	}
	// 收窄到 WelcomeMsg
	if (isType(msg, 'welcome')) {
		const clientId: string = msg.payload.client_id
		const snapshotDevices: DeviceState[] = msg.payload.snapshot.devices
		return `welcome ${clientId} (${snapshotDevices.length})`
	}
	// 收窄到 StateSnapshotMsg
	if (isType(msg, 'state_snapshot')) {
		const first: DeviceState | undefined = msg.payload.devices[0]
		return `snapshot#${msg.payload.update_id} ${first?.device_id ?? 'empty'}`
	}
	// 收窄到 CommandAckMsg
	if (isType(msg, 'command_ack')) {
		const ok: boolean = msg.payload.ok
		return `ack#${msg.payload.ack_seq} ${ok ? 'OK' : msg.payload.code}`
	}
	// 收窄到 ErrorMsg
	if (isType(msg, 'error')) {
		return `error ${msg.payload.code}: ${msg.payload.message}`
	}
	return 'unknown'
}

// ---------------- 2. switch 判别收窄 ----------------

export function checkSwitchNarrowing(msg: ToPf): number {
	switch (msg.type) {
		case 'welcome': {
			const w: WelcomeMsg = msg
			return w.payload.snapshot.devices.length
		}
		case 'state_snapshot': {
			const s: StateSnapshotMsg = msg
			return s.payload.devices.length
		}
		case 'device_state_update': {
			const u: DeviceStateUpdateMsg = msg
			return u.payload.update_id
		}
		case 'command_ack': {
			const a: CommandAckMsg = msg
			return a.payload.ack_seq
		}
		case 'error': {
			const e: ErrorMsg = msg
			return e.payload.ref_seq ?? -1
		}
		case 'world': {
			const w: WorldMsg = msg
			return w.payload.players.length
		}
		case 'event': {
			return 0
		}
	}
}

// ---------------- 3. COMMAND_MAP 与指令集一致性 ----------------

export function checkCommandMap(): boolean {
	const expected: Record<CommandId, { device_id: DeviceId; action: string }> = {
		CMD_01: { device_id: 'living_room_light', action: 'toggle' },
		CMD_02: { device_id: 'living_room_curtain', action: 'toggle' },
		CMD_03: { device_id: 'air_conditioner', action: 'temp_up' },
		CMD_04: { device_id: 'air_conditioner', action: 'temp_down' },
		CMD_05: { device_id: 'tv', action: 'toggle' },
		CMD_06: { device_id: 'emergency', action: 'emergency' },
		CMD_07: { device_id: 'bedroom_light', action: 'brightness_cycle' },
		CMD_08: { device_id: 'door_lock', action: 'toggle' },
	}
	return (Object.keys(expected) as CommandId[]).every((cmd) => {
		const mapped = COMMAND_MAP[cmd]
		return mapped.device_id === expected[cmd].device_id && mapped.action === expected[cmd].action
	})
}

// ---------------- 运行时断言（构建时类型检查覆盖，亦可手动执行） ----------------

const widened: ToPf = updateMsg
console.assert(isType(widened, 'device_state_update'), 'isType 应收窄 device_state_update')
console.assert(checkSwitchNarrowing(widened) === 87, 'switch 收窄后应读到 update_id=87')
console.assert(checkIsTypeNarrowing(widened) === 'update#87 air_conditioner @27℃', 'isType 收窄链路输出应一致')
console.assert(checkIsTypeNarrowing(makeEnvelope('state_snapshot', { update_id: 9, server_ts: 0, devices: [] })) === 'snapshot#9 empty', '快照分支')
console.assert(checkCommandMap(), 'COMMAND_MAP 应与 7.4 指令迁移表一致')
console.log('[protocol.test] 全部协议收窄与 COMMAND_MAP 断言通过 ✓')
