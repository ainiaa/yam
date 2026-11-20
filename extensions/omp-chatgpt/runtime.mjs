// Author: Jeff.Liu
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readFile,realpath} from 'node:fs/promises';
import {dirname,join,parse} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateCredential} from './provider.mjs';
import {homedir} from 'node:os';

export function createPiCredentialReader({store,oauth,refresh}) {
  return async(signal=AbortSignal.timeout(30000))=>{
    let c;
    try {
      c=await refresh(store,'openai',oauth,current=>current.expires<=Date.now()+60000,signal);
    }catch{
      if(signal.aborted)throw signal.reason;
      throw Error('Pi ChatGPT login could not be refreshed; check Pi login and system proxy.');
    }
    validateCredential(c);
    // Pi remains the only refresh-token owner, including across OMP worker processes.
    return {type:c.type,access:c.access,expires:c.expires,clientId:c.clientId,scopes:c.scopes};
  };
}

export async function findPiPackage(executable) {
  let dir=dirname(await realpath(executable));
  while(dir!==parse(dir).root){
    try {
      const p=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));
      if(p.name==='@earendil-works/pi-coding-agent')return dir;
    }catch{/* Not a package root. */}
    dir=dirname(dir);
  }
  throw Error('Cannot locate the installed Pi package.');
}

export async function loadPiCredentialReader(packageDir,authPath) {
  const incompatible=()=>Error('This bridge requires compatible Pi authentication interfaces (AuthStorage.create, refreshStoredOAuthCredential and ChatGPT OAuth).');
  try {
    const pkg=JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
    if(pkg.name!=='@earendil-works/pi-coding-agent')throw incompatible();
    const load=p=>import(pathToFileURL(join(packageDir,p)).href);
    const [{AuthStorage},{refreshStoredOAuthCredential},{openaiChatGPTOAuth}]=await Promise.all([
      load('dist/core/auth-storage.js'),
      load('node_modules/@earendil-works/pi-ai/dist/auth/resolve.js'),
      load('node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js'),
    ]);
    if(typeof AuthStorage?.create!=='function'||typeof refreshStoredOAuthCredential!=='function'
      ||typeof openaiChatGPTOAuth?.refresh!=='function'||typeof openaiChatGPTOAuth?.toAuth!=='function')throw incompatible();
    return createPiCredentialReader({store:AuthStorage.create(authPath),oauth:openaiChatGPTOAuth,refresh:refreshStoredOAuthCredential});
  }catch{throw incompatible();}
}

export function parseSystemProxy(text) {
  const field=k=>text.match(new RegExp(`^\\s*${k}\\s*:\\s*(\\S+)\\s*$`,'m'))?.[1];
  if(field('ProxyAutoConfigEnable')==='1')throw Error('PAC system proxy is not supported by this launcher.');
  const kind=field('HTTPSEnable')==='1'?'HTTPS':field('HTTPEnable')==='1'?'HTTP':undefined;
  const host=kind&&field(`${kind}Proxy`),port=Number(kind&&field(`${kind}Port`));
  if(!kind||!host||!/^[\w.-]+$/.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('An enabled HTTP(S) system proxy is required.');
  return `http://${host}:${port}`;
}

export function launchEnvironment(inherited,proxy,packageDir) {
  const env={...inherited};
  for(const key of Object.keys(env)){
    if(/(?:API_KEY|OAUTH_TOKEN|ACCESS_TOKEN)$/.test(key)||/^PI_PROXY(?:_|$)/.test(key)||/^(?:https?|all|no)_proxy$/i.test(key))delete env[key];
  }
  delete env.YAM_PI_PACKAGE_DIR;
  return {...env,PI_PROXY:proxy,HTTP_PROXY:proxy,HTTPS_PROXY:proxy,NO_PROXY:'localhost,127.0.0.1,::1',...packageDir?{YAM_PI_PACKAGE_DIR:packageDir}:{}};
}

export function yamAuthDirectory(env=process.env){return env.YAM_OMP_AUTH_DIR||join(homedir(),'Library','Application Support','com.yam.desktop','sessions','omp-auth');}
export function createYamSubprocessCredentialReader({node,authDir,env=process.env}){
 let pending;
 return ()=>{
  if(!pending)pending=promisify(execFile)(node,['--use-env-proxy',fileURLToPath(new URL('./yam-auth-helper.mjs',import.meta.url)),authDir],{env,detached:true,timeout:90000,maxBuffer:65536,encoding:'utf8'})
   .then(({stdout})=>validateCredential(JSON.parse(stdout))).catch(e=>{
    let failure;try{failure=JSON.parse(String(e.stderr).trim().split('\n').at(-1));}catch{}
    throw Object.assign(Error(failure?.code?.startsWith('YAM_')?failure.message:'YAM ChatGPT authorization unavailable; reconnect YAM or explicitly choose Pi backup.'),{code:failure?.code});
   }).finally(()=>{pending=undefined;});
  return pending;
 };
}

export function createSubprocessCredentialReader({node,packageDir,authPath}) {
  let pending;
  return ()=>{
    // Do not kill a rotating refresh on cancellation; Pi must persist its result.
    if(!pending){
      pending=promisify(execFile)(node,['--use-env-proxy',fileURLToPath(new URL('./auth.mjs',import.meta.url)),packageDir,authPath],{
        timeout:60000,maxBuffer:65536,encoding:'utf8',
      }).then(({stdout})=>validateCredential(JSON.parse(stdout))).catch(()=>{
        throw Error('Pi ChatGPT auth helper failed; check Pi login and system proxy.');
      }).finally(()=>{pending=undefined;});
    }
    return pending;
  };
}
