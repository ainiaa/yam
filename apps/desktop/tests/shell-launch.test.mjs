// Author: Jeff.Liu. Ordinary shell preferences never execute commands.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isShellLaunch,loadShellLaunch,saveShellLaunch,shellStartError} from '../src/shell-launch.ts';
test('A01b exact nullable wire shape and platform semantics',()=>{
 for(const login of [true,false])for(const program of [null,'/bin/bash','/installed shells/中文/zsh'])assert.equal(isShellLaunch({program,login},false),true);
 for(const program of [null,'C:\\Program Files\\中文\\CMD.EXE','\\\\server\\share\\cmd.exe'])assert.equal(isShellLaunch({program,login:null},true),true);
 for(const v of [null,[],{}, {program:null},{login:true},{program:null,login:true,argv:[]},{program:1,login:false},{program:null,login:1},{program:'',login:true},{program:' \t',login:true},{program:'bash',login:true},{program:'/bin/bash\0',login:true},{program:'/bin/bash\n',login:true},{program:'/bin/\u2028bash',login:true}])assert.equal(isShellLaunch(v,false),false,JSON.stringify(v));
 assert.equal(isShellLaunch({program:null,login:null},false),false);assert.equal(isShellLaunch({program:null,login:false},true),false);
 for(const program of ['cmd.exe','C:cmd.exe','\\cmd.exe','/bin/bash'])assert.equal(isShellLaunch({program,login:null},true),false);
});
test('A01b program budget counts UTF8 bytes and preserves spaces',()=>{
 const valid='/'+ '中'.repeat(1365);assert.equal(Buffer.byteLength(valid),4096);assert.equal(isShellLaunch({program:valid,login:false},false),true);assert.equal(isShellLaunch({program:valid+'x',login:false},false),false);
 const writes=[];const shell={program:'/path with spaces/中文/bash',login:false};saveShellLaunch(shell,false,raw=>writes.push(raw));assert.deepEqual(loadShellLaunch(()=>writes[0],false),{shell,error:null});
});
test('A01b absent and current default preferences preserve omission',()=>{assert.deepEqual(loadShellLaunch(()=>null,false),{shell:null,error:null});const writes=[];saveShellLaunch(null,false,raw=>writes.push(raw));assert.deepEqual(JSON.parse(writes[0]),{version:1,shell:null});assert.deepEqual(loadShellLaunch(()=>writes[0],false),{shell:null,error:null});});
test('A01b corrupt unknown and oversized preferences report errors without writes',()=>{
 for(const raw of ['oops','null','[]','{}',JSON.stringify({version:2,shell:null}),JSON.stringify({version:1,shell:null,extra:1}),JSON.stringify({version:1,shell:{program:null,login:null}}),' '.repeat(16385),JSON.stringify({version:1,shell:{program:'/'+ '中'.repeat(1366),login:true}})]){const r=loadShellLaunch(()=>raw,false);assert.equal(r.shell,null);assert.match(r.error,/Shell preferences/);}
 const r=loadShellLaunch(()=>{throw Error('denied');},false);assert.equal(r.shell,null);assert.match(r.error,/unavailable/);
});
test('A01b preference write validates before writing and propagates quota failure',()=>{let calls=0;assert.throws(()=>saveShellLaunch({program:'relative',login:false},false,()=>calls++),/Invalid shell/);assert.equal(calls,0);assert.throws(()=>saveShellLaunch(null,false,()=>{calls++;throw Error('quota');}),/quota/);assert.equal(calls,1);});
test('A01b bounded launch errors explain support and compatibility without retry',()=>{assert.match(shellStartError('shell_unsupported'),/bash.*zsh.*fish.*Current default/);assert.match(shellStartError('shell_invalid_combination'),/ordinary/);assert.match(shellStartError('shell_invalid'),/absolute/);assert.match(shellStartError('shell_unavailable'),/executable/);assert.match(shellStartError('Invalid background command arguments'),/may not support/);assert.match(shellStartError('owner unavailable'),/owner unavailable/);assert.match(shellStartError(new Error('spawn failed')),/spawn failed/);assert.ok(shellStartError('x'.repeat(2000)).length<1000);});

test('A01b unknown prototype property error names always produce bounded readable text',()=>{for(const message of ['toString','constructor','__proto__','hasOwnProperty','valueOf','isPrototypeOf'])for(const reason of [message,new Error(message)]){const result=shellStartError(reason);assert.equal(typeof result,'string',message);assert.ok(result.length<1000);assert.ok(result.includes(message));assert.match(result,/may not support/);assert.match(result,/Current default/);assert.match(result,/existing sessions keep running/);}});
