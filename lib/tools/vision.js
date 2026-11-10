// fish_vision_frames：视频关键帧 + 摘要（Qwen2.5-VL）。
import { makeTool, outputSchema, requireEnum, requireInt, requireString, safe } from './shared.js'

const 努力 = ['auto', 'low', 'medium', 'high']
const 规划 = ['hybrid', 'agent']
const 字幕 = ['auto', 'off']

export function makeVisionTool({ api, logger }) {
  return makeTool({
    name: 'fish_vision_frames',
    description: '从本机视频中选取 1~10 张关键帧并生成摘要。返回关键帧文件路径、时间点与摘要。长视频处理较慢，请耐心等待。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoPath: { type: 'string', description: '本机视频绝对路径。' },
        targetFrames: { type: 'integer', description: '要几张关键帧（1~10），默认 3。' },
        effort: { type: 'string', enum: 努力, description: '分析力度，默认 auto（自动选择）；越高越细致，耗时也越长。' },
        planner: { type: 'string', enum: 规划, description: '选帧方式，默认 hybrid（自动平衡）；agent 表示按画面内容主动挑选。' },
        subtitles: { type: 'string', enum: 字幕, description: '是否参考字幕辅助选帧，默认 auto。' },
      },
      required: ['videoPath'],
    },
    output: outputSchema({
      frames: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            time: { type: 'number' },
            path: { type: 'string' },
            score: { type: 'number' },
            kind: { type: 'string' },
            ocrText: { type: 'string' },
            summary: { type: 'string' },
            why: { type: 'string' },
            confidence: { type: 'string' },
          },
        },
      },
      duration: { type: 'number' },
      subtitlesFrom: { type: 'string' },
      stats: { type: 'object', additionalProperties: true, properties: {} },
      ms: { type: 'number' },
    }),
    execute: safe(async (args) => {
      const videoPath = requireString(args.videoPath, { field: 'videoPath', max: 4096 })
      const targetFrames = requireInt(args.targetFrames, { field: 'targetFrames', min: 1, max: 10, fallback: 3 })
      const effort = requireEnum(args.effort, { field: 'effort', allowed: 努力, fallback: 'auto' })
      const planner = requireEnum(args.planner, { field: 'planner', allowed: 规划, fallback: 'hybrid' })
      const subtitles = requireEnum(args.subtitles, { field: 'subtitles', allowed: 字幕, fallback: 'auto' })
      return api.visionFrames({ videoPath }, { targetFrames, effort, planner, subtitles })
    }, { api, logger, name: 'fish_vision_frames' }),
  })
}
