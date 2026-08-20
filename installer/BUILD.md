# Building the installer

Produces `TZync-Setup.exe` — a native Windows installer that bundles a portable
Node.js runtime and a portable Python (with `pyzk` pre-installed), so the
target machine needs nothing preinstalled.

## One-time build machine setup

1. Install [Inno Setup 6](https://jrsoftware.org/isinfo.php)
2. Download Node.js Windows x64 zip (nodejs.org) → extract → keep only `node.exe` + `LICENSE`
3. Download Python 3.11 embeddable zip (python.org) → extract → uncomment
   `import site` in `python311._pth` → run `get-pip.py` → `pip install pyzk`

## Layout expected by `installer.iss`

```
zkteco-build/
  payload/
    app/            <- copy of ../lib, ../public, ../scripts, ../server.js, package.json
                       + `npm install --omit=dev` run against the portable node.exe
    runtime/
      node/         <- node.exe + LICENSE
      python/       <- embeddable Python + pyzk installed
    Start-TZync.vbs
    Stop-TZync.vbs
  logo.ico
  installer.iss
```

## Compile

```
ISCC.exe installer.iss
```

Output: `dist/TZync-Setup.exe`

## Silent / IT deployment

```
TZync-Setup.exe /VERYSILENT /DIR="C:\TZync" /ip=192.168.1.201 /port=4370 /password=0 /devicename="Main Device" /timezone=Asia/Karachi
```
