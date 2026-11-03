// Author: Jeff.Liu. Pi owns package cache operations; commit settings only under its shared lock.
import {openSync,closeSync,readSync,fstatSync,writeFileSync,fsyncSync,renameSync,unlinkSync,realpathSync,statSync,accessSync,constants} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const limit=2*1024*1024;
const stale=()=>Object.assign(Error('Pi packages changed'),{code:'PI_SETTINGS_CHANGED'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const namePattern=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function npmName(source){if(typeof source!=='string'||!source.startsWith('npm:'))return null;const body=source.slice(4),at=body.indexOf('@',body.startsWith('@')?1:0),name=at>0?body.slice(0,at):body;return name.length<=214&&namePattern.test(name)?name:null;}
function readSettings(file){
 let fd;try{fd=openSync(file,'r');}catch(error){if(error.code==='ENOENT')return Buffer.alloc(0);throw error;}
 try{if(!fstatSync(fd).isFile())throw Error('Invalid Pi settings');const bytes=Buffer.alloc(limit+1);let length=0,count;while(length<bytes.length&&(count=readSync(fd,bytes,length,bytes.length-length,null)))length+=count;if(length>limit)throw Error('Pi settings too large');return bytes.subarray(0,length);}finally{closeSync(fd);}
}
function parseSettings(bytes){const value=bytes.length?JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')):{};if(!value||typeof value!=='object'||Array.isArray(value)||value.packages!==undefined&&(!Array.isArray(value.packages)||value.packages.length>512))throw Error('Invalid Pi settings');return value;}
function saveSettings(file,value){
 let target=file,mode=0o600;
 try{target=realpathSync(file);mode=statSync(target).mode&0o777;accessSync(target,constants.W_OK);}catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=join(dirname(target),`.yam-pi-${randomUUID()}.tmp`);let fd;
 try{fd=openSync(temporary,'wx',mode);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,target);}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
export async function changePackages({directory,action,source,revision,createManager,lock}){
 const name=npmName(source),suffix=name?source.slice(4+name.length):'';
 if(!isAbsolute(directory)||!['install','remove'].includes(action)||!name||!(/^[a-f0-9]{64}$/).test(revision)||(action==='install'||suffix)&&(suffix[0]!=='@'||suffix.length>129||!versionPattern.test(suffix.slice(1))))throw Error('Invalid Pi package transaction');
 const file=join(directory,'settings.json'),before=readSettings(file);if(hash(before)!==revision)throw stale();const settings=parseSettings(before),references=settings.packages??[];
 if(action==='install'&&references.some(p=>npmName(typeof p==='string'?p:p.source)===name))throw Error('Pi package already configured');
 if(action==='remove'&&!references.some(p=>(typeof p==='string'?p:p.source)===source))throw Error('Pi package no longer configured');
 if(action==='install'&&references.length>=512)throw Error('Pi package limit reached');
 if(action==='remove'&&references.filter(p=>npmName(typeof p==='string'?p:p.source)===name).length!==1)throw Error('Use Pi CLI for duplicate package references');
 const manager=await createManager(settings);
 // These SDK methods prepare/remove files without persisting Pi's cached settings array.
 await manager[action](source);
 const release=await lock(file);
 try{
  const current=readSettings(file);if(hash(current)!==revision)throw stale();
  const packages=action==='install'?[...references,source]:references.filter(p=>npmName(typeof p==='string'?p:p.source)!==name);
  saveSettings(file,{...parseSettings(current),packages});
 }finally{await release();}
}
export async function main([root,directory,action,source,revision]){
 const {DefaultPackageManager,SettingsManager}=await import(pathToFileURL(join(root,'dist/index.js')).href);
 const lockfile=createRequire(join(root,'package.json'))('proper-lockfile');
 await changePackages({directory,action,source,revision,createManager:settings=>new DefaultPackageManager({cwd:directory,agentDir:directory,settingsManager:SettingsManager.inMemory(settings,{projectTrusted:false})}),lock:file=>lockfile.lock(file,{realpath:false,retries:{retries:8,minTimeout:20,maxTimeout:100}})});
}
