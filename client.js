// dsh-fish-service · 设置页（DSH Web 客户端插件）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
// 挂载方式照 dsh-fish-message：window.__ModuleLoader__.load → slots.register('settings.section')。
//
// P1 只做：状态 / 服务地址 / 超时 / 默认音色 / 缓存 / 能力列表 / 测试连接 / 日志。
// 不做：一键安装、内嵌 WebUI、朗读按钮、语音输入（P2/P3）。

window.__ModuleLoader__.load({
  id: 'dsh-fish-service',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const inject = ['slots']
    const h = React.createElement
    const B = '/dsh-fish-service'

    const get = (path) => fetch(B + path, { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => null)
    const post = (path, body) => fetch(B + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()).catch((error) => ({ ok: false, code: 'upstream_error', hint: String(error?.message || error) }))

    const S = {
      wrap: {
        padding: '12px 14px 28px',
        fontSize: 13,
        lineHeight: 1.7,
        background: 'var(--dsw-alias-bg-layer-1, rgba(255,255,255,.94))',
        border: '1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08))',
        borderRadius: 12,
      },
      h1: { fontSize: 17, fontWeight: 700, margin: '0 0 4px' },
      h: { fontSize: 15, fontWeight: 650, margin: '16px 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      row: { display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8, flexWrap: 'wrap' },
      lab: { minWidth: 150, paddingTop: 3, fontSize: 12.5 },
      ctl: { flex: '1 1 260px', minWidth: 200 },
      hint: { opacity: 0.58, fontSize: 11.5, marginTop: 2 },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: '100%',
        boxSizing: 'border-box',
      },
      small: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 8px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12.5,
        width: 160,
        boxSizing: 'border-box',
      },
      btn: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      btnOn: {
        border: '1px solid var(--dsw-alias-state-business-primary)',
        borderRadius: 6,
        padding: '4px 12px',
        background: 'var(--dsw-alias-state-business-primary)',
        color: '#fff',
        fontSize: 12,
        cursor: 'pointer',
      },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 20,
        fontSize: 11.5,
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      ok: { color: 'var(--dsw-alias-state-business-primary)', fontSize: 12 },
      danger: { color: '#c0392b', fontSize: 12 },
      chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        padding: '5px 9px',
        fontSize: 12,
        minWidth: 120,
      },
      logs: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 11.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        maxHeight: 300,
        overflow: 'auto',
        background: 'rgba(0,0,0,.06)',
        borderRadius: 6,
        padding: 8,
      },
    }

    const 能力中文 = {
      tts: 'TTS 语音合成',
      asr: 'ASR 语音识别',
      translate: '翻译',
      separate: '人声分离',
      vision: '视觉关键帧',
      media: '媒体探测',
      download: '下载',
      jobs: '任务队列',
    }
    const 原因中文 = {
      service_down: '服务未启动',
      model_missing: '模型未下载',
      not_supported: '服务不支持',
      api_incompatible: '契约版本不匹配',
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)
    const 行 = (标签, 控件, 说明) => h('div', { style: S.row },
      h('div', { style: S.lab }, 标签),
      h('div', { style: S.ctl }, 控件, 说明 ? 提示(说明) : null))

    function 输入(值, onChange, 占位 = '', 类型 = 'text') {
      return h('input', {
        style: S.input,
        type: 类型,
        value: 值 == null ? '' : String(值),
        placeholder: 占位,
        onChange: (e) => onChange(e.target.value),
      })
    }

    function 下拉(值, 选项, onChange) {
      return h('select', {
        style: S.small,
        value: 值 == null ? '' : String(值),
        onChange: (e) => onChange(e.target.value),
      }, 选项.map((项) => h('option', { key: 项.value, value: 项.value }, 项.label)))
    }

    function 状态点(ok, 文本) {
      return h('span', { style: { ...S.badge, ...(ok ? S.ok : S.danger) } }, 文本)
    }

    function Section() {
      const [态, 设态] = React.useState(null)
      const [脏, 设脏] = React.useState(false)
      const [忙, 设忙] = React.useState(false)
      const [说, 设说] = React.useState('')
      const [日志, 设日志] = React.useState(null)

      const 拉 = async () => {
        const s = await get('/state')
        if (s && s.ok) 设态(s)
      }
      React.useEffect(() => { 拉() }, [])
      React.useEffect(() => {
        if (脏) return undefined
        const t = setInterval(拉, 5000)
        return () => clearInterval(t)
      }, [脏])

      const 配置 = (态 && 态.config) || {}
      const 健康 = (态 && 态.health) || {}
      const 缓存 = (态 && 态.cache) || {}
      const 能力表 = (态 && 态.capabilities) || {}
      const 音色们 = Array.isArray(态 && 态.voices) ? 态.voices : []
      const 在线 = Boolean(健康.reachable)
      const 兼容 = 健康.compatible !== false

      const 改 = (键, 值) => {
        设态((旧) => (旧 ? { ...旧, config: { ...(旧.config || {}), [键]: 值 } } : 旧))
        设脏(true)
      }

      const 存 = async () => {
        设忙(true); 设说('保存中…')
        const r = await post('/save', { config: 配置 })
        设忙(false)
        if (r && r.ok) {
          设脏(false)
          设说((r.warnings && r.warnings.length) ? `已保存（${r.warnings.join('；')}）` : '已保存。')
          await 拉()
        } else {
          设说('保存失败：' + String((r && (r.hint || r.message)) || '未知错误'))
        }
      }

      const 测试 = async () => {
        设忙(true); 设说('正在连接本地 AI 服务…')
        const r = await post('/test', { timeoutMs: 4000 })
        设忙(false)
        if (r && r.ok) 设说(`连接正常：服务 v${r.serviceVersion || '?'}，api ${r.apiVersion || '?'}，延迟 ${r.latencyMs}ms。`)
        else 设说(`连接失败：${(r && r.hint) || '服务没连上。'}`)
        await 拉()
      }

      const 看日志 = async () => {
        设忙(true)
        const r = await get('/logs?lines=200')
        设忙(false)
        设日志(r && r.ok ? r.lines : null)
      }

      if (!态) {
        return h('div', { style: S.wrap },
          h('div', { style: S.h1 }, '本地 AI'),
          h('div', { style: S.dim }, '正在读取状态…'))
      }

      const 能力块 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '能力'),
        h('div', { style: S.chips }, Object.keys(能力中文).map((名) => {
          const 信息 = 能力表[名] || {}
          const 可用 = Boolean(信息.available)
          const 原因 = 信息.reason ? (原因中文[信息.reason] || 信息.reason) : ''
          return h('div', { key: 名, style: S.chip },
            h('div', { style: { fontWeight: 600 } }, 能力中文[名]),
            h('div', { style: 可用 ? S.ok : S.danger },
              可用 ? `可用${信息.loaded ? '（已加载）' : ''}` : `不可用${原因 ? `：${原因}` : ''}`),
            信息.model ? h('div', { style: S.dim }, 信息.model) : null)
        })),
        能力表.tts && !能力表.tts.available && 能力表.tts.reason === 'service_down'
          ? h('div', { style: { ...S.danger, marginTop: 8 } },
              '服务未启动。手动启动：在 E:\\LocalAIService 目录运行 start_ai_service.ps1（P1 不自动安装/启动）。')
          : null)

      const 音色选项 = [{ value: 配置.ttsVoice || 'dafeiyu', label: 配置.ttsVoice || 'dafeiyu' }]
      for (const 名 of 音色们) {
        if (!音色选项.some((x) => x.value === 名)) 音色选项.push({ value: 名, label: 名 })
      }

      const 配置块 = h('div', { style: S.card },
        h('div', { style: { ...S.h, margin: '0 0 8px' } }, '服务设置'),
        行('服务地址', 输入(配置.baseUrl, (v) => 改('baseUrl', v), 'http://127.0.0.1:7880'),
          '唯一保存服务地址的地方；其它插件通过 fish.service 读取。'),
        行('请求超时（毫秒）', h('input', {
          style: S.small, type: 'number', min: 1000, max: 1800000,
          value: 配置.requestTimeoutMs ?? 180000,
          onChange: (e) => 改('requestTimeoutMs', Number(e.target.value)),
        }), 'TTS / 一般请求；ASR 与视觉有各自更长的超时。'),
        行('默认音色', 下拉(配置.ttsVoice || 'dafeiyu', 音色选项, (v) => 改('ttsVoice', v)),
          '服务端 /voices 里的文件名（不含扩展名）；默认保留 dafeiyu。'),
        行('缓存目录', 输入(配置.cacheDir, (v) => 改('cacheDir', v), ''),
          `产物只写这里：TTS wav / 分离 stems / 关键帧。当前 ${缓存.mb || 0} MB、${缓存.files || 0} 个文件；上限 ${缓存.maxMb || 2048} MB、TTL ${缓存.ttlHours || 72} 小时。`),
        行('总开关', h('input', {
          type: 'checkbox', checked: 配置.enabled !== false,
          onChange: (e) => 改('enabled', e.target.checked),
        }), '关掉后工具返回 service_not_installed，设置页仍可用。'),
        行('日志级别', 下拉(配置.logLevel || 'info', [
          { value: 'debug', label: 'debug' },
          { value: 'info', label: 'info' },
          { value: 'warn', label: 'warn' },
          { value: 'error', label: 'error' },
        ], (v) => 改('logLevel', v)), `日志文件：${(态.plugin && 态.plugin.logFile) || ''}`),
        (态.envOverrides && 态.envOverrides.length)
          ? h('div', { style: { ...S.danger, marginTop: 4 } }, `这些字段被环境变量覆盖：${态.envOverrides.join(', ')}`)
          : null,
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btnOn, onClick: 存, disabled: 忙 }, 忙 ? '处理中…' : '保存设置'),
          h('button', { type: 'button', style: S.btn, onClick: 测试, disabled: 忙 }, '测试连接'),
          h('button', { type: 'button', style: S.btn, onClick: 拉, disabled: 忙 }, '刷新')))

      const 状态块 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('div', { style: S.h1 }, '本地 AI'),
          h('span', { style: { ...S.badge, ...(在线 ? S.ok : S.danger) } },
            在线 ? `在线${兼容 ? '' : '（版本不兼容）'} · v${健康.serviceVersion || '?'}` : '服务未启动'),
          h('span', { style: S.dim }, `插件 v${(态.plugin && 态.plugin.version) || '?'}`)),
        h('div', { style: S.dim },
          `${配置.baseUrl}｜API ${健康.apiVersion || '?'}｜延迟 ${健康.latencyMs || 0}ms`
          + (健康.vram ? `｜显存 ${健康.vram.freeMb || 0}/${健康.vram.totalMb || 0} MB` : '')
          + `｜最近检查 ${健康.checkedAt ? new Date(健康.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
        (健康.lastError && 健康.lastError.hint)
          ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近错误：${健康.lastError.hint}`)
          : null,
        (态.errors && 态.errors.length)
          ? h('div', { style: { ...S.dim, marginTop: 4 } },
              `最近错误 ${态.errors.length} 条；最新：${态.errors[态.errors.length - 1].code} ${态.errors[态.errors.length - 1].hint || ''}`)
          : null)

      const 日志块 = h('div', null,
        h('div', { style: { ...S.h, marginTop: 14 } }, '日志（最近 200 行）'),
        h('button', { type: 'button', style: S.btn, onClick: 看日志, disabled: 忙 }, '读取日志'),
        h('pre', { style: S.logs }, 日志 ? 日志.join('\n') : '（点“读取日志”查看）'))

      return h('div', { style: S.wrap },
        状态块,
        能力块,
        配置块,
        (说 ? h('div', { style: { ...(说.includes('失败') ? S.danger : S.ok), marginTop: 6 } }, 说) : null),
        日志块)
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'fish-service', order: 57, label: () => '本地 AI' },
        Section,
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
