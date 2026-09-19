# get-dsh-token.ps1 — recover the *currently valid* DSH Web launch token.
#
# DSH mints a random launch token per `dsh web` process and never persists it; it is only
# ever printed on the startup line. So: gather every `token=` candidate we can find (log
# files first, process memory as a fallback) and let the server itself decide which one is
# live — a valid token answers `GET /?token=...` with 303, a stale one with 401.

[CmdletBinding()]
param(
    [string]$Server = '<host-tailnet-ip>:3080',
    [string[]]$SearchRoot = @(
        "$env:USERPROFILE\.dsh",
        $PSScriptRoot,
        $PWD.Path,
        $env:TEMP
    ),
    [switch]$SkipMemoryScan
)

$ErrorActionPreference = 'Stop'
$TOKEN_RE = '[?&]token=([A-Za-z0-9_\-]{43})'

function Test-DshToken {
    param([string]$Token)
    $req = [System.Net.HttpWebRequest]::Create("http://$Server/?token=$Token")
    $req.AllowAutoRedirect = $false
    $req.Timeout = 8000
    try {
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return -1
    } catch {
        return -1
    }
}

function Add-Candidates {
    param([string]$Text, [System.Collections.Generic.HashSet[string]]$Set)
    foreach ($m in [regex]::Matches($Text, $TOKEN_RE)) { [void]$Set.Add($m.Groups[1].Value) }
}

Write-Host "target server : http://$Server" -ForegroundColor Cyan

# ---- Phase 1: log files -------------------------------------------------------------
$candidates = New-Object System.Collections.Generic.HashSet[string]
$logFiles = @()
foreach ($root in $SearchRoot) {
    if (-not (Test-Path $root)) { continue }
    $logFiles += Get-ChildItem $root -Filter '*.log' -Recurse -Depth 3 -File -ErrorAction SilentlyContinue
}
$logFiles = $logFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 40
Write-Host "scanning $($logFiles.Count) log file(s)..."
foreach ($f in $logFiles) {
    try { Add-Candidates -Text (Get-Content $f.FullName -Raw -ErrorAction Stop) -Set $candidates } catch { }
}
Write-Host "  -> $($candidates.Count) candidate(s) from logs"

$live = $null
foreach ($t in $candidates) {
    $code = Test-DshToken -Token $t
    if ($code -eq 303) { $live = $t; Write-Host "  LIVE  $t" -ForegroundColor Green; break }
    elseif ($code -eq 401) { Write-Host "  stale $t" -ForegroundColor DarkGray }
    else { Write-Host "  ??    $t (status $code)" -ForegroundColor Yellow }
}

# ---- Phase 2: process memory (fallback) ---------------------------------------------
if (-not $live -and -not $SkipMemoryScan) {
    Write-Host 'no live token in logs; falling back to process-memory scan (needs admin)...' -ForegroundColor Yellow

    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshMemScan {
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(int a, bool b, int p);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, IntPtr n, out IntPtr r);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr VirtualQueryEx(IntPtr h, IntPtr a, out MEMORY_BASIC_INFORMATION m, IntPtr l);
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
        public IntPtr RegionSize; public uint State; public uint Protect; public uint Type;
    }
}
"@

    $line = (netstat -ano | Select-String '0\.0\.0\.0:3080\s' | Select-String 'LISTENING' | Select-Object -First 1)
    if (-not $line) { throw 'no process is listening on 0.0.0.0:3080' }
    $procId = [int](($line.ToString() -split '\s+') | Where-Object { $_ } | Select-Object -Last 1)
    Write-Host "  listener pid = $procId"

    $h = [DshMemScan]::OpenProcess(0x0410, $false, $procId)
    if ($h -eq [IntPtr]::Zero) { throw ('OpenProcess failed (win32 ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ') — run elevated') }

    $mbiSize = [Runtime.InteropServices.Marshal]::SizeOf([type][DshMemScan+MEMORY_BASIC_INFORMATION])
    $memCandidates = New-Object System.Collections.Generic.HashSet[string]
    $buf = New-Object byte[] (4MB)
    $addr = [IntPtr]::Zero
    $scanned = [int64]0

    while ($true) {
        $mbi = New-Object DshMemScan+MEMORY_BASIC_INFORMATION
        if ([DshMemScan]::VirtualQueryEx($h, $addr, [ref]$mbi, [IntPtr]$mbiSize) -eq [IntPtr]::Zero) { break }
        $size = [int64]$mbi.RegionSize
        if ($size -le 0) { break }
        $p = $mbi.Protect
        $readable = ($mbi.State -eq 0x1000) -and (
            ($p -band 0x02) -or ($p -band 0x04) -or ($p -band 0x08) -or
            ($p -band 0x20) -or ($p -band 0x40) -or ($p -band 0x80))
        if ($readable) {
            $off = [int64]0
            while ($off -lt $size) {
                $toRead = [int][Math]::Min([int64]$buf.Length, $size - $off)
                if ($toRead -le 0) { break }
                $read = [IntPtr]::Zero
                if ([DshMemScan]::ReadProcessMemory($h, [IntPtr]([int64]$mbi.BaseAddress + $off), $buf, [IntPtr]$toRead, [ref]$read)) {
                    $n = [int]$read
                    if ($n -gt 0) {
                        $scanned += $n
                        Add-Candidates -Text ([System.Text.Encoding]::ASCII.GetString($buf, 0, $n)) -Set $memCandidates
                        Add-Candidates -Text ([System.Text.Encoding]::Unicode.GetString($buf, 0, $n)) -Set $memCandidates
                    }
                }
                $off += $toRead
            }
        }
        $addr = [IntPtr]([int64]$mbi.BaseAddress + $size)
        if ([int64]$addr -le 0) { break }
    }
    [DshMemScan]::CloseHandle($h) | Out-Null
    Write-Host ("  scanned {0:N0} MB, {1} candidate(s)" -f ($scanned / 1MB), $memCandidates.Count)

    foreach ($t in $memCandidates) {
        if ((Test-DshToken -Token $t) -eq 303) { $live = $t; break }
    }
}

Write-Host ''
if ($live) {
    Write-Host 'LIVE TOKEN:' -ForegroundColor Green
    Write-Host $live -ForegroundColor Green
    Write-Host ''
    Write-Host "Paste this URL into the app's 连接设置:"
    Write-Host "  http://$Server/?token=$live"
} else {
    Write-Host 'No live token found. Read the `dsh web:` line from the console that started DSH.' -ForegroundColor Red
    exit 1
}
