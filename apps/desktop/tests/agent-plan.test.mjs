import assert from 'node:assert/strict';
import {test} from 'node:test';
const api=await import('../src-tauri/pi/agent-plan.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const catalog=[{id:'codex',kind:'codex',auth:'subscription',capabilities:['text','files','image_generation']},{id:'pi-small',kind:'pi',auth:'api',capabilities:['text','files']}];
const task=(id='t1',executor='codex')=>({id,executor,goal:'Write the requested article and cover',requires:['text'],dependsOn:[],resume:null});
const plan=()=>({version:1,intent:'new',billing:'configured',reason:'Native image generation required',clarification:null,tasks:[task()]});
test('agent plan exports executable validation and model prompt',()=>{assert.equal(typeof api.validatePlan,'function');assert.equal(typeof api.plannerPrompt,'function');});
test('agent plan accepts native image generation and orders dependent tasks',{skip:!api.validatePlan},()=>{
 const p=plan();p.tasks=[{...task('cover'),requires:['image_generation'],dependsOn:['article']},task('article','pi-small')];
 const valid=api.validatePlan(p,catalog);assert.deepEqual(valid.tasks.map(t=>t.id),['article','cover']);
 assert.notEqual(valid,p);assert.deepEqual(p.tasks.map(t=>t.id),['cover','article']);
});
test('agent plan refuses unavailable agents, unknown capabilities and cross-channel billing',{skip:!api.validatePlan},()=>{
 for(const change of [p=>p.tasks[0].executor='shell',p=>p.tasks[0].requires=['desktop_plugin'],p=>{p.billing='subscription';p.tasks[0].executor='pi-small';}]){
  const p=plan();change(p);assert.throws(()=>api.validatePlan(p,catalog));
 }
 assert.throws(()=>api.validatePlan(plan(),[{...catalog[0],auth:'unknown'}]),/auth|authenticated/i);
});
test('agent plan validates strict fields, limits, dependencies and clarification',{skip:!api.validatePlan},()=>{
 const changes=[p=>p.shell='echo nope',p=>p.version=2,p=>p.tasks=[],p=>p.tasks[0].goal='',p=>p.tasks[0].goal='x'.repeat(8001),p=>p.tasks[0].args=['--unsafe'],p=>p.tasks.push(task()),p=>p.tasks[0].dependsOn=['missing'],p=>p.tasks[0].dependsOn=['t1'],p=>p.tasks[0].requires=['text','text'],p=>p.tasks[0].dependsOn=['t2','t2'],p=>p.tasks=Array.from({length:9},(_,i)=>task('t'+i)),p=>p.clarification='Which document?'];
 for(const change of changes){const p=plan();change(p);assert.throws(()=>api.validatePlan(p,catalog));}
 const cycle=plan();cycle.tasks=[{...task('t1'),dependsOn:['t2']},{...task('t2'),dependsOn:['t1']}];assert.throws(()=>api.validatePlan(cycle,catalog),/cycle/i);
 const p=plan();p.tasks=[];p.clarification='Which document?';assert.equal(api.validatePlan(p,catalog).clarification,p.clarification);
});
test('agent plan only continues successful same-executor child sessions',{skip:!api.validatePlan},()=>{
 const prior=[{taskId:'old',executor:'codex',status:'completed',sessionId:'01234567-1234-1234-1234-0123456789ab'}];
 const p=plan();p.intent='continue';p.tasks[0].resume='old';assert.equal(api.validatePlan(p,catalog,prior).tasks[0].resume,'old');
 for(const records of [[],[{...prior[0],status:'running'}],[{...prior[0],executor:'pi-small'}],[{...prior[0],sessionId:null}]])assert.throws(()=>api.validatePlan(p,catalog,records),/resume/i);
 p.intent='new';assert.throws(()=>api.validatePlan(p,catalog,prior),/resume/i);
});
test('planner prompt requires semantic routing and preserves ambiguity and provider boundaries',{skip:!api.plannerPrompt},()=>{
 const text=api.plannerPrompt();for(const term of ['JSON','clarification','subscription','resume','image_generation','untrusted','continue'])assert.ok(text.includes(term),term);
});
