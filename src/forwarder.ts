import type { Outbox } from "./outbox.ts";
import type { Publish } from "./publish.ts";

export type ForwarderOptions = {
  maxBatchSize: number;
  timeoutMs: number;
  log: (message: string) => void;
};

// Rejects if `promise` hasn't settled within `ms`. Needed because publish can
// hang forever, and we treat "no answer" the same as a failure.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One forwarding cycle: publish batches one at a time until the outbox is
// empty or a publish fails. Returns how many batches were confirmed.
//
// On failure we stop and leave the batch in the outbox; the next cycle's
// nextBatch() returns that same batch, so the retry has the same batch_id and
// the receiver can deduplicate it if it did arrive.
export async function forwardCycle(
  outbox: Outbox,
  publish: Publish,
  { maxBatchSize, timeoutMs, log }: ForwarderOptions,
): Promise<number> {
  let published = 0;
  for (;;) {
    const batch = outbox.nextBatch(maxBatchSize);
    if (batch === null) return published;
    try {
      await withTimeout(publish(batch), timeoutMs);
    } catch (err) {
      log(`publish of batch ${batch.batch_id} (${batch.messages.length} messages) failed: ${(err as Error).message}; will retry`);
      return published;
    }
    // A crash right here means the batch is published again after restart,
    // with the same batch_id: a duplicate the receiver removes.
    outbox.deleteBatch(batch.batch_id);
    published++;
  }
}
