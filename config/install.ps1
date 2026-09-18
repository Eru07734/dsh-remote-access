#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Install the dsh-remote-access plugin set into a DSH profile.

.DESCRIPTION
    Three idempotent steps, in order:

      1. Junction  C:\dsh-plugins\<package>  ->  <repo>\plugins\<package>
         so the profile patch fragments can keep referring to the original
         absolute paths while the source of truth stays inside this repo.
      2. For every package that declares `dsh.bundle.patch`, run
         `dsh plugin --profile <profile> add "file:<junction>"`.
      3. Append the patch entries from config\fragments\*.yml that are not
         already present in the profile's cordis.patch.yml, matching by entry id
         (an entry counts as present when ANY of its ids is already there).

    Nothing is changed unless -Apply is passed: the default is a dry run that
    prints exactly what it would do. With -Apply every file it rewrites is
    backed up first, and no existing directory is ever deleted.

    Bundle layers are composed once, at process start, so a restart of
    `dsh web` is required after a real install.

.EXAMPLE
    pwsh -File config\install.ps1
    pwsh -File config\install.ps1 -Apply
    pwsh -File config\install.ps1 -Apply -Profile web -SkipBundles
#>
[CmdletBinding()]
param(
    # DSH profile to install into.
    [string]$Profile = 'web',

    # Where the plugin junctions are created. This matches the convention the
    # running deployment already uses, so the patch fragments need no edit.
    [string]$PluginRoot = 'C:\dsh-plugins',

    # Actually make the changes. Without it: dry run.
    [switch]$Apply,

    # Skip step 2 (bundle packages) for deployments that only want the
    # absolute-path rows.
    [switch]$SkipBundles,

    # Re-point a junction that currently targets somewhere else. Without it, a
    # mismatched junction is reported and left alone.
    [switch]$RepointJunction
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path $PSScriptRoot -Parent
$PluginsDir = Join-Path $RepoRoot 'plugins'
$FragmentsDir = Join-Path $PSScriptRoot 'fragments'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Write-Head($text) { Write-Host ''; Write-Host "── $text" -ForegroundColor Cyan }
function Write-Plan($text) { Write-Host "   [plan] $text" }
function Write-Done($text) { Write-Host "   [done] $text" -ForegroundColor Green }
function Write-Skip($text) { Write-Host "   [skip] $text" -ForegroundColor DarkGray }
function Write-Warn2($text) { Write-Host "   [warn] $text" -ForegroundColor Yellow }

Write-Host "dsh-remote-access installer" -ForegroundColor White
Write-Host "  repo       : $RepoRoot"
Write-Host "  profile    : $Profile"
Write-Host "  pluginroot : $PluginRoot"
Write-Host "  mode       : $(if ($Apply) { 'APPLY (writes)' } else { 'DRY RUN (no writes; pass -Apply)' })"

if (-not (Test-Path $PluginsDir)) { throw "plugins directory not found: $PluginsDir" }

# ── resolve DSH home and the profile patch file ─────────────────────────────
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$PatchFile = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"
Write-Host "  dsh home   : $DshHome"
Write-Host "  patch file : $PatchFile"

# ── enumerate packages ──────────────────────────────────────────────────────
$packages = @(Get-ChildItem $PluginsDir -Directory | Where-Object {
    Test-Path (Join-Path $_.FullName 'package.json')
} | Sort-Object Name)

if (-not $packages) { throw "no packages with a package.json under $PluginsDir" }

$bundles = @()
$plain   = @()
foreach ($p in $packages) {
    $manifest = Get-Content (Join-Path $p.FullName 'package.json') -Raw | ConvertFrom-Json
    # StrictMode makes a missing property an error, and most of the plain rows
    # have no `dsh` field at all — so probe before reading.
    $isBundle = $false
    if ($manifest.PSObject.Properties.Name -contains 'dsh' -and $manifest.dsh) {
        $isBundle = [bool]($manifest.dsh.PSObject.Properties.Name -contains 'bundle' -and
                           $manifest.dsh.bundle.PSObject.Properties.Name -contains 'patch')
    }
    $info = [pscustomobject]@{
        Name    = $p.Name
        Path    = $p.FullName
        Link    = Join-Path $PluginRoot $p.Name
        Bundle  = $isBundle
    }
    if ($info.Bundle) { $bundles += $info } else { $plain += $info }
}

# ── step 1: junctions ───────────────────────────────────────────────────────
Write-Head "1/3  plugin junctions  ($($packages.Count) packages)"

# name -> 'repo' (the junction resolves into this repo) | 'elsewhere' | 'realdir'
$linkState = @{}

if (-not (Test-Path $PluginRoot)) {
    Write-Plan "create $PluginRoot"
    if ($Apply) { New-Item -ItemType Directory -Path $PluginRoot -Force | Out-Null }
}
elseif (-not (Get-Item $PluginRoot).PSIsContainer) {
    throw "$PluginRoot exists and is not a directory"
}

foreach ($pkg in $packages) {
    $link = Join-Path $PluginRoot $pkg.Name
    if (-not (Test-Path $link)) {
        Write-Plan "junction $link -> $($pkg.FullName)"
        if ($Apply) {
            New-Item -ItemType Junction -Path $link -Target $pkg.FullName | Out-Null
            Write-Done "linked $($pkg.Name)"
        }
        $linkState[$pkg.Name] = 'repo'
        continue
    }

    $item = Get-Item $link -Force
    if ($item.LinkType -eq 'Junction') {
        $target = @($item.Target)[0]
        if ($target -and ($target.TrimEnd('\') -ieq $pkg.FullName.TrimEnd('\'))) {
            Write-Skip "$($pkg.Name): junction already correct"
            $linkState[$pkg.Name] = 'repo'
        }
        elseif ($RepointJunction) {
            Write-Plan "repoint $link  ($target -> $($pkg.FullName))"
            if ($Apply) {
                # Remove the LINK only; Remove-Item on a junction does not touch
                # the directory it points at.
                Remove-Item $link -Force
                New-Item -ItemType Junction -Path $link -Target $pkg.FullName | Out-Null
                Write-Done "repointed $($pkg.Name)"
            }
            $linkState[$pkg.Name] = 'repo'
        }
        else {
            Write-Warn2 "$($pkg.Name): junction points at '$target', not at this repo — left alone (use -RepointJunction)"
            $linkState[$pkg.Name] = 'elsewhere'
        }
    }
    else {
        Write-Warn2 "$($pkg.Name): $link is a real directory, not a junction — left alone (move it aside yourself)"
        $linkState[$pkg.Name] = 'realdir'
    }
}

# Where a package should actually be installed FROM. When the junction resolves
# into this repo, use the junction so every package has exactly one address (this
# is what the patch fragments assume). Otherwise fall back to the repo path and
# say so, rather than silently leaving the profile pointed at the old copy.
function Get-InstallPath {
    param($pkg)
    if ($linkState[$pkg.Name] -eq 'repo') { return $pkg.Link }
    return $pkg.Path
}

# ── step 2: bundle packages ─────────────────────────────────────────────────
Write-Head "2/3  bundle packages  ($($bundles.Count) to add)"

if ($SkipBundles) {
    Write-Skip "-SkipBundles given; not touching profile bundles"
}
elseif (-not $bundles) {
    Write-Skip "no package declares dsh.bundle.patch"
}
else {
    $dsh = Get-Command dsh -ErrorAction SilentlyContinue
    if (-not $dsh) {
        Write-Warn2 "'dsh' is not on PATH; run these yourself after fixing PATH:"
        foreach ($b in $bundles) { Write-Host "        dsh plugin --profile $Profile add `"file:$(Get-InstallPath $b)`"" }
    }
    else {
        foreach ($b in $bundles) {
            $source = Get-InstallPath $b
            # `add` is idempotent in DSH (it rewrites the same lockfile entry),
            # and re-running it is also how a hard-linked node_modules entry gets
            # refreshed after editing the package source.
            Write-Plan "dsh plugin --profile $Profile add `"file:$source`""
            if ($Apply) {
                & dsh plugin --profile $Profile add "file:$source"
                if ($LASTEXITCODE -ne 0) { Write-Warn2 "$($b.Name): dsh plugin add exited $LASTEXITCODE" }
                else { Write-Done "bundle $($b.Name)" }
            }
        }
    }
}

# ── step 3: patch fragments ─────────────────────────────────────────────────
Write-Head "3/3  profile patch entries"

# An entry is one top-level `- ` list item plus the comment block above it.
function Split-PatchEntries {
    param([string[]]$Lines)
    $blocks = [System.Collections.Generic.List[object]]::new()
    $pending = [System.Collections.Generic.List[string]]::new()
    $current = $null
    foreach ($line in $Lines) {
        if ($line -match '^- ') {
            if ($null -ne $current) { $blocks.Add($current) }
            $current = [pscustomobject]@{ Lines = [System.Collections.Generic.List[string]]::new() }
            foreach ($c in $pending) { $current.Lines.Add($c) }
            $pending.Clear()
            $current.Lines.Add($line)
        }
        elseif ($null -ne $current) {
            $current.Lines.Add($line)
        }
        else {
            $pending.Add($line)
        }
    }
    if ($null -ne $current) { $blocks.Add($current) }
    return $blocks
}

# Matches both `- id: x` and a nested `    - id: x`, so one function serves
# top-level entries and the rows inside an `- insert:` block.
$idPattern = '(?m)^\s*-?\s*id:\s*([A-Za-z0-9_.\-]+)'

$existingIds = @()
if (Test-Path $PatchFile) {
    $existingIds = @([regex]::Matches((Get-Content $PatchFile -Raw), $idPattern) |
        ForEach-Object { $_.Groups[1].Value })
    Write-Host "   profile already declares $($existingIds.Count) row ids"
}
else {
    Write-Warn2 "patch file does not exist yet: $PatchFile"
}

$toAppend = [System.Collections.Generic.List[string]]::new()
$fragments = Get-ChildItem $FragmentsDir -Filter '*.yml' | Sort-Object Name

foreach ($frag in $fragments) {
    $blocks = Split-PatchEntries -Lines (Get-Content $frag.FullName)
    $kept = 0; $skipped = 0
    foreach ($block in $blocks) {
        $text = ($block.Lines -join "`n").TrimEnd()
        if ([string]::IsNullOrWhiteSpace($text)) { continue }
        $ids = [regex]::Matches($text, $idPattern) | ForEach-Object { $_.Groups[1].Value }
        $hit = $ids | Where-Object { $existingIds -contains $_ } | Select-Object -First 1
        if ($hit) { $skipped++; continue }
        $toAppend.Add($text)
        $kept++
    }
    Write-Host ("   {0,-34} +{1} entries, {2} already present" -f $frag.Name, $kept, $skipped)
}

if (-not $toAppend) {
    Write-Skip "nothing to append; the profile already carries every entry"
}
elseif ($Apply) {
    $header = @()

    $existing = if (Test-Path $PatchFile) { Get-Content $PatchFile -Raw } else { '' }
    $backup = "$PatchFile.bak-remote-access-$stamp"
    if (Test-Path $PatchFile) {
        Copy-Item $PatchFile $backup -Force
        Write-Done "backed up to $(Split-Path $backup -Leaf)"
    }
    else {
        $header += '# Your patch layer for this dsh profile, applied after every bundle layer:'
        $header += '# a top-level YAML array of loader patch entries.'
        $header += ''
    }

    $addition = @()
    $addition += ''
    $addition += "# ── dsh-remote-access ($stamp) ──────────────────────────────────────────────"
    foreach ($entry in $toAppend) { $addition += $entry; $addition += '' }

    $body = (@($header) + @($existing.TrimEnd()) + $addition) -join "`n"
    Set-Content -Path $PatchFile -Value $body -Encoding UTF8
    Write-Done "appended $($toAppend.Count) entries to $PatchFile"
}
else {
    Write-Plan "would append $($toAppend.Count) entries to ${PatchFile}:"
    foreach ($entry in $toAppend) {
        $first = ($entry -split "`n" | Where-Object { $_ -match $idPattern } | Select-Object -First 1)
        Write-Host "        $($first.Trim())"
    }
}

# ── wrap up ─────────────────────────────────────────────────────────────────
$foreign = $packages | Where-Object { $linkState[$_.Name] -ne 'repo' }
if ($foreign) {
    Write-Head "source of truth — read this"
    Write-Host "   These packages are NOT being served from this repo:" -ForegroundColor Yellow
    foreach ($p in $foreign) {
        $what = if ($linkState[$p.Name] -eq 'realdir') { 'a real directory' } else { 'a junction pointing elsewhere' }
        Write-Host ("     {0,-24} {1} is {2}" -f $p.Name, (Join-Path $PluginRoot $p.Name), $what)
    }
    Write-Host ""
    Write-Host "   The patch fragments mount the plain rows by absolute path, so on this"
    Write-Host "   machine the profile keeps loading those older copies, not this repo's."
    Write-Host "   To make this repo the source of truth, move the old directories aside and"
    Write-Host "   re-run with -Apply (junctions are then created), or -RepointJunction for"
    Write-Host "   the ones that are already junctions."
}

Write-Head "next"
if ($Apply) {
    Write-Host "   Restart the harness so the bundle layers recompose:"
    Write-Host "     pwsh -File $(Join-Path $RepoRoot 'tools\restart-harness.ps1')"
    Write-Host "   Then confirm the rows are live:"
    Write-Host "     dsh web --patch config\fragments\01-lan-access.patch.yml --dump-config"
}
else {
    Write-Host "   Nothing was written. Re-run with -Apply to make these changes."
}
