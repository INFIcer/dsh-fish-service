// dsh-fish-service · 宿主入口
//
// 只做装配：
//   配置 → 客户端 → 能力缓存 → 健康轮询 → fish.service → 8 个工具 → 宿主路由。
// 真正的逻辑都在 lib/ 里，宿主层保持薄，方便离线单测。
//
// 生命周期：插件加载不阻塞 DSH；健康轮询在后台跑；
// ctx.effect 的 cleanup 负责停轮询、停缓存清理、摘工具和路由。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigStore, buildConfigSchema } from './config.js'
import { Logger } from './logger.js'
import { CacheStore } from './cache.js'
import { LocalAIClient } from './client.js'
import { CapabilityService } from './capabilities.js'
import { HealthMonitor } from './health.js'
import { createFishServiceApi } from './service-api.js'
import { registerTools } from './tools/index.js'
import { registerRoutes } from './routes.js'

const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')

export const name = 'fish-service'
export const inject = ['tools', 'webServer']

const 版本 = (() => {
  try {
    return String(JSON.parse(readFileSync(join(包根, 'package.json'), 'utf8')).version || '0.1.0')
  } catch {
    return '0.1.0'
  }
})()

// schemastery 是可选依赖：拿不到时 Config 为 undefined，插件照常加载（配置仍走 json）。
let schemastery = null
try {
  schemastery = (await import('@deepseek-ai/schemastery')).default
} catch {
  // 正常的降级路径，不打印错误。
}
export const Config = schemastery ? buildConfigSchema(schemastery) : undefined

export function apply(ctx, pluginConfig = {}) {
  const 家目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
  const configStore = new ConfigStore({ homeDir: 家目录 })
  let 配置 = configStore.load(pluginConfig || {})
  const logger = new Logger({ filePath: join(家目录, 'fish-service.log'), level: 配置.logLevel })
  // 配置里被丢弃的非法项（如手工改坏的按会话自动朗读）只记日志，不让插件起不来。
  for (const 警告 of configStore.warnings || []) logger.warn(警告)

  const cache = new CacheStore({
    dir: 配置.cacheDir,
    ttlHours: 配置.cacheTtlHours,
    maxMb: 配置.cacheMaxMb,
    logger,
  })
  cache.init()
  try { cache.cleanup() } catch (error) { logger.warn(`启动时缓存清理失败：${error?.message || error}`) }
  const 停缓存定时 = cache.startAutoCleanup()

  const client = new LocalAIClient({ getConfig: () => configStore.current, logger })
  const capabilities = new CapabilityService({
    client,
    getConfig: () => configStore.current,
    logger,
    ttlMs: 30000,
  })
  const monitor = new HealthMonitor({ capabilities, getConfig: () => configStore.current, logger })

  const api = createFishServiceApi({
    ctx,
    configStore,
    client,
    capabilities,
    cache,
    logger,
    version: 版本,
    onConfigChange: ({ config: 新配置 }) => {
      配置 = 新配置
      logger.setLevel(新配置.logLevel)
      // 缓存上限/TTL 是 CacheStore 的实例字段；设置页保存后立即生效，不用重启。
      cache.ttlHours = 新配置.cacheTtlHours
      cache.maxMb = 新配置.cacheMaxMb
    },
  })

  // 暴露 Cordis 服务：其它插件用 ctx.get('fish.service') 取。
  try {
    ctx.provide?.('fish.service', api)
  } catch (error) {
    logger.error(`ctx.provide('fish.service') 失败：${error?.message || error}`)
  }

  const 停工具 = ctx.effect(() => registerTools(ctx, { api, logger }), 'fish-service: 注册 8 个工具')
  const 停路由 = ctx.effect(() => registerRoutes({
    ctx,
    api,
    configStore,
    capabilities,
    cache,
    logger,
    version: 版本,
  }), 'fish-service: 注册 /dsh-fish-service 路由')

  const 停健康 = ctx.effect(() => {
    monitor.start()
    return () => monitor.stop()
  }, 'fish-service: 后台健康轮询')

  logger.info(`dsh-fish-service v${版本} 已加载｜服务地址 ${配置.baseUrl}｜缓存 ${配置.cacheDir}｜工具 ${8} 个`)
  if (configStore.overrides?.length) {
    logger.info(`环境变量覆盖：${configStore.overrides.join(', ')}`)
  }
  if (配置.enabled === false) {
    logger.warn('插件当前是停用状态（enabled=false）：工具会返回 service_not_installed，设置页仍可用。')
  }

  async function stop() {
    try { monitor.stop() } catch { /* 已停 */ }
    try { 停缓存定时?.() } catch { /* 已停 */ }
    for (const 停 of [停健康, 停工具, 停路由]) {
      try { if (typeof 停 === 'function') 停() } catch { /* 已卸载 */ }
    }
    cache.stopAutoCleanup()
    logger.info('dsh-fish-service 已卸载')
  }

  return {
    api,
    client,
    capabilities,
    cache,
    logger,
    configStore,
    health: monitor,
    stop,
  }
}

export { 版本 as version }
