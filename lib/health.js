// 后台健康轮询：不阻塞插件加载，失败时退避 5s → 10s → 30s，成功后回到配置间隔。
// 它只负责“多久探一次”；探测本身、缓存、事件都在 CapabilityService 里。

export class HealthMonitor {
  constructor({ capabilities, getConfig, logger = null }) {
    this.capabilities = capabilities
    this.getConfig = getConfig
    this.logger = logger
    this.started = false
    this.stopped = false
    this.timer = null
    this.failures = 0
  }

  start() {
    if (this.started) return
    this.started = true
    this.stopped = false
    this.#schedule(50)
  }

  stop() {
    this.stopped = true
    this.started = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  #interval() {
    const 配置 = this.getConfig?.() || {}
    if (this.failures <= 0) return Math.max(5000, Number(配置.healthIntervalMs) || 15000)
    if (this.failures === 1) return 5000
    if (this.failures === 2) return 10000
    return 30000
  }

  #schedule(ms) {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.#tick() }, Math.max(0, ms))
    this.timer.unref?.()
  }

  async #tick() {
    if (this.stopped) return
    try {
      const 快照 = await this.capabilities.refresh({ force: true, timeoutMs: 2000 })
      this.failures = 快照.ok || 快照.reachable ? 0 : (this.failures + 1)
    } catch (error) {
      this.failures += 1
      this.logger?.debug(`健康检查异常：${error?.message || error}`)
    } finally {
      this.#schedule(this.#interval())
    }
  }
}
