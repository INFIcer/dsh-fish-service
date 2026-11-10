// dsh-fish-service · 客户端插件（DSH Web）
//
// 纯原生 JS + React（DSH 平台自带），没有 npm、没有 CDN、没有构建步骤。
//
// P1：设置页（状态 / 服务地址 / 超时 / 默认音色 / 缓存 / 日志）。
// P2：消息朗读按钮（conversation.chat.assistant-actions）、
//     语音输入麦克风（conversation.input.right）+ 三选一面板（conversation.input.overlay）、
//     自动朗读开关（conversation.input.left）；
//     设置页补「朗读」「语音输入」两个分区。
//
// 所有请求都走宿主路由 /dsh-fish-service/*：浏览器不接触 token，也不直接访问 localai。
//
// 槽位 props 说明（DSH 0.2.2-rc.1 的 standard props，见 CONTRACT / docs/P2.md）：
//   - 每个槽位都带 sessionId / useChat / useInput / inputActions / useTrajectory；
//   - conversation.chat.assistant-actions 额外带 messageId（已定稿的助手消息）；
//   - inputActions.captureInsertion() 取「草稿选区 + 版本号」，
//     inputActions.insertText(text, span) 只有在版本没变、编辑器允许编辑时才会插入并返回 true。
//   插入失败不能直接改 DOM（会丢 React 状态），要求用户重试或走剪贴板兜底。

window.__ModuleLoader__.load({
  id: 'dsh-fish-service',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const inject = ['slots']
    const h = React.createElement
    const B = '/dsh-fish-service'

    // ---------------- 网络 ----------------

    const get = (path) => fetch(B + path, { cache: 'no-store' })
      .then((r) => r.json())
      .catch(() => null)

    const post = (path, body, opts = {}) => fetch(B + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      // 停止朗读时用 AbortController 掐掉还没回来的 /read/segment 请求。
      ...(opts.signal ? { signal: opts.signal } : {}),
    }).then((r) => r.json().catch(() => null))
      .catch((error) => ({
        ok: false,
        code: error?.name === 'AbortError' ? 'canceled' : 'upstream_error',
        hint: String(error?.message || error),
      }))

    /** multipart 上传；不要手动设 content-type，浏览器自己带 boundary。 */
    const postForm = (path, form) => fetch(B + path, { method: 'POST', body: form })
      .then((r) => r.json().catch(() => null))
      .catch((error) => ({ ok: false, code: 'upstream_error', hint: String(error?.message || error) }))

    const 音频地址 = (路径) => `${B}/audio?path=${encodeURIComponent(String(路径 || ''))}`

    // ---------------- 极简 store（跨槽位共享状态） ----------------

    function 造store(初值) {
      let 值 = 初值
      const 听 = new Set()
      return {
        get: () => 值,
        set(下一个) {
          值 = typeof 下一个 === 'function' ? 下一个(值) : 下一个
          for (const 函数 of [...听]) {
            try { 函数(值) } catch { /* 单个订阅者出错不影响别人 */ }
          }
        },
        subscribe(函数) {
          听.add(函数)
          return () => 听.delete(函数)
        },
      }
    }

    function useStore(store) {
      const [值, 设值] = React.useState(store.get)
      React.useEffect(() => {
        const 停 = store.subscribe(设值)
        设值(store.get())
        return 停
      }, [store])
      return 值
    }

    // ---------------- 插件偏好（来自 /state，设置页保存后同步更新） ----------------

    const 偏好 = 造store({
      载入: false,
      在线: false,
      config: {},
      健康: null,
      音色: [],
      插件: {},
    })

    let 偏好请求 = null
    function 载入偏好({ force = false } = {}) {
      if (偏好请求 && !force) return 偏好请求
      偏好请求 = get('/state').then((s) => {
        if (s && s.ok) {
          偏好.set((旧) => ({
            ...旧,
            载入: true,
            在线: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            健康: s.health || null,
            音色: Array.isArray(s.voices) ? s.voices : 旧.音色,
            插件: s.plugin || {},
          }))
        } else {
          偏好.set((旧) => ({ ...旧, 载入: true }))
        }
        return s
      }).catch(() => {
        偏好请求 = null
        return null
      })
      return 偏好请求
    }

    // ---------------- 按会话自动朗读（纯函数，便于单测） ----------------

    const 会话自动朗读上限 = 200
    const 会话键合法 = (键) => typeof 键 === 'string' && /^session-/.test(键)
    const 真值 = (值) => 值 === true || 值 === 'true' || 值 === 1 || 值 === '1'

    /** 当前会话是否自动朗读：本会话有设置就用它，否则回落到全局默认（autoRead）。 */
    function 读会话自动朗读(配置, 会话键) {
      const 配置项 = 配置 && typeof 配置 === 'object' ? 配置 : {}
      const 表 = 配置项.autoReadSessions && typeof 配置项.autoReadSessions === 'object'
        && !Array.isArray(配置项.autoReadSessions)
        ? 配置项.autoReadSessions
        : null
      if (表 && 会话键合法(会话键) && Object.prototype.hasOwnProperty.call(表, 会话键)) {
        return 真值(表[会话键])
      }
      return 真值(配置项.autoRead)
    }

    /** 只改当前会话那一条，返回新配置；其它会话与全局默认保持不变。 */
    function 写会话自动朗读(配置, 会话键, 开) {
      const 配置项 = 配置 && typeof 配置 === 'object' ? 配置 : {}
      if (!会话键合法(会话键)) return 配置项
      const 表 = 配置项.autoReadSessions && typeof 配置项.autoReadSessions === 'object'
        && !Array.isArray(配置项.autoReadSessions)
        ? { ...配置项.autoReadSessions }
        : {}
      // 先删再写：最近改过的会话排在最后，超过上限时优先淘汰最早的设置。
      delete 表[会话键]
      表[会话键] = 开 === true || 开 === 'true'
      const 键们 = Object.keys(表)
      while (键们.length > 会话自动朗读上限) delete 表[键们.shift()]
      return { ...配置项, autoReadSessions: 表 }
    }

    /** 后台朗读：旧配置没有该字段、或值无法识别时按开启；只有明确关闭才关。 */
    function 读后台自动朗读(配置) {
      const 值 = 配置 && typeof 配置 === 'object' ? 配置.autoReadInBackground : undefined
      if (值 === false || 值 === 'false' || 值 === 0 || 值 === '0') return false
      return true
    }

    /** 这条新回复是否自动朗读：会话开关必须开；页面在后台时还要「后台也自动朗读」开着。 */
    function 是否自动朗读(配置, 会话键, 页面可见) {
      if (!读会话自动朗读(配置, 会话键)) return false
      if (页面可见) return true
      return 读后台自动朗读(配置)
    }

    // 有组件挂载时才轮询 /health（30 秒一次），没人看就不打扰服务。
    let 心跳 = null
    let 挂载数 = 0
    function 保活(开) {
      挂载数 += 开 ? 1 : -1
      if (挂载数 < 0) 挂载数 = 0
      if (开 && !心跳) {
        心跳 = setInterval(async () => {
          try {
            const r = await fetch(B + '/health', { cache: 'no-store' }).then((x) => x.json())
            if (r) 偏好.set((旧) => ({ ...旧, 在线: Boolean(r.ok) }))
          } catch { /* 服务重启/DSH 关闭时忽略 */ }
        }, 30000)
      } else if (!开 && 挂载数 === 0 && 心跳) {
        clearInterval(心跳)
        心跳 = null
      }
    }

    // ---------------- 朗读播放器（全局只有一个） ----------------
    //
    // 流式朗读（P2 性能修复）：
    //   1. POST /read/plan 立刻拿分段计划（不合成）；
    //   2. 按顺序请求 /read/segment，拿到第 1 段就开始播，同时预取下一段；
    //   3. 切换消息 / 再点一次 = stop()：递增代次 + abort 未完成的 segment 请求。
    // 这样长文不用等全部合成，首段出声明显更早；同一段重复朗读由服务端缓存直接命中。

    const 播放 = {
      态: 造store({ phase: 'idle', messageId: '', error: '', index: 0, total: 0 }),
      音频: null,
      预取: null,
      序号: 0,
      消息: '',
      中止: null,

      stop(错误 = '') {
        this.序号 += 1
        try { this.中止?.abort() } catch { /* 已经结束 */ }
        this.中止 = null
        for (const 音频 of [this.音频, this.预取]) {
          if (!音频) continue
          try { 音频.pause() } catch { /* 已经结束 */ }
          try { 音频.removeAttribute('src'); 音频.load() } catch { /* 忽略 */ }
        }
        this.音频 = null
        this.预取 = null
        this.消息 = ''
        this.态.set({ phase: 'idle', messageId: '', error: 错误, index: 0, total: 0 })
      },

      /** 流式合成并顺序播放；同一条消息再点一次 = 停止。 */
      async 合成并播放(messageId, 文本, 配置) {
        this.stop()
        const 代 = ++this.序号
        const 中止 = typeof AbortController === 'function' ? new AbortController() : null
        this.中止 = 中止
        this.消息 = messageId
        this.态.set({ phase: 'synth', messageId, error: '', index: 0, total: 0 })

        const plan = await post('/read/plan', {
          text: 文本,
          voice: 配置.ttsVoice,
          speed: 配置.ttsSpeed,
          maxChars: 配置.readMaxChars,
          skipCodeBlocks: 配置.readSkipCode !== false,
        }, { signal: 中止?.signal })
        if (代 !== this.序号) return
        if (!plan || !plan.ok) {
          this.中止 = null
          this.态.set({ phase: 'error', messageId, error: (plan && plan.hint) || '朗读准备失败，请稍后重试。', index: 0, total: 0 })
          return
        }

        const 段们 = Array.isArray(plan.segments) ? plan.segments.filter((x) => x && typeof x.text === 'string') : []
        if (!段们.length) {
          this.中止 = null
          this.态.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        const 总段 = 段们.length
        const 提示 = plan.truncated ? '（内容过长，仅朗读了前一部分）' : ''

        // 每段只请求一次；任务表让「预取」和「正在播的下一段」复用同一个请求。
        const 任务 = new Map()
        const 要段 = (i) => {
          if (!任务.has(i)) {
            任务.set(i, post('/read/segment', {
              index: Number.isInteger(段们[i].index) ? 段们[i].index : i,
              total: 总段,
              text: 段们[i].text,
              ...(plan.voice ? { voice: plan.voice } : {}),
              ...(plan.speed ? { speed: plan.speed } : {}),
            }, { signal: 中止?.signal }))
          }
          return 任务.get(i)
        }

        // 第 1 段和第 2 段一起发出去：第 1 段一到就播，第 2 段在后台合成。
        // 第 1 段回来之前保持「合成中」转圈；回来后才切到「播放中 1/N」。
        void 要段(0)
        if (总段 > 1) void 要段(1)

        for (let i = 0; i < 总段; i++) {
          if (代 !== this.序号) return
          const r = await 要段(i)
          if (代 !== this.序号) return
          if (!r || !r.ok) {
            try { 中止?.abort() } catch { /* 已经结束 */ }
            this.中止 = null
            this.态.set({
              phase: 'error',
              messageId,
              error: (r && r.hint) || '朗读中断，请重试。',
              index: 0,
              total: 0,
            })
            return
          }
          this.态.set((旧) => ({ ...旧, phase: 'playing', error: '', hint: 提示, index: i + 1, total: 总段 }))
          // 播放当前段之前先把下一段请求发出去，利用播放时间做预取。
          if (i + 1 < 总段) void 要段(i + 1)
          const 错误 = await this.播一段({ wavPath: r.wavPath }, 代)
          if (代 !== this.序号) return
          if (错误) {
            try { 中止?.abort() } catch { /* 已经结束 */ }
            this.中止 = null
            this.态.set((旧) => ({ ...旧, phase: 'error', error: 错误, index: 0, total: 0 }))
            return
          }
        }
        if (代 === this.序号) {
          this.中止 = null
          this.态.set({ phase: 'idle', messageId: '', error: '', hint: 提示, index: 0, total: 0 })
        }
      },

      播一段(item, 代) {
        return new Promise((resolve) => {
          const 音频 = new Audio(音频地址(item.wavPath))
          this.音频 = 音频
          let 结束 = false
          let 检查 = null
          const 收尾 = (错误) => {
            if (结束) return
            结束 = true
            if (检查) { clearInterval(检查); 检查 = null }
            if (this.音频 === 音频) this.音频 = null
            try { 音频.pause() } catch { /* 忽略 */ }
            resolve(错误)
          }
          音频.onended = () => 收尾('')
          音频.onerror = () => 收尾('音频无法播放，请再点一次朗读。')
          try {
            音频.play().then(() => { /* 开始播了 */ }).catch(() => {
              收尾('浏览器阻止了自动播放，请再点一次朗读。')
            })
          } catch {
            收尾('无法播放这段音频。')
          }
          // 播放器被 stop() 强行换掉时，别让 Promise 永远挂着。
          检查 = setInterval(() => {
            if (代 !== this.序号) 收尾('')
          }, 300)
        })
      },
    }

    // ---------------- 从聊天快照里取消息文字 ----------------

    function 取轮次键们(快照, turn) {
      try {
        const 键们 = 快照 && 快照.locations && 快照.locations.getTurn ? 快照.locations.getTurn(turn) : null
        return Array.isArray(键们) ? 键们 : []
      } catch {
        return []
      }
    }

    function 取节点(快照, 键) {
      try {
        return 快照 && 快照.nodes && 快照.nodes.get ? 快照.nodes.get(键) : undefined
      } catch {
        return undefined
      }
    }

    /**
     * 在 Chat 快照里找「最终节点 messageId 等于本条消息」的轮次。
     * 消息定稿后轮次不会变，所以按 messageId 缓存轮次号；否则每条消息每次快照
     * 都扫全部轮次，长会话里会拖慢流式渲染。
     */
    const 消息轮次缓存 = new Map()

    function 找消息轮次(快照, messageId) {
      if (!快照 || !messageId) return null
      const 轮次 = 快照.timeline && Array.isArray(快照.timeline.turnOrder) ? 快照.timeline.turnOrder : []
      const 缓存 = 消息轮次缓存.get(messageId)
      // 先试缓存轮次；命中就只扫一轮。缓存失效（切会话/重建）时再扫全部。
      const 候选 = 缓存 !== undefined && 轮次.includes(缓存) ? [缓存] : []
      for (const turn of 候选) {
        const 键们 = 取轮次键们(快照, turn)
        for (const 键 of 键们) {
          const 节点 = 取节点(快照, 键)
          if (!节点 || 节点.kind !== 'turn-tail') continue
          const 终 = 节点.data && 节点.data.closing && 节点.data.closing.finalNode
          if (终 && 终.messageId === messageId) {
            return {
              turn,
              键们,
              是最后: 轮次[轮次.length - 1] === turn,
              块们: Array.isArray(节点.data.closing.blocks) ? 节点.data.closing.blocks : [],
            }
          }
        }
      }
      for (const turn of 轮次) {
        if (候选.length && turn === 候选[0]) continue
        const 键们 = 取轮次键们(快照, turn)
        for (const 键 of 键们) {
          const 节点 = 取节点(快照, 键)
          if (!节点 || 节点.kind !== 'turn-tail') continue
          const 终 = 节点.data && 节点.data.closing && 节点.data.closing.finalNode
          if (终 && 终.messageId === messageId) {
            消息轮次缓存.set(messageId, turn)
            return {
              turn,
              键们,
              是最后: 轮次[轮次.length - 1] === turn,
              块们: Array.isArray(节点.data.closing.blocks) ? 节点.data.closing.blocks : [],
            }
          }
        }
      }
      return null
    }

    function 消息位置(快照, messageId) {
      const 命中 = 找消息轮次(快照, messageId)
      if (!命中) return ''
      return `${命中.turn}|${命中.是最后 ? 1 : 0}`
    }

    function 消息文本(快照, messageId) {
      const 命中 = 找消息轮次(快照, messageId)
      if (!命中) return ''
      // 只读「这一轮最终回复」的文本块（closing.blocks）；工具调用 / 思考 / 中间步骤都不读。
      const 段 = []
      for (const 块 of 命中.块们) {
        if (块 && 块.kind === 'text' && typeof 块.text === 'string') 段.push(块.text)
      }
      return 段.join('\n\n').trim()
    }

    /** 兜底：快照取不到时，从按钮所在的 DOM 行往上找最近的助手消息行。 */
    function DOM取文本(元素) {
      try {
        if (!元素 || typeof 元素.closest !== 'function') return ''
        const 行 = 元素.closest('[data-chat-flow-key]') || 元素.closest('[data-chat-anchor-key]')
        if (!行 || !行.parentElement) return ''
        const 列表 = 行.parentElement
        let 目标 = null
        for (let 前 = 行.previousElementSibling; 前; 前 = 前.previousElementSibling) {
          if (前.getAttribute && 前.getAttribute('data-chat-flow-kind') === 'assistant-step') { 目标 = 前; break }
        }
        if (!目标) {
          const 全部 = 列表.querySelectorAll('[data-chat-flow-kind="assistant-step"]')
          目标 = 全部.length ? 全部[全部.length - 1] : null
        }
        if (!目标) return ''
        const 文 = String(目标.innerText || '').trim()
        return 文
      } catch {
        return ''
      }
    }

    // ---------------- 图标 + 样式 ----------------

    function 图标发声(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('path', { d: 'M2.6 6.1h2.1L7.6 3.4v9.2L4.7 9.9H2.6z', fill: 'currentColor' }),
        h('path', { d: 'M10.1 5.4a3.4 3.4 0 0 1 0 5.2', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        h('path', { d: 'M11.9 3.7a5.6 5.6 0 0 1 0 8.6', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }))
    }

    function 图标暂停(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }),
        h('rect', { x: 9.4, y: 2.8, width: 3.2, height: 10.4, rx: 1 }))
    }

    function 图标转圈(大小 = 15) {
      return h('svg', { className: 'fish-spin', viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('circle', { cx: 8, cy: 8, r: 6, stroke: 'currentColor', strokeWidth: 1.6, opacity: 0.25 }),
        h('path', { d: 'M8 2a6 6 0 0 1 6 6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    function 图标麦克风(大小 = 15) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'none' },
        h('rect', { x: 5.6, y: 1.8, width: 4.8, height: 8, rx: 2.4, fill: 'currentColor' }),
        h('path', { d: 'M3.6 7.6a4.4 4.4 0 0 0 8.8 0', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
        h('path', { d: 'M8 12v2.2', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function 图标停止(大小 = 14) {
      return h('svg', { viewBox: '0 0 16 16', width: 大小, height: 大小, 'aria-hidden': true, fill: 'currentColor' },
        h('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 2.4 }))
    }

    const 样式文本 = `
@keyframes fish-spin { to { transform: rotate(360deg) } }
@keyframes fish-pulse { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
@keyframes fish-in { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: translateY(0) } }
.fish-spin { animation: fish-spin .9s linear infinite; transform-origin: 50% 50%; }
.fish-iconbtn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 24px; min-width: 24px; padding: 0 4px; margin: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #666);
  font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
}
.fish-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, inherit); }
.fish-iconbtn[data-on="1"] { color: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-iconbtn[data-rec="1"] { color: #d0342c; }
.fish-iconbtn[disabled] { opacity: .45; cursor: default; }
.fish-dot { width: 7px; height: 7px; border-radius: 50%; background: #d0342c; animation: fish-pulse 1.1s ease-in-out infinite; }
.fish-panel {
  position: absolute; left: 8px; right: 8px; bottom: 0; margin-bottom: 10px;
  z-index: 40; box-sizing: border-box; max-width: 560px; margin-left: auto; margin-right: auto;
  padding: 12px 14px; border-radius: 12px; animation: fish-in .12s ease-out;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.98));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: 0 10px 30px rgba(0,0,0,.18);
  font-size: 13px; line-height: 1.6;
}
.fish-panel-title { font-weight: 650; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.fish-panel-dim { opacity: .62; font-size: 12px; }
.fish-panel-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.fish-btn {
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.14)); border-radius: 8px;
  background: transparent; color: inherit; font: inherit; font-size: 12.5px;
  padding: 6px 12px; cursor: pointer;
}
.fish-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.fish-btn[data-primary="1"] {
  border-color: var(--dsw-alias-state-business-primary, #2f6fed);
  background: var(--dsw-alias-state-business-primary, #2f6fed); color: #fff;
}
.fish-btn[disabled] { opacity: .5; cursor: default; }
.fish-wave { display: inline-flex; align-items: center; gap: 2px; height: 22px; }
.fish-wave i { display: block; width: 3px; border-radius: 2px; background: currentColor; transition: height .12s linear; }
.fish-err { color: #c0392b; font-size: 12px; }
.fish-ok { color: var(--dsw-alias-state-business-primary, #2f6fed); font-size: 12px; }
/* 原生下拉：某些主题下 option 会继承白色文字，而弹层的系统背景是白色 → 看不清。
   这里显式给 select 与 option 配「背景/文字」成对颜色，跟随 DSH 主题变量。 */
select.fish-select {
  color-scheme: light dark;
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
select.fish-select option,
select.fish-select optgroup {
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
select.fish-select option:checked {
  background-color: var(--dsw-alias-state-business-primary, #2f6fed);
  color: #ffffff;
}
/* 其它原生表单控件同理，避免浅底白字 */
.fish-service-settings input,
.fish-service-settings textarea,
.fish-service-settings select {
  background-color: var(--dsw-alias-bg-layer-1, #ffffff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.fish-service-settings input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary, #2f6fed); }
.fish-service-settings input::placeholder { color: var(--dsw-alias-label-secondary, #888); opacity: 1; }
`

    // 样式只注入一次：每个消息都渲染一份 <style> 会把 DOM 撑爆。
    // DSH 自己的客户端包也是这么做的（在客户端模块里往 head 里插一段 CSS）。
    function 注入样式() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-fish-service="p2"]')) return
        const 节点 = document.createElement('style')
        节点.dataset.fishService = 'p2'
        节点.textContent = 样式文本
        document.head.appendChild(节点)
      } catch { /* 注入失败只影响外观，不影响功能 */ }
    }

    // ---------------- 朗读按钮 ----------------

    const 已自动朗读 = new Set()
    // 每个会话「第一次看到时的最后一轮」：只有比它更新的回复才会自动朗读，
    // 这样打开旧会话 / 切回旧会话都不会把历史消息念一遍。
    const 会话初始末轮 = new Map()

    function 末轮次(快照) {
      try {
        const 轮次 = 快照 && 快照.timeline && Array.isArray(快照.timeline.turnOrder) ? 快照.timeline.turnOrder : []
        return 轮次.length ? 轮次[轮次.length - 1] : -1
      } catch {
        return -1
      }
    }

    /** props.useChat 缺失时的占位选择器：仍然按 hook 调用，保证 hook 数量稳定。 */
    function 空选择器() {
      const [空] = React.useState('')
      return 空
    }

    function 朗读按钮(props) {
      const { messageId } = props || {}
      const 播放态 = useStore(播放.态)
      const 偏好态 = useStore(偏好)
      const 按钮 = React.useRef(null)
      const 挂载时已载入 = React.useRef(Boolean(偏好.get().载入))

      // 槽位标准 props：useChat 一定有；真没有时退化成空选择器（不读快照，只走 DOM 兜底）。
      const 用聊天 = typeof props?.useChat === 'function' ? props.useChat : 空选择器

      const 文本 = 用聊天((快照) => 消息文本(快照, messageId))
      const 位置 = 用聊天((快照) => 消息位置(快照, messageId))
      const 末轮 = 用聊天((快照) => 末轮次(快照))
      const 会话键 = String(props?.sessionId || '')

      React.useEffect(() => {
        // 本轮所有消息按钮挂载时记录一次；之后新到的回复轮次会更大。
        if (!会话初始末轮.has(会话键)) 会话初始末轮.set(会话键, 末轮)
      }, [末轮, 会话键])

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      const 正在这条 = 播放态.messageId === messageId && (播放态.phase === 'synth' || 播放态.phase === 'playing')
      const 合成中 = 正在这条 && 播放态.phase === 'synth'
      const 播放中 = 正在这条 && 播放态.phase === 'playing'
      const 自动朗读 = 读会话自动朗读(偏好态.config, 会话键)
      const 后台朗读 = 读后台自动朗读(偏好态.config)

      const 取文本 = () => 文本 || DOM取文本(按钮.current)

      const 点 = async () => {
        if (正在这条) {
          播放.stop()
          return
        }
        const 原文本 = 取文本()
        if (!原文本) {
          播放.态.set({ phase: 'error', messageId, error: '这条消息没有可朗读的文字。', index: 0, total: 0 })
          return
        }
        await 播放.合成并播放(messageId, 原文本, 偏好.get().config || {})
      }

      // 自动朗读：按当前会话的设置判断（未单独设置时回落到全局默认）；
      // 只在「偏好已加载 + 这条是最后一轮」时触发一次。窗口在后台时，
      // 是否朗读由「后台也自动朗读」决定（默认开）。
      React.useEffect(() => {
        if (!挂载时已载入.current) return
        if (!偏好态.载入 || !自动朗读) return
        if (!文本 || !位置) return
        const [轮次文本, 最后] = String(位置).split('|')
        if (最后 !== '1') return
        const 轮次 = Number(轮次文本)
        const 初始 = 会话初始末轮.get(会话键)
        if (Number.isFinite(轮次) && Number.isFinite(初始) && 轮次 <= 初始) return
        if (已自动朗读.has(messageId)) return
        const 页面可见 = typeof document === 'undefined' || document.visibilityState === 'visible'
        if (!是否自动朗读(偏好态.config, 会话键, 页面可见)) return
        已自动朗读.add(messageId)
        void 播放.合成并播放(messageId, 文本, 偏好.get().config || {})
      }, [文本, 位置, 偏好态.载入, 自动朗读, 后台朗读, messageId, 会话键])

      const 标题 = 合成中 ? '正在准备朗读，再点一次可取消'
        : 播放中 ? '停止朗读'
          : 偏好态.在线 === false ? '朗读这条回复（本地 AI 未启动）'
            : '朗读这条回复'

      const 错误 = 播放态.messageId === messageId && 播放态.phase === 'error' ? 播放态.error : ''
      const 提示 = 播放态.messageId === messageId && 播放态.hint && 播放态.phase !== 'error' ? 播放态.hint : ''

      return h(React.Fragment, null,
        h('button', {
          ref: 按钮,
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': 播放中 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-busy': 合成中 ? 'true' : undefined,
          onClick: 点,
        },
          合成中 ? 图标转圈() : 播放中 ? 图标暂停() : 图标发声(),
          播放中 && 播放态.total > 1 ? h('span', { style: { fontSize: 11 } }, `${播放态.index}/${播放态.total}`) : null),
        错误 ? h('span', { className: 'fish-err', role: 'status', style: { marginLeft: 6 } }, 错误) : null,
        提示 ? h('span', { className: 'fish-panel-dim', role: 'status', style: { marginLeft: 6 } }, 提示) : null)
    }

    // ---------------- 输入设备（纯函数，便于单测） ----------------

    /** 录音约束：空标识 = 跟随系统默认；非空则精确指定该设备。 */
    function 构建录音约束(deviceId) {
      const 设备标识 = typeof deviceId === 'string' ? deviceId.trim() : ''
      const 音频 = { echoCancellation: true, noiseSuppression: true }
      if (设备标识) 音频.deviceId = { exact: 设备标识 }
      return { audio: 音频 }
    }

    /** 设备被拔掉、改名或约束不满足时，浏览器报这几个错误。 */
    function 设备不可用错误(错误) {
      const 名 = String(错误?.name || '')
      return 名 === 'OverconstrainedError' || 名 === 'NotFoundError' || 名 === 'DevicesNotFoundError'
    }

    /**
     * 打开麦克风；指定了设备但设备不可用时自动回退到系统默认。
     * getUserMedia 由调用方注入，便于单测模拟浏览器行为。
     * 返回 { stream, fellBack }。
     */
    async function 打开麦克风(deviceId, getUserMedia) {
      const 已选 = typeof deviceId === 'string' ? deviceId.trim() : ''
      const 申请 = typeof getUserMedia === 'function'
        ? getUserMedia
        : (约束) => navigator.mediaDevices.getUserMedia(约束)
      try {
        return { stream: await 申请(构建录音约束(已选)), fellBack: false }
      } catch (错误) {
        if (!已选 || !设备不可用错误(错误)) throw 错误
        return { stream: await 申请(构建录音约束('')), fellBack: true }
      }
    }

    /** 设备名像虚拟声卡/采集卡时，提醒用户改选真实麦克风。 */
    const 虚拟设备特征 = /stream|virtual|cable|voicemeeter|vb-audio|loopback|stereo\s*mix|立体声混音/i

    function 是虚拟设备名称(名称) {
      return typeof 名称 === 'string' && 虚拟设备特征.test(名称)
    }

    function 虚拟设备提示(名称) {
      return 是虚拟设备名称(名称)
        ? '当前输入设备可能是虚拟设备，请在设置里改选真实麦克风。'
        : ''
    }

    function 补设备提示(文本, 名称) {
      const 提示 = 虚拟设备提示(名称)
      return 提示 ? `${文本} ${提示}` : 文本
    }

    // 输入设备列表与最近一次录音实际使用的设备（只在本次页面会话里，不持久化）。
    const 设备 = 造store({
      列表: [],
      最近名称: '',
      最近标识: '',
      枚举中: false,
      提示: '',
    })

    async function 已有麦克风权限() {
      try {
        if (!navigator.permissions?.query) return false
        const 状态 = await navigator.permissions.query({ name: 'microphone' })
        return 状态.state === 'granted'
      } catch {
        return false
      }
    }

    /** 先申请权限（已有权限就直接枚举），再列出音频输入设备。 */
    async function 刷新设备列表() {
      if (设备.get().枚举中) return
      设备.set((旧) => ({ ...旧, 枚举中: true, 提示: '' }))
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
          设备.set((旧) => ({ ...旧, 枚举中: false, 提示: '当前浏览器不支持选择麦克风。' }))
          return
        }
        if (!(await 已有麦克风权限())) {
          let 流
          try {
            流 = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch {
            设备.set((旧) => ({ ...旧, 列表: [], 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
            return
          }
          try { 流?.getTracks?.().forEach((轨) => 轨.stop()) } catch { /* 忽略 */ }
        }
        let 全部 = []
        try { 全部 = await navigator.mediaDevices.enumerateDevices() } catch { 全部 = [] }
        const 列表 = []
        for (const 项 of Array.isArray(全部) ? 全部 : []) {
          if (!项 || 项.kind !== 'audioinput') continue
          const 标识 = String(项.deviceId || '')
          if (!标识) continue
          const 名称 = String(项.label || '').trim() || `麦克风 ${列表.length + 1}`
          列表.push({ deviceId: 标识, label: 名称 })
        }
        if (!列表.length) {
          设备.set((旧) => ({ ...旧, 列表: [], 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
          return
        }
        设备.set((旧) => ({ ...旧, 列表, 枚举中: false, 提示: '' }))
      } catch {
        设备.set((旧) => ({ ...旧, 枚举中: false, 提示: '未获得麦克风权限，无法列出设备。' }))
      }
    }

    // ---------------- 录音器（MediaRecorder 优先，退化到 PCM/WAV） ----------------

    function 停流(流) {
      try { 流?.getTracks?.().forEach((轨) => 轨.stop()) } catch { /* 忽略 */ }
    }

    function 造电平(流) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext
        if (!Ctx) throw new Error('no audio context')
        const 上下文 = new Ctx()
        try { void 上下文.resume?.() } catch { /* 有些浏览器不需要/不允许 */ }
        const 源 = 上下文.createMediaStreamSource(流)
        const 分析 = 上下文.createAnalyser()
        分析.fftSize = 256
        源.connect(分析)
        const 缓冲 = new Uint8Array(分析.frequencyBinCount)
        return {
          读取() {
            try {
              分析.getByteTimeDomainData(缓冲)
              let 峰 = 0
              for (const v of 缓冲) {
                const d = Math.abs(v - 128) / 128
                if (d > 峰) 峰 = d
              }
              return Math.min(1, 峰 * 2.2)
            } catch { return 0 }
          },
          关闭() {
            try { 源.disconnect(); 分析.disconnect(); 上下文.close() } catch { /* 忽略 */ }
          },
        }
      } catch {
        return { 读取: () => 0, 关闭() {} }
      }
    }

    function 用MediaRecorder(流, mime) {
      const 录制 = new MediaRecorder(流, { mimeType: mime })
      const 块 = []
      录制.ondataavailable = (事件) => { if (事件.data && 事件.data.size) 块.push(事件.data) }
      const 电平 = 造电平(流)
      录制.start(250)
      let 停止 = false
      return {
        mime,
        读取电平: () => 电平.读取(),
        async stop() {
          if (!停止) {
            停止 = true
            await new Promise((resolve) => {
              录制.onstop = resolve
              try { 录制.stop() } catch { resolve() }
            })
          }
          电平.关闭()
          停流(流)
          return { blob: new Blob(块, { type: mime }), mime }
        },
        cancel() {
          try { 停止 = true; 录制.stop() } catch { /* 忽略 */ }
          电平.关闭()
          停流(流)
        },
      }
    }

    function 编码WAV(采样, 采样率) {
      const 数据长度 = 采样.length
      const 缓冲 = new ArrayBuffer(44 + 数据长度 * 2)
      const 视 = new DataView(缓冲)
      const 写文 = (偏移, 文) => { for (let i = 0; i < 文.length; i++) 视.setUint8(偏移 + i, 文.charCodeAt(i)) }
      写文(0, 'RIFF')
      视.setUint32(4, 36 + 数据长度 * 2, true)
      写文(8, 'WAVE')
      写文(12, 'fmt ')
      视.setUint32(16, 16, true)
      视.setUint16(20, 1, true)
      视.setUint16(22, 1, true)
      视.setUint32(24, 采样率, true)
      视.setUint32(28, 采样率 * 2, true)
      视.setUint16(32, 2, true)
      视.setUint16(34, 16, true)
      写文(36, 'data')
      视.setUint32(40, 数据长度 * 2, true)
      let 偏移 = 44
      for (let i = 0; i < 数据长度; i++) {
        const s = Math.max(-1, Math.min(1, 采样[i]))
        视.setInt16(偏移, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        偏移 += 2
      }
      return new Uint8Array(缓冲)
    }

    function 用WAV(流) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return Promise.reject(new Error('浏览器不支持 WebAudio 录音'))
      const 上下文 = new Ctx()
      try { void 上下文.resume?.() } catch { /* 忽略 */ }
      const 源 = 上下文.createMediaStreamSource(流)
      const 节点 = 上下文.createScriptProcessor(4096, 1, 1)
      const 块 = []
      let 峰 = 0
      节点.onaudioprocess = (事件) => {
        const 数据 = 事件.inputBuffer.getChannelData(0)
        块.push(new Float32Array(数据))
        let 本帧 = 0
        for (let i = 0; i < 数据.length; i++) {
          const d = Math.abs(数据[i])
          if (d > 本帧) 本帧 = d
        }
        峰 = Math.max(峰, 本帧)
      }
      源.connect(节点)
      节点.connect(上下文.destination)
      const 采样率 = 上下文.sampleRate
      let 停止 = false
      const 收尾 = () => {
        try { 节点.disconnect(); 源.disconnect(); 上下文.close() } catch { /* 忽略 */ }
        停流(流)
      }
      return Promise.resolve({
        mime: 'audio/wav',
        读取电平: () => { const v = 峰; 峰 = 0; return Math.min(1, v * 2.2) },
        async stop() {
          if (!停止) { 停止 = true; 收尾() }
          const 总长 = 块.reduce((和, x) => 和 + x.length, 0)
          const 合并 = new Float32Array(总长)
          let 偏移 = 0
          for (const x of 块) { 合并.set(x, 偏移); 偏移 += x.length }
          return { blob: new Blob([编码WAV(合并, 采样率)], { type: 'audio/wav' }), mime: 'audio/wav' }
        },
        cancel() {
          if (!停止) { 停止 = true; 收尾() }
        },
      })
    }

    async function 创建录音器(流, 格式) {
      const 偏好mime = 格式 === 'webm' ? 'audio/webm;codecs=opus' : null
      const 候选 = 偏好mime ? [偏好mime] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      if (格式 !== 'wav' && typeof window.MediaRecorder === 'function') {
        const mime = 候选.find((x) => {
          try { return window.MediaRecorder.isTypeSupported(x) } catch { return false }
        })
        if (mime) return 用MediaRecorder(流, mime)
      }
      return 用WAV(流)
    }

    // ---------------- 语音输入状态机 ----------------

    const 语音 = {
      态: 造store({
        phase: 'idle', // idle | requesting | recording | choose | uploading | transcribing | done | error
        sessionId: '',
        startedAt: 0,
        seconds: 0,
        level: 0,
        peak: 0,
        micLabel: '',
        durationMs: 0,
        bytes: 0,
        mime: '',
        choice: '',
        hint: '',
        error: '',
        text: '',
        pendingText: '',
        path: '',
        elapsedMs: 0,
      }),
      录音器: null,
      计时器: null,
      关闭定时: null,
      片段: null,
      插入位: null,
      // 录音有异步步骤（要等用户点「允许麦克风」）；取消/关闭时递增它，
      // 晚到的 getUserMedia 结果发现代号变了就自己收掉，不会在关掉面板后又开始录。
      代: 0,
    }

    const 选择键 = 'dsh-fish-service.voice-choice'

    function 记住的选择() {
      try {
        const v = window.localStorage.getItem(选择键)
        return ['text', 'audio', 'cancel'].includes(v) ? v : ''
      } catch { return '' }
    }

    function 记住选择(选择) {
      if (偏好.get().config.rememberVoiceChoice === false) return
      try { window.localStorage.setItem(选择键, 选择) } catch { /* 无痕模式 */ }
    }

    function 麦克风错误(错误) {
      const 名 = String(错误?.name || '')
      if (名 === 'NotAllowedError' || 名 === 'SecurityError') return '未获得麦克风权限，请允许浏览器使用麦克风后重试。'
      if (名 === 'NotFoundError' || 名 === 'DevicesNotFoundError') return '未找到麦克风，请连接麦克风后重试。'
      if (名 === 'NotReadableError') return '麦克风正被其他程序占用，请关闭会议或录音软件后重试。'
      if (名 === 'OverconstrainedError') return '麦克风不支持当前的录音设置，请改用系统默认设备后重试。'
      return '无法打开麦克风，请检查设备后重试。'
    }

    function 清理录音() {
      if (语音.计时器) { clearInterval(语音.计时器); 语音.计时器 = null }
      if (语音.录音器) {
        try { 语音.录音器.cancel?.() } catch { /* 忽略 */ }
        语音.录音器 = null
      }
    }

    function 安排关闭(毫秒 = 6000) {
      if (语音.关闭定时) clearTimeout(语音.关闭定时)
      语音.关闭定时 = setTimeout(() => {
        语音.关闭定时 = null
        关闭语音面板()
      }, 毫秒)
    }

    async function 开始录音(props) {
      const 当前 = 语音.态.get().phase
      if (当前 !== 'idle' && 当前 !== 'error') return
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      清理录音()
      const 代 = ++语音.代
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '当前浏览器不支持录音，请换用其他浏览器后重试。' }))
        安排关闭()
        return
      }
      const 配置 = 偏好.get().config || {}
      const 插入位 = (() => {
        try { return props?.inputActions?.captureInsertion?.() ?? null } catch { return null }
      })()
      语音.插入位 = 插入位
      语音.态.set({
        ...语音.态.get(),
        phase: 'requesting',
        sessionId: String(props?.sessionId || ''),
        startedAt: Date.now(),
        seconds: 0,
        level: 0,
        durationMs: 0,
        bytes: 0,
        mime: '',
        choice: '',
        hint: '',
        error: '',
        text: '',
        pendingText: '',
        path: '',
        elapsedMs: 0,
      })
      语音.片段 = null
      let 流
      let 回退默认 = false
      try {
        const 打开 = await 打开麦克风(配置.recordDeviceId || '')
        流 = 打开.stream
        回退默认 = 打开.fellBack === true
      } catch (错误) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: 麦克风错误(错误) }))
        安排关闭(8000)
        return
      }
      if (代 !== 语音.代) {
        停流(流)
        return
      }
      let 麦克风名 = ''
      let 麦克风标识 = ''
      try {
        const 轨 = 流.getAudioTracks?.()[0]
        麦克风名 = String(轨?.label || '')
        麦克风标识 = String(轨?.getSettings?.()?.deviceId || '')
      } catch { 麦克风名 = ''; 麦克风标识 = '' }
      语音.态.set((旧位) => ({
        ...旧位,
        micLabel: 麦克风名,
        hint: 回退默认 ? '所选麦克风不可用，已改用系统默认设备。' : '',
      }))
      设备.set((旧位) => ({
        ...旧位,
        最近名称: 麦克风名 || 旧位.最近名称,
        最近标识: 麦克风标识 || 旧位.最近标识,
      }))
      try {
        const 录音器 = await 创建录音器(流, 配置.recordMime || 'auto')
        if (代 !== 语音.代) {
          录音器.cancel?.()
          停流(流)
          return
        }
        语音.录音器 = 录音器
        const 开始 = Date.now()
        语音.态.set((旧) => ({ ...旧, phase: 'recording', startedAt: 开始, mime: 录音器.mime }))
        语音.计时器 = setInterval(() => {
          const 秒 = Math.floor((Date.now() - 开始) / 1000)
          const 电平值 = 录音器.读取电平()
        语音.态.set((旧) => (旧.phase === 'recording'
          ? { ...旧, seconds: 秒, level: 电平值, peak: Math.max(旧.peak || 0, 电平值) }
          : 旧))
          if (秒 >= 300) void 停止录音()
        }, 200)
      } catch {
        清理录音()
        停流(流)
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音启动失败，请检查麦克风后重试。' }))
        安排关闭(8000)
      }
    }

    async function 停止录音() {
      const 态 = 语音.态.get()
      if (态.phase !== 'recording' || !语音.录音器) return
      const 代 = 语音.代
      if (语音.计时器) { clearInterval(语音.计时器); 语音.计时器 = null }
      const 录音器 = 语音.录音器
      语音.录音器 = null
      let 结果
      try {
        结果 = await 录音器.stop()
      } catch {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '结束录音失败，请重试。' }))
        安排关闭(8000)
        return
      }
      // 等待 MediaRecorder 收尾期间用户可能已经取消/关了面板。
      if (代 !== 语音.代) return
      const 时长 = Math.max(0, Date.now() - Number(态.startedAt || Date.now()))
      const 大小 = 结果.blob.size
      if (时长 > 5 * 60 * 1000) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音超过 5 分钟已停止，请分段录制。' }))
        安排关闭(8000)
        return
      }
      if (大小 > 25 * 1024 * 1024) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音超过 25MB 已停止，请缩短录音时长。' }))
        安排关闭(8000)
        return
      }
      if (大小 < 600) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '没有录到声音（录音过短），请点「重新录」重试。' }))
        安排关闭(8000)
        return
      }
      if (!结果.blob || 结果.blob.size < 1500) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '没有采集到声音，请检查麦克风是否可用后重试。' }))
        return
      }
      if (时长 < 300) {
        语音.态.set((旧) => ({ ...旧, phase: 'error', error: '录音太短，请多说几秒再停止。' }))
        return
      }
      // 峰值一直贴着 0：麦克风多半被静音 / 选成了虚拟设备 / 系统输入源不对。
      if ((态.peak || 0) < 0.008) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'error',
          error: 补设备提示(`没有检测到声音${态.micLabel ? `（当前麦克风：${态.micLabel}）` : ''}。请检查系统声音设置里的输入设备是否被静音，或改为默认麦克风后重试。`, 态.micLabel),
        }))
        安排关闭(10000)
        return
      }
      语音.片段 = { blob: 结果.blob, mime: 结果.mime, durationMs: 时长 }
      语音.态.set((旧) => ({
        ...旧,
        phase: 'choose',
        durationMs: 时长,
        bytes: 大小,
        mime: 结果.mime,
        choice: 偏好.get().config.rememberVoiceChoice === false ? '' : 记住的选择(),
        error: '',
        hint: '',
      }))
    }

    function 取消录音() {
      语音.代 += 1
      清理录音()
      语音.片段 = null
      语音.插入位 = null
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      语音.态.set({ ...语音.态.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    function 关闭语音面板() {
      语音.代 += 1
      清理录音()
      语音.片段 = null
      语音.插入位 = null
      if (语音.关闭定时) { clearTimeout(语音.关闭定时); 语音.关闭定时 = null }
      语音.态.set({ ...语音.态.get(), phase: 'idle', seconds: 0, level: 0, hint: '', error: '', text: '', pendingText: '', path: '' })
    }

    /** 往输入框插文字：先按录音开始时的光标，再按当前光标；都不行就复制到剪贴板。 */
    function 插入文本(inputActions, 文本) {
      const 值 = String(文本 == null ? '' : 文本)
      if (!值) return false
      const 试 = (位) => {
        try { return inputActions?.insertText?.(值, 位) === true } catch { return false }
      }
      if (试(语音.插入位)) return true
      let 当前 = null
      try { 当前 = inputActions?.captureInsertion?.() ?? null } catch { 当前 = null }
      if (试(当前)) return true
      try { navigator.clipboard?.writeText?.(值) } catch { /* 剪贴板也可能被拒 */ }
      return false
    }

    function 语音扩展(mime) {
      const 类型 = String(mime || '').toLowerCase()
      if (类型.includes('wav')) return '.wav'
      if (类型.includes('ogg') || 类型.includes('opus')) return '.ogg'
      if (类型.includes('mp4') || 类型.includes('m4a')) return '.m4a'
      return '.webm'
    }

    async function 转文字(inputActions) {
      const 态 = 语音.态.get()
      if (!语音.片段 || 态.phase === 'transcribing' || 态.phase === 'uploading') return
      const 代 = 语音.代
      const 配置 = 偏好.get().config || {}
      语音.态.set((旧) => ({ ...旧, phase: 'transcribing', error: '', hint: '' }))
      const 表单 = new FormData()
      表单.append('file', 语音.片段.blob, `voice${语音扩展(语音.片段.mime)}`)
      表单.append('durationMs', String(语音.片段.durationMs || 0))
      表单.append('language', 配置.asrLanguage || 'auto')
      表单.append('speaker', 'false')
      const r = await postForm('/transcribe-upload', 表单)
      if (代 !== 语音.代) return
      if (!r || !r.ok) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'choose',
          error: 补设备提示((r && r.hint) || '转写失败，请稍后重试。', 旧.micLabel),
        }))
        return
      }
      const 文本 = String(r.text || '').trim()
      if (!文本) {
        语音.态.set((旧) => ({
          ...旧,
          phase: 'choose',
          error: 补设备提示('没有识别出文字，可以重新录制。', 旧.micLabel),
        }))
        return
      }
      const 插入成功 = 插入文本(inputActions, 文本)
      const 录音秒数 = Math.max(0, Math.round(Number(语音.片段?.durationMs || 0) / 1000))
      记住选择('text')
      语音.片段 = null
      语音.插入位 = null
      语音.态.set((旧) => ({
        ...旧,
        phase: 'done',
        text: 文本,
        pendingText: 插入成功 ? '' : 文本,
        elapsedMs: Number(r.ms) || 0,
        choice: 'text',
        error: '',
        hint: 插入成功
          ? `已转写 ${文本.length} 字（录音 ${录音秒数} 秒），文字已插入输入框，可以继续编辑。`
          : `已转写 ${文本.length} 字，但未能插入输入框；文字已复制到剪贴板，也可点「重试插入」或「复制文字」。`,
      }))
      安排关闭(插入成功 ? 4500 : 12000)
    }

    async function 保留语音(inputActions) {
      if (!语音.片段) return
      const 代 = 语音.代
      语音.态.set((旧) => ({ ...旧, phase: 'uploading', error: '', hint: '' }))
      const 表单 = new FormData()
      表单.append('file', 语音.片段.blob, `voice${语音扩展(语音.片段.mime)}`)
      表单.append('durationMs', String(语音.片段.durationMs || 0))
      const r = await postForm('/voice-upload', 表单)
      if (代 !== 语音.代) return
      if (!r || !r.ok) {
        语音.态.set((旧) => ({ ...旧, phase: 'choose', error: (r && r.hint) || '音频保存失败，请稍后重试。' }))
        return
      }
      const 路径 = String(r.path || '')
      const 插入成功 = 插入文本(inputActions, `（语音附件：${路径}）\n`)
      记住选择('audio')
      语音.插入位 = null
      语音.态.set((旧) => ({
        ...旧,
        phase: 'done',
        path: 路径,
        text: '',
        pendingText: '',
        choice: 'audio',
        error: '',
        hint: 插入成功
          ? `录音已保存在本机：${路径}\n暂不支持把录音作为附件发送，已把保存位置插入输入框（可删除，也可继续补充文字）。`
          : `录音已保存在本机：${路径}\n保存位置未能插入输入框，已复制到剪贴板。`,
      }))
      // 片段先留着：面板里还有「补上文字」按钮。
      安排关闭(12000)
    }

    // ---------------- 语音输入：麦克风按钮 ----------------

    function 麦克风按钮(props) {
      const { sessionId, inputActions } = props || {}
      const 态 = useStore(语音.态)
      const 偏好态 = useStore(偏好)

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      const 本会话 = !态.sessionId || !sessionId || 态.sessionId === sessionId
      const 录音中 = 本会话 && 态.phase === 'recording'
      const 请求中 = 本会话 && 态.phase === 'requesting'
      const 离线 = 偏好态.在线 === false

      const 点 = () => {
        if (录音中) { void 停止录音(); return }
        if (态.phase === 'recording') return
        if (态.phase === 'idle' || 态.phase === 'error') { void 开始录音({ sessionId, inputActions }); return }
        // 面板开着时再点麦克风 = 关掉面板（录音中除外，上面已处理）。
        if (!录音中) 关闭语音面板()
      }

      const 标题 = 录音中 ? `正在录音 ${格式时间(态.seconds)}，点击结束`
        : 请求中 ? '正在请求麦克风…'
          : 离线 ? '语音输入（本地 AI 未启动）'
            : '语音输入：点击开始录音'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-rec': 录音中 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-pressed': 录音中 ? 'true' : 'false',
          // 别让点击按钮夺走编辑器焦点：captureInsertion() 要拿的是当前草稿选区。
          onMouseDown: (事件) => { try { 事件.preventDefault() } catch { /* 忽略 */ } },
          onClick: 点,
        },
          录音中 ? h('span', { className: 'fish-dot' }) : 请求中 ? 图标转圈() : 图标麦克风(),
          录音中 ? h('span', { style: { fontSize: 11, fontVariantNumeric: 'tabular-nums' } }, 格式时间(态.seconds)) : null))
    }

    function 格式时间(秒数) {
      const 总 = Math.max(0, Math.trunc(Number(秒数) || 0))
      const 分 = Math.floor(总 / 60)
      const 秒 = 总 % 60
      return `${分}:${String(秒).padStart(2, '0')}`
    }

    // ---------------- 语音输入：三选一面板（composer overlay） ----------------

    function 波形({ 电平, 录音中 }) {
      const 条 = []
      for (let i = 0; i < 18; i++) {
        const 起伏 = 0.35 + ((i * 37) % 10) / 14
        const 高 = 3 + Math.min(1, (录音中 ? 电平 : 0) * 起伏) * 19
        条.push(h('i', { key: i, style: { height: `${Math.max(3, 高)}px` } }))
      }
      return h('span', { className: 'fish-wave', 'aria-hidden': true }, 条)
    }

    function 语音面板(props) {
      const { sessionId, inputActions } = props || {}
      const 态 = useStore(语音.态)
      const 偏好态 = useStore(偏好)

      React.useEffect(() => {
        保活(true)
        return () => {
          保活(false)
          // 切换会话/卸载输入框时别把录音丢在后台跑（最多能录 5 分钟）。
          const 现 = 语音.态.get()
          if (现.phase === 'recording' && (!sessionId || 现.sessionId === sessionId)) 取消录音()
        }
      }, [sessionId])

      // 录音中没有 sessionId 也要显示（会话说变就变），面板只服务当前会话。
      if (态.phase === 'idle') return null
      if (态.sessionId && sessionId && 态.sessionId !== sessionId) return null

      const 记住 = 偏好.get().config.rememberVoiceChoice !== false ? 记住的选择() : ''
      const 高亮 = (选择) => (态.choice || 记住) === 选择
      const 忙碌 = 态.phase === 'uploading' || 态.phase === 'transcribing'
      const 可取消 = 态.phase !== 'recording' && !忙碌

      const 标题 = 态.phase === 'requesting' ? '正在请求麦克风…'
        : 态.phase === 'recording' ? '正在录音'
          : 态.phase === 'choose' ? `录音已完成（${格式时间(Math.round((态.durationMs || 0) / 1000))}）`
            : 态.phase === 'transcribing' ? '正在转写…'
              : 态.phase === 'uploading' ? '正在保存录音…'
                : 态.phase === 'done' ? '完成'
                  : '语音输入'

      const 行 = []

      if (态.phase === 'requesting') {
        行.push(h('div', { key: 'req', className: 'fish-panel-dim' }, '浏览器会询问是否允许使用麦克风，允许后开始录音。'))
      }

      if (态.phase === 'recording') {
        行.push(h('div', { key: 'rec', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('span', { className: 'fish-dot' }),
          h('span', { style: { fontVariantNumeric: 'tabular-nums', fontWeight: 600 } }, 格式时间(态.seconds)),
          h(波形, { 电平: 态.level, 录音中: true }),
          h('span', { className: 'fish-panel-dim' }, '录音中｜最长 5 分钟')))
        行.push(h('div', { key: 'mic', className: 'fish-panel-dim', style: { marginTop: 4 } },
          `音量 ${Math.min(100, Math.round((态.level || 0) * 100))}%`
            + (态.micLabel ? `｜麦克风：${态.micLabel}` : '')
            + ((态.level || 0) < 0.01 && (态.seconds || 0) > 1 ? '（几乎没有声音，请检查麦克风）' : '')))
        if (态.hint) {
          行.push(h('div', { key: 'mic-hint', className: 'fish-panel-dim', style: { marginTop: 4 } }, 态.hint))
        }
        行.push(h('div', { key: 'acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => void 停止录音() }, '停止并选择'),
          h('button', { type: 'button', className: 'fish-btn', onClick: 取消录音 }, '取消录音')))
      }

      if (态.phase === 'choose') {
        行.push(h('div', { key: 'tip', className: 'fish-panel-dim' }, '请选择这段录音的用法。'))
        行.push(h('div', { key: 'choose', className: 'fish-panel-row' },
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('text') ? '1' : undefined,
            onClick: () => void 转文字(inputActions),
          }, '转文字'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('audio') ? '1' : undefined,
            onClick: () => void 保留语音(inputActions),
          }, '保留语音'),
          h('button', {
            type: 'button',
            className: 'fish-btn',
            'data-primary': 高亮('cancel') ? '1' : undefined,
            onClick: () => { 记住选择('cancel'); 取消录音() },
          }, '取消')))
        行.push(h('div', { key: 'sub', className: 'fish-panel-dim' }, '上次的选择会高亮，但不会自动执行；转成的文字会插入光标处，可以继续修改。'))
      }

      if (忙碌) {
        行.push(h('div', { key: 'busy', style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { className: 'fish-spin', style: { display: 'inline-flex' } }, 图标转圈()),
          h('span', null, 态.phase === 'transcribing' ? '正在转写，首次使用需要加载模型，可能要等一会儿…' : '正在保存录音…')))
        行.push(h('div', { key: 'busy-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭面板（转写继续在后台进行）')))
      }

      if (态.phase === 'done') {
        行.push(h('div', { key: 'hint', className: 'fish-ok', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, 态.hint))
        if (态.pendingText) {
          行.push(h('div', { key: 'pending', className: 'fish-panel-dim', style: { marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 110, overflow: 'auto' } }, 态.pendingText))
          行.push(h('div', { key: 'pending-acts', className: 'fish-panel-row' },
            h('button', {
              type: 'button', className: 'fish-btn', 'data-primary': '1',
              onClick: () => {
                const 成 = 插入文本(inputActions, 态.pendingText)
                语音.态.set((旧) => ({ ...旧, hint: 成 ? `已插入 ${态.pendingText.length} 字。` : '仍无法插入；文字已复制到剪贴板，请按 Ctrl+V 粘贴。', pendingText: 成 ? '' : 态.pendingText }))
              },
            }, '重试插入'),
            h('button', {
              type: 'button', className: 'fish-btn',
              onClick: () => { try { navigator.clipboard?.writeText?.(态.pendingText) } catch { /* 忽略 */ } },
            }, '复制文字')))
        }
        if (态.path && !态.text && 语音.片段) {
          行.push(h('div', { key: 'extra', className: 'fish-panel-row' },
            h('button', { type: 'button', className: 'fish-btn', onClick: () => void 转文字(inputActions) }, '补充文字（可选）')))
        }
        行.push(h('div', { key: 'done-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭')))
      }

      if (态.phase === 'error') {
        行.push(h('div', { key: 'err', className: 'fish-err', style: { whiteSpace: 'pre-wrap' } }, 态.error || '未能完成'))
        行.push(h('div', { key: 'err-acts', className: 'fish-panel-row' },
          h('button', { type: 'button', className: 'fish-btn', onClick: 关闭语音面板 }, '关闭'),
          h('button', { type: 'button', className: 'fish-btn', 'data-primary': '1', onClick: () => { 关闭语音面板(); void 开始录音({ sessionId, inputActions }) } }, '重新录')))
      }

      if (态.error && 态.phase !== 'error' && !忙碌) {
        行.push(h('div', { key: 'err2', className: 'fish-err', style: { marginTop: 4 } }, 态.error))
      }

      return h(React.Fragment, null,
        h('div', { className: 'fish-panel', role: 'dialog', 'aria-label': '语音输入' },
          h('div', { className: 'fish-panel-title' },
            h('span', { style: { display: 'inline-flex' } }, 态.phase === 'recording' ? h('span', { className: 'fish-dot' }) : 图标麦克风(15)),
            h('span', null, 标题),
            h('span', { style: { flex: 1 } }),
            可取消 ? h('button', {
              type: 'button', className: 'fish-iconbtn', title: '关闭', 'aria-label': '关闭',
              onClick: 关闭语音面板,
            }, h('span', { style: { fontSize: 15, lineHeight: 1 } }, '×')) : null),
          行,
          h('div', { className: 'fish-panel-dim', style: { marginTop: 8 } },
            偏好态.在线 === false
              ? '本地 AI 未启动，转写暂不可用，请先启动。'
              : '录音只在本机处理，不联网，也不产生额外费用。')))
    }

    // ---------------- 自动朗读开关（输入框左侧） ----------------

    function 自动朗读开关(props) {
      const 偏好态 = useStore(偏好)
      const [忙, 设忙] = React.useState(false)
      const 会话键 = String(props?.sessionId || '')
      const 可设置 = 会话键合法(会话键)

      React.useEffect(() => {
        保活(true)
        if (!偏好.get().载入) void 载入偏好()
        return () => 保活(false)
      }, [])

      const 开 = 读会话自动朗读(偏好态.config, 会话键)
      // 偏好还没读回来时不写：否则空表会把其它会话已有的设置覆盖掉。
      const 就绪 = 可设置 && 偏好态.载入
      const 切 = async () => {
        if (忙 || !就绪) return
        设忙(true)
        const 新配置 = 写会话自动朗读(偏好.get().config || {}, 会话键, !开)
        const r = await post('/save', { config: { autoReadSessions: 新配置.autoReadSessions } })
        设忙(false)
        if (r && r.ok) {
          偏好.set((旧) => ({
            ...旧,
            config: r.config
              ? { ...(旧.config || {}), ...r.config }
              : { ...(旧.config || {}), autoReadSessions: 新配置.autoReadSessions },
          }))
        }
      }
      const 标题 = !可设置 ? '当前会话暂不支持单独设置自动朗读'
        : !偏好态.载入 ? '正在读取自动朗读设置…'
          : 开 ? '本会话自动朗读已开启，点击关闭'
            : '本会话自动朗读已关闭，点击开启'

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'fish-iconbtn',
          'data-on': 开 ? '1' : undefined,
          title: 标题,
          'aria-label': 标题,
          'aria-pressed': 开 ? 'true' : 'false',
          disabled: 忙 || !就绪,
          onClick: 切,
        }, 图标发声(14), h('span', { style: { fontSize: 11.5 } }, 开 ? '自动朗读 开' : '自动朗读 关')))
    }

    // ================================================================
    // 设置页（P1 状态 + P2 朗读 / 语音输入）
    // ================================================================

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
      h2: { fontSize: 13.5, fontWeight: 650, margin: '0 0 8px' },
      dim: { opacity: 0.62, fontSize: 12 },
      ask: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        marginLeft: 4,
        borderRadius: '50%',
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: 10,
        lineHeight: 1,
        opacity: 0.62,
        cursor: 'help',
        userSelect: 'none',
        verticalAlign: 'text-bottom',
      },
      link: {
        border: 0,
        padding: 0,
        background: 'transparent',
        color: 'inherit',
        fontSize: 12,
        opacity: 0.62,
        cursor: 'pointer',
        textDecoration: 'underline',
      },
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
      tts: '文字转语音',
      asr: '语音识别',
      translate: '翻译',
      separate: '人声分离',
      vision: '视觉关键帧',
      media: '媒体探测',
      download: '下载',
      jobs: '任务队列',
    }
    const 原因中文 = {
      service_down: '本地 AI 未启动',
      model_missing: '模型未下载',
      not_supported: '当前版本不支持',
      api_incompatible: '版本不兼容',
    }

    // 设置页给用户看的字段名；环境变量覆盖提示只显示中文名。
    const 配置中文 = {
      baseUrl: '服务地址',
      apiVersion: '服务版本',
      requestTimeoutMs: '请求超时',
      asrTimeoutMs: '语音识别超时',
      visionTimeoutMs: '视觉分析超时',
      healthIntervalMs: '状态检查间隔',
      ttsVoice: '默认音色',
      ttsSpeed: '语速',
      readMaxChars: '单次最大字数',
      readConcurrency: '同时生成',
      readSkipCode: '去掉代码块',
      autoRead: '新会话默认自动朗读',
      recordMime: '录音格式',
      recordDeviceId: '输入设备',
      asrLanguage: '识别语言',
      rememberVoiceChoice: '记住上次选择',
      cacheDir: '缓存目录',
      cacheMaxMb: '缓存上限',
      cacheTtlHours: '缓存保留时长',
      enabled: '总开关',
      enabledCapabilities: '启用的能力',
      installDir: '安装目录',
      logLevel: '日志级别',
      token: '访问令牌',
    }

    const 提示 = (文本) => h('div', { style: S.hint }, 文本)

    /** 「?」提示控件：文案短了说不清时，鼠标悬浮（或键盘聚焦）展开完整说明。 */
    const 问号 = (说明) => h('span', {
      style: S.ask,
      role: 'img',
      tabIndex: 0,
      title: 说明,
      'aria-label': 说明,
    }, '?')

    /**
     * 一行设置。说明只保留一种形式，二选一：
     *   字符串        → 控件下方一行短句；
     *   { 问: '…' }   → 标签后的「?」，悬浮展开。
     */
    const 行 = (标签, 控件, 说明) => {
      const 问文 = 说明 && typeof 说明 === 'object' && typeof 说明.问 === 'string' ? 说明.问 : ''
      const 短句 = typeof 说明 === 'string' ? 说明 : ''
      return h('div', { style: S.row },
        h('div', { style: S.lab },
          h('span', null, 标签),
          问文 ? 问号(问文) : null),
        h('div', { style: S.ctl }, 控件, 短句 ? 提示(短句) : null))
    }

    /** 可折叠的一块内容：默认收起，标题旁给一行摘要，避免大段内容铺满设置页。 */
    function 折叠块(props) {
      const { 摘要, 默认展开 = false, 展开字样 = '展开', 收起字样 = '收起', children } = props || {}
      const [开, 设开] = React.useState(默认展开)
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: S.dim }, 摘要 || ''),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            style: S.link,
            'aria-expanded': 开 ? 'true' : 'false',
            onClick: () => 设开(!开),
          }, 开 ? 收起字样 : 展开字样)),
        h('div', { style: { display: 开 ? 'block' : 'none', marginTop: 8 } }, children))
    }

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
        className: 'fish-select',
        style: S.small,
        value: 值 == null ? '' : String(值),
        onChange: (e) => onChange(e.target.value),
      }, 选项.map((项) => h('option', { key: 项.value, value: 项.value }, 项.label)))
    }

    function 勾(值, onChange) {
      return h('input', { type: 'checkbox', checked: Boolean(值), onChange: (e) => onChange(e.target.checked) })
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
      const [缓存统计, 设缓存统计] = React.useState(null)
      const 语音态 = useStore(语音.态)
      const 设备态 = useStore(设备)

      const 拉 = async () => {
        const s = await get('/state')
        if (s && s.ok) {
          设态(s)
          偏好.set((旧) => ({
            ...旧,
            载入: true,
            在线: Boolean(s.health && s.health.reachable),
            config: s.config || {},
            健康: s.health || null,
            音色: Array.isArray(s.voices) ? s.voices : [],
            插件: s.plugin || {},
          }))
        }
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
          if (r.config) {
            偏好.set((旧) => ({ ...旧, config: { ...r.config } }))
          }
          await 拉()
        } else {
          设说('保存失败：' + String((r && (r.hint || r.message)) || '请稍后重试。'))
        }
      }

      const 测试 = async () => {
        设忙(true); 设说('正在测试连接…')
        const r = await post('/test', { timeoutMs: 4000 })
        设忙(false)
        if (r && r.ok) 设说(`连接正常，延迟 ${r.latencyMs || 0} 毫秒。`)
        else 设说(`连接失败：${(r && r.hint) || '本地 AI 未启动，请先启动。'}`)
        await 拉()
      }

      const 看日志 = async () => {
        设忙(true)
        const r = await get('/logs?lines=200')
        设忙(false)
        设日志(r && r.ok ? r.lines : null)
      }

      const 拉缓存统计 = async () => {
        const r = await get('/cache/stats')
        if (r && r.ok) 设缓存统计(r)
      }

      const 清缓存 = async () => {
        设忙(true)
        const r = await post('/cache/clear', { kind: 'tts' })
        设忙(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytes || 0) / 1024 / 1024) * 10) / 10
          设说(`已清空朗读缓存（${r.files || 0} 个文件，释放 ${mb} MB）。下次朗读会重新生成语音。`)
        } else {
          设说(`清空缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await 拉()
        await 拉缓存统计()
      }

      const 清过期 = async () => {
        设忙(true)
        const r = await post('/cache/cleanup', {})
        设忙(false)
        if (r && r.ok) {
          const mb = Math.round(((r.bytesFreed || 0) / 1024 / 1024) * 10) / 10
          设说(`已清理过期缓存 ${r.expired || 0} 个、超出上限 ${r.lru || 0} 个，释放 ${mb} MB。`)
        } else {
          设说(`清理缓存失败：${(r && r.hint) || '请稍后重试。'}`)
        }
        await 拉()
        await 拉缓存统计()
      }

      React.useEffect(() => { void 拉缓存统计() }, [])

      const 打开缓存目录 = async () => {
        const r = await post('/open-folder', { path: String(配置.cacheDir || 缓存.dir || '').trim() })
        if (r && r.ok) 设说('已在文件管理器中打开缓存目录。')
        else 设说(`打开文件夹失败：${(r && r.hint) || '请手动打开。'}`)
      }

      const 打开管理界面 = async () => {
        const r = await post('/open-webui', {})
        if (r && r.ok) 设说('已在默认浏览器中打开管理界面。')
        else 设说(`打开管理界面失败：${(r && r.hint) || '请稍后重试。'}`)
      }

      if (!态) {
        return h('div', { className: 'fish-service-settings', style: S.wrap },
          h('div', { style: S.h1 }, '本地 AI'),
          h('div', { style: S.dim }, '正在读取状态…'))
      }

      const 能力名们 = Object.keys(能力中文)
      const 可用数 = 能力名们.filter((名) => 能力表[名] && 能力表[名].available).length
      const 能力块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '能力'),
        h('div', { style: { ...S.dim, marginBottom: 6 } },
          `${可用数} / ${能力名们.length} 项可用`),
        h(折叠块, {
          摘要: '',
          默认展开: 可用数 < 能力名们.length,
          展开字样: '查看各项',
          收起字样: '收起',
        },
          h('div', { style: S.chips }, 能力名们.map((名) => {
            const 信息 = 能力表[名] || {}
            const 可用 = Boolean(信息.available)
            const 原因 = 信息.reason ? (原因中文[信息.reason] || '原因未知') : ''
            return h('div', { key: 名, style: S.chip },
              h('div', { style: { fontWeight: 600 } }, 能力中文[名]),
              h('div', { style: 可用 ? S.ok : S.danger },
                可用 ? `可用${信息.loaded ? '（已加载）' : ''}` : `不可用（${原因 || '原因未知'}）`))
          })),
          能力表.tts && !能力表.tts.available && 能力表.tts.reason === 'service_down'
            ? h('div', { style: { ...S.danger, marginTop: 8 } }, '本地 AI 未启动，请先启动。')
            : null))

      const 音色选项 = [{ value: 配置.ttsVoice || 'dafeiyu', label: 配置.ttsVoice || 'dafeiyu' }]
      for (const 名 of 音色们) {
        if (!音色选项.some((x) => x.value === 名)) 音色选项.push({ value: 名, label: 名 })
      }

      const 服务块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '服务连接'),
        行('服务地址', 输入(配置.baseUrl, (v) => 改('baseUrl', v), ''),
          { 问: '一般不用改；改了地址后点「测试连接」确认。' }),
        行('请求超时（秒）', h('input', {
          style: S.small, type: 'number', min: 1, max: 1800,
          value: Math.round((Number(配置.requestTimeoutMs) || 180000) / 1000),
          onChange: (e) => 改('requestTimeoutMs', Number(e.target.value) * 1000),
        }), { 问: '只影响一般请求；识别、分离与视觉分析另有更长的等待时间。' }),
        行('总开关', 勾(配置.enabled !== false, (v) => 改('enabled', v)),
          '关闭后朗读与语音输入都不可用。'),
        行('管理界面',
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              style: S.btn,
              onClick: 打开管理界面,
              disabled: !在线 || 忙,
            }, '打开管理界面'),
            状态点(在线, 在线 ? '在线' : '离线')),
          在线 ? '' : '先启动本地 AI 再打开。'),
        (态.envOverrides && 态.envOverrides.length)
          ? h('div', { style: { ...S.danger, marginTop: 4 } },
              `以下设置已由系统统一指定，在设置页修改不会生效：${态.envOverrides.map((名) => 配置中文[名] || '其他设置').join('、')}`)
          : null)

      const 朗读块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '朗读'),
        行('默认音色', 下拉(配置.ttsVoice || 'dafeiyu', 音色选项, (v) => 改('ttsVoice', v))),
        行('语速', h('input', {
          style: S.small, type: 'number', min: 0.5, max: 2, step: 0.05,
          value: 配置.ttsSpeed ?? 1,
          onChange: (e) => 改('ttsSpeed', Number(e.target.value)),
        })),
        行('去掉代码块', 勾(配置.readSkipCode !== false, (v) => 改('readSkipCode', v)),
          '关闭后只提示「代码块，共 N 行」。'),
        行('单次最大字数', h('input', {
          style: S.small, type: 'number', min: 200, max: 5000, step: 100,
          value: 配置.readMaxChars ?? 2000,
          onChange: (e) => 改('readMaxChars', Number(e.target.value)),
        }), { 问: '超过 2 万字的部分不朗读；长内容会自动分段。' }),
        行('同时生成', h('input', {
          style: S.small, type: 'number', min: 1, max: 4, step: 1,
          value: 配置.readConcurrency ?? 2,
          onChange: (e) => 改('readConcurrency', Number(e.target.value)),
        }), { 问: '数值越大出声越快、更占显存；卡顿时调低。' }),
        行('新会话默认自动朗读', 勾(配置.autoRead === true, (v) => 改('autoRead', v)),
          { 问: '只影响未单独设置过的会话；每个会话可单独开关。' }),
        行('后台也自动朗读', 勾(配置.autoReadInBackground !== false, (v) => 改('autoReadInBackground', v)),
          '切到后台或最小化时仍会朗读，会占用扬声器，可能打扰他人。'))

      const 已选设备标识 = String(配置.recordDeviceId || '')
      const 设备选项 = [{ value: '', label: '系统默认' }]
      for (const 项 of 设备态.列表) {
        if (!设备选项.some((x) => x.value === 项.deviceId)) 设备选项.push({ value: 项.deviceId, label: 项.label })
      }
      let 已选设备名 = '系统默认'
      if (已选设备标识) {
        const 命中 = 设备选项.find((x) => x.value === 已选设备标识)
        已选设备名 = (命中 && 命中.label)
          || (设备态.最近标识 === 已选设备标识 ? 设备态.最近名称 : '')
          || '名称未确认（请刷新设备列表）'
        if (!命中) 设备选项.push({ value: 已选设备标识, label: 已选设备名 })
      }
      const 录音中 = 语音态.phase === 'recording'
      const 输入音量 = 录音中 ? `${Math.min(100, Math.round((语音态.level || 0) * 100))}%` : '—'
      const 设备状态 = `已选：${已选设备名}｜上次录音：${设备态.最近名称 || '—'}｜当前音量：${输入音量}`

      const 语音块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '语音输入'),
        行('输入设备',
          h('div', null,
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
              下拉(已选设备标识, 设备选项, (v) => 改('recordDeviceId', v)),
              h('button', {
                type: 'button',
                style: S.btn,
                disabled: 设备态.枚举中,
                onClick: () => { void 刷新设备列表() },
              }, 设备态.枚举中 ? '读取中…' : '刷新设备列表')),
            h('div', { style: { marginTop: 2 } },
              设备状态,
              设备态.提示 ? h('div', { style: { marginTop: 2 } }, 设备态.提示) : null)),
          { 问: '有多支麦克风或录音无声时可指定；虚拟设备常录不到人声。' }),
        行('录音格式', 下拉(配置.recordMime || 'auto', [
          { value: 'auto', label: '自动（推荐）' },
          { value: 'webm', label: '体积较小' },
          { value: 'wav', label: '体积较大' },
        ], (v) => 改('recordMime', v)), { 问: '转写结果异常时，换一种格式再试。' }),
        行('识别语言', 下拉(配置.asrLanguage || 'auto', [
          { value: 'auto', label: '自动判断' },
          { value: 'zh', label: '中文' },
          { value: 'en', label: '英文' },
          { value: 'ja', label: '日文' },
        ], (v) => 改('asrLanguage', v))),
        行('记住上次选择', 勾(配置.rememberVoiceChoice !== false, (v) => 改('rememberVoiceChoice', v)),
          '只高亮上次的选项，不会自动执行。'),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '录音最长 5 分钟、最大 25MB。'))

      const 缓存块 = h('div', { style: S.card },
        h('div', { style: S.h2 }, '缓存'),
        h('div', { style: S.dim },
          `当前占用 ${缓存.mb || 0} MB，共 ${缓存.files || 0} 个文件。`),
        h(折叠块, {
          摘要: 缓存统计
            ? `已复用 ${缓存统计.hits || 0} 次，复用率 ${Math.round((缓存统计.hitRate || 0) * 1000) / 10}%`
            : '统计读取中…',
          展开字样: '查看明细',
          收起字样: '收起明细',
        },
          行('保存位置',
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              输入(配置.cacheDir, (v) => 改('cacheDir', v), ''),
              h('button', { type: 'button', style: S.btn, onClick: 打开缓存目录, disabled: 忙 }, '打开文件夹')),
            { 问: '朗读音频、分离音轨、关键帧和保留的录音都在这里。' }),
          行('缓存上限（MB）', h('input', {
            style: S.small, type: 'number', min: 256, max: 10240, step: 256,
            value: 配置.cacheMaxMb ?? 2048,
            onChange: (e) => 改('cacheMaxMb', Number(e.target.value)),
          }), '超出上限时先删最久没用的文件。'),
          行('保留时长（小时）', h('input', {
            style: S.small, type: 'number', min: 1, max: 720, step: 1,
            value: 配置.cacheTtlHours ?? 72,
            onChange: (e) => 改('cacheTtlHours', Number(e.target.value)),
          }), '过期的文件会自动清理。'),
          h('div', { style: { ...S.dim, marginTop: 4 } },
            '已缓存音频：' + (缓存统计
              ? `${缓存统计.files || 0} 段 / ${(Math.round(((缓存统计.bytes || 0) / 1024 / 1024) * 10) / 10)} MB；`
                + `复用 ${缓存统计.hits || 0} 次、重新生成 ${缓存统计.misses || 0} 次（本次运行以来）`
              : '统计读取中…'))),
        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btn, onClick: 清缓存, disabled: 忙 }, '清空朗读缓存'),
          h('button', { type: 'button', style: S.btn, onClick: 清过期, disabled: 忙 }, '清理过期缓存')),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '清空后下次朗读会重新生成。'))

      const 动作块 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 8, marginTop: 2, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: S.btnOn, onClick: 存, disabled: 忙 }, 忙 ? '处理中…' : '保存设置'),
          h('button', { type: 'button', style: S.btn, onClick: 测试, disabled: 忙 }, '测试连接'),
          h('button', {
            type: 'button',
            style: S.btn,
            onClick: () => { void 拉(); void 拉缓存统计() },
            disabled: 忙,
          }, '重新读取')),
        h('div', { style: { ...S.dim, marginTop: 6 } },
          '保存后立即生效，不用重启。'))

      const 状态块 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('div', { style: S.h1 }, '本地 AI'),
          h('span', { style: { ...S.badge, ...(在线 ? S.ok : S.danger) } },
            在线 ? `在线${兼容 ? '' : '（版本不兼容）'} · v${健康.serviceVersion || '?'}` : '未启动'),
          h('span', { style: S.dim }, `插件 v${(态.plugin && 态.plugin.version) || '?'}`)),
        h('div', { style: S.dim },
          `延迟 ${健康.latencyMs || 0} 毫秒`
          + (健康.vram ? `｜显存 ${健康.vram.freeMb || 0}/${健康.vram.totalMb || 0} MB` : '')
          + `｜最近检查 ${健康.checkedAt ? new Date(健康.checkedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}`),
        h('div', { style: { ...S.dim, marginTop: 2 } },
          '朗读、语音输入与各项能力都在本机完成，不联网，也不产生额外费用。'),
        (健康.lastError && 健康.lastError.hint)
          ? h('div', { style: { ...S.danger, marginTop: 4 } }, `最近错误：${健康.lastError.hint}`)
          : null,
        (态.errors && 态.errors.length)
          ? h('div', { style: { ...S.dim, marginTop: 4 } },
              `最近有 ${态.errors.length} 条错误，最新：${态.errors[态.errors.length - 1].hint || '未知错误'}`)
          : null)

      const 日志块 = h('div', { style: S.card },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
          h('div', { style: { ...S.h2, margin: 0 } }, '运行日志'),
          h('span', { style: S.dim }, '最近 200 行'),
          h('span', { style: { flex: 1 } }),
          h('span', { style: S.dim }, '日志级别'),
          下拉(配置.logLevel || 'info', [
            { value: 'debug', label: '详细' },
            { value: 'info', label: '一般' },
            { value: 'warn', label: '仅警告' },
            { value: 'error', label: '仅错误' },
          ], (v) => 改('logLevel', v)),
          h('button', { type: 'button', style: S.btn, onClick: 看日志, disabled: 忙 }, '读取日志')),
        h('pre', { style: S.logs }, 日志 ? 日志.join('\n') : '（点「读取日志」查看）'),
        h('div', { style: { ...S.dim, marginTop: 4 } },
          '遇到问题时读取并复制给维护者。'))

      return h('div', { className: 'fish-service-settings', style: S.wrap },
        状态块,
        能力块,
        朗读块,
        语音块,
        服务块,
        缓存块,
        动作块,
        (说 ? h('div', { style: { ...(说.includes('失败') ? S.danger : S.ok), marginTop: 6 } }, 说) : null),
        日志块)
    }

    // ---------------- 注册 ----------------

    function 注册(ctx, 槽位, 配置项, 组件) {
      try {
        slots注册(ctx, 槽位, 配置项, 组件)
      } catch (error) {
        // 槽位在这个 DSH 版本不存在时不要让整个插件挂掉。
        try { console.warn('[dsh-fish-service] 注册槽位失败', 槽位, error) } catch { /* 忽略 */ }
      }
    }

    function slots注册(ctx, 槽位, 配置项, 组件) {
      const slots = ctx.get('slots')
      if (slots === undefined || typeof slots.register !== 'function') {
        // 与 dsh-peak-scheduler 同样的做法：DSH 启动早期 slots 可能还没好，短重试。
        let 次数 = 0
        const 重试 = () => {
          const 后到 = ctx.get('slots')
          if (!后到 || typeof 后到.register !== 'function') {
            if (次数 < 40) { 次数 += 1; setTimeout(重试, 250) }
            return
          }
          try {
            后到.inject(槽位, () => 后到.register({ name: 槽位, ...配置项 }, 组件))
          } catch {
            if (次数 < 40) { 次数 += 1; setTimeout(重试, 250) }
          }
        }
        重试()
        return
      }
      slots.inject(槽位, () => slots.register({ name: 槽位, ...配置项 }, 组件))
    }

    function apply(ctx) {
      注入样式()
      // 设置页：P1 的「本地 AI」tab（P2 在同一个页面里加分区的）。
      注册(ctx, 'settings.section', { id: 'fish-service', order: 57, label: () => '本地 AI' }, Section)
      // 消息级朗读按钮：助手消息操作行（复制按钮右边）。
      注册(ctx, 'conversation.chat.assistant-actions', { id: 'fish-read', order: 21, label: () => '朗读' }, 朗读按钮)
      // 输入框右侧：麦克风（开始/结束录音）。
      注册(ctx, 'conversation.input.right', { id: 'fish-mic', order: 32, label: () => '语音输入' }, 麦克风按钮)
      // 输入框上方浮层：录音状态 + 三选一面板（DSH 的 overlay 就挂在这里）。
      注册(ctx, 'conversation.input.overlay', { id: 'fish-voice', order: 40, label: () => '语音输入面板' }, 语音面板)
      // 输入框左侧：自动朗读开关。
      注册(ctx, 'conversation.input.left', { id: 'fish-auto-read', order: 45, label: () => '自动朗读' }, 自动朗读开关)

      // 预热一次偏好（不阻塞）；失败也无所谓，组件挂载时会再拉。
      void 载入偏好()
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供单元测试直接验证的纯函数；浏览器运行时不使用。
    exports.__testing = {
      读会话自动朗读,
      写会话自动朗读,
      读后台自动朗读,
      是否自动朗读,
      会话自动朗读上限,
      会话键合法,
      构建录音约束,
      打开麦克风,
      设备不可用错误,
      是虚拟设备名称,
      虚拟设备提示,
    }
    return module.exports
  },
})
