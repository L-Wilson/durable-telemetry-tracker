# Durable Telemetry Tracker

Samples virtual data sources, keeps the samples worth reporting in a durable
local outbox (SQLite), and forwards them in batches over an unreliable channel
(stdout stands in for the cloud). Built to survive being killed at any moment
without losing or duplicating messages.

## How to run

Requires Node.js 24. There is no build step: Node runs the TypeScript files
directly (type stripping).

```sh
npm install
```

### The application

```sh
node src/main.ts > batches.jsonl     # uses ./config.json, creates ./outbox.db
node src/main.ts my-config.json      # another config file
```

Stop it with Ctrl+C. Batches go to stdout, one JSON line each; all logging goes
to stderr. Use `node src/main.ts` (or `npm start --silent`) rather than plain
`npm start` when capturing stdout, because npm prints its own banner to stdout.

The outbox persists across runs. Delete `outbox.db*` to start empty.

Optional environment variables (defaults match the challenge):

| Variable               | Default     | Meaning                         |
|------------------------|-------------|---------------------------------|
| `OUTBOX_PATH`          | `outbox.db` | SQLite file for the outbox      |
| `FORWARD_INTERVAL_MS`  | `10000`     | How often the forwarder runs    |
| `PUBLISH_FAILURE_RATE` | `0.3`       | Chance that a publish fails     |

### The tests

```sh
npm test               # unit tests (node:test)
npm run typecheck      # tsc; Node strips types but doesn't check them
npm run crash-test     # kill -9 test, about 1 minute; optional: npm run crash-test 20
```

## Design

```text
┌──────────── Industrial PC ────────────────────────┐
│                                                   │
│  Trackers ──► Outbox (SQLite) ──► Forwarder ──────┼──► stdout
│  sample,      holds messages      batches +       │    (= "the cloud")
│  keep/drop    until delivered     publish         │
└───────────────────────────────────────────────────┘
```

| File                    | Responsibility                                             |
|-------------------------|------------------------------------------------------------|
| `src/config.ts`         | Load and validate `config.json`; refuse to start if bad    |
| `src/sources.ts`        | The `sin` / `cos` data sources                             |
| `src/tracking.ts`       | The keep rule: first sample, precision, 15 s heartbeat     |
| `src/trackers.ts`       | One scheduler tick: sample due trackers, write kept ones   |
| `src/outbox.ts`         | SQLite outbox: append, create/return batch, delete         |
| `src/publish.ts`        | Simulated unreliable `publish`                             |
| `src/forwarder.ts`      | Publish batches with a timeout; retry the same batch       |
| `src/main.ts`           | Wiring, timers, logging, shutdown                          |
| `scripts/crash-test.ts` | Kills the app repeatedly and checks stdout                 |

### Storage

The local outbox is SQLite rather than a plain file, for crash safety:

- **Atomic transactions:** a write either fully lands or not at all, even if
  the process dies halfway through it.
- **Durability:** WAL mode with `synchronous=FULL`. A commit only returns once
  it is on disk, so a power cut can't lose a transaction we already treated
  as committed.
- **State changes in place:** creating a batch is one transaction (insert the
  batch row and assign its messages); confirming it is one transaction (delete
  the batch and its messages). With an append-only file I would have to
  rebuild this state from a log after every crash.

Schema:

```sql
batches  (batch_id TEXT PRIMARY KEY, created_at INTEGER)
messages (id INTEGER PRIMARY KEY AUTOINCREMENT, name, ts, value,
          batch_id NULL REFERENCES batches, UNIQUE (name, ts))
```

`UNIQUE(name, ts)` matches the challenge's message identity: inserting the
same message twice is a no-op. `batch_id` is a random UUID, so it is unique
across restarts without needing a stored counter.

### Message lifecycle

A message has one of three states:

- **Pending:** kept by the tracker, not in a batch yet (`batch_id` is NULL).
- **Batched:** assigned to a batch; publish not confirmed yet.
- **Deleted:** publish succeeded; the batch and its messages are removed.

Rules:

- A batch is created, and its messages assigned, in one transaction
  **before** publish is called.
- A batch never changes once created: same `batch_id`, same messages, on
  every retry. This is what makes the receiver's deduplication safe.
- The forwarder always re-publishes an existing unconfirmed batch before
  creating a new one, including right after startup. Only one batch is in
  flight at a time.
- `publish` is wrapped in a 5 s timeout. A timeout counts as a failure, and
  the same batch is retried on the next cycle.
- After a successful publish, the batch and its messages are deleted in one
  transaction.

What a crash at each point means:

| Crash happens…                         | After restart                                         |
|----------------------------------------|-------------------------------------------------------|
| during a tick's write                  | rolled back; those samples never reached the outbox   |
| after creating a batch, before publish | the same batch is published                           |
| after publish, before delete           | the same batch is sent again; the receiver dedupes it |
| during the delete                      | rolled back; same as above                            |

Why delete immediately?

- The table only holds what still has to be sent, so it stays small and
  picking the next batch stays fast.
- No separate cleanup job, and no unbounded growth while the link is up.

Trade-offs of deleting immediately:

- **Local history:** you can't answer "what did we send at 14:02?" from the device.
- **Re-sending:** if the cloud acknowledged a batch and then lost it, we can't
  send it again. In this challenge a resolved publish counts as delivered, so
  that's out of scope, but it's worth discussing.

### Scaling to ~1,000 trackers

- **One scheduler loop**, not 1,000 timers. Every second, the loop samples
  every tracker that is due.
- **One transaction per tick:** all samples kept in a tick are written
  together. With `synchronous=FULL` every commit waits for the disk, so one
  commit per tick instead of one per message is the difference between one
  disk flush and up to 1,000.
- Batches are capped at 5,000 messages. A forwarding cycle keeps publishing
  batches until the outbox is empty or a publish fails, so a backlog drains
  faster than one batch per 10 s.

### Smaller decisions

- **better-sqlite3** (synchronous API): a transaction runs start to finish
  without other code interleaving, which keeps the batch logic easy to reason
  about.
- **Writing to stdout:** `publish` resolves only after Node has handed the line
  to the OS (the write callback). On macOS, stdout to a pipe is asynchronous,
  so "write() returned" doesn't mean the data has left the process.
- **Tracker state is in memory only.** After a restart each tracker's first
  sample is kept, as the challenge allows. `lastKept` is only updated after the
  tick's write succeeds, so a tracker never compares against a value that
  isn't in the outbox.
- **Config is validated at startup** (unique names, known source,
  `sampleMs` ≥ 1000, `precision` ≥ 0). Names must be unique because
  `(name, ts)` identifies a message.

## Guarantees

After deduplicating by `batch_id`, every message written to the outbox
appears on stdout exactly once, across any number of crashes and restarts.
The app delivers at least once, and because batches never change, the
receiver's dedupe on `batch_id` turns that into exactly once.

How this is tested:

- Unit tests for each part (tracking rule, outbox, publish, forwarder, tick).
- `npm run crash-test` runs the real app with 1,000 trackers and kills it with
  SIGKILL at random moments, 10 times. It then does a drain run (no publish
  failures, no new load) and checks stdout for loss, duplicates, changed
  batches and messages that were never written. To know what was written, it
  adds an audit table and a trigger to the outbox; the trigger runs inside the
  app's own insert transaction, so the audit is exactly what was committed.
- I checked that the crash test catches real bugs: it fails if a retry
  creates a new batch (messages get stuck) or re-batches messages under a new
  `batch_id` (duplicates).

### When the guarantees don't hold

- **The disk lies about flushing.** `synchronous=FULL` relies on fsync. Some
  disks and virtual machines acknowledge a write before it is really stored;
  a power cut can then lose recent commits. A process crash is still safe.
- **The disk is full or fails.** If a tick can't be written, it is logged and
  those samples are dropped. They never reached the outbox, so this is outside
  the no-loss guarantee, but data is lost. There is no disk-full policy.
- **The wall clock jumps backwards** (for example an NTP correction). A tracker
  can then produce a `(name, ts)` that already exists. If the old message is
  still in the outbox, the new sample is ignored. If the old one was already
  sent, the receiver gets two messages with the same identity.
- **The receiver forgets batch ids.** Dedupe only works if the receiver
  remembers a `batch_id` for as long as we might re-send it.
- **"Eventually" needs the network to work sometimes.** After a failure the
  forwarder waits for the next cycle (10 s). With 1,000 trackers keeping every
  sample (1,000 messages/s) and a 30% failure rate, throughput is only just
  above the input rate. A long outage or a much higher failure rate makes the
  backlog grow, limited only by disk space.
- **Samples are taken on a 1 s grid.** A `sampleMs` that isn't a multiple of
  1000 (say 1500) is sampled up to about 1 s late. The average rate is right,
  but individual intervals vary.

## What I left out

- **Local history:** the outbox only holds undelivered messages and deletes
  them once published. A real controller would also keep a rolling window of
  raw, high-resolution samples locally, for diagnostics and on-demand
  backfill. That's a separate store with its own retention, deliberately
  decoupled from delivery.
- **End-to-end delivery acknowledgement:** deletion assumes a resolved publish
  means the cloud stored the batch durably. In production this needs an
  acknowledgement from the receiver.
- **Disk-full policy:** whether to drop the oldest messages, stop sampling, or
  raise an alarm is a product decision, so I left it open rather than guess.

## Possible next steps

- Retry a failed batch sooner, with exponential backoff, instead of waiting for
  the next 10 s cycle. This raises throughput during flaky periods.
- Use a monotonic clock for scheduling and heartbeat intervals, so a wall-clock
  jump doesn't affect them (`ts` itself still has to be wall-clock time).
- Metrics: outbox size, age of the oldest pending message, publish failure rate.
- Keep tracker state (`lastKept`) in SQLite, so a restart doesn't send an extra
  first sample per tracker.
