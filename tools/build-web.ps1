# Builds the website version of Aura into docs/ (served by GitHub Pages).
# It's the same interface as the desktop app (ui/) plus web/web.js, which stands in for the
# Rust backend in the browser.
#
#   .\tools\build-web.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot
$out = Join-Path $root "docs"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory $out | Out-Null

foreach ($f in "app.js", "style.css", "logo.png") { Copy-Item (Join-Path $root "ui\$f") $out }
foreach ($f in "web.js", "web.css", "manifest.webmanifest") { Copy-Item (Join-Path $root "web\$f") $out }

# index.html: load the web layer before app.js, and the web styles after the app's
$html = [IO.File]::ReadAllText((Join-Path $root "ui\index.html"))
$html = $html.Replace('<link rel="stylesheet" href="style.css" />', "<link rel=`"stylesheet`" href=`"style.css`" />`n  <link rel=`"stylesheet`" href=`"web.css`" />`n  <link rel=`"icon`" href=`"logo.png`" />`n  <meta name=`"description`" content=`"Aura: a Spotify client with lyrics, stats and a glassy look.`" />")
# phones: fill the whole screen (under the notch and home bar), and let iPhone/Android add
# Aura to the home screen as a full-screen app with its own icon
$html = $html.Replace('<meta name="viewport" content="width=device-width, initial-scale=1" />', @"
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <link rel="manifest" href="manifest.webmanifest" />
  <link rel="apple-touch-icon" href="logo.png" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Aura" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="theme-color" content="#0e1118" />
"@)
$html = $html.Replace('<script src="app.js"></script>', "<script src=`"web.js`"></script>`n  <script src=`"app.js`"></script>")
# cache-busting: a new ?v= on every build, so browsers don't keep using old files
$v = Get-Date -Format "yyyyMMddHHmmss"
foreach ($f in "web.js", "app.js", "style.css", "web.css") { $html = $html.Replace("`"$f`"", "`"$f`?v=$v`"") }
[IO.File]::WriteAllText((Join-Path $out "index.html"), $html, (New-Object Text.UTF8Encoding $false))
# GitHub Pages: serve files as they are
New-Item -ItemType File (Join-Path $out ".nojekyll") | Out-Null
"Website built in $out"
