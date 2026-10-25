import { readFileSync } from "node:fs";
import { isSourceName, type SourceName } from "./sources.ts";

export type TrackerConfig = {
  name: string;
  source: SourceName;
  sampleMs: number;
  precision: number;
};

const MIN_SAMPLE_MS = 1000;

// Reads and validates config.json. Throws on any problem, so the app refuses
// to start with a bad config instead of failing later in the main loop.
export function loadConfig(path: string): TrackerConfig[] {
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

// Validation only, no file access. loadConfig calls this; tests call it directly.
export function parseConfig(raw: unknown): TrackerConfig[] {
  if (!Array.isArray(raw)) throw new Error("config must be an array of trackers");
  if (raw.length === 0) throw new Error("config must contain at least one tracker");

  const seenNames = new Set<string>();

  return raw.map((entry: unknown, i): TrackerConfig => {
    const where = `tracker #${i}`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${where}: must be an object`);
    }
    const { name, source, sampleMs, precision } = entry as Record<string, unknown>;

    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`${where}: "name" must be a non-empty string`);
    }
    // A message is identified by (name, ts). Two trackers with the same name
    // could produce the same identity, so names must be unique.
    if (seenNames.has(name)) throw new Error(`${where}: duplicate name "${name}"`);
    seenNames.add(name);

    if (!isSourceName(source)) {
      throw new Error(`${where} ("${name}"): unknown source ${JSON.stringify(source)}`);
    }
    if (!Number.isInteger(sampleMs) || (sampleMs as number) < MIN_SAMPLE_MS) {
      throw new Error(`${where} ("${name}"): "sampleMs" must be an integer >= ${MIN_SAMPLE_MS}`);
    }
    // Number.isFinite also rejects NaN, Infinity and non-numbers like "0.1".
    if (!Number.isFinite(precision) || (precision as number) < 0) {
      throw new Error(`${where} ("${name}"): "precision" must be a number >= 0`);
    }

    return { name, source, sampleMs: sampleMs as number, precision: precision as number };
  });
}
