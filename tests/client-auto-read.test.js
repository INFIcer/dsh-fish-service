// 客户端「按会话自动朗读」纯函数：取值回落、单会话写入、旧配置兼容、非法键与上限。
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

const { 读会话自动朗读, 写会话自动朗读, 会话自动朗读上限 } = 载入客户端().__testing

/** vm 里造出来的对象原型不同，比较前先转成当前 realm 的普通对象。 */
const 纯 = (值) => JSON.parse(JSON.stringify(值))

test('读会话自动朗读：本会话有设置就用，未设置回落全局默认', () => {
  const 配置 = { autoRead: true, autoReadSessions: { 'session-a': false, 'session-b': true } }
  assert.equal(读会话自动朗读(配置, 'session-a'), false)
  assert.equal(读会话自动朗读(配置, 'session-b'), true)
  assert.equal(读会话自动朗读(配置, 'session-c'), true)

  assert.equal(读会话自动朗读({ autoRead: false, autoReadSessions: { 'session-a': true } }, 'session-a'), true)
  assert.equal(读会话自动朗读({ autoRead: false }, 'session-a'), false)
  assert.equal(读会话自动朗读({}, 'session-a'), false)
  // 值按布尔理解，字符串 'true' 也算开启。
  assert.equal(读会话自动朗读({ autoReadSessions: { 'session-a': 'true' } }, 'session-a'), true)
  assert.equal(读会话自动朗读({ autoReadSessions: { 'session-a': 'false' } }, 'session-a'), false)
})

test('读会话自动朗读：旧配置没有按会话字段时行为与以前一致', () => {
  assert.equal(读会话自动朗读({ autoRead: true }, 'session-a'), true)
  assert.equal(读会话自动朗读({ autoRead: false }, 'session-a'), false)
  // 字段被手工改坏时按全局默认处理，不抛错。
  assert.equal(读会话自动朗读({ autoRead: true, autoReadSessions: [] }, 'session-a'), true)
})

test('写会话自动朗读：只改当前会话，不影响其它会话与全局默认', () => {
  const 原 = { autoRead: true, autoReadSessions: { 'session-a': false, 'session-b': true } }
  const 新 = 写会话自动朗读(原, 'session-a', true)
  assert.deepEqual(纯(新.autoReadSessions), { 'session-a': true, 'session-b': true })
  assert.equal(新.autoRead, true)
  assert.equal(新.autoReadSessions['session-b'], true)
  // 不改原对象。
  assert.deepEqual(原.autoReadSessions, { 'session-a': false, 'session-b': true })

  // 未设置过的会话：只新增一条，全局默认原样保留。
  const 另 = 写会话自动朗读({ autoRead: false }, 'session-c', true)
  assert.deepEqual(纯(另.autoReadSessions), { 'session-c': true })
  assert.equal(另.autoRead, false)
  assert.equal(读会话自动朗读(另, 'session-c'), true)
  // 其它未设置的会话仍回落全局默认。
  assert.equal(读会话自动朗读(另, 'session-d'), false)
})

test('写会话自动朗读：非法会话键不写入', () => {
  for (const 键 of ['', 's1', 'session', null, undefined, 42]) {
    const 配置 = { autoRead: false, autoReadSessions: { 'session-a': true } }
    assert.deepEqual(纯(写会话自动朗读(配置, 键, true)), 配置)
  }
})

test('写会话自动朗读：最多保留 200 条，超出时淘汰最早的设置、保留本次写入', () => {
  const 表 = {}
  for (let i = 0; i < 会话自动朗读上限; i += 1) 表[`session-${i}`] = true
  const 新 = 写会话自动朗读({ autoReadSessions: 表 }, 'session-new', true)
  assert.equal(Object.keys(新.autoReadSessions).length, 会话自动朗读上限)
  assert.equal(新.autoReadSessions['session-new'], true)
  assert.equal('session-0' in 新.autoReadSessions, false)
  assert.equal('session-1' in 新.autoReadSessions, true)
})

test('会话切换：按钮状态随会话键重算', () => {
  let 配置 = { autoRead: true, autoReadSessions: {} }
  assert.equal(读会话自动朗读(配置, 'session-a'), true)

  配置 = 写会话自动朗读(配置, 'session-a', false)
  assert.equal(读会话自动朗读(配置, 'session-a'), false)
  assert.equal(读会话自动朗读(配置, 'session-b'), true) // B 还没单独设置，沿用默认

  配置 = 写会话自动朗读(配置, 'session-b', false)
  assert.equal(读会话自动朗读(配置, 'session-a'), false)
  assert.equal(读会话自动朗读(配置, 'session-b'), false)
  assert.equal(读会话自动朗读(配置, 'session-c'), true)

  // 切回 A 仍然只反映 A 自己的设置。
  assert.equal(读会话自动朗读(配置, 'session-a'), false)
})
