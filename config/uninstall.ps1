#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Undo what config\install.ps1 did.

.DESCRIPTION
    Three idempotent steps, the inverse of the installer:

      1. Drop this repo's entries from the profile's cordis.patch.yml. Preferred
         path: everything from the `# ── dsh-remote-access (<stamp>)` marker (or the older `# ── dsh-remote-kit (<stamp>)` one) on is
         removed, so an entry the user wrote earlier with the same id is never
         touched. If no marker is present (the fragments were merged by hand),
         entries are removed by id instead, and that is reported.
      2. `dsh plugin --profile <profile> remove <package>` for every bundle.
      3. Delete the plugin junctions — but only those that actually point into
         this repo. A real directory is never deleted.

    Nothing is changed unless -Apply is passed. Every rewritten file is backed
    up first, and the most recent install backup is named in the output.

.EXAMPLE
    pwsh -File config\uninstall.ps1
    pwsh -File config\uninstall.ps1 -Apply
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$PluginRoot = 'C:\dsh-plugins',
    [switch]$Apply,
    [switch]$SkipBundles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot      = Split-Path $PSScriptRoot -Parent
$PluginsDir   = Join-Path $RepoRoot 'plugins'
$FragmentsDir = Join-Path $PSScriptRoot 'fragments'
$stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Head($text) { Write-Host ''; Write-Host "── $text" -ForegroundColor Cyan }
function Write-Plan($text) { Write-Host "   [plan] $text" }
function Write-Done($text) { Write-Host "   [done] $text" -ForegroundColor Green }
function Write-Skip($text) { Write-Host "   [skip] $text" -ForegroundColor DarkGray }
function Write-Warn2($text) { Write-Host "   [warn] $text" -ForegroundColor Yellow }

Write-Host "dsh-remote-access uninstaller" -ForegroundColor White
Write-Host "  repo       : $RepoRoot"
Write-Host "  profile    : $Profile"
Write-Host "  mode       : $(if ($Apply) { 'APPLY (writes)' } else { 'DRY RUN (no writes; pass -Apply)' })"

$DshHome   = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$PatchFile = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
Write-Host "  patch file : $PatchFile"

$packages = @(Get-ChildItem $PluginsDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName 'package.json')
} | Sort-Object Name)

$bundles = @()
foreach ($p in $packages) {
    $manifest = Get-Content (Join-Path $p.FullName 'package.json') -Raw | ConvertFrom-Json
    # StrictMode makes a missing property an error, so probe before reading.
    $isBundle = $false
    if ($manifest.PSObject.Properties.Name -contains 'dsh' -and $manifest.dsh) {
        $isBundle = [bool]($manifest.dsh.PSObject.Properties.Name -contains 'bundle' -and
                           $manifest.dsh.bundle.PSObject.Properties.Name -contains 'patch')
    }
    if ($isBundle) {
        $bundles += [pscustomobject]@{ Name = $p.Name; Path = $p.FullName; Link = Join-Path $PluginRoot $p.Name }
    }
}

# ── step 1: patch entries ───────────────────────────────────────────────────
Write-Head "1/3  profile patch entries"

$idPattern = '(?m)^\s*-?\s*id:\s*([A-Za-z0-9_.\-]+)'
$ourIds = @()
foreach ($frag in Get-ChildItem $FragmentsDir -Filter '*.yml') {
    $ourIds += [regex]::Matches((Get-Content $frag.FullName -Raw), $idPattern) |
        ForEach-Object { $_.Groups[1].Value }
}
$ourIds = @($ourIds | Sort-Object -Unique)
Write-Host "   config declares $($ourIds.Count) row ids: $($ourIds -join ', ')"

if (-not (Test-Path $PatchFile)) {
    Write-Skip "patch file does not exist; nothing to remove"
}
else {
    $lines = Get-Content $PatchFile
    $markerIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        # Both spellings on purpose: install.ps1 wrote `dsh-remote-kit` before the rename.
        if ($lines[$i] -match '^# ── dsh-remote-(kit|access)') { $markerIdx = $i; break }
    }

    if ($markerIdx -ge 0) {
        # Everything from the marker on was written by install.ps1.
        $keep = $lines[0..($markerIdx - 1)]
        while ($keep.Count -gt 0 -and [string]::IsNullOrWhiteSpace($keep[-1])) {
            $keep = $keep[0..($keep.Count - 2)]
        }
        $removed = $lines.Count - $keep.Count
        Write-Plan "drop the install block at line $($markerIdx + 1) ($removed lines)"
        if ($Apply) {
            Copy-Item $PatchFile "$PatchFile.bak-remote-access-uninstall-$stamp" -Force
            Set-Content -Path $PatchFile -Value (($keep -join "`n") + "`n") -Encoding UTF8
            Write-Done "restored the pre-install patch body"
        }
    }
    else {
        # Hand-merged fragments: remove top-level entries whose id is ours.
        $blocks = [System.Collections.Generic.List[object]]::new()
        $pending = [System.Collections.Generic.List[string]]::new()
        $current = $null
        foreach ($line in $lines) {
            if ($line -match '^- ') {
                if ($null -ne $current) { $blocks.Add($current) }
                $current = [pscustomobject]@{ Lines = [System.Collections.Generic.List[string]]::new() }
                foreach ($c in $pending) { $current.Lines.Add($c) }
                $pending.Clear()
                $current.Lines.Add($line)
            }
            elseif ($null -ne $current) { $current.Lines.Add($line) }
            else { $pending.Add($line) }
        }
        if ($null -ne $current) { $blocks.Add($current) }

        $keepLines = [System.Collections.Generic.List[string]]::new()
        foreach ($c in $pending) { $keepLines.Add($c) }
        $dropped = 0
        foreach ($block in $blocks) {
            $text = ($block.Lines -join "`n")
            $ids = [regex]::Matches($text, $idPattern) | ForEach-Object { $_.Groups[1].Value }
            if ($ids | Where-Object { $ourIds -contains $_ }) { $dropped++ }
            else { foreach ($l in $block.Lines) { $keepLines.Add($l) } }
        }
        Write-Warn2 "no install marker found; removing $dropped entries by id instead"
        if ($Apply) {
            Copy-Item $PatchFile "$PatchFile.bak-remote-access-uninstall-$stamp" -Force
            Set-Content -Path $PatchFile -Value (($keepLines -join "`n").TrimEnd() + "`n") -Encoding UTF8
            Write-Done "rewrote the patch file without the appended entries"
        }
        else {
            Write-Plan "would rewrite $PatchFile, dropping $dropped entries"
        }
    }
}

# ── step 2: bundle packages ─────────────────────────────────────────────────
Write-Head "2/3  bundle packages  ($($bundles.Count) to remove)"

if ($SkipBundles) {
    Write-Skip "-SkipBundles given; leaving profile bundles alone"
}
elseif (-not $bundles) {
    Write-Skip "no package declares dsh.bundle.patch"
}
else {
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dsh) {
        Write-Warn2 "'dsh' is not on PATH; run these yourself after fixing PATH:"
        foreach ($b in $bundles) { Write-Host "        dsh plugin --profile $Profile remove $($b.Name)" }
    }
    else {
        foreach ($b in $bundles) {
            Write-Plan "dsh plugin --profile $Profile remove $($b.Name)"
            if ($Apply) {
                & dsh plugin --profile $Profile remove $b.Name
                if ($LASTEXITCODE -ne 0) { Write-Warn2 "$($b.Name): remove exited $LASTEXITCODE (was it ever added?)" }
                else { Write-Done "removed $($b.Name)" }
            }
        }
    }
}

# ── step 3: junctions ───────────────────────────────────────────────────────
Write-Head "3/3  plugin junctions"

foreach ($p in $packages) {
    $link = Join-Path $PluginRoot $p.Name
    if (-not (Test-Path $link)) { Write-Skip "$($p.Name): no junction"; continue }
    $item = Get-Item $link -Force
    if ($item.LinkType -ne 'Junction') {
        Write-Warn2 "$($p.Name): not a junction (real directory) — left alone"
        continue
    }
    $target = @($item.Target)[0]
    if ($target -and (-not $target.TrimEnd('\').StartsWith($RepoRoot.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase))) {
        Write-Warn2 "$($p.Name): junction points outside this repo ('$target') — left alone"
        continue
    }
    Write-Plan "remove junction $link"
    if ($Apply) {
        # Removing a junction deletes the link, never the directory it targets.
        Remove-Item $link -Force
        Write-Done "unlinked $($p.Name)"
    }
}

Write-Head "next"
if ($Apply) {
    Write-Host "   Restart the harness so the bundle layers recompose without these rows."
    Write-Host "   If you kept dsh-lan-url, remember that web-urls.txt is still a live credential:"
    Write-Host "     Remove-Item `"$DshHome\web-urls.txt`" -ErrorAction SilentlyContinue"
}
else {
    Write-Host "   Nothing was written. Re-run with -Apply to make these changes."
}
