import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

// Proves the toolchain works: Node runs TypeScript, the test runner finds
// this file, and better-sqlite3's native module loads and supports WAL.
test("better-sqlite3 opens a file database in WAL mode", () => {
  // WAL needs a real file; an in-memory database ignores journal_mode.
  const dir = mkdtempSync(join(tmpdir(), "heat-smoke-"));
  const db = new Database(join(dir, "smoke.db"));
  try {
    assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
    // Rows come back as `unknown`; we declare the shape we expect.
    const row = db.prepare("SELECT 1 + 1 AS two").get() as { two: number };
    assert.equal(row.two, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
