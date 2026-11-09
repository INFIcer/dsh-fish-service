// 配置：默认值、范围钳制、env 覆盖、原子写、token 脱敏。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONFIG_VERSION,
  ConfigStore,
  applyEnv,
  buildConfigSchema,
  defaultConfig,
  envOverrides,
  normalizeConfig,
  publicConfig,
} from '../lib/config.js'
import { makeTempDir } from './helpers.js'

test('默认配置符合 P1 契约', () => {
  const temp = makeTempDir()
  try {
    const c = defaultConfig(temp.dir)
    assert.equal(c.version, CONFIG_VERSION)
    assert.equal(c.enabled, true)
    assert.equal(c.baseUrl, 'http://127.0.0.1:7880')
    assert.equal(c.apiVersion, '1')
    assert.equal(c.token, '')
    assert.equal(c.ttsVoice, 'dafeiyu')
    assert.equal(c.cacheDir, join(temp.dir, 'fish-service-cache'))
    assert.equal(c.cacheTtlHours, 72)
    assert.equal(c.cacheMaxMb, 2048)
    assert.equal(c.requestTimeoutMs, 180000)
    assert.equal(c.asrTimeoutMs, 300000)
    assert.equal(c.visionTimeoutMs, 600000)
    assert.equal(c.healthIntervalMs, 15000)
    assert.equal(c.logLevel, 'info')
    assert.equal(c.installMode, 'unknown')
    assert.deepEqual(c.enabledCapabilities, [])
  } finally {
    temp.cleanup()
  }
})

test('normalizeConfig 钳范围、补默认、去尾斜杠', () => {
  const temp = makeTempDir()
  try {
    const c = normalizeConfig({
      baseUrl: 'http://127.0.0.1:9999/',
      requestTimeoutMs: 999999999,
      asrTimeoutMs: 1,
      visionTimeoutMs: 'abc',
      cacheTtlHours: 0,
      cacheMaxMb: 999999,
      healthIntervalMs: 100,
      logLevel: 'TRACE',
      installMode: 'nonsense',
      token: 'x'.repeat(600),
      enabled: 'false',
      ttsVoice: '   ',
    }, { homeDir: temp.dir })

    assert.equal(c.baseUrl, 'http://127.0.0.1:9999')
    assert.equal(c.requestTimeoutMs, 1800000)
    assert.equal(c.asrTimeoutMs, 1000)
    assert.equal(c.visionTimeoutMs, 600000)
    assert.equal(c.cacheTtlHours, 1)
    assert.equal(c.cacheMaxMb, 10240)
    assert.equal(c.healthIntervalMs, 5000)
    assert.equal(c.logLevel, 'info')
    assert.equal(c.installMode, 'unknown')
    assert.equal(c.token.length, 512)
    assert.equal(c.enabled, false)
    assert.equal(c.ttsVoice, 'dafeiyu')
  } finally {
    temp.cleanup()
  }
})

test('非法 baseUrl 回退默认；只接受 http/https', () => {
  const temp = makeTempDir()
  try {
    assert.equal(normalizeConfig({ baseUrl: 'not a url' }, { homeDir: temp.dir }).baseUrl, 'http://127.0.0.1:7880')
    assert.equal(normalizeConfig({ baseUrl: 'ftp://127.0.0.1' }, { homeDir: temp.dir }).baseUrl, 'http://127.0.0.1:7880')
    assert.equal(normalizeConfig({ baseUrl: 'https://例子.test:8443' }, { homeDir: temp.dir }).baseUrl, 'https://例子.test:8443')
  } finally {
    temp.cleanup()
  }
})

test('cacheDir 支持 ~ 展开', () => {
  const temp = makeTempDir()
  try {
    assert.equal(normalizeConfig({ cacheDir: '~/cache' }, { homeDir: temp.dir }).cacheDir, join(temp.dir, 'cache'))
    assert.equal(normalizeConfig({ cacheDir: '~' }, { homeDir: temp.dir }).cacheDir, temp.dir)
  } finally {
    temp.cleanup()
  }
})

test('解包 DSH volatile 引用，不把 [object Object] 写进配置', () => {
  const temp = makeTempDir()
  try {
    const 引用 = (值) => ({
      get: () => 值,
      [Symbol.for('cosmokit.volatile.write')]: () => {},
    })
    const c = normalizeConfig({
      baseUrl: 引用('http://127.0.0.1:7444'),
      apiVersion: 引用('1'),
      ttsVoice: 引用('default'),
      cacheDir: 引用('~/vc'),
      requestTimeoutMs: 引用(9000),
      logLevel: 引用('debug'),
    }, { homeDir: temp.dir })
    assert.equal(c.baseUrl, 'http://127.0.0.1:7444')
    assert.equal(c.apiVersion, '1')
    assert.equal(c.ttsVoice, 'default')
    assert.equal(c.cacheDir, join(temp.dir, 'vc'))
    assert.equal(c.requestTimeoutMs, 9000)
    assert.equal(c.logLevel, 'debug')
    assert.ok(!JSON.stringify(c).includes('[object Object]'))
  } finally {
    temp.cleanup()
  }
})

test('环境变量覆盖：env > 文件 > 插件参数 > 默认', () => {
  const temp = makeTempDir()
  try {
    const base = normalizeConfig({ baseUrl: 'http://127.0.0.1:7000' }, { homeDir: temp.dir })
    const { config, overrides } = applyEnv(base, {
      DSH_FISH_SERVICE_BASE_URL: 'http://127.0.0.1:7900',
      DSH_FISH_SERVICE_ENABLED: '0',
      DSH_FISH_SERVICE_HEALTH_MS: '20000',
      DSH_FISH_SERVICE_TOKEN: 'secret-token',
    }, { homeDir: temp.dir })

    assert.equal(config.baseUrl, 'http://127.0.0.1:7900')
    assert.equal(config.enabled, false)
    assert.equal(config.healthIntervalMs, 20000)
    assert.equal(config.token, 'secret-token')
    assert.deepEqual(overrides.sort(), ['baseUrl', 'enabled', 'healthIntervalMs', 'token'])
    assert.deepEqual(envOverrides({ DSH_FISH_SERVICE_BASE_URL: 'x' }), ['baseUrl'])
  } finally {
    temp.cleanup()
  }
})

test('ConfigStore：文件优先于插件参数，保存后可重读，token 不回显', () => {
  const temp = makeTempDir()
  try {
    const file = join(temp.dir, 'fish-service-config.json')
    writeFileSync(file, JSON.stringify({ baseUrl: 'http://127.0.0.1:7111', ttsVoice: 'default' }), 'utf8')

    const store = new ConfigStore({ homeDir: temp.dir })
    const loaded = store.load({ baseUrl: 'http://127.0.0.1:7222' }, {})
    assert.equal(loaded.baseUrl, 'http://127.0.0.1:7111')
    assert.equal(loaded.ttsVoice, 'default')

    loaded.baseUrl = 'http://127.0.0.1:7333'
    loaded.token = 'my-token'
    const saved = store.save(loaded)
    assert.equal(saved.baseUrl, 'http://127.0.0.1:7333')

    const again = new ConfigStore({ homeDir: temp.dir })
    const reread = again.load({}, {})
    assert.equal(reread.baseUrl, 'http://127.0.0.1:7333')
    assert.equal(reread.token, 'my-token')

    const pub = publicConfig(reread)
    assert.equal(pub.token, '***已设置***')
    assert.ok(!JSON.stringify(pub).includes('my-token'))

    const leftovers = readdirSync(temp.dir).filter((x) => x.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  } finally {
    temp.cleanup()
  }
})

test('ConfigStore.save 写入的是规范化后的完整配置', () => {
  const temp = makeTempDir()
  try {
    const store = new ConfigStore({ homeDir: temp.dir })
    store.load({}, {})
    store.save({ ...store.current, requestTimeoutMs: 12345, cacheMaxMb: 4096 })
    const raw = JSON.parse(readFileSync(join(temp.dir, 'fish-service-config.json'), 'utf8'))
    assert.equal(raw.requestTimeoutMs, 12345)
    assert.equal(raw.cacheMaxMb, 4096)
    assert.equal(raw.version, CONFIG_VERSION)
    assert.equal(raw.baseUrl, 'http://127.0.0.1:7880')
  } finally {
    temp.cleanup()
  }
})

test('schemastery 配置 schema 能构建（拿不到包时允许为 undefined）', async () => {
  const temp = makeTempDir()
  try {
    const z = (await import('@deepseek-ai/schemastery')).default
    const schema = buildConfigSchema(z, temp.dir)
    assert.equal(typeof schema, 'function')
    const text = String(schema)
    assert.match(text, /baseUrl/)
    assert.match(text, /ttsVoice/)
    assert.match(text, /cacheDir/)
  } finally {
    temp.cleanup()
  }
})
