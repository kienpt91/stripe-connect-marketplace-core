import { randomUUID } from "node:crypto";
import type { Clock, IdGenerator, Logger } from "../application/ports.js";

export const systemClock: Clock = { now: () => Date.now() };

export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

/** Field names whose value is never written to a log, whatever it holds. */
const SENSITIVE = /secret|token|authorization|password|passwd|api[_-]?key|signature|card|iban|email/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  }
  return typeof value === "string" && value.length > 300 ? `${value.slice(0, 300)}...` : value;
}

/** One JSON object per line with a timestamp, a level, an event name and the fields; fields with a sensitive name are replaced. */
export class JsonLogger implements Logger {
  private readonly write: (line: string) => void;
  private readonly clock: Clock;

  constructor(write: (line: string) => void, clock: Clock) {
    this.write = write;
    this.clock = clock;
  }

  info(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("info", event, fields);
  }

  warn(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("warn", event, fields);
  }

  error(event: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit("error", event, fields);
  }

  private emit(level: string, event: string, fields: Readonly<Record<string, unknown>> | undefined): void {
    this.write(JSON.stringify({ ...(redact(fields ?? {}) as Record<string, unknown>), ts: new Date(this.clock.now()).toISOString(), level, event }));
  }
}

/** A clock that only moves when told to: for tests and the demo, where days have to pass without waiting. */
export class ManualClock implements Clock {
  private t: number;

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  set(t: number): void {
    this.t = t;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

/** Identifiers that count up (valid version 4 UUIDs): for tests and the demo, where the same run must print the same ids. */
export class SequentialIds implements IdGenerator {
  private n: number;
  private readonly prefix: string;

  constructor(prefix = "00000000", start = 0) {
    this.prefix = prefix;
    this.n = start;
  }

  next(): string {
    this.n += 1;
    return `${this.prefix}-0000-4000-8000-${String(this.n).padStart(12, "0")}`;
  }
}
