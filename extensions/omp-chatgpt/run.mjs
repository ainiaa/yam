// Author: Jeff.Liu
import {execFileSync,spawn} from 'node:child_process';
import {access,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {delimiter,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {findPiPackage,parseSystemProxy,launchEnvironment,yamAuthDirectory,createYamSubprocessCredentialReader} from './runtime.mjs';
import {launcherArgs,readRoutingPolicy} from './routing.mjs';
import {desktopLaunch} from './desktop.mjs';

async function executable(name) {
  for(const dir of (process.env.PATH??'').split(delimiter)){
    const path=join(dir,name);try{await access(path,constants.X_OK);return path;}catch{}
  }
  throw Error(`${name} executable was not found in PATH.`);
}
try {
  if(process.argv[2]==='--yam-auth-broker'){
    const proxy=parseSystemProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:5000}));
    const env=launchEnvironment(process.env,proxy);delete env.YAM_OMP_DESKTOP;
    const child=spawn(process.execPath,['--use-env-proxy',fileURLToPath(new URL('./yam-auth-helper.mjs',import.meta.url)),yamAuthDirectory(),'broker'],{env,stdio:'inherit'});
    child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
  }else{
  const desktop=desktopLaunch(process.env);
  if(desktop)process.umask(0o077);
  const {args,policyPath,routing,authSource,login}=launcherArgs(process.argv.slice(2),{defaultRouting:!desktop||!!desktop.policy,resuming:!!desktop&&!!process.env.YAM_OMP_RESUME,defaultAuth:desktop?process.env.YAM_OMP_AUTH_SOURCE??'yam':'yam'});
  const omp=process.env.YAM_OMP_DESKTOP==='1'&&process.env.YAM_OMP_EXECUTABLE?process.env.YAM_OMP_EXECUTABLE:await executable('omp');
  const proxy=parseSystemProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:5000}));
  const env=launchEnvironment(process.env,proxy,authSource==='pi'?await findPiPackage(await executable('pi')):undefined);
  env.YAM_NODE_BINARY=process.execPath;
  env.YAM_OMP_AUTH_SOURCE=authSource;
  if(authSource==='yam')env.YAM_OMP_AUTH_DIR=yamAuthDirectory();
  delete env.YAM_OMP_ROUTING_POLICY;
  if(routing){
    let raw=desktop?.policy;
    if(policyPath){
      const file=await open(policyPath,'r');
      try{const buffer=Buffer.alloc(65537),{bytesRead}=await file.read(buffer,0,buffer.length,0);raw=buffer.subarray(0,bytesRead).toString('utf8');}
      finally{await file.close();}
    }
    env.YAM_OMP_ROUTING_POLICY=JSON.stringify(readRoutingPolicy(raw));
  }
  delete env.YAM_OMP_POLICY;
  if(authSource==='yam'){
    process.umask(0o077);
    let needsLogin=login;
    if(!needsLogin)try{await createYamSubprocessCredentialReader({node:process.execPath,authDir:env.YAM_OMP_AUTH_DIR,env})();}catch(e){if(e.code!=='YAM_AUTH_REQUIRED'||!process.stdout.isTTY)throw e;needsLogin=true;}
    if(needsLogin)await new Promise((resolve,reject)=>{
      // Accepted grants must survive terminal teardown long enough to persist their rotating token.
      const helper=spawn(process.execPath,['--use-env-proxy',fileURLToPath(new URL('./yam-auth-helper.mjs',import.meta.url)),env.YAM_OMP_AUTH_DIR,'login'],{env,stdio:'inherit',detached:true});
      let cancelled=false;
      const cancel=signal=>{cancelled=true;helper.kill(signal);helper.unref();cleanup();reject(Error('YAM ChatGPT authorization was cancelled.'));};
      const interrupt=()=>cancel('SIGINT'),terminate=()=>cancel('SIGTERM');process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
      const cleanup=()=>{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);};
      helper.on('error',()=>{cleanup();reject(Error('Unable to start YAM ChatGPT authorization.'));});helper.on('exit',code=>{cleanup();code===0&&!cancelled?resolve():reject(Error('YAM ChatGPT authorization was cancelled or could not finish.'));});
    });
    if(login)process.exit(0);
  }else if(login)throw Error('Pi backup uses Pi login. Use --yam-auth yam --yam-login for YAM authorization.');
  const child=spawn(omp,[...(desktop?.args??[]),'--profile','yam-chatgpt-validation','--no-extensions','--extension',fileURLToPath(new URL('./index.mjs',import.meta.url)),...args],{env,stdio:'inherit'});
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>child.kill(sig));
  child.on('error',()=>{console.error('Unable to start the OMP validation process.');process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
  }
}catch(e){console.error(e.message);process.exitCode=1;}
