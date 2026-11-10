// fish_job：查询 / 取消 / 等待 / 列最近任务。不提交新任务。
import { makeTool, outputSchema, requireEnum, requireInt, requireString, safe } from './shared.js'
import { makeError } from '../errors.js'

const 动作 = ['status', 'cancel', 'list', 'wait']
const 种类 = ['tts', 'asr', 'separate', 'translate', 'download', 'analyze', 'vision']
const 状态 = ['queued', 'running', 'done', 'failed', 'canceled']

export function makeJobTool({ api, logger }) {
  return makeTool({
    name: 'fish_job',
    description: '查询、取消或等待本机任务，也可列出最近的任务。长任务请先用对应工具提交，再用本工具查看进度；本工具不提交新任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: 动作, description: '操作类型：status 查询、cancel 取消、list 列表、wait 等待。' },
        jobId: { type: 'string', description: '查询、取消或等待任务时必填。' },
        kind: { type: 'string', enum: 种类, description: '列表时按任务类型筛选。' },
        state: { type: 'string', enum: 状态, description: '列表时按状态筛选。' },
        limit: { type: 'integer', description: '列表返回条数（1~100），默认 20。' },
        timeoutMs: { type: 'integer', description: '等待的最长时间（毫秒），默认 600000（10 分钟）。' },
      },
      required: ['action'],
    },
    output: outputSchema({
      id: { type: 'string' },
      kind: { type: 'string' },
      state: { type: 'string' },
      jobs: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
      total: { type: 'number' },
      result: { type: 'object', additionalProperties: true, properties: {} },
    }),
    execute: safe(async (args) => {
      const action = requireEnum(args.action, { field: 'action', allowed: 动作 })
      if (!action) {
        throw makeError('bad_request', { detail: '缺少 action', hint: '请求参数有误：请指定操作类型（status / cancel / list / wait）。' })
      }

      if (action === 'list') {
        return api.jobs.list({
          ...(args.kind ? { kind: requireEnum(args.kind, { field: 'kind', allowed: 种类 }) } : {}),
          ...(args.state ? { state: requireEnum(args.state, { field: 'state', allowed: 状态 }) } : {}),
          limit: requireInt(args.limit, { field: 'limit', min: 1, max: 100, fallback: 20 }),
        })
      }

      const jobId = requireString(args.jobId, { field: 'jobId', max: 200 })
      if (action === 'status') return api.jobs.status(jobId)
      if (action === 'cancel') return api.jobs.cancel(jobId)
      return api.jobs.wait(jobId, {
        timeoutMs: requireInt(args.timeoutMs, { field: 'timeoutMs', min: 1000, max: 1800000, fallback: 600000 }),
      })
    }, { api, logger, name: 'fish_job' }),
  })
}
