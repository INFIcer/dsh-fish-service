// fish_asr：音频/视频 → 文字（可批量），默认 SenseVoice + 声纹。
import { makeTool, outputSchema, requireBool, requireEnum, requireFiles, safe } from './shared.js'

const 语言 = ['auto', 'zh', 'en', 'ja', 'ko', 'yue', 'nospeech']
const 引擎 = ['auto', 'sensevoice', 'whisper']

export function makeAsrTool({ api, logger }) {
  return makeTool({
    name: 'fish_asr',
    description: '把本机的音频或视频转写为文字，可一次处理多个文件。默认同时识别人声特征；需要时间轴时返回每段的时间点。一次最多 10 个文件，单文件不超过 200MB。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '本机绝对路径（1~10 个）；音频或视频，单文件不超过 200MB。',
        },
        language: { type: 'string', enum: 语言, default: 'auto', description: '语言；auto 表示自动判断。' },
        engine: { type: 'string', enum: 引擎, default: 'auto', description: '识别引擎；一般保持 auto 即可。' },
        speaker: { type: 'boolean', default: true, description: '是否识别人声特征；关闭可减少等待时间。' },
        timestamps: { type: 'boolean', default: false, description: '是否返回每段的时间点（开启后固定使用 whisper 引擎）。' },
      },
      required: ['files'],
    },
    output: outputSchema({
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            file: { type: 'string' },
            text: { type: 'string' },
            language: { type: 'string' },
            engine: { type: 'string' },
            durationMs: { type: 'number' },
            elapsedMs: { type: 'number' },
            speaker: { type: 'object', additionalProperties: true },
            speakerError: { type: 'string' },
            segments: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  start: { type: 'number' },
                  end: { type: 'number' },
                  text: { type: 'string' },
                },
                required: ['start', 'end', 'text'],
              },
            },
            truncated: { type: 'boolean' },
          },
        },
      },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const files = requireFiles(args.files, { max: 10 })
      const language = requireEnum(args.language, { field: 'language', allowed: 语言, fallback: 'auto' })
      const engine = requireEnum(args.engine, { field: 'engine', allowed: 引擎, fallback: 'auto' })
      const speaker = requireBool(args.speaker, true)
      const timestamps = requireBool(args.timestamps, false)
      return api.asr(files, { language, engine, speaker, timestamps })
    }, { api, logger, name: 'fish_asr' }),
  })
}
