// What a tracker remembers about the last sample it KEPT (not the last one it
// sampled). null means nothing kept yet: a fresh start or a restart.
export type LastKept = { value: number; ts: number } | null;

export const HEARTBEAT_MS = 15_000;

// Decides whether a sample is worth keeping. Pure: no clock, no storage.
// The caller updates LastKept when this returns true.
export function shouldKeep(
  lastKept: LastKept,
  value: number,
  ts: number,
  precision: number,
): boolean {
  if (lastKept === null) return true;
  if (Math.abs(value - lastKept.value) >= precision) return true;
  if (ts - lastKept.ts > HEARTBEAT_MS) return true;
  return false;
}
