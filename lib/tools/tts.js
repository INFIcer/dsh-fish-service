// fish_tts：文本 → 语音（可批量），产物落 cacheDir，只返回路径与指标。
import { requireInt, requireTexts, makeTool, outputSchema, safe } from './shared.js'
import { makeError } from '../errors.js'

const 语言 = ['auto', 'zh', 'en', 'ja', 'es', 'ar']

export function makeTtsTool({ api, logger }) {
  return makeTool({
    name: 'fish_tts',
    description: '把文字转换为语音，可一次合成多条。返回音频文件路径与耗时。首次合成需要加载模型，可能较慢。一次最多 20 条，每条不超过 5000 字。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: '要合成的文本（1~20 条）；单条也传数组。每条不超过 5000 字。',
        },
        voice: { type: 'string', description: '音色名；不填则使用设置里的默认音色。' },
        speed: { type: 'number', description: '语速 0.5~2.0，默认 1.0。' },
        language: { type: 'string', enum: 语言, default: 'auto', description: '语言；auto 表示自动判断。' },
        seed: { type: 'integer', description: '0~4294967295；不传=随机，同一 seed 可复现。' },
      },
      required: ['texts'],
    },
    output: outputSchema({
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            wavPath: { type: 'string' },
            ms: { type: 'number' },
            voice: { type: 'string' },
            seed: { type: 'number' },
            language: { type: 'string' },
            bytes: { type: 'number' },
            cached: { type: 'boolean' },
          },
        },
      },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const texts = requireTexts(args.texts, { max: 20 })
      let speed
      if (args.speed !== undefined) {
        speed = Number(args.speed)
        if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
          throw makeError('bad_request', { detail: `speed=${args.speed}`, hint: '请求参数有误：语速须在 0.5~2.0 之间。' })
        }
      }
      const seed = requireInt(args.seed, { field: 'seed', min: 0, max: 4294967295 })
      return api.tts(texts, {
        ...(args.voice ? { voice: String(args.voice) } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(args.language ? { language: args.language } : {}),
        ...(seed !== undefined ? { seed } : {}),
      })
    }, { api, logger, name: 'fish_tts' }),
  })
}
