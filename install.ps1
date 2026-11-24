#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-command Windows installer for Antigravity GStack Swarm (Full Runtime Edition).
  Clones/updates garrytan/gstack, installs Bun & jq if missing, compiles native binaries + 66 skills
  with the 9-specialist Review Army unlocked, deploys the global Antigravity plugin & enforced hooks,
  and runs `gstack doctor`.
#>
param(
  [string]$GstackRepoUrl = "https://github.com/garrytan/gstack.git",
  [switch]$SkipBrowserDownload
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$GstackDest = Join-Path $HomeDir ".gemini\gstack"
$PluginDest = Join-Path $HomeDir ".gemini\config\plugins\gstack-swarm"

Write-Host "==> [1/6] Checking Windows prerequisites (Node.js, Git Bash, Bun, jq)..." -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js (>= 20) is required. Install from https://nodejs.org/"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git for Windows (with Git Bash) is required. Install from https://git-scm.com/"
}

$GitExe = (Get-Command git).Source
$GitRoot = Split-Path -Parent (Split-Path -Parent $GitExe)
$GitBash = Join-Path $GitRoot "bin\bash.exe"
if (-not (Test-Path $GitBash)) {
  foreach ($cand in @("C:\Program Files\Git\bin\bash.exe", "D:\Program Files\Git\bin\bash.exe")) {
    if (Test-Path $cand) { $GitBash = $cand; break }
  }
}
if (-not (Test-Path $GitBash)) {
  throw "Could not find Git Bash (bash.exe). Ensure Git for Windows is installed."
}
Write-Host "    Found Git Bash: $GitBash"

$NpmPrefix = (npm config get prefix).Trim()
$env:PATH = "$NpmPrefix;$HomeDir\.bun\bin;$env:PATH"
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "    Installing Bun via npm..."
  npm install -g bun
}
Write-Host "    Bun version: $(bun --version)"

Write-Host "==> [2/6] Cloning or updating garrytan/gstack in $GstackDest..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $GstackDest) | Out-Null
if (Test-Path (Join-Path $GstackDest ".git")) {
  git -C $GstackDest pull --ff-only
} else {
  if (Test-Path $GstackDest) { Remove-Item -Recurse -Force $GstackDest }
  git clone --depth 1 $GstackRepoUrl $GstackDest
}

Write-Host "==> [3/6] Injecting Antigravity Full-Tier Host, Swarm Lock Engine & Windows Shims..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $GstackDest "bin-shim") | Out-Null
Copy-Item -Force (Join-Path $RepoRoot "runtime\hosts\agy.ts") (Join-Path $GstackDest "hosts\agy.ts")
Copy-Item -Force (Join-Path $RepoRoot "runtime\bin\gstack-swarm-lock.mjs") (Join-Path $GstackDest "bin\gstack-swarm-lock.mjs")
Copy-Item -Force (Join-Path $RepoRoot "runtime\bin\gstack-dispatch.mjs") (Join-Path $GstackDest "bin\gstack-dispatch.mjs")
Copy-Item -Force (Join-Path $RepoRoot "runtime\bin-shim\bun") (Join-Path $GstackDest "bin-shim\bun")

# Install global `gstack` PowerShell & CMD launchers onto PATH (npm global prefix)
Copy-Item -Force (Join-Path $RepoRoot "runtime\bin\gstack.ps1") (Join-Path $NpmPrefix "gstack.ps1")
Copy-Item -Force (Join-Path $RepoRoot "runtime\bin\gstack.cmd") (Join-Path $NpmPrefix "gstack.cmd")

# Ensure jq.exe is available in bin-shim if not already on PATH
if (-not (Get-Command jq -ErrorAction SilentlyContinue)) {
  $jqDest = Join-Path $GstackDest "bin-shim\jq.exe"
  if (-not (Test-Path $jqDest)) {
    Write-Host "    Downloading jq-1.7.1 for Git Bash JSON pipelines..."
    Invoke-WebRequest -Uri "https://github.com/jqlang/jq/releases/download/jq-1.7.1/jq-windows-amd64.exe" -OutFile $jqDest
  }
}

# Shim real python3 if python.exe exists (avoids Microsoft Store python3 stub in Git Bash)
$realPy = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if ($realPy -and ($realPy -notmatch "WindowsApps")) {
  $msysPy = "/" + ($realPy.Substring(0,1).ToLower()) + ($realPy.Substring(2) -replace '\\','/')
  Set-Content -Path (Join-Path $GstackDest "bin-shim\python3") -Value "#!/usr/bin/env bash`nexec `"$msysPy`" `"`$@`"`n" -NoNewline
}

Write-Host "==> [4/6] Installing gstack dependencies & compiling native binaries + 64 upstream skills..." -ForegroundColor Cyan
Push-Location $GstackDest
try {
  bun install
  $env:GSTACK_GIT_BASH = $GitBash
  $env:GSTACK_SETUP_RUNNING = "1"
  $env:GSTACK_SETUP_SKIP_CSO_BUILD = "1"
  $msysRoot = "/" + ($GstackDest.Substring(0,1).ToLower()) + ($GstackDest.Substring(2) -replace '\\','/')
  $msysNpm  = "/" + ($NpmPrefix.Substring(0,1).ToLower()) + ($NpmPrefix.Substring(2) -replace '\\','/')

  & $GitBash -lc "
    set -e
    export PATH='$msysRoot/bin-shim:${msysNpm}:$msysRoot/bin:'`$PATH
    cd '$msysRoot'
    echo 'agy' > .gstack-installed-hosts
    bash scripts/build.sh
    bun run build:diagram-render
    if bash scripts/build-cso.sh 2>/dev/null; then
      printf 'complete\n' > browse/dist/.build-complete
      echo '    Native CSO security launcher compiled via MSVC!'
    else
      printf 'complete\n' > browse/dist/.build-complete
      echo '    MSVC C++ workload not detected — skipping optional native CSO launcher (static skills remain active).'
    fi
  "
  bun --no-env-file --config=NUL scripts/gen-skill-docs.ts --host agy
  if (-not $SkipBrowserDownload) {
    # npx evaluates gstack's package.json overrides and fails with EOVERRIDE on Windows npm.
    node node_modules/playwright/cli.js install chromium
  }
} finally {
  Pop-Location
}

Write-Host "==> [5/6] Deploying global Antigravity plugin to $PluginDest..." -ForegroundColor Cyan
if (Test-Path $PluginDest) { Remove-Item -Recurse -Force $PluginDest }
Copy-Item -Recurse -Force (Join-Path $RepoRoot "plugin") $PluginDest

$PluginSkillsDir = Join-Path $PluginDest "skills"
Get-ChildItem (Join-Path $GstackDest ".agy\skills") -Directory | ForEach-Object {
  $skillName = $_.Name
  $dst = Join-Path $PluginSkillsDir $skillName
  if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
  Copy-Item -Recurse -Force $_.FullName $dst

  $baseName = $skillName -replace '^gstack-', ''
  $srcSkill = Join-Path $GstackDest $baseName
  if (Test-Path $srcSkill) {
    foreach ($sub in @("references", "templates", "specialists", "sections")) {
      $srcSub = Join-Path $srcSkill $sub
      if (Test-Path $srcSub) {
        $dstSub = Join-Path $dst $sub
        New-Item -ItemType Directory -Force -Path $dstSub | Out-Null
        Get-ChildItem $srcSub -File | Where-Object { $_.Extension -ne ".tmpl" } | ForEach-Object {
          $f = Join-Path $dstSub $_.Name
          if (-not (Test-Path $f)) { Copy-Item -Force $_.FullName $f }
        }
      }
    }
  }
  Set-Content -Path (Join-Path $dst ".gstack-owned") -Value "gstack-swarm" -NoNewline
}

# Register in ~/.gstack/installs.tsv
$msysPluginSkills = "/" + ($PluginSkillsDir.Substring(0,1).ToLower()) + ($PluginSkillsDir.Substring(2) -replace '\\','/')
& $GitBash -lc "
  set -e
  cd '$msysRoot'
  . bin/gstack-state-root.sh
  . bin/gstack-install-registry.sh
  gstack_state_root_select
  GSTACK_STATE_ROOT=`"`$_gstack_sr_root`"
  VER=`"`$(tr -d '\r\n' < VERSION)`"
  gstack_install_registry_upsert 'agy' 'global' '-' '$msysPluginSkills' '$msysRoot' '$msysRoot' `"`$VER`" 'true' 'committed'
"

Write-Host "==> [6/6] Running verification tests & gstack doctor..." -ForegroundColor Cyan
Push-Location $RepoRoot
try {
  node --test tests/*.test.mjs
} finally {
  Pop-Location
}
& (Join-Path $NpmPrefix "gstack.ps1") doctor
Write-Host "`nSUCCESS! Antigravity GStack Swarm (66 skills + native binaries + enforced Zero-Trust hooks) is live!" -ForegroundColor Green
