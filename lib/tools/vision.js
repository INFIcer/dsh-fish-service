// fish_vision_frames：视频关键帧 + 摘要（Qwen2.5-VL）。
import { makeTool, outputSchema, requireEnum, requireInt, requireString, safe } from './shared.js'

const 努力 = ['auto', 'low', 'medium', 'high']
const 规划 = ['hybrid', 'agent']
const 字幕 = ['auto', 'off']

export function makeVisionTool({ api, logger }) {
  return makeTool({
    name: 'fish_vision_frames',
    description: '从本机视频里挑 1~10 张关键帧并给出摘要（Qwen2.5-VL）。返回帧的本机路径、时间点与摘要；不返回 base64。长视频可能较慢，默认超时 600 秒。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoPath: { type: 'string', description: '本机视频绝对路径。' },
        targetFrames: { type: 'integer', description: '要几张关键帧（1~10），默认 3。' },
        effort: { type: 'string', enum: 努力, description: '预算档位，默认 auto。' },
        planner: { type: 'string', enum: 规划, description: '规划器，默认 hybrid。' },
        subtitles: { type: 'string', enum: 字幕, description: '是否用软字幕辅助选帧，默认 auto。' },
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
