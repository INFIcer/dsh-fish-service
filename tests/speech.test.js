// P2 朗读文本预处理与分段（纯函数，离线）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  默认最大字数,
  最大分段字数,
  最多段数,
  prepareSpeech,
  splitForSpeech,
  stripMarkdown,
} from '../lib/speech.js'

const 样例 = [
  '# 标题一',
  '',
  '这是**加粗**和*斜体*，还有 `行内代码`。',
  '',
  '[链接文字](https://example.com/x) 和 ![图片说明](https://example.com/x.png)',
  '裸链接 https://example.com/y 会被丢掉。',
  '',
  '> 引用一行',
  '',
  '- 列表项 A',
  '- 列表项 B',
  '',
  '| 列1 | 列2 |',
  '| --- | --- |',
  '| 值1 | 值2 |',
  '',
  '---',
  '',
  '```js',
  'const a = 1',
  'const b = 2',
  '```',
  '',
  '[QQ]主人，测试一下。[/QQ]',
  '',
  '&nbsp;&amp; 结束',
].join('\n')

test('stripMarkdown：标题/加粗/斜体/行内代码/列表/引用/表格标记都剥掉', () => {
  const { text } = stripMarkdown(样例)
  assert.ok(!text.includes('#'))
  assert.ok(!text.includes('**'))
  assert.ok(!text.includes('`'))
  assert.ok(!text.includes('> '))
  assert.ok(text.includes('标题一'))
  assert.ok(text.includes('这是加粗和斜体，还有 行内代码。'), text)
  assert.ok(text.includes('引用一行'))
  assert.ok(text.includes('列表项 A'))
  assert.ok(text.includes('列表项 B'))
  assert.ok(!text.includes('- 列表项'))
  assert.ok(text.includes('列1，列2'), text)
  assert.ok(text.includes('值1，值2'), text)
  assert.ok(!text.includes('| ---'))
})

test('stripMarkdown：链接只读文字、图片只读 alt、裸 URL 丢掉', () => {
  const { text } = stripMarkdown('[链接文字](https://example.com/x) 与 ![图片说明](https://e/x.png) 以及 https://example.com/y')
  assert.ok(text.includes('链接文字'))
  assert.ok(text.includes('图片说明'))
  assert.ok(!text.includes('example.com'))
  assert.ok(!text.includes(']('))
})

test('stripMarkdown：默认去掉代码块并统计行数', () => {
  const 全 = '前面\n\n```python\nprint(1)\nprint(2)\n```\n\n后面'
  const { text, codeBlocks, codeLines } = stripMarkdown(全, { skipCodeBlocks: true })
  assert.equal(codeBlocks, 1)
  assert.equal(codeLines, 2)
  assert.ok(!text.includes('print(1)'))
  assert.ok(text.includes('前面'))
  assert.ok(text.includes('后面'))
})

test('stripMarkdown：关掉去代码块时念「代码块，共 N 行」而不是代码内容', () => {
  const { text, codeBlocks } = stripMarkdown('前\n```\na\nb\nc\n```\n后', { skipCodeBlocks: false })
  assert.equal(codeBlocks, 1)
  assert.ok(text.includes('代码块，共 3 行'), text)
  assert.ok(!text.includes('\na\n'))
})

test('stripMarkdown：剥掉 [QQ] 标记但保留块内文字；HTML 实体还原', () => {
  const { text } = stripMarkdown('[QQ]主人，晚安。[/QQ]\n<strong>粗</strong> &amp; &lt;x&gt;')
  assert.ok(!text.includes('[QQ]'))
  assert.ok(!text.includes('[/QQ]'))
  assert.ok(text.includes('主人，晚安。'))
  assert.ok(text.includes('粗'))
  assert.ok(text.includes('& <x>'), text)
  assert.ok(!text.includes('<strong>'))
})

test('stripMarkdown：空输入安全返回空串', () => {
  assert.deepEqual(stripMarkdown(''), { text: '', codeBlocks: 0, codeLines: 0 })
  assert.deepEqual(stripMarkdown(null), { text: '', codeBlocks: 0, codeLines: 0 })
})

test('splitForSpeech：短文本一段，空文本零段', () => {
  assert.deepEqual(splitForSpeech('你好呀。'), { chunks: ['你好呀。'], truncated: false })
  assert.deepEqual(splitForSpeech('   '), { chunks: [], truncated: false })
})

test('splitForSpeech：单段超长按句末标点切分，且不超过 maxChars', () => {
  const 句 = '这是一个用来测试分段的句子，需要足够长一点才能看出效果。'
  const 文本 = 句.repeat(10) // 约 270 字
  const { chunks, truncated } = splitForSpeech(文本, 200)
  assert.equal(truncated, false)
  assert.ok(chunks.length >= 2)
  for (const 块 of chunks) assert.ok(块.length <= 200, `片段超长：${块.length}`)
  assert.equal(chunks.join(''), 文本)
})

test('splitForSpeech：没有标点的超长句按字数硬切', () => {
  const 文本 = '啊'.repeat(500)
  const { chunks } = splitForSpeech(文本, 200)
  assert.equal(chunks.length, 3)
  for (const 块 of chunks) assert.ok(块.length <= 200)
  assert.equal(chunks.join(''), 文本)
})

test('splitForSpeech：过短的相邻段会合并，减少 TTS 次数', () => {
  const { chunks } = splitForSpeech('第一段。\n\n第二段。\n\n第三段。', 200)
  assert.equal(chunks.length, 1)
  assert.ok(chunks[0].includes('第一段'))
  assert.ok(chunks[0].includes('第三段'))
})

test('splitForSpeech：maxChars 会被钳到 200~5000', () => {
  const 文本 = '字'.repeat(3000)
  const 小 = splitForSpeech(文本, 1)
  for (const 块 of 小.chunks) assert.ok(块.length <= 200)
  const 大 = splitForSpeech(文本, 999999)
  assert.equal(大.chunks.length, 1)
  assert.ok(大.chunks[0].length <= 最大分段字数)
})

test('splitForSpeech：总字数超过 2 万会截断并标记 truncated', () => {
  const 文本 = '啊'.repeat(25000)
  const { chunks, truncated } = splitForSpeech(文本, 默认最大字数)
  assert.equal(truncated, true)
  assert.equal(chunks.length, 10)
  for (const 块 of chunks) assert.ok(块.length <= 默认最大字数)
  assert.equal(chunks.join('').length, 20000)

  // 小分段时：2 万字切成 100 段，最终只保留前 40 段。
  const 小 = splitForSpeech(文本, 200)
  assert.equal(小.truncated, true)
  assert.equal(小.chunks.length, 最多段数)
})

test('prepareSpeech：清洗 + 分段 + 统计代码块', () => {
  const r = prepareSpeech(样例, { maxChars: 200 })
  assert.ok(r.chunks.length >= 1)
  assert.ok(r.chars > 0)
  assert.equal(r.codeBlocks, 1)
  assert.equal(r.codeLines, 2)
  assert.equal(r.truncated, false)
  assert.ok(!r.text.includes('const a = 1'))
  assert.ok(r.text.includes('主人，测试一下。'))
  for (const 块 of r.chunks) assert.ok(块.length <= 200)
})

test('prepareSpeech：只有代码块时没有可朗读内容', () => {
  const r = prepareSpeech('```\ncode\n```')
  assert.equal(r.chunks.length, 0)
  assert.equal(r.codeBlocks, 1)
})
