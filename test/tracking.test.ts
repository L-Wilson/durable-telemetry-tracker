import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldKeep, HEARTBEAT_MS, type LastKept } from "../src/tracking.ts";

// Runs samples through shouldKeep the way a tracker will: LastKept only
// changes when a sample is kept. Returns which samples were kept.
function run(samples: { ts: number; value: number }[], precision: number): boolean[] {
  let lastKept: LastKept = null;
  return samples.map(({ ts, value }) => {
    const keep = shouldKeep(lastKept, value, ts, precision);
    if (keep) lastKept = { value, ts };
    return keep;
  });
}

test("first sample is always kept", () => {
  assert.equal(shouldKeep(null, 0, 1000, 5), true);
});

test("challenge example: precision 5, last kept 18", () => {
  const last = { value: 18, ts: 0 };
  assert.equal(shouldKeep(last, 19, 1000, 5), false);
  assert.equal(shouldKeep(last, 23, 1000, 5), true);  // exactly +5 counts ("at least")
  assert.equal(shouldKeep(last, 13, 1000, 5), true);  // exactly -5 counts too
  assert.equal(shouldKeep(last, 14, 1000, 5), false);
});

test("heartbeat: keep an insignificant sample only after MORE than 15 s", () => {
  const last = { value: 18, ts: 0 };
  assert.equal(shouldKeep(last, 18, HEARTBEAT_MS, 5), false);     // exactly 15 s: not yet
  assert.equal(shouldKeep(last, 18, HEARTBEAT_MS + 1, 5), true);
});

test("compares against the last KEPT value, so slow drift is caught", () => {
  // Each step is only 0.05, but 0 → 0.1 is a change of 0.1 >= 0.08.
  const kept = run([
    { ts: 1000, value: 0 },
    { ts: 2000, value: 0.05 },
    { ts: 3000, value: 0.1 },
  ], 0.08);
  assert.deepEqual(kept, [true, false, true]);
});

test("heartbeat timer restarts from the last kept sample", () => {
  // A flat signal, sampled every second: kept at 0 s, then 16 s, then 32 s.
  const samples = Array.from({ length: 33 }, (_, i) => ({ ts: i * 1000, value: 1 }));
  const keptTimes = run(samples, 5)
    .flatMap((keep, i) => (keep ? [samples[i]!.ts] : []));
  assert.deepEqual(keptTimes, [0, 16_000, 32_000]);
});

test("precision 0 keeps every sample", () => {
  assert.deepEqual(run([{ ts: 0, value: 1 }, { ts: 1000, value: 1 }], 0), [true, true]);
});
