# Builds, signs and publishes a new Aura version to GitHub Releases.
# Installed copies of Aura find it through latest.json and offer to update.
#
#   .\tools\release.ps1 -Version 0.1.1 -Notes "What's new"
#
# Needs: the GitHub CLI logged in (gh auth login) and the updater key at
# %USERPROFILE%\.tauri\aura-updater.key (never commit or share that file).
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$Notes = "Bug fixes and improvements"
)
# Not "Stop": Windows PowerShell treats cargo's normal stderr output as errors. Each step
# checks its exit code instead.
$ErrorActionPreference = "Continue"
function Check($what) { if ($LASTEXITCODE) { throw "$what failed (exit $LASTEXITCODE)" } }
$repo = "hejmedig1235432/aura"
$root = Split-Path $PSScriptRoot
$tauri = Join-Path $root "src-tauri"
$gh = Join-Path $env:ProgramFiles "GitHub CLI\gh.exe"
$env:Path += ";$env:USERPROFILE\.cargo\bin"
$utf8 = New-Object Text.UTF8Encoding $false

# 1. version number in both places Tauri reads it
$conf = Join-Path $tauri "tauri.conf.json"
[IO.File]::WriteAllText($conf, ([IO.File]::ReadAllText($conf) -replace '"version": "[^"]+"', "`"version`": `"$Version`""), $utf8)
$cargo = Join-Path $tauri "Cargo.toml"
[IO.File]::WriteAllText($cargo, ([IO.File]::ReadAllText($cargo) -replace '(?m)^version = "[^"]+"', "version = `"$Version`""), $utf8)

# 2. signed build (separate target folder, so a running Aura doesn't block it)
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\aura-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
$env:CARGO_TARGET_DIR = Join-Path $tauri "target-installer"
$env:CI = "true"
Push-Location $tauri
try { cargo tauri build --bundles nsis 2>&1 | ForEach-Object { "$_" }; Check "build" } finally { Pop-Location }

$bundle = Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis"
$setupName = "Aura_${Version}_x64-setup.exe"
$setup = Join-Path $bundle $setupName
$sig = Get-Content "$setup.sig" -Raw

# 3. latest.json: what installed copies read to find this version
$latest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{ signature = $sig.Trim(); url = "https://github.com/$repo/releases/download/v$Version/$setupName" }
  }
}
$latestPath = Join-Path $bundle "latest.json"
[IO.File]::WriteAllText($latestPath, ($latest | ConvertTo-Json -Depth 5), $utf8)

# 4. commit, push and publish
Push-Location $root
try {
  git add -A
  git diff --cached --quiet; if ($LASTEXITCODE) { git commit -q -m "Release v$Version" }
  # GitHub sometimes answers 502 for a moment; retry these steps a few times
  foreach ($try in 1..3) { git push -q origin main 2>&1 | ForEach-Object { "$_" }; if (-not $LASTEXITCODE) { break }; Start-Sleep 5 }
  Check "git push"
  foreach ($try in 1..3) {
    & $gh release view "v$Version" --repo $repo 2>$null | Out-Null
    if (-not $LASTEXITCODE) { break } # already created by an earlier try
    & $gh release create "v$Version" $setup "$setup.sig" $latestPath --repo $repo --title "Aura $Version" --notes $Notes 2>&1 | ForEach-Object { "$_" }
    if (-not $LASTEXITCODE) { break }; Start-Sleep 5
  }
  Check "gh release create"
} finally { Pop-Location }

Copy-Item $setup (Join-Path $env:USERPROFILE "Downloads\Aura-Setup.exe") -Force
"Published Aura ${Version}: https://github.com/$repo/releases/tag/v$Version"
