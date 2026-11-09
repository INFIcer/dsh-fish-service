# 迁移（MIGRATION）

> 从「`dsh-fish-message` 直接 HTTP + `@memef1f1y/dsh-plugin-tts` 提供朗读」迁到「`fish-service` 统一门面 + `fish-message` 可选依赖 + 现有 v2.5 服务被接管」。
>
> 原则：**先备份、先并存、后切换；任何一步都能回滚，不删用户数据。**

---

## 1. 迁移前盘点（2026-11-09 实测）

| 项 | 当前值 | 迁移后 |
| --- | --- | --- |
| 服务 | `E:\LocalAIService`，`localai-service 2.5.0`，`127.0.0.1:7880` | **不重装**，`installMode=adopted` |
| 服务自启 | 计划任务 `LocalAIService-Service`，已启用 | 保留，不改名 |
| 服务配置 | `E:\LocalAIService\config.json`（`model_search_paths`） | 保留；插件不覆盖 |
| 音色 | `E:\LocalAIService\voices`，7 个，`dafeiyu` 等 | 保留；`defaultVoice` 导入 `dafeiyu` |
| 声纹 | `E:\LocalAIService\speakers`（向量，0.2MB） | 保留 |
| QQ 桥 | `E:\dsh-fish-message` v0.1.0，已上线 | 保留；新增可选 `fish.service` 调用 |
| QQ 配置 | `~\.dsh\fish-message-config.json`：`asrBaseUrl`/`ttsBaseUrl=7880`、`ttsVoice=dafeiyu` | 保留旧字段；新增 `useFishService` |
| 旧 TTS 插件 | `@memef1f1y/dsh-plugin-tts 0.6.7` 已安装；**当前不在 `dsh.profile.bundles`** | 确保不在 bundles；`dependencies` 保留以便回滚 |
| 旧 TTS 配置 | `~\.dsh\tts-rvc\settings.json`（`index.baseUrl` 等） | 保留；仅作 baseUrl 候选 |
| DSH | `0.2.2-rc.1`，profile `desktop` | 不变 |

**先确认一遍（只读）**

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
Get-Content "$profileDir\package.json" -Raw -Encoding utf8
Get-Content "$profileDir\cordis.patch.yml" -Raw -Encoding utf8
Get-Content "$env:USERPROFILE\.dsh\fish-message-config.json" -Raw -Encoding utf8
curl.exe -s http://127.0.0.1:7880/capabilities
curl.exe -s http://127.0.0.1:7880/admin/system
```

重点看：

- `dsh.profile.bundles` 里有没有 `@memef1f1y/dsh-plugin-tts`；
- `dependencies` 里有没有它（有=可回滚，不要删）；
- `fish-message-config.json` 的 `asrBaseUrl` / `ttsBaseUrl` 是否都指向 7880；
- 7880 的 `/capabilities` 是否 `api_version=1`、`service.version=2.5.x`。

---

## 2. 禁用 `@memef1f1y/dsh-plugin-tts`

### 2.1 备份（必须）

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item "$profileDir\package.json" "$profileDir\package.json.bak-fish-service-$stamp"
Copy-Item "$profileDir\cordis.patch.yml" "$profileDir\cordis.patch.yml.bak-fish-service-$stamp"
Copy-Item "$env:USERPROFILE\.dsh\fish-message-config.json" "$env:USERPROFILE\.dsh\fish-message-config.json.bak-fish-service-$stamp"
```

备份文件不要删；回滚要用。

### 2.2 确认它是否在 bundles

```powershell
$pkg = Get-Content "$profileDir\package.json" -Raw -Encoding utf8 | ConvertFrom-Json
$pkg.dsh.profile.bundles | Where-Object { $_ -match 'dsh-plugin-tts' }
$pkg.dependencies.PSObject.Properties.Name | Where-Object { $_ -match 'dsh-plugin-tts' }
```

三种结果：

| 结果 | 含义 | 动作 |
| --- | --- | --- |
| bundles 无、dependencies 有 | **当前未激活**（本机现状） | 不用改；记录基线；继续 |
| bundles 有、dependencies 有 | 正在激活 | 从 bundles 删掉这一项 |
| 都没有 | 未安装/已移除 | 无需处理；回滚时可能要重装 |

### 2.3 从 bundles 移除（如果需要）

编辑 `~\.dsh\profiles\desktop\package.json`，在 `dsh.profile.bundles` 数组里删掉：

```json
"@memef1f1y/dsh-plugin-tts"
```

**保留** `dependencies` 里的：

```json
"@memef1f1y/dsh-plugin-tts": "0.6.7"
```

原因：回滚时不用重新下载；`dsh plugin --profile desktop list` 还能看到它，但**不在 bundles = 不加载**。

> 不要用 `dsh plugin --profile desktop remove @memef1f1y/dsh-plugin-tts` 来做“禁用”：它会移除依赖与 lockfile，回滚要重装。只有确定永不回滚才 remove。

### 2.4 重启 DSH

不要在正在跑的会话里直接重启（会杀掉当前会话）。用现成脚本：

```powershell
# 二选一；参数按你的会话改
pwsh -NoProfile -File "$env:USERPROFILE\.dsh\_restart\dsh-restart.ps1" `
  -SessionId "session-a3e56af2-2285-44e6-b32d-863efb9e7d8b" `
  -WakeText "【迁移检查】确认 @memef1f1y/dsh-plugin-tts 已不在 bundles，朗读入口只剩 fish-service。"

# 或 fish-message 仓库的薄包装
pwsh -NoProfile -File "E:\dsh-fish-message\tools\restart-dsh.ps1"
```

### 2.5 验证

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | bundles | `package.json` 的 `dsh.profile.bundles` 无 `dsh-plugin-tts` |
| 2 | 依赖 | `dependencies` 仍有 `@memef1f1y/dsh-plugin-tts`（可回滚） |
| 3 | 页面 | 设置 → 插件里没有「语音（Edge TTS）」tab；消息操作行没有旧朗读按钮 |
| 4 | 网络 | 打开消息页，DevTools Network 没有 `/dsh-tts-api/*` |
| 5 | 插件列表 | `dsh plugin --profile desktop list` 仍显示依赖（正常，列表是依赖不是激活） |

> 如果第 3 项仍有旧按钮：说明 bundles 里还有别的 bundle 间接插入，或客户端缓存未刷新。先硬刷新（Ctrl+F5），再检查 `cordis.patch.yml` 是否有 `name: '@memef1f1y/dsh-plugin-tts'` 的手工 insert。

### 2.6 回滚（恢复到旧 TTS）

1. 把 `@memef1f1y/dsh-plugin-tts` 加回 `dsh.profile.bundles`（放在 `dsh-fish-message` 之前/之后都行，但**只能有一个朗读入口**）；
2. 在 `fish-service` 设置里关闭「朗读按钮」和「自动朗读」（或临时把 `dsh-fish-service` 从 bundles 移除）；
3. 重启 DSH；
4. 确认旧 TTS 设置页与朗读按钮恢复；
5. `~\.dsh\tts-rvc\settings.json` 全程未改，RVC/Index 地址还在。

---

## 3. `dsh-fish-message` 改为可选依赖 `fish.service`

### 3.1 目标

- 有 `fish.service`：入站转写/出站语音走统一门面（地址、错误、缓存都统一）；
- 没有 `fish.service`：保持现有 HTTP 行为，**不报错、不阻塞**；
- `dsh-fish-message` 的 `package.json` **不新增**对 `dsh-fish-service` 的依赖（避免循环/强制安装）。

### 3.2 改动点（按文件）

| 文件 | 现状 | 改法 |
| --- | --- | --- |
| `lib/host.js` | `inject = ['agents','sessions','sessionTitle','webServer','workspaceRegistry','attachments']`；构造 `VoiceService` | `apply` 里 `const fishService = ctx.get('fish.service')`（可选）；传给 `new VoiceService({..., fishService})`；`ctx.provide('fish.message', ...)`（见 3.4） |
| `lib/voice.js` | 直接 `fetch(ttsBaseUrl/tts)`、`fetch(asrBaseUrl/asr)` | 构造函数接收 `fishService`；`transcribeRecord`/`synthesize` 优先走它；保留原 HTTP 方法作 fallback |
| `lib/config.js` | 默认配置 + `schemastery` schema | 新增 `useFishService: true`；`asrBaseUrl`/`ttsBaseUrl` 保留但标 deprecated；设置页显示来源 |
| `lib/bridge.js` | 调 `voice.synthesize` / `voice.transcribeRecord` | 不改调用签名；VoiceService 内部切换实现 |
| `lib/voice.js` 的 `recordToFile` | 文件命名 `qq-voice-<messageId>-<ts>.<ext>` | 保留命名；`fish.message.getVoice` 按这个前缀找文件 |
| `client.js` | QQ 设置页 | 显示「语音服务：由本地 AI 插件管理 / 直连（旧）」；新增「使用本地 AI 服务」开关 |

### 3.3 `VoiceService` 的切换逻辑

```js
// 伪代码，P6 按此实现
async asrFile(path) {
  const 配置 = this.getConfig()
  if (配置.useFishService !== false && this.fishService?.capabilities?.asr?.available) {
    try {
      const r = await this.fishService.asr(path, { speaker: true, language: 'auto' })
      const item = r.items?.[0]
      if (item?.text) return { text: item.text, speakerName: item.speaker?.name || '', speakerKnown: !!item.speaker?.known, engine: item.engine }
    } catch (error) {
      // 只在“服务不可用”时回退 HTTP；业务错误（507/400）原样抛给上层，避免重复请求
      if (error?.code !== 'service_not_installed') throw error
      this.logger?.warn(`未安装 fish.service，回退 HTTP：${error.message}`)
    }
  }
  return await this.asrFileHttp(path)   // 现有实现改名，逻辑不变
}

async synthesize(text, opts = {}) {
  const 配置 = this.getConfig()
  if (配置.useFishService !== false && this.fishService?.capabilities?.tts?.available) {
    try {
      const r = await this.fishService.tts(text, { voice: opts.voice || 配置.ttsVoice })
      return r.items[0].wavPath
    } catch (error) {
      if (error?.code !== 'service_not_installed') throw error
      this.logger?.warn(`未安装 fish.service，回退 HTTP：${error.message}`)
    }
  }
  return await this.synthesizeHttp(text, opts)   // 现有实现改名
}
```

关键规则：

- **只在 `service_not_installed` 回退**（即插件没配置服务）；`service_down` 不回退——因为旧 `asrBaseUrl`/`ttsBaseUrl` 通常和 `fish.service` 是同一个地址，回退只会把等待时间翻倍；
- `507`/`400`/`timeout` 也不回退，否则会对同一个模型发两次请求，放大显存压力；让上层按现有语义降级（入站显示失败、出站进队列）；
- `fishService.capabilities` 是缓存值，可能滞后 60 秒；调用失败按上面的 code 判断，不靠缓存猜；
- `fish.service` 的 `asr` 默认 `speaker:true`，和现有 `/asr?speaker=1` 行为一致；
- 返回的 `wavPath` 在 `~/.dsh/fish-service-cache`，TTL 72h > 出站队列 TTL 24h，重发不会找不到文件；
- 如果 `useFishService=false`，完全走旧 HTTP，行为与 0.1.0 一致。

### 3.4 暴露 `fish.message` 服务（P4 前置）

当前 0.1.0 **没有**这个服务；`fish-ops` 的 `voice_note_analyze`/`say_as_voice`/`translate_and_speak`/`long_text_read` 依赖它（`vision_watch` 只依赖 `fish.service`）。最小实现：

```js
// lib/host.js，apply 内
ctx.provide('fish.message', {
  apiVersion: '0.2',

  async getVoice(messageId) {
    // 在 inboxDir 里找 qq-voice-<安全名(messageId)>-*，取最新一个
    // 返回 { ok:true, filePath, messageId, durationMs? }；找不到返回 code
  },

  async sendVoice({ sessionId, wavPath, text }) {
    // sessionId → binding.qq；调用 bridge.sendVoiceOutbound(qq, { text, voice: config.ttsVoice, path: wavPath })
    // 返回 { ok, messageId? }；失败不删 wavPath
  },

  async sendText({ sessionId, text }) {
    // bridge.sendText(qq, text)
  },

  async health() {
    return { ok: true, transport: 'ws'|'http', bound: config.bindings.length }
  },
})
```

约束：

- `getVoice` 的文件名必须与现有 `recordToFile` 的 `qq-voice-${messageId}-...` 对齐；`安全名()` 会去掉非字母数字，messageId 通常是数字，没问题；
- `sendVoice` 复用 `bridge.sendVoiceOutbound`，不要另写一套 OneBot 发送；
- `sendVoice`/`sendText` 的 `sessionId` 找不到绑定 → `{ok:false, error:{code:'session_not_bound', hint:'这个会话没有绑定 QQ'}}`；
- HTTP 路由 `/dsh-fish-message/*` 完全不变；`fish.message` 只是给 DSH 内部用的 Cordis 服务；
- 版本：`apiVersion:'0.2'`；`package.json.version` 升到 `0.2.0`，并在 CHANGELOG 写明新增服务。

### 3.5 配置兼容

```json
{
  "useFishService": true,
  "asrBaseUrl": "http://127.0.0.1:7880",
  "ttsBaseUrl": "http://127.0.0.1:7880",
  "ttsVoice": "dafeiyu"
}
```

- `useFishService` 默认 `true`；设为 `false` 回到纯 HTTP；
- `asrBaseUrl`/`ttsBaseUrl` 保留，用于 fallback；设置页标注「旧字段，建议由本地 AI 插件统一管理」；
- 迁移时 `fish-service` 从这两个字段导入 `baseUrl`（两者一致才导入）；
- 不删除旧字段，避免旧版本/回滚读不到。

### 3.6 失败降级（保持现有语义）

| 情况 | 行为 |
| --- | --- |
| `fish.service` 未安装 | 走旧 HTTP；`transcriptionEnabled`/`ttsEnabled` 仍生效 |
| `fish.service` 装了但服务没启动 | 不回退 HTTP（同地址会双倍等待）→ 上层降级：入站 `[语音（转写失败：…）]`，出站文字进补发队列 |
| 服务返回 507 | 不回退 HTTP；上层按失败处理，保留原文/队列 |
| 声纹失败但转写成功 | `ok:true`，`speakerName=''`；消息里不带声纹名 |
| 服务返回超时 | 不回退；上层按超时失败，避免双倍等待 |

---

## 4. 接管现有 v2.5 服务

### 4.1 不需要重装

现有 `E:\LocalAIService` 已经是 2.5.0，`api_version=1`，`/admin/*` 齐全。迁移时：

1. `GET http://127.0.0.1:7880/health`、`/capabilities`；
2. 校验 `service.name=localai-service`、`api_version=1`、`service.version>=2.5.0`；
3. `GET /admin/system` 读 `paths.home`、`autostart`、`service.pid`（只读）；
4. 写 `fish-service-install.json`：`installMode=adopted`、`installDir=E:\LocalAIService`、`serviceVersion=2.5.0`；
5. **不**停止服务、不移动目录、不覆盖 `config.json`、不重下模型。

### 4.2 baseUrl 导入顺序

1. `fish-message-config.json` 的 `asrBaseUrl` / `ttsBaseUrl`：两者一致且可达 → 用它；
2. 否则 `http://127.0.0.1:7880`；
3. 都不可达 → 让用户填；不要瞎扫端口。

### 4.3 音色导入

- `ttsVoice=dafeiyu` 且 `/voices` 里存在 `dafeiyu` → `defaultVoice=dafeiyu`；
- 不存在 → 用 `/voices` 第一个或 `default`，并在设置页提示「原音色 dafeiyu 不存在，已回退」；
- 不修改 `fish-message-config.json` 的 `ttsVoice`（回滚要用）；只改 `fish-service-config.json`。

### 4.4 接管后的状态

```json
{
  "installMode": "adopted",
  "installDir": "E:\\LocalAIService",
  "serviceVersion": "2.5.0",
  "apiVersion": "1",
  "ownsAutostart": false
}
```

- 设置页「升级/卸载」按钮置灰，文案「该服务由用户管理，插件只接管」；
- 模型下载/切换、日志、重启仍可用（走 `/admin/*`）；
- 卸载插件不影响服务。

---

## 5. 服务端需要新增的接口/命令

### 5.1 已经存在（不要重复实现）

| 能力 | 现有接口 | 用途 |
| --- | --- | --- |
| 版本 | `/capabilities.service.version`、`/admin/system.service.version` | 版本协商 |
| 健康 | `/health`、`/capabilities` | 探测/能力 |
| 模型清单 | `/admin/models` | 已下载/缺失/大小 |
| 模型下载 | `/admin/models/download` | 支持 tts/asr/whisper/translate/speaker/separate/vad/vision |
| 下载进度 | `/admin/models/tasks/{id}` | 轮询 |
| 模型切换 | `/admin/models/activate` | whisper/ASR 档位 |
| 已有模型 | `/admin/models/search-paths`、`/scan`、`/adopt` | 不重复下载 |
| 自启 | `/admin/autostart` | 计划任务 `LocalAIService-Service` |
| 重启 | `/admin/restart` | 需 `confirm=true` |
| 日志 | `/admin/logs` | 尾部日志 |
| 显存 | `/vram`、`/vram/unload` | 诊断/卸载 |

### 5.2 需要新增（P5，当前不存在）

| # | 新增 | 形式 | 为什么 |
| --- | --- | --- | --- |
| 1 | `localai bundle` | CLI | 产出代码包 + manifest + SHA256；离线包 |
| 2 | `localai models install` | CLI | 统一 `--mirror modelscope|huggingface|hf-mirror`、`--json`、续传；补齐 translate/vision/whisper（现有 `models download` 不含） |
| 3 | `GET /version` | HTTP | 轻量版本别名；当前只能从 `/capabilities`/`/admin/system` 取，增加一个稳定入口 |
| 4 | `/ui?embed=1` + `postMessage` | WebUI | 隐藏 `.sidebar`/`.topbar`；高度自适应 |
| 5 | 可选 `POST /media/concat` | HTTP | 长文单条音频拼接；v1 不做，逐段发送 |

**不需要**新增 `/admin/install/*`：

- 安装/升级/卸载是**插件侧**行为（要操作 venv、下载、计划任务），服务端只提供模型/自启/日志/系统信息；
- 服务没起来时，`/admin/install/*` 也不可用，反而多一层依赖；
- 真正的“安装 API”就是插件自己的 `/dsh-fish-service/install/*`。

### 5.3 服务端改动的最小集（按优先级）

1. `?embed=1` + 高度上报（P3，前端小改）；
2. `localai bundle`（P5，构建脚本）；
3. `localai models install`（P5，复用 `ModelDownloader`）；
4. `GET /version`（P5，可选）；
5. `/media/concat`（P5+，可选）。

---

## 6. 数据迁移

### 6.1 不需要搬的

| 数据 | 原因 |
| --- | --- |
| `models/` | 服务原地接管，路径不变；不复制 17.7GB |
| `voices/` | 同上；音色名不变 |
| `speakers/` | 同上；声纹向量不变 |
| `outputs/` / `logs/` / `data/` | 服务自己管理 |
| `config.json` | 服务自己管理；插件只读 `paths.home` |

### 6.2 需要新建的

| 数据 | 位置 | 内容 |
| --- | --- | --- |
| 插件配置 | `~\.dsh\fish-service-config.json` | `baseUrl`、`defaultVoice`、超时、缓存 |
| 安装状态 | `~\.dsh\fish-service-install.json` | `installMode=adopted`、`installDir`、版本 |
| 缓存 | `~\.dsh\fish-service-cache\` | 新产物；旧文件不迁 |
| 幂等表 | `~\.dsh\fish-service-cache\ops-idempotency.json` | 运行时生成 |

### 6.3 旧 TTS 数据

- `~\.dsh\tts-rvc\settings.json`：保留；只读 `index.baseUrl` 作为候选；
- `~\.dsh\tts-rvc\calibration.json` / `cloud-usage.json` / `installed.json`：保留；新插件不读；
- 浏览器 `localStorage['dsh-tts-settings']`：保留；设置页可提供「导入旧偏好」按钮（P2，读 `provider`/`voice`，用户确认后写 `defaultVoice`）；
- 旧插件的语音包/RVC 模型：保留；`fish-service` 不使用（不做变声）。

### 6.4 出站队列

`~\.dsh\fish-message-outbox.json` 里可能有 `record_text` 条目：

- 迁移后 `fish-message` 的 `voice.synthesize` 优先走 `fish.service`；
- 补发时重新合成，缓存 TTL 72h 足够；
- 如果服务没起，补发按现有退避继续，不会丢；
- **不要清空出站队列**；迁移前后都保留。

---

## 7. 切换顺序（Cutover）

> 目标：任何时刻只有一个朗读入口、一个语音服务配置源；每步可回滚。

| 步 | 动作 | 验证 | 回滚 |
| --- | --- | --- | --- |
| 0 | 备份 profile `package.json`/`cordis.patch.yml`/`fish-message-config.json` | 备份文件存在 | 恢复备份 |
| 1 | 装 `dsh-fish-service`（P1），**先不启用朗读 UI** | 设置页能看到状态，`fish_service_status` 正常 | 从 bundles 移除 fish-service |
| 2 | 接管 7880，导入 `baseUrl`/`ttsVoice` | `installMode=adopted`，`defaultVoice=dafeiyu` | 删 `fish-service-install.json` |
| 3 | 禁用旧 TTS（确保不在 bundles） | 页面无旧朗读按钮、无 `/dsh-tts-api` | 加回 bundles |
| 4 | 启用 fish-service 朗读按钮（P2） | 每条消息一个按钮，可播放 | 设置里关朗读/移除 bundles |
| 5 | 升级 `dsh-fish-message` 到 0.2.0（P4 前置） | `fish.message` 服务存在；HTTP 行为不变 | 回退 message 版本/代码 |
| 6 | `fish-message` 打开 `useFishService` | 入站转写/出站语音正常；停服务时降级 | 设 `useFishService=false` |
| 7 | 开 `fish-ops`（P4） | 5 个 op 按依赖出现；缺 message 时不出现 | 移除 ops bundle |
| 8 | 跑回归（第 8 节） | 全部通过 | 按步回滚 |

**建议在低峰期做 3~6 步**；第 1~2 步可以提前做，不影响现有使用。

---

## 8. 回归矩阵

| # | 场景 | 步骤 | 期望 |
| --- | --- | --- | --- |
| 1 | QQ 文字入站 | 发「你好」 | 进入 DSH 会话，正常回复 |
| 2 | QQ 语音入站 | 发 3 秒语音 | 转写文字 + 声纹名；无重复消息 |
| 3 | 服务停掉后语音入站 | 停 7880，再发语音 | `[语音（转写失败：…）]`，消息不丢；服务恢复后新消息正常 |
| 4 | QQ 出站文字 | `[QQ]测试[/QQ]` | 收到文字 |
| 5 | QQ 出站语音 | `[QQ][语音]晚安[/语音][/QQ]` | 收到语音条；服务停掉时文字进补发队列，恢复后重发 |
| 6 | DSH 朗读 | 点消息朗读 | 播放；再点停止；不重复播放 |
| 7 | 自动朗读 | 开启，发一条回复 | 只读最终回复；不读工具调用/代码块 |
| 8 | 语音输入 | 录音 3 秒 | 文字进输入框（或剪贴板降级提示） |
| 9 | 旧 TTS 残留 | 检查页面/Network | 无旧朗读按钮、无 `/dsh-tts-api` |
| 10 | 双入口 | 同时启用旧 TTS + fish-service | 文档要求只开一个；验收时不能出现两个按钮 |
| 11 | 507 | 占满显存再点朗读 | UI 显示「显存不够」hint；不自动重试风暴 |
| 12 | 服务未装 | 新机器只装插件 | 设置页显示安装向导；工具返回 `service_not_installed` |
| 13 | ops 缺依赖 | 禁用 fish-message | `voice_note_analyze`/`say_as_voice` 不在工具列表；`fish_tts` 仍可用 |
| 14 | 重启 DSH | 重启后 | 配置/绑定/出站队列不丢；服务自启仍在 |
| 15 | 回滚 | 加回旧 TTS、关 fish-service UI | 旧朗读恢复；无重复入口 |

---

## 9. 回滚总方案

### 9.1 只回滚朗读入口

- `fish-service` 设置里关「朗读按钮」「自动朗读」；
- 或从 `dsh.profile.bundles` 移除 `dsh-fish-service`；
- 旧 TTS 加回 bundles（如果之前移除了）；
- 重启 DSH。

### 9.2 回滚 fish-message 集成

- `fish-message-config.json` 设 `useFishService=false`；
- 重启 DSH；
- 仍走旧 HTTP（`asrBaseUrl`/`ttsBaseUrl` 还在）。

### 9.3 回滚接管

- 删 `~\.dsh\fish-service-install.json`（或把 `installMode` 改回 `unknown`）；
- 删 `~\.dsh\fish-service-config.json`（先备份）；
- 服务本身未被修改，无需恢复。

### 9.4 回滚 ops

- 从 bundles 移除 `dsh-fish-ops`；
- 工具消失；不影响 fish-service / fish-message。

### 9.5 回滚旧 TTS

- 加回 `@memef1f1y/dsh-plugin-tts` 到 bundles；
- 关掉 fish-service 的朗读 UI；
- `~\.dsh\tts-rvc\settings.json` 未改，直接可用；
- 如果之前 remove 了依赖，重新 `dsh plugin --profile desktop add @memef1f1y/dsh-plugin-tts@0.6.7`。

---

## 10. 迁移检查清单（打印出来逐项打勾）

- [ ] 备份 `package.json`、`cordis.patch.yml`、`fish-message-config.json`
- [ ] 确认 `dsh.profile.bundles` 无 `@memef1f1y/dsh-plugin-tts`
- [ ] `dependencies` 保留 `@memef1f1y/dsh-plugin-tts`（可回滚）
- [ ] 7880 `/capabilities` 为 2.5.x / api 1
- [ ] `fish-service` 接管成功（`installMode=adopted`）
- [ ] `defaultVoice=dafeiyu`（或明确回退到 `default`）
- [ ] 页面只有一个朗读入口；Network 无 `/dsh-tts-api`
- [ ] QQ 文字/语音双向回归通过
- [ ] 服务停掉时降级符合预期
- [ ] ops 缺 message 时工具消失、`fish_ops_list` 有原因
- [ ] 回滚步骤实际演练过一次（至少回滚朗读入口）
