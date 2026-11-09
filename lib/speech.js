// 朗读用的文本预处理与分段（P2）。
//
// 为什么放在宿主：浏览器里只管播放，Markdown / 代码块 / [QQ] 标记的清洗规则
// 只有一份，且能离线单测。客户端把「消息原文」发过来，宿主返回干净的分段。
//
// 清洗规则（README / docs/P2.md 有同一份说明）：
//   - 代码围栏整体处理：默认删掉；`skipCodeBlocks=false` 时换成「代码块，共 N 行」（不读代码）；
//   - 行内代码去掉反引号，保留内容；
//   - Markdown 链接只读文字（`[文字](url)` → `文字`），裸 URL 丢掉；
//   - 图片 `![alt](url)` 只读 alt；
//   - 标题 / 引用 / 列表 / 表格 / 分割线 / HTML 标签 / 加粗斜体删除线标记全部剥掉；
//   - `[QQ]` / `[/QQ]` 只是 DSH 出站标记，朗读时剥掉，块内文字保留。
//
// 分段规则（2026-11 调整）：以「换行」和「句末标点（。！？!?；;…）」为边界切段；
// 不足 10 字的碎片不单独成段（并到下一段，末尾的并到上一段）；
// 只有单句超过 maxChars 时才按字数硬切（优先在逗号/顿号/空格处断）。
// 最多 40 段、最多 20000 字（超出截断并标记）。

export const 默认最大字数 = 2000
export const 最小分段字数 = 200
export const 最大分段字数 = 5000
export const 最短短语 = 10
export const 最多段数 = 40
export const 最多总字数 = 20000

const 句末 = /[。！？!?；;…]/

/** 把 Markdown 文本变成「适合念出来」的纯文本。 */
export function stripMarkdown(input, { skipCodeBlocks = true } = {}) {
  let 文本 = String(input == null ? '' : input)
  let 代码块数 = 0
  let 代码行数 = 0

  // 统一换行；把行内 <br> 变成空格，避免整行黏在一起。
  文本 = 文本.replace(/\r\n?/g, '\n').replace(/<br\s*\/?>/gi, ' ')

  // HTML 注释整体删。
  文本 = 文本.replace(/<!--[\s\S]*?-->/g, '')

  // 代码围栏：成对的、以及未闭合到文末的都算一块。
  文本 = 文本.replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_全, 内容) => {
    代码块数 += 1
    const 行 = String(内容 || '').split('\n').filter((x) => x.trim() !== '').length
    代码行数 += 行
    if (skipCodeBlocks) return '\n'
    return `\n（代码块，共 ${行} 行）\n`
  })
  // 四个空格缩进的代码块（没有围栏）也按代码处理。
  文本 = 文本.replace(/^(?: {4}|\t).+$/gm, '')

  // 表格：单元格用「，」连起来，分隔行（|---|）丢掉。
  文本 = 文本.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/gm, '')
  文本 = 文本.replace(/^\s*\|(.+)\|\s*$/gm, (_全, 行) => {
    const 格 = String(行).split('|').map((x) => x.trim()).filter(Boolean)
    return 格.length ? `${格.join('，')}\n` : ''
  })

  // 分割线。
  文本 = 文本.replace(/^\s*(?:[-*_])(?:\s*[-*_]){2,}\s*$/gm, '')

  // 标题 / 引用 / 列表符号。
  文本 = 文本.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  文本 = 文本.replace(/^\s{0,3}>\s?/gm, '')
  文本 = 文本.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/gm, '')
  // 任务列表的勾选框。
  文本 = 文本.replace(/^\s*\[[ xX]\]\s*/gm, '')

  // 图片 → alt；链接 → 文字。
  文本 = 文本.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  文本 = 文本.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  文本 = 文本.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
  // 引用式链接的定义行（[1]: https://…）。
  文本 = 文本.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, '')

  // 裸 URL 与尖括号自动链接：朗读没有意义，丢掉。
  文本 = 文本.replace(/<https?:\/\/[^>]*>/gi, '')
  文本 = 文本.replace(/https?:\/\/[^\s<>()（）"']+/gi, '')

  // 行内代码：去掉反引号，保留内容。
  文本 = 文本.replace(/`([^`\n]+)`/g, '$1')

  // HTML 标签。
  文本 = 文本.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, '')

  // 加粗 / 斜体 / 删除线。
  文本 = 文本.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  文本 = 文本.replace(/__([^_\n]+)__/g, '$1')
  文本 = 文本.replace(/~~([^~\n]+)~~/g, '$1')
  // 单个 * 当斜体标记；中文里标记两侧常常直接贴字，所以不要求空白边界。
  文本 = 文本.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  文本 = 文本.replace(/(^|[\s（(【「])_([^_\n]+)_(?=$|[\s）)】」。，,！!？?；;：:])/g, '$1$2')

  // [QQ]…[/QQ] 标记剥掉，块内文字保留。
  文本 = 文本.replace(/\[\/?qq\]/gi, '')

  // 常见 HTML 实体。
  文本 = 文本
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")

  // 收尾：压空白、去空行。
  文本 = 文本
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return { text: 文本, codeBlocks: 代码块数, codeLines: 代码行数 }
}

/** 把一段（已清洗的）文本切成不超过 maxChars 的片段。
 *
 * 分段语义（与 docs/TTS_CACHE.md 保持一致）：
 *   1. 先按「换行」与「句末标点（。！？!?；;…）」切出基础片段，标点跟着前一句；
 *   2. 不足 `最短短语` 个字的片段不单独成段——优先并到下一片，末尾的并到上一片；
 *   3. 再按 maxChars 打包：能装下就合并，装不下就断开；
 *   4. 单句超长时按字数硬切，尽量在逗号/顿号/空格处断开；
 *   5. 最多 40 段、最多 20000 字（超出截断并标记）。
 */
export function splitForSpeech(input, maxChars = 默认最大字数) {
  const 上限 = Math.max(最小分段字数, Math.min(最大分段字数, Math.trunc(Number(maxChars) || 默认最大字数)))
  const 原文 = String(input == null ? '' : input).replace(/\r\n?/g, '\n').trim()
  if (!原文) return { chunks: [], truncated: false }

  let 文本 = 原文
  let 截断 = false
  if (文本.length > 最多总字数) {
    文本 = 文本.slice(0, 最多总字数)
    // 尽量退到句末，别把一句话砍一半。
    const 退 = Math.max(文本.lastIndexOf('。'), 文本.lastIndexOf('！'), 文本.lastIndexOf('？'), 文本.lastIndexOf('\n'))
    if (退 > 最多总字数 * 0.8) 文本 = 文本.slice(0, 退 + 1)
    截断 = true
  }

  // 1) 基础片段：换行与句末标点都是边界。
  const 原始片 = []
  for (const 行 of 文本.split(/\n+/)) {
    const 段 = 行.trim()
    if (!段) continue
    let 起点 = 0
    for (let i = 0; i < 段.length; i++) {
      if (句末.test(段[i])) {
        const 片 = 段.slice(起点, i + 1).trim()
        if (片) 原始片.push(片)
        起点 = i + 1
      }
    }
    if (起点 < 段.length) {
      const 尾 = 段.slice(起点).trim()
      if (尾) 原始片.push(尾)
    }
  }
  if (!原始片.length) return { chunks: [], truncated: 截断 }

  // 2) 太短的片段不单独成段：不足 最短短语 的并到下一片（末尾的并到上一片）。
  const 片 = []
  let i = 0
  while (i < 原始片.length) {
    let 当前 = 原始片[i]
    i += 1
    while (当前.length < 最短短语 && i < 原始片.length) {
      当前 += 原始片[i]
      i += 1
    }
    片.push(当前)
  }
  if (片.length >= 2 && 片[片.length - 1].length < 最短短语) {
    const 末 = 片.pop()
    片[片.length - 1] = 片[片.length - 1] + 末
  }

  // 3) 句/换行级片段直接成段（不再为了压字数把多句黏成 2000 字长段）；
  //    4) 只有单片超过 maxChars 时才按字数硬切，并尽量在逗号/顿号/空格处断开。
  const 片段 = []
  for (const 块 of 片) {
    if (块.length <= 上限) {
      片段.push(块)
      continue
    }
    let 余 = 块
    while (余.length > 上限) {
      let 切点 = 上限
      const 逗 = Math.max(
        余.lastIndexOf('，', 上限),
        余.lastIndexOf(',', 上限),
        余.lastIndexOf('、', 上限),
        余.lastIndexOf(' ', 上限),
      )
      if (逗 > 上限 * 0.6) 切点 = 逗 + 1
      片段.push(余.slice(0, 切点).trim())
      余 = 余.slice(切点)
    }
    if (余.trim()) 片段.push(余.trim())
  }

  // 5) 收尾：除最后一段外，任何片段都不短于 最短短语（打包边界可能产生短尾）。
  const 合并 = []
  for (const 块 of 片段.filter(Boolean)) {
    const 上 = 合并[合并.length - 1]
    if (上 !== undefined && 上.length < 最短短语 && (上.length + 块.length) <= 上限) {
      合并[合并.length - 1] = 上 + 块
    } else {
      合并.push(块)
    }
  }
  if (合并.length >= 2 && 合并[合并.length - 1].length < 最短短语) {
    const 末 = 合并.pop()
    合并[合并.length - 1] = 合并[合并.length - 1] + 末
  }

  const 出 = 合并.filter((x) => x.trim() !== '')
  if (出.length > 最多段数) {
    return { chunks: 出.slice(0, 最多段数), truncated: true }
  }
  return { chunks: 出, truncated: 截断 }
}

/**
 * 预处理 + 分段，一步到位。
 * @returns {{text:string, chunks:string[], chars:number, codeBlocks:number, codeLines:number, truncated:boolean}}
 */
export function prepareSpeech(input, { maxChars = 默认最大字数, skipCodeBlocks = true } = {}) {
  const 清洗 = stripMarkdown(input, { skipCodeBlocks })
  const 分段 = splitForSpeech(清洗.text, maxChars)
  return {
    text: 清洗.text,
    chunks: 分段.chunks,
    chars: 清洗.text.length,
    codeBlocks: 清洗.codeBlocks,
    codeLines: 清洗.codeLines,
    truncated: 分段.truncated,
  }
}
