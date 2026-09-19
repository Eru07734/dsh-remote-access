# 开机自启安装脚本（需要管理员权限）
#
# 创建两个计划任务：登录时自动启动反代与 mDNS 广播。
# 用"登录时触发"而不是"开机时触发"，因为服务跑在你的用户会话下，
# 且不能要求你手动登录后再点一下。

$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "此脚本需要管理员权限。" -ForegroundColor Red
    Write-Host "请右键 PowerShell -> 以管理员身份运行，然后执行：" -ForegroundColor Yellow
    Write-Host "  pwsh -NoProfile -File `"$PSCommandPath`"" -ForegroundColor Yellow
    exit 1
}

$Root = Split-Path -Parent $PSCommandPath
$Ps   = (Get-Command pwsh).Source
$Task = 'DSH-LAN-Gateway'

Write-Host "注册计划任务: $Task" -ForegroundColor Cyan
Write-Host "  工作目录: $Root"

$action = New-ScheduledTaskAction `
    -Execute $Ps `
    -Argument "-NoProfile -WindowStyle Hidden -File `"$Root\gateway.ps1`" start" `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $Task `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Host "`n已安装。验证:" -ForegroundColor Green
Write-Host "  Get-ScheduledTask -TaskName '$Task' | Select TaskName, State"
Write-Host "`n立即测试运行:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$Task'"
Write-Host "`n卸载:" -ForegroundColor Cyan
Write-Host "  Unregister-ScheduledTask -TaskName '$Task' -Confirm:`$false"
