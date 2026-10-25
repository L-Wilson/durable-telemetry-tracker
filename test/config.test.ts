import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "../src/config.ts";
import { sources, isSourceName } from "../src/sources.ts";

const valid = { name: "one", source: "sin", sampleMs: 1000, precision: 0.08 };

test("the example config.json loads", () => {
  const trackers = loadConfig("config.json");
  assert.equal(trackers.length, 3);
  assert.deepEqual(trackers[0], valid);
});

test("accepts a valid tracker", () => {
  assert.deepEqual(parseConfig([valid]), [valid]);
});

test("rejects a config that is not a non-empty array", () => {
  assert.throws(() => parseConfig({}), /array/);
  assert.throws(() => parseConfig([]), /at least one/);
});

test("rejects bad fields", () => {
  const bad = [
    { ...valid, name: "" },
    { ...valid, source: "tan" },
    { ...valid, source: "toString" }, // inherited property, not a real source
    { ...valid, sampleMs: 999 },      // below the 1000 ms minimum
    { ...valid, sampleMs: 1500.5 },
    { ...valid, sampleMs: "1000" },   // a string, not a number
    { ...valid, precision: -1 },
    { ...valid, precision: null },
  ];
  for (const entry of bad) {
    assert.throws(() => parseConfig([entry]), Error, JSON.stringify(entry));
  }
});

test("rejects duplicate names", () => {
  assert.throws(() => parseConfig([valid, { ...valid, source: "cos" }]), /duplicate/);
});

test("sources are deterministic functions of time", () => {
  assert.equal(sources.sin(0), 0);
  assert.equal(sources.cos(0), 1);
  assert.equal(sources.sin(12345), sources.sin(12345));
  assert.ok(isSourceName("cos"));
  assert.ok(!isSourceName("toString"));
});
