// 客户端「语音输入设备」纯函数：录音约束、设备不可用回退、虚拟设备提示。
//
// client.js 是 DSH 浏览器插件（window.__ModuleLoader__），这里用 vm + React 替身载入，
// 直接验证挂在 exports.__testing 上的纯函数，不跑浏览器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function 载入客户端() {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  assert.equal(typeof 工厂, 'function')
  return 工厂(() => ({
    createElement: () => null,
    Fragment: 'Fragment',
    useState: (初值) => [typeof 初值 === 'function' ? 初值() : 初值, () => {}],
    useEffect: () => {},
    useRef: (值) => ({ current: 值 }),
  }))
}

const {
  构建录音约束,
  打开麦克风,
  设备不可用错误,
  是虚拟设备名称,
  虚拟设备提示,
} = 载入客户端().__testing

/** vm 里造出来的对象原型不同，比较前先转成当前 realm 的普通对象。 */
const 纯 = (值) => JSON.parse(JSON.stringify(值))

function 造设备错误(名) {
  const 错误 = new Error(名)
  错误.name = 名
  return 错误
}

test('构建录音约束：空设备标识 → 系统默认约束，不带 deviceId', () => {
  const 默认 = { audio: { echoCancellation: true, noiseSuppression: true } }
  assert.deepEqual(纯(构建录音约束('')), 默认)
  assert.deepEqual(纯(构建录音约束('   ')), 默认)
  assert.deepEqual(纯(构建录音约束(undefined)), 默认)
  assert.deepEqual(纯(构建录音约束(null)), 默认)
  assert.deepEqual(纯(构建录音约束(42)), 默认)
  assert.equal(构建录音约束('').audio.deviceId, undefined)
})

test('构建录音约束：非空设备标识 → 精确指定 deviceId', () => {
  assert.deepEqual(纯(构建录音约束('mic-abc')), {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      deviceId: { exact: 'mic-abc' },
    },
  })
  // 前后空白去掉，不改设备标识内部的字符。
  assert.deepEqual(纯(构建录音约束('  mic abc  ').audio.deviceId), { exact: 'mic abc' })
})

test('回退逻辑：所选设备报 OverconstrainedError → 改用系统默认', async () => {
  const 流 = { id: 'default-stream' }
  const 调用 = []
  const 结果 = await 打开麦克风('gone-device', async (约束) => {
    调用.push(约束)
    if (调用.length === 1) throw 造设备错误('OverconstrainedError')
    return 流
  })
  assert.equal(结果.stream, 流)
  assert.equal(结果.fellBack, true)
  assert.equal(调用.length, 2)
  assert.deepEqual(调用[0], 构建录音约束('gone-device'))
  assert.deepEqual(调用[1], 构建录音约束(''))
  assert.equal(调用[1].audio.deviceId, undefined)
})

test('回退逻辑：设备被拔掉 / 改名（NotFoundError）同样回退', async () => {
  const 调用 = []
  const 结果 = await 打开麦克风('old-device', async (约束) => {
    调用.push(约束)
    if (调用.length === 1) throw 造设备错误('NotFoundError')
    return { id: 'ok' }
  })
  assert.equal(结果.fellBack, true)
  assert.equal(调用.length, 2)
  assert.equal(设备不可用错误(造设备错误('DevicesNotFoundError')), true)
})

test('回退逻辑：未指定设备或其它错误不回退，直接抛给调用方', async () => {
  let 次数 = 0
  await assert.rejects(
    打开麦克风('', async () => { 次数 += 1; throw 造设备错误('NotFoundError') }),
    (错误) => 错误.name === 'NotFoundError',
  )
  assert.equal(次数, 1)

  次数 = 0
  await assert.rejects(
    打开麦克风('mic-1', async () => { 次数 += 1; throw 造设备错误('NotAllowedError') }),
    (错误) => 错误.name === 'NotAllowedError',
  )
  assert.equal(次数, 1)
})

test('回退逻辑：回退后仍失败，返回第二次的错误', async () => {
  const 调用 = []
  await assert.rejects(
    打开麦克风('gone-device', async (约束) => {
      调用.push(约束)
      if (调用.length === 1) throw 造设备错误('OverconstrainedError')
      throw 造设备错误('NotReadableError')
    }),
    (错误) => 错误.name === 'NotReadableError',
  )
  assert.equal(调用.length, 2)
})

test('虚拟设备识别：包含 stream / virtual / cable / voicemeeter 等关键词', () => {
  for (const 名称 of [
    'PicoStreamingMicrophone',
    'Virtual Audio Cable',
    'CABLE Output (VB-Audio Virtual Cable)',
    'VoiceMeeter VAIO',
    'Stereo Mix (Realtek)',
    '立体声混音',
    'Loopback Audio',
  ]) {
    assert.equal(是虚拟设备名称(名称), true, 名称)
    assert.match(虚拟设备提示(名称), /虚拟设备/)
  }
  for (const 名称 of ['', 'Microphone (Realtek(R) Audio)', 'Headset Microphone', null, 42]) {
    assert.equal(是虚拟设备名称(名称), false, String(名称))
    assert.equal(虚拟设备提示(名称), '')
  }
})

test('虚拟设备提示文案固定，便于直接展示给用户', () => {
  assert.equal(虚拟设备提示('PicoStreamingMicrophone'), '当前输入设备可能是虚拟设备，请在设置里改选真实麦克风。')
})
