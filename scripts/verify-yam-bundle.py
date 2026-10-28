#!/usr/bin/env python3
"""Author: Jeff.Liu. Verify one YAM bundle without launching or modifying it."""
import argparse,hashlib,json,os,plistlib,shutil,subprocess,tempfile
from pathlib import Path


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Missing or linked bundle file: {path.name}')
    return path


def code_hash(binary):
    # Signing assigns different bundle identifiers; compare copies after removing signatures.
    with tempfile.TemporaryDirectory(prefix='yam-verify-') as directory:
        copy=Path(directory)/'binary';shutil.copy2(regular(binary),copy)
        subprocess.run(['codesign','--remove-signature',str(copy)],check=True,capture_output=True,timeout=30)
        return hashlib.sha256(copy.read_bytes()).hexdigest()


def verify(app,version):
    app=Path(app)
    if app.is_symlink() or app.name!='YAM.app' or not app.is_dir():
        raise ValueError('Expected the maintained YAM.app bundle')
    helper=app/'Contents/Helpers/YAM Background.app'
    if helper.is_symlink() or not helper.is_dir():raise ValueError('Background helper is missing or linked')
    binaries=[];parsers=[]
    for bundle,identifier,executable in [(app,'com.yam.desktop','yam-desktop'),(helper,'com.yam.desktop.background','yam-background')]:
        contents=bundle/'Contents'
        info=plistlib.loads(regular(contents/'Info.plist').read_bytes())
        if any(info.get(key)!=expected for key,expected in {'CFBundleIdentifier':identifier,'CFBundleExecutable':executable,'CFBundleVersion':version,'CFBundleShortVersionString':version}.items()):
            raise ValueError('Bundle identity or version does not match the build')
        if bundle==helper and (info.get('LSUIElement') is not True or info.get('CFBundleURLTypes')):
            raise ValueError('Helper must remain a background application without URL claims')
        binary=regular(contents/'MacOS'/executable)
        if not os.access(binary,os.X_OK):raise ValueError('Bundle executable is not executable')
        binaries.append(binary);parsers.append(regular(contents/'Resources/target/terminal-runtime/yam-terminal.cjs'))
    subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True,timeout=60)
    if code_hash(binaries[0])!=code_hash(binaries[1]):raise ValueError('Main and helper executable code differs')
    hashes=[hashlib.sha256(path.read_bytes()).hexdigest() for path in parsers]
    if hashes[0]!=hashes[1]:raise ValueError('Main and helper terminal parser differs')
    return {'identifier':'com.yam.desktop','version':version,'main_helper_code_match':True,'parser_sha256':hashes[0],'signature_verified':True}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('app',type=Path);parser.add_argument('--version',required=True)
    args=parser.parse_args();print(json.dumps(verify(args.app,args.version)))
if __name__=='__main__':main()
