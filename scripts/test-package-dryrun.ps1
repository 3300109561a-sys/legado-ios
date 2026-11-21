# Local dry-run of the CI packaging + verification logic, in PowerShell.
#
# Git Bash cannot run under this sandbox (it needs to create signal pipes), so
# this mirrors the workflow's shell steps with the same operations: build a
# fake .app with xcodebuild's bundle layout, zip it as Payload/<app>.ipa, unzip
# it back, and assert the result. It validates the *artifact shape* the CI
# script is responsible for, and the same script is executed for real on macOS.

param(
    [string]$Fixture = "D:\Documents\deepseek-harness\default-workspace\legado-ios\ios\LegadoMobile"
)

$ErrorActionPreference = 'Stop'
$fail = 0
function Ok($m)  { Write-Output "PASS  $m" }
function Bad($m) { Write-Output "FAIL  $m"; $script:fail++ }

$work = Join-Path $env:TEMP ("legado-pkg-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$appDir = Join-Path $work 'build/Build/Products/Release-iphoneos/LegadoMobile.app'
New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'WebApp') | Out-Null

# ---- fake .app with the same layout xcodebuild produces ----
Set-Content -Path (Join-Path $appDir 'LegadoMobile') -Value "#!/bin/sh`nexit 0" -NoNewline
Copy-Item (Join-Path $Fixture 'Info.plist') (Join-Path $appDir 'Info.plist')
Copy-Item (Join-Path $Fixture 'WebApp/index.html') (Join-Path $appDir 'WebApp/index.html')
Copy-Item (Join-Path $Fixture 'WebApp/js/app.js') (Join-Path $appDir 'WebApp/app.js')
New-Item -ItemType Directory -Force -Path (Join-Path $appDir 'WebApp/js') | Out-Null
Copy-Item (Join-Path $Fixture 'WebApp/js/app.js') (Join-Path $appDir 'WebApp/js/app.js')

if (Test-Path $appDir) { Ok 'fixture .app exists' } else { Bad 'fixture .app missing' }

# ---- package exactly like the workflow ----
$out = Join-Path $work 'out'
$payload = Join-Path $out 'Payload'
New-Item -ItemType Directory -Force -Path $payload | Out-Null
Copy-Item $appDir (Join-Path $payload 'LegadoMobile.app') -Recurse

Add-Type -AssemblyName System.IO.Compression.FileSystem
# write the archive outside the folder being zipped
$ipa = Join-Path $work 'LegadoMobile-unsigned.ipa'
if (Test-Path $ipa) { Remove-Item $ipa -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($out, $ipa, [System.IO.Compression.CompressionLevel]::Optimal, $false)
if (Test-Path $ipa) { Ok 'ipa created' } else { Bad 'ipa not created' }

# ---- inspect the archive ----
$zip = [System.IO.Compression.ZipFile]::OpenRead($ipa)
# .NET writes path separators as '\' on Windows while the `zip` tool used in CI
# writes '/', so normalise before matching.
$names = $zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }
$zip.Dispose()

if ($names -contains 'Payload/LegadoMobile.app/Info.plist') {
    Ok 'ipa contains Payload/LegadoMobile.app/Info.plist'
} else { Bad ("ipa layout wrong: " + ($names -join ', ')) }

if ($names -contains 'Payload/LegadoMobile.app/WebApp/index.html') {
    Ok 'WebApp/index.html is inside the app bundle'
} else { Bad 'WebApp shell lost during packaging' }

if ($names -contains 'Payload/LegadoMobile.app/WebApp/js/app.js') {
    Ok 'WebApp js asset bundled with directory structure'
} else { Bad 'WebApp asset structure lost' }

if ($names -contains 'Payload/LegadoMobile.app/LegadoMobile') {
    Ok 'main binary present at bundle root'
} else { Bad 'main binary missing' }

# ---- Info.plist facts the workflow asserts ----
$plistText = Get-Content (Join-Path $appDir 'Info.plist') -Raw
if ($plistText -match '<key>MinimumOSVersion</key>\s*<string>16\.0</string>') {
    Ok 'Info.plist MinimumOSVersion=16.0 (iPad 6 / iOS 16.3.1)'
} else { Bad 'MinimumOSVersion wrong or missing' }

if ($plistText -match '<key>UIDeviceFamily</key>\s*<array>\s*<integer>1</integer>\s*<integer>2</integer>') {
    Ok 'UIDeviceFamily includes iPad'
} else { Bad 'UIDeviceFamily missing iPad' }

# ---- the asset catalog must carry a colour named in Info.plist ----
$launchColor = Join-Path $Fixture 'Assets.xcassets/LaunchBackground.colorset/Contents.json'
if (Test-Path $launchColor) {
    Ok 'LaunchBackground colorset exists (matches UILaunchScreen)'
} else { Bad 'LaunchBackground colorset missing - launch screen would fail' }

if ($plistText -match '<key>UIColorName</key>\s*<string>LaunchBackground</string>') {
    Ok 'UILaunchScreen references LaunchBackground'
} else { Bad 'UILaunchScreen colour name mismatch' }

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Output ""
if ($fail -eq 0) {
    Write-Output "package dry-run: ALL PASSED"
    exit 0
} else {
    Write-Output "package dry-run: $fail FAILED"
    exit 1
}
