// Virtual data sources from the challenge. They take the time as an argument
// instead of reading the clock, so the same input always gives the same output.
// That makes them easy to test.
export const sources = {
  sin: (unixTimeMs: number): number => Math.sin(unixTimeMs / 10000),
  cos: (unixTimeMs: number): number => Math.cos(unixTimeMs / 10000),
};

// "sin" | "cos" — derived from the object above, so adding a source here
// automatically makes it valid in config.
export type SourceName = keyof typeof sources;

export function isSourceName(value: unknown): value is SourceName {
  // Object.hasOwn, not `value in sources`: `in` also finds inherited
  // properties, so "toString" would wrongly count as a source.
  return typeof value === "string" && Object.hasOwn(sources, value);
}
