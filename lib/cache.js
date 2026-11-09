// 产物缓存：TTS wav、分离 stems、视觉关键帧。
//
// 规则（DESIGN 8.7）：
//   - 模型/音频大文件**不写** ~/.dsh 根目录，统一进 cacheDir；
//   - 启动时 + 每 6 小时清理：先删过期（TTL），再按 LRU 删到上限；
//   - 翻译结果、任务列表、日志不缓存。

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'
import { copyFileSafe, ensureDir, sha16 } from './fs-util.js'

// tmp：ASR 上传的临时文件（请求结束即删）；voice：用户选择「保留语音」的录音（按 TTL/LRU 清理）。
const 子目录 = ['tts', 'separate', 'vision', 'tmp', 'voice']

function 递归文件(root) {
  const 出 = []
  const 走 = (目录) => {
    let 项 = []
    try { 项 = readdirSync(目录, { withFileTypes: true }) } catch { return }
    for (const 条目 of 项) {
      const 路径 = join(目录, 条目.name)
      if (条目.isDirectory()) 走(路径)
      else if (条目.isFile()) {
        try {
          const 信息 = statSync(路径)
          出.push({ path: 路径, bytes: 信息.size, mtimeMs: 信息.mtimeMs })
        } catch { /* 文件刚好被删 */ }
      }
    }
  }
  走(root)
  return 出
}

export class CacheStore {
  constructor({ dir, ttlHours = 72, maxMb = 2048, logger = null } = {}) {
    this.dirPath = String(dir || '')
    this.ttlHours = Number(ttlHours) || 72
    this.maxMb = Number(maxMb) || 2048
    this.logger = logger
    this.timer = null
  }

  setDir(dir) {
    this.dirPath = String(dir || '')
    this.init()
  }

  init() {
    if (!this.dirPath) return false
    ensureDir(this.dirPath)
    for (const 子 of 子目录) ensureDir(join(this.dirPath, 子))
    return true
  }

  kindDir(kind) {
    const 子 = 子目录.includes(kind) ? kind : 'tmp'
    return join(this.dirPath, 子)
  }

  /** 保存一段二进制，返回本机绝对路径。 */
  saveBuffer(kind, buffer, { ext = '.wav', key = '', ts = Date.now(), name = '' } = {}) {
    this.init()
    const 目录 = this.kindDir(kind)
    ensureDir(目录)
    const 前缀 = key ? `${String(key).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48)}-` : ''
    const 文件名 = name
      ? String(name).replace(/[\\/:*?"<>|]/g, '_')
      : `${前缀}${ts}${ext.startsWith('.') ? ext : `.${ext}`}`
    let 路径 = join(目录, 文件名)
    if (existsSync(路径)) 路径 = join(目录, `${前缀}${ts}-${Math.random().toString(16).slice(2, 8)}${ext}`)
    writeFileSync(路径, buffer)
    return 路径
  }

  /** 按 key 找已经存在的缓存（用于固定 seed 的 TTS 复用）。 */
  findByKey(kind, key) {
    const 目录 = this.kindDir(kind)
    const 前缀 = String(key || '')
    if (!前缀) return ''
    let 项 = []
    try { 项 = readdirSync(目录) } catch { return '' }
    const 命中 = 项.find((名) => 名.startsWith(`${前缀}-`))
    return 命中 ? join(目录, 命中) : ''
  }

  /** 复制一个服务端文件到缓存目录，返回目标路径。 */
  copyIn(kind, source, { subdir = '', name = '' } = {}) {
    this.init()
    const 目录 = join(this.kindDir(kind), String(subdir || ''))
    ensureDir(目录)
    const 目标 = join(目录, name || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}${extname(source) || '.bin'}`)
    if (!copyFileSafe(source, 目标)) return ''
    return 目标
  }

  /** 给一次任务分配一个独立目录（分离/关键帧用）。 */
  makeJobDir(kind, jobId = '') {
    this.init()
    const 标识 = String(jobId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`).replace(/[^a-zA-Z0-9_-]/g, '')
    const 目录 = join(this.kindDir(kind), 标识)
    ensureDir(目录)
    return 目录
  }

  /** 缓存用量（宿主 /state 与设置页用）。 */
  usage() {
    if (!this.dirPath || !existsSync(this.dirPath)) {
      return { dir: this.dirPath, bytes: 0, mb: 0, files: 0, byKind: {}, ttlHours: this.ttlHours, maxMb: this.maxMb }
    }
    const 文件 = 递归文件(this.dirPath)
    const byKind = {}
    let bytes = 0
    for (const 文件项 of 文件) {
      bytes += 文件项.bytes
      const 相对 = 文件项.path.slice(this.dirPath.length + 1)
      const 类 = 相对.split(/[\\/]/)[0] || 'other'
      byKind[类] = byKind[类] || { bytes: 0, files: 0 }
      byKind[类].bytes += 文件项.bytes
      byKind[类].files += 1
    }
    return {
      dir: this.dirPath,
      bytes,
      mb: Math.round((bytes / 1024 / 1024) * 10) / 10,
      files: 文件.length,
      byKind,
      ttlHours: this.ttlHours,
      maxMb: this.maxMb,
    }
  }

  /** 先删过期，再按 LRU 删到上限。 */
  cleanup({ now = Date.now() } = {}) {
    const 结果 = { expired: 0, lru: 0, bytesFreed: 0, scanned: 0 }
    if (!this.dirPath || !existsSync(this.dirPath)) return 结果
    const 文件 = 递归文件(this.dirPath)
    结果.scanned = 文件.length
    const 截止 = now - this.ttlHours * 3600 * 1000
    const 保留 = []
    for (const 文件项 of 文件) {
      if (文件项.mtimeMs < 截止) {
        try { rmSync(文件项.path, { force: true }); 结果.expired += 1; 结果.bytesFreed += 文件项.bytes } catch { /* 删不掉就留 */ }
      } else {
        保留.push(文件项)
      }
    }
    let 总字节 = 保留.reduce((和, x) => 和 + x.bytes, 0)
    const 上限 = this.maxMb * 1024 * 1024
    if (总字节 > 上限) {
      保留.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const 文件项 of 保留) {
        if (总字节 <= 上限) break
        try {
          rmSync(文件项.path, { force: true })
          总字节 -= 文件项.bytes
          结果.lru += 1
          结果.bytesFreed += 文件项.bytes
        } catch { /* 删不掉就留 */ }
      }
    }
    // 清理空目录（不删根）
    for (const 子 of 子目录) {
      const 目录 = join(this.dirPath, 子)
      try {
        if (existsSync(目录) && readdirSync(目录).length === 0) rmSync(目录, { recursive: false, force: true })
      } catch { /* 目录里还有东西或正被使用 */ }
    }
    this.init()
    if (结果.expired || 结果.lru) {
      this.logger?.info(`缓存清理：过期 ${结果.expired} 个、LRU ${结果.lru} 个，释放 ${(结果.bytesFreed / 1024 / 1024).toFixed(1)} MB`)
    }
    return 结果
  }

  /** 每 6 小时自动清理；返回停止函数。 */
  startAutoCleanup({ intervalMs = 6 * 3600 * 1000 } = {}) {
    this.stopAutoCleanup()
    this.timer = setInterval(() => {
      try { this.cleanup() } catch (error) { this.logger?.warn(`缓存清理失败：${error?.message || error}`) }
    }, intervalMs)
    this.timer.unref?.()
    return () => this.stopAutoCleanup()
  }

  stopAutoCleanup() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
}

export { sha16 }
