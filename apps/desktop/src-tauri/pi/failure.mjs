// Author: Jeff.Liu. Only owned failure sites and verified protocol facts assign categories.
const codes={
 unknown:['unknown','inspect-task'],
 'not-logged-in':['auth','check-login'],
 'subscription-required':['auth','check-login'],
 'native-unavailable':['unknown','check-login'],
 'context-budget':['context','reduce-context'],
 'capability-unavailable':['capability','check-capability'],
 'tools-restricted':['capability','check-capability'],
 'platform-unsupported':['capability','check-capability'],
 cancelled:['cancelled','refresh-state'],
 'spawn-failed':['execution','check-capability'],
 'process-timeout':['execution','inspect-task'],
 'process-exit':['execution','inspect-task'],
 'output-limit':['execution','inspect-task'],
 'protocol-invalid':['execution','inspect-task'],
 'native-reported-error':['unknown','inspect-task'],
 'native-session-missing':['execution','inspect-task'],
 'native-session-mismatch':['execution','inspect-task'],
 'answer-missing':['execution','inspect-task'],
 'receipt-persistence':['execution','inspect-task'],
 'control-unavailable':['connection','refresh-state'],
 'control-result-unknown':['unknown','refresh-state'],
};
const stages=['discovery','preparation','dispatch','execution','verification','persistence','control'],dispatches=['not-started','started','unknown'],trusted=new WeakMap();
export function projectFailure(value,{stage='execution',dispatch='unknown'}={}){
 const code=typeof value?.code==='string'&&Object.hasOwn(codes,value.code)?value.code:'unknown';
 stage=stages.includes(value?.stage)?value.stage:stages.includes(stage)?stage:'execution';
 dispatch=dispatches.includes(value?.dispatch)?value.dispatch:dispatches.includes(dispatch)?dispatch:'unknown';
 const [category,action]=codes[code],nextAction=stage==='control'?'refresh-state':dispatch!=='not-started'?'inspect-task':action;
 return {category,stage,code,dispatch,nextAction};
}
export function withFailure(error,failure){
 if(!(error instanceof Error))error=Error(String(error));
 const facts=Object.freeze(projectFailure(failure));trusted.set(error,facts);error.failure=facts;return error;
}
export function nativeError(code,message,details={}){return withFailure(Error(message),{code,stage:'preparation',dispatch:'not-started',...details});}
export function failureOf(error,defaults={}){
 let failure,mayBeRunning=false;const seen=new Set();
 for(let current=error;current&&typeof current==='object'&&!seen.has(current);current=current.cause){
  seen.add(current);mayBeRunning||=current.mayBeRunning===true;failure??=trusted.get(current);
 }
 return projectFailure({...failure,...mayBeRunning?{dispatch:'unknown'}:{}},defaults);
}
