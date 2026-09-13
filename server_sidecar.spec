from pathlib import Path

project = Path(SPECPATH)
data_files = [
    (str(project / name), ".")
    for name in [
        "index.html",
        "styles.css",
        "library.js",
        "sample_bank.json",
        "app.js",
        "manifest.webmanifest",
        "icon.svg",
        "sw.js",
    ]
]

a = Analysis(
    [str(project / "server.py")],
    pathex=[str(project)],
    binaries=[],
    datas=data_files,
    hiddenimports=["baostock", "pandas", "numpy"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="K线训练服务",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
)
