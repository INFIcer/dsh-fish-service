// fish_translate：批量翻译（NLLB），返回顺序与输入严格一致。
import { makeTool, outputSchema, requireString, requireTexts, safe } from './shared.js'
import { makeError } from '../errors.js'

const 最大总字数 = 200000

export function makeTranslateTool({ api, logger }) {
  return makeTool({
    name: 'fish_translate',
    description: '用本地 NLLB-200 批量翻译（1~200 条，每条 ≤5000 字、总 ≤20 万字），返回顺序与输入严格一致。source=auto 只覆盖常见语种；超短文本建议显式给 source。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: '要翻译的文本（1~200 条，每条 ≤5000 字，总 ≤200000 字）。',
        },
        source: { type: 'string', description: '源语言：auto / zh / en / NLLB 码；默认 auto。' },
        target: { type: 'string', description: '目标语言（必填，不能是 auto）：zh / en / ja / NLLB 码。' },
      },
      required: ['texts', 'target'],
    },
    output: outputSchema({
      texts: { type: 'array', items: { type: 'string' } },
      source: { type: 'string' },
      target: { type: 'string' },
      engine: { type: 'string' },
      ms: { type: 'number' },
      chunks: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const texts = requireTexts(args.texts, { max: 200 })
      const total = texts.reduce((和, x) => 和 + x.length, 0)
      if (total > 最大总字数) {
        throw makeError('bad_request', {
          detail: `总字数 ${total} 超过 ${最大总字数}`,
          hint: '参数不对：一次最多 20 万字，请拆批或用 fish_job。',
        })
      }
      const target = requireString(args.target, { field: 'target', max: 64 })
      if (target === 'auto') {
        throw makeError('bad_request', { detail: 'target=auto', hint: '参数不对：target 不能是 auto。' })
      }
      const source = args.source ? String(args.source) : 'auto'
      return api.translate(texts, { source, target })
    }, { api, logger, name: 'fish_translate' }),
  })
}
