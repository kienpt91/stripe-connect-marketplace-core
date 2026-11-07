import { describe, expect, it } from "vitest";
import { parseUuid } from "../../src/domain/ids.js";
import { JsonLogger, ManualClock, SequentialIds, systemClock, uuidGenerator } from "../../src/infrastructure/system.js";

describe("clocks and identifiers", () => {
  it("tells the time, and a manual clock only moves when told to", () => {
    expect(Math.abs(systemClock.now() - Date.now())).toBeLessThan(1_000);
    const c = new ManualClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
    c.set(7);
    expect(c.now()).toBe(7);
  });

  it("makes valid UUIDs, random ones and counted ones", () => {
    expect(parseUuid(uuidGenerator.next())).toBeDefined();
    expect(uuidGenerator.next()).not.toBe(uuidGenerator.next());
    const ids = new SequentialIds("0a000000", 41);
    expect([ids.next(), ids.next()]).toEqual(["0a000000-0000-4000-8000-000000000042", "0a000000-0000-4000-8000-000000000043"]);
    expect(parseUuid(new SequentialIds().next())).toBeDefined();
  });
});

describe("the logger", () => {
  const log = () => {
    const lines: string[] = [];
    return { lines, logger: new JsonLogger((l) => void lines.push(l), new ManualClock(Date.UTC(2026, 10, 9, 9, 0))) };
  };

  it("writes one JSON object per line with a time, a level and the event", () => {
    const { lines, logger } = log();
    logger.info("a.b", { n: 1 });
    logger.warn("c");
    logger.error("d", { code: "x" });
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { n: 1, ts: "2026-11-09T09:00:00.000Z", level: "info", event: "a.b" },
      { ts: "2026-11-09T09:00:00.000Z", level: "warn", event: "c" },
      { code: "x", ts: "2026-11-09T09:00:00.000Z", level: "error", event: "d" },
    ]);
  });

  it("replaces the value of a field whose name says it is sensitive, at any depth, and shortens long strings", () => {
    const { lines, logger } = log();
    logger.info("probe", { Authorization: "Bearer abc", stripe_signature: "t=1,v1=00", nested: { password: "p", list: [{ api_key: "k", ok: 1 }] }, card_number: "4242", note: "x".repeat(400), deep: { a: { b: { c: { d: { e: 1 } } } } } });
    const line = JSON.parse(lines[0] as string);
    expect(line.Authorization).toBe("[redacted]");
    expect(line.stripe_signature).toBe("[redacted]");
    expect(line.nested).toEqual({ password: "[redacted]", list: [{ api_key: "[redacted]", ok: 1 }] });
    expect(line.card_number).toBe("[redacted]");
    expect(line.note).toHaveLength(303);
    expect(JSON.stringify(line.deep)).toContain("[deep]");
    expect(lines[0]).not.toContain("Bearer");
  });
});
