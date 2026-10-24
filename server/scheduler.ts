import type { Scenario } from './types.ts';

type Window = { scenario: Scenario; windowStart: string };
type Outcome = { reused: boolean; alertCount: number };

const WINDOWS: Window[] = [
  { scenario: 'rapid_pull', windowStart: '2026-10-23T12:00' },
  { scenario: 'token_shared', windowStart: '2026-10-23T13:00' },
  { scenario: 'failure_burst', windowStart: '2026-10-23T14:00' },
  { scenario: 'scope_violation', windowStart: '2026-10-23T15:00' },
  { scenario: 'missing_chain', windowStart: '2026-10-23T16:00' },
  { scenario: 'unknown_inputs', windowStart: '2026-10-23T17:00' },
  { scenario: 'client_tool', windowStart: '2026-10-23T18:00' },
  { scenario: 'sustained_access', windowStart: '2026-10-23T02:00' },
];

export class DemoScheduler {
  private readonly detect: (input: Window) => Promise<Outcome>;
  private readonly intervalMs: number;
  private index = 0;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private idleResolvers: (() => void)[] = [];
  private last: (Window & { checkedAt: string; reused: boolean; alertCount: number; error: string | null }) | null = null;

  constructor(detect: (input: Window) => Promise<Outcome>, intervalMs: number) {
    this.detect = detect;
    this.intervalMs = intervalMs;
  }

  status() {
    return { active: this.timer !== null, running: this.running, checked: this.index, total: WINDOWS.length,
      intervalSeconds: this.intervalMs / 1000, next: WINDOWS[this.index] || null, last: this.last };
  }

  async tick() {
    if (this.running || this.index >= WINDOWS.length) return;
    this.running = true;
    const input = WINDOWS[this.index];
    try {
      const result = await this.detect(input);
      this.last = { ...input, checkedAt: new Date().toISOString(), ...result, error: null };
      this.index++;
    } catch {
      this.last = { ...input, checkedAt: new Date().toISOString(), reused: false, alertCount: 0, error: '检测失败，下一轮重试' };
    } finally {
      this.running = false;
      if (this.index >= WINDOWS.length) this.stop();
      for (const resolve of this.idleResolvers.splice(0)) resolve();
    }
  }

  start() {
    if (this.timer || this.index >= WINDOWS.length) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  waitForIdle() {
    return this.running ? new Promise<void>(resolve => this.idleResolvers.push(resolve)) : Promise.resolve();
  }
}
