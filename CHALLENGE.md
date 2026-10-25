# Code challenge: Durable telemetry tracker

At HEAT we build controllers for power plants. They sample hundreds of signals, decide which values are worth reporting, and forward them to the cloud over links that fail regularly. Power can be cut without warning, and data must not be lost along the way. This challenge is a small version of that problem.

Its main purpose is to give us a common basis for our next conversation, where we'll discuss your design choices, the trade-offs you made, and possible next steps. Every submission gets that conversation, and it's where we make our decision.

We expect you to spend about 3 hours on this. If you find you need more time, it's okay to stop.

## What to build

A Node.js application, written in TypeScript, with two stages:

1. **Tracking:** sample virtual data sources at configured intervals, decide which samples are worth keeping, and store those durably in a local outbox.
2. **Forwarding:** periodically publish the stored samples in batches over an unreliable channel.

It should run until interrupted. Please include tests and instructions for running both the application and the tests.

## Setup

- **Runtime:** Node.js 24 (LTS), TypeScript.
- **Dependencies:** any npm packages you like. Embedded storage (plain files, SQLite) is fine; external services such as databases or message brokers are not.
- **AI assistants** are allowed. In the follow-up session we'll ask you to walk us through your code and extend it together, so make sure you understand every part of it.

## Data sources

We can't give you real temperature or energy readings, so use these two virtual sources. They take time in milliseconds as an argument, which makes them deterministic. Adapt them as needed.

```ts
function sin(unixTimeMs: number): number {
  return Math.sin(unixTimeMs / 10000);
}

function cos(unixTimeMs: number): number {
  return Math.cos(unixTimeMs / 10000);
}
```

## Configuration

The application reads a `config.json` describing which sources to track, how, and under which name. This example has three trackers, two of which track the same source:

```json
[
  { "name": "one",   "source": "sin", "sampleMs": 1000, "precision": 0.08 },
  { "name": "two",   "source": "cos", "sampleMs": 2000, "precision": 0.15 },
  { "name": "three", "source": "sin", "sampleMs": 1000, "precision": 5 }
]
```

| Field       | Meaning                                                              |
|-------------|----------------------------------------------------------------------|
| `name`      | Name of the tracker, used in messages.                               |
| `source`    | The data source to sample (`sin` or `cos`).                          |
| `sampleMs`  | Sampling interval in milliseconds. Never below 1000.                 |
| `precision` | The smallest change we care about (see below).                       |

## Stage 1: Tracking

Each tracker samples its source every `sampleMs` milliseconds and applies these rules to every sample:

- **First sample:** always kept.
- **Significant change:** keep the sample if it differs from the tracker's last *kept* value by at least `precision`. For example, with precision 5, if the last kept value was 18 and we sample 19, we don't keep it. We keep the next sample of 23 or more, or 13 or less.
- **Heartbeat:** if a sample isn't significant but the tracker last kept a value more than 15 seconds ago, keep it anyway.

A kept sample becomes a message:

```json
{ "name": "one", "ts": 1790241303412, "value": -0.4 }
```

`ts` is the time the sample was taken, as Unix time in milliseconds, and `value` is the raw sampled value. A message is identified by its `name` and `ts`.

Kept messages are appended to a **local outbox**. Where it lives and how it's designed is up to you.

After a restart, trackers may start fresh: each tracker's first sample after a restart is kept, as if the application had just started.

## Stage 2: Forwarding

Every 10 seconds, the forwarder publishes the messages in the outbox that haven't been published yet, as a batch of at most 5,000 messages.

A batch looks like this:

```json
{ "batch_id": "…", "messages": [ { "name": "one", "ts": 1790241303412, "value": -0.4 } ] }
```

The format of `batch_id` is up to you.

**Publishing** is done by a function you implement:

```ts
publish(batch: Batch): Promise<void>
```

It writes the batch to **stdout** as a single JSON line. For this challenge, stdout stands in for our cloud: please keep it free of anything else, and send your own logging to stderr.

To simulate an unreliable network, `publish` fails at random, often enough that failures matter. When it fails, it does one of the following:

- Rejects without writing anything.
- Never resolves.
- Writes the batch to stdout, then rejects.

**The receiver deduplicates on `batch_id`.** If the same `batch_id` appears more than once on stdout, it's treated as one batch. Two different batches containing the same message count as a duplicate.

## Requirements

The application may stop at any moment without warning, as it would in a power loss, and then be restarted. Across any number of such stops:

- **No loss:** every message that was written to the outbox eventually appears on stdout, provided the application keeps running long enough.
- **No duplicates:** after deduplicating by `batch_id`, each message appears on stdout exactly once.
- **Crash safety:** the outbox stays usable after a crash, including if the process died in the middle of a write.

All of this should work well with around 1,000 trackers.

## Your README

Please cover:

- How to run the application and the tests.
- Your design and the main decisions behind it.
- The guarantees you provide, and any conditions under which they don't hold.
- What you deliberately left out, and why.

## Submission

A git repository (link or zip) with your commit history intact.

## Next conversation

You'll share your screen and walk us through your solution. We'll discuss the design and implementation, then extend the solution together, and talk about related topics.