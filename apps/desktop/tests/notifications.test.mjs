import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationQueue, inferAgentPhase, notificationFailure } from '../src/notifications.ts';
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
 assert.equal(notificationFailure('Register notification protocol: access denied').kind, 'transient');
});
