import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublisher } from "../src/publish.ts";

const batch = { batch_id: "b1", messages: [{ name: "one", ts: 1, value: 0.5 }] };
const line = JSON.stringify(batch) + "\n";

// A publisher whose random number is fixed, and whose output is captured.
function publisherWith(r: number) {
  const written: string[] = [];
  const publish = createPublisher({
    failureRate: 0.3,
    random: () => r,
    write: async (l) => { written.push(l); },
  });
  return { publish, written };
}

// Settles to "pending" if the promise hasn't resolved or rejected in 20 ms.
const settle = (p: Promise<void>) =>
  Promise.race([
    p.then(() => "resolved", () => "rejected"),
    new Promise((r) => setTimeout(() => r("pending"), 20)),
  ]);

test("success writes the batch as one JSON line and resolves", async () => {
  const { publish, written } = publisherWith(0.5);
  assert.equal(await settle(publish(batch)), "resolved");
  assert.deepEqual(written, [line]);
});

test("failure mode 1: rejects without writing", async () => {
  const { publish, written } = publisherWith(0.05);
  assert.equal(await settle(publish(batch)), "rejected");
  assert.deepEqual(written, []);
});

test("failure mode 2: never resolves", async () => {
  const { publish, written } = publisherWith(0.15);
  assert.equal(await settle(publish(batch)), "pending");
  assert.deepEqual(written, []);
});

test("failure mode 3: writes, then rejects", async () => {
  const { publish, written } = publisherWith(0.25);
  assert.equal(await settle(publish(batch)), "rejected");
  assert.deepEqual(written, [line]);
});
