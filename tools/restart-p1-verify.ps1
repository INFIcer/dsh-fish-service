# 重启 DSH 加载 dsh-fish-service 修复后的代码，并做 P1 验收
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【dsh-fish-service P1 已加载】DSH 已重启。请做 P1 验收：
1) curl 本机 /dsh-fish-service/health 与 /state（用当前 DSH 端口），确认 ok=true、pluginVersion 0.1.0、serviceVersion 2.5.0、apiVersion "1"、latencyMs 正常、lastError 为空；
2) /state 的 config.apiVersion 必须是字符串 "1"、ttsVoice 是 "dafeiyu"、cacheDir 是绝对路径（不是 [object Object]）；
3) 调用 fish_service_status 工具看返回；再调用 fish_tts 合成一句短文本（例如「服务已就绪」）确认工具链路通、返回 wav 路径且不含 base64；
4) 看 C:\Users\Administrator\.dsh\fish-service.log 最近 20 行无异常；
5) 用 [QQ] 块向主人汇报：P1 是否可用、8 个工具的简况、TTS 实测耗时、以及下一步（P2 朗读/语音输入、P3 内嵌 WebUI 与一键安装）；块外贴关键 JSON 片段。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 20 `
  -WakeAfterSeconds 50
