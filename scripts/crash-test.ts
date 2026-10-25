// Crash test: runs the real app many times, killing it with SIGKILL (like a
// power cut) at random moments, then checks the requirements on stdout:
//   no loss       - every message written to the outbox appeared on stdout
//                   (or is still safely in the outbox, waiting to be sent)
//   no duplicates - after deduplicating by batch_id, each message appears once
//
// How do we know what was written to the outbox, when the app deletes
// messages after publishing? We add an `audit` table plus a trigger that
// copies every inserted message into it. The trigger runs inside the app's own
// insert transaction, so the audit is exactly what was committed - no more,
// no less. The app itself is unchanged.
//
// Usage: npm run crash-test [rounds]
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Outbox, type Batch } from "../src/outbox.ts";

const ROUNDS = Number(process.argv[2] ?? 10);
const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "heat-crash-"));
const dbPath = join(dir, "outbox.db");
const stdoutPath = join(dir, "stdout.jsonl");
const stderrPath = join(dir, "stderr.log");
const configPath = join(dir, "config.json");

// 1,000 trackers. Half have precision 0 (every sample kept) for volume, so
// batches hit the 5,000 cap; the other half exercise the tracking rule.
writeFileSync(configPath, JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({
  name: `t${i}`,
  source: i % 2 === 0 ? "sin" : "cos",
  sampleMs: i % 3 === 0 ? 2000 : 1000,
  precision: i % 2 === 0 ? 0 : 0.05,
}))));

new Outbox(dbPath).close(); // creates the schema
const setup = new Database(dbPath);
setup.exec(`
  CREATE TABLE audit (name TEXT, ts INTEGER, value REAL);
  CREATE TRIGGER audit_insert AFTER INSERT ON messages
  BEGIN INSERT INTO audit VALUES (NEW.name, NEW.ts, NEW.value); END;
`);
setup.close();

// For the drain run: one tracker that keeps its first sample and then
// nothing for 15 s, so the backlog can empty out completely.
const drainConfigPath = join(dir, "drain-config.json");
writeFileSync(drainConfigPath, JSON.stringify([
  { name: "drain", source: "sin", sampleMs: 1000, precision: 1e9 },
]));

// Starts the app with stdout appended to one file (our "cloud"), stops it
// with `signal` after `ms`. Forwarding every second gives many more cycles.
function runApp(
  ms: number,
  signal: NodeJS.Signals,
  config = configPath,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const out = openSync(stdoutPath, "a");
  const err = openSync(stderrPath, "a");
  const child = spawn(process.execPath, [MAIN, config], {
    stdio: ["ignore", out, err],
    env: { ...process.env, OUTBOX_PATH: dbPath, FORWARD_INTERVAL_MS: "1000", ...extraEnv },
  });
  closeSync(out);
  closeSync(err);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(signal), ms);
    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      if (sig === null && code !== 0) reject(new Error(`app exited with code ${code}, see ${stderrPath}`));
      else resolve();
    });
  });
}

console.log(`crash test in ${dir}`);
for (let i = 1; i <= ROUNDS; i++) {
  const ms = 1500 + Math.floor(Math.random() * 4500);
  console.log(`round ${i}/${ROUNDS}: run ${ms} ms, then SIGKILL`);
  await runApp(ms, "SIGKILL");
}
// "Provided the application keeps running long enough": a last run with a
// working network and no new load, so everything left must get sent. Without
// this we could only check that messages are still in the outbox, not that
// they eventually leave it (a stuck batch would go unnoticed).
console.log("drain run: 1 quiet tracker, no publish failures, 6 s, then SIGTERM");
await runApp(6_000, "SIGTERM", drainConfigPath, { PUBLISH_FAILURE_RATE: "0" });

// --- Check stdout ---------------------------------------------------------

// A SIGKILL can cut a line in half, and the next run then appends to it.
// Like a real receiver, we skip what can't be parsed (that batch was never
// confirmed, so it is sent again) and recover a complete batch at the end.
function parseLine(line: string): Batch | null {
  for (const candidate of [line, line.slice(line.lastIndexOf('{"batch_id"'))]) {
    try { return JSON.parse(candidate) as Batch; } catch { /* try next */ }
  }
  return null;
}

const batches = new Map<string, Batch>(); // the receiver: dedupe on batch_id
let lines = 0, unparsable = 0, changedBatches = 0;
for (const line of readFileSync(stdoutPath, "utf8").split("\n")) {
  if (line === "") continue;
  lines++;
  const batch = parseLine(line);
  if (batch === null) { unparsable++; continue; }
  const seen = batches.get(batch.batch_id);
  if (seen === undefined) batches.set(batch.batch_id, batch);
  else if (JSON.stringify(seen) !== JSON.stringify(batch)) changedBatches++; // must never change
}

const key = (m: { name: string; ts: number }) => `${m.name}@${m.ts}`;
const publishedIn = new Map<string, string>(); // message -> batch_id
let duplicates = 0;
for (const batch of batches.values()) {
  for (const m of batch.messages) {
    const prev = publishedIn.get(key(m));
    if (prev !== undefined && prev !== batch.batch_id) duplicates++;
    publishedIn.set(key(m), batch.batch_id);
  }
}

const db = new Database(dbPath, { readonly: true });
const audit = db.prepare("SELECT name, ts FROM audit").all() as { name: string; ts: number }[];
const remaining = db.prepare("SELECT name, ts, batch_id FROM messages")
  .all() as { name: string; ts: number; batch_id: string | null }[];
db.close();

// A message still in the outbox must not have been published under another
// batch_id, or it would show up twice once that batch is retried.
const remainingKeys = new Set<string>();
for (const r of remaining) {
  remainingKeys.add(key(r));
  const prev = publishedIn.get(key(r));
  if (prev !== undefined && prev !== r.batch_id) duplicates++;
}

const auditKeys = new Set(audit.map(key));
const lost = [...auditKeys].filter((k) => !publishedIn.has(k) && !remainingKeys.has(k)).length;
const invented = [...publishedIn.keys()].filter((k) => !auditKeys.has(k)).length;

console.log({
  written: auditKeys.size,
  published: publishedIn.size,
  stillInOutbox: remaining.length,
  stdoutLines: lines,
  distinctBatches: batches.size,
  resentBatches: lines - unparsable - batches.size,
  unparsable,
  lost,
  duplicates,
  changedBatches,
  invented,
});

const ok = lost === 0 && duplicates === 0 && changedBatches === 0 && invented === 0
  && remaining.length === 0 && publishedIn.size > 0;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
