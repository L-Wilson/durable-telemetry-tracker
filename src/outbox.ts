import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export type Message = { name: string; ts: number; value: number };
export type Batch = { batch_id: string; messages: Message[] };

// The durable outbox. A message moves through three states:
//   pending  (batch_id IS NULL)
//   batched  (batch_id points to a row in batches; publish not confirmed yet)
//   deleted  (publish confirmed; the batch and its messages are removed)
export class Outbox {
  private readonly db: Database.Database;
  private readonly insertMessage: Database.Statement;
  private readonly selectOpenBatch: Database.Statement;
  private readonly selectAnyPending: Database.Statement;
  private readonly insertBatch: Database.Statement;
  private readonly assignPending: Database.Statement;
  private readonly selectBatchMessages: Database.Statement;
  private readonly deleteMessages: Database.Statement;
  private readonly deleteBatchRow: Database.Statement;
  private readonly countByState: Database.Statement;

  constructor(path: string) {
    this.db = new Database(path);
    // WAL: a crash mid-write leaves the last committed state intact.
    // synchronous=FULL: a commit only returns once it is on disk, so a power
    // cut can't lose a transaction we already reported as committed.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");

    // IF NOT EXISTS: on restart we reopen the same file and keep its contents.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id   TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        name     TEXT    NOT NULL,
        ts       INTEGER NOT NULL,
        value    REAL    NOT NULL,
        batch_id TEXT    NULL REFERENCES batches(batch_id),
        UNIQUE (name, ts)
      );
      CREATE INDEX IF NOT EXISTS messages_by_batch ON messages(batch_id);
    `);

    // OR IGNORE: (name, ts) identifies a message, so inserting the same
    // identity twice is the same message, not a new one.
    this.insertMessage = this.db.prepare(
      "INSERT OR IGNORE INTO messages (name, ts, value) VALUES (?, ?, ?)",
    );
    this.selectOpenBatch = this.db.prepare(
      "SELECT batch_id FROM batches ORDER BY created_at, batch_id LIMIT 1",
    );
    this.selectAnyPending = this.db.prepare(
      "SELECT 1 FROM messages WHERE batch_id IS NULL LIMIT 1",
    );
    this.insertBatch = this.db.prepare(
      "INSERT INTO batches (batch_id, created_at) VALUES (?, ?)",
    );
    // Oldest pending messages first (id only ever grows thanks to AUTOINCREMENT).
    this.assignPending = this.db.prepare(`
      UPDATE messages SET batch_id = ?
      WHERE id IN (SELECT id FROM messages WHERE batch_id IS NULL ORDER BY id LIMIT ?)
    `);
    this.selectBatchMessages = this.db.prepare(
      "SELECT name, ts, value FROM messages WHERE batch_id = ? ORDER BY id",
    );
    this.deleteMessages = this.db.prepare("DELETE FROM messages WHERE batch_id = ?");
    this.deleteBatchRow = this.db.prepare("DELETE FROM batches WHERE batch_id = ?");
    this.countByState = this.db.prepare(`
      SELECT
        COALESCE(SUM(batch_id IS NULL), 0)     AS pending,
        COALESCE(SUM(batch_id IS NOT NULL), 0) AS batched
      FROM messages
    `);
  }

  // Stores all messages of one tick in ONE transaction: all of them or none.
  append(messages: Message[]): void {
    if (messages.length === 0) return;
    this.db.transaction(() => {
      for (const m of messages) this.insertMessage.run(m.name, m.ts, m.value);
    })();
  }

  // Returns the batch to publish next, or null if there is nothing to send.
  // An existing unconfirmed batch always comes first (e.g. after a crash or a
  // failed publish), so it is retried with the same id and the same messages.
  // Only if there is none do we create a new batch, in the same transaction
  // that assigns its messages. A batch never changes after this.
  nextBatch(maxSize: number): Batch | null {
    return this.db.transaction((): Batch | null => {
      let batchId = (this.selectOpenBatch.get() as { batch_id: string } | undefined)?.batch_id;
      if (batchId === undefined) {
        if (this.selectAnyPending.get() === undefined) return null;
        batchId = randomUUID();
        this.insertBatch.run(batchId, Date.now());
        this.assignPending.run(batchId, maxSize);
      }
      const messages = this.selectBatchMessages.all(batchId) as Message[];
      return { batch_id: batchId, messages };
    })();
  }

  // Publish confirmed: remove the batch and its messages in ONE transaction.
  deleteBatch(batchId: string): void {
    this.db.transaction(() => {
      this.deleteMessages.run(batchId);
      this.deleteBatchRow.run(batchId);
    })();
  }

  counts(): { pending: number; batched: number } {
    return this.countByState.get() as { pending: number; batched: number };
  }

  close(): void {
    this.db.close();
  }
}
