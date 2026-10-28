#!/usr/bin/env python3
"""Author: Jeff.Liu. Stage and sign the resident macOS helper before Tauri seals YAM.app."""
import json,os,platform,plistlib,shutil,subprocess
from pathlib import Path

HELPER = 'YAM Background.app'

def stage(native, binary, identity):
    native,binary=Path(native),Path(binary)
    if binary.is_symlink() or not binary.is_file() or not os.access(binary,os.X_OK):
        raise ValueError('Current helper source executable is missing or invalid')
    resources=native/'target/terminal-runtime'
    if not (resources/'yam-terminal.cjs').is_file():
        raise FileNotFoundError('Current terminal parser is missing')
    config=json.loads((native/'tauri.conf.json').read_text())
    destination=native/'target/background-helper'/HELPER
    if destination.is_symlink():
        raise ValueError('Helper staging directory must not be a symlink')
    if destination.exists():shutil.rmtree(destination)
    contents=destination/'Contents';(contents/'MacOS').mkdir(parents=True)
    shutil.copy2(binary,contents/'MacOS/yam-background')
    runtime=contents/'Resources/target/terminal-runtime';runtime.mkdir(parents=True)
    # Dependency notices live in the outer app; do not copy stale Node/SEA artifacts.
    shutil.copy2(resources/'yam-terminal.cjs',runtime/'yam-terminal.cjs')
    shutil.copy2(native/'icons/icon.icns',contents/'Resources/icon.icns')
    info={'CFBundleIdentifier':'com.yam.desktop.background','CFBundleExecutable':'yam-background',
          'CFBundleDisplayName':'YAM','CFBundleName':'YAM Background','CFBundlePackageType':'APPL',
          'CFBundleVersion':config['version'],'CFBundleShortVersionString':config['version'],
          'CFBundleIconFile':'icon.icns','LSUIElement':True,'NSHighResolutionCapable':True,
          'LSMinimumSystemVersion':config['bundle']['macOS']['minimumSystemVersion']}
    (contents/'Info.plist').write_bytes(plistlib.dumps(info))
    args=['codesign','--force','--options','runtime','--sign',identity]
    if identity!='-':args+=['--timestamp']
    subprocess.run([*args,str(destination)],check=True,capture_output=True,timeout=120)
    subprocess.run(['codesign','--verify','--deep','--strict',str(destination)],check=True,capture_output=True,timeout=120)
    return destination

def source_binary(native, environment):
    if environment.get('YAM_BUILD_BINARY'):
        return Path(environment['YAM_BUILD_BINARY'])
    native=Path(native)
    target=Path(environment.get('CARGO_TARGET_DIR',str(native/'target')))
    if not target.is_absolute():target=native/target
    profile='debug' if environment.get('TAURI_ENV_DEBUG')=='true' else 'release'
    candidates=[target/profile/'yam-desktop']
    triple=environment.get('TAURI_ENV_TARGET_TRIPLE')
    if triple:candidates.append(target/triple/profile/'yam-desktop')
    existing=[path for path in candidates if path.is_file() and not path.is_symlink()]
    if len(existing)!=1:
        raise ValueError('Helper build source is missing or ambiguous; use build:release or set YAM_BUILD_BINARY to the actual Cargo output')
    return existing[0]

def main():
    if os.environ.get('TAURI_ENV_PLATFORM',platform.system().lower()) not in ('darwin','macos'):return 0
    native=Path(__file__).resolve().parents[1]/'apps/desktop/src-tauri'
    binary=source_binary(native,os.environ)
    stage(native,binary,os.environ.get('APPLE_SIGNING_IDENTITY') or '-')
    return 0
if __name__=='__main__':raise SystemExit(main())
