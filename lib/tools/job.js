// fish_job：查询 / 取消 / 等待 / 列最近任务。不提交新任务。
import { makeTool, outputSchema, requireEnum, requireInt, requireString, safe } from './shared.js'
import { makeError } from '../errors.js'

const 动作 = ['status', 'cancel', 'list', 'wait']
const 种类 = ['tts', 'asr', 'separate', 'translate', 'download', 'analyze', 'vision']
const 状态 = ['queued', 'running', 'done', 'failed', 'canceled']

export function makeJobTool({ api, logger }) {
  return makeTool({
    name: 'fish_job',
    description: '查询/取消/等待本地服务任务，或列最近任务。长任务（下载、视觉、批量翻译）先用对应工具提交再轮询；本工具只做查询与控制，不提交新任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: 动作, description: 'status / cancel / list / wait。' },
        jobId: { type: 'string', description: 'action=status/cancel/wait 时必填。' },
        kind: { type: 'string', enum: 种类, description: 'list 时按任务类型过滤。' },
        state: { type: 'string', enum: 状态, description: 'list 时按状态过滤。' },
        limit: { type: 'integer', description: 'list 返回条数 1~100，默认 20。' },
        timeoutMs: { type: 'integer', description: 'wait 的总超时，1000~1800000，默认 600000。' },
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
        throw makeError('bad_request', { detail: '缺少 action', hint: '参数不对：要传 action（status/cancel/list/wait）。' })
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
