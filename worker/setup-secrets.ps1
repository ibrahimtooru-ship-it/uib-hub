# Запускается один раз после первого `npx wrangler deploy`:
#   powershell -ExecutionPolicy Bypass -File .\setup-secrets.ps1 -WorkerUrl https://uib-hub-submit.<аккаунт>.workers.dev
# Кладёт секреты в Cloudflare и подключает кнопки бота к Worker.
# Токены вводятся скрыто и уходят только в Cloudflare и Telegram.
param([Parameter(Mandatory)] [string]$WorkerUrl)

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
$githubToken = Read-Secret 'GitHub fine-grained токен'

# Telegram принимает в secret_token только A-Z, a-z, 0-9, _ и -
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$webhookSecret = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''

Put-Secret 'TELEGRAM_BOT_TOKEN' $botToken
Put-Secret 'GITHUB_TOKEN' $githubToken
Put-Secret 'TELEGRAM_WEBHOOK_SECRET' $webhookSecret

$body = @{ url = "$WorkerUrl/telegram"; secret_token = $webhookSecret; allowed_updates = @('callback_query') } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$botToken/setWebhook" -ContentType 'application/json' -Body $body
if ($result.ok) { 'Готово: секреты сохранены, кнопки бота подключены к Worker.' }
else { "Telegram ответил ошибкой: $($result.description)" }
