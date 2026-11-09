// 日志：内存环（设置页看最近 200 行）+ 落盘文件（超过 5 MB 滚动一次）。
// 所有写入都包在 try/catch 里：日志坏了不能影响主流程。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const 等级权重 = { debug: 10, info: 20, warn: 30, error: 40 }

export class Logger {
  constructor({ filePath, level = 'info', maxMemory = 200, maxBytes = 5 * 1024 * 1024 } = {}) {
    this.filePath = filePath || ''
    this.level = 等级权重[level] ? level : 'info'
    this.maxMemory = maxMemory
    this.maxBytes = maxBytes
    this.lines = []
  }

  setLevel(level) {
    if (等级权重[level]) this.level = level
  }

  enabled(level) {
    return (等级权重[level] || 20) >= (等级权重[this.level] || 20)
  }

  log(level, message) {
    const 级别 = 等级权重[level] ? level : 'info'
    const 文本 = String(message == null ? '' : message).replace(/\r?\n/g, ' ⏎ ')
    const 时间 = new Date()
    const 补 = (n, w = 2) => String(n).padStart(w, '0')
    const 行 = `${时间.getFullYear()}-${补(时间.getMonth() + 1)}-${补(时间.getDate())} `
      + `${补(时间.getHours())}:${补(时间.getMinutes())}:${补(时间.getSeconds())}.${补(时间.getMilliseconds(), 3)} `
      + `[${级别.toUpperCase()}] ${文本}`

    this.lines.push(行)
    if (this.lines.length > this.maxMemory) this.lines.splice(0, this.lines.length - this.maxMemory)

    if (!this.enabled(级别) || !this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath) && statSync(this.filePath).size > this.maxBytes) {
        const 旧 = `${this.filePath}.1`
        try { if (existsSync(旧)) unlinkSync(旧) } catch { /* 删不掉就继续追加 */ }
        try { renameSync(this.filePath, 旧) } catch { /* 滚动失败就继续追加 */ }
      }
      appendFileSync(this.filePath, `${行}\n`, 'utf8')
    } catch {
      // 写不进日志不影响服务。
    }
  }

  debug(msg) { this.log('debug', msg) }
  info(msg) { this.log('info', msg) }
  warn(msg) { this.log('warn', msg) }
  error(msg) { this.log('error', msg) }

  recent(n = 200) {
    const 数 = Math.max(1, Math.min(1000, Number(n) || 200))
    return this.lines.slice(-数)
  }
}
