# Запускается один раз после первого `npx wrangler deploy`:
#   powershell -ExecutionPolicy Bypass -File .\setup-secrets.ps1 -WorkerUrl https://uib-hub-submit.<аккаунт>.workers.dev
# Кладёт секреты в Cloudflare и подключает кнопки и команды бота к Worker.
# Токены вводятся скрыто и уходят только в Cloudflare и Telegram.
#
# -WebhookOnly: заново подключить бота (новый секрет вебхука), не трогая токен GitHub.
#   Нужен, когда Worker начинает слушать новые типы сообщений, например команду /stats.
param(
  [Parameter(Mandatory)] [string]$WorkerUrl,
  [switch]$WebhookOnly
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 по умолчанию не включает TLS 1.2, без него запрос к Telegram не пройдёт
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location $PSScriptRoot
$WorkerUrl = $WorkerUrl.TrimEnd('/') -replace '/submit$', ''

function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Put-Secret([string]$name, [string]$value) {
  # npx.cmd, а не npx: npx.ps1 блокируется политикой выполнения скриптов Windows
  $value | npx.cmd wrangler secret put $name
  if ($LASTEXITCODE -ne 0) { throw "Не удалось сохранить $name" }
}

$botToken = Read-Secret 'Токен бота из @BotFather'
if (-not $WebhookOnly) { $githubToken = Read-Secret 'GitHub fine-grained токен' }

# Telegram принимает в secret_token только A-Z, a-z, 0-9, _ и -
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$webhookSecret = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''

Put-Secret 'TELEGRAM_BOT_TOKEN' $botToken
if (-not $WebhookOnly) { Put-Secret 'GITHUB_TOKEN' $githubToken }
Put-Secret 'TELEGRAM_WEBHOOK_SECRET' $webhookSecret

# callback_query — кнопки ✅ / ❌, message — команды вроде /stats
$body = @{ url = "$WorkerUrl/telegram"; secret_token = $webhookSecret; allowed_updates = @('callback_query', 'message') } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setWebhook" -ContentType 'application/json' -Body $body
if (-not $result.ok) { "Telegram ответил ошибкой: $($result.description)"; exit 1 }

# Подсказка «/stats» в меню команд групп
$commands = @{ commands = @(@{ command = 'stats'; description = 'Статистика UIB Hub' }); scope = @{ type = 'all_group_chats' } } | ConvertTo-Json -Depth 4
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setMyCommands" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($commands)) | Out-Null

'Готово: секреты сохранены, кнопки и команды бота подключены к Worker.'
