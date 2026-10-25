import type { Batch } from "./outbox.ts";

export type Publish = (batch: Batch) => Promise<void>;

export type PublisherOptions = {
  failureRate?: number; // 0..1, chance that a publish fails
  random?: () => number; // injectable so tests can pick the outcome
  write?: (line: string) => Promise<void>; // injectable so tests don't touch stdout
};

// Writes one line to stdout and resolves once Node has handed it to the OS.
// We wait for the callback because stdout to a pipe is asynchronous on macOS:
// "write() returned" does not mean the data left our process.
export function writeStdout(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(line, (err) => (err ? reject(err) : resolve()));
  });
}

// Simulated unreliable network. One random number decides the outcome:
// r >= failureRate succeeds; otherwise the range [0, failureRate) is split
// into three equal parts, one per failure mode from the challenge.
export function createPublisher({
  failureRate = 0.3,
  random = Math.random,
  write = writeStdout,
}: PublisherOptions = {}): Publish {
  return async (batch) => {
    const line = JSON.stringify(batch) + "\n";
    const r = random();
    if (r >= failureRate) return write(line);

    const mode = Math.floor((r / failureRate) * 3);
    if (mode === 0) throw new Error("network error, nothing sent");
    if (mode === 1) return new Promise<void>(() => {}); // never resolves
    await write(line);
    throw new Error("network error after sending"); // receiver got it, we don't know
  };
}
