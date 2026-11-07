import { describe, expect, it } from "vitest";
import { CONNECTION_BUDGET, declarePool, declaredConnections, TRANSIENT_ALLOWANCE } from "../support/connection-budget.js";

describe("the connection budget of the PostgreSQL tests", () => {
  it("fits the default of 100 connections with 3 reserved, with room to spare", () => {
    expect(CONNECTION_BUDGET + 3).toBeLessThanOrEqual(100 - 20);
  });

  it("lets two pools of ten share a file, and refuses a pool of 30 beside them", () => {
    const first = declarePool("first", 10);
    const second = declarePool("second", 10);
    expect(declaredConnections()).toBe(20);
    expect(() => declarePool("pool of 30", 30)).toThrow("connection budget exceeded");
    second();
    first();
    expect(declaredConnections()).toBe(0);
  });

  it("refuses a pool that would take the file past the budget, counting the harness's own connections", () => {
    expect(() => declarePool("too big", CONNECTION_BUDGET - TRANSIENT_ALLOWANCE + 1)).toThrow("connection budget exceeded");
    const exact = declarePool("exact", CONNECTION_BUDGET - TRANSIENT_ALLOWANCE);
    expect(() => declarePool("one more", 1)).toThrow("connection budget exceeded");
    exact();
  });

  it("gives connections back once, however often the release is called", () => {
    const release = declarePool("a", 10);
    release();
    release();
    expect(declaredConnections()).toBe(0);
  });
});
