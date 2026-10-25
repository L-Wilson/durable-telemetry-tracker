Durable Telemetry Tracker


Design choices

┌──────────── Industrial PC ────────────────────────┐
│                                                   │
│  Trackers ──► Outbox (SQLite) ──► Forwarder ──────┼──► stdout
│  sample,      holds messages      batches +       │    (= "the cloud")
│  keep/drop    until delivered     publish         │
└───────────────────────────────────────────────────┘


Storage
The local outbox will be created with SQLite rather than plain file for crash safety.

How:

- Atomic transactions (a write either fully lands or not at all)
- Durability (a committed transaction is on disk - WAL mode, `synchronous=FULL`)
- State management (ie: assigning a batch and marking it published - single UPDATE transaction, rather than appending to file)


Message lifecycle
Message can have 1 of 3 states:

- Pending - kept by the tracker, not in a batch yet (`batch_id` is NULL)
- Batched - assigned to a batch, publish not yet confirmed (`published_at` is NULL)
- Published - publish resolved successfully (`published_at` is set)

Rules:

- A message is assigned to a batch and saved *before* publish is called.
- A batch never changes once created: same `batch_id`, same messages, on
  every retry. This is what makes the receiver's deduplication safe.
- After publishing, messages are deleted immediately

Why delete immediately? 

- Table stays small
- 

Tradeoffs with deleting immediately:

- Local history. You can’t answer “what did we send at 14:02?” from the device.
- Re-sending. If the cloud acknowledged a batch and then lost it, you can’t send it again. In this challenge a resolved publish counts as delivered, so that’s out of scope, but it’s a good thing to mention in the discussion.



What I left out

- Local history: the outbox only holds undelivered messages and deletes them
  once published. A real controller would also keep a rolling window of raw,
  high-resolution samples locally for diagnostics and on-demand backfill. That'sa separate store with its own retention, deliberately decoupled from delivery.
- Delivery acknowledgement: deletion assumes a resolved publish means the cloud stored the batch durably. In production this needs an end-to-end ack.