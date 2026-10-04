import ts from 'typescript';
import {readFileSync} from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationQueue, inferAgentPhase, notificationFailure, discardAttentionRetries, terminalStatuses } from '../src/notifications.ts';
test('failed delivery remains retryable; successful delivery deduplicates', async () => {
 const q = new NotificationQueue(); let calls = 0;
 const send = async () => { if (++calls === 1) throw Error('denied'); };
 await assert.rejects(q.deliver('a', send));
 await q.deliver('a', send); await q.deliver('a', send);
 assert.equal(calls, 2);
});
test('concurrent delivery cannot send twice and foreground suppression acknowledges', async () => {
 const q = new NotificationQueue(); let finish; let calls = 0;
 const first = q.deliver('a', () => { calls++; return new Promise(resolve => { finish = resolve; }); });
 await q.deliver('a', async () => { calls++; }); finish(); await first;
 q.suppress('b'); await q.deliver('b', async () => { calls++; }); assert.equal(calls, 1);
});
test('latest prompt takes precedence over stale working text', () => {
 assert.equal(inferAgentPhase('Working (esc to interrupt)\nAsk Codex anything\n› '), 'waiting');
 assert.equal(inferAgentPhase('› \nWorking (esc to interrupt)'), 'working');
 assert.equal(inferAgentPhase('plain output'), 'idle');
});

test('permanent notification failures pause until explicit retry, without clearing delivery receipts', async () => {
 const q = new NotificationQueue();
 q.recordFailure('permission', 'macOS notification permission was denied', 0);
 q.recordFailure('unsupported', 'This desktop cannot provide notifications that reopen YAM after exit.', 0);
 assert.equal(q.canRetry('permission', 999999999), false);
 assert.equal(q.canRetry('unsupported', 999999999), false);
 q.resetRetries();
 assert.equal(q.canRetry('permission', 0), true);
 let sends = 0;
 await q.deliver('sent', async () => { sends++; });
 q.recordFailure('sent', 'Failed to save history', 0);
 assert.equal(q.canRetry('sent', 14999), false);
 q.resetRetries();
 await q.deliver('sent', async () => { sends++; });
 assert.equal(sends, 1);
});
test('transient retry backs off at boundaries and caps at five minutes', () => {
 const q = new NotificationQueue();
 assert.equal(q.canRetry('a', 0), true);
 q.recordFailure('a', 'Notification bus connection failed', 100);
 assert.equal(q.canRetry('a', 15099), false);
 assert.equal(q.canRetry('a', 15100), true);
 q.recordFailure('a', 'Notification bus connection failed', 15100);
 assert.equal(q.canRetry('a', 45099), false);
 assert.equal(q.canRetry('a', 45100), true);
 for (let i = 0; i < 20; i++) q.recordFailure('a', 'temporary failure', 0);
 assert.equal(q.canRetry('a', 299999), false);
 assert.equal(q.canRetry('a', 300000), true);
 q.clearFailure('a');
 assert.equal(q.canRetry('a', 0), true);
});
test('notification failures give actionable permission, compatibility and transient messages', () => {
 for (const reason of ['macOS notification permission was denied', 'Windows notifications are disabled (DisabledForUser)']) {
  const failure = notificationFailure(reason);
  assert.equal(failure.kind, 'permission');
  assert.match(failure.message, /system settings/i);
 }
 const failure = notificationFailure('This desktop cannot provide notifications that reopen YAM after exit.');
 assert.equal(failure.kind, 'unsupported');
 assert.match(failure.message, /GNOME|portal/);
 assert.equal(notificationFailure(new Error('Notification delivery timed out')).kind, 'transient');
 assert.equal(notificationFailure(null).kind, 'transient');
 assert.equal(notificationFailure('Invalid notification session ID').kind, 'invalid');
 assert.equal(notificationFailure('Register notification protocol: access denied').kind, 'permission');
 assert.match(notificationFailure('Register notification protocol: Access is denied. (0x80070005)').message, /permissions|installation/i);
 assert.equal(notificationFailure('Linux notification delivery failed. Portal: Timeout was reached; GNOME: Timeout was reached').kind, 'transient');
 assert.equal(notificationFailure('macOS notifications require the installed YAM.app bundle').kind, 'unsupported');
});

test('terminal notification supersedes an older waiting retry for the same session only', () => {
 const pending = new Map([
  ['s-one:idle_attention',{session_id:'s-one',status:'idle_attention'}],
  ['s-two:idle_attention',{session_id:'s-two',status:'idle_attention'}],
  ['s-one:succeeded',{session_id:'s-one',status:'succeeded'}],
 ]);
 assert.deepEqual(discardAttentionRetries(pending,'s-one'),['s-one:idle_attention']);
 assert.equal(pending.size,2);
 assert.ok(pending.has('s-two:idle_attention'));
 assert.ok(pending.has('s-one:succeeded'));
 assert.deepEqual(discardAttentionRetries(pending,'missing'),[]);
 assert.equal(terminalStatuses.has('succeeded'),true);
 assert.equal(terminalStatuses.has('running'),false);
});

// Execute the actual App coordinator with mocked IPC; rendering the terminal is unnecessary.
const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let coordinator,focusPredicate;
function findCoordinator(node) {
 if(ts.isFunctionDeclaration(node)&&node.name?.text==='terminalHasInputFocus')focusPredicate=node.getText(appSource);
 if (ts.isFunctionDeclaration(node) && node.name?.text === 'notifySession') coordinator = node.getText(appSource);
 ts.forEachChild(node, findCoordinator);
}
findCoordinator(appSource);
assert.ok(coordinator, 'App notification coordinator must exist');
const coordinatorJs = ts.transpileModule(focusPredicate+"\n"+coordinator, {compilerOptions:{target:ts.ScriptTarget.ESNext}}).outputText;
function notificationHarness(options = {}) {
 const q = new NotificationQueue();
 const pending = new Map();
 const sends = []; const receipts = []; const errors = [];
 const invoke = async (command,args) => {
  if (command === 'get_session' && options.listSessions) return (await options.listSessions())[0];
  if (command === 'get_session') return {summary:{session_id:'s-one',cwd:'/repo'},status:options.status ?? 'succeeded'};
  if (command === 'notify_session') {
   sends.push(args);
   if (options.sendGate) await options.sendGate;
   if (options.sendError) throw options.sendError;
  }
  if (command === 'acknowledge_notification') {
   receipts.push(args);
   if (options.receiptError) throw options.receiptError;
  }
 };
 const paused={current:options.paused??false};
 const factory = new Function('invoke','notifications','retryNotifications','document','sessionId','titlesRef','projectName','statusLabels','terminalStatuses','setNotificationError','discardAttentionRetries','pausedRef','terminalLayoutRef','terminalViews', `${coordinatorJs}; return notifySession;`);
 const notify = factory(invoke,{current:q},{current:pending},{hasFocus:()=>false},{current:null},{current:{}},()=> 'repo',{},terminalStatuses,error=>errors.push(error),discardAttentionRetries,paused,{current:{panes:[null],focused:0}},{current:new Map()});
 if(options.pauseRef)options.pauseRef.current=paused;
 return {notify,q,pending,sends,receipts,errors};
}
const notificationEvent = status => ({session_id:'s-one',status,exit_code:null,reason:null});
test('pausing preserves required notifications, excludes unrelated statuses and resumes pending delivery',async()=>{
 const ref={current:null};const h=notificationHarness({paused:true,pauseRef:ref});
 await h.notify(notificationEvent('running'));assert.equal(h.pending.size,0);
 await h.notify(notificationEvent('succeeded'));assert.equal(h.sends.length,0);assert.equal(h.receipts.length,0);assert.equal(h.pending.size,1);
 ref.current.current=false;await h.notify(notificationEvent('succeeded'));assert.equal(h.sends.length,1);assert.equal(h.pending.size,0);
});
test('pausing while session metadata loads defers delivery without consuming its receipt',async()=>{
 let release;const ref={current:null};
 const options={pauseRef:ref,listSessions:()=>new Promise(resolve=>release=resolve)};
 const h=notificationHarness(options);
 const sending=h.notify(notificationEvent('succeeded'));
 ref.current.current=true;
 release([{summary:{session_id:'s-one',cwd:'/repo'},status:'succeeded'}]);
 await sending;
 assert.equal(h.sends.length,0);assert.equal(h.receipts.length,0);assert.equal(h.pending.size,1);
 options.listSessions=null;ref.current.current=false;
 await h.notify(notificationEvent('succeeded'));
 assert.equal(h.sends.length,1);assert.equal(h.receipts.length,1);assert.equal(h.pending.size,0);
});
test('repeated stale attention never acknowledges an undelivered terminal notification', async () => {
 const h = notificationHarness({status:'succeeded'});
 await h.notify(notificationEvent('idle_attention'));
 await h.notify(notificationEvent('idle_attention'));
 assert.equal(h.sends.length,0);
 assert.equal(h.receipts.length,0);
});
test('coordinator pauses permission retries and retries only receipt after successful delivery', async () => {
 const options = {sendError:'Windows notifications are disabled (DisabledForUser)'};
 const h = notificationHarness(options);
 await h.notify(notificationEvent('succeeded'));
 await h.notify(notificationEvent('succeeded'));
 assert.equal(h.sends.length,1);
 assert.equal(h.receipts.length,0);
 h.q.resetRetries(); options.sendError=null; options.receiptError='disk unavailable';
 await h.notify(notificationEvent('succeeded'));
 assert.equal(h.sends.length,2);
 h.q.resetRetries(); options.receiptError=null;
 await h.notify(notificationEvent('succeeded'));
 assert.equal(h.sends.length,2);
 assert.equal(h.receipts.length,2);
 assert.equal(h.receipts[0].expectedStatus,'succeeded');
 assert.equal(h.pending.size,0);
});
test('different statuses of one session cannot send concurrently', async () => {
 const q = new NotificationQueue(); let finish; let sends=0;
 const first = q.deliver('s-one:idle_attention',()=>{sends++;return new Promise(resolve=>{finish=resolve;});},'s-one');
 assert.equal(await q.deliver('s-one:succeeded',async()=>{sends++;},'s-one'),false);
 finish(); await first;
 assert.equal(await q.deliver('s-one:succeeded',async()=>{sends++;},'s-one'),true);
 assert.equal(sends,2);
});
test('completion during attention delivery preserves final pending receipt and supersedes old retry', async () => {
 let finish;
 const options = {status:'running',sendGate:new Promise(resolve=>{finish=resolve;})};
 const h=notificationHarness(options);
 const old=h.notify(notificationEvent('idle_attention'));
 await new Promise(setImmediate);
 options.status='succeeded';
 const current=h.notify(notificationEvent('succeeded'));
 await new Promise(setImmediate);
 const concurrentSends=h.sends.length;
 finish(); options.sendGate=null; await Promise.all([old,current]);
 assert.equal(concurrentSends,1);
 assert.equal(h.receipts.length,0);
 assert.ok(h.pending.has('s-one:succeeded'));
 assert.equal(h.pending.has('s-one:idle_attention'),false);
 await h.notify(notificationEvent('succeeded'));
 assert.equal(h.receipts.length,1);
 assert.equal(h.sends.length,2);
});

test('delayed history response cannot bypass newly recorded backoff', async () => {
 let release; let reads=0;
 const options={sendError:'temporary service failure',listSessions:async()=>{
  if (++reads===2) await new Promise(resolve=>{release=resolve;});
  return [{summary:{session_id:'s-one',cwd:'/repo'},status:'succeeded'}];
 }};
 const h=notificationHarness(options);
 const first=h.notify(notificationEvent('succeeded'));
 const second=h.notify(notificationEvent('succeeded'));
 await first; release(); await second;
 assert.equal(h.sends.length,1);
 assert.equal(h.q.canRetry('s-one:succeeded'),false);
});
