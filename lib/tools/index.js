// 8 个 Agent 工具的统一注册。
//
// 工具**始终注册**（即使服务没装/没起）：Agent 需要能诊断“为什么不能用”；
// 具体失败由 execute 返回结构化 {ok:false, code, hint}，不抛裸异常。

import { makeTtsTool } from './tts.js'
import { makeAsrTool } from './asr.js'
import { makeTranslateTool } from './translate.js'
import { makeSeparateTool } from './separate.js'
import { makeVisionTool } from './vision.js'
import { makeMediaProbeTool } from './media.js'
import { makeJobTool } from './job.js'
import { makeStatusTool } from './status.js'

export const TOOL_NAMES = Object.freeze([
  'fish_tts',
  'fish_asr',
  'fish_translate',
  'fish_separate',
  'fish_vision_frames',
  'fish_media_probe',
  'fish_job',
  'fish_service_status',
])

/** 造 8 个工具定义（不注册，方便单测）。 */
export function buildToolDefinitions({ api, logger }) {
  return [
    makeTtsTool({ api, logger }),
    makeAsrTool({ api, logger }),
    makeTranslateTool({ api, logger }),
    makeSeparateTool({ api, logger }),
    makeVisionTool({ api, logger }),
    makeMediaProbeTool({ api, logger }),
    makeJobTool({ api, logger }),
    makeStatusTool({ api, logger }),
  ]
}

/**
 * 注册到宿主；返回 disposer（调用一次摘掉全部）。
 * 宿主 API 不存在时安静跳过，插件仍可用 fish.service。
 */
export function registerTools(ctx, { api, logger }) {
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    logger?.warn('宿主没有 ctx.tools，跳过 8 个工具注册（fish.service 仍然可用）')
    return () => {}
  }
  const 摘 = []
  for (const 定义 of buildToolDefinitions({ api, logger })) {
    try {
      const disposer = ctx.tools.register(定义)
      if (typeof disposer === 'function') 摘.push(disposer)
    } catch (error) {
      logger?.error(`工具 ${定义.name} 注册失败：${error?.message || error}`)
    }
  }
  return () => {
    for (const 函数 of 摘.splice(0)) {
      try { 函数() } catch { /* 已卸载 */ }
    }
  }
}
