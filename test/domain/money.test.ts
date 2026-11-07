import { describe, expect, it } from "vitest";
import { addMinor, allocateReversal, formatMinor, isMinor, MAX_CHARGE_MINOR, parseCurrency, parseFeePolicy, splitCharge, type FeePolicy } from "../../src/domain/money.js";
import { int, partition, rng, shuffle } from "../support/random.js";

const policy: FeePolicy = { percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 };
const split = (amount: number, p: FeePolicy = policy) => {
  const r = splitCharge(p, amount);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("currencies and formatting", () => {
  it("knows the currencies it has an exponent for and nothing else", () => {
    expect(parseCurrency("usd")).toBe("usd");
    expect(parseCurrency("jpy")).toBe("jpy");
    for (const bad of ["USD", "xxx", "constructor", "toString", "", 3, null, undefined]) expect(parseCurrency(bad)).toBeUndefined();
  });

  it("formats integers of the minor unit without floating point", () => {
    expect(formatMinor(1234, "usd")).toBe("12.34 USD");
    expect(formatMinor(5, "usd")).toBe("0.05 USD");
    expect(formatMinor(0, "eur")).toBe("0.00 EUR");
    expect(formatMinor(1234, "jpy")).toBe("1234 JPY");
    expect(formatMinor(-250, "gbp")).toBe("-2.50 GBP");
    expect(formatMinor(99_999_999, "usd")).toBe("999999.99 USD");
  });

  it("accepts only whole non-negative safe numbers as minor units and refuses an overflowing sum", () => {
    for (const ok of [0, 1, 99_999_999, Number.MAX_SAFE_INTEGER]) expect(isMinor(ok)).toBe(true);
    for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, "5", null, undefined, 1n]) expect(isMinor(bad)).toBe(false);
    expect(addMinor(2, 3)).toBe(5);
    expect(() => addMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow(RangeError);
  });
});

describe("the fee policy", () => {
  it("accepts a sane policy and refuses the rest", () => {
    expect(parseFeePolicy({ percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 }).ok).toBe(true);
    expect(parseFeePolicy({ percentBps: 0, fixedMinor: 0, minimumChargeMinor: 1 }).ok).toBe(true);
    const bad = [
      { percentBps: 10_001, fixedMinor: 0, minimumChargeMinor: 1 },
      { percentBps: -1, fixedMinor: 0, minimumChargeMinor: 1 },
      { percentBps: 1.5, fixedMinor: 0, minimumChargeMinor: 1 },
      { percentBps: 10, fixedMinor: -1, minimumChargeMinor: 1 },
      { percentBps: 10, fixedMinor: MAX_CHARGE_MINOR + 1, minimumChargeMinor: 1 },
      { percentBps: 10, fixedMinor: 0, minimumChargeMinor: 0 },
      { percentBps: 10, fixedMinor: 0, minimumChargeMinor: MAX_CHARGE_MINOR + 1 },
      { percentBps: "10", fixedMinor: 0, minimumChargeMinor: 1 },
    ];
    for (const p of bad) expect(parseFeePolicy(p).ok, JSON.stringify(p)).toBe(false);
  });
});

describe("splitCharge: the application fee in integers", () => {
  it("is a percentage in basis points plus a fixed amount", () => {
    expect(split(1000)).toEqual({ fee: 130, sellerNet: 870 });
    expect(split(100)).toEqual({ fee: 40, sellerNet: 60 });
    expect(split(99_999_999)).toEqual({ fee: 10_000_030, sellerNet: 89_999_969 });
  });

  it("rounds half up at the boundary and down below it", () => {
    const five: FeePolicy = { percentBps: 500, fixedMinor: 0, minimumChargeMinor: 1 };
    expect(split(30, five).fee).toBe(2); // 1.50 -> 2
    expect(split(29, five).fee).toBe(1); // 1.45 -> 1
    expect(split(31, five).fee).toBe(2); // 1.55 -> 2
    expect(split(10, five).fee).toBe(1); // 0.50 -> 1
    expect(split(9, five).fee).toBe(0); // 0.45 -> 0
    expect(split(333, five).fee).toBe(17); // 16.65 -> 17
    const third: FeePolicy = { percentBps: 3333, fixedMinor: 0, minimumChargeMinor: 1 };
    expect(split(3, third).fee).toBe(1); // 0.9999 -> 1
    expect(split(2, third).fee).toBe(1); // 0.6666 -> 1
    expect(split(1, { ...third, percentBps: 4999 }).fee).toBe(0); // 0.4999 -> 0
    expect(split(2, { ...third, percentBps: 2500 }).fee).toBe(1); // 0.5000 -> 1
  });

  it("never produces a fraction: fee and net are whole, positive and add up to the charge", () => {
    const next = rng(20261107);
    for (let i = 0; i < 2000; i++) {
      const p: FeePolicy = { percentBps: int(next, 0, 3000), fixedMinor: int(next, 0, 80), minimumChargeMinor: int(next, 100, 500) };
      const amount = int(next, p.minimumChargeMinor, i % 10 === 0 ? MAX_CHARGE_MINOR : 100_000);
      const r = splitCharge(p, amount);
      if (!r.ok) {
        expect(r.error).toBe("fee_not_below_amount");
        continue;
      }
      expect(Number.isSafeInteger(r.value.fee) && r.value.fee >= 0, `seed 20261107 #${i}`).toBe(true);
      expect(r.value.sellerNet).toBeGreaterThanOrEqual(1);
      expect(r.value.fee + r.value.sellerNet).toBe(amount);
      // within half a minor unit of the exact percentage, plus the fixed part
      expect(Math.abs(r.value.fee - p.fixedMinor - (amount * p.percentBps) / 10_000)).toBeLessThanOrEqual(0.5);
    }
  });

  it("refuses what it cannot split exactly", () => {
    const bad = (amount: number, p: FeePolicy = policy) => {
      const r = splitCharge(p, amount);
      return r.ok ? "ok" : r.error;
    };
    for (const amount of [0, -5, 1.5, NaN, Infinity, 2 ** 53, 0.1 + 0.2]) expect(bad(amount)).toBe("invalid_amount");
    expect(bad(99)).toBe("amount_below_minimum");
    expect(bad(MAX_CHARGE_MINOR + 1)).toBe("amount_above_maximum");
  });

  it("refuses a charge whose fee would leave the seller nothing instead of clipping the fee", () => {
    const greedy: FeePolicy = { percentBps: 10_000, fixedMinor: 0, minimumChargeMinor: 1 };
    expect(splitCharge(greedy, 500)).toEqual({ ok: false, error: "fee_not_below_amount" });
    const fixed: FeePolicy = { percentBps: 0, fixedMinor: 100, minimumChargeMinor: 50 };
    expect(splitCharge(fixed, 100)).toEqual({ ok: false, error: "fee_not_below_amount" });
    expect(splitCharge(fixed, 101)).toEqual({ ok: true, value: { fee: 100, sellerNet: 1 } });
  });

  it("works for a zero-decimal currency the same way, since it only sees integers", () => {
    const yen: FeePolicy = { percentBps: 900, fixedMinor: 0, minimumChargeMinor: 50 };
    expect(split(1234, yen)).toEqual({ fee: 111, sellerNet: 1123 }); // 111.06 -> 111
    expect(formatMinor(111, "jpy")).toBe("111 JPY");
  });

  it("charges zero commission when the policy says so", () => {
    expect(split(5000, { percentBps: 0, fixedMinor: 0, minimumChargeMinor: 1 })).toEqual({ fee: 0, sellerNet: 5000 });
  });
});

describe("allocateReversal: refunds and lost disputes between platform and seller", () => {
  const sale = { amount: 1000, fee: 130 };
  const alloc = (taken: { amount: number; fee: number }, amount: number, s = sale) => {
    const r = allocateReversal(s, taken, amount);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("takes the platform's part in proportion to the sale", () => {
    expect(alloc({ amount: 0, fee: 0 }, 1000)).toEqual({ feePart: 130, sellerPart: 870 });
    expect(alloc({ amount: 0, fee: 0 }, 500)).toEqual({ feePart: 65, sellerPart: 435 });
    expect(alloc({ amount: 0, fee: 0 }, 1)).toEqual({ feePart: 0, sellerPart: 1 });
  });

  it("makes the parts of any series of refunds add up to exactly the fee and the net", () => {
    const next = rng(7);
    for (let i = 0; i < 500; i++) {
      const amount = int(next, 2, i % 25 === 0 ? MAX_CHARGE_MINOR : 5_000);
      const fee = int(next, 0, amount - 1);
      const parts = partition(next, amount, int(next, 1, Math.min(amount, 12)));
      let taken = { amount: 0, fee: 0 };
      let feeTotal = 0;
      let sellerTotal = 0;
      for (const part of parts) {
        const r = alloc(taken, part, { amount, fee });
        expect(r.feePart).toBeGreaterThanOrEqual(0);
        expect(r.sellerPart).toBeGreaterThanOrEqual(0);
        expect(r.feePart + r.sellerPart).toBe(part);
        taken = { amount: taken.amount + part, fee: taken.fee + r.feePart };
        // the cumulative fee reversed is always floor(fee * taken / amount), whatever the parts were
        expect(taken.fee, `case ${i}`).toBe(Number((BigInt(fee) * BigInt(taken.amount)) / BigInt(amount)));
        feeTotal += r.feePart;
        sellerTotal += r.sellerPart;
      }
      expect(feeTotal).toBe(fee);
      expect(sellerTotal).toBe(amount - fee);
    }
  });

  it("gives the same total whichever order the same refunds are applied in", () => {
    const next = rng(99);
    for (let i = 0; i < 200; i++) {
      const amount = int(next, 50, 10_000);
      const fee = int(next, 0, amount - 1);
      const parts = partition(next, amount, int(next, 2, 8));
      const run = (order: readonly number[]) => {
        let taken = { amount: 0, fee: 0 };
        for (const part of order) {
          const r = alloc(taken, part, { amount, fee });
          taken = { amount: taken.amount + part, fee: taken.fee + r.feePart };
        }
        return taken;
      };
      expect(run(shuffle(next, parts))).toEqual(run(parts));
    }
  });

  it("is exact where a floating point product would not be", () => {
    const big = { amount: 99_999_999, fee: 99_999_998 };
    expect(big.fee * 99_999_998).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    const first = alloc({ amount: 0, fee: 0 }, 99_999_998, big);
    expect(first.feePart).toBe(Number((99_999_998n * 99_999_998n) / 99_999_999n));
    const last = alloc({ amount: 99_999_998, fee: first.feePart }, 1, big);
    expect(first.feePart + last.feePart).toBe(big.fee);
  });

  it("refuses to take back more than is left, and nonsense amounts", () => {
    expect(allocateReversal(sale, { amount: 900, fee: 117 }, 101)).toEqual({ ok: false, error: "exceeds_remaining" });
    expect(allocateReversal(sale, { amount: 0, fee: 0 }, 1001)).toEqual({ ok: false, error: "exceeds_remaining" });
    for (const amount of [0, -1, 1.5, NaN, Infinity]) expect(allocateReversal(sale, { amount: 0, fee: 0 }, amount)).toEqual({ ok: false, error: "invalid_amount" });
  });

  it("stays inside the amount and the fee that is left even when the totals taken have drifted", () => {
    // a refund that failed after the next one was applied can leave the fee taken a unit off the cumulative rule
    const r = alloc({ amount: 500, fee: 130 }, 500);
    expect(r.feePart).toBe(0);
    expect(r.sellerPart).toBe(500);
    const s = alloc({ amount: 0, fee: 0 }, 1, { amount: 2, fee: 1 });
    expect(s.feePart + s.sellerPart).toBe(1);
  });
});
