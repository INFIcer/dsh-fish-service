# 部署与安装（DEPLOY）

> 目标：让一个没有 Python / CUDA 环境知识的用户，在 DSH 设置页里完成「装服务 → 下模型 → 启动 → 开机自启」，并且能接管已有服务、升级、卸载、离线安装。
>
> 本文中的命令分两类：
> - **【现有】**：`E:\LocalAIService` 当前已经支持；
> - **【新增】**：P5 要在服务端仓库新增，当前不存在。不要照着现有代码找。

---

## 1. 前提与边界

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 19045+ / Windows 11，x64 |
| DSH | `0.2.2-rc.1`（插件 API 以该版本为准） |
| 服务 | `localai-service 2.5.x`，HTTP 契约 `api_version=1` |
| 磁盘 | 代码 50MB + venv 约 7GB + 所选模型（最小约 9.1GB，全量 17.7GB）+ 10% 余量 |
| GPU | NVIDIA，建议 ≥8GB 显存；驱动需满足所选 torch CUDA 轮子（manifest 写明，安装器只比较，不猜） |
| 网络 | 首次装依赖/下模型需要；运行时可离线 |
| 权限 | 默认不需要管理员；计划任务由当前用户创建；装 Windows 服务（NSSM）不做 |

**安装器不负责**：模型训练、CUDA 驱动安装、系统级 Python 安装、杀毒软件白名单。驱动缺失/过旧时只给检测结果和链接，不自动装驱动。

---

## 2. 发布打包（服务端）

### 2.1 现状与缺口

**现有**【现有】：

- `pyproject.toml` 可 `pip install -e .`；`localai` 命令已注册；
- `localai models download <tts|asr|speaker|demucs|all>` 可下模型（ModelScope 优先，失败回退 HF）；
- `/admin/models/download` 支持 `tts/asr/whisper/translate/speaker/separate/vad/vision`，带进度与单任务互斥；
- `start_ai_service.ps1` 是正式启动脚本；
- `tools/restart_service.ps1` 供 `/admin/restart` 使用。

**缺口**【新增】：

| 缺口 | 影响 | P5 方案 |
| --- | --- | --- |
| 没有发布构建命令 | 无法产出可校验的代码包 | `python -m localai bundle` |
| `models download` 不含 translate/vision/whisper，也没有 `--mirror/--json/续传` | 一键安装无法统一调用 | `localai models install`（内部复用 `/admin/models` 的下载器） |
| 没有 `manifest.json`/SHA256 | 无法校验、无法离线 | bundle 生成 |
| 没有 `GET /version` | 只能从 `/capabilities` 取版本 | 轻量别名（可选） |
| `/ui` 没有 embed | iframe 带完整侧栏 | `?embed=1` + postMessage |
| 没有离线包 | 内网/断网装不了 | `bundle --offline` |

### 2.2 打包命令（设计）

```powershell
# 标准包（代码 + 启动脚本 + 文档；不含 venv/模型/用户数据）
python -m localai bundle `
  --out dist `
  --version 2.5.0 `
  --platform win-x64 `
  --cuda cu130 `
  --include-engine `
  --include-webui `
  --format zip

# 离线包（额外带 wheels 与可选模型，体积大，分卷）
python -m localai bundle `
  --out dist\offline `
  --version 2.5.0 `
  --platform win-x64 `
  --cuda cu130 `
  --include-engine `
  --include-wheels `
  --models tts,asr,speaker,demucs,vad `
  --split-mb 2048 `
  --format zip
```

参数语义：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--out` | `dist` | 输出目录 |
| `--version` | 读 `pyproject.toml` | 必须与 `src/localai/__init__.py` 的 `__version__` 一致；不一致直接失败 |
| `--platform` | `win-x64` | 首版只支持 Windows x64 |
| `--cuda` | `cu130` | `cu128` / `cu130` / `cpu`；写入 manifest |
| `--include-engine` | 开 | 带 `engine/*.py` 与 `engine/indextts_vendor/`（源码，不含 venv） |
| `--include-webui` | 开 | 带 `src/localai/webui/` |
| `--include-wheels` | 关 | 离线包：`pip download` 全部依赖到 `wheels/` |
| `--models` | 空 | 离线包：把模型复制进 `models/`（只允许已下载且校验通过的） |
| `--split-mb` | 0（不分卷） | 离线包分卷大小 |
| `--format` | `zip` | `zip` / `dir` |

**排除清单**（硬编码，防止把用户数据打进包）：

```text
.git/  .venv/  engine/.venv/  models/  voices/  speakers/
outputs/  logs/  data/  out/  config.json  *.log  *.wav  *.mp3
__pycache__/  *.pyc  .pytest_cache/  *.egg-info/
```

### 2.3 产物结构

```text
dist/
├─ localai-service-2.5.0-win64-cu130.zip
├─ localai-service-2.5.0-win64-cu130.manifest.json
├─ localai-service-2.5.0-win64-cu130.manifest.json.sig   # P5 待定：Ed25519
└─ SHA256SUMS
```

zip 内：

```text
localai-service-2.5.0/
├─ manifest.json
├─ VERSION
├─ pyproject.toml
├─ README.md
├─ start_ai_service.ps1
├─ start_webui.bat
├─ src/localai/                 # 服务层 + webui 静态文件
├─ engine/                      # 原生引擎源码 + indextts_vendor
│  ├─ engine.py
│  ├─ asr_engine.py
│  ├─ whisper_engine.py
│  ├─ translate_engine.py
│  ├─ vision_engine.py
│  ├─ separator_engine.py
│  ├─ speaker_engine.py
│  ├─ download_engine.py
│  ├─ vram_manager.py
│  ├─ requirements.lock.txt
│  └─ indextts_vendor/
├─ tools/
│  ├─ restart_service.ps1
│  └─ start_webui.ps1
└─ docs/                        # SERVICE_API / WEBUI / INSTALL（可选，便于离线排查）
```

> **不打包** `engine/.venv`。venv 与机器绑定（CUDA/驱动/Python ABI），必须在目标机重建。

### 2.4 manifest.json

```json
{
  "schemaVersion": 1,
  "name": "localai-service",
  "version": "2.5.0",
  "apiVersion": "1",
  "build": {
    "platform": "win-x64",
    "python": ">=3.11,<3.14",
    "cuda": "cu130",
    "torch": "2.11.0+cu130",
    "minDriver": "580.00",
    "builtAt": "2026-11-09T12:00:00+08:00",
    "gitCommit": "b083d02"
  },
  "artifact": {
    "path": "localai-service-2.5.0-win64-cu130.zip",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "sizeBytes": 0
  },
  "install": {
    "entry": "start_ai_service.ps1",
    "module": "localai",
    "serve": ["-m", "localai", "serve"],
    "defaultPort": 7880,
    "homeEnv": "LOCALAI_HOME"
  },
  "dependencies": {
    "core": ["fastapi>=0.110", "uvicorn[standard]>=0.27", "httpx>=0.27", "python-multipart>=0.0.9", "pydantic>=2.5", "soundfile>=0.12", "numpy>=1.24"],
    "engines": ["torch", "funasr", "demucs", "transformers", "sentencepiece", "langdetect"],
    "optional": ["modelscope", "huggingface_hub", "yt-dlp"]
  },
  "models": [
    { "capability": "tts", "name": "IndexTTS-2.5", "required": true, "sizeMb": 8075 },
    { "capability": "asr", "name": "SenseVoiceSmall", "required": true, "sizeMb": 897 },
    { "capability": "speaker", "name": "campplus", "required": true, "sizeMb": 27 },
    { "capability": "vad", "name": "fsmn-vad", "required": true, "sizeMb": 4 },
    { "capability": "separate", "name": "htdemucs", "required": false, "sizeMb": 80 },
    { "capability": "translate", "name": "nllb-200-distilled-600M", "required": false, "sizeMb": 2368 },
    { "capability": "vision", "name": "Qwen2.5-VL-3B-Instruct-Q4_K_M", "required": false, "sizeMb": 4023 },
    { "capability": "whisper", "name": "small", "required": false, "sizeMb": 464 }
  ],
  "signature": { "algo": "ed25519", "keyId": "localai-release-2026", "sig": "PENDING" }
}
```

字段规则：

- `artifact.sha256` 必填；插件安装前必须校验；
- `models[].sizeMb` 用于预检磁盘，允许与实际差 ±5%；安装完成以 `/admin/models.present` 为准；
- `minDriver` 是**示例值**，由构建者按 torch CUDA 轮子填（本机 591.59 可跑 cu130）；安装器只比较 `nvidia-smi` 的 driver 版本，不自行推断；
- `signature` P5 待定；未签名时 `sig` 为 `null`，插件在 UI 明示「未签名包」，不阻止安装（内网场景）。

### 2.5 体积估算（实测）

| 组成 | 大小 | 说明 |
| --- | --- | --- |
| 代码包（不含 venv/模型/数据） | **3.6 MB**（282 files） | 实测源码；zip 后约 1.2~1.5MB |
| 引擎 venv | **6.5 GB** | 含 torch 2.11+cu130；实际安装可能 5~7GB |
| 模型：最小可用 | **约 9.1 GB** | TTS 8075 + ASR 897 + campplus 27 + VAD 4 + Demucs 133 |
| 模型：全量 | **17.7 GB** | 再加视觉 4023 + 翻译 2368 + whisper 2139 |
| 离线全量包 | **约 24 GB+** | 代码 + wheels + 最小模型；全量模型另算 |

> 用户文档里的「3~5GB 引擎」是旧估算；本机实测 venv 6.5GB。安装器显示实际大小，不用固定文案骗人。

### 2.6 构建流水线

```text
tag v2.5.0
  → 干净 clone（不含 .venv/models/voices）
  → python -m localai bundle --out dist ...
  → 生成 manifest + SHA256
  → 在干净 Windows VM 上：解压 → uv venv → 安装 core+engine → doctor → /health
  → 上传 release（GitHub / 内网）
```

验收门槛：干净 VM 上 `localai doctor` 全绿、`/health` 200、`/ui` 可打开、`/capabilities.api_version=1`。

---

## 3. 插件侧安装流程

> **顺序与直觉不同：先启动服务（0 模型），再下模型。**
> 因为模型下载接口 `/admin/models/download` 由服务提供；服务启动时 0 模型是正常状态（`/health` 可能 `ok:false`，但 HTTP 200、`/capabilities` 可用）。
>
> 正确顺序：预检 → 选目录 → uv → venv → 代码包 → 引擎依赖 → **启动** → 健康可达 → **模型下载** → 模型校验 → 自启 → 写配置。
> 不要“先下完模型再启动”，那会绕过服务端的下载进度/互斥/校验逻辑。

### 3.1 状态机

```text
unknown
  ├─ 探测到已有服务 → adopted（只读接管，不装）
  └─ 没探测到 → not_installed
        └─ preflight_ok → installing
              ├─ 成功 → installed（启动并写配置）
              └─ 失败 → failed（可重试；回滚 createdPaths）
installed
  ├─ 发现新版本 → upgrading → installed / rollback
  └─ 卸载 → uninstalling → not_installed（保留用户数据）
```

状态文件：`~/.dsh/fish-service-install.json`

```json
{
  "version": 1,
  "installMode": "managed",
  "installDir": "C:\\Users\\Administrator\\AppData\\Local\\localai-service",
  "serviceVersion": "2.5.0",
  "apiVersion": "1",
  "createdPaths": ["C:\\...\\localai-service\\src", "C:\\...\\localai-service\\engine", "C:\\...\\localai-service\\engine\\.venv"],
  "createdAutostart": true,
  "autostartName": "LocalAIService-Service",
  "startedByUs": true,
  "lastInstallAt": "2026-11-09T20:00:00+08:00",
  "lastError": null
}
```

### 3.2 预检（preflight）

**检查项与命令**

| # | 检查 | 命令/接口 | 失败处理 |
| --- | --- | --- | --- |
| 1 | Windows 版本 | `[Environment]::OSVersion.Version` | <10.0.19045 → `bad_request`，提示升级 |
| 2 | 架构 | `$env:PROCESSOR_ARCHITECTURE` | 非 `AMD64` → 拒绝 |
| 3 | 目标盘空间 | `Get-PSDrive -Name <盘符>` | 需要 `代码 50MB + venv 7GB + 模型 + 10%`；不足 → 列出明细 |
| 4 | GPU | `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader` | 无 NVIDIA → 允许「仅媒体/下载」lite 模式；否则提示 |
| 5 | 驱动 | 比较 manifest `minDriver` | 过旧 → 给驱动下载链接，不自动装 |
| 6 | 端口 7880 | `Get-NetTCPConnection -LocalPort 7880 -State Listen` | 被 localai 占用 → adopt；被其它程序占用 → 换端口或让用户关闭 |
| 7 | 已有服务 | `GET <baseUrl>/health`、`GET http://127.0.0.1:7880/health`（2s 超时；只看 HTTP 200，不看 `ok`） | 通 → 版本协商（第 4 节） |
| 8 | 已有安装标记 | `~/.dsh/fish-service-install.json` + 目录内 `.dsh-fish-service-install.json` | 一致 → 走升级/修复；不一致 → 告警，不覆盖 |
| 9 | ffmpeg | `Get-Command ffmpeg` / `LOCALAI_FFMPEG` | 缺失 → 媒体/关键帧不可用；hint 给安装方法（winget 需用户确认） |
| 10 | 网络 | 访问 `https://modelscope.cn` / PyPI 镜像，5s 超时 | 失败 → 提示离线包；不立刻失败（本地包可继续） |
| 11 | 写权限 | 在目标目录建临时文件再删 | 失败 → 换目录/提示权限 |

**PreflightResult**

```json
{
  "ok": true,
  "os": "Windows-10-10.0.19045",
  "arch": "x64",
  "disk": { "drive": "C", "freeMb": 120000, "requiredMb": 26000 },
  "gpu": { "name": "NVIDIA GeForce RTX 3070", "totalMb": 8192, "driver": "591.59", "ok": true },
  "port": { "port": 7880, "listening": false, "owner": null },
  "existing": { "found": true, "baseUrl": "http://127.0.0.1:7880", "version": "2.5.0", "apiVersion": "1", "mode": "adoptable" },
  "ffmpeg": { "ok": true, "path": "C:\\...\\ffmpeg.exe" },
  "network": { "ok": true, "checked": ["modelscope", "pypi"] },
  "warnings": [],
  "blockers": []
}
```

`blockers` 非空就不允许开始安装；`warnings` 允许继续但 UI 要显示。

### 3.3 选目录

- 默认：`%LOCALAPPDATA%\localai-service`（通常 `C:\Users\<user>\AppData\Local\localai-service`）；
- 允许用户选其它目录；拒绝：盘符根、`C:\Windows`、`C:\Program Files`（无管理员时）、网络路径、junction 逃逸；
- 目录非空：
  - 有安装标记且版本一致 → 提示「已安装，可修复/升级」；
  - 有安装标记但版本不同 → 升级；
  - 无标记但有文件 → **不覆盖**，要求换目录或明确「这是旧安装，接管」；
- 目录内写 `.dsh-fish-service-install.json` 标记（与全局状态互相校验）。

### 3.4 uv 引导

**优先**：`uv --version` 可用（PATH 或 `%LOCALAPPDATA%\Programs\uv\uv.exe`）。

**没有**：下载便携版（不需要管理员）：

```text
https://github.com/astral-sh/uv/releases/download/<version>/uv-x86_64-pc-windows-msvc.zip
```

- 版本固定写在插件 `package.json` 的 `fishService.uvVersion`（P5 定），不追 latest；
- 下载到 `<installDir>\tools\uv.zip`，校验 SHA256（插件内置），解压到 `<installDir>\tools\uv\`；
- 只执行 `uv.exe`，不执行 zip 里的其它脚本；
- 国内镜像：`UV_DEFAULT_INDEX` 或 `--default-index` 指到用户配置的 PyPI 镜像；
- 失败：提示手动安装 uv 或改用离线包，不无限重试。

### 3.5 venv 与代码包

```powershell
# 1) 建 venv（uv 可自动下载 Python 3.12，不依赖系统 Python）
& "<installDir>\tools\uv\uv.exe" venv --python 3.12 "<installDir>\engine\.venv"

# 2) 安装代码包（wheel 或解压后的源码目录）
& "<installDir>\tools\uv\uv.exe" pip install `
  --python "<installDir>\engine\.venv\Scripts\python.exe" `
  "<installDir>\localai-service-2.5.0"    # 或 .whl

# 3) 验证
& "<installDir>\engine\.venv\Scripts\python.exe" -m localai version
```

- 解压前校验 zip SHA256；解压后校验 `manifest.json` 的 `version/apiVersion`；
- 不把 `engine\.venv` 打进代码包；不在全局 Python 装任何东西；
- 目录含空格/中文：所有命令用引号；PowerShell 用 `&` 调用，不拼字符串执行；
- 失败：删除本次创建的 `engine\.venv` 与解压目录（只删 createdPaths），保留下载的 zip 以便重试。

### 3.6 引擎依赖（可选，但 TTS/ASR/视觉需要）

```powershell
# torch 按 manifest 的 cuda 选择索引（示例 cu130）
& uv pip install --python "<venv>\Scripts\python.exe" torch==2.11.0 `
  --index-url https://download.pytorch.org/whl/cu130

# 其余引擎依赖
& uv pip install --python "<venv>\Scripts\python.exe" `
  funasr demucs transformers sentencepiece langdetect `
  modelscope huggingface_hub yt-dlp
```

- **不要** `pip install torch` 不带索引（会拿 CPU 版）；
- 需要与发布包完全一致时，用 `engine\requirements.lock.txt`（`pip freeze` 结果），但要先确认 CUDA 版本匹配；
- 安装后验证：`python -c "import torch; print(torch.__version__, torch.cuda.is_available())"`；
- 失败/超时：保留已下载 wheel 缓存（`uv` cache），重试不从头；
- 用户可选「仅媒体/下载」lite：跳过 torch/引擎，只装 core；此时 TTS/ASR/视觉/分离不可用，UI 明确标注。

### 3.7 模型

**原则**：安装器不自己实现下载；调服务端 `/admin/models/download`，一次一个（服务端只允许一个任务）。

| 能力 | name | 大小（实测） | 必需 | 说明 |
| --- | --- | --- | --- | --- |
| `tts` | `""`（固定 IndexTTS-2.5） | 8075 MB | ✅ | 朗读/发语音 |
| `asr` | `""`（固定 SenseVoiceSmall） | 897 MB | ✅ | 语音输入/转写 |
| `speaker` | `""`（固定 campplus） | 27 MB | ✅ | 声纹 |
| `vad` | `""`（固定 fsmn-vad） | 4 MB | ✅ | 分段/长音频 |
| `separate` | `htdemucs` | 80 MB | 推荐 | 人声分离 |
| `translate` | `""`（固定 NLLB） | 2368 MB | 可选 | 翻译 |
| `vision` | `""`（固定 Qwen2.5-VL-3B） | 4023 MB | 可选 | 关键帧/视觉 |
| `whisper` | `small` | 464 MB | 可选 | 精确时间戳 |

请求体（真实接口）：

```json
{"capability":"tts","name":""}
{"capability":"asr","name":""}
{"capability":"speaker","name":""}
{"capability":"vad","name":""}
{"capability":"separate","name":"htdemucs"}
{"capability":"translate","name":""}
{"capability":"vision","name":""}
{"capability":"whisper","name":"small"}
```

流程：

1. **前置**：服务已启动（0 模型即可），`GET /health` 返回 HTTP 200；`ok` 可能是 `false`，因为 TTS 权重还没下；
2. `GET /admin/models` 拿 `present/size_mb/missing`，已存在的跳过；
3. 用户勾选后按「必需 → 推荐 → 可选」顺序串行下载；
4. `POST /admin/models/download` → `{task_id}`；
5. 每 1 秒 `GET /admin/models/tasks/{task_id}`，把 `downloaded_mb/percent/status` 推到进度条；
6. 完成后再 `GET /admin/models` 校验 `present=true` 且 `missing=[]`；
7. 失败：显示 `error`，允许「重试这一项」；已下载文件保留，底层 snapshot 支持续传；
8. 全部模型完成后**不需要重启服务**：模型是懒加载，`/admin/models` 立即可见；下一次请求会加载。

> `localai models download` 当前只支持 tts/asr/speaker/demucs/all，不含 translate/vision/whisper；所以安装器统一走 `/admin/models/download`，不调 CLI。P5 的 `localai models install` 只是给脚本/离线场景的补充。
>
> 如果用户选的是「lite（仅媒体/下载）」：跳过 torch/引擎依赖，服务仍可启动；TTS/ASR/视觉/分离在状态页标灰。

### 3.8 启动与开机自启

> 安装器实际顺序：**本节先启动服务（0 模型）→ 再做 3.7 的模型下载 → 最后回本节注册自启**。
> 3.7 的 `/admin/models/download` 依赖服务已经在跑。

**启动**（服务未运行）：

```powershell
# 方式 A：直接调用安装目录的启动脚本（推荐，日志落 logs\）
Start-Process -FilePath "powershell.exe" `
  -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',"<installDir>\start_ai_service.ps1") `
  -WorkingDirectory "<installDir>" -WindowStyle Hidden

# 方式 B：WMI 脱离父进程（DSH 重启也不影响）
$startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance(); $startup.ShowWindow = 0
[void]([wmiclass]"Win32_Process").Create($cmd, "<installDir>", $startup)
```

等待 `/health` 返回 **HTTP 200**（最多 120 秒，每 2 秒一次）；**不要等 `ok:true`**，模型还没下时它就是 false。判定服务可用看 `/capabilities` 能否返回 `api_version=1`。失败读 `logs\service.err.log` 尾部 50 行。

**自启：两种方案对比**

| 方案 | 优点 | 缺点 | 采用 |
| --- | --- | --- | --- |
| 计划任务 `LocalAIService-Service`（服务端 `/admin/autostart` 已实现） | 登录触发、隐藏窗口、状态可查、已有代码 | 任务计划权限不足时失败 | **默认** |
| 启动文件夹 `.vbs` 快捷方式 | 不需要任务计划权限 | 无状态查询、易被误删、隐藏窗口要写 VBS | 回退 |
| NSSM 注册 Windows 服务 | 开机即启、不依赖登录 | 需管理员、额外二进制、卸载麻烦 | 不做 |

调用：

```http
POST /admin/autostart
{"enabled": true}
```

返回计划任务状态；若 `detail` 含权限错误 → 回退启动文件夹：

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\localai-service.vbs
```

VBS 内容（隐藏窗口）：

```vbscript
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""<installDir>\start_ai_service.ps1""", 0, False
```

**停止/重启（安全约束）**

- 重启优先用 `POST /admin/restart {"confirm":true}`（服务端自己处理脱离进程与重启）；
- 升级需要“停掉再换文件”时：从 `/admin/system.service.pid` 拿 PID，校验命令行含 `localai serve` 且可执行文件在 `<installDir>` 下，才 `Stop-Process -Id <pid>`；**不要** `taskkill /IM python.exe` 或杀所有 python；
- 停止后 30 秒内没退出 → 报错并让用户手动处理，不强杀。

**只在 `/health` HTTP 200 且 `/capabilities.api_version=1` 后**写 `fish-service-config.json` 的 `baseUrl`/`installMode`；否则用户会看到一个连不上的地址。`ok:false` 不是阻塞条件（模型没下而已）。

### 3.9 进度、失败与回滚

**进度事件**（SSE `/dsh-fish-service/install/events`）：

```text
event: progress
data: {"taskId":"...","step":"venv","index":4,"total":15,"percent":27,"message":"正在创建虚拟环境","detail":"uv venv --python 3.12"}

event: progress
data: {"taskId":"...","step":"start","index":8,"total":15,"percent":53,"message":"启动服务（0 模型）","detail":"GET /health → HTTP 200"}

event: progress
data: {"taskId":"...","step":"models","index":9,"total":15,"percent":62,"message":"下载 TTS 模型 3.2/8.1 GB","detail":"IndexTTS-2.5"}

event: done
data: {"ok":true,"serviceVersion":"2.5.0","health":"reachable","models":"ok"}
```

轮询兜底：`GET /install/status` 返回同一结构的 `steps[]`。

**失败处理**

| 失败点 | 行为 |
| --- | --- |
| 预检 blocker | 不开始，不创建目录 |
| uv 下载/校验失败 | 保留 zip，提示手动安装；不创建 venv |
| venv 创建失败 | 删除本次 venv；保留代码包 |
| 代码包校验失败 | 删除解压目录；不启动 |
| 引擎依赖失败 | 保留 venv 与 wheel 缓存；允许「重试引擎依赖」或「以 lite 模式继续」 |
| 模型失败 | 保留已下载文件；允许单项重试；不写“安装完成”，但服务仍可运行（只是该能力不可用） |
| 启动失败 | 读 err log；不写配置；允许重试/回滚 |
| 健康检查超时 | 同上；进程可能还在启动，给 120 秒；只看 HTTP 200，不等 `ok:true` |
| 自启失败 | 安装仍算成功，UI 标「自启未启用」，提供手动方案 |

**回滚**

- 维护 `createdPaths`（只记录本次创建、且不在安装前存在的路径）；
- 回滚顺序：停进程（仅自己启动的）→ 删 createdPaths → 删安装标记 → 恢复配置备份；
- **不删**：`models/`、`voices/`、`speakers/`、`data/`、`outputs/`、`logs/`、用户 `config.json`；
- 如果服务是 `adopted`，回滚只删插件自己的状态文件，不动服务目录。

---

## 4. 接管已有服务

### 4.1 探测顺序

1. 插件配置的 `baseUrl`（默认 `http://127.0.0.1:7880`）；
2. `http://127.0.0.1:7880`；
3. 用户手动填的地址。

**不扫全网、不扫 7881~7890**（避免误连别的服务）；需要时让用户填。

### 4.2 版本协商

```text
GET <baseUrl>/health          (2s)
GET <baseUrl>/capabilities    (5s)
GET <baseUrl>/admin/system    (5s，可选，拿 paths.home/autostart)
```

判定：

| 条件 | 结果 |
| --- | --- |
| `/health` 超时/非 200 | 不是可接管服务 |
| `/health` 200 但 `ok:false` | **仍可接管**：只表示 TTS 模型还没下；看 `/capabilities` 判断能力 |
| `/capabilities.service.name != "localai-service"` | 不是 localai，拒绝接管 |
| `api_version` 主版本 != 1 | 提示升级插件/服务；可只读展示，不写配置 |
| `service.version` < `minServiceVersion`（默认 2.5.0） | 提示升级；不自动重装 |
| 以上都通过 | `installMode=adopted`，记录 `baseUrl`、`serviceVersion`、`paths.home`（只读） |

`adopted` 的行为：

- **不**安装/升级/卸载服务目录；
- **不**改 `LOCALAI_HOME`、模型、配置；
- 只使用现有 `/admin/*` 做模型下载/自启/日志；
- 设置页显示「已接管，安装目录由用户管理」；
- 卸载插件不影响服务。

### 4.3 安全提示

- `listen.host` 不是 `127.0.0.1` 且 `auth.required=false` → 黄色警告，建议设 `LOCALAI_TOKEN`；
- token 已设置但插件没配 → 状态页 401，提示填 token；
- 服务版本比插件新 → 允许，标「比插件新，未知字段已忽略」。

---

## 5. 升级与卸载

### 5.1 升级（仅 managed）

```text
当前版本 < 目标版本：
  1. 读 /admin/system.service.pid 与命令行，确认是 localai serve
  2. 备份当前代码目录（不含 models/voices/speakers/data/outputs/logs，也**不含 engine\.venv**）到 <installDir>\.backup\<old>-<ts>
  3. 停止进程（只停 PID 匹配的那个；不 taskkill 全部 python）
  4. 下载新包 → 校验 SHA256 → 解压覆盖代码（保留 config.json/模型/数据）
  5. 若 manifest 的引擎依赖 hash 变化 → 重装引擎依赖（可跳过，先试跑）
  6. 启动 → /health → /capabilities 版本校验
  7. 成功：更新 install.json；失败：恢复 .backup，重启旧版
```

约束：

- 模型/音色/声纹/输出/日志**原地保留**；
- `config.json` 保留；新增配置项用默认值；
- 升级不自动改端口/不重下模型；
- 跨大版本（如 2.x→3.x）先读 release notes；`api_version` 变了要升级插件。

### 5.2 卸载

**默认（保留用户数据）**

1. 停进程（仅自己启动/确认是 localai 的 PID）；
2. 取消自启（仅 `createdAutostart=true` 时）；
3. 删除代码、venv、`tools/uv`、缓存；
4. **保留** `models/`、`voices/`、`speakers/`、`data/`、`outputs/`、`logs/`、`config.json`；
5. 删除安装标记；保留 `fish-service-config.json.bak-<ts>`。

**可选（删除我下载的模型）**

- 默认不勾；勾选后二次确认，显示将删除的目录与大小；
- 只删安装 manifest 里记录、且 `present` 由我们下载的模型目录；
- 不删 `/admin/models/search-paths` 指向的外部目录、不删用户手放的模型。

**卸载后**

- 设置页回到安装向导；
- 不自动删 `~/.dsh/fish-service-cache` 之外的任何用户文件；
- 若服务是 `adopted`，卸载只删插件状态，不动服务。

---

## 6. 离线 / 内网

### 6.1 镜像源

| 用途 | 默认 | 可配 |
| --- | --- | --- |
| 模型 | ModelScope 优先，HF 回退 | `modelMirror=modelscope/huggingface/hf-mirror` |
| PyPI | 官方 | `pypiIndex=https://pypi.tuna.tsinghua.edu.cn/simple` 等 |
| torch | `https://download.pytorch.org/whl/cu130` | `torchIndex` |
| uv | GitHub Releases | 内网可放同版本 zip，插件校验 SHA256 |

镜像只影响下载，不影响运行时；切换镜像不需要重装服务。

### 6.2 离线包

```text
localai-service-2.5.0-offline-win64-cu130/
├─ manifest.offline.json          # 版本/哈希/依赖/模型清单/分卷列表
├─ code/localai-service-2.5.0.zip
├─ wheels/                        # pip download 的全部 wheel
├─ models/                        # 可选：tts/asr/speaker/vad/demucs
├─ install-offline.ps1            # 可选：不依赖插件的最小安装脚本
└─ SHA256SUMS
```

离线安装：

1. 选择本地目录/zip；
2. 校验 `manifest.offline.json` 与每个分卷 SHA256；
3. `uv pip install --no-index --find-links wheels`；
4. 把 `models/*` 复制到 `<installDir>\models\`（只复制，不移动）；
5. 启动 + `/admin/models` 校验 `present`；
6. 不访问外网；如果用户勾了缺失的可选模型，明确提示「离线包未包含」。

### 6.3 断网降级

| 场景 | 行为 |
| --- | --- |
| 预检网络失败 | `warnings` 提示「将使用离线包/本地缓存」；不直接失败 |
| 下载模型失败 | 最多 3 次退避（5s/15s/45s）；仍失败给「重试/换镜像/离线包」三个按钮 |
| uv 下载失败 | 提示手动安装 uv 或离线包；不重试超过 2 次 |
| 服务已装、仅网络断 | 不影响本地推理；模型下载/更新按钮置灰并提示 |

---

## 7. WebUI 内嵌

### 7.1 服务端改动【新增】

1. `index.html` 读取查询参数：

```js
const params = new URLSearchParams(location.search)
const embed = params.get('embed') === '1'
const view = params.get('view') || 'overview'
if (embed) document.body.classList.add('embed')
```

2. `styles.css`：

```css
body.embed .sidebar,
body.embed .topbar { display: none !important; }
body.embed .main { margin-left: 0 !important; width: 100% !important; }
body.embed { background: transparent; }
```

3. `app.js` 启动时 `switchView(view)`；`embed` 下不启动 3 秒自动刷新以外的全局轮询（可选）。

4. 高度上报：

```js
function reportHeight() {
  if (!document.body.classList.contains('embed')) return
  const h = Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  )
  parent.postMessage({ type: 'localai:height', height: h }, '*')
}
window.addEventListener('load', reportHeight)
window.addEventListener('resize', reportHeight)
new ResizeObserver(reportHeight).observe(document.body)
```

5. 安全头：

- **不要**设 `X-Frame-Options: DENY/SAMEORIGIN`（会把 DSH 的跨源 iframe 拦掉）；
- 如果以后加 CSP，用 `frame-ancestors 'self' http://127.0.0.1:* http://localhost:*`；
- 不使用已废弃的 `ALLOW-FROM`；
- `/ui` 本身免鉴权（现状），但 `/admin/*` 仍受 token 保护。**WebUI 自己**会从 `localStorage['localai_token']` 读 token 并加 `Authorization`（`app.js` 现有逻辑）；iframe 的源是 `7880`，用户如果在这个源下登录过，embed 里也能用；
- 宿主的 `token` 存在 `fish-service-config.json`，和浏览器 `localStorage` 是两份。**不要**把 token 拼进 iframe URL；P3 决策：iframe 只做展示，遇到 401 时显示「在新窗口打开并输入 token」，不自动跨源传 token（要传也必须 `postMessage` + 校验 `origin`，P5 再评估）。

### 7.2 宿主侧

```ts
const origin = new URL(baseUrl).origin
const src = `${baseUrl}/ui?embed=1&view=${view}`

<iframe
  src={src}
  title="本地 AI 服务"
  style={{ width: '100%', height: height, border: '0', borderRadius: 10 }}
  onLoad={() => setLoaded(true)}
  onError={() => setFailed(true)}
/>

window.addEventListener('message', (e) => {
  if (e.origin !== origin) return
  if (e.data?.type !== 'localai:height') return
  const h = Number(e.data.height)
  if (Number.isFinite(h)) setHeight(Math.min(1200, Math.max(480, h)))
})
```

- 视图切换：设置页外部 tab（概览/模型/设置/任务/系统）改变 `view`，重新设置 iframe `src`；
- 兜底：
  - 8 秒未 `onLoad` 或 `health` 不通 → 显示「服务未启动/无法连接」+「启动服务」+「新窗口打开」；
  - iframe 内白屏无法检测（跨源），以 `health` + `onLoad` 双条件判断；
- 不把 token 拼进 iframe URL；不在 iframe 内做安装/卸载；
- 移动端/窄屏：iframe 最小高度 480，超出滚动。

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 安装时 7880 被占用 | 旧服务/其它程序 | 先 `GET /health` 判断是否 localai；是→接管；否→换端口或关程序 |
| `uv` 下载失败 | 网络/代理/杀软 | 手动装 uv 或用离线包；检查 `%LOCALAPPDATA%\uv` |
| `torch.cuda.is_available()=False` | 装了 CPU torch / 驱动旧 | 用 manifest 的 cuXXX 索引重装；更新驱动；不要混装 |
| 模型下载 0 字节/中断 | 镜像/磁盘/网络 | 换 `modelMirror`；检查磁盘；重试会续传；看 `/admin/models/tasks/{id}.error` |
| 服务启动后立刻退出 | 端口占用/缺依赖/路径含特殊字符 | 看 `logs\service.err.log`；`localai doctor`；换无空格路径 |
| `/health` 200 但 TTS 503 | 模型缺文件/引擎依赖没装 | `GET /admin/models` 看 `present/missing`；重装引擎依赖 |
| 401 | 服务设了 token，插件没配 | 设置页填 token；不要写进 URL |
| 507 | 显存不足 | 关占卡程序；`/vram/unload`；换小模型/分段 |
| iframe 空白 | 服务没起/被安全头拦/跨源 | 先看 `/health`；检查 `X-Frame-Options`/CSP；用「新窗口打开」 |
| 自启失败 | 任务计划权限 | 用启动文件夹 VBS 回退；或手动允许任务 |
| 卸载后模型还在 | 默认保留用户数据 | 属预期；需要删就勾「同时删除我下载的模型」 |
| 升级后配置丢失 | 覆盖了 config.json | 升级前备份；只覆盖代码，不覆盖 config |

**诊断命令**

```powershell
curl.exe -s http://127.0.0.1:7880/health
curl.exe -s http://127.0.0.1:7880/capabilities
curl.exe -s http://127.0.0.1:7880/admin/system
curl.exe -s http://127.0.0.1:7880/admin/models
& "<installDir>\engine\.venv\Scripts\python.exe" -m localai doctor
Get-Content "<installDir>\logs\service.err.log" -Tail 80
```

---

## 9. 验收清单

### 9.1 打包

- [ ] `python -m localai bundle --out dist --version 2.5.0` 成功；
- [ ] zip 内无 `.venv/models/voices/speakers/outputs/logs/data/config.json`；
- [ ] manifest 有 version/apiVersion/platform/cuda/models/sha256；
- [ ] 干净 VM 解压后 `uv venv` + 安装 core/engine + `localai doctor` 全绿；
- [ ] 代码包 < 50MB。

### 9.2 全新安装

- [ ] 空目录、无 uv、无 Python：一键安装成功；
- [ ] 预检显示磁盘/GPU/端口/网络；
- [ ] 模型按勾选下载，进度可见，`/admin/models` 全 `present`；
- [ ] `/health` 200，`/ui` 可打开；
- [ ] 计划任务创建成功，重启 Windows 后自动起来；
- [ ] 第二次点安装：`already_installed`，不重复建任务。

### 9.3 接管

- [ ] 现有 `E:\LocalAIService` 7880 被识别为 `adopted`；
- [ ] 不重装、不移动、不重启；
- [ ] 设置页显示真实 `paths.home` 与版本；
- [ ] 卸载插件不影响服务。

### 9.4 升级/卸载

- [ ] 升级保留 models/voices/speakers/data/config；
- [ ] 升级失败自动恢复备份并重启旧版；
- [ ] 卸载默认保留模型；勾选后才删自己下载的；
- [ ] 自启只删自己创建的任务。

### 9.5 离线/内网

- [ ] 断网时预检提示离线包，不无限重试；
- [ ] 离线包安装成功，`/health` 200；
- [ ] 缺失可选模型时明确提示，不静默跳过；
- [ ] 切换 ModelScope/HF 镜像后下载可用。

### 9.6 WebUI

- [ ] `/ui?embed=1` 隐藏 `.sidebar`/`.topbar`；
- [ ] iframe 高度随内容变化（±4px）；
- [ ] 视图切换可用；
- [ ] 服务未启动显示引导，不白屏；
- [ ] 「新窗口打开」可用；
- [ ] iframe 不泄漏 token。

---

## 10. 附录

### 10.1 安装目录布局（managed）

```text
%LOCALAPPDATA%\localai-service\
├─ .dsh-fish-service-install.json   # 安装标记
├─ VERSION
├─ manifest.json
├─ pyproject.toml
├─ start_ai_service.ps1
├─ src\localai\
├─ engine\
│  ├─ *.py
│  ├─ indextts_vendor\
│  └─ .venv\                        # 6.5GB
├─ tools\uv\uv.exe
├─ models\                          # 用户数据，卸载默认保留
├─ voices\
├─ speakers\
├─ outputs\
├─ logs\
├─ data\
└─ config.json
```

### 10.2 缓存布局（插件）

```text
~\.dsh\fish-service-cache\
├─ tts\<sha16>-<ts>.wav
├─ separate\<jobid>\vocals.wav ...
├─ vision\<jobid>\frame_0001.jpg
├─ tmp\                             # ASR 上传临时文件，请求结束即删
└─ ops-idempotency.json             # 10 分钟幂等表
```

### 10.3 关键环境变量（安装器设置）

| 变量 | 值 |
| --- | --- |
| `LOCALAI_HOME` | `<installDir>` |
| `PYTHONPATH` | `<installDir>\src` |
| `TORCH_HOME` | `<installDir>\models\torch` |
| `LOCALAI_FFMPEG` / `LOCALAI_FFPROBE` | 探测到的路径（可选） |
| `PYTHONUTF8` / `PYTHONIOENCODING` | `1` / `utf-8` |
| `TTS_BACKEND` | `engine` |
