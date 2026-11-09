# dsh-fish-service

> 状态：**P2 已完成**（P1 骨架 + P2 界面入口：消息朗读按钮、语音输入三选一、自动朗读开关）。
> 目标环境：DSH `0.2.2-rc.1`，本地服务 `localai-service 2.5.x`（HTTP 契约 `api_version = "1"`）。
> 最后核对：2026-11-09。

`dsh-fish-service` 是 DSH 侧访问本地 AI 服务的**唯一门面**：只有它知道 `baseUrl` / token；
其它插件通过 Cordis 服务 `fish.service` 取能力，或直接用 8 个 Agent 工具。

```text
localai-service（127.0.0.1:7880）
        ▲ HTTP（唯一出口；token 在这里注入）
        │
dsh-fish-service（DSH 宿主插件）
  ├─ fish.service（Cordis）：health / ensureReady / tts / asr / translate /
  │   separate / visionFrames / mediaProbe / jobs / voices / config / events / install
  ├─ 8 个 Agent 工具（fish_tts … fish_service_status）
  ├─ 宿主路由 /dsh-fish-service/*（给设置页用）
  └─ 产物缓存 ~/.dsh/fish-service-cache
        ▲ Cordis 服务 / 工具
        │
dsh-fish-ops（P4，规划中；本仓库未实现）
```

## P1 做了什么

- **Cordis 服务 `fish.service`**：`ctx.provide('fish.service', api)`，暴露 `apiVersion: "1.0"`。
- **8 个 Agent 工具**：始终注册，服务没起时返回结构化中文错误，方便 Agent 诊断。
- **宿主路由**：`/dsh-fish-service/{health,state,save,test,logs,voices}`，浏览器不接触 token。
- **配置**：`~/.dsh/fish-service-config.json`，env 覆盖，原子写，token 只写不回显。
- **缓存**：TTS / 分离 / 关键帧产物只写 `cacheDir`，TTL + LRU 清理。
- **设置页**：状态、服务地址、超时、默认音色、缓存用量、能力列表（不可用带原因）、
  测试连接、日志。

## P2 做了什么（界面入口）

- **消息朗读按钮**（`conversation.chat.assistant-actions`）：每条已定稿助手回复旁一个喇叭；
  点击 → `POST /read` 清洗 + 分段 + 合成 → 浏览器按顺序播放；再点停止；切换消息停上一条。
  失败显示中文 hint，不白屏、不抛 JS 异常。
- **语音输入**（`conversation.input.right`）：麦克风录音（webm/opus 优先，退化 WAV）→
  结束时在输入框浮层里三选一：**转文字**（插到光标处）/ **保留语音**（存 `cacheDir/voice`，
  路径插进输入框）/ **取消**。录音上限 5 分钟、25MB；记住上次选择只做高亮。
- **自动朗读开关**（`conversation.input.left`）：默认关；开关写入 `config.autoRead`。
- **设置页**：在 P1 同一页里新增「朗读」「语音输入」两个分区。

细节、挂载点依据与手动验收步骤见 [`docs/P2.md`](docs/P2.md)。

**P1/P2 不做**（按设计留给后续阶段）：一键安装 / 内嵌 WebUI（P3）、组合链路 `dsh-fish-ops`（P4）、
`vision_watch` 的 URL 下载输入。

## 安装

本插件**只允许用 CLI 安装**（不要手改 profile 的 `dsh.profile.bundles`，CLI 会按依赖重写）：

```powershell
C:\Users\Administrator\AppData\Roaming\npm\dsh.cmd plugin --profile desktop add E:\dsh-fish-service
```

安装后检查 profile：

```powershell
Get-Content C:\Users\Administrator\.dsh\profiles\desktop\package.json -Raw
# dsh.profile.bundles 里应出现 "dsh-fish-service"
```

> 安装只写 profile 的依赖与 bundles，**不会重启 DSH**。重启由使用者决定；重启后插件才会加载。

## 配置

文件：`~/.dsh/fish-service-config.json`（`DSH_HOME` 可改家目录）。优先级：
**环境变量 > 配置文件 > 插件 patch > 默认值**。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后工具返回 `service_not_installed`，设置页仍可用 |
| `baseUrl` | `http://127.0.0.1:7880` | **唯一服务地址** |
| `apiVersion` | `"1"` | 期望的 HTTP 契约主版本；不匹配 → `api_incompatible` |
| `token` | `""` | 对应服务端 `LOCALAI_TOKEN`；只写不回显 |
| `requestTimeoutMs` | `180000` | TTS / 一般请求 |
| `asrTimeoutMs` | `300000` | ASR / 人声分离 |
| `visionTimeoutMs` | `600000` | 视觉关键帧 |
| `ttsVoice` | `dafeiyu` | 默认音色（设置页可从 `/voices` 选） |
| `ttsSpeed` | `1.0` | 朗读语速 0.5~2.0 |
| `autoRead` | `false` | 自动朗读最终回复（默认关） |
| `readMaxChars` | `2000` | 朗读单段最大字数 200~5000 |
| `readSkipCode` | `true` | 朗读时去掉代码块（关=念「代码块，共 N 行」） |
| `recordMime` | `"auto"` | 录音格式 auto/webm/wav |
| `rememberVoiceChoice` | `true` | 记住语音输入上次选择（只做高亮） |
| `asrLanguage` | `"auto"` | 语音输入 ASR 语言 auto/zh/en/ja |
| `cacheDir` | `~/.dsh/fish-service-cache` | 产物目录；只在这里写文件 |
| `cacheTtlHours` | `72` | 产物 TTL |
| `cacheMaxMb` | `2048` | 缓存上限（超出按 LRU 删） |
| `healthIntervalMs` | `15000` | 后台健康检查间隔 |
| `enabledCapabilities` | `[]` | 空 = 全部按服务端能力；填了则只启用列出的能力 |
| `logLevel` | `info` | `debug/info/warn/error` |

环境变量覆盖：`DSH_FISH_SERVICE_BASE_URL`、`..._TOKEN`、`..._ENABLED`、
`..._REQUEST_TIMEOUT_MS`、`..._ASR_TIMEOUT_MS`、`..._VISION_TIMEOUT_MS`、
`..._TTS_VOICE`、`..._CACHE_DIR`、`..._HEALTH_MS`、`..._LOG_LEVEL`、
`..._ENABLED_CAPABILITIES`、`..._INSTALL_DIR`（也接受去掉 `DSH_` 前缀的简写）。

设置页保存后会立即生效；`baseUrl` / `apiVersion` 改变时能力缓存会失效，下一次调用重新探测。

## 8 个工具

| 工具 | 参数（必填 `*`） | 返回 |
| --- | --- | --- |
| `fish_tts` | `texts*` 1~20 条、`voice`、`speed` 0.5~2、`language`、`seed` | `items[{wavPath,ms,voice,seed,language?,bytes,cached?}]` |
| `fish_asr` | `files*` 1~10 个、`language`、`engine`、`speaker`、`timestamps` | `items[{file,text,language?,engine?,durationMs?,elapsedMs?,speaker?,speakerError?,segments?,truncated?}]` |
| `fish_translate` | `texts*` 1~200 条、`source`、`target*` | `{texts,source,target,engine:"nllb",ms,chunks?}` |
| `fish_separate` | `file*`、`model`、`stems[]` | `{stems:{name:{path,duration?}},dir,ms,released?}` |
| `fish_vision_frames` | `videoPath*`、`targetFrames` 1~10、`effort`、`planner`、`subtitles` | `{frames:[{time,path,score?,kind?,ocrText?,summary?,why?,confidence?}],duration?,subtitlesFrom?,stats?,ms}` |
| `fish_media_probe` | `files*` 1~10 个 | `{items:[{file,duration?,format?,audio?,video?}],ms}` |
| `fish_job` | `action*`（`status/cancel/list/wait`）、`jobId`、`kind`、`state`、`limit`、`timeoutMs` | 任务记录 / 列表 |
| `fish_service_status` | 无 | `{ok,baseUrl,version,apiVersion,latencyMs,capabilities,vram?,voices,install,autostart,lastError}` |

规则：

- **只返回路径 + 指标，不返回 base64 / buffer**；TTS/分离/关键帧的产物都已复制到 `cacheDir`。
- 批量上限是硬限制，超限返回 `bad_request`，**不静默截断**。
- 失败统一返回 `{ok:false, code, hint, detail?, retryable, error:{code,hint}}`；
  `hint` 是可直接展示的中文，`detail` 只用于诊断。
- `fish_service_status` 在服务不可达时也返回诊断信息（`ok:false` + 启动提示）。

## 宿主路由

前缀 `/dsh-fish-service`，只给本插件设置页使用；`Origin` 存在时校验同源。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 插件 + 服务联合状态（不阻塞探测） |
| GET | `/state` | 脱敏配置 + health + capabilities + voices + 缓存用量 + 最近错误 |
| POST | `/save` | `{config:{...}}` 或 `{patch:{...}}`，同 `fish.service.config.set` |
| POST | `/test` | `{timeoutMs?}` 探测服务连通 |
| GET | `/logs` | `?lines=1..1000`，插件内存日志（最近 200 行） |
| GET | `/voices` | 服务端音色列表；服务没起时 `ok:false` + 空数组 |
| POST | `/read` | `{text, voice?, speed?, maxChars?, skipCodeBlocks?}` → `{ok, wavPath, ms, items[], chunks, chars, codeBlocks, truncated}` |
| GET | `/audio?path=` | 以 `audio/*` 返回 cacheDir 里的音频（防目录穿越） |
| POST | `/transcribe-upload` | multipart 录音 → `{ok, text, ms, elapsedMs?, language?}` |
| POST | `/voice-upload` | multipart 录音 → 存 `<cacheDir>/voice`，返回 `{ok, path, bytes, mime}` |

## 错误码

`service_not_installed` / `service_down` / `model_missing` / `model_loading` /
`vram_exhausted` / `busy` / `timeout` / `bad_request` / `upstream_error` /
`api_incompatible` / `canceled` / `not_implemented`。

HTTP 映射：连接失败 → `service_down`；507 → `vram_exhausted`；503（能力未就绪）→
`model_missing`；503（正在加载）→ `model_loading`；503（其它）→ `upstream_error`；
504 → `timeout`；400/401/403/404/409/413/422 → `bad_request`；其它 5xx → `upstream_error`。

## 测试

全部离线：测试用 `node:http` 起 mock localai，不连 7880、不加载模型。

```powershell
npm install     # 只装 @deepseek-ai/schemastery@3.18.4
npm test        # 11 个测试文件，124 项断言
npm run check   # 所有 lib/*.js 与 client.js 的 node --check
```

覆盖：错误映射与中文 hint、capabilities 解析 + 30 秒缓存、工具参数校验与批量上限、
缓存 TTL/LRU、配置读写与 env 覆盖、`/state` 字段、路由 405/400/403、工具结果不含
base64 / token。mock 场景包括 200、400、503（ready true/false）、504、507、连接拒绝、超时。

P2 追加：朗读文本清洗（Markdown / 代码块 / `[QQ]` / 链接）、分段与 2 万字截断、
multipart 解析、`/read` + `/audio` + 两个上传路由、路径穿越防护、真实 `fish.service`
的分段合成与缓存回放、`client.js` 的加载与槽位注册冒烟。

## 目录

```text
E:\dsh-fish-service\
├─ package.json           # dsh.bundle.patch / dsh.client / exports["./client"]
├─ cordis.patch.yml       # insert: fish-service
├─ lib\
│  ├─ host.js             # apply：装配、provide、工具、路由、生命周期
│  ├─ service-api.js      # fish.service 实现（唯一门面）
│  ├─ client.js           # HTTP 客户端：超时、重试、错误映射、multipart
│  ├─ capabilities.js     # /capabilities 解析 + 30s 缓存
│  ├─ errors.js           # 错误码 / 中文 hint / HTTP 映射
│  ├─ cache.js            # 产物落盘、TTL、LRU
│  ├─ config.js           # 默认值、env 覆盖、原子写
│  ├─ health.js           # 后台健康轮询（5s→10s→30s 退避）
│  ├─ routes.js           # /dsh-fish-service/*（含 P2 的 read/audio/transcribe/voice）
│  ├─ speech.js           # 朗读文本清洗 + 分段（纯函数）
│  ├─ upload.js           # multipart 解析、音频扩展名
│  ├─ logger.js           # 内存环 + 落盘日志
│  ├─ fs-util.js          # 原子写 / hash / 路径（含防穿越）
│  └─ tools\              # 8 个工具，每个一个文件
├─ client.js              # 设置页 + 朗读按钮 + 语音输入 + 自动朗读（React，无构建）
├─ docs\                  # DESIGN / CONTRACT / DEPLOY / MIGRATION / P1 / P2
└─ tests\                 # 11 个契约测试 + mock 公共件
```

## 已知限制（P1）

- 没有安装器：不会启动 / 停止 / 重启 localai，也不会下载模型；安装 UI 是 P3。
- `install.*` 只有占位与只读 `adopt/status`；未实现安装、升级、卸载、模型管理。
- `visionFrames` 的 `url` 输入返回 `not_implemented`；长视频（>10 分钟）仍走同步接口，
  没有自动切 `/jobs/vision`。
- `jobs.enqueue` 不支持 `files`（需要先上传到服务端，P3）。
- POST 请求默认**不自动重试**（避免重复推理）；只有幂等 GET 失败重试 1 次。
- `fish_translate` 的 `source='auto'` 只覆盖服务端支持的常见语种。
- 设置页的能力列表来自最近一次探测；服务刚启动时可能需要手动点「测试连接」刷新。
- 插件只监听 / 调用 `127.0.0.1`；不联网下载任何东西（依赖安装除外）。

P2 的已知限制（音频附件降级、自动朗读时机、录音格式、插入位置等）见
[`docs/P2.md` 第 10 节](docs/P2.md#10-已知限制)。

更细的实现说明、与 `docs/CONTRACT.md` 的差异见 [`docs/P1.md`](docs/P1.md)。
设计文档：[`docs/DESIGN.md`](docs/DESIGN.md)、[`docs/CONTRACT.md`](docs/CONTRACT.md)。
