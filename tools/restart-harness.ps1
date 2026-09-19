#requires -Version 7.0
<#
Restart the DSH web host in place, time every phase, and write a self-contained
report.

Why a script: the plugin modules are loaded when the host composes its profile, so
new plugin code only becomes live after a restart — and the
restart kills the very agent process that would otherwise report on it. So the
restart, its timing, and the post-restart verification all happen out of process,
and the result lands in a report file.

Phases (each timed, all written to the report):
  1. optional delay, so the caller's turn can finish streaming
  2. resolve and VERIFY the replacement launch command (before touching anything)
  3. stop the process listening on the harness port (verified to be the harness)
  4. wait for the port to be released                      -> downtime starts here
  5. start the replacement detached from the caller
  6. wait for the first HTTP answer                        -> downtime ends here
  7. verify the plugin rows compose into the new host's tree

Usage:
  pwsh -File .\restart-harness.ps1 -DryRun                 # resolve only, change nothing
  pwsh -File .\restart-harness.ps1 -DelaySeconds 20        # the real thing
#>
[CmdletBinding()]
param(
  [int]$Port = 3080,
  [string]$Workspace = 'C:\Users\<user>\Desktop\DSH Test',
  [int]$DelaySeconds = 0,
  [int]$StartupTimeoutSeconds = 90,
  [string]$LogPath = 'C:\Users\<user>\Desktop\DSH Test\_harness-restart.log',
  [string]$HostLogPath = 'C:\Users\<user>\Desktop\DSH Test\_harness-web.log',
  [string]$ReportPath = 'C:\Users\<user>\Desktop\DSH Test\_harness-restart-report.md',
  [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$startedAt = Get-Date

$phases = @()
function Add-Phase([string]$Name, [string]$Detail = '') {
  $script:phases += [pscustomobject]@{ name = $Name; at = (Get-Date); detail = $Detail }
}

function Write-Step([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
  if (-not $DryRun) { Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8 }
  Write-Output $line
}

function Format-Delta([TimeSpan]$Span) {
  if ($Span.TotalSeconds -lt 10) { return '{0:0.00} s' -f $Span.TotalSeconds }
  return '{0:0.0} s' -f $Span.TotalSeconds
}

if (-not $DryRun) { Add-Content -LiteralPath $LogPath -Value '' -Encoding utf8 }
Add-Phase 'requested' "delay ${DelaySeconds}s, port $Port"
Write-Step "restart requested (delay ${DelaySeconds}s, port $Port, dryRun $([bool]$DryRun))"

if ($DelaySeconds -gt 0 -and -not $DryRun) { Start-Sleep -Seconds $DelaySeconds }

$verdict = 'failed'
$failure = $null
$oldPid = $null
$oldCommand = $null
$newPid = $null
$status = $null
$composition = 'not checked'
$selfCheck = 'not run'
$downtime = $null
$urlLine = $null

try {
  # ── resolve and verify the launch command FIRST ─────────────────────────────
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $listener) {
    $oldPid = [int]$listener.OwningProcess
    $oldCommand = (Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid" -ErrorAction SilentlyContinue).CommandLine
    Write-Step "current listener: pid $oldPid — $oldCommand"
    if ($oldCommand -notmatch 'dsh' -or $oldCommand -notmatch 'web') {
      throw "refusing to continue: pid $oldPid is not the harness web host"
    }
  } else {
    Write-Step "no listener on port $Port; only starting a host"
  }
  Add-Phase 'resolved listener' "pid $oldPid"

  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  $entry = 'C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if ($null -ne $oldCommand) {
    if ($oldCommand -match '"([^"]*bin\.js)"') { $entry = $Matches[1] }
    if ($oldCommand -match '^"([^"]+)"') { $candidate = $Matches[1]; if ($candidate -match '[\\/]') { $node = $candidate } }
  }
  $entry = [System.IO.Path]::GetFullPath($entry)
  if ([string]::IsNullOrWhiteSpace($node) -or -not (Test-Path -LiteralPath $node)) { $node = 'node' }
  $home_ = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

  Write-Step "node    : $node"
  Write-Step "entry   : $entry"
  Write-Step "DSH_HOME: $home_"
  if (-not (Test-Path -LiteralPath $entry)) { throw "entry point not found at $entry" }
  if (-not (Test-Path -LiteralPath $home_)) { throw "DSH_HOME not found at $home_" }
  if (-not (Test-Path -LiteralPath $Workspace)) { throw "workspace not found at $Workspace" }

  $launch = 'cmd.exe /c set "DSH_HOME={0}" && cd /d "{1}" && "{2}" "{3}" web --no-open >> "{4}" 2>&1' -f $home_, $Workspace, $node, $entry, $HostLogPath
  Write-Step "launch  : $launch"
  Add-Phase 'launch verified' "node $node"

  if ($DryRun) {
    Write-Step 'dry run: nothing was stopped or started'
    $verdict = 'dry-run'
    exit 0
  }

  # ── stop the old host; downtime is measured from here ───────────────────────
  $downtimeStart = $null
  if ($null -ne $oldPid) {
    $downtimeStart = Get-Date
    Write-Step "stopping harness host pid $oldPid"
    Stop-Process -Id $oldPid -Force -ErrorAction Stop
    Add-Phase 'old host stopped' "pid $oldPid"
  }

  $releaseDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $releaseDeadline) {
    if ($null -eq (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 300
  }
  if ($null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    throw "port $Port is still occupied; refusing to start a second instance"
  }
  Write-Step 'port released'
  Add-Phase 'port released'

  # ── start the replacement, detached from the caller ─────────────────────────
  Add-Content -LiteralPath $HostLogPath -Value ("`n=== harness start {0} ===" -f (Get-Date -Format o)) -Encoding utf8
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $launch }
  if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed with return value $($created.ReturnValue)" }
  $newPid = $created.ProcessId
  Write-Step "replacement started as pid $newPid"
  Add-Phase 'replacement started' "pid $newPid"

  # ── wait for the first HTTP answer (401 without the token still proves it) ──
  $url = "http://127.0.0.1:$Port/"
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $probe = & curl.exe -s -o NUL -w '%{http_code}' --max-time 5 $url 2>$null
    if ($probe -match '^\d{3}$' -and [int]$probe -gt 0) { $status = [int]$probe; break }
  }
  if ($null -eq $status) { throw "the harness did not answer on $url within $StartupTimeoutSeconds s" }
  Add-Phase 'first HTTP answer' "HTTP $status"
  if ($null -ne $downtimeStart) { $downtime = (Get-Date) - $downtimeStart }
  # Win32_Process.Create returns the cmd.exe wrapper; report the real listener too.
  $launcherPid = $newPid
  $newListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $newListener) { $newPid = [int]$newListener.OwningProcess }
  Write-Step "harness is back on $url (HTTP $status), listener pid $newPid"
  $urlLine = (Get-Content -LiteralPath $HostLogPath -ErrorAction SilentlyContinue | Select-String 'token=' | Select-Object -Last 1).Line

  # ── verify the plugin rows compose into the new host's tree ────────────────
  try {
    $dump = & $node $entry --profile web --dump-config 2>&1 | Out-String
    # Kept next to the report: when this check fails, the composed tree is the
    # evidence, and reconstructing it afterwards costs another restart.
    Set-Content -LiteralPath (Join-Path (Split-Path $ReportPath -Parent) '_harness-restart-config.txt') -Value $dump -Encoding utf8
    $rows = @()
    foreach ($row in @('lan-owns-host', 'lan-url', 'api-attribution', 'mobile-ui')) {
      # (?m) is required: without it `$` anchors at the end of the whole dump,
      # not at the end of a line, and the check silently never matched — which
      # made three restarts in a row report a composition that was fine.
      $idSeen = $dump -match ('(?m)^\s*-?\s*id:\s*' + [regex]::Escape($row) + '\s*$')
      $rows += ('{0} {1}' -f $row, $(if ($idSeen) { 'present' } else { 'MISSING' }))
    }
    if (@($rows | Where-Object { $_ -like '*MISSING*' }).Count -gt 0) {
      # Say what the dump actually held, instead of only that a match failed.
      $firstLine = @($dump -split "`n" | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 1)
      $hint = 'the dump was empty'
      if ($firstLine.Count -gt 0) { $hint = 'the dump begins: ' + $firstLine[0].Trim() }
      $composition = "INCOMPLETE: $($rows -join ', ') — $hint"
    } else {
      $composition = 'present (' + ($rows -join ', ') + ')'
    }
  } catch {
    $composition = "check failed: $($_.Exception.Message)"
  }
  Add-Phase 'composition checked' $composition
  Write-Step "composition: $composition"

  $verdict = if ($composition -like 'present*') { 'ok' } else { 'ok-with-warnings' }
} catch {
  $failure = $_.Exception.Message
  Write-Step "FAILED: $failure"
  Add-Phase 'failed' $failure
} finally {
  # ── the report ─────────────────────────────────────────────────────────────
  $finishedAt = Get-Date
  $lines = @()
  $lines += '# DSH harness restart report'
  $lines += ''
  $lines += ('- verdict: **{0}**{1}' -f $verdict, $(if ($null -ne $failure) { " — $failure" } else { '' }))
  $lines += ('- requested: {0}' -f $startedAt.ToString('yyyy-MM-dd HH:mm:ss.fff'))
  $lines += ('- finished: {0} (total {1})' -f $finishedAt.ToString('yyyy-MM-dd HH:mm:ss.fff'), (Format-Delta ($finishedAt - $startedAt)))
  $lines += ('- old host: {0}' -f $(if ($null -ne $oldPid) { "pid $oldPid" } else { 'none' }))
  $lines += ('- new host: {0} (launcher pid {1})' -f $(if ($null -ne $newPid) { "listener pid $newPid" } else { 'not started' }), $(if ($null -ne $launcherPid) { $launcherPid } else { 'n/a' }))
  $lines += ('- first HTTP answer: {0}' -f $(if ($null -ne $status) { "HTTP $status" } else { 'none' }))
  $lines += ('- **downtime (stop -> first answer): {0}**' -f $(if ($null -ne $downtime) { Format-Delta $downtime } else { 'n/a' }))
  $lines += ('- plugin row in the new composition: {0}' -f $composition)
  if ($null -ne $urlLine) { $lines += ('- session URL: {0}' -f $urlLine.Trim()) }
  $lines += ''
  $lines += '## Timeline'
  $lines += ''
  $lines += '| phase | at | delta from request |'
  $lines += '|---|---|---|'
  foreach ($phase in $phases) {
    $lines += ('| {0} | {1} | {2} |' -f $phase.name, $phase.at.ToString('HH:mm:ss.fff'), (Format-Delta ($phase.at - $startedAt)))
    if ($phase.detail.Length -gt 0) { $lines += ('| | _{0}_ | |' -f ($phase.detail -replace '\|', '\|')) }
  }
  $lines += ''
  $lines += 'The already-open GUI tab keeps working (its cookie is bound to the persisted secret, not to the boot); refresh it if it does not reconnect on its own.'
  Set-Content -LiteralPath $ReportPath -Value ($lines -join "`n") -Encoding utf8
  Write-Step "report written to $ReportPath"
}

if ($verdict -eq 'failed') { exit 1 }
exit 0
