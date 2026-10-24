import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoScheduler } from '../server/scheduler.ts';

test('scheduled checks visit each validation window and skip saved results', async () => {
  const visited: string[] = [];
  const scheduler = new DemoScheduler(async input => {
    visited.push(`${input.scenario}:${input.windowStart}`);
    return { reused: input.scenario === 'rapid_pull', alertCount: input.scenario === 'failure_burst' ? 1 : 0 };
  }, 1000);
  await scheduler.tick();
  await scheduler.tick();
  assert.deepEqual(visited, ['rapid_pull:2026-10-23T12:00', 'token_shared:2026-10-23T13:00']);
  assert.equal(scheduler.status().checked, 2);
  assert.equal(scheduler.status().next?.scenario, 'failure_burst');
  await scheduler.tick();
  assert.equal(scheduler.status().last?.alertCount, 1);
  assert.equal(scheduler.status().last?.reused, false);
});

test('failed checks retain their window for retry and cannot overlap', async () => {
  let calls = 0;
  const scheduler = new DemoScheduler(async () => {
    calls++;
    if (calls === 1) throw new Error('upstream unavailable');
    return { reused: false, alertCount: 0 };
  }, 1000);
  await scheduler.tick();
  assert.equal(scheduler.status().next?.scenario, 'rapid_pull');
  assert.equal(scheduler.status().last?.error, '检测失败，下一轮重试');
  await scheduler.tick();
  assert.equal(scheduler.status().next?.scenario, 'token_shared');
  assert.equal(scheduler.status().checked, 1);
});

test('validation batch finishes after eight windows without repeating a completed window', async () => {
  let calls = 0;
  const scheduler = new DemoScheduler(async () => { calls++; return { reused: false, alertCount: 0 }; }, 1000);
  for (let index = 0; index < 8; index++) await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 8);
  assert.equal(scheduler.status().checked, 8);
  assert.equal(scheduler.status().next, null);
  assert.equal(scheduler.status().active, false);
});
