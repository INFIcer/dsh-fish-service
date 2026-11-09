// P2 multipart 解析与音频字段工具（纯函数，离线）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  取边界,
  取音频扩展,
  取音频文件,
  是音频扩展,
  最大音频字节,
  最大录音毫秒,
  解析multipart,
  读数字字段,
} from '../lib/upload.js'

function 造表单(边界, 段们) {
  const 块 = []
  for (const 段 of 段们) {
    let 头 = `--${边界}\r\nContent-Disposition: form-data; name="${段.name}"`
    if (段.filename) 头 += `; filename="${段.filename}"`
    头 += '\r\n'
    if (段.type) 头 += `Content-Type: ${段.type}\r\n`
    头 += '\r\n'
    块.push(Buffer.from(头, 'utf8'))
    const 数据 = Buffer.isBuffer(段.data) ? 段.data : Buffer.from(String(段.data ?? ''), 'utf8')
    块.push(数据)
    块.push(Buffer.from('\r\n', 'utf8'))
  }
  块.push(Buffer.from(`--${边界}--\r\n`, 'utf8'))
  return Buffer.concat(块)
}

test('取边界：带引号/不带引号都能认；非 multipart 返回空串', () => {
  assert.equal(取边界('multipart/form-data; boundary=abc123'), 'abc123')
  assert.equal(取边界('multipart/form-data; boundary="a b-c"'), 'a b-c')
  assert.equal(取边界('application/json'), '')
  assert.equal(取边界(''), '')
})

test('解析multipart：字段 + 文件（二进制原样）', () => {
  const 音频 = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff])
  const 体 = 造表单('BOUND', [
    { name: 'language', data: 'zh' },
    { name: 'durationMs', data: '3200' },
    { name: 'file', filename: 'voice.webm', type: 'audio/webm', data: 音频 },
  ])
  const r = 解析multipart(体, 'multipart/form-data; boundary=BOUND')
  assert.equal(r.fields.language, 'zh')
  assert.equal(r.fields.durationMs, '3200')
  assert.equal(r.files.length, 1)
  assert.equal(r.files[0].field, 'file')
  assert.equal(r.files[0].filename, 'voice.webm')
  assert.equal(r.files[0].contentType, 'audio/webm')
  assert.deepEqual([...r.files[0].data], [...音频])
})

test('解析multipart：filename* / 中文文件名不炸，字段按 UTF-8 读', () => {
  const 体 = 造表单('X', [
    { name: 'note', data: '你好' },
    { name: 'file', filename: '录音 1.wav', type: 'audio/wav', data: Buffer.from('RIFF') },
  ])
  const r = 解析multipart(体, 'multipart/form-data; boundary=X')
  assert.equal(r.fields.note, '你好')
  assert.equal(r.files[0].filename, '录音 1.wav')
})

test('解析multipart：空体 / 错边界安全返回空结果', () => {
  assert.deepEqual(解析multipart(Buffer.alloc(0), 'multipart/form-data; boundary=X'), { fields: {}, files: [] })
  assert.deepEqual(解析multipart(Buffer.from('junk'), 'multipart/form-data; boundary=X'), { fields: {}, files: [] })
  assert.deepEqual(解析multipart(Buffer.from('junk'), 'text/plain'), { fields: {}, files: [] })
})

test('取音频文件：优先 file / audio 字段，其次第一个文件', () => {
  const 结果 = {
    files: [
      { field: 'thumb', filename: 'a.png', data: Buffer.from('x') },
      { field: 'audio', filename: 'b.webm', data: Buffer.from('y') },
    ],
  }
  assert.equal(取音频文件(结果).field, 'audio')
  assert.equal(取音频文件({ files: [{ field: 'other' }] }).field, 'other')
  assert.equal(取音频文件({ files: [] }), null)
  assert.equal(取音频文件(null), null)
})

test('取音频扩展：MIME 优先，其次文件名，未知回退 .webm', () => {
  assert.equal(取音频扩展('audio/wav', 'x.bin'), '.wav')
  assert.equal(取音频扩展('audio/webm;codecs=opus', 'x'), '.webm')
  assert.equal(取音频扩展('audio/ogg', 'x.opus'), '.ogg')
  assert.equal(取音频扩展('application/octet-stream', '录音.WAV'), '.wav')
  assert.equal(取音频扩展('', 'x.mp4'), '.m4a')
  assert.equal(取音频扩展('', 'x.unknown'), '.webm')
})

test('是音频扩展 与 常量', () => {
  assert.equal(是音频扩展('a.wav'), true)
  assert.equal(是音频扩展('a.WEBM'), true)
  assert.equal(是音频扩展('a.txt'), false)
  assert.equal(最大音频字节, 25 * 1024 * 1024)
  assert.equal(最大录音毫秒, 5 * 60 * 1000)
  assert.equal(读数字字段('3000', 0), 3000)
  assert.equal(读数字字段('abc', 7), 7)
  assert.equal(读数字字段(undefined, 7), 7)
})
