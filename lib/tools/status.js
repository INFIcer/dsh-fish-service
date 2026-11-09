// fish_service_status：永远可调的只读诊断工具。
// 服务不可达时仍然返回 baseUrl / 最近错误 / 手动启动提示，方便 Agent 解释“为什么不能用”。
import { makeTool, outputSchema, safe } from './shared.js'

const 能力中文 = {
  tts: 'TTS',
  asr: 'ASR',
  translate: '翻译',
  separate: '分离',
  vision: '视觉',
  media: '媒体',
  download: '下载',
  jobs: '任务',
}

function 能力摘要(caps) {
  const 出 = {}
  for (const [名, 信息] of Object.entries(caps || {})) {
    出[名] = {
      available: Boolean(信息?.available),
      ready: Boolean(信息?.ready),
      loaded: Boolean(信息?.loaded),
      ...(信息?.model ? { model: 信息.model } : {}),
      ...(信息?.reason ? { reason: 信息.reason } : {}),
      ...(信息?.estimateMb != null ? { estimateMb: 信息.estimateMb } : {}),
      title: 能力中文[名] || 名,
    }
  }
  return 出
}

export function makeStatusTool({ api, logger }) {
  return makeTool({
    name: 'fish_service_status',
    description: '查看本地 AI 服务状态：地址、版本、延迟、显存、各能力是否可用（含原因）、音色、安装状态与最近错误。服务没启动时也能调，会返回诊断和手动启动提示。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: outputSchema({
      baseUrl: { type: 'string' },
      version: { type: 'string' },
      apiVersion: { type: 'string' },
      latencyMs: { type: 'number' },
      vram: { type: 'object', additionalProperties: true, properties: {} },
      capabilities: { type: 'object', additionalProperties: true, properties: {} },
      voices: { type: 'array', items: { type: 'string' } },
      install: { type: 'object', additionalProperties: true, properties: {} },
      autostart: { type: 'object', additionalProperties: true, properties: {} },
      lastError: { type: 'object', additionalProperties: true, properties: {} },
    }),
    execute: safe(async () => {
      const 健康 = await api.health({ timeoutMs: 3000 })
      let caps = 健康.capabilities
      if (!caps) {
        try { caps = api.capabilities || {} } catch { caps = {} }
      }
      let 音色 = []
      try {
        音色 = (await api.voices()).map((x) => x.name).filter(Boolean)
      } catch { /* 服务没起时拿不到音色，不影响诊断 */ }

      let install = { ok: false, code: 'not_implemented', hint: '安装管理还没实现（P3）。' }
      try { install = await api.install.status() } catch { /* 保持占位 */ }

      const 失败 = !健康.ok
      // lastError 在 output schema 里必须是对象：服务端偶尔回字符串/null，这里统一归一化。
      const 原始错 = 健康.lastError ?? api.lastError ?? null
      const 错 =
        原始错 && typeof 原始错 === 'object'
          ? 原始错
          : 原始错
            ? { code: 'unknown', detail: String(原始错) }
            : {}
      return {
        ok: 健康.ok,
        baseUrl: 健康.baseUrl || api.config.get().baseUrl,
        version: 健康.serviceVersion || '',
        apiVersion: 健康.apiVersion || '',
        latencyMs: 健康.latencyMs || 0,
        ...(健康.vram ? { vram: 健康.vram } : {}),
        capabilities: 能力摘要(caps),
        voices: 音色,
        install,
        autostart: {
          supported: false,
          enabled: false,
          name: 'LocalAIService-Service',
          note: 'P1 不主动探测计划任务；P3 安装器接管。',
        },
        lastError: 错,
        ...(失败
          ? {
              code: 错?.code || 'service_down',
              hint: 错?.hint || '本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。',
            }
          : {}),
      }
    }, { api, logger, name: 'fish_service_status' }),
  })
}
