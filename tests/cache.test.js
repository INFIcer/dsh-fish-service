// 缓存：落盘路径、TTL、LRU、用量统计。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { CacheStore } from '../lib/cache.js'
import { makeTempDir, writeTempFile } from './helpers.js'

function 造缓存(temp, opts = {}) {
  const cache = new CacheStore({ dir: join(temp.dir, 'cache'), ttlHours: 72, maxMb: 2048, ...opts })
  cache.init()
  return cache
}

test('saveBuffer 写入 tts 子目录，返回绝对路径与正确字节', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp)
    const data = Buffer.from('RIFF....WAVE')
    const p = cache.saveBuffer('tts', data, { ext: '.wav', key: 'abc123', ts: 1000 })
    assert.ok(existsSync(p))
    assert.equal(statSync(p).size, data.length)
    assert.ok(p.startsWith(join(temp.dir, 'cache', 'tts')))
    assert.match(p, /abc123-1000\.wav$/)
  } finally {
    temp.cleanup()
  }
})

test('findByKey 只找同前缀；copyIn / makeJobDir 正常建目录', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp)
    const p = cache.saveBuffer('tts', Buffer.from('x'), { key: 'key-a', ts: 123 })
    assert.equal(cache.findByKey('tts', 'key-a'), p)
    assert.equal(cache.findByKey('tts', 'key-b'), '')
    assert.equal(cache.findByKey('tts', ''), '')

    const source = writeTempFile(temp.dir, 'src.wav', 'wave')
    const copied = cache.copyIn('separate', source, { subdir: 'job1', name: 'vocals.wav' })
    assert.ok(existsSync(copied))
    assert.ok(copied.includes(join('separate', 'job1')))

    const dir = cache.makeJobDir('vision', 'job-2')
    assert.ok(existsSync(dir))
    assert.ok(dir.endsWith('job-2'))
  } finally {
    temp.cleanup()
  }
})

test('usage 统计文件数、字节数与按类分组', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp)
    cache.saveBuffer('tts', Buffer.alloc(100), { ext: '.wav', ts: 1 })
    cache.saveBuffer('tts', Buffer.alloc(200), { ext: '.wav', ts: 2 })
    cache.saveBuffer('vision', Buffer.alloc(50), { ext: '.jpg', ts: 3 })

    const usage = cache.usage()
    assert.equal(usage.files, 3)
    assert.equal(usage.bytes, 350)
    assert.equal(usage.byKind.tts.files, 2)
    assert.equal(usage.byKind.tts.bytes, 300)
    assert.equal(usage.byKind.vision.bytes, 50)
    assert.equal(usage.maxMb, 2048)
    assert.equal(usage.ttlHours, 72)
  } finally {
    temp.cleanup()
  }
})

test('cleanup 删除过期文件（TTL）', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp, { ttlHours: 1 })
    const 旧 = cache.saveBuffer('tts', Buffer.from('old'), { ts: 1 })
    const 新 = cache.saveBuffer('tts', Buffer.from('new'), { ts: 2 })
    const 老时间 = new Date(Date.now() - 2 * 3600 * 1000)
    utimesSync(旧, 老时间, 老时间)

    const r = cache.cleanup()
    assert.equal(r.expired, 1)
    assert.equal(existsSync(旧), false)
    assert.equal(existsSync(新), true)
  } finally {
    temp.cleanup()
  }
})

test('cleanup 按 LRU 删到 cacheMaxMb 以内', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp, { maxMb: 0.0005 }) // ~524 字节
    const 老 = cache.saveBuffer('tts', Buffer.alloc(400), { ts: 1, name: 'old.wav' })
    const 新 = cache.saveBuffer('tts', Buffer.alloc(400), { ts: 2, name: 'new.wav' })
    const 老时间 = new Date(Date.now() - 60_000)
    const 新时间 = new Date()
    utimesSync(老, 老时间, 老时间)
    utimesSync(新, 新时间, 新时间)

    const r = cache.cleanup()
    assert.equal(r.lru, 1)
    assert.equal(existsSync(老), false)
    assert.equal(existsSync(新), true)
    assert.ok(cache.usage().mb <= 0.1)
  } finally {
    temp.cleanup()
  }
})

test('目录不存在时 usage / cleanup 安全返回', () => {
  const temp = makeTempDir()
  try {
    const cache = new CacheStore({ dir: join(temp.dir, 'nope') })
    const usage = cache.usage()
    assert.equal(usage.bytes, 0)
    assert.equal(usage.files, 0)
    const r = cache.cleanup()
    assert.equal(r.scanned, 0)
  } finally {
    temp.cleanup()
  }
})

test('startAutoCleanup 返回停止函数且可重复停止', () => {
  const temp = makeTempDir()
  try {
    const cache = 造缓存(temp)
    const stop = cache.startAutoCleanup({ intervalMs: 60000 })
    assert.equal(typeof stop, 'function')
    stop()
    stop()
    cache.stopAutoCleanup()
  } finally {
    temp.cleanup()
  }
})
