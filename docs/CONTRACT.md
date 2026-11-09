# 接口契约（CONTRACT）

> 版本：`v0.1`（P0 冻结稿）
> 适用：`dsh-fish-service` / `dsh-fish-ops` / `localai-service 2.5.x`
> 原则：**先改本文，再改代码**。P1 只实现本文已写明的字段；新增字段必须向后兼容。

---

## 0. 总则

### 0.1 三个版本号

| 名称 | 位置 | 当前 | 规则 |
| --- | --- | --- | --- |
| HTTP 契约 | `GET /capabilities` → `api_version` | `"1"` | 主版本不兼容；新增字段兼容 |
| Cordis 服务 | `fish.service.apiVersion` | `"1.0"` | 主版本必须相同；次版本向后兼容 |
| `fish.message` | `fish.message.apiVersion` | `"0.2"`（规划） | 0.x 允许小版本破坏，但必须显式升 `requires` |

### 0.2 通用返回包

所有工具与服务方法统一：

```json
{ "ok": true, "...": "..." }
```

```json
{ "ok": false, "code": "vram_exhausted", "hint": "显存不够……", "detail": "insufficient_vram: need 6912MB free 6000MB", "retryable": false }
```

- `code`：见第 3 节；`hint`：可直接展示给用户的中文；`detail`：诊断原文，不直接进 UI；
- 失败**不抛裸异常**（服务方法内部可以 throw `FishServiceError`，但工具层必须转成上面的包）；
- 未知字段调用方必须忽略；未知 `code` 按 `upstream_error` 处理并保留原值。

### 0.3 路径与文件

- 所有 `*Path` 都是**本机绝对路径**（Windows 用 `E:\...`；JSON 里反斜杠转义）；
- 工具返回的路径必须存在且可读；临时文件 TTL 见配置；
- 不接受 `file://`、URL（除 `vision_watch` 的 `url` 参数）；下载由服务端负责。

---

## 1. Cordis 服务：`fish.service`

### 1.1 类型定义

```ts
type CapabilityName =
  | 'tts' | 'asr' | 'translate' | 'separate'
  | 'vision' | 'media' | 'download' | 'jobs'

interface CapabilityInfo {
  available: boolean          // 服务暴露了该能力且 ready
  ready: boolean              // 模型文件齐全（服务端 capabilities.<name>.ready）
  loaded: boolean             // 当前是否占显存
  model?: string
  reason?: 'service_down' | 'model_missing' | 'not_supported' | 'api_incompatible'
  versions?: { service?: string; api?: string }
  estimateMb?: number
}

interface FishServiceApi {
  apiVersion: '1.0'
  capabilities: Record<CapabilityName, CapabilityInfo>
  health(opts?: { timeoutMs?: number }): Promise<HealthResult>
  ensureReady(cap: CapabilityName, opts?: { preload?: boolean; timeoutMs?: number }): Promise<ReadyResult>
  tts(input: string | string[], opts?: TtsOptions): Promise<TtsResult>
  asr(input: string | string[], opts?: AsrOptions): Promise<AsrResult>
  translate(input: string | string[], opts: TranslateOptions): Promise<TranslateResult>
  separate(file: string, opts?: SeparateOptions): Promise<SeparateResult>
  visionFrames(input: VisionInput, opts?: VisionOptions): Promise<VisionResult>
  mediaProbe(input: string | string[], opts?: { timeoutMs?: number }): Promise<ProbeResult>
  jobs: JobsApi
  voices(opts?: { timeoutMs?: number }): Promise<VoiceInfo[]>
  config: {
    get(): PublicConfig
    set(patch: Partial<PublicConfig>): Promise<{ ok: boolean; applied: string[]; requiresRestart: boolean; warnings: string[] }>
  }
  events: {
    on(name: FishEventName, fn: (e: FishEvent) => void): () => void
    off(name: FishEventName, fn: (e: FishEvent) => void): void
    once(name: FishEventName, fn: (e: FishEvent) => void): () => void
  }
  install: InstallApi   // 只给本插件 UI/工具；其它插件不要用
}
```

### 1.2 `capabilities` 形状

```json
{
  "tts": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "IndexTTS-2.5",
    "versions": { "service": "2.5.0", "api": "1" },
    "estimateMb": 6400
  },
  "asr": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "SenseVoiceSmall",
    "estimateMb": 1200
  },
  "translate": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "nllb-200-distilled-600M",
    "estimateMb": 1500
  },
  "separate": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "htdemucs",
    "estimateMb": 1000
  },
  "vision": {
    "available": true,
    "ready": true,
    "loaded": false,
    "model": "Qwen2.5-VL-3B-Instruct-Q4_K_M",
    "estimateMb": 3400
  },
  "media": { "available": true, "ready": true, "loaded": false, "model": "ffmpeg", "estimateMb": 0 },
  "download": { "available": true, "ready": true, "loaded": false, "model": "yt-dlp", "estimateMb": 0 },
  "jobs": { "available": true, "ready": true, "loaded": false }
}
```

规则：

- `available = 服务可达 && api_version 兼容 && 服务端 capabilities.<cap> 存在 && ready`；
- `reason` 只在 `available=false` 时出现；
- `whisper` 不是独立工具能力，归到 `asr` 的 `engine=whisper`；`speaker` 归到 `asr` 的 `speaker:true`；
- `jobs` 永远 `available=true`（只要服务可达且 `jobs.enabled`），因为它是一个 API 组，不是模型。

### 1.3 `health()`

```ts
interface HealthResult {
  ok: boolean
  baseUrl: string
  latencyMs: number
  checkedAt: string            // ISO8601
  serviceVersion?: string
  apiVersion?: string
  vram?: { freeMb: number; totalMb: number; marginMb?: number }
  capabilities?: Record<CapabilityName, CapabilityInfo>
  consecutiveFailures: number
  lastError?: { code: string; detail: string }
}
```

- 超时默认 2000ms；不发任何会加载模型的请求；
- `ok` 表示**服务可达且 api 兼容**，不是 localai `/health.ok`。localai 的 `ok` 只表示 TTS 权重就绪；模型没下时它仍是 HTTP 200 + `ok:false`，此时 `health().ok=true`、`capabilities.tts.ready=false`；
- `ok=false` 时 `capabilities` 可省略（服务都没通，不猜）；
- `latencyMs` 是本次 `/health` 的墙钟。

### 1.4 `ensureReady(cap, opts)`

```ts
interface ReadyResult {
  ok: boolean
  capability: CapabilityName
  ready: boolean
  loaded: boolean
  willLoadOnFirstUse: boolean
  waitedMs: number
  released?: string[]
  code?: string
  hint?: string
}
```

语义：

1. 服务不可达 → `service_down`；
2. `api_version` 不兼容 → `api_incompatible`；
3. 能力不存在 → `upstream_error`（`detail: unsupported capability`）；
4. `ready=false` → `model_missing`，带模型名/大小（能从 `/admin/models` 拿到就带）；
5. `preload:true` 且 `cap='tts'`：合成 `"嗯"` 一次，返回后 `loaded=true`；其它能力**不支持强制 preload**，返回 `willLoadOnFirstUse:true` 且 `ok=true`；
6. 不主动卸载任何模型；显存不够只报告，不替用户做决定。

### 1.5 `tts(input, opts)`

```ts
interface TtsOptions {
  voice?: string              // 默认 config.defaultVoice
  speed?: number              // 0.5~2.0，默认 1.0
  emotion?: string            // 服务端支持的情感文本/8 维向量；不校验内容
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'es' | 'ar'
  seed?: number               // 0~2^32-1；不传=随机
  timeoutMs?: number          // 默认 config.requestTimeoutMs
  returnBuffer?: boolean      // 默认 false；UI 播放也别用，走 /audio/<id>
}

interface TtsResult {
  ok: boolean
  items: Array<{
    wavPath: string
    ms: number
    voice: string
    seed: number
    language?: string
    bytes: number
    cached?: boolean
    buffer?: Uint8Array   // 仅 returnBuffer:true 时；工具层永不返回
  }>
  ms: number
}
```

- 单条也传数组；工具层 `texts` 必填，服务方法允许 `string`（内部归一成数组）；
- 每条文本 ≤ 5000 字；超过返回 `bad_request`（不要偷偷切）；
- 产物写 `~/.dsh/fish-service-cache/tts/`，返回稳定路径；
- `returnBuffer:true` 时 `items[].buffer` 是 `Uint8Array`（宿主内存内使用）；**工具层禁止设置该选项**，否则违反“不回传 base64”的约定；
- 响应头 `X-Audio-Path` 只用于诊断，不直接返回（可能被服务端清理）；
- 空数组 / 空字符串 → `bad_request`。

### 1.6 `asr(input, opts)`

```ts
interface AsrOptions {
  language?: 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'yue' | 'nospeech'
  engine?: 'auto' | 'sensevoice' | 'whisper'
  speaker?: boolean            // 默认 true；false 时连 campplus 都不加载
  timestamps?: boolean         // true 时走 /asr/segments（固定 whisper）
  timeoutMs?: number           // 默认 config.asrTimeoutMs
}

interface AsrResult {
  ok: boolean
  items: Array<{
    file: string
    text: string
    language?: string
    engine?: 'sensevoice' | 'whisper'
    durationMs?: number
    elapsedMs?: number
    speaker?: { name: string; score: number; known: boolean } | null
    speakerError?: string
    segments?: Array<{ start: number; end: number; text: string }>
    truncated?: boolean
  }>
  ms: number
}
```

- 文件必须是本机绝对路径；不存在 → `bad_request`；
- 上传上限 200MB（音频 50MB）；超限 → `bad_request`，hint 提示裁剪；
- `timestamps:true` 时用 `/asr/segments`，`segments` 最多返回 200 段；
- `speaker` 失败不影响转写：`speaker:null` + `speakerError`，整体 `ok:true`；
- 临时上传文件请求结束即删。

### 1.7 `translate(input, opts)`

```ts
interface TranslateOptions {
  source: string         // 'auto' | 'zh' | 'en' | NLLB 码
  target: string         // 必填，不能 'auto'
  timeoutMs?: number     // 默认 60000
  batchSize?: number     // 默认 8；1~16
}

interface TranslateResult {
  ok: boolean
  texts: string[]
  source: string         // 实际使用的 NLLB 码
  target: string
  engine: 'nllb'
  ms: number
  chunks?: number
}
```

- 1 条走 `/translate`；2~500 条走 `/translate/batch`；超过 500 条或 200k 字 → `bad_request`，提示用 `fish_job` 或拆批；
- 返回顺序与输入严格一致；
- 空字符串原样返回；
- `source='auto'` 只覆盖常见语种；失败 → `bad_request`，hint 要求显式 `source`。

### 1.8 `separate(file, opts)`

```ts
interface SeparateOptions {
  model?: 'htdemucs' | 'htdemucs_6s' | 'htdemucs_ft'  // 默认 htdemucs
  stems?: string[]        // 默认 ['vocals','drums','bass','other']
  timeoutMs?: number      // 默认 config.asrTimeoutMs
}

interface SeparateResult {
  ok: boolean
  stems: Record<string, { path: string; duration?: number }>
  dir: string
  ms: number
  released?: string[]     // 为腾显存被 LRU 卸掉的能力
}
```

- 产物复制到 `~/.dsh/fish-service-cache/separate/<jobid>/`，不返回服务端 `outputs/` 原路径；
- `stems` 至少 1 个；未知 stem → `bad_request`。

### 1.9 `visionFrames(input, opts)`

```ts
interface VisionInput {
  videoPath?: string      // 本机路径，与 url 二选一
  url?: string            // 公开链接；内部先下载
  jobId?: string          // 服务端任务 id，取 result.path
}

interface VisionOptions {
  targetFrames?: number   // 1~10，默认 3
  effort?: 'auto' | 'low' | 'medium' | 'high'
  planner?: 'hybrid' | 'agent'
  subtitles?: 'auto' | 'off'   // 默认 auto
  timeoutMs?: number      // 默认 config.visionTimeoutMs
}

interface VisionResult {
  ok: boolean
  frames: Array<{
    time: number
    path: string
    score?: number
    kind?: string
    ocrText?: string
    summary?: string
    why?: string
    confidence?: 'normal' | 'low'
  }>
  duration?: number
  subtitlesFrom?: 'embedded' | 'sidecar' | 'asr' | 'provided' | 'site' | 'none'
  stats?: { candidates?: number; vlmCalls?: number; elapsedMs?: number; degraded?: boolean; degradedReason?: string }
  ms: number
}
```

- 视频 ≤ 10 分钟默认同步 `/vision/frames`；> 10 分钟或 `effort=high` 默认走 `/jobs/vision` 轮询；
- `frames[].path` 复制到 DSH 缓存（原 `outputs/` 会被清理）；
- **不返回 base64 / preview**；
- 返回帧数少于 `targetFrames` 时 `ok:true` + `stats` 说明，不伪造。

### 1.10 `mediaProbe(input)`

```ts
interface ProbeResult {
  ok: boolean
  items: Array<{
    file: string
    duration?: number
    format?: string
    audio?: { codec?: string; sampleRate?: number; channels?: number }
    video?: { codec?: string; width?: number; height?: number; fps?: number }
  }>
  ms: number
}
```

- 1~10 个文件；单文件 ≤ 200MB；
- 只调 `/media/probe`；不触发 ffmpeg 转码。

### 1.11 `jobs`

```ts
interface JobsApi {
  enqueue(kind: 'tts'|'asr'|'separate'|'translate'|'download'|'analyze'|'vision',
          payload: Record<string, unknown>,
          opts?: { priority?: number; files?: string[]; timeoutMs?: number }): Promise<{ ok: boolean; id: string; state: string }>
  status(id: string, opts?: { timeoutMs?: number }): Promise<JobRecord>
  wait(id: string, opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal }): Promise<JobRecord>
  cancel(id: string): Promise<{ ok: boolean; id: string; state: string; cancelRequested?: boolean }>
  list(filter?: { kind?: string; state?: string; limit?: number; offset?: number }): Promise<{ ok: boolean; total: number; jobs: JobRecord[] }>
}

interface JobRecord {
  ok: boolean
  id: string
  kind: string
  action?: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  priority?: number
  createdAt?: string
  startedAt?: string
  finishedAt?: string
  attempts?: number
  error?: string
  result?: Record<string, unknown>
  progress?: { stage?: string; percent?: number; downloadedBytes?: number; totalBytes?: number; speed?: number; eta?: number }
}
```

- `enqueue` 的 `files` 会先上传到服务端（multipart），`payload.file` 用服务端路径；
- `wait` 默认总超时 600s；下载任务可传 1800s；`signal` 取消时调用 `cancel`；
- `status` 不返回完整 `payload`（可能含用户文本）；只返回 `kind/state/result/error` 摘要；
- `cancel` 对终态返回 `canceled` 扩展码，不是错误。

### 1.12 `voices()`

```json
[
  { "name": "dafeiyu", "filename": "dafeiyu.wav", "format": "wav", "duration": 9.4 },
  { "name": "default", "filename": "default.mp3", "format": "mp3", "duration": 3.157 }
]
```

- 直接映射 `/voices`；不缓存超过 30 秒（音色目录可能新增文件）；
- 名称不含扩展名；上传音色不在本契约内（服务端 `/api/v1/upload` 可选）。

### 1.13 `config`

`get()` 返回**脱敏**配置：`token` 只返回 `"***"` 或 `""`，其余字段原样。

`set(patch)` 只接受白名单：

| 字段 | 可写 | 校验 |
| --- | --- | --- |
| `baseUrl` | ✅ | `http://` / `https://`，保存前 `GET /health`（可在 UI 里跳过） |
| `token` | ✅ | 字符串；只写，不回显 |
| `enabled` | ✅ | boolean |
| `defaultVoice` | ✅ | 必须存在于 `/voices`（离线时允许先保存，状态页标红） |
| `autoRead` | ✅ | boolean |
| `maxCharsPerChunk` | ✅ | 200~5000 |
| `requestTimeoutMs` / `asrTimeoutMs` / `visionTimeoutMs` | ✅ | 1000~1800000 |
| `healthIntervalMs` | ✅ | 5000~120000 |
| `busyAfterMs` | ✅ | 5000~300000 |
| `cacheTtlHours` / `cacheMaxMb` | ✅ | 1~720 / 256~10240 |
| `modelMirror` / `pypiIndex` / `torchIndex` | ✅ | 枚举/URL |
| `installDir` | ✅（仅未安装时） | 绝对路径 |
| `installMode` / `version` | ❌ | 由安装器维护 |

返回：

```json
{ "ok": true, "applied": ["defaultVoice"], "requiresRestart": false, "warnings": [] }
```

### 1.14 `events`

| 事件 | payload | 触发 |
| --- | --- | --- |
| `model-loaded` | `{capability, model, at}` | 轮询发现 `loaded=false→true` |
| `model-unloaded` | `{capability, model?, at}` | `loaded=true→false` |
| `error` | `{code, capability?, detail, at}` | 请求失败（节流：同 code 30s 一次） |
| `service-down` | `{reason, at}` | 连续 2 次健康失败 |
| `service-up` | `{serviceVersion, at}` | 失败后首次成功 |

- 事件是**尽力而为**：轮询间隔内最多延迟 15s；不保证每次模型加载都触发；
- 监听器异常不影响主流程；`on` 返回 disposer。

### 1.15 `install`（内部 API）

```ts
interface InstallApi {
  status(): Promise<InstallStatus>
  preflight(opts?: { installDir?: string; port?: number }): Promise<PreflightResult>
  start(opts: { installDir: string; models: string[]; installEngine: boolean; autoStart: boolean }): Promise<{ ok: boolean; taskId: string }>
  cancel(): Promise<{ ok: boolean }>
  adopt(opts?: { baseUrl?: string }): Promise<{ ok: boolean; installMode: 'adopted'; serviceVersion?: string }>
  uninstall(opts: { removeModels?: boolean; keepConfig?: boolean }): Promise<{ ok: boolean; removed: string[]; kept: string[] }>
  models(): Promise<ModelInfo[]>
  logs(opts?: { lines?: number; file?: 'service' | 'err' }): Promise<{ ok: boolean; lines: string[] }>
}
```

详细字段与状态机见 [`DEPLOY.md`](DEPLOY.md) 第 3 节。

---

## 2. DSH 工具契约

### 2.1 通用规则

- 工具名全局唯一；本插件固定 8 个（第 2.2 节）；
- `parameters` 是标准 JSON Schema（object 根，`additionalProperties:false`）；
- `output` 用 JSON Schema 描述成功包；失败包统一 `{ok:false, code, hint, detail?, retryable}`；
- 所有路径必须绝对路径；工具不做 `~` 展开（由调用方/LLM 给绝对路径）；
- 批量上限是硬限制，超限 `bad_request`，不静默截断。

### 2.2 工具清单

| 工具 | 参数（必填加 *） | 返回 | 主要错误 |
| --- | --- | --- | --- |
| `fish_tts` | `texts*` (1~20)、`voice`、`speed` 0.5~2、`language`、`seed` | `items[{wavPath,ms,voice,seed,bytes}]` | `service_down`、`model_missing`、`vram_exhausted`、`timeout`、`bad_request` |
| `fish_asr` | `files*` (1~10)、`language`、`engine`、`speaker`、`timestamps` | `items[{file,text,segments?,speaker?,engine,ms}]` | 同上 + `bad_request`（文件不存在/超限） |
| `fish_translate` | `texts*` (1~200)、`source`、`target*` | `{texts,source,target,ms}` | `bad_request`（语言/长度）、`service_down`、`vram_exhausted` |
| `fish_separate` | `file*`、`model`、`stems[]` | `{stems,dir,ms,released?}` | `model_missing`（htdemucs_ft）、`vram_exhausted`、`timeout` |
| `fish_vision_frames` | `videoPath*`、`targetFrames` 1~10、`effort`、`planner`、`subtitles` | `{frames[],duration,subtitlesFrom,stats,ms}` | `model_missing`、`vram_exhausted`、`timeout`、`bad_request` |
| `fish_media_probe` | `files*` (1~10) | `{items[],ms}` | `bad_request`、`service_down` |
| `fish_job` | `action*` (`status/cancel/list/wait`)、`jobId`、`kind`、`state`、`limit` | 任务记录/列表 | `bad_request`（缺 jobId）、`canceled`、`timeout` |
| `fish_service_status` | 无 | `{ok,baseUrl,version,apiVersion,capabilities,vram,voices,install,autostart,lastError}` | 永远 `ok:true`（服务不可达时 `ok:false` 但仍有诊断） |

### 2.3 `fish_tts` 完整 schema

```json
{
  "name": "fish_tts",
  "description": "用本地 IndexTTS-2.5 合成语音（可一次多条）。返回本机 wav 路径与耗时；不返回 base64。首条可能因加载模型较慢，超时默认 180 秒。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "texts": {
        "type": "array",
        "items": { "type": "string", "minLength": 1, "maxLength": 5000 },
        "minItems": 1,
        "maxItems": 20,
        "description": "要合成的文本；单条也传数组。每条 ≤5000 字。"
      },
      "voice": { "type": "string", "description": "音色名，如 dafeiyu/default；默认取配置。" },
      "speed": { "type": "number", "minimum": 0.5, "maximum": 2.0, "default": 1.0 },
      "language": { "type": "string", "enum": ["auto", "zh", "en", "ja", "es", "ar"], "default": "auto" },
      "seed": { "type": "integer", "minimum": 0, "maximum": 4294967295, "description": "不传=随机；同一 seed 可复现。" }
    },
    "required": ["texts"]
  },
  "output": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "wavPath": { "type": "string" },
            "ms": { "type": "number" },
            "voice": { "type": "string" },
            "seed": { "type": "number" },
            "language": { "type": "string" },
            "bytes": { "type": "number" },
            "cached": { "type": "boolean" }
          },
          "required": ["wavPath", "ms", "voice", "seed", "bytes"]
        }
      },
      "ms": { "type": "number" }
    },
    "required": ["ok", "items", "ms"]
  }
}
```

成功示例：

```json
{
  "ok": true,
  "items": [
    { "wavPath": "C:\\Users\\Administrator\\.dsh\\fish-service-cache\\tts\\a1b2c3d4-1794200000.wav", "ms": 8530, "voice": "dafeiyu", "seed": 42, "language": "zh", "bytes": 182300, "cached": false }
  ],
  "ms": 8530
}
```

失败示例：

```json
{ "ok": false, "code": "vram_exhausted", "hint": "显存不够（需要约 6.4 GB，当前空闲 2.1 GB）。关掉占显存的程序，或在服务 WebUI 里卸载其它模型。", "detail": "insufficient_vram: need 6912MB free 6000MB", "retryable": false }
```

### 2.4 `fish_asr` 完整 schema

```json
{
  "name": "fish_asr",
  "description": "本地转写音频/视频（可一次多个）。默认 SenseVoice + 声纹；timestamps=true 时用 whisper 分段。返回文字、声纹、可选分段；不返回音频。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "files": {
        "type": "array",
        "items": { "type": "string" },
        "minItems": 1,
        "maxItems": 10,
        "description": "本机绝对路径；音频或视频，单文件 ≤200MB。"
      },
      "language": { "type": "string", "enum": ["auto", "zh", "en", "ja", "ko", "yue", "nospeech"], "default": "auto" },
      "engine": { "type": "string", "enum": ["auto", "sensevoice", "whisper"], "default": "auto" },
      "speaker": { "type": "boolean", "default": true, "description": "false 时跳过声纹，省 campplus 加载。" },
      "timestamps": { "type": "boolean", "default": false, "description": "true 时走 /asr/segments（固定 whisper）。" }
    },
    "required": ["files"]
  },
  "output": {
    "type": "object",
    "properties": {
      "ok": { "type": "boolean" },
      "items": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "file": { "type": "string" },
            "text": { "type": "string" },
            "language": { "type": "string" },
            "engine": { "type": "string" },
            "durationMs": { "type": "number" },
            "elapsedMs": { "type": "number" },
            "speaker": {
              "type": ["object", "null"],
              "properties": { "name": { "type": "string" }, "score": { "type": "number" }, "known": { "type": "boolean" } }
            },
            "speakerError": { "type": "string" },
            "segments": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": { "start": { "type": "number" }, "end": { "type": "number" }, "text": { "type": "string" } },
                "required": ["start", "end", "text"]
              }
            },
            "truncated": { "type": "boolean" }
          },
          "required": ["file", "text"]
        }
      },
      "ms": { "type": "number" }
    },
    "required": ["ok", "items", "ms"]
  }
}
```

### 2.5 `fish_job` 完整 schema

```json
{
  "name": "fish_job",
  "description": "查询/取消/等待本地服务任务，或列最近任务。长任务（下载、视觉、批量翻译）先用 enqueue 再轮询；本工具只做查询与控制，不提交新任务。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "action": { "type": "string", "enum": ["status", "cancel", "list", "wait"] },
      "jobId": { "type": "string", "description": "action=status/cancel/wait 时必填。" },
      "kind": { "type": "string", "enum": ["tts", "asr", "separate", "translate", "download", "analyze", "vision"] },
      "state": { "type": "string", "enum": ["queued", "running", "done", "failed", "canceled"] },
      "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
      "timeoutMs": { "type": "integer", "minimum": 1000, "maximum": 1800000, "default": 600000 }
    },
    "required": ["action"]
  }
}
```

### 2.6 其余工具参数与返回

**`fish_translate`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `texts` | string[] | ✅ | 1~200 条，每条 ≤5000 字，总 ≤200k 字 | 要翻译的文本 |
| `source` | string | ❌ | `auto` / `zh` / `en` / NLLB 码 | 默认 `auto`；超短文本检测不稳，建议显式 |
| `target` | string | ✅ | 不能 `auto` | 目标语言 |

返回：`{ok, texts[], source, target, engine:"nllb", ms, chunks?}`。
错误：`bad_request`（语言/长度/超 500 条）、`service_down`、`vram_exhausted`、`timeout`。

**`fish_separate`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `file` | string | ✅ | 本机绝对路径，≤200MB | 音频或视频 |
| `model` | string | ❌ | `htdemucs`（默认）/`htdemucs_6s`/`htdemucs_ft` | `htdemucs_ft` 需额外权重，缺则 `model_missing` |
| `stems` | string[] | ❌ | 默认 `["vocals","drums","bass","other"]` | 未知 stem → `bad_request` |

返回：`{ok, stems:{vocals:{path,duration?}, ...}, dir, ms, released?}`。
错误：`model_missing`、`vram_exhausted`、`timeout`、`bad_request`。

**`fish_vision_frames`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `videoPath` | string | ✅ | 本机绝对路径；与 `url` 二选一（工具层只暴露 path） | 视频/图片目录 |
| `targetFrames` | integer | ❌ | 1~10，默认 3 | 关键帧数 |
| `effort` | string | ❌ | `auto`（默认）/`low`/`medium`/`high` | 预算档位 |
| `planner` | string | ❌ | `hybrid`（默认）/`agent` | 规划器 |
| `subtitles` | string | ❌ | `auto`（默认）/`off` | 是否用软字幕/ASR 辅助选帧 |

返回：`{ok, frames:[{time,path,score?,kind?,ocrText?,summary?,why?,confidence?}], duration?, subtitlesFrom?, stats?, ms}`。
错误：`model_missing`、`vram_exhausted`、`timeout`、`bad_request`；视频没有视频流 → `bad_request`。

**`fish_media_probe`**

| 参数 | 类型 | 必填 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `files` | string[] | ✅ | 1~10 个，单文件 ≤200MB | 本机绝对路径 |

返回：`{ok, items:[{file,duration?,format?,audio?,video?}], ms}`。
错误：`bad_request`（文件不存在/超限）、`service_down`、`timeout`。

### 2.7 `fish_service_status` 返回示例

```json
{
  "ok": true,
  "baseUrl": "http://127.0.0.1:7880",
  "version": "2.5.0",
  "apiVersion": "1",
  "latencyMs": 12,
  "vram": { "freeMb": 6973, "totalMb": 8192 },
  "capabilities": { "tts": { "available": true, "ready": true, "loaded": false, "model": "IndexTTS-2.5" } },
  "voices": ["dafeiyu", "default", "female-A"],
  "install": { "installMode": "adopted", "installDir": "E:\\LocalAIService", "serviceVersion": "2.5.0" },
  "autostart": { "supported": true, "enabled": true, "name": "LocalAIService-Service" },
  "lastError": null
}
```

### 2.8 工具错误返回示例

```json
{ "ok": false, "code": "service_down", "hint": "本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。", "detail": "fetch failed: ECONNREFUSED 127.0.0.1:7880", "retryable": true, "retryAfterMs": 5000 }
```

---

## 3. 错误码

### 3.1 完整表

| code | 来源 | HTTP/条件 | `retryable` | hint（固定文案） |
| --- | --- | --- | --- | --- |
| `service_not_installed` | 插件 | 无配置 + 探测不到 + 无安装标记 | false | 还没装本地 AI 服务。打开 设置 → 插件 → 本地 AI → 安装服务。 |
| `service_down` | 插件 | ECONNREFUSED / 健康超时 / 进程不在 | true | 本地 AI 服务没在运行。点『启动服务』，或运行 start_ai_service.ps1。 |
| `model_missing` | 服务+插件 | `cap.ready=false`；或 `/admin/models` `present=false`；或 503 + 缺权重 | false | 缺少 {model} 模型（约 {size}）。到『模型管理』勾选下载。 |
| `model_loading` | 服务+插件 | 503 detail 含“加载/loading”；或冷加载 in-flight 超 3s 再次请求 | true | 模型正在加载，通常 10~60 秒；稍后再试。 |
| `vram_exhausted` | 服务 | 507 `insufficient_vram` | false | 显存不够（需要约 {need}，当前空闲 {free}）。关掉占显存的程序，或在服务 WebUI 里卸载其它模型。 |
| `busy` | 插件 | 队列等待 > `busyAfterMs`；或 503 含“队列/busy” | true | 服务正在忙（队列还有 {n} 个任务），已经排队；可用 fish_job 查进度。 |
| `timeout` | 插件 | 504 `job_timeout`/`comfy_error`；fetch AbortError | true（一次） | 等太久了（>{timeout} 秒），模型可能正在加载。稍后重试；长文本请分段。 |
| `bad_request` | 服务 | 400/401/403/404/413/422 | false | 参数不对：{detail}。修正后重试，不要原样重试。 |
| `upstream_error` | 服务 | 500/502/503（能力 ready 但失败） | true（一次） | 服务内部报错：{detail}。可重试一次；仍失败看 logs\service.err.log。 |
| `api_incompatible` | 插件 | `api_version` 主版本 ≠ 1 | false | 服务契约版本不匹配（服务 {v}，插件支持 1.x）。请升级插件或服务。 |
| `canceled` | 服务+插件 | 409 `job_canceled`；或用户取消 | false | 任务已取消。 |
| `not_implemented` | 插件 | 契约保留、本版未做 | false | 这个功能还没实现（{feature}）。 |

### 3.2 HTTP 映射细节

| HTTP | 服务端 `error` | 映射 | 备注 |
| --- | --- | --- | --- |
| 400 | `invalid_*` / `voice_not_found` | `bad_request` | 不重试 |
| 401 | `unauthorized` | `bad_request` | hint 提示检查 token；**不**自动重试 |
| 403 | `result_path_not_allowed` | `bad_request` | 路径越界；不要换路径重试 |
| 404 | `voice_not_found` / `job_not_found` | `bad_request` | 音色不存在 → 刷新 `/voices` |
| 409 | `job_not_done` / `not_cancelable` | `bad_request` | 任务状态不允许 |
| 409 | `job_canceled` | `canceled` | 用户取消 |
| 413 | — | `bad_request` | 提示裁剪/压缩 |
| 422 | 校验错误 | `bad_request` | FastAPI 默认 |
| 500 | — | `upstream_error` | 可重试一次 |
| 502 | `comfy_error` | `upstream_error` | 仅 comfy 后端 |
| 503 | `engine_error` / `asr_error` / …且 `cap.ready=false` | `model_missing` | 先看 `/admin/models` |
| 503 | 同上但 `cap.ready=true` | `upstream_error` | 引擎加载失败 |
| 503 | detail 含“加载/loading” | `model_loading` | 服务端没有独立 code，按文案识别 |
| 504 | `job_timeout` / `comfy_error` | `timeout` | 不无限重试 |
| 507 | `insufficient_vram` | `vram_exhausted` | 带 `need_mb/free_mb` 进 detail |

### 3.3 重试策略

- `service_down` / `busy` / `model_loading`：最多重试 1 次，退避 2~5s；
- `timeout`：最多 1 次；长文本先分段；
- `upstream_error`：最多 1 次；
- `vram_exhausted` / `model_missing` / `bad_request` / `api_incompatible`：**不自动重试**；
- 任何重试都不得重复“有副作用”的步骤（发语音用幂等 key）。

---

## 4. 宿主 HTTP 路由（UI 用）

前缀 `/dsh-fish-service`。这些路由给**本插件客户端**用，不是公共 API；token 由宿主注入，浏览器不接触。

| 方法 | 路径 | 请求 | 返回 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok, serviceDown, lastCheckAt, latencyMs}`（宿主自身健康，不是 localai 的） |
| GET | `/status` | — | 脱敏配置 + `fish.service.health()` + capabilities + install 状态 |
| POST | `/config` | `{patch: {...}}` | 同 `fish.service.config.set` |
| GET | `/voices` | — | `{ok, voices:[...]}` |
| POST | `/tts` | `{text, voice?, speed?, language?, seed?}` | `audio/wav`（默认）或 `{ok, wavPath, id}`（`?mode=json`） |
| POST | `/read` | `{text, voice?, speed?, maxChars?, skipCodeBlocks?}` | `{ok, wavPath, ms, items[{wavPath,url,ms,voice,bytes,chars}], chunks, chars, codeBlocks, truncated}`（P2） |
| GET | `/audio?path=` | — | `audio/*`；只允许 `cacheDir` 内的 `.wav/.webm/.ogg/.opus/.mp3/.m4a`（P2） |
| POST | `/transcribe-upload` | multipart `file` + `durationMs?` + `language?` + `speaker?` | `{ok, text, ms, elapsedMs?, language?, speaker?}`（P2，临时文件请求结束即删） |
| POST | `/voice-upload` | multipart `file` + `durationMs?` | `{ok, path, bytes, mime}`（P2，存 `cacheDir/voice`） |
| GET | `/audio/:id` | — | `audio/wav` 流；id 映射到缓存文件，防目录穿越 |
| POST | `/asr` | multipart `file` + `language?` + `speaker?` | `{ok, text, speaker?, segments?}` |
| GET | `/logs` | `?lines=200&file=service` | `{ok, lines:[]}`（代理 `/admin/logs`） |
| POST | `/service/:action` | `action=start\|stop\|restart` | `{ok, state}`；start 等待 `/health` **HTTP 200**（不等 `ok:true`）或 120s 超时 |
| GET | `/install/status` | — | `InstallStatus` |
| POST | `/install/preflight` | `{installDir?, port?}` | `PreflightResult` |
| POST | `/install/start` | `{installDir, models[], installEngine, autoStart}` | `{ok, taskId}` |
| POST | `/install/cancel` | — | `{ok}` |
| GET | `/install/events` | SSE | `event: progress\ndata: {...}`；断线可重连 |
| POST | `/install/adopt` | `{baseUrl?}` | `{ok, installMode}` |
| POST | `/install/uninstall` | `{removeModels?, keepConfig?}` | `{ok, removed[], kept[]}` |
| GET | `/models` | — | 代理 `/admin/models` |
| POST | `/models/download` | `{capability, name}` | `{ok, taskId}` |
| GET | `/models/tasks/:id` | — | 代理下载进度 |
| POST | `/models/activate` | `{capability, name}` | `{ok}` |
| GET | `/webui` | — | `{ok, url, embedUrl}`（`/ui?embed=1`） |
| GET | `/metrics` | — | 计数器 JSON |

安全：

- 所有 POST 要求同源（检查 `Origin`/`Referer` 为 DSH 页面）；
- `/audio/:id` 只接受 `[a-f0-9-]+`，映射表里查不到就 404；
- `/logs` 不接受任意 `file` 路径，只接受 `service`/`err` 枚举；
- 不返回 token、不返回 localai 的绝对 `outputs/` 路径。

---

## 5. 配置 schema

### 5.1 完整示例

```json
{
  "version": 1,
  "enabled": true,
  "baseUrl": "http://127.0.0.1:7880",
  "token": "",
  "installDir": "C:\\Users\\Administrator\\AppData\\Local\\localai-service",
  "installMode": "unknown",
  "autoStart": true,
  "defaultVoice": "default",
  "autoRead": false,
  "maxCharsPerChunk": 800,
  "requestTimeoutMs": 180000,
  "asrTimeoutMs": 300000,
  "visionTimeoutMs": 600000,
  "healthIntervalMs": 15000,
  "busyAfterMs": 30000,
  "cacheTtlHours": 72,
  "cacheMaxMb": 2048,
  "modelMirror": "modelscope",
  "pypiIndex": "",
  "torchIndex": "",
  "embedWebUI": true,
  "logLevel": "info"
}
```

### 5.2 字段说明

| 字段 | 类型 | 默认 | 约束 | 说明 |
| --- | --- | --- | --- | --- |
| `version` | int | 1 | 只读 | schema 版本；迁移用 |
| `enabled` | bool | true | — | 总开关 |
| `baseUrl` | string | `http://127.0.0.1:7880` | `http(s)://` | 唯一服务地址 |
| `token` | string | `""` | ≤512 | 只写不回显 |
| `installDir` | string | `%LOCALAPPDATA%\localai-service` | 绝对路径 | managed 模式 |
| `installMode` | enum | `unknown` | `unknown/managed/adopted` | 安装器维护 |
| `autoStart` | bool | true | — | 安装后启用计划任务 |
| `defaultVoice` | string | `default` | 存在于 `/voices` | 新装用服务端默认；迁移时若 `dafeiyu` 存在则导入 |
| `autoRead` | bool | false | — | 默认关，避免迁移后突然出声 |
| `maxCharsPerChunk` | int | 800 | 200~5000 | 长文分段（ops 用） |
| `ttsSpeed` | number | 1.0 | 0.5~2.0 | 朗读语速（P2） |
| `autoRead` | bool | false | — | 自动朗读最终回复（P2） |
| `readMaxChars` | int | 2000 | 200~5000 | 朗读单段最大字数（P2） |
| `readSkipCode` | bool | true | — | 朗读时去掉代码块（P2） |
| `recordMime` | enum | auto | auto/webm/wav | 语音输入录音格式（P2） |
| `rememberVoiceChoice` | bool | true | — | 记住三选一上次选择（P2，只做高亮） |
| `asrLanguage` | enum | auto | auto/zh/en/ja | 语音输入 ASR 语言（P2） |
| `requestTimeoutMs` | int | 180000 | 1000~1800000 | TTS/一般 |
| `asrTimeoutMs` | int | 300000 | 1000~1800000 | ASR/分离 |
| `visionTimeoutMs` | int | 600000 | 1000~1800000 | 视觉 |
| `healthIntervalMs` | int | 15000 | 5000~120000 | 健康轮询 |
| `busyAfterMs` | int | 30000 | 5000~300000 | 队列等待阈值 |
| `cacheTtlHours` | int | 72 | 1~720 | 必须 > fish-message 出站 TTL（24h） |
| `cacheMaxMb` | int | 2048 | 256~10240 | LRU 上限 |
| `modelMirror` | enum | `modelscope` | `modelscope/huggingface/hf-mirror` | 模型下载源 |
| `pypiIndex` | string | `""` | URL 或空 | pip 镜像 |
| `torchIndex` | string | `""` | URL 或空 | torch 轮子索引 |
| `embedWebUI` | bool | true | — | 设置页 iframe |
| `logLevel` | enum | info | `debug/info/warn/error` | 日志级别 |

### 5.3 环境变量

| 变量 | 字段 | 优先级 |
| --- | --- | --- |
| `DSH_FISH_SERVICE_BASE_URL` | `baseUrl` | env > file > default |
| `DSH_FISH_SERVICE_TOKEN` | `token` | 同上 |
| `DSH_FISH_SERVICE_ENABLED` | `enabled` | 同上 |
| `DSH_FISH_SERVICE_INSTALL_DIR` | `installDir` | 同上 |
| `DSH_FISH_SERVICE_DISABLE_INSTALL` | 隐藏安装 UI | 只读 |
| `DSH_FISH_SERVICE_HEALTH_MS` | `healthIntervalMs` | 同上 |

### 5.4 迁移导入规则

| 来源 | 字段 | 规则 |
| --- | --- | --- |
| `~/.dsh/fish-message-config.json` | `asrBaseUrl` / `ttsBaseUrl` | 两者一致且 `/capabilities` 可达 → 写入 `baseUrl`；不一致 → 不自动导入，设置页提示 |
| 同上 | `ttsVoice` | 写入 `defaultVoice`（仅当 `/voices` 里存在） |
| `~/.dsh/tts-rvc/settings.json` | `index.baseUrl` | 仅作为候选；不覆盖 fish-message 的一致值 |
| 浏览器 `localStorage['dsh-tts-settings']` | `provider` / `voice` | 宿主不读；设置页提供客户端导入按钮（P2） |

---

## 6. `fish.message` 服务（规划）

> 当前 `dsh-fish-message 0.1.0` **没有**这个服务；P4 前先加最小实现（P4 前置），HTTP 路由不变。

### 6.1 定义

```ts
interface FishMessageApi {
  apiVersion: '0.2'
  getVoice(messageId: string): Promise<{
    ok: boolean
    filePath: string
    messageId: string
    durationMs?: number
    sender?: { qq?: string; name?: string }
    error?: { code: 'message_not_found' | 'no_voice_attachment'; hint: string }
  }>
  sendVoice(opts: { sessionId: string; wavPath: string; text?: string }): Promise<{
    ok: boolean
    messageId?: string
    error?: { code: string; hint: string; detail?: string }
  }>
  sendText(opts: { sessionId: string; text: string }): Promise<{
    ok: boolean
    messageId?: string
    error?: { code: string; hint: string; detail?: string }
  }>
  health(): Promise<{ ok: boolean; transport: 'ws' | 'http'; bound: number }>
}
```

### 6.2 约束

- `sessionId` 是 DSH 的 `session-...` 或去掉前缀的 id；message 自己负责映射到 QQ 绑定；
- `wavPath` 必须是本机存在文件；message 负责转码/发送；
- `sendVoice` 失败时**不删除** `wavPath`；调用方可重试；
- 不通过 `fish.message` 暴露原始 QQ 号/消息全文，除非调用方明确需要；
- message 的 HTTP 路由保持现有 `/dsh-fish-message/*`，不做破坏性改动。

### 6.3 降级

如果 `fish.message` 不存在：

- `voice_note_analyze` / `say_as_voice` 不注册；
- `fish_ops_list` 显示 `fish.message@>=0.2` 缺失；
- `fish-service` 的朗读/语音输入不受影响（它们不依赖 message）。

---

## 7. `dsh-fish-ops` 契约

### 7.1 manifest schema

```json
{
  "id": "voice_note_analyze",
  "version": "1.0.0",
  "title": "语音消息分析",
  "requires": ["fish.service@>=1.0", "fish.message@>=0.2"],
  "tool": "voice_note_analyze",
  "timeoutMs": 360000,
  "sideEffect": false,
  "idempotent": true,
  "description": "取一条 QQ 语音 → 转写 → 声纹 → 返回；不改动消息。"
}
```

规则：

- `requires` 只支持 `name` 或 `name@>=x.y`；不支持范围/通配；
- `tool` 必须与注册的工具名一致；
- `sideEffect:true` 必须实现幂等 key；
- manifest 是**唯一**决定工具是否注册的依据；不要在 `run` 里再判断“依赖在不在”。

### 7.2 op 工具清单

| 工具 | 参数 | 返回 | 依赖 |
| --- | --- | --- | --- |
| `voice_note_analyze` | `messageId?`、`filePath?`、`language?`、`identifySpeaker?` | `{text,speaker,language,durationMs,engine}` | service + message |
| `say_as_voice` | `text*`、`voice?`、`sessionId?`、`idempotencyKey?` | `{sent,wavPath,messageId?,ms,deduplicated?}` | service + message |
| `translate_and_speak` | `text*`、`source`、`target*`、`voice?`、`sessionId?`、`idempotencyKey?` | `{sourceText,translatedText,wavPath,sent,stage?}` | service + message |
| `long_text_read` | `text?`、`filePath?`、`maxCharsPerChunk?`、`voice?`、`sessionId?`、`idempotencyKey?` | `{chunks[],sentCount,wavPaths[]}` | service + message |
| `vision_watch` | `videoPath?`、`url?`、`targetFrames?`、`effort?` | `{frames[],report}` | service |
| `fish_ops_list` | 无 | `{ops[],missing[]}` | 无 |

> `requires` 是**静态**的：一旦声明 `fish.message@>=0.2`，message 不存在时该 op 整个不注册。不要用运行时 `if` 去补“可选投递”；需要“只生成不发送”的场景请直接用单步工具 `fish_tts` / `fish_translate` / `fish_vision_frames`。

### 7.3 `voice_note_analyze` 完整 schema

```json
{
  "name": "voice_note_analyze",
  "description": "分析一条 QQ 语音消息：取音频 → 本地转写 → 声纹识别。只读，不改消息。需要 fish-message 0.2+。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "messageId": { "type": "string", "description": "QQ 消息 id；与 filePath 二选一。" },
      "filePath": { "type": "string", "description": "本机音频绝对路径；与 messageId 二选一。" },
      "language": { "type": "string", "enum": ["auto", "zh", "en", "ja", "ko", "yue"], "default": "auto" },
      "identifySpeaker": { "type": "boolean", "default": true, "description": "false 时跳过声纹。" }
    }
  }
}
```

### 7.4 `say_as_voice` 完整 schema

```json
{
  "name": "say_as_voice",
  "description": "把一段文字合成语音并发送到指定 DSH 会话（默认当前会话）。10 分钟内相同内容不会重复发。",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "text": { "type": "string", "minLength": 1, "maxLength": 5000 },
      "voice": { "type": "string" },
      "sessionId": { "type": "string", "description": "不传=当前会话。" },
      "idempotencyKey": { "type": "string", "maxLength": 128 }
    },
    "required": ["text"]
  }
}
```

### 7.5 `fish_ops_list` 返回

```json
{
  "ok": true,
  "ops": [
    { "id": "voice_note_analyze", "available": true, "tool": "voice_note_analyze", "requires": [{ "id": "fish.service", "ok": true }, { "id": "fish.message", "ok": true }] },
    { "id": "vision_watch", "available": false, "tool": null, "requires": [{ "id": "fish.service", "ok": false, "reason": "service_down" }] }
  ],
  "missing": [
    { "require": "fish.message@>=0.2", "reason": "未检测到 fish.message 服务", "hint": "升级 dsh-fish-message 到 0.2.0+" }
  ]
}
```

---

## 8. 契约测试（P1 就要有）

| # | 测试 | 断言 |
| --- | --- | --- |
| 1 | mock `/health` 200 | `health().ok=true`，`serviceVersion` 解析正确 |
| 2 | mock `/capabilities` 缺 `tts` | `capabilities.tts.available=false`，`reason=not_supported` |
| 3 | mock `api_version:"2"` | `api_incompatible`，写工具拒绝 |
| 4 | mock 507 | `vram_exhausted`，hint 含“显存”，`retryable=false` |
| 5 | mock 503 + `ready=false` | `model_missing`，不是 `upstream_error` |
| 6 | mock 503 + `ready=true` | `upstream_error`，`retryable=true` |
| 7 | mock 504 | `timeout`，只重试 1 次 |
| 8 | mock 400 | `bad_request`，不重试 |
| 9 | 连接拒绝 | `service_down`，2s 内返回 |
| 10 | 工具结果扫描 | 不含 `base64`、不含 `token`、不含 `service.err.log` 全文 |
| 11 | 批量超限 | `fish_tts` 21 条 → `bad_request`，不截断 |
| 12 | ops 禁用 message | 两个工具不注册；`fish_ops_list` 有 missing |

测试不依赖真实模型：用 Node 内置 `http` 起 mock localai，按上表返回固定 JSON；真实模型只做 P1 手工冒烟。
