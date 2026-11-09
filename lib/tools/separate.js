// fish_separate：人声分离（Demucs），stems 复制到 cacheDir。
import { makeTool, outputSchema, requireEnum, requireString, safe } from './shared.js'
import { makeError } from '../errors.js'

const 模型 = ['htdemucs', 'htdemucs_6s', 'htdemucs_ft']
const 音轨 = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']

export function makeSeparateTool({ api, logger }) {
  return makeTool({
    name: 'fish_separate',
    description: '用人声分离模型把音频/视频拆成 stems（默认 vocals/drums/bass/other），产物复制到 DSH 缓存并返回本机路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '本机绝对路径；音频或视频，≤200MB。' },
        model: { type: 'string', enum: 模型, description: '模型；htdemucs_ft 需要额外权重。' },
        stems: {
          type: 'array',
          items: { type: 'string', enum: 音轨 },
          description: '要输出的 stem；默认 vocals/drums/bass/other。',
        },
      },
      required: ['file'],
    },
    output: outputSchema({
      stems: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      dir: { type: 'string' },
      ms: { type: 'number' },
      released: { type: 'array', items: { type: 'string' } },
    }),
    execute: safe(async (args) => {
      const file = requireString(args.file, { field: 'file', max: 4096 })
      const model = requireEnum(args.model, { field: 'model', allowed: 模型, fallback: 'htdemucs' })
      let stems
      if (args.stems !== undefined) {
        if (!Array.isArray(args.stems) || args.stems.length === 0) {
          throw makeError('bad_request', { detail: 'stems 不是非空数组', hint: '参数不对：stems 必须是非空数组。' })
        }
        for (const 音轨名 of args.stems) {
          if (!音轨.includes(音轨名)) {
            throw makeError('bad_request', { detail: `未知 stem ${音轨名}`, hint: `参数不对：stem 只能是 ${音轨.join(' / ')}。` })
          }
        }
        stems = args.stems.slice()
      }
      return api.separate(file, { model, ...(stems ? { stems } : {}) })
    }, { api, logger, name: 'fish_separate' }),
  })
}
