import type { DetectionInput, RuleId } from './types.ts';
import { WINDOW_MINUTES } from './rules.ts';
import { at } from './features.ts';

export const stamp = (milliseconds: number) => new Date(milliseconds + 8 * 3600000).toISOString().slice(0, 23).replace('T', ' ');
// All rules share the selected end time, each with its own natural lookback.
export function ruleWindow(input: DetectionInput, id: RuleId): DetectionInput {
  return { ...input, windowStart: stamp(at(input.windowEnd) - WINDOW_MINUTES[id] * 60000) };
}
export const withinBatch = (input: DetectionInput) => at(input.windowStart) >= at('2026-10-16 00:00:00.000') && at(input.windowEnd) <= at('2026-10-24 00:00:00.000');
