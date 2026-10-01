import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationQueue, inferAgentPhase } from '../src/notifications.ts';
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
