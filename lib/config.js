// 配置：默认值、范围钳制、环境变量覆盖、原子持久化、设置页脱敏。
//
// 配置的真身是 <DSH 家目录>/fish-service-config.json。
// 设置页读写的也是它；schema 只是给 DSH 的声明，不靠它存运行配置。
//
// 优先级：env > 文件 > 插件 patch 传入的配置 > 默认值。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureDir, expandHome, readJson, writeJsonAtomic } from './fs-util.js'

export const CONFIG_VERSION = 1
export const CONFIG_FILE = 'fish-service-config.json'
export const CAPABILITY_NAMES = Object.freeze([
  'tts', 'asr', 'translate', 'separate', 'vision', 'media', 'download', 'jobs',
])

const 默认家目录 = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/** 默认配置（cacheDir 在执行时才按家目录展开）。 */
export function defaultConfig(homeDir = 默认家目录()) {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    /** 唯一服务地址（唯一知道 localai 在哪里的地方） */
    baseUrl: 'http://127.0.0.1:7880',
    /** 期望的 HTTP 契约主版本 */
    apiVersion: '1',
    /** LOCALAI_TOKEN；只写不回显 */
    token: '',
    /** 一般请求（TTS）超时 */
    requestTimeoutMs: 180000,
    /** ASR / 分离超时 */
    asrTimeoutMs: 300000,
    /** 视觉超时 */
    visionTimeoutMs: 600000,
    /** 默认音色；迁移自 fish-message 时保留 dafeiyu */
    ttsVoice: 'dafeiyu',
    /** 朗读默认语速（0.5~2.0） */
    ttsSpeed: 1,
    /** 新会话默认是否自动朗读最终回复（单个会话的值见 autoReadSessions） */
    autoRead: false,
    /** 按会话保存的自动朗读：{ [sessionId]: boolean }；缺省时回落到 autoRead */
    autoReadSessions: {},
    /** 朗读时单段最大字数（超过就分段合成） */
    readMaxChars: 2000,
    /** 朗读分段合成时的并发批数（1~4；1 = 完全串行） */
    readConcurrency: 2,
    /** 朗读时是否去掉代码块（关掉则读「代码块，共 N 行」） */
    readSkipCode: true,
    /** 语音输入录音格式：auto / webm / wav */
    recordMime: 'auto',
    /** 是否记住上次的三选一（只作默认高亮，不自动执行） */
    rememberVoiceChoice: true,
    /** 语音输入默认 ASR 语言 */
    asrLanguage: 'auto',
    /** 产物目录（TTS / 分离 / 关键帧） */
    cacheDir: join(homeDir, 'fish-service-cache'),
    /** 产物 TTL（小时），必须大于 fish-message 出站 TTL（24h） */
    cacheTtlHours: 72,
    /** 缓存上限（MB），超出按 LRU 删 */
    cacheMaxMb: 2048,
    /** 后台健康检查间隔 */
    healthIntervalMs: 15000,
    /** 可选：只启用这些能力（空 = 全部按服务端 capabilities） */
    enabledCapabilities: [],
    /** debug / info / warn / error */
    logLevel: 'info',
    /** P3 安装器维护；P1 只读 */
    installMode: 'unknown',
    installDir: '',
  }
}

const 数字范围 = (值, 兜底, 最小, 最大) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.max(最小, Math.min(最大, n))
}

const 整数范围 = (值, 兜底, 最小, 最大) => Math.round(数字范围(值, 兜底, 最小, 最大))

const 布尔 = (值, 兜底) => {
  if (值 === true || 值 === 'true' || 值 === 1 || 值 === '1') return true
  if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
  return 兜底
}

/** 「按会话自动朗读」最多保存的会话数；超出部分丢弃（有上限，避免配置文件无限膨胀）。 */
export const AUTO_READ_SESSIONS_LIMIT = 200
const 会话键格式 = /^session-/

/**
 * 规范化「按会话自动朗读」：
 * - 只接受普通对象，其它值按空表处理；
 * - 键须以 session- 开头，值转布尔；
 * - 最多保留 200 条，超出部分丢弃；
 * - 非法项忽略，不报错。
 * 返回 { value, warnings }；warnings 是给用户看的中文提示，不含会话键。
 */
export function normalizeAutoReadSessions(值) {
  if (值 == null) return { value: {}, warnings: [], valid: true }
  if (typeof 值 !== 'object' || Array.isArray(值)) {
    return {
      value: {},
      warnings: ['自动朗读的会话设置格式不正确，已忽略。'],
      valid: false,
    }
  }
  const 出 = {}
  let 非法 = 0
  let 超出 = 0
  for (const 原始键 of Object.keys(值)) {
    const 键 = String(原始键)
    if (!会话键格式.test(键)) { 非法 += 1; continue }
    if (Object.keys(出).length >= AUTO_READ_SESSIONS_LIMIT) { 超出 += 1; continue }
    出[键] = 布尔(值[原始键], false)
  }
  const warnings = []
  if (非法) warnings.push(`自动朗读的会话设置中有 ${非法} 条无法识别，已忽略。`)
  if (超出) warnings.push(`自动朗读的会话设置最多保留 ${AUTO_READ_SESSIONS_LIMIT} 条，超出的 ${超出} 条已忽略。`)
  return { value: 出, warnings, valid: true }
}

const 字 = (值, 兜底 = '') => {
  if (值 == null) return 兜底
  return typeof 值 === 'string' ? 值.trim() : String(值).trim()
}

const 去尾斜杠 = (值) => 字(值).replace(/\/+$/, '')

const 规范地址 = (值, 兜底) => {
  const 地址 = 去尾斜杠(值)
  if (!地址) return 兜底
  try {
    const u = new URL(地址)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 兜底
    return 地址
  } catch {
    return 兜底
  }
}

const 规范能力列表 = (值) => {
  const 原始 = Array.isArray(值) ? 值 : (typeof 值 === 'string' ? 值.split(',') : [])
  const 出 = []
  for (const 项 of 原始) {
    const 名 = 字(项).toLowerCase()
    if (CAPABILITY_NAMES.includes(名) && !出.includes(名)) 出.push(名)
  }
  return 出
}

/** 枚举值：不认识就回退默认。 */
const 枚举 = (值, 允许, 兜底) => {
  const 名 = 字(值).toLowerCase()
  return 允许.includes(名) ? 名 : 兜底
}

/** 语速：0.5~2.0，保留两位小数。 */
const 规范语速 = (值, 兜底) => {
  const n = Number(值)
  if (!Number.isFinite(n)) return 兜底
  return Math.round(Math.max(0.5, Math.min(2, n)) * 100) / 100
}

/** 解包 DSH / cosmokit 的 volatile 配置引用；普通值原样返回。 */
function 解包配置值(值) {
  if (值 && typeof 值 === 'object' && typeof 值.get === 'function'
    && Symbol.for('cosmokit.volatile.write') in 值) {
    try { return 值.get() } catch { return undefined }
  }
  return 值
}

/** 读进来的任何东西都走这里：补默认值、钳范围、认旧字段。 */
export function normalizeConfig(raw, { homeDir = 默认家目录(), onWarning = null } = {}) {
  const 默认 = defaultConfig(homeDir)
  const 原始配置 = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  // DSH 的 schemastery 字段如果标了 `volatile`，传进来的是 {get()} 引用而不是值。
  // 这里统一解包，避免把 `[object Object]` 写进配置。
  const src = {}
  for (const [字段, 值] of Object.entries(原始配置)) {
    src[字段] = 解包配置值(值)
  }
  const 会话朗读 = normalizeAutoReadSessions(src.autoReadSessions)
  if (onWarning) {
    for (const 警告 of 会话朗读.warnings) onWarning(警告)
  }

  const logLevelRaw = 字(src.logLevel, 默认.logLevel).toLowerCase()
  const logLevel = ['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info'
  const 模式Raw = 字(src.installMode, 默认.installMode).toLowerCase()
  const installMode = ['unknown', 'managed', 'adopted'].includes(模式Raw) ? 模式Raw : 'unknown'
  const baseUrl = 规范地址(src.baseUrl, 默认.baseUrl)
  const apiVersion = 字(src.apiVersion, 默认.apiVersion) || 默认.apiVersion

  return {
    version: CONFIG_VERSION,
    enabled: 布尔(src.enabled, 默认.enabled),
    baseUrl,
    apiVersion,
    token: 字(src.token, '').slice(0, 512),
    requestTimeoutMs: 整数范围(src.requestTimeoutMs, 默认.requestTimeoutMs, 1000, 1800000),
    asrTimeoutMs: 整数范围(src.asrTimeoutMs, 默认.asrTimeoutMs, 1000, 1800000),
    visionTimeoutMs: 整数范围(src.visionTimeoutMs, 默认.visionTimeoutMs, 1000, 1800000),
    ttsVoice: 字(src.ttsVoice, 默认.ttsVoice).slice(0, 80) || 默认.ttsVoice,
    ttsSpeed: 规范语速(src.ttsSpeed, 默认.ttsSpeed),
    autoRead: 布尔(src.autoRead, 默认.autoRead),
    autoReadSessions: 会话朗读.value,
    readMaxChars: 整数范围(src.readMaxChars, 默认.readMaxChars, 200, 5000),
    readConcurrency: 整数范围(src.readConcurrency, 默认.readConcurrency, 1, 4),
    readSkipCode: 布尔(src.readSkipCode, 默认.readSkipCode),
    recordMime: 枚举(src.recordMime, ['auto', 'webm', 'wav'], 默认.recordMime),
    rememberVoiceChoice: 布尔(src.rememberVoiceChoice, 默认.rememberVoiceChoice),
    asrLanguage: 枚举(src.asrLanguage, ['auto', 'zh', 'en', 'ja'], 默认.asrLanguage),
    cacheDir: expandHome(字(src.cacheDir, 默认.cacheDir), homeDir) || 默认.cacheDir,
    cacheTtlHours: 整数范围(src.cacheTtlHours, 默认.cacheTtlHours, 1, 720),
    cacheMaxMb: 整数范围(src.cacheMaxMb, 默认.cacheMaxMb, 256, 10240),
    healthIntervalMs: 整数范围(src.healthIntervalMs, 默认.healthIntervalMs, 5000, 120000),
    enabledCapabilities: 规范能力列表(src.enabledCapabilities),
    logLevel,
    installMode,
    installDir: expandHome(字(src.installDir, ''), homeDir),
  }
}

// 环境变量：优先 DSH_FISH_SERVICE_*（契约），同时接受 FISH_SERVICE_*（简短写法）。
const 环境变量表 = [
  ['baseUrl', ['DSH_FISH_SERVICE_BASE_URL', 'FISH_SERVICE_BASE_URL'], 'string'],
  ['apiVersion', ['DSH_FISH_SERVICE_API_VERSION', 'FISH_SERVICE_API_VERSION'], 'string'],
  ['token', ['DSH_FISH_SERVICE_TOKEN', 'FISH_SERVICE_TOKEN'], 'string'],
  ['enabled', ['DSH_FISH_SERVICE_ENABLED', 'FISH_SERVICE_ENABLED'], 'boolean'],
  ['requestTimeoutMs', ['DSH_FISH_SERVICE_REQUEST_TIMEOUT_MS', 'FISH_SERVICE_REQUEST_TIMEOUT_MS'], 'number'],
  ['asrTimeoutMs', ['DSH_FISH_SERVICE_ASR_TIMEOUT_MS', 'FISH_SERVICE_ASR_TIMEOUT_MS'], 'number'],
  ['visionTimeoutMs', ['DSH_FISH_SERVICE_VISION_TIMEOUT_MS', 'FISH_SERVICE_VISION_TIMEOUT_MS'], 'number'],
  ['ttsVoice', ['DSH_FISH_SERVICE_TTS_VOICE', 'FISH_SERVICE_TTS_VOICE'], 'string'],
  ['cacheDir', ['DSH_FISH_SERVICE_CACHE_DIR', 'FISH_SERVICE_CACHE_DIR'], 'string'],
  ['healthIntervalMs', ['DSH_FISH_SERVICE_HEALTH_MS', 'FISH_SERVICE_HEALTH_MS'], 'number'],
  ['logLevel', ['DSH_FISH_SERVICE_LOG_LEVEL', 'FISH_SERVICE_LOG_LEVEL'], 'string'],
  ['enabledCapabilities', ['DSH_FISH_SERVICE_ENABLED_CAPABILITIES', 'FISH_SERVICE_ENABLED_CAPABILITIES'], 'list'],
  ['installDir', ['DSH_FISH_SERVICE_INSTALL_DIR', 'FISH_SERVICE_INSTALL_DIR'], 'string'],
]

function 找环境变量(env, 名字们) {
  for (const 名 of 名字们) {
    if (env && env[名] !== undefined && env[名] !== '') return { key: 名, value: env[名] }
  }
  return null
}

/**
 * 环境变量覆盖（返回新对象，不改入参）。
 * @returns {{config: object, overrides: string[]}}
 */
export function applyEnv(config, env = process.env, { homeDir = 默认家目录() } = {}) {
  const 补丁 = {}
  const overrides = []
  for (const [字段, 名字们, 类型] of 环境变量表) {
    const 命中 = 找环境变量(env, 名字们)
    if (!命中) continue
    if (类型 === 'boolean') 补丁[字段] = 布尔(命中.value, config[字段])
    else if (类型 === 'number') 补丁[字段] = Number(命中.value)
    else if (类型 === 'list') 补丁[字段] = String(命中.value).split(',')
    else 补丁[字段] = 命中.value
    overrides.push(字段)
  }
  if (!overrides.length) return { config, overrides }
  return {
    config: normalizeConfig({ ...config, ...补丁 }, { homeDir }),
    overrides,
  }
}

/** 设置页 / 宿主路由能看到的配置（token 打码）。 */
export function publicConfig(config) {
  const c = normalizeConfig(config)
  return {
    ...c,
    token: c.token ? '***已设置***' : '',
  }
}

/** 让设置页知道哪些字段被环境变量钉住了（改了也不生效）。 */
export function envOverrides(env = process.env) {
  const 出 = []
  for (const [字段, 名字们] of 环境变量表) {
    if (找环境变量(env, 名字们)) 出.push(字段)
  }
  return 出
}

/** 配置持久化。 */
export class ConfigStore {
  constructor({ homeDir = 默认家目录(), fileName = CONFIG_FILE } = {}) {
    this.homeDir = homeDir
    this.filePath = join(homeDir, fileName)
    this.current = null
    this.overrides = []
    /** 最近一次载入/保存时被丢弃的非法项（给日志用，不含会话键）。 */
    this.warnings = []
  }

  /** 文件 > pluginConfig > 默认；最后套 env。 */
  load(pluginConfig = {}, env = process.env) {
    const 文件 = readJson(this.filePath, null)
    const 合并 = { ...(pluginConfig || {}), ...(文件 || {}) }
    this.warnings = []
    const 规范 = normalizeConfig(合并, {
      homeDir: this.homeDir,
      onWarning: (警告) => this.warnings.push(警告),
    })
    const 结果 = applyEnv(规范, env, { homeDir: this.homeDir })
    this.current = 结果.config
    this.overrides = 结果.overrides
    return this.current
  }

  save(config) {
    this.warnings = []
    const 规范 = normalizeConfig(config, {
      homeDir: this.homeDir,
      onWarning: (警告) => this.warnings.push(警告),
    })
    ensureDir(this.homeDir)
    if (!writeJsonAtomic(this.filePath, 规范)) return null
    // 文件里存的是“不含 env”的值；运行值仍要套 env（env > file）。
    const 结果 = applyEnv(规范, process.env, { homeDir: this.homeDir })
    this.current = 结果.config
    this.overrides = 结果.overrides
    return this.current
  }

  get() {
    return this.current
  }
}

/** cordis / schemastery 配置 schema；拿不到 schemastery 时返回 undefined，插件照常加载。 */
export function buildConfigSchema(z, homeDir = 默认家目录()) {
  const 默认 = defaultConfig(homeDir)
  // 不标 `volatile`：P1 的配置真身是 fish-service-config.json，设置页走宿主路由读写；
  // 如果标成 volatile，DSH 会把每个字段包成 {get()} 引用，静态 ConfigStore 读不到实际值。
  return z.object({
    enabled: z.boolean().default(默认.enabled).description('总开关'),
    baseUrl: z.string().default(默认.baseUrl).description('本地 AI 服务地址'),
    apiVersion: z.string().default(默认.apiVersion).description('期望的 HTTP 契约主版本'),
    token: z.string().default('').description('LOCALAI_TOKEN；只写不回显'),
    requestTimeoutMs: z.natural().default(默认.requestTimeoutMs).description('TTS/一般请求超时（毫秒）'),
    asrTimeoutMs: z.natural().default(默认.asrTimeoutMs).description('ASR/分离超时（毫秒）'),
    visionTimeoutMs: z.natural().default(默认.visionTimeoutMs).description('视觉超时（毫秒）'),
    ttsVoice: z.string().default(默认.ttsVoice).description('默认音色'),
    ttsSpeed: z.number().min(0.5).max(2).default(默认.ttsSpeed).description('朗读语速 0.5~2.0'),
    autoRead: z.boolean().default(默认.autoRead).description('新会话默认自动朗读最终回复'),
    autoReadSessions: z.dict(z.boolean()).default({}).description('按会话保存的自动朗读设置'),
    readMaxChars: z.natural().min(200).max(5000).default(默认.readMaxChars).description('朗读单段最大字数'),
    readConcurrency: z.natural().min(1).max(4).default(默认.readConcurrency).description('朗读分段合成并发度 1~4'),
    readSkipCode: z.boolean().default(默认.readSkipCode).description('朗读时去掉代码块'),
    recordMime: z.string().default(默认.recordMime).description('录音格式：auto/webm/wav'),
    rememberVoiceChoice: z.boolean().default(默认.rememberVoiceChoice).description('记住语音输入上次选择'),
    asrLanguage: z.string().default(默认.asrLanguage).description('语音输入 ASR 语言：auto/zh/en/ja'),
    cacheDir: z.string().default(默认.cacheDir).description('产物缓存目录'),
    cacheTtlHours: z.natural().default(默认.cacheTtlHours).description('产物 TTL（小时）'),
    cacheMaxMb: z.natural().default(默认.cacheMaxMb).description('缓存上限（MB）'),
    healthIntervalMs: z.natural().default(默认.healthIntervalMs).description('健康检查间隔（毫秒）'),
    enabledCapabilities: z.array(z.string()).default([]).description('只启用这些能力；空=自动'),
    logLevel: z.string().default(默认.logLevel).description('日志级别：debug/info/warn/error'),
  }).description('dsh-fish-service 配置')
}
