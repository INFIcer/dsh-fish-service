# dsh-fish-service / dsh-fish-ops

> **状态：只有设计文档，没有实现代码。** 本仓库当前用于冻结契约、评审方案，评审通过后再按 `docs/DESIGN.md` 的 P1 开工。
>
> 目标版本：DSH `0.2.2-rc.1`；本地服务 `localai-service 2.5.x`（HTTP 契约 `api_version = "1"`）。
> 最后核对：2026-11-09。

---

## 这是什么

两个 DSH 插件，把「本地 AI 服务」从一堆手写 HTTP 调用，变成 DSH 里可发现、可配置、可安装、可组合的能力：

| 插件 | 一句话 | 关键点 |
| --- | --- | --- |
| **`dsh-fish-service`** | DSH 侧唯一的本地 AI 门面 | 唯一知道服务地址的地方；提供 `fish.service` Cordis 服务、8 个 Agent 工具、朗读/语音输入/设置页 UI、服务安装与模型管理 |
| **`dsh-fish-ops`** | 多步调用链的编排层 | 只封装「需要多个插件协作」的链路；依赖缺失的 op **不注册、不可见、不可调用**；不保存服务地址 |

底层仍然是 `E:\LocalAIService` 的 FastAPI 服务（默认 `http://127.0.0.1:7880`，`python -m localai serve`）。**它的 HTTP 接口一个都不删**，其它软件、脚本、旧插件可以继续直接调。

```text
localai-service（引擎层，HTTP :7880）
        ▲  HTTP（唯一出口在 fish-service）
        │
dsh-fish-service（DSH 门面：fish.service + 工具 + UI + 安装管理）
        ▲  Cordis 服务 / 工具
        │
dsh-fish-ops（组合链路，按依赖条件注册）
        ▲
其它插件（dsh-fish-message 等，可按需使用 fish.service，也可完全不用）
```

## 为什么拆成两个插件

- **地址只有一份**：`baseUrl`、token、超时、能力缓存、错误翻译都在 `fish-service`。其它插件不再各写一份 `127.0.0.1:7880`。
- **单步不重复封装**：`fish_tts`、`fish_asr` 已经是单步工具，`fish-ops` 不再包一层；它只做「转写 + 声纹 + 投递」「翻译 + 合成 + 发语音」这类多步链路。
- **依赖缺失就消失**：`fish-ops` 的每个 op 声明 `requires`；缺 `fish.message` 时，相关工具从工具列表里直接消失，而不是运行到一半报错。
- **可替换**：`dsh-fish-message` 不依赖 `fish-service`；`fish-service` 不依赖 `fish-ops`。任何一层都可以单独卸载。

## 文档索引

| 文档 | 内容 | 先看哪节 |
| --- | --- | --- |
| [`docs/DESIGN.md`](docs/DESIGN.md) | 主设计：背景与现状、架构、职责边界、两个插件的设计、实施计划、验收、风险 | 第 2、5、7、14 节 |
| [`docs/CONTRACT.md`](docs/CONTRACT.md) | 接口契约：`fish.service` 方法、工具 schema、错误码、配置 schema、宿主路由、`fish.message` 服务 | 第 1、2、3、6 节 |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | 打包、安装、接管、升级、卸载、模型管理、离线镜像、WebUI 内嵌 | 第 2、3、7、9 节 |
| [`docs/MIGRATION.md`](docs/MIGRATION.md) | 从现状迁移：禁用 `@memef1f1y/dsh-plugin-tts`、让 `dsh-fish-message` 可选依赖、接管 v2.5 | 第 2、3、4 节 |

## 现状快照（实测，不是估算）

| 项 | 实测值 |
| --- | --- |
| 服务 | `localai-service 2.5.0`，`api_version=1`，`127.0.0.1:7880`，PID 13644 |
| Python / torch | 3.13.9 / `2.11.0+cu130`，CUDA 13.0，RTX 3070 8GB，驱动 591.59 |
| 模型总占用 | `models/` 17.7 GB（TTS 8.1 GB、视觉 4.0 GB、翻译 2.4 GB、whisper 2.1 GB、ASR 0.9 GB、声纹 27 MB、Demucs 133 MB、VAD 3.8 MB） |
| 引擎 venv | 6.5 GB（`engine\.venv`，含 torch） |
| 代码包（不含 venv/模型/数据） | 3.6 MB，282 个文件 |
| 已有 WebUI | `/ui`：概览 / 模型 / 设置 / 任务 / 系统；`/admin/*` 已具备设置、模型下载、开机自启、重启、日志 |
| DSH 插件现状 | `dsh-fish-message 0.1.0` 已上线；`@memef1f1y/dsh-plugin-tts 0.6.7` 已安装，但**当前不在 `dsh.profile.bundles` 里**（即当前未激活） |

## 当前仓库有什么 / 没有什么

**有**：5 份中文文档（本 README + 4 份 `docs/`）。

**没有**：`package.json`、`lib/`、`client.js`、任何可运行代码。按任务要求，先冻结契约；P1 才建插件骨架。

## 关键取舍（先看这 6 条）

1. **服务地址只在 `fish-service`**：`fish-ops`、`fish-message`、设置页都通过它拿能力，不各自读 `7880`。
2. **`fish-ops` 条件注册**：每个 op 单独判定 `requires`，不满足就不注册；插件本身仍加载，`fish_ops_list` 能解释「为什么没有」。
3. **工具返回路径，不回传 base64**：TTS/ASR/分离/关键帧都落盘到 DSH 自己的缓存目录，工具只回路径 + 指标。
4. **安装器只回滚自己创建的文件**：模型、音色、声纹、用户 `config.json` 默认不删；只有用户明确勾选才删自己下载的模型。
5. **接管优先于重装**：7880 已有 v2.5 就直接接管（`installMode=adopted`），版本不匹配提示升级，不覆盖用户目录。
6. **WebUI 不重写**：设置页 iframe 内嵌 `/ui?embed=1`，只做隐藏侧栏/页头和高度自适应；服务没起来时显示引导，不显示白屏。

## 评审时要拍板的 5 件事

1. `dsh-fish-message` 是保持「可选使用 `fish.service`、HTTP 兜底」，还是直接强制依赖？
2. 迁移时是否自动把 `fish-message-config.json` 的 `ttsVoice`（当前 `dafeiyu`）改成服务端 `default`，还是保留原名？
3. 新安装默认目录 `%LOCALAPPDATA%\localai-service`，与现有 `E:\LocalAIService` 是「只接管、不迁移」，还是要提供迁移向导？
4. 发布包是否强制 Ed25519 签名？首发渠道是 GitHub Releases 还是内网文件服务器？
5. 长文朗读 v1 只逐段发语音，还是要求服务端新增 `/media/concat` 做单条拼接？

## 怎么评审这份设计

按这个顺序读，30 分钟能判断能不能开工：

1. `DESIGN.md` 第 2 节（现状）——确认没有编造接口/路径；
2. `DESIGN.md` 第 6 节（职责边界）——确认没有把安装、模型管理塞错层；
3. `CONTRACT.md` 第 2~4 节——确认 `fish.service`、工具、错误码够 P1 直接写；
4. `DEPLOY.md` 第 3 节——确认安装流程能落地（预检、uv、模型、自启、回滚）；
5. `MIGRATION.md` 第 2~4 节——确认禁用 TTS 插件和接管 v2.5 不会破坏现有 `fish-message`。

## 非目标

- 不重写 `localai-service` 的推理/模型管理；
- 不把 HTTP 接口改成私有协议；
- 不做云端 TTS / 在线翻译兜底；
- 不在 `fish-ops` 里保存任何服务地址或模型路径；
- 不在本仓库写实现代码（P1 开工后另起分支/仓库）。
