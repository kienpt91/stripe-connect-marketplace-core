import { describe, expect, it } from "vitest";
import {
  accountBalance, disputeLostEntry, disputeOpenedEntry, disputeWonEntry, isSellerAccount, NORMAL_SIDE, payoutEntry, refundEntry, reversalOf, saleEntry, sumSide, totalsOf, validateEntry,
  ACCOUNTS, type Entry,
} from "../../src/domain/ledger.js";
import { asId } from "../../src/domain/ids.js";
import { int, rng } from "../support/random.js";

const sellerId = asId<"SellerId">("11111111-1111-4111-8111-111111111111");
const common = { sellerId, currency: "usd" as const, occurredAt: 1_762_000_000_000 };

function balanced(entry: Entry): void {
  expect(validateEntry(entry).ok, entry.postingKey).toBe(true);
  expect(sumSide(entry.lines, "debit")).toBe(sumSide(entry.lines, "credit"));
}

describe("the chart of accounts", () => {
  it("has a normal side for every account and one seller-owned account", () => {
    for (const a of ACCOUNTS) expect(["debit", "credit"]).toContain(NORMAL_SIDE[a]);
    expect(ACCOUNTS.filter(isSellerAccount)).toEqual(["seller_balance"]);
  });
});

describe("entries", () => {
  it("a sale credits the seller the net and the platform the fee, and debits Stripe the whole charge", () => {
    const e = saleEntry({ ...common, chargeId: "ch_1AbCdEfGh", amount: 1000, fee: 130 });
    expect(e.postingKey).toBe("sale:ch_1AbCdEfGh");
    expect(e.lines).toEqual([
      { account: "stripe_funds", side: "debit", amount: 1000 },
      { account: "seller_balance", side: "credit", amount: 870 },
      { account: "platform_fees", side: "credit", amount: 130 },
    ]);
    balanced(e);
  });

  it("leaves out a line of zero, so a sale without a fee still balances", () => {
    const e = saleEntry({ ...common, chargeId: "ch_1AbCdEfGh", amount: 1000, fee: 0 });
    expect(e.lines).toHaveLength(2);
    balanced(e);
  });

  it("a refund takes the seller's part and the platform's part back and credits Stripe out", () => {
    const e = refundEntry({ ...common, refundId: "re_1AbCdEfGh", amount: 500, feePart: 65, absorbed: 0 });
    expect(e.lines).toEqual([
      { account: "seller_balance", side: "debit", amount: 435 },
      { account: "platform_fees", side: "debit", amount: 65 },
      { account: "stripe_funds", side: "credit", amount: 500 },
    ]);
    balanced(e);
    // a lost dispute had already taken 120 of the 500 from the seller and the fee: the platform bears them
    const overlapped = refundEntry({ ...common, refundId: "re_1AbCdEfGh", amount: 500, feePart: 40, absorbed: 120 });
    expect(overlapped.lines).toEqual([
      { account: "seller_balance", side: "debit", amount: 340 },
      { account: "platform_fees", side: "debit", amount: 160 },
      { account: "stripe_funds", side: "credit", amount: 500 },
    ]);
    balanced(overlapped);
  });

  it("a dispute is held aside when opened, reinstated when won, and charged to seller and platform when lost", () => {
    const open = disputeOpenedEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: 1000 });
    expect(open.postingKey).toBe("dispute:du_1AbCdEfGh:open");
    expect(open.lines).toEqual([{ account: "disputed_funds", side: "debit", amount: 1000 }, { account: "stripe_funds", side: "credit", amount: 1000 }]);
    const won = disputeWonEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: 1000 });
    expect(won.lines).toEqual([{ account: "stripe_funds", side: "debit", amount: 1000 }, { account: "disputed_funds", side: "credit", amount: 1000 }]);
    const lost = disputeLostEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: 1000, feePart: 130, absorbed: 0 });
    expect(lost.lines).toEqual([
      { account: "seller_balance", side: "debit", amount: 870 },
      { account: "platform_fees", side: "debit", amount: 130 },
      { account: "disputed_funds", side: "credit", amount: 1000 },
    ]);
    for (const e of [open, won, lost]) balanced(e);
  });

  it("a lost dispute puts the part a refund had already taken on the platform, and nothing on the seller when no sale is left", () => {
    const partly = disputeLostEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: 1000, feePart: 40, absorbed: 600 });
    expect(partly.lines).toEqual([
      { account: "seller_balance", side: "debit", amount: 360 },
      { account: "platform_fees", side: "debit", amount: 640 },
      { account: "disputed_funds", side: "credit", amount: 1000 },
    ]);
    const wholly = disputeLostEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: 1000, feePart: 0, absorbed: 1000 });
    expect(wholly.lines).toEqual([{ account: "platform_fees", side: "debit", amount: 1000 }, { account: "disputed_funds", side: "credit", amount: 1000 }]);
    for (const e of [partly, wholly]) balanced(e);
  });

  it("a payout moves the seller's balance out of Stripe", () => {
    const e = payoutEntry({ ...common, payoutId: "po_1AbCdEfGh", amount: 700 });
    expect(e.lines).toEqual([{ account: "seller_balance", side: "debit", amount: 700 }, { account: "stripe_funds", side: "credit", amount: 700 }]);
    balanced(e);
  });

  it("a reversal swaps every side, keeps the amounts and gets its own posting key", () => {
    const payout = payoutEntry({ ...common, payoutId: "po_1AbCdEfGh", amount: 700 });
    const back = reversalOf(payout, "payout_reversal", 5);
    expect(back.postingKey).toBe("payout:po_1AbCdEfGh:reversal");
    expect(back.kind).toBe("payout_reversal");
    expect(back.occurredAt).toBe(5);
    expect(back.lines).toEqual([{ account: "seller_balance", side: "credit", amount: 700 }, { account: "stripe_funds", side: "debit", amount: 700 }]);
    balanced(back);
    const refund = refundEntry({ ...common, refundId: "re_1AbCdEfGh", amount: 500, feePart: 65, absorbed: 120 });
    const lines = [...refund.lines, ...reversalOf(refund, "refund_reversal", 9).lines];
    for (const account of ACCOUNTS) expect(accountBalance(account, totalsOf(lines, account))).toBe(0);
  });

  it("every entry the builders make balances, for any split of any amount", () => {
    const next = rng(5);
    for (let i = 0; i < 500; i++) {
      const amount = int(next, 2, 99_999_999);
      const fee = int(next, 0, amount - 1);
      const part = int(next, 1, amount);
      const feePart = int(next, 0, Math.min(fee, part));
      balanced(saleEntry({ ...common, chargeId: "ch_1AbCdEfGh", amount, fee }));
      const absorbed = int(next, 0, part - feePart);
      balanced(refundEntry({ ...common, refundId: "re_1AbCdEfGh", amount: part, feePart, absorbed }));
      balanced(disputeLostEntry({ ...common, disputeId: "du_1AbCdEfGh", amount: part, feePart, absorbed }));
    }
  });
});

describe("validateEntry", () => {
  const good = payoutEntry({ ...common, payoutId: "po_1AbCdEfGh", amount: 700 });

  it("refuses an entry with fewer than two lines", () => {
    expect(validateEntry({ ...good, lines: [] })).toEqual({ ok: false, error: "no_lines" });
    expect(validateEntry({ ...good, lines: [{ account: "stripe_funds", side: "debit", amount: 1 }] })).toEqual({ ok: false, error: "no_lines" });
  });

  it("refuses an amount that is not a positive whole number", () => {
    for (const amount of [0, -1, 1.5, NaN, 2 ** 53]) {
      const lines = [{ account: "seller_balance", side: "debit", amount }, { account: "stripe_funds", side: "credit", amount }] as const;
      expect(validateEntry({ ...good, lines }), String(amount)).toEqual({ ok: false, error: "invalid_amount" });
    }
  });

  it("refuses an entry whose debits and credits differ by even one minor unit", () => {
    const lines = [{ account: "seller_balance", side: "debit", amount: 700 }, { account: "stripe_funds", side: "credit", amount: 699 }] as const;
    expect(validateEntry({ ...good, lines })).toEqual({ ok: false, error: "unbalanced" });
  });
});

describe("balances", () => {
  it("are positive on an account's normal side and negative on the other", () => {
    const lines = [
      ...saleEntry({ ...common, chargeId: "ch_1AbCdEfGh", amount: 1000, fee: 130 }).lines,
      ...payoutEntry({ ...common, payoutId: "po_1AbCdEfGh", amount: 900 }).lines,
    ];
    expect(accountBalance("stripe_funds", totalsOf(lines, "stripe_funds"))).toBe(100);
    expect(accountBalance("seller_balance", totalsOf(lines, "seller_balance"))).toBe(-30); // paid out more than owed
    expect(accountBalance("platform_fees", totalsOf(lines, "platform_fees"))).toBe(130);
    expect(accountBalance("disputed_funds", totalsOf(lines, "disputed_funds"))).toBe(0);
  });
});
