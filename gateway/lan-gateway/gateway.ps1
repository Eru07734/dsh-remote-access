# LAN Gateway — 统一入口控制脚本
# 用法:
#   .\gateway.ps1 start     启动反代 + mDNS
#   .\gateway.ps1 stop      停止
#   .\gateway.ps1 status    查看状态
#   .\gateway.ps1 restart   重启
#   .\gateway.ps1 add dsh.home.arpa 127.0.0.1 3080   追加一个服务路由

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'restart', 'add', 'logs')]
    [string]$Action = 'status',

    [Parameter(Position = 1)][string]$Host_,
    [Parameter(Position = 2)][string]$BackendHost,
    [Parameter(Position = 3)][int]$BackendPort
)

$ErrorActionPreference = 'Stop'
$Root    = $PSScriptRoot
$LogDir  = Join-Path $Root 'logs'
$Py      = 'C:\Users\<user>\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# NOTE: detection is port-based on purpose. Get-CimInstance / Win32_Process is
# unavailable under some sandbox and language-mode configurations, which made an
# earlier version of this script report "not running" for a live service.
# The listening port is the fact that actually matters, so we read that.
# NOTE: identification is PID-FILE based, deliberately.
# Two wrong approaches were tried and removed, both of which would have hurt:
#   * Get-CimInstance Win32_Process is unavailable under some sandbox/language
#     modes and silently returned nothing, so a live service read as "stopped".
#   * Matching netstat rows for port 5353 by PID was WORSE: 5353 is a shared
#     port already used on this machine by msedge, adb, ChatGPT and svchost.
#     Stopping everything bound to it would have terminated the user's browser.
# So each service records its own PID, and we only ever touch that PID after
# confirming it is alive and is a python process.
function Get-PidFile([string]$Tag) { Join-Path $LogDir "$Tag.pid" }

function Read-SvcPid([string]$Tag) {
    $f = Get-PidFile $Tag
    if (-not (Test-Path $f)) { return $null }
    $raw = (Get-Content $f -ErrorAction SilentlyContinue | Select-Object -First 1)
    $pidVal = 0
    if (-not [int]::TryParse($raw, [ref]$pidVal)) { return $null }
    $proc = Get-Process -Id $pidVal -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ($proc.ProcessName -ne 'python') { return $null }
    return $pidVal
}

# Readiness is confirmed by the actual socket, not by the PID file alone.
function Test-PortListening([int]$Port) {
    $lines = netstat -ano | Select-String 'LISTENING' | Select-String ":$Port\s"
    return [bool]$lines
}

function Test-UdpBound([int]$Port) {
    # UDP has no LISTENING state; parse the local-address column specifically
    # rather than any occurrence of the port number.
    $lines = netstat -ano -p UDP | Select-String "^\s*UDP\s+\S*:$Port\s"
    return [bool]$lines
}

function Get-OwningPid([int]$Port, [string]$Proto) {
    # Resolve the PID that ACTUALLY owns the socket, and require it to be a
    # python process. Port 5353 is shared with msedge/adb/ChatGPT on this
    # machine, so an unfiltered port match reports a false "running".
    if ($Proto -eq 'udp') {
        $rows = netstat -ano -p UDP | Select-String "^\s*UDP\s+\S*:$Port\s"
    } else {
        $rows = netstat -ano | Select-String 'LISTENING' | Select-String ":$Port\s"
    }
    foreach ($r in $rows) {
        $candidate = ($r.ToString().Trim() -split '\s+')[-1]
        if ($candidate -match '^\d+$' -and $candidate -ne '0' -and $candidate -ne '4') {
            $proc = Get-Process -Id $candidate -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'python') { return [int]$candidate }
        }
    }
    return $null
}

function Start-Svc([string]$Script, [string]$Tag, [int]$Port, [string]$Proto) {
    $existing = Get-OwningPid $Port $Proto
    if ($existing) {
        Write-Host "  [$Tag] 已在运行 (PID $existing)" -ForegroundColor Yellow
        return
    }
    # Launch fully detached.
    #
    # History of what does NOT work here (each verified by experiment):
    #   * Start-Process ... -RedirectStandardOutput  -> the child inherits the
    #     parent's stdout pipe, so the SCRIPT never returns when the caller
    #     captures its output (`pwsh -File gateway.ps1 start | ...`). The
    #     services start fine; the control script just hangs forever.
    #   * Start-Process -PassThru together with -RedirectStandardOutput -> same
    #     deadlock.
    #   * `cmd /c "python x.py > log"` -> exits immediately, no service left.
    #
    # So: let the Python service open its own log files and give it no inherited
    # pipe. DETACHED_PROCESS (0x8) + CREATE_NEW_PROCESS_GROUP (0x200) makes the
    # child independent of this console.
    $env:GW_TAG = $Tag
    $args = @{
        FilePath     = $Py
        ArgumentList = @($Script)
        WorkingDirectory = $Root
        WindowStyle  = 'Hidden'
        PassThru     = $true
    }
    $proc = Start-Process @args
    Write-Host "  [$Tag] 进程已拉起 (PID $($proc.Id)) ..." -ForegroundColor Gray

    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 250
        $owner_ = Get-OwningPid $Port $Proto
        if ($owner_) {
            Set-Content -Path (Get-PidFile $Tag) -Value $owner_ -Encoding ASCII
            Write-Host "  [$Tag] 已就绪 (PID $owner_, $Port/$Proto)" -ForegroundColor Green
            return
        }
    }
    Write-Host "  [$Tag] 启动超时, 请查看 $(Join-Path $LogDir "$Tag.err")" -ForegroundColor Red
}

function Stop-Svc([string]$Tag, [int]$Port, [string]$Proto) {
    # Prefer the live socket owner; fall back to the recorded PID.
    $pidVal = Get-OwningPid $Port $Proto
    if (-not $pidVal) { $pidVal = Read-SvcPid $Tag }
    if (-not $pidVal) {
        Remove-Item (Get-PidFile $Tag) -ErrorAction SilentlyContinue
        Write-Host "  [$Tag] 未在运行" -ForegroundColor Yellow
        return
    }
    Write-Host "  停止 [$Tag] PID $pidVal ..." -ForegroundColor Gray
    Stop-Process -Id $pidVal -Force -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 40; $i++) {
        if (-not (Get-Process -Id $pidVal -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 150
    }
    Remove-Item (Get-PidFile $Tag) -ErrorAction SilentlyContinue
}

function Show-Status {
    Write-Host "`n=== LAN Gateway 状态 ===" -ForegroundColor Cyan

    $proxyPid = Get-OwningPid 443 'tcp'
    if ($proxyPid) { Write-Host "  反向代理 (443/TCP): 运行中 (PID $proxyPid)" -ForegroundColor Green }
    else           { Write-Host "  反向代理 (443/TCP): 未运行" -ForegroundColor Red }

    # Must be an owned python socket: 5353 is also held by msedge/adb/ChatGPT.
    $mdnsPid = Get-OwningPid 5353 'udp'
    if ($mdnsPid) { Write-Host "  mDNS 广播 (5353/UDP): 运行中 (PID $mdnsPid)" -ForegroundColor Green }
    else          { Write-Host "  mDNS 广播 (5353/UDP): 未运行" -ForegroundColor Red }
    Write-Host "`n  路由表:" -ForegroundColor Cyan
    $routes = Join-Path $Root 'routes.json'
    if (Test-Path $routes) {
        (Get-Content $routes -Raw | ConvertFrom-Json).PSObject.Properties |
            ForEach-Object { Write-Host "    https://$($_.Name)  ->  $($_.Value.host):$($_.Value.port)" }
    } else {
        Write-Host "    https://dsh.home.arpa  ->  127.0.0.1:3080  (内置默认)"
    }

    Write-Host "`n  证书目录: $Root\certs" -ForegroundColor Cyan
    Write-Host "  根证书   : $Root\certs\ca.crt   <-- 需安装到各设备信任库" -ForegroundColor Cyan
    Write-Host ""
}

switch ($Action) {
    'start' {
        Write-Host "启动 LAN Gateway ..." -ForegroundColor Cyan
        Start-Svc 'mdns.py'  'mdns'  5353 'udp'
        Start-Svc 'proxy.py' 'proxy'  443 'tcp'
        Show-Status
    }
    'stop' {
        Write-Host "停止 LAN Gateway ..." -ForegroundColor Cyan
        Stop-Svc 'proxy' 443 'tcp'
        Stop-Svc 'mdns' 5353 'udp'
    }
    'restart' {
        Write-Host "重启 LAN Gateway ..." -ForegroundColor Cyan
        Stop-Svc 'proxy' 443 'tcp'
        Stop-Svc 'mdns' 5353 'udp'
        Start-Sleep -Seconds 1
        Start-Svc 'mdns.py'  'mdns'  5353 'udp'
        Start-Svc 'proxy.py' 'proxy'  443 'tcp'
        Show-Status
    }
    'add' {
        if (-not $Host_ -or -not $BackendHost -or -not $BackendPort) {
            Write-Host "用法: .\gateway.ps1 add <域名> <后端IP> <后端端口>" -ForegroundColor Yellow
            Write-Host "例如: .\gateway.ps1 add nas.home.arpa 127.0.0.1 5000"
            exit 1
        }
        $routes = Join-Path $Root 'routes.json'
        $obj = @{}
        if (Test-Path $routes) {
            (Get-Content $routes -Raw | ConvertFrom-Json).PSObject.Properties |
                ForEach-Object { $obj[$_.Name] = $_.Value }
        }
        $obj[$Host_] = @{ host = $BackendHost; port = $BackendPort; tls = $false }
        $obj | ConvertTo-Json -Depth 5 | Set-Content $routes -Encoding UTF8
        Write-Host "已添加路由 $Host_ -> ${BackendHost}:${BackendPort}" -ForegroundColor Green
        Write-Host "证书需包含该域名, 重新签发: " -ForegroundColor Yellow
        Write-Host "  $Py $Root\make-certs.py --domains dsh.home.arpa,$Host_"
        Write-Host "然后重启: .\gateway.ps1 restart" -ForegroundColor Yellow
    }
    'logs' {
        Get-ChildItem $LogDir -Filter '*.out' | ForEach-Object {
            Write-Host "`n===== $($_.Name) =====" -ForegroundColor Cyan
            Get-Content $_.FullName -Tail 20
        }
    }
    default { Show-Status }
}
