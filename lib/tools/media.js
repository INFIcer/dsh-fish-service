// fish_media_probe：只调 /media/probe，不触发转码。
import { makeTool, outputSchema, requireFiles, safe } from './shared.js'

export function makeMediaProbeTool({ api, logger }) {
  return makeTool({
    name: 'fish_media_probe',
    description: '用 ffprobe 探测 1~10 个本机媒体文件的时长、容器、音视频参数；只读，不转码、不抽帧。单文件 ≤200MB。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '本机绝对路径（1~10 个），单文件 ≤200MB。',
        },
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
            duration: { type: 'number' },
            format: { type: 'string' },
            audio: { type: 'object', additionalProperties: true, properties: {} },
            video: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
      },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const files = requireFiles(args.files, { max: 10 })
      return api.mediaProbe(files)
    }, { api, logger, name: 'fish_media_probe' }),
  })
}
