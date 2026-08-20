# Builds TZync-Setup.exe from source. Run from anywhere; paths are relative to this script.
# Requires: internet access, Inno Setup 6 (auto-detected or installed at
# "C:\Program Files (x86)\Inno Setup 6\ISCC.exe").

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path (Split-Path -Parent $root) "zkteco-build"
$payload = Join-Path $build "payload"

Write-Host "Build workspace: $build"
New-Item -ItemType Directory -Force -Path $build, "$payload\app" | Out-Null

# --- Node.js portable runtime ---
# Extracted full zip is kept until after npm-install (below) since we use its
# bundled npm-cli.js to install app dependencies with matching native ABI,
# then trim to just node.exe for the final runtime bundle.
$nodeVersion = "20.18.1"
$nodeZip = "$build\node-portable.zip"
$nodeFull = "$build\node-v$nodeVersion-win-x64"
if (-not (Test-Path $nodeFull)) {
    Write-Host "Downloading Node.js v$nodeVersion..."
    Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/node-v$nodeVersion-win-x64.zip" -OutFile $nodeZip
    Expand-Archive $nodeZip -DestinationPath $build -Force
}

# --- Python embeddable + pyzk ---
$pyVersion = "3.11.9"
$pyZip = "$build\python-embed.zip"
if (-not (Test-Path "$payload\runtime\python\python.exe")) {
    Write-Host "Downloading Python $pyVersion embeddable..."
    Invoke-WebRequest "https://www.python.org/ftp/python/$pyVersion/python-$pyVersion-embed-amd64.zip" -OutFile $pyZip
    New-Item -ItemType Directory -Force -Path "$payload\runtime\python" | Out-Null
    Expand-Archive $pyZip -DestinationPath "$payload\runtime\python" -Force

    (Get-Content "$payload\runtime\python\python311._pth") -replace '#import site', 'import site' |
        Set-Content "$payload\runtime\python\python311._pth"

    Invoke-WebRequest "https://bootstrap.pypa.io/get-pip.py" -OutFile "$build\get-pip.py"
    & "$payload\runtime\python\python.exe" "$build\get-pip.py" --no-warn-script-location
    & "$payload\runtime\python\python.exe" -m pip install pyzk --no-warn-script-location
}

# --- App source (always refreshed from current source) ---
Write-Host "Copying app source..."
Remove-Item "$payload\app\lib", "$payload\app\public", "$payload\app\scripts" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$root\lib" "$payload\app\lib" -Recurse
Copy-Item "$root\public" "$payload\app\public" -Recurse
Copy-Item "$root\scripts" "$payload\app\scripts" -Recurse
Copy-Item "$root\server.js", "$root\package.json", "$root\package-lock.json" "$payload\app\"

Write-Host "Installing production node_modules (via portable node+npm)..."
Push-Location "$payload\app"
& "$nodeFull\node.exe" "$nodeFull\node_modules\npm\bin\npm-cli.js" install --omit=dev
Pop-Location

if (-not (Test-Path "$payload\app\node_modules\better-sqlite3")) { throw "npm install failed" }

# Now trim the full Node download down to just what ships in the installer.
New-Item -ItemType Directory -Force -Path "$payload\runtime\node" | Out-Null
Copy-Item "$nodeFull\node.exe", "$nodeFull\LICENSE" "$payload\runtime\node\" -Force

# --- Launcher scripts + icon ---
Copy-Item "$PSScriptRoot\Start-TZync.vbs", "$PSScriptRoot\Stop-TZync.vbs" $payload
Copy-Item "$PSScriptRoot\logo.ico" $build

# --- Compile ---
$iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { throw "Inno Setup not found at $iscc. Install it from jrsoftware.org first." }

Copy-Item "$PSScriptRoot\installer.iss" $build
Push-Location $build
& $iscc installer.iss
Pop-Location

Write-Host "`nDone: $build\dist\TZync-Setup.exe"
