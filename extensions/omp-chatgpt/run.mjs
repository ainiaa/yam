// Author: Jeff.Liu
import {execFileSync,spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findPiPackage,parseSystemProxy,launchEnvironment} from './runtime.mjs';

async function executable(name) {
  for(const dir of (process.env.PATH??'').split(delimiter)){
    const path=join(dir,name);try{await access(path,constants.X_OK);return path;}catch{}
  }
  throw Error(`${name} executable was not found in PATH.`);
}
try {
  const [omp,pi]=await Promise.all([executable('omp'),executable('pi')]);
  if(execFileSync(omp,['--version'],{encoding:'utf8',timeout:10000}).trim()!=='omp/18.16.0')throw Error('This bridge requires the verified OMP 18.16.0 binary.');
  const proxy=parseSystemProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:5000}));
  const env=launchEnvironment(process.env,proxy,await findPiPackage(pi));
  env.YAM_NODE_BINARY=process.execPath;
  const args=process.argv.slice(2);
  if(args.some(a=>/^--(?:profile|api-key|extension|provider)(?:=|$)/.test(a)||a==='-e'))throw Error('This launcher owns the validation profile, extension and authentication.');
  const child=spawn(omp,['--profile','yam-chatgpt-validation','--no-extensions','--extension',fileURLToPath(new URL('./index.mjs',import.meta.url)),...args],{env,stdio:'inherit'});
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
  child.on('error',()=>{console.error('Unable to start the OMP validation process.');process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}catch(e){console.error(e.message);process.exitCode=1;}
