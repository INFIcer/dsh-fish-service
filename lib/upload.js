// multipart/form-data 的最小解析器（P2 语音上传用）。
//
// 浏览器用 FormData 上传录音；这里不引入 busboy/ formidable 之类依赖，
// 只用 Node 内置 Buffer + indexOf 手写一份，够用且能离线单测。
//
// 限制：只处理一层 multipart，字段值按 UTF-8 文本；文件按二进制原样保留。
// 上传大小由调用方在读请求体时限制（见 lib/routes.js 的 读原始体）。

import { extname } from 'node:path'

export const 最大音频字节 = 25 * 1024 * 1024
export const 最大录音毫秒 = 5 * 60 * 1000

const 音频扩展 = new Set(['.webm', '.ogg', '.opus', '.wav', '.mp3', '.m4a', '.mp4', '.aac', '.flac'])

const MIME扩展 = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
}

/** 从 content-type 里取 boundary；没有就返回空串。 */
export function 取边界(contentType) {
  const 值 = String(contentType || '')
  if (!/^multipart\/form-data/i.test(值)) return ''
  const 匹配 = /boundary\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(值)
  const 边界 = (匹配 && (匹配[1] || 匹配[2]) || '').trim()
  return 边界
}

function 解析头(文本) {
  const 头 = {}
  for (const 行 of String(文本 || '').split('\r\n')) {
    const 位置 = 行.indexOf(':')
    if (位置 <= 0) continue
    头[行.slice(0, 位置).trim().toLowerCase()] = 行.slice(位置 + 1).trim()
  }
  return 头
}

function 解析处置(值) {
  const 出 = { name: '', filename: '' }
  const 文本 = String(值 || '')
  const 名 = /name\s*=\s*"([^"]*)"/i.exec(文本) || /name\s*=\s*([^;]+)/i.exec(文本)
  const 文件 = /filename\s*=\s*"([^"]*)"/i.exec(文本) || /filename\s*=\s*([^;]+)/i.exec(文本)
  if (名) 出.name = 名[1]
  if (文件) 出.filename = 文件[1]
  return 出
}

/**
 * 解析 multipart 请求体。
 * @param {Buffer} buffer
 * @param {string} contentType
 * @returns {{fields: Record<string,string>, files: Array<{field:string, filename:string, contentType:string, data:Buffer}>}}
 */
export function 解析multipart(buffer, contentType) {
  const 边界 = 取边界(contentType)
  const 结果 = { fields: {}, files: [] }
  if (!边界 || !Buffer.isBuffer(buffer) || buffer.length === 0) return 结果

  const 分隔 = Buffer.from(`--${边界}`)
  let 位置 = buffer.indexOf(分隔)
  while (位置 !== -1) {
    位置 += 分隔.length
    // 结束标记 --boundary--
    if (buffer[位置] === 0x2d && buffer[位置 + 1] === 0x2d) break
    if (buffer[位置] === 0x0d && buffer[位置 + 1] === 0x0a) 位置 += 2
    else if (buffer[位置] === 0x0a) 位置 += 1

    const 头结束 = buffer.indexOf('\r\n\r\n', 位置)
    if (头结束 === -1) break
    const 头文本 = buffer.subarray(位置, 头结束).toString('utf8')
    const 下一个 = buffer.indexOf(分隔, 头结束 + 4)
    if (下一个 === -1) break

    let 数据结束 = 下一个
    // 分隔符前面固定有 \r\n。
    if (buffer[数据结束 - 2] === 0x0d && buffer[数据结束 - 1] === 0x0a) 数据结束 -= 2
    else if (buffer[数据结束 - 1] === 0x0a) 数据结束 -= 1

    const 数据 = buffer.subarray(头结束 + 4, 数据结束)
    const 头 = 解析头(头文本)
    const 处置 = 解析处置(头['content-disposition'])
    if (处置.name) {
      if (处置.filename) {
        结果.files.push({
          field: 处置.name,
          filename: 处置.filename,
          contentType: 头['content-type'] || 'application/octet-stream',
          data: Buffer.from(数据),
        })
      } else {
        结果.fields[处置.name] = 数据.toString('utf8')
      }
    }
    位置 = 下一个
  }
  return 结果
}

/** 找上传的音频文件：优先 file/audio 字段，其次第一个文件。 */
export function 取音频文件(解析结果) {
  if (!解析结果 || !Array.isArray(解析结果.files)) return null
  return 解析结果.files.find((x) => x.field === 'file' || x.field === 'audio')
    || 解析结果.files[0]
    || null
}

/** 依 MIME / 文件名推一个安全扩展名。 */
export function 取音频扩展(mime, filename) {
  const 类型 = String(mime || '').split(';')[0].trim().toLowerCase()
  if (MIME扩展[类型]) return MIME扩展[类型]
  const 扩展 = extname(String(filename || '')).toLowerCase()
  // 音频容器是 mp4 时统一存成 .m4a（/audio 只认 .m4a 这个扩展名）。
  if (扩展 === '.mp4') return '.m4a'
  if (音频扩展.has(扩展)) return 扩展
  return '.webm'
}

/** 只看扩展名判断是不是我们愿意接收的音频。 */
export function 是音频扩展(path) {
  return 音频扩展.has(extname(String(path || '')).toLowerCase())
}

/** 读 multipart 里的数值字段（缺省/非法返回兜底）。 */
export function 读数字字段(字段, 兜底 = 0) {
  const n = Number(字段)
  return Number.isFinite(n) ? n : 兜底
}
