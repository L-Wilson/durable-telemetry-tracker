import { loadConfig } from "./config.ts";
import { Outbox } from "./outbox.ts";
import { createPublisher } from "./publish.ts";
import { forwardCycle } from "./forwarder.ts";
import { createTrackers, runTick } from "./trackers.ts";

const TICK_MS = 1000; // sampleMs is never below 1000, so one tick per second is enough
const MAX_BATCH_SIZE = 5000;
const PUBLISH_TIMEOUT_MS = 5000; // shorter than the forward interval

// stdout is "the cloud" and carries batches only; all logging goes to stderr.
function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
}

// Settings that tests (the crash test) need to change; defaults match the challenge.
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

const configPath = process.argv[2] ?? "config.json";
const outboxPath = process.env.OUTBOX_PATH ?? "outbox.db";
const forwardIntervalMs = envNumber("FORWARD_INTERVAL_MS", 10_000, 100, 3_600_000);
const failureRate = envNumber("PUBLISH_FAILURE_RATE", 0.3, 0, 1);

const configs = loadConfig(configPath);
const outbox = new Outbox(outboxPath);
const publish = createPublisher({ failureRate });
const trackers = createTrackers(configs, Date.now());

log(`started: ${trackers.length} trackers, outbox ${outboxPath}, ` +
  `pending ${JSON.stringify(outbox.counts())}`);

function tick(): void {
  try {
    runTick(trackers, Date.now(), (messages) => outbox.append(messages));
  } catch (err) {
    // The samples of this tick never reached the outbox; keep running.
    log(`tick failed: ${(err as Error).message}`);
  }
}

// Guard so cycles never overlap: one batch in flight at a time.
let forwarding = false;
async function forward(): Promise<void> {
  if (forwarding) return;
  forwarding = true;
  try {
    const n = await forwardCycle(outbox, publish, {
      maxBatchSize: MAX_BATCH_SIZE,
      timeoutMs: PUBLISH_TIMEOUT_MS,
      log,
    });
    if (n > 0) log(`published ${n} batch(es), outbox now ${JSON.stringify(outbox.counts())}`);
  } catch (err) {
    log(`forward cycle failed: ${(err as Error).message}`);
  } finally {
    forwarding = false;
  }
}

// Forward right away on startup: an unconfirmed batch left by a crash is
// re-published (same batch_id) before anything new is sent.
tick();
void forward();
const tickTimer = setInterval(tick, TICK_MS);
const forwardTimer = setInterval(() => void forward(), forwardIntervalMs);

function shutdown(signal: string): void {
  log(`${signal} received, stopping`);
  clearInterval(tickTimer);
  clearInterval(forwardTimer);
  outbox.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
