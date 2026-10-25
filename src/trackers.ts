import type { TrackerConfig } from "./config.ts";
import type { Message } from "./outbox.ts";
import { sources } from "./sources.ts";
import { shouldKeep, type LastKept } from "./tracking.ts";

// In-memory state of one tracker. Not persisted: after a restart every
// tracker starts with lastKept = null, so its first sample is kept.
export type Tracker = {
  config: TrackerConfig;
  lastKept: LastKept;
  nextSampleAt: number;
};

export function createTrackers(configs: TrackerConfig[], now: number): Tracker[] {
  return configs.map((config) => ({ config, lastKept: null, nextSampleAt: now }));
}

// One scheduler tick: sample every tracker that is due, decide what to keep,
// and hand all kept messages to `append` at once (one transaction).
// Returns the number of kept messages.
export function runTick(
  trackers: Tracker[],
  now: number,
  append: (messages: Message[]) => void,
): number {
  const kept: { tracker: Tracker; message: Message }[] = [];

  for (const tracker of trackers) {
    if (tracker.nextSampleAt > now) continue;
    const { name, source, sampleMs, precision } = tracker.config;
    const value = sources[source](now);
    if (shouldKeep(tracker.lastKept, value, now, precision)) {
      kept.push({ tracker, message: { name, ts: now, value } });
    }
    // Advance from the planned time, not from `now`, so a late tick doesn't
    // slowly shift the schedule. If we fell far behind (process paused),
    // skip the missed samples instead of firing them all at once.
    tracker.nextSampleAt += sampleMs;
    if (tracker.nextSampleAt <= now) tracker.nextSampleAt = now + sampleMs;
  }

  append(kept.map((k) => k.message));
  // Only after the write succeeded: if append threw, lastKept stays as it
  // was, so we never compare against a value that isn't in the outbox.
  for (const { tracker, message } of kept) {
    tracker.lastKept = { value: message.value, ts: message.ts };
  }
  return kept.length;
}
