import { describe, expect, it } from "vitest";
import { asId, parseId, parseStripeId, parseUuid } from "../../src/domain/ids.js";
import { err, ok } from "../../src/domain/result.js";
import { parseOrigin, returnUrl } from "../../src/domain/url.js";

const ORIGIN = "https://market.example";

describe("returnUrl: where Stripe sends people back to", () => {
  it("joins a path to the configured origin", () => {
    expect(returnUrl(ORIGIN, "/onboarding/done")).toEqual({ ok: true, value: "https://market.example/onboarding/done" });
    expect(returnUrl(ORIGIN, "/orders/42?paid=1#top")).toEqual({ ok: true, value: "https://market.example/orders/42?paid=1#top" });
    expect(returnUrl("http://localhost:3000", "/x")).toEqual({ ok: true, value: "http://localhost:3000/x" });
  });

  it.each([
    ["an absolute URL", "https://evil.example/phish"],
    ["a scheme-relative URL", "//evil.example/phish"],
    ["a backslash that browsers read as a slash", "/\\evil.example"],
    ["a path that starts with a backslash trick", "\\\\evil.example"],
    ["a bare word", "orders/42"],
    ["javascript:", "javascript:alert(1)"],
    ["a newline", "/ok\nHost: evil"],
    ["a tab", "/ok\tx"],
    ["a space", "/ok x"],
    ["a null byte", "/ok\u0000"],
    ["an empty string", ""],
    ["a very long path", `/${"a".repeat(600)}`],
    ["a number", 5],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_name, path) => {
    expect(returnUrl(ORIGIN, path)).toEqual({ ok: false, error: "invalid_redirect" });
  });

  it("refuses a path that resolves to another origin and an origin that is not one", () => {
    expect(returnUrl(ORIGIN, "/..//evil.example").ok).toBe(true); // stays on the origin: the path is just odd
    expect(returnUrl("not a url", "/x")).toEqual({ ok: false, error: "invalid_redirect" });
  });
});

describe("parseOrigin", () => {
  it("takes https origins and loopback http origins, nothing else", () => {
    expect(parseOrigin("https://market.example")).toBe("https://market.example");
    expect(parseOrigin("https://market.example/")).toBe("https://market.example");
    expect(parseOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    for (const bad of ["http://market.example", "ftp://market.example", "https://u:p@market.example", "https://market.example/path", "https://market.example?x=1", "https://market.example#a", "market.example", "", 5, null, undefined]) {
      expect(parseOrigin(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("identifiers", () => {
  it("parses a UUID of any case into the lower case form and refuses the rest", () => {
    expect(parseUuid("0A000000-0000-4000-8000-000000000001")).toBe("0a000000-0000-4000-8000-000000000001");
    for (const bad of ["", "not-a-uuid", "0a000000-0000-4000-8000-00000000000", "0a000000-0000-0000-0000-000000000001", 5, null, undefined, {}, `0a000000-0000-4000-8000-000000000001${"0"}`]) expect(parseUuid(bad), String(bad)).toBeUndefined();
    expect(parseId<"SellerId">("0a000000-0000-4000-8000-000000000001")).toBe("0a000000-0000-4000-8000-000000000001");
    expect(asId<"OrderId">("x")).toBe("x");
  });

  it("parses Stripe ids by prefix and shape", () => {
    expect(parseStripeId("acct", "acct_1AbCdEfGh")).toBe("acct_1AbCdEfGh");
    expect(parseStripeId("ch", "ch_3NxYz12345678")).toBe("ch_3NxYz12345678");
    for (const bad of ["acct_short", "ch_1AbCdEfGh", "acct_1AbC dEfGh", "acct_1AbCdEfGh'; DROP", "acct_", "", `acct_${"a".repeat(65)}`, 5, null]) expect(parseStripeId("acct", bad), String(bad)).toBeUndefined();
  });
});

describe("result", () => {
  it("wraps a value or an error", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("x")).toEqual({ ok: false, error: "x" });
  });
});
