// P2 客户端插件加载冒烟（不跑浏览器，只用 vm + React 替身）：
// 验证 client.js 能求值、apply 能注册 4 个入口（设置页 + 朗读 + 麦克风 + 面板 + 自动朗读）。
//
// 真正的交互（录音、播放、插入文字）仍需真机验收，见 docs/P2.md 的手动步骤。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function 装React() {
  return {
    createElement: (...参数) => ({ 参数 }),
    useState: (初值) => [typeof 初值 === 'function' ? 初值() : 初值, () => {}],
    useEffect: () => {},
    useRef: (值) => ({ current: 值 }),
    useSyncExternalStore: () => null,
    Fragment: 'Fragment',
    version: '18.2.0',
  }
}

test('client.js 加载：apply 注册设置页 / 朗读 / 麦克风 / 面板 / 自动朗读', async () => {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null

  const 窗口 = {
    __ModuleLoader__: {
      load: (定义) => { 工厂 = 定义.factory },
    },
  }

  const 沙箱 = {
    window: 窗口,
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
  assert.equal(typeof 工厂, 'function', 'window.__ModuleLoader__.load 应该拿到 factory')

  const 导出 = 工厂((名字) => {
    if (名字 === 'react') return 装React()
    throw new Error(`未预期的 require：${名字}`)
  })
  assert.equal(typeof 导出.apply, 'function')
  assert.deepEqual([...导出.inject], ['slots'])

  const 注册们 = []
  const 服务 = {
    inject: (_槽位, 回调) => 回调(),
    register: (配置, 组件) => {
      注册们.push({ 配置, 组件 })
      return () => {}
    },
  }
  const ctx = { get: (名字) => (名字 === 'slots' ? 服务 : undefined) }
  导出.apply(ctx)

  assert.deepEqual(注册们.map((x) => x.配置.name), [
    'settings.section',
    'conversation.chat.assistant-actions',
    'conversation.input.right',
    'conversation.input.overlay',
    'conversation.input.left',
  ])
  assert.deepEqual(注册们.map((x) => x.配置.id), [
    'fish-service',
    'fish-read',
    'fish-mic',
    'fish-voice',
    'fish-auto-read',
  ])
  for (const 项 of 注册们) assert.equal(typeof 项.组件, 'function')

  // 再拿最小 props 各渲染一次：能抓出「引用了不存在的变量 / 拼错字段」这类运行时错误。
  const 组件们 = Object.fromEntries(注册们.map((x) => [x.配置.id, x.组件]))
  assert.doesNotThrow(() => 组件们['fish-service']())
  assert.doesNotThrow(() => 组件们['fish-read']({ messageId: 'm1', useChat: () => '' }))
  assert.doesNotThrow(() => 组件们['fish-mic']({ sessionId: 's1' }))
  assert.doesNotThrow(() => 组件们['fish-voice']({ sessionId: 's1' }))
  assert.doesNotThrow(() => 组件们['fish-auto-read']())
  // 面板空闲时不应该渲染任何东西。
  assert.equal(组件们['fish-voice']({ sessionId: 's1' }), null)
})

test('client.js：slots 还没就绪时会重试，而不是直接抛错', async () => {
  const 源码 = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let 工厂 = null
  const 沙箱 = {
    window: { __ModuleLoader__: { load: (定义) => { 工厂 = 定义.factory } } },
    document: undefined,
    console,
    setTimeout: (函数) => { void 函数; return 0 },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    URL,
    fetch: async () => ({ json: async () => null }),
  }
  vm.createContext(沙箱)
  vm.runInContext(源码, 沙箱)
  const 导出 = 工厂(() => 装React())
  let 取了 = 0
  const ctx = { get: () => { 取了 += 1; return undefined } }
  assert.doesNotThrow(() => 导出.apply(ctx))
  assert.ok(取了 > 0, '应该尝试过 ctx.get("slots")')
})
