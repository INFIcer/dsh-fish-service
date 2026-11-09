# DSH 本地 AI 插件体系设计（fish-service / fish-ops）与一键部署

> 文档版本：`v0.1`（P0 契约冻结稿）
> 适用：DSH `0.2.2-rc.1`、`localai-service 2.5.x`（HTTP 契约 `api_version = "1"`）
> 最后核对：2026-11-09，基于 `E:\LocalAIService` 实机与 `E:\dsh-fish-message` 源码
> 状态：**只写设计，不写实现**。P1 开工前先评审本文与 [`CONTRACT.md`](CONTRACT.md)。

---

## 1. 范围与术语

| 术语 | 含义 |
| --- | --- |
| 服务层 / localai | `E:\LocalAIService` 的 Python FastAPI 服务，`python -m localai serve`，默认 `127.0.0.1:7880` |
| `fish-service` | 插件 `dsh-fish-service`；DSH 侧唯一知道服务地址的地方 |
| `fish-ops` | 插件 `dsh-fish-ops`；多步调用链编排层，按依赖条件注册 |
| `fish.service` | `fish-service` 通过 `ctx.provide('fish.service', api)` 暴露的 Cordis 服务 |
| `fish.message` | 规划中由 `dsh-fish-message` 暴露的 Cordis 服务（当前 0.1.0 **还没有**） |
| 能力（capability） | 服务层的 `tts / asr / whisper / translate / speaker / separate / media / download / vision / jobs` |
| 单步 / 多步 | 一次 HTTP 能完成的叫单步；需要两个以上插件或两次以上语义步骤的叫多步 |

本文只覆盖 DSH 侧插件与部署；服务层推理实现、模型内部细节不在范围内，必要时引用 `E:\LocalAIService\docs\SERVICE_API.md`。

---

## 2. 背景与现状（真实信息）

### 2.1 本地 AI 服务：`E:\LocalAIService`

**进程与入口**

- 包名 `localai-service`，版本 `2.5.0`；`pyproject.toml` 的 `[project.scripts]` 注册 `localai = "localai.cli:main"`。
- 启动脚本 `E:\LocalAIService\start_ai_service.ps1`（UTF-8 BOM）；实际执行 `engine\.venv\Scripts\python.exe -m localai serve`。
- 默认监听 `127.0.0.1:7880`；`LOCALAI_HOME` 默认项目根；日志 `logs\service.out.log` / `service.err.log`。
- 启动 **0 模型**；TTS / ASR / whisper / 声纹 / Demucs / 翻译 / 视觉各自懒加载；空闲 900 秒（可配）自动卸载；显存不足按 LRU 互卸，腾完仍不够返回 507。

**已实测的环境**

| 项 | 值 |
| --- | --- |
| 服务版本 / 契约 | `2.5.0` / `api_version = "1"` |
| Python / torch | `3.13.9` / `2.11.0+cu130` |
| GPU / 驱动 | RTX 3070 8GB / 591.59，CUDA 13.0 |
| 当前监听 | `127.0.0.1:7880`，PID 13644 |
| 开机自启 | Windows 计划任务 `LocalAIService-Service`，已启用 |
| 数据根 | `E:\LocalAIService`（`/admin/system.paths.home` 可查） |

**目录**

| 目录 | 内容 | 是否随包分发 |
| --- | --- | --- |
| `src\localai\` | 服务层 Python 包（FastAPI 路由、任务调度、WebUI 静态文件） | 是 |
| `engine\` | 原生推理实现（`engine.py`、`asr_engine.py`、`whisper_engine.py`、`indextts_vendor\` 等） | 是（源码） |
| `engine\.venv\` | 虚拟环境，含 torch（实测 6.5 GB） | 否 |
| `models\` | 模型权重（实测 17.7 GB） | 否，按需下载 |
| `voices\` | 音色参考音频（7 个，6.5 MB） | 否，用户数据 |
| `speakers\` | 声纹向量（0.2 MB，不含原始音频） | 否，用户数据 |
| `outputs\` / `data\` / `logs\` | 输出、任务 SQLite、日志 | 否 |
| `docs\SERVICE_API.md` | 完整 HTTP API（2219 行） | 是 |
| `docs\WEBUI.md` | WebUI 与 `/admin/*` 说明 | 是 |
| `docs\PLUGIN_CONTRACT.md` | 已有的「插件只走 HTTP」契约 | 是 |
| `docs\INSTALL.md` | 安装/移植说明 | 是 |

**能力现状（`GET /capabilities` 实测）**

| 能力 | 模型 | 就绪 | 显存估算 | 主要接口 |
| --- | --- | --- | --- | --- |
| `tts` | IndexTTS-2.5 | true | 6400 MB | `POST /tts`、`POST /v1/audio/speech`、`GET /voices` |
| `asr` | SenseVoiceSmall | true | 1200 MB | `POST /asr`、`POST /asr/segments` |
| `whisper` | faster-whisper-small | true | 600 MB | `POST /asr`（`engine=whisper`）、`POST /asr/segments` |
| `translate` | nllb-200-distilled-600M | true | 1500 MB | `POST /translate`、`/translate/batch`、`/jobs/translate` |
| `speaker` | campplus | true | 300 MB | `/speakers/*` |
| `separate` | htdemucs | true | 1000 MB | `POST /separate` |
| `media` | ffmpeg / ffprobe | true | 0 | `/media/probe`、`/media/to_wav`、`/media/frames`、`/media/scenes`、`/media/subtitles*` |
| `download` | yt-dlp 2026.10.26 | true | 0 | `/media/download`、`/media/download/sync`、`/media/analyze` |
| `vision` | Qwen2.5-VL-3B-Instruct-Q4_K_M | true | 3400 MB | `/vision/frames`、`/vision/describe`、`/vision/scan`、`/jobs/vision` |
| `jobs` | SQLite 队列 | true | — | `/jobs/*`，同类型优先、无 aging |

**错误体与状态码（服务层真实行为）**

```json
{"ok": false, "error": "insufficient_vram", "detail": "显存不足：……", "need_mb": 6912, "free_mb": 6000, "released": ["asr"], "shortfall_mb": 912}
```

| 状态码 | `error` | 含义 |
| --- | --- | --- |
| 400 | `invalid_*` / `voice_not_found` | 参数/音色/格式错 |
| 401 | `unauthorized` | 设了 `LOCALAI_TOKEN` 但没带 |
| 404 | `voice_not_found` / `job_not_found` | 不存在 |
| 409 | `job_canceled` / `not_cancelable` / `job_not_done` | 任务状态不允许 |
| 413 | — | 文件超限（上传 200MB，音频 50MB） |
| 503 | `engine_error` / `asr_error` / `speaker_error` / `separate_error` | 引擎加载/推理失败 |
| 504 | `comfy_error` / `job_timeout` | 超时 |
| 507 | `insufficient_vram` | 显存不足（正常保护，不是崩溃） |

**已有的管理接口（`/admin/*`，WebUI 与安装器可直接复用）**

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/admin/system` | 版本、Python、GPU、磁盘、监听地址、**`paths.home`**、计划任务状态 |
| GET/PUT | `/admin/settings` | 26 项白名单设置，带 `value/default/source/requires_restart` |
| GET | `/admin/models` | 各能力模型：`present/size_mb/current/missing` |
| POST | `/admin/models/download` | 异步下载；同一时刻只允许一个任务 |
| GET | `/admin/models/tasks/{id}` | 下载进度 |
| POST | `/admin/models/activate` | 切换 whisper / ASR 档位 |
| GET/POST | `/admin/autostart` | 计划任务 `LocalAIService-Service` 开关 |
| POST | `/admin/restart` | 必须 `{"confirm":true}`，202 后延迟重启 |
| GET | `/admin/logs?lines=200&file=service` | UTF-8/UTF-16/GBK 自动探测的日志尾部 |
| GET/PUT | `/admin/models/search-paths` | 已有模型搜索路径 |
| POST | `/admin/models/scan` | 只读扫描已有模型 |
| POST | `/admin/models/adopt` | 只写配置指向，不移动/复制/删除用户文件 |

**WebUI**

- `/ui` 是纯静态单页，无 npm/CDN，随 Python 包分发；左侧 `.sidebar` + 顶部 `.topbar` + `.main`。
- 页面：概览 / 模型 / 设置 / 任务 / 系统；任务详情弹窗、日志查看器、开机自启、重启都已有。
- **目前没有 `?embed=1`，也没有 iframe 高度自适应**；也**没有** `X-Frame-Options` / CSP 响应头（同机 iframe 目前可以显示，但会带完整侧栏）。

**启动脚本的关键约定**

- 设置 `LOCALAI_HOME`、`PYTHONPATH`、`TORCH_HOME`、各能力空闲卸载秒数；
- 用 `Start-Process ... -Wait` 起子进程，日志重定向到 `logs\`；
- `engine\.venv` 是默认解释器位置；换目录要改脚本或直接用 venv 的 python。

### 2.2 DSH 侧现状

**`dsh-fish-message`（已上线，`E:\dsh-fish-message`，v0.1.0）**

- QQ 私聊双向桥：NapCat / OneBot 11，WS 优先、HTTP 轮询兜底；离线补投、持久化出站队列、`[语音]…[/语音]` 出站。
- 现在**直接 HTTP** 调本地服务：
  - 入站：`record` 段 → `get_record` 拿 wav → 落 `fish-message-inbox\` → `POST /asr?speaker=1` → 文字 + 声纹名；
  - 出站：`[语音]文字[/语音]` → `POST /tts` → 落 `fish-message-outbox\` → 交给 transport；
  - 另有 `/media/to_wav` 做 16k 单声道归一。
- 配置 `~/.dsh/fish-message-config.json` 实测：
  - `asrBaseUrl = http://127.0.0.1:7880`
  - `ttsBaseUrl = http://127.0.0.1:7880`
  - `ttsVoice = dafeiyu`、`ttsTimeoutMs = 180000`、`asrTimeoutMs = 180000`
  - `transcriptionEnabled = true`、`ttsEnabled = true`
- 宿主入口 `lib/host.js` 的 `inject = ['agents','sessions','sessionTitle','webServer','workspaceRegistry','attachments']`；路由前缀 `/dsh-fish-message`；**目前没有 `ctx.provide('fish.message', …)`**。
- 它的 `lib/voice.js` 是独立的 HTTP 客户端，**不依赖任何别的 DSH 插件**；这正是我们要保留的可替换性。

**`@memef1f1y/dsh-plugin-tts`（将被覆盖）**

- 已安装版本 `0.6.7`，包在 `~/.dsh/profiles/desktop/node_modules/@memef1f1y/dsh-plugin-tts`。
- **关键事实（2026-11-09 核查）**：它出现在 profile 的 `dependencies` 里，但**不在 `dsh.profile.bundles` 数组里**。按 DSH 的加载规则，当前它没有激活；不要再假设它一定在跑。
- 它自己的能力：Edge TTS / RVC / Index-TTS2 / CosyVoice / Google Cloud；消息级朗读按钮、自动朗读开关、语音设置面板；宿主路由 `/dsh-tts-api/*`；配置 `~/.dsh/tts-rvc/settings.json`（`{version, index:{baseUrl}, rvc:{...}, cosy:{...}}`）；UI 偏好存在浏览器 `localStorage` 的 `dsh-tts-settings`（含 `provider`、`voice` 等）。
- 迁移时以「**确保不在 bundles**」为准；不要只删 `dependencies`（删了回滚还要重装）。

**DSH 0.2.2-rc.1 的插件机制（本项目实际会用到的）**

| 机制 | 用法 | 真实依据 |
| --- | --- | --- |
| 包声明 | `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client = {platform:'web', inject:['slots'], external:['react']}`；`exports["./client"]` 指向客户端入口 | `dsh-fish-message/package.json` |
| 插进 profile | `cordis.patch.yml` 里 `- insert: [{id, name}]`；profile 的 `dsh.profile.bundles` 决定加载 | `dsh-fish-message/cordis.patch.yml` |
| 宿主服务 | `export const inject = [...]`；`ctx.provide(name, api)` 暴露；`ctx.get(name)` 取用 | `dsh-pet` 的 `ctx.provide("petApi7340", …)` |
| 工具 | `ctx.tools.register(defineTool({name, description, parameters, output, execute}))` | `dsh-fish-memory`、`dsh-bili-subagent` |
| HTTP 路由 | `ctx.webServer.register({kind:'exact', path, handler})`，返回 disposer | `dsh-fish-memory` 的 `mroute` |
| 投递会话 | `ctx.agents.get(id).followup(...)` | `dsh-fish-message/lib/delivery.js` |
| UI | 客户端 `window.__ModuleLoader__.load({id, factory})`；`slots.inject(name, () => slots.register({name,key,id,order,label}, Component))` | `dsh-fish-message/client.js`、`@memef1f1y/dsh-plugin-tts/lib/client.js` |
| 卸载清理 | `ctx.effect(() => { ...; return () => cleanup })`；工具/路由的 disposer 随插件卸载自动消失 | `dsh-fish-message/lib/host.js` |

已确认存在的 UI 插槽（来自 DSH 0.2.2 客户端 bundle 字符串与已装插件实测）：

- `conversation.chat.assistant-actions`（单条助手消息的操作行，带 `messageId`）
- `conversation.input.left`（输入框左侧；TTS 插件把自动朗读开关放这里）
- `conversation.input.right`（输入框右侧；**语音输入按钮的首选位置，P2 需实测 props**）
- `conversation.input.dock` / `overlay` / `attachments` / `activity`
- `settings.plugins.tab`（插件设置页的 tab）、`settings.section`（设置分区）、`shell.overlay`（全局浮层）

> 注意：UI 是**客户端**注册，不是宿主 `ctx.slots`。宿主侧只负责 HTTP 路由与数据；客户端通过 `slots` 注入。

### 2.3 现状的四个痛点

1. **地址散落**：`fish-message` 的 `asrBaseUrl` / `ttsBaseUrl`、TTS 插件的 `index.baseUrl`、脚本里的 `127.0.0.1:7880` 各存一份；换端口/换机器要改多处。
2. **失败只有状态码**：507/503/504 在 UI 上就是「失败」，用户不知道该开服务、下模型还是关占卡程序；Agent 也只能看到 `HTTP 507`。
3. **多步链路每次重写**：取语音→转写→声纹→投递、翻译→合成→发语音，这些链路目前要么写死在某个插件里，要么让 Agent 连续调多个工具，往返多、容易漏步骤。
4. **安装/模型管理靠人**：装 venv、装 torch、下 8GB 模型、配自启，全是手工步骤；换机器成本高。

---

## 3. 目标与非目标

### 3.1 目标

1. **一个门面**：DSH 里只有 `fish-service` 知道服务地址；其它插件通过 `fish.service` 或配置引用，不再手写 HTTP。
2. **能力可发现**：`capabilities` 把「有没有、能不能、占多少显存、缺什么」暴露给 Agent 和 UI；服务缺失/模型缺失/显存不足都能翻译成人话。
3. **多步可组合**：`fish-ops` 把常见链路封装成工具；依赖不满足就不注册，不在运行时炸。
4. **一键部署**：插件内完成预检、安装、启动、自启、模型下载、接管已有服务、升级、卸载、离线安装。
5. **不重复造 UI**：服务自带 WebUI 通过 iframe 内嵌，插件只做壳与引导。
6. **HTTP 接口保留**：`localai` 的 HTTP 契约不变；插件只是 DSH 侧门面，其它软件/脚本继续可用。

### 3.2 非目标

- 不重写推理、不改模型加载策略、不做模型训练/微调；
- 不把 HTTP 改成私有 IPC/WebSocket 协议；
- 不做云端 TTS/翻译兜底（TTS 插件原有的 Edge/Cloud 能力不迁进来）；
- 不在 `fish-ops` 里存服务地址、模型路径、token；
- 不在 P1 做「服务端打包命令」；P5 才改 `localai` 仓库；
- 不承诺跨平台（首版 Windows 10/11 x64；Linux/macOS 只保留接口，不做安装器）。

---

## 4. 设计原则

1. **单一事实源**：`baseUrl`、token、超时、能力缓存只在 `fish-service` 的 `ConfigStore` 里；`fish-ops` 和 UI 都读 `fish.service`。
2. **单步不封装**：`fish-ops` 只放多步链路；`fish_tts`、`fish_asr` 已存在，不再做 `tts_simple`。
3. **能力先于调用**：任何重请求前先 `ensureReady(cap)`；`ready=false` 直接给 `model_missing`，不要打一次 503 再猜。
4. **产物落盘、接口回路径**：TTS/分离/关键帧写到 DSH 缓存目录，工具返回 `wavPath`/`stems`/`frames[].path`；**绝不把 base64 塞进工具结果**。
5. **降级而不是阻塞**：服务不可用时，`fish-service` 的工具返回结构化错误；`fish-message` 的转写失败降级为 `[语音（转写失败：…）]`；UI 显示引导而不是白屏。
6. **接管优先于覆盖**：已有 `localai` 服务只接管，不重装；只有 `installMode=managed` 且目录带安装标记时才允许升级/卸载。
7. **只回滚自己创建的东西**：安装器维护 `createdPaths` 清单；模型、音色、声纹、用户 `config.json` 默认不动。
8. **契约先冻结**：P0 先把 `CONTRACT.md` 定死；P1 只实现契约内的东西，不边写边改字段。

---

## 5. 总体架构

### 5.1 分层图

```text
┌──────────────────────────────────────────────────────────────────────┐
│ DSH 客户端（Web GUI）                                                 │
│  ├─ 消息操作行 conversation.chat.assistant-actions → [朗读]           │
│  ├─ 输入框 conversation.input.right/left → [语音输入]                 │
│  └─ 设置 → 插件 → 本地 AI（状态/安装/模型/日志/内嵌 WebUI）           │
└───────────────▲──────────────────────────────────────────────────────┘
                │ 宿主 HTTP 路由 /dsh-fish-service/*（浏览器不接触 token）
┌───────────────┴──────────────────────────────────────────────────────┐
│ dsh-fish-service（DSH 宿主插件）                                      │
│  ├─ fish.service（Cordis）：capabilities/health/ensureReady/tts/asr/  │
│  │   translate/separate/visionFrames/mediaProbe/jobs/config/events    │
│  ├─ 8 个 Agent 工具（fish_tts / fish_asr / … / fish_service_status）  │
│  ├─ LocalAIClient：HTTP、超时、重试、错误翻译、能力缓存               │
│  ├─ InstallManager：预检/安装/接管/升级/卸载/模型/自启/日志           │
│  └─ CacheStore：~/.dsh/fish-service-cache（TTS/分离/关键帧产物）      │
└───────────────▲──────────────────────────────────────────────────────┘
                │ HTTP（唯一出口；token 在此注入）
┌───────────────┴──────────────────────────────────────────────────────┐
│ localai-service（引擎层，127.0.0.1:7880）                             │
│  FastAPI + 懒加载 + 显存 LRU + 持久化任务队列 + /ui + /admin/*        │
└───────────────▲──────────────────────────────────────────────────────┘
                │ Cordis 服务 / 工具
┌───────────────┴──────────────────────────────────────────────────────┐
│ dsh-fish-ops（组合链路，按 requires 条件注册）                        │
│  voice_note_analyze / say_as_voice / translate_and_speak /            │
│  long_text_read / vision_watch / fish_ops_list                        │
└───────────────▲──────────────────────────────────────────────────────┘
                │ 可选使用 fish.service，也可完全不用
┌───────────────┴──────────────────────────────────────────────────────┐
│ 其它插件：dsh-fish-message（QQ 桥）、dsh-fish-memory、……              │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 一次 TTS 调用的时序

```text
Agent/UI → fish_tts / POST /dsh-fish-service/tts
  → fish.service.ensureReady('tts')
      → 读 capabilities 缓存（60s）；ready=false → model_missing
      → 读 /vram；free_mb - margin < estimate → vram_exhausted（可选先提示）
  → LocalAIClient POST /tts（timeout 180s）
      → 200 audio/wav + X-Audio-Path / X-Seed / X-Language
  → CacheStore 写 ~/.dsh/fish-service-cache/tts/<sha16>-<ts>.wav
  → 返回 {ok:true, items:[{wavPath, ms, voice, seed, language, bytes}]}
UI 额外走 GET /dsh-fish-service/audio/<id> 流式播放；Agent 只拿路径。
```

### 5.3 一次 `voice_note_analyze` 的时序

```text
Agent → voice_note_analyze({messageId})
  → fish-ops 解析 requires：fish.service>=1.0 ✅、fish.message>=0.2 ✅
  → fish.message.getVoice(messageId) → 本地 wav 路径 + 元数据
  → fish.service.asr(wav, {speaker:true, language:'auto'})
      → POST /asr?speaker=1（multipart，timeout 300s）
  → 返回 {ok:true, text, speaker:{name,score,known}, language, durationMs}
失败：
  - 消息不是语音 → no_voice_attachment（不调服务）
  - 服务没起 → service_down（带「启动服务」hint）
  - 声纹失败但转写成功 → ok:true，speaker=null，speakerError 字段
```

---

## 6. 职责边界

| 事情 | localai-service | dsh-fish-service | dsh-fish-ops | dsh-fish-message | 其它插件 |
| --- | --- | --- | --- | --- | --- |
| 监听地址 / token 的唯一配置 | 自己监听；token 由 env 提供 | **唯一保存 `baseUrl`/token 的地方** | 不保存 | 兼容旧字段，可选引用 | 不保存 |
| 健康检查 | 提供 `/health`、`/capabilities` | 轮询、缓存、翻译成 `health()` | 只用 `fish.service` | 不需要 | 不需要 |
| 模型管理 | 提供 `/admin/models*`、下载/切换 | 代理 + 安装向导 + 依赖选择 | 不碰 | 不碰 | 不碰 |
| 安装/升级/卸载 | 提供打包命令、自启/重启接口 | **执行安装器**、记录 createdPaths | 不碰 | 不碰 | 不碰 |
| 能力调用 | 真正推理 | 统一封装、超时、重试、产物落盘 | 组合多步 | 可选走 `fish.service` | 可选走 `fish.service` |
| UI | 自带 `/ui` | 朗读/语音输入/设置页/内嵌 WebUI | 无 UI | 自己的 QQ 设置页 | 各自 |
| 错误翻译 | HTTP 状态码 + `error`/`detail` | **映射成 9 类 + hint** | 透传并补 `op/stage` | 自己的降级文案 | 不需要 |
| 会话投递 | 无 | 不投递（UI 除外） | 通过 `fish.message` 或 `ctx.agents` | 自己投递 | 自己 |

**依赖方向（硬约束）**

```text
fish-ops  →  fish-service  →  localai HTTP
fish-ops  →  fish-message（仅需要“取语音/发语音”的 op）
fish-message  →  fish-service（可选；没有就 HTTP 兜底）
fish-service  →  ✗ fish-ops
fish-service  →  ✗ fish-message
其它插件      →  fish-service（可选）
```

- `fish-service` **不得** import / `ctx.get('fish-ops')` / 依赖 `fish-message`；
- `fish-message` **不得**依赖 `fish-ops`；
- `fish-ops` 可以依赖具体插件，但每个 op 必须自己声明，不能“整个插件硬依赖”。

---

## 7. 版本与兼容策略

| 对象 | 版本字段 | 规则 |
| --- | --- | --- |
| HTTP 契约 | `capabilities.api_version = "1"` | 主版本不兼容；新增字段视为兼容，调用方忽略未知字段 |
| `fish.service` | `api.apiVersion = "1.0"` | 主版本必须相同；次版本向后兼容；`fish-ops` 用 `>=1.0` 判断 |
| `fish.message` | `api.apiVersion = "0.2"` | 0.x 阶段允许小版本破坏，但必须显式升 `requires` |
| 插件包 | `package.json.version` | 语义化；P1 从 `0.1.0` 起 |
| 服务层 | `capabilities.service.version` | 仅展示/诊断；插件只强制 `api_version` 主版本，另有 `minServiceVersion`（默认 `2.5.0`）用于安装器提示 |

**不匹配时的行为**

| 情况 | 行为 |
| --- | --- |
| `api_version` 主版本 ≠ 1 | `fish.service` 进入 `api_incompatible`：只保留 `health()`/`status`，写操作工具返回 `api_incompatible`，不自动重试 |
| 服务版本 < 插件要求 | 状态页提示「服务版本过旧，建议升级」；读能力照常，安装器不自动降级 |
| 服务版本 > 插件认识 | 允许使用；未知字段忽略；在状态页标注「比插件新」 |
| `fish.message` 版本不满足 | 相关 op 不注册；`fish_ops_list` 给出 `requires` 与原因 |

---

## 8. `dsh-fish-service` 设计

### 8.1 目标目录结构（P1 建立）

```text
E:\dsh-fish-service\
├─ package.json                 # dsh.bundle.patch / dsh.client / exports["./client"]
├─ cordis.patch.yml             # - insert: [{id: fish-service, name: dsh-fish-service}]
├─ lib\
│  ├─ host.js                   # apply：装配 config/service/tools/routes/install，ctx.effect 清理
│  ├─ config.js                 # 默认值、schemastery schema、env 覆盖、迁移导入
│  ├─ localai-client.js         # fetch 封装：超时、AbortSignal、multipart、token
│  ├─ service-api.js            # 实现 fish.service 契约（唯一出口）
│  ├─ capabilities.js           # /capabilities 解析、60s 缓存、版本校验
│  ├─ errors.js                 # FishServiceError、状态码→code、hint 文案
│  ├─ cache.js                  # 产物落盘、TTL、LRU、audio id 映射
│  ├─ health.js                 # 15s 轮询、service-up/down 去抖、事件
│  ├─ routes.js                 # /dsh-fish-service/* 宿主路由
│  ├─ tools\                    # 每个工具一个文件，统一 safe() 包装
│  └─ install\                  # preflight/uv/venv/models/autostart/rollback
├─ client.js                    # 朗读按钮、语音输入、设置页、iframe
├─ docs\                        # 本目录
└─ tests\                       # 契约测试 + mock localai
```

> 当前仓库只有 `docs/`；上表是 P1 的目标结构，不是现状。

### 8.2 Cordis 服务：`fish.service`

```js
export const name = 'fish-service'
export const inject = ['tools', 'webServer', 'agents', 'sessions']
// 注意：inject 里没有 fish-ops / fish-message / message 相关项——它不依赖任何插件
```

```js
export function apply(ctx, pluginConfig) {
  const api = createFishServiceApi({ ctx, config, client, cache, health })
  ctx.provide('fish.service', api)
  // 卸载时：ctx.effect 的 cleanup 停轮询、关缓存、摘路由；工具 disposer 自动回收
}
```

`api` 的最小面（完整签名见 [`CONTRACT.md`](CONTRACT.md)）：

| 成员 | 作用 |
| --- | --- |
| `apiVersion: "1.0"` | 服务契约版本 |
| `capabilities` | `{tts,asr,translate,separate,vision,media,download,jobs}`，每项 `{available, ready, loaded, model, reason?, versions?, estimateMb?}` |
| `health()` | `{ok, baseUrl, latencyMs, serviceVersion, apiVersion, vram, capabilities, checkedAt}` |
| `ensureReady(cap, opts)` | 能力门禁；`preload:false` 默认只检查，不强行加载模型 |
| `tts(text\|texts, opts)` | 返回 `{items:[{wavPath,ms,voice,seed,language,bytes}], ms}` |
| `asr(file\|files, opts)` | 返回 `{items:[{text,segments?,speaker?,language,engine,ms}]}` |
| `translate(text\|texts, opts)` | 返回 `{texts, source, target, ms, engine}` |
| `separate(file, opts)` | 返回 `{stems, dir, ms, released}` |
| `visionFrames(input, opts)` | 返回 `{frames, duration, subtitlesFrom, stats, ms}` |
| `mediaProbe(file\|files)` | 返回 `{items:[{duration,format,audio,video}]}` |
| `jobs` | `enqueue/status/wait/cancel/list` |
| `voices()` | 音色列表（`/voices`） |
| `config` | `get()` 脱敏；`set(patch)` 只接受白名单 |
| `events` | `on/off/once`：`model-loaded` / `model-unloaded` / `error` / `service-down` / `service-up` |
| `install` | 安装管理内部 API（`status/preflight/start/cancel/adopt/uninstall/models/autostart/logs`） |

**为什么 `ensureReady` 默认不 preload**

服务层没有「加载模型」的独立接口；加载只能靠一次真实请求。`ensureReady(cap, {preload:true})` 仅对 TTS 定义最小预热（合成一个极短文本），其它能力不做假预热。默认 `preload:false`，返回 `willLoadOnFirstUse:true`，让调用方自己承担首次延迟。这样不会因为一次「检查」白占 6.4GB 显存。

**能力缓存**

- `/capabilities` 缓存 60 秒；`/health` 不缓存（但 15 秒轮询一次）。
- 请求返回 507/503 时，**立刻失效**缓存并重拉一次，避免 UI 长时间显示旧的 `ready`。
- 冷却：同一能力连续失败 3 次，30 秒内不再自动重拉，防止打爆服务。

### 8.3 Agent 工具（8 个）

工具是给 LLM 用的，**不是**给 UI 用的；UI 走宿主路由。所有工具：

- 成功返回 `{ok:true, ...}`，失败返回 `{ok:false, code, hint, ...}`，**不抛裸异常**（DSH 里 LLM 能看到结构化错误）；
- 参数用标准 JSON Schema，`additionalProperties:false`；
- 一次多条（`texts`/`files`）上限明确，减少往返；
- 返回路径 + 关键指标，不回传 base64、不回传整段日志；
- 长文本/长分段有截断，并在结果里标 `truncated:true`。

| 工具 | 用途 | 主要参数 | 返回 |
| --- | --- | --- | --- |
| `fish_tts` | 文本→语音（批量） | `texts[1..20]`, `voice`, `speed`, `language`, `seed` | `items[{wavPath,ms,voice,seed,language,bytes}]` |
| `fish_asr` | 音频/视频→文字（批量） | `files[1..10]`, `language`, `engine`, `speaker`, `timestamps` | `items[{text,segments?,speaker?,language,engine,ms}]` |
| `fish_translate` | 批量翻译 | `texts[1..200]`, `source`, `target` | `texts[]`, `source`, `target`, `ms` |
| `fish_separate` | 人声分离 | `file`, `model`, `stems[]` | `stems{name:path}`, `dir`, `ms` |
| `fish_vision_frames` | 视频关键帧 + 摘要 | `videoPath`, `targetFrames`, `effort`, `planner`, `subtitles` | `frames[{time,path,summary,score,kind,ocrText}]` |
| `fish_media_probe` | 媒体探测（批量） | `files[1..10]` | `items[{duration,format,audio,video}]` |
| `fish_job` | 任务查询/取消/等待 | `action(status/cancel/list/wait)`, `jobId`, `kind`, `state` | 任务记录/结果摘要 |
| `fish_service_status` | 服务状态（只读） | 无 | 版本/能力/显存/音色/安装状态/最近错误 |

工具注册时机：**8 个工具始终注册**（即使服务没装）。理由：Agent 需要能诊断「为什么不能用」；`fish_service_status` 必须永远可调。服务缺失时，除 `fish_service_status` 外的工具返回 `service_not_installed`/`service_down` + hint。

**返回精简的硬规则**

| 内容 | 上限 |
| --- | --- |
| ASR `segments` | 最多 200 段；超出标 `truncated:true`，只保留首尾各 100 段 |
| `vision.frames` | 最多 10 帧；`summary` 每帧 ≤ 300 字 |
| 翻译 `texts` | 原样返回（翻译结果本身就是交付物），但总字符 > 50k 时截断并提示改用 `fish_job` |
| 任何 base64 | **0**（工具结果里出现 base64 视为实现 bug） |
| 任务 `payload` | 不返回完整 payload；只返回 `kind/state/result/error` 摘要 |

### 8.4 错误分类（9 类 + 3 个扩展）

| code | 何时出现 | 用户 hint（可直接展示） | 重试 |
| --- | --- | --- | --- |
| `service_not_installed` | 没有配置、没探测到服务、没有安装标记 | 「还没装本地 AI 服务。打开 设置 → 插件 → 本地 AI → 安装服务。」 | 否，先安装 |
| `service_down` | 连接拒绝 / 健康检查超时 / 进程不在 | 「本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。」 | 可，启动后 |
| `model_missing` | `cap.ready=false` 或 `/admin/models` 的 `present=false` | 「缺少 TTS 模型（IndexTTS-2.5，约 8.1 GB）。到『模型管理』勾选下载。」 | 否，先下载 |
| `model_loading` | 冷加载中再次请求 / 503 detail 含「加载」 | 「模型正在加载，通常 10~60 秒；稍后再试。」 | 可，等 5~10s |
| `vram_exhausted` | HTTP 507 `insufficient_vram` | 「显存不够（需要约 6.4 GB，当前空闲 2.1 GB）。关掉占显存的程序，或在服务 WebUI 里卸载其它模型。」 | 否，先腾显存 |
| `busy` | 队列等待超过 `busyAfterMs`（默认 30s）或 503 含「队列/busy」 | 「服务正在忙（队列还有 N 个任务），已经排队；可用 fish_job 查进度。」 | 可，等待 |
| `timeout` | HTTP 504 / fetch AbortError | 「等太久了（>180 秒），模型可能正在加载。稍后重试；长文本请分段。」 | 可一次 |
| `bad_request` | 400/401/403/404/413/422 | 「参数不对：…… 修正后重试，不要原样重试。」 | 否 |
| `upstream_error` | 500/502/503（能力 ready 但失败） | 「服务内部报错：…… 可重试一次；仍失败看 logs\service.err.log。」 | 一次 |
| `api_incompatible`（扩展） | `api_version` 主版本不符 | 「服务契约版本不匹配（服务 X，插件支持 1.x）。请升级插件或服务。」 | 否 |
| `canceled`（扩展） | HTTP 409 `job_canceled` / 用户取消 | 「任务已取消。」 | 否 |
| `not_implemented`（扩展） | 契约里保留但本版没做 | 「这个功能还没实现（P?）。」 | 否 |

`FishServiceError` 形状：`{code, httpStatus, capability, hint, detail, retryable, retryAfterMs?, cause?}`。`detail` 保留服务端原文用于日志/诊断，`hint` 只放人话；不要把 `detail` 直接当 UI 文案（可能含路径/英文堆栈）。

### 8.5 UI 设计

| 入口 | 插槽 | 行为 | 服务缺失时 |
| --- | --- | --- | --- |
| 消息级朗读 | `conversation.chat.assistant-actions`（`key: fish-read`, `order: 21`） | 取当前消息纯文本 → 宿主 `POST /dsh-fish-service/tts` → `GET /audio/<id>` 播放；播放中再点=停止 | 按钮显示为「安装服务」图标/提示；点击打开设置页安装向导，不报错 |
| 语音输入 | `conversation.input.right`（首选；不可用则 `conversation.input.left`，`key: fish-mic`） | 按住/点击录音（MediaRecorder）→ `POST /asr`（multipart）→ 把文字插入输入框；插入 API 待 P2 实测，兜底复制到剪贴板 + toast | 按钮置灰 + tooltip「先安装/启动服务」 |
| 设置页 | `settings.plugins.tab`（`key: fish-service`, `label: '本地 AI'`） | 状态 / 安装 / 模型 / 服务设置 / 日志 / 内嵌 WebUI 六个分区 | 首屏就是安装向导，不是错误页 |
| 全局提示 | `shell.overlay`（可选，`key: fish-service-toast`） | 安装进度、服务重启、模型下载完成的轻提示 | 不挂载 |

**朗读按钮的文本提取**：优先用 slot props 的 `messageId` + `useTrajectory` 找 `blocks[kind=text].text`；取不到时向上找 DOM 气泡文本（沿用 TTS 插件的兼容策略）。**只朗读助手最终回复**，跳过工具调用/思考/代码块（可在设置里关）。

**语音输入的关键风险**：`conversation.input.right` 的 props 契约没有官方文档，P2 第一件事是用 `console.log` 抓一次 props，确认有没有 `insertText` / `useInput`。没有就走「复制到剪贴板 + toast：已转写，按 Ctrl+V 粘贴」的降级；**不允许**用 DOM 直接改 React 受控输入框（会丢状态）。

**设置页分区**

1. **状态**：服务版本、`baseUrl`、延迟、能力 chips（TTS/ASR/翻译/分离/视觉/媒体/下载）、显存、自启状态、`启动/停止/重启/打开 WebUI`。
2. **安装**：`installMode`（managed/adopted）、安装目录、预检结果、安装/升级/卸载、进度条与日志。
3. **模型**：能力/模型/是否已下载/大小/当前档位/操作；必需模型默认勾选，可选模型默认不勾；一次只跑一个下载任务（服务端限制）。
4. **服务设置**：地址/端口、token（只写不回显）、默认音色、自动朗读、请求超时、缓存 TTL/上限、镜像源。
5. **日志**：`/admin/logs` 代理（宿主注入 token），200 行，UTF-8 自动探测；不把 token 打到浏览器。
6. **WebUI**：内嵌 iframe + 视图切换 + 「新窗口打开」兜底。

### 8.6 配置

配置文件：`~/.dsh/fish-service-config.json`（与 `fish-message-config.json` 同目录，原子写）。
安装状态：`~/.dsh/fish-service-install.json`（`installMode`、`installDir`、`createdPaths`、`autostartCreatedByUs`、`lastVersion`）。
缓存：`~/.dsh/fish-service-cache/`（默认 2 GB 上限，TTL 72h，LRU）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `version` | `1` | 配置 schema 版本 |
| `enabled` | `true` | 总开关；关掉后工具返回 `service_not_installed`，UI 显示禁用 |
| `baseUrl` | `http://127.0.0.1:7880` | **唯一服务地址** |
| `token` | `""` | 对应 `LOCALAI_TOKEN`；只写不回显，不写日志/URL |
| `installDir` | `%LOCALAPPDATA%\localai-service` | 仅 managed 模式有效 |
| `installMode` | `"unknown"` | `managed` / `adopted` / `unknown` |
| `autoStart` | `true` | 安装完成后是否启用计划任务 |
| `defaultVoice` | `"default"` | 新装用服务端默认音色；迁移时若 `/voices` 有 `dafeiyu` 则导入为 `dafeiyu` |
| `autoRead` | `false` | 自动朗读开关（默认关，避免迁移后突然出声） |
| `maxCharsPerChunk` | `800` | 长文分段上限（服务端 TTS 硬上限 5000） |
| `requestTimeoutMs` | `180000` | TTS/一般请求 |
| `asrTimeoutMs` | `300000` | ASR/分离 |
| `visionTimeoutMs` | `600000` | 视觉 |
| `healthIntervalMs` | `15000` | 健康轮询 |
| `busyAfterMs` | `30000` | 队列等待超过它 → `busy` |
| `cacheTtlHours` | `72` | 产物 TTL；必须 > fish-message 出站 TTL（24h） |
| `cacheMaxMb` | `2048` | 缓存上限 |
| `modelMirror` | `"modelscope"` | `modelscope` / `huggingface` / `hf-mirror` |
| `pypiIndex` | `""` | 空=官方；内网可填镜像 |
| `torchIndex` | `""` | 空=按 manifest 推荐；如 `https://download.pytorch.org/whl/cu130` |
| `embedWebUI` | `true` | 设置页是否显示内嵌 WebUI |
| `logLevel` | `"info"` | `debug/info/warn/error` |

**环境变量覆盖**（优先级：env > config.json > 默认，和 localai 一致）

| 变量 | 覆盖 |
| --- | --- |
| `DSH_FISH_SERVICE_BASE_URL` | `baseUrl` |
| `DSH_FISH_SERVICE_TOKEN` | `token` |
| `DSH_FISH_SERVICE_ENABLED` | `enabled`（`0/false` 关） |
| `DSH_FISH_SERVICE_INSTALL_DIR` | `installDir` |
| `DSH_FISH_SERVICE_DISABLE_INSTALL` | 为 `1` 时隐藏安装/卸载按钮（托管环境用） |
| `DSH_FISH_SERVICE_HEALTH_MS` | `healthIntervalMs` |

**从旧 TTS 插件导入（迁移时一次性，可撤销）**

- 读 `~/.dsh/tts-rvc/settings.json` 的 `index.baseUrl`：若它指向一个能通过 `/capabilities` 的 localai，作为 `baseUrl` 候选；
- 读 `fish-message-config.json` 的 `ttsVoice` / `asrBaseUrl` / `ttsBaseUrl`：地址一致才自动导入，不一致则在设置页让用户选；
- 浏览器 `localStorage['dsh-tts-settings']` 的 `provider` / `voice` **不由宿主读取**；设置页可以提供「从旧插件导入」按钮，在客户端 `localStorage` 有值时提示用户确认（P2 实现，P1 不阻塞）。

### 8.7 产物与缓存

- TTS：`<cache>/tts/<sha16(text+voice+speed+emotion+seed)>-<ts>.wav`；`seed` 随机时不复用，避免“同文不同音”被缓存。
- 分离：`<cache>/separate/<jobid>/<stem>.wav`；`stems` 原样指向缓存。
- 关键帧：`<cache>/vision/<jobid>/frame_*.jpg`；`frames[].path` 指向缓存。
- ASR 上传临时文件：`<cache>/tmp/<uuid>.<ext>`，请求结束即删；不长期保存用户音频。
- 缓存清理：启动时、每 6 小时；先删过期，再按 LRU 删到 `cacheMaxMb`。
- **不缓存**：翻译结果（隐私 + 服务端已足够快）、任务列表、日志。

### 8.8 生命周期与健康

```text
apply
 ├─ 载入 config（env 覆盖）→ 若 enabled=false，只挂 status/设置路由
 ├─ 创建 LocalAIClient / CacheStore / HealthMonitor
 ├─ ctx.provide('fish.service', api)
 ├─ 注册 8 个工具（始终）
 ├─ 注册 /dsh-fish-service/* 路由
 ├─ health.start()：立即探一次，之后每 15s
 └─ ctx.effect(() => cleanup: health.stop / cache.flush / 摘路由)
```

- `service-down`：连续 2 次失败才发（防抖）；`service-up`：1 次成功就发。
- 轮询失败退避：5s → 10s → 30s，成功恢复 15s。
- 服务重启后自动重拉 capabilities，不需要重载插件。
- 插件卸载：停止轮询、取消进行中的安装任务（保留已下载文件）、关闭缓存、disposer 摘工具/路由。

### 8.9 安装管理（详见 DEPLOY）

`fish-service` 内部 `InstallManager` 负责：

- 预检：OS、磁盘、GPU/驱动、端口、已有服务；
- 安装：uv → venv → 代码包 → 引擎依赖 → 模型 → 启动 → 自启 → 写配置；
- 接管：探测 → 版本协商 → `installMode=adopted`；
- 升级/卸载/回滚；模型下载/切换；日志尾读。

它**不**把安装逻辑暴露成 `fish.service` 的公共方法给其它插件；只通过 `api.install` 给本插件 UI/工具用，避免别的插件触发安装。

---

## 9. `dsh-fish-ops` 设计

### 9.1 为什么条件注册

`fish-ops` 的每个 op 依赖的服务/插件不同：

- `voice_note_analyze` 需要 `fish.service` + `fish.message`；
- `say_as_voice` 需要 `fish.service` + `fish.message`；
- `translate_and_speak` 需要 `fish.service` + `fish.message`（端到端：翻译→合成→发送）；
- `long_text_read` 需要 `fish.service` + `fish.message`（端到端：分段→合成→逐段发送）；
- `vision_watch` 只需要 `fish.service`（视频→关键帧→报告；投递不在这个 op 里）。

如果整个插件 `inject: ['fish.service','fish.message']`，那么**没装 fish-message 的用户连 `vision_watch` 都用不了**，而它根本不依赖 message。如果运行时再判断，工具已经出现在列表里，LLM 会调，然后报「依赖缺失」——这正是要避免的。所以按 op 声明、按 op 注册。

> 首批 5 个里 4 个需要 message，只有 `vision_watch` 不需要；这不是巧合：它证明“少一个依赖时，只消失该消失的工具”。单步的 `fish_tts` / `fish_translate` 永远在，不需要 ops。

因此：

- 插件级 `inject` 只放 DSH 自带、一定存在的服务：`['tools','agents','sessions']`；
- 每个 op 自己声明 `requires`，在 `apply` 时逐项解析；
- **不满足的 op 不调用 `ctx.tools.register`** → 工具列表里根本不存在；
- `fish_ops_list` 是唯一“可见”的诊断工具，列出所有 op（含不可用的）与原因；
- 依赖后来出现（插件热插拔/加载顺序）→ 监听 `internal/service` 事件重新解析；服务消失 → disposer 摘掉工具。事件名以 Cordis 4 实测为准，若不存在则退化为 3 秒轮询 `ctx.get()`（只在有 op 不可用时轮询）。

### 9.2 op manifest

```js
{
  id: 'voice_note_analyze',
  version: '1.0.0',
  title: '语音消息分析',
  requires: ['fish.service@>=1.0', 'fish.message@>=0.2'],
  tool: { name: 'voice_note_analyze', parameters: {...}, output: {...} },
  timeoutMs: 360000,
  sideEffect: false,
  idempotent: true,
  async run(ctx, args, exec) { ... }
}
```

- `requires` 只支持 `name@>=x.y` 与 `name`（任意版本）；不引入完整 semver 依赖，自己写 20 行解析。
- `sideEffect:true` 的 op 必须支持 `idempotencyKey`；默认 key = `sha256(op + sessionId + 规范化参数)`，10 分钟内重复直接返回上次结果。
- `timeoutMs` 是 op 总预算，不是单次 HTTP 超时；内部每一步用剩余预算。
- `run` 只通过 `fish.service` / `fish.message` / `ctx.agents` 做事，**不 import HTTP 客户端、不读 `baseUrl`**。

### 9.3 首批 op（5 个）

| op | 链路 | 输入 | 输出 | 失败语义 |
| --- | --- | --- | --- | --- |
| `voice_note_analyze` | `fish.message.getVoice` → `fish.service.asr(speaker:true)` | `messageId?` / `filePath?`、`language?`、`identifySpeaker?` | `text`、`speaker{name,score,known}`、`language`、`durationMs`、`engine` | 非语音→`no_voice_attachment`；服务错→原 code + `op/stage` |
| `say_as_voice` | `fish.service.tts` → `fish.message.sendVoice` | `text`、`voice?`、`sessionId?`、`idempotencyKey?` | `sent`、`wavPath`、`messageId?`、`ms` | TTS 成功但发送失败→`send_failed`，保留 `wavPath` 可重试 |
| `translate_and_speak` | `fish.service.translate` → `tts` → `sendVoice` | `text`、`source`、`target`、`voice?`、`sessionId?`、`idempotencyKey?` | `sourceText`、`translatedText`、`wavPath`、`sent` | 分阶段：`stage:'translate'|'tts'|'send'`，带 `partial` |
| `long_text_read` | 分段 → 逐段 `tts` → 逐段发送 | `text?` / `filePath?`、`maxCharsPerChunk`、`voice?`、`sessionId?`、`idempotencyKey?` | `chunks[]`、`sentCount`、`wavPaths[]` | 某段失败→停止并返回已完成段；`mode:'concat'` 本版 `not_implemented` |
| `vision_watch` | 可选 `download` → `vision.frames` → 生成报告 | `videoPath?` / `url?`、`targetFrames`、`effort` | `frames[]`、`report` | 长视频走 `/jobs/vision`；取消时调 `jobs.cancel`；**不投递**，由调用方决定怎么用报告 |

**`voice_note_analyze` 步骤细节**

1. `fish.message.getVoice(messageId)` 返回 `{filePath, durationMs, messageId, sender?}`；没有 `messageId` 时用 `filePath`（必须绝对路径，且存在）。
2. 若 `identifySpeaker !== false`，`fish.service.asr(file,{speaker:true, language})`；否则 `speaker:false`（省掉 campplus 加载）。
3. `asr` 的 `speaker_error` 不视为失败：`ok:true`，`speaker:null`，`speakerError` 带原因。
4. 返回不包含原始音频路径以外的隐私内容；临时文件由 `fish.message` 的 inbox 管理。

**`say_as_voice` 步骤细节**

1. `tts` 返回 `wavPath`；若 `sessionId` 省略，用 `exec.sessionId`（DSH 当前会话）。
2. `fish.message.sendVoice({sessionId, wavPath, text})`；message 侧负责转码/发送。
3. 幂等：同 key 10 分钟内直接返回 `{deduplicated:true, ...}`，不重复发。
4. 发送失败：**不删 wav**；返回 `send_failed` + `wavPath`，调用方可重试 `fish.message.sendVoice`。

**`translate_and_speak` 步骤细节**

1. `fish.service.translate(text,{source,target})`；失败直接返回 `stage:'translate'`，不合成；
2. `fish.service.tts(translatedText,{voice})`；失败返回 `stage:'tts'`，`partial:{sourceText,translatedText}`；
3. `fish.message.sendVoice({sessionId, wavPath, text:translatedText})`；失败返回 `stage:'send'`，保留 `translatedText` 与 `wavPath`；
4. 幂等 key 覆盖“原文+目标语言+音色+会话”，10 分钟内重复调用直接返回上次结果，不重复发。

**`long_text_read` 的分段规则**

- 先按段落（`\n\n`）切；单段超过 `maxCharsPerChunk` 再按句号/问号/叹号/分号切；仍超长按字符硬切；
- 每段 ≤ `maxCharsPerChunk`（默认 800，服务端上限 5000）；
- 顺序合成、顺序发送，任意一段失败停止；已发送段不回滚（语音消息无法撤回的语义要提前告知）；
- 最多 40 段；超过直接 `bad_request`，提示用户缩短或改用文件；
- v1 `mode:'concat'` 返回 `not_implemented`；要做单条拼接需服务端新增 `/media/concat`（P5+ 评估）。

**`vision_watch` 的输入策略**

- `videoPath` 优先；`url` 时先 `fish.service.jobs.enqueue('download', {url})`，轮询到 `done` 拿 `result.path`；
- 时长 ≤ 10 分钟用同步 `/vision/frames`；> 10 分钟用 `/jobs/vision`，每 2 秒查 `meta.progress`；
- 返回 `frames`（路径 + 摘要）和一段 Markdown 报告；**只返回报告，不投递**。需要发到会话时，由调用方用 `fish.message.sendText` 或 `ctx.agents.get(sessionId).followup` 完成。

### 9.4 错误传播、超时、取消、幂等

**错误传播**

- 任何底层 `FishServiceError` 都保留原 `code`/`hint`，外层补 `op`、`stage`、`causeCode`；
- 工具返回 `{ok:false, code, hint, op, stage, partial?}`，**不 throw**；
- 不把底层 `detail` 拼进 `hint`；`detail` 只进日志/调试字段；
- 多步的 `partial` 必须明确哪些步骤已完成（例如翻译成功、TTS 失败 → `partial:{translatedText}`）。

**超时**

| op | 总预算 | 内部单步 |
| --- | --- | --- |
| `voice_note_analyze` | 360s | ASR 300s |
| `say_as_voice` | 240s | TTS 180s + 发送 30s |
| `translate_and_speak` | 240s | 翻译 60s + TTS 180s |
| `long_text_read` | 900s | 每段 180s，段间不重置总预算 |
| `vision_watch` | 1200s | 下载 1800s 上限但受总预算约束；视觉 600s |

超时返回 `timeout` + `stage`，并尽量取消底层请求（AbortController）；job 类调用 `cancel`。

**取消**

- 使用 DSH 传入的 `exec.signal`；每步开始前检查 `signal.aborted`；
- fetch 传 `signal`；job 类在 abort 时调 `POST /jobs/{id}/cancel`；
- 取消后返回 `canceled`，已产生的缓存文件保留（TTL 清理），不删用户数据。

**幂等**

| op | 幂等 | 说明 |
| --- | --- | --- |
| `voice_note_analyze` | 天然幂等 | 同一文件 hash 缓存 10 分钟 |
| `say_as_voice` | 需要 key | 默认 key 去重 10 分钟；同文同会话不重复发 |
| `translate_and_speak` | 需要 key | 翻译可缓存，发送必须去重 |
| `long_text_read` | 需要 key | 防止重复发一长串语音 |
| `vision_watch` | 视频 hash + 参数 | 10 分钟内同视频同参数不重复生成 |

### 9.5 `fish_ops_list`

```json
{
  "ok": true,
  "ops": [
    {"id":"voice_note_analyze","available":true,"tool":"voice_note_analyze","requires":[{"id":"fish.service","ok":true},{"id":"fish.message","ok":true}]},
    {"id":"vision_watch","available":false,"tool":null,"requires":[{"id":"fish.service","ok":false,"reason":"service_down"}]}
  ],
  "missing": [
    {"require":"fish.message@>=0.2","reason":"未安装或版本过旧（当前无 fish.message 服务）","hint":"升级 dsh-fish-message 到 0.2.0+"}
  ]
}
```

- 只读，不触发任何服务调用（用缓存的能力状态）；
- 不可用 op 的 `tool` 为 `null`，并给 `reason` + `hint`；
- 这是唯一允许“知道不可用 op”的入口；其它工具列表里不可见。

### 9.6 反模式（明确禁止）

| 反模式 | 为什么禁止 | 正确做法 |
| --- | --- | --- |
| 在 ops 里包 `fish_tts` 单步 | 重复工具、LLM 选择困难 | 直接用 `fish_tts` |
| 在 ops 里存 `baseUrl`/token | 地址双份、换端口失效 | 只用 `fish.service` |
| 插件级硬依赖 `fish.message` | 没装 message 的用户整个 ops 不可用 | 每个 op 声明 `requires` |
| 缺依赖时注册“占位工具” | LLM 会调用并收到错误 | 不注册；`fish_ops_list` 解释 |
| 把 base64 放进工具结果 | 上下文爆炸、DSH 卡顿 | 返回路径 |
| 在 ops 里重新实现错误翻译 | 文案不一致 | 透传 `code/hint`，只补 `op/stage` |
| 多步失败后静默重试整条链 | 重复发语音/重复翻译 | 只重试可重试的单步；发送类用幂等 key |
| ops 之间互相调用 | 依赖图变复杂、难卸载 | 共享 `fish.service`，不互相调 |

---

## 10. 部署设计摘要

完整流程见 [`DEPLOY.md`](DEPLOY.md)。核心决策：

1. **打包与模型分离**：代码包 < 50 MB（实测源码 3.6 MB）；引擎依赖（venv 6.5 GB）与模型（17.7 GB）按需。
2. **安装器用 uv**：`uv venv` + `uv pip install`；uv 缺失时下载便携版（校验 SHA256），不要求管理员权限。
3. **模型走服务端 `/admin/models/download`**：安装器不自己实现下载；服务端已有 ModelScope 优先、进度、单任务互斥。
4. **自启复用 `/admin/autostart`**：服务端已实现计划任务 `LocalAIService-Service`；失败再退回启动文件夹快捷方式。
5. **接管优先**：先探配置地址，再探 7880；`/health` + `/capabilities` 版本协商；不匹配提示升级，不重装。
6. **回滚只删自己建的**：`createdPaths` 清单 + 安装标记；模型/音色/声纹/用户 config 默认保留。
7. **WebUI 内嵌**：服务端加 `?embed=1` 隐藏 `.sidebar`/`.topbar`；`postMessage` 高度自适应；插件提供「新窗口打开」兜底。

---

## 11. 迁移设计摘要

完整步骤见 [`MIGRATION.md`](MIGRATION.md)。核心事实与决策：

- **`@memef1f1y/dsh-plugin-tts 0.6.7` 当前不在 `dsh.profile.bundles`**，即未激活；迁移仍要显式校验并记录，防止未来被重新加入。
- 禁用方式：从 `dsh.profile.bundles` 移除（保留 `dependencies` 以便回滚），备份 profile 的 `package.json` / `cordis.patch.yml`。
- **`dsh-fish-message` 不改成硬依赖**：在 `lib/host.js` 里可选 `ctx.get('fish.service')`，`VoiceService` 优先走它，没有就保持现有 HTTP；配置里的 `asrBaseUrl`/`ttsBaseUrl` 标记 deprecated 但继续生效。
- **`fish.message` 服务是新增的**：当前 0.1.0 没有；P4 前先加一个最小 `ctx.provide('fish.message', {apiVersion:'0.2', getVoice, sendVoice, sendText})`，HTTP 路由不变。`fish-ops` 的 `voice_note_analyze`/`say_as_voice` 依赖它。
- **现有 v2.5 直接接管**：`installMode=adopted`，`baseUrl` 从 `fish-message-config.json` 的 `asrBaseUrl`/`ttsBaseUrl` 导入（两者一致时），不重装、不移动目录。
- **服务端需要新增的东西**（当前不存在，P5 做）：
  - `localai bundle`（打包命令）；
  - `localai models install`（统一 `--mirror` / `--json` / 续传语义；现有 `localai models download tts|asr|speaker|demucs|all` 没有这些参数，且不含 translate/vision/whisper）；
  - `GET /version`（轻量版本别名；当前只有 `/capabilities.service.version` 和 `/admin/system.service.version`）；
  - `/ui?embed=1` + `postMessage` 高度自适应；
  - 可选：`POST /media/concat`（长文单条音频拼接，v1 不做）。

---

## 12. 安全、隐私、权限

| 面 | 决策 |
| --- | --- |
| 监听 | 默认 `127.0.0.1`；用户改成 `0.0.0.0` 时 UI 强警告，并要求设置 `LOCALAI_TOKEN` |
| token | 只存 `fish-service-config.json`，宿主路由代理时注入；**不返回给浏览器**、不写日志、不拼 URL |
| 安装下载 | 只允许 HTTPS；manifest 带 SHA256；签名（Ed25519）P5 待定；不执行 `curl \| iex` |
| 安装目录 | 必须是绝对路径、用户可写、非盘符根、非 `C:\Windows`；解析 realpath，拒绝 junction 逃逸 |
| 回滚 | 只删 `createdPaths` 内、且带安装标记的文件；不按通配符删目录 |
| 用户数据 | 音频/声纹/翻译文本不写日志正文；日志只记长度/hash/耗时；缓存本地、可一键清空 |
| WebUI iframe | 只允许 loopback 来源；宿主校验 `event.origin`；不把 token 放 iframe URL |
| 工具权限 | 安装/卸载是高危操作，只由设置页触发；Agent 工具不暴露 `install/uninstall` |
| SSRF | 下载能力由服务端已有的 SSRF 策略负责；`fish-ops` 不自己抓 URL |

---

## 13. 可观测性

- 日志：`~/.dsh/fish-service.log`，5 MB 滚动；字段 `ts level op cap code ms`；用户文本只记长度/前 20 字（可配）。
- 计数器：`/dsh-fish-service/metrics` 返回 JSON：请求数/错误分布/缓存命中/安装步骤耗时/健康检查延迟。
- 健康：状态页显示 `lastCheckAt`、`latencyMs`、`consecutiveFailures`、`serviceVersion`。
- 安装：每一步 `stepId/status/percent/message`，SSE 推送 + 轮询兜底；失败保留完整日志路径。
- 诊断包：设置页「导出诊断」生成 zip（配置脱敏、最近 200 行日志、capabilities、安装状态），**不含 token/音频/文本正文**。

---

## 14. 实施计划

> 每个阶段都必须能独立验收；P1 不依赖 P5 的打包命令，P4 不依赖 P3 的安装器。

### P0 文档与契约冻结（本仓库）

- 产出：`README.md`、`docs/DESIGN.md`、`docs/CONTRACT.md`、`docs/DEPLOY.md`、`docs/MIGRATION.md`；
- 评审：确认接口、错误码、配置字段、阶段验收；
- 完成标准：5 个开放问题有结论（或明确“按推荐执行”）。

### P1 `fish-service` 骨架

- 建 `package.json` / `cordis.patch.yml` / `lib/host.js` / `client.js` 空壳；
- `ConfigStore`（默认值 + env 覆盖 + 原子写）；
- `LocalAIClient`（fetch、超时、AbortSignal、multipart、token）；
- `capabilities` 解析 + 60s 缓存 + 版本校验；
- `fish.service` 的 `health/ensureReady/tts/asr/translate/voices/config/events`；
- 工具：`fish_service_status`、`fish_tts`、`fish_asr`、`fish_translate`（先 4 个，P2 补其余）；
- 设置页：状态 + 地址/默认音色 + 保存；
- 验收：见 15.1。

### P2 UI 入口

> 状态：**已完成**（2026-11-09），实现与验收见 [`P2.md`](P2.md)。

- 朗读按钮（`conversation.chat.assistant-actions`）；
- 语音输入（`conversation.input.right` 优先，`left` 兜底；MediaRecorder + 插入/剪贴板降级）；
- 自动朗读开关（`conversation.input.left`，默认关）；
- 服务未装/未启动的引导与 toast；
- 补 `fish_separate`、`fish_vision_frames`、`fish_media_probe`、`fish_job`；
- 验收：见 15.2。

### P3 WebUI 内嵌 + 安装管理

- 服务端（另一个仓库）加 `?embed=1` + `postMessage` 高度；
- 设置页 iframe + 视图切换 + 新窗口兜底 + 服务未启动引导；
- 安装管理：预检、adopt、启动/停止/重启、模型列表/下载、日志、自启；
- 验收：见 15.3。

### P4 `fish-ops`（条件注册）

- 前置：`dsh-fish-message` 0.2.0 暴露 `fish.message`（最小 `getVoice/sendVoice/sendText`）；
- op manifest + 依赖解析 + 动态注册/摘除；
- 5 个 op + `fish_ops_list`；
- 验收：见 15.4。

### P5 打包与一键安装

- `localai bundle` 命令 + manifest + SHA256；
- 安装器：uv 引导、venv、引擎依赖、模型、启动、自启、进度、失败回滚；
- 离线包 + 镜像；
- 验收：见 15.5。

### P6 迁移与回归

- 禁用 `@memef1f1y/dsh-plugin-tts`（校验 bundles）；
- `fish-message` 可选接 `fish.service`（HTTP 兜底）；
- 接管现有 v2.5；导入 `ttsVoice`/`baseUrl`；
- 全量回归（QQ 语音双向、朗读、安装/卸载、断网、507）；
- 验收：见 15.6。

**依赖关系**

```text
P0 ─→ P1 ─→ P2
        └─→ P3 ─→ P5
        └─→ P4（需 fish-message 0.2.0 的 fish.message）
P2/P4/P5 ─→ P6（迁移是最后一步，避免中途双入口）
```

---

## 15. 验收标准（可测）

### 15.1 P1

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 插件加载 | DSH 重启后无 `failed to import`；设置页出现「本地 AI」tab |
| 2 | 状态 | `fish_service_status` 返回真实 `serviceVersion=2.5.0`、`apiVersion=1`、`tts.ready=true` |
| 3 | TTS | `fish_tts({texts:["测试"]})` 返回存在的 `wavPath`，可播放，`ms>0` |
| 4 | ASR | 对 3 秒中文 wav 调 `fish_asr`，`text` 非空，`speaker` 有名字或明确 `known:false` |
| 5 | 翻译 | `fish_translate({texts:["你好"],target:"en"})` 返回英文，顺序一致 |
| 6 | 服务缺失 | 停止服务后调 `fish_tts`，2 秒内返回 `{ok:false,code:"service_down",hint:"…"}`，不抛堆栈 |
| 7 | 507 翻译 | mock 服务返回 507，工具返回 `vram_exhausted` + 可读 hint，UI 不显示原始英文 |
| 8 | 版本不匹配 | mock `/capabilities` 返回 `api_version:"2"`，状态显示 `api_incompatible`，写工具拒绝 |
| 9 | 配置 | 改 `baseUrl` 保存后立即生效；重启 DSH 仍保留；token 不出现在 `/status` |
| 10 | 卸载 | 禁用插件后工具消失，重新启用后恢复；不残留路由 |

### 15.2 P2

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 朗读按钮 | 每条助手消息操作行只有一个「朗读」；点击能播放；再点停止 |
| 2 | 无重复入口 | 浏览器 Network 无 `/dsh-tts-api/*`；profile bundles 无 TTS 插件；页面只有一个朗读控件 |
| 3 | 语音输入 | 录音 3 秒 → 文字进入输入框（或剪贴板降级提示）；不刷新页面、不丢草稿 |
| 4 | 服务未启动 | 朗读/语音按钮显示引导，不白屏、不报 JS 异常 |
| 5 | 自动朗读 | 默认关；开启后只读最终回复，不读工具调用/代码块 |

### 15.3 P3

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | iframe | `/ui?embed=1` 不显示 `.sidebar`/`.topbar`；宿主 iframe 高度随内容变化（±4px） |
| 2 | 兜底 | iframe 加载失败显示「打开新窗口」+ 原因，不显示空白 |
| 3 | 接管 | 现有 7880 服务被识别为 `adopted`，不重装、不移动目录、不重启 |
| 4 | 安装幂等 | 连续点两次安装：第二次返回 `already_installed`，不自启两次、不重复建任务 |
| 5 | 卸载 | 卸载后服务目录删除，模型/音色/声纹保留；再次安装能复用模型 |
| 6 | 回滚 | 模拟安装第 3 步失败：只删除本次创建的文件，原有目录不受影响 |
| 7 | 端口占用 | 7880 被非 localai 占用时提示换端口/关闭程序，不覆盖 |

### 15.4 P4

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 条件注册 | 禁用 `dsh-fish-message` 重启：`voice_note_analyze`/`say_as_voice`/`translate_and_speak`/`long_text_read` 不在工具列表；`vision_watch` 与 `fish_tts` 仍在 |
| 2 | 诊断 | `fish_ops_list` 显示缺失 `fish.message@>=0.2` 与 hint，且 `vision_watch.available=true` |
| 3 | 热插拔 | 重新启用 message：无需重载 ops，工具在 3 秒内出现 |
| 4 | 语音分析 | 发一条 QQ 语音，`voice_note_analyze` 返回文字 + 声纹名 |
| 5 | 发语音 | `say_as_voice` 发到绑定会话；10 分钟内重复调用不重复发 |
| 6 | 长文 | 2000 字分 3 段发送；第 2 段失败时返回已完成段 + `stage` |
| 7 | 取消 | 取消 `vision_watch` 后 5 秒内停止，job 状态 `canceled` 或不再推进 |

### 15.5 P5

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 打包 | `python -m localai bundle --out dist --version 2.5.0` 产出 zip + manifest + SHA256；代码包 < 50MB |
| 2 | 干净安装 | 空目录、无 uv、无 Python 环境：一键安装成功，`/health` **HTTP 200**（`ok` 可能为 false，因为模型还没下）且 `/capabilities.api_version=1` |
| 3 | 模型 | 勾选 TTS/ASR/声纹/Demucs 下载完成；`/admin/models` 全部 `present=true` |
| 4 | 断网 | 断网后安装：预检给出 `network_unavailable` + 离线包提示；不无限重试 |
| 5 | 离线 | 用离线包 + 本地模型目录安装成功，不访问外网 |
| 6 | 空间不足 | 预检拦截，提示需要 X GB，不开始下载 |
| 7 | 自启 | 重启 Windows 后服务自动起来；卸载后计划任务删除（仅自己创建的） |

### 15.6 P6

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | 禁用 TTS | profile bundles 无 `@memef1f1y/dsh-plugin-tts`；无重复朗读入口 |
| 2 | 回滚 | 重新加入 bundles + 重启，旧 TTS 恢复，fish-service 朗读按钮可同时关掉 |
| 3 | QQ 入站 | 语音消息转写正常，声纹名正确；服务停掉时降级为 `[语音（转写失败：…）]`，消息不丢 |
| 4 | QQ 出站 | `[语音]…[/语音]` 正常发；服务停掉时文字进补发队列，恢复后重发 |
| 5 | 接管 | 现有 v2.5 不被重装；`installMode=adopted`；`ttsVoice` 导入为 `defaultVoice` |
| 6 | 双入口 | 同时启用旧 TTS + fish-service 时，文档要求只开一个；验收时检查没有两个朗读按钮 |

---

## 16. 风险清单

| # | 风险 | 影响 | 概率 | 缓解 / 检测 |
| --- | --- | --- | --- | --- |
| 1 | 插件/服务版本错配 | 调用失败、字段缺失 | 中 | `api_version` 主版本校验；`minServiceVersion`；状态页明示；不自动降级 |
| 2 | Windows 路径/权限 | 安装失败、文件写不进 | 中 | 安装目录白名单校验；realpath；失败给具体路径与权限提示；不要求管理员 |
| 3 | CUDA/torch 体积（6.5GB） | 下载久、磁盘爆 | 高 | 预检磁盘 + 10% 余量；引擎依赖可选；显示真实大小；支持离线包 |
| 4 | 模型下载失败/中断 | 功能不可用 | 高 | 复用服务端 `/admin/models/download`；单任务；重试续传；校验 `present` + 缺失文件 |
| 5 | iframe 兼容性 | 设置页白屏/高度不对 | 中 | 只允许 loopback；`?embed=1`；postMessage 高度 + 固定高度兜底；新窗口打开 |
| 6 | ops 依赖漂移 | 工具消失/重复注册 | 中 | manifest 显式版本；`internal/service` 重解析；单测覆盖“禁用 message”场景 |
| 7 | 双 TTS 冲突 | 一条消息读两遍 | 高 | 迁移清单强制校验 bundles；验收检查 Network 无 `/dsh-tts-api`；设置页互斥提示 |
| 8 | 服务地址被改错 | 全部功能不可用 | 中 | 设置页「测试连接」；保存前 `GET /health`；保留最近一次可用地址 |
| 9 | 卸载误删用户模型 | 数据丢失 | 低 | 安装标记 + createdPaths；默认保留 models/voices/speakers；二次确认 |
| 10 | 长文本 TTS 超时 | 朗读中断 | 中 | 分段 ≤800 字；总预算；逐段发送；失败保留已完成段 |
| 11 | 视觉长视频阻塞 | UI 卡住 | 中 | >10 分钟走 job；进度轮询；可取消 |
| 12 | token 泄漏 | 本机接口被滥用 | 低 | 仅宿主持有；不返浏览器；日志脱敏；loopback 默认 |

---

## 17. 开放问题（评审拍板）

1. **`dsh-fish-message` 的依赖形态**：保持「可选 `fish.service` + HTTP 兜底」（推荐，兼容旧装机），还是 0.2.0 起强制依赖？
2. **默认音色迁移**：`fish-message` 当前 `ttsVoice=dafeiyu`；新装服务端 `default` 也在。迁移时保留 `dafeiyu`（推荐，声音不变），还是统一改成 `default`？
3. **安装目录策略**：新装默认 `%LOCALAPPDATA%\localai-service`，现有 `E:\LocalAIService` 只接管不迁移（推荐）；是否要做「迁移到新目录」向导（会移动 17.7GB 模型）？
4. **发布与签名**：首发走 GitHub Releases 还是内网文件服务器？是否强制 Ed25519 签名（增加 P5 工作量，但能防篡改）？
5. **长文单条音频**：v1 只逐段发语音（推荐，零服务端改动）；还是要求服务端新增 `/media/concat`，把多段拼成一条？

> 未拍板前，按括号里的“推荐”执行；P1/P2 不受这 5 个问题阻塞。

---

## 18. 附录

### 18.1 实测环境快照（2026-11-09）

```text
GET http://127.0.0.1:7880/capabilities
  service.name    = localai-service
  service.version = 2.5.0
  api_version     = 1
  listen          = 127.0.0.1:7880
  gpu             = RTX 3070, 8192MB, free 6973MB
  tts             = ready, model IndexTTS-2.5, estimate 6400MB
  asr             = ready, SenseVoiceSmall, estimate 1200MB
  whisper         = ready, faster-whisper-small, estimate 600MB
  translate       = ready, nllb-200-distilled-600M, estimate 1500MB
  speaker         = ready, campplus, estimate 300MB
  separate        = ready, htdemucs, estimate 1000MB
  vision          = ready, Qwen2.5-VL-3B-Instruct-Q4_K_M, estimate 3400MB
  media/download  = ready
  jobs            = enabled, max_parallel 1, per_kind asr=2
```

```text
GET /admin/system
  paths.home = E:\LocalAIService
  autostart  = LocalAIService-Service, enabled, Running
  gpu.driver = 591.59
  disk.models_mb = 17665.6
```

### 18.2 关键文件路径

| 路径 | 用途 |
| --- | --- |
| `E:\LocalAIService\docs\SERVICE_API.md` | HTTP 契约（2219 行） |
| `E:\LocalAIService\docs\WEBUI.md` | WebUI 与 `/admin/*` |
| `E:\LocalAIService\docs\PLUGIN_CONTRACT.md` | 已有“插件只走 HTTP”约束 |
| `E:\LocalAIService\start_ai_service.ps1` | 启动脚本（UTF-8 BOM） |
| `E:\LocalAIService\engine\.venv\Scripts\python.exe` | 服务解释器 |
| `E:\LocalAIService\models\` | 模型（17.7GB） |
| `E:\dsh-fish-message\lib\voice.js` | 现有 ASR/TTS HTTP 调用点 |
| `E:\dsh-fish-message\lib\host.js` | 插件入口、`inject`、路由、effect |
| `~\.dsh\fish-message-config.json` | 现有地址/音色配置 |
| `~\.dsh\tts-rvc\settings.json` | 旧 TTS 插件的 Index-TTS2 地址 |
| `~\.dsh\profiles\desktop\package.json` | profile bundles（迁移要改这里） |
| `~\.dsh\profiles\desktop\cordis.patch.yml` | profile patch（备份对象） |

### 18.3 术语对照

| 中文 | 代码/字段 |
| --- | --- |
| 服务门面 | `fish.service` / `dsh-fish-service` |
| 组合链路 | op / `dsh-fish-ops` |
| 能力 | capability |
| 就绪 | `ready` |
| 已加载 | `loaded` |
| 显存不足 | `insufficient_vram`（507） |
| 接管 | `installMode=adopted` |
| 托管安装 | `installMode=managed` |
