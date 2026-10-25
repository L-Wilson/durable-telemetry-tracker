import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Outbox, type Message } from "../src/outbox.ts";

let dir: string;
let path: string;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "heat-outbox-"));
  path = join(dir, "outbox.db");
  outbox = new Outbox(path);
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

const msg = (i: number): Message => ({ name: "one", ts: 1000 * i, value: i / 10 });

test("returns null when there is nothing to send", () => {
  assert.equal(outbox.nextBatch(5000), null);
});

test("append ignores a message with the same (name, ts)", () => {
  outbox.append([msg(1), msg(1), { ...msg(1), name: "two" }]);
  assert.deepEqual(outbox.counts(), { pending: 2, batched: 0 });
});

test("a batch takes the oldest pending messages, up to maxSize", () => {
  outbox.append([msg(1), msg(2), msg(3)]);
  const batch = outbox.nextBatch(2)!;
  assert.deepEqual(batch.messages, [msg(1), msg(2)]);
  assert.deepEqual(outbox.counts(), { pending: 1, batched: 2 });
});

test("an unconfirmed batch is returned again unchanged, even after new messages arrive", () => {
  outbox.append([msg(1)]);
  const first = outbox.nextBatch(5000)!;
  outbox.append([msg(2)]);
  assert.deepEqual(outbox.nextBatch(5000), first);
});

test("deleteBatch removes the batch and its messages, then the next batch starts", () => {
  outbox.append([msg(1), msg(2)]);
  const first = outbox.nextBatch(1)!;
  outbox.deleteBatch(first.batch_id);
  const second = outbox.nextBatch(1)!;
  assert.notEqual(second.batch_id, first.batch_id);
  assert.deepEqual(second.messages, [msg(2)]);
  outbox.deleteBatch(second.batch_id);
  assert.equal(outbox.nextBatch(1), null);
});

test("after a restart the same batch comes back (same id, same messages)", () => {
  outbox.append([msg(1), msg(2)]);
  const before = outbox.nextBatch(5000)!;
  outbox.close();
  outbox = new Outbox(path); // simulates the process starting again
  assert.deepEqual(outbox.nextBatch(5000), before);
});
