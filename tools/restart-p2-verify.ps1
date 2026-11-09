# 重启 DSH 加载 dsh-fish-service 的 P2 代码，并做界面入口验收。
#
# 用法（父 agent 执行；普通会话里不要跑，会杀掉自己）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\restart-p2-verify.ps1
#
# 验收前建议先停用 dsh-speak-up（避免两个朗读入口混淆）：
#   在 profile 的 dsh.profile.bundles 里去掉对应项后再重启；本脚本不代改 profile。
$ErrorActionPreference = 'Continue'
$inner = 'C:\Users\Administrator\.dsh\_restart\dsh-restart.ps1'
if (-not (Test-Path -LiteralPath $inner)) { throw "找不到重启脚本：$inner" }

$wake = @'
【dsh-fish-service P2 已加载】DSH 已重启。请做 P2 验收（界面入口）：

1) 设置 → 本地 AI：应看到「朗读」「语音输入」两个分区；把语速改成 1.2、单次最大字数改成 1500，保存后刷新页面确认仍在。
2) 任选一条助手回复，操作行（复制按钮右侧）应只有一个喇叭按钮：点一下出现转圈→播放；再点停止；播放中点另一条消息的朗读，上一条应立刻停。
3) 长文本：让回复超过 2000 字（或把单次最大字数临时调到 200），应出现 1/2、2/2 分段；段间没有明显空白；中途停止后不再出声。
4) 内容清洗：回复里带代码块、[QQ]…[/QQ]、Markdown 链接、表格时，朗读不应念出 # / ** / [QQ] / URL；代码块默认不念；关掉「去掉代码块」后应念「代码块，共 N 行」。
5) 语音输入：点输入框右侧麦克风 → 允许麦克风 → 录 3 秒 → 停止并选择：
   转文字（插到光标处，显示耗时）、保留语音（输入框出现「（语音附件：C:\Users\…\fish-service-cache\voice\….webm）」，文件存在，且可再点「补上文字」）、取消（输入框不变）。
6) 记住上次选择：用过「保留语音」后再录一次，三选一里「保留语音」应高亮，但不会自动执行。
7) 自动朗读：默认关；打开后发一条新消息，最终回复应自动朗读；不读工具调用/思考/代码块。
8) 服务未启动：停掉 localai 后点朗读 / 转文字，应显示中文引导，不白屏、不报 JS 异常。
9) 无重复入口：浏览器 Network 无 /dsh-tts-api/*；页面上只有一个朗读控件。
10) 看 C:\Users\Administrator\.dsh\fish-service.log 最近 20 行无异常。

命令行自检（把端口换成当前 DSH 端口，默认 5657）：
  curl.exe -s "http://127.0.0.1:5657/dsh-fish-service/state"
  curl.exe -s -X POST "http://127.0.0.1:5657/dsh-fish-service/read" -H "content-type: application/json" -d "{\"text\":\"你好，这是朗读测试。\"}"
  # 期望 ok=true、chunks>=1、wavPath 存在；再用 /audio?path=… 能播放。

用 [QQ] 块向主人汇报：P2 是否可用、朗读/语音输入实测结果、发现的问题；块外贴关键 JSON 片段。
'@

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inner `
  -SessionId 'session-a3e56af2-2285-44e6-b32d-863efb9e7d8b' `
  -WakeText $wake `
  -DelaySeconds 20 `
  -WakeAfterSeconds 50
