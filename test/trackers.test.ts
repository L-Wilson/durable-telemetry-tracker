import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrackers, runTick } from "../src/trackers.ts";
import type { Message } from "../src/outbox.ts";

const configs = [
  { name: "fast", source: "sin" as const, sampleMs: 1000, precision: 0 },
  { name: "slow", source: "cos" as const, sampleMs: 2000, precision: 0 },
];

test("each tick samples only the trackers that are due, in one append", () => {
  const trackers = createTrackers(configs, 0);
  const appends: Message[][] = [];
  for (const now of [0, 1000, 2000, 3000]) {
    runTick(trackers, now, (m) => appends.push(m));
  }
  assert.deepEqual(
    appends.map((batch) => batch.map((m) => m.name)),
    [["fast", "slow"], ["fast"], ["fast", "slow"], ["fast"]],
  );
});

test("kept messages carry the sample time and the raw value", () => {
  const trackers = createTrackers([configs[0]!], 0);
  let written: Message[] = [];
  runTick(trackers, 5000, (m) => { written = m; });
  assert.deepEqual(written, [{ name: "fast", ts: 5000, value: Math.sin(0.5) }]);
});

test("if the write fails, lastKept is not updated", () => {
  const trackers = createTrackers([configs[0]!], 0);
  assert.throws(() => runTick(trackers, 0, () => { throw new Error("disk"); }));
  assert.equal(trackers[0]!.lastKept, null);
});
