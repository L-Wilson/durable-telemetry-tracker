import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, type Batch } from "../src/outbox.ts";
import { forwardCycle } from "../src/forwarder.ts";

let dir: string;
let outbox: Outbox;
const opts = { maxBatchSize: 2, timeoutMs: 50, log: () => {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "heat-forwarder-"));
  outbox = new Outbox(join(dir, "outbox.db"));
  outbox.append([1, 2, 3].map((i) => ({ name: "one", ts: i, value: i })));
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

test("publishes every batch and empties the outbox", async () => {
  const sent: Batch[] = [];
  const n = await forwardCycle(outbox, async (b) => { sent.push(b); }, opts);
  assert.equal(n, 2); // 3 messages, max 2 per batch
  assert.deepEqual(sent.map((b) => b.messages.length), [2, 1]);
  assert.deepEqual(outbox.counts(), { pending: 0, batched: 0 });
});

test("a failed batch is kept and retried with the same id and messages", async () => {
  const attempts: Batch[] = [];
  const failing = async (b: Batch) => { attempts.push(b); throw new Error("down"); };
  assert.equal(await forwardCycle(outbox, failing, opts), 0);
  assert.deepEqual(outbox.counts(), { pending: 1, batched: 2 });

  await forwardCycle(outbox, async (b) => { attempts.push(b); }, opts);
  assert.deepEqual(attempts[1], attempts[0]); // the retry is identical
  assert.deepEqual(outbox.counts(), { pending: 0, batched: 0 });
});

test("a publish that never resolves times out and counts as a failure", async () => {
  const hanging = () => new Promise<void>(() => {});
  assert.equal(await forwardCycle(outbox, hanging, opts), 0);
  assert.deepEqual(outbox.counts(), { pending: 1, batched: 2 });
});
