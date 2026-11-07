import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestEvent, retryDeferred } from "../../src/application/ingest.js";
import { startCheckout } from "../../src/application/checkout.js";
import { GatewayError } from "../../src/application/ports.js";
import type { Database, Tx } from "../../src/application/store.js";
import { payoutEntry, saleEntry } from "../../src/domain/ledger.js";
import { PostgresDatabase } from "../../src/infrastructure/postgres/database.js";
import { openPool } from "../support/connection-budget.js";
import { asAdmin, createTestDatabase, describeDb, waitFor, waitUntilBlockedOnLock, type TestDatabase } from "../support/pg.js";
import { insertEntry, seedWorld, W } from "../support/seed.js";
import { checkoutRequest, enabledSeller, makeWorld, sessionOf } from "../support/world.js";

const system = { kind: "system" } as const;
const operator = { kind: "operator" } as const;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

describeDb("the PostgreSQL adapter", () => {
  let database: TestDatabase;
  let db: PostgresDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
    await asAdmin(database, async (c) => {
      await seedWorld(c);
      // a deadlock is found after 100 ms here instead of a second
      await c.query(`ALTER DATABASE ${database.name} SET deadlock_timeout = '100ms'`);
    });
    db = openPool({ url: database.appUrl, poolMax: 10 });
  });
  afterAll(async () => {
    await db.close();
    await database.drop();
  });

  it("answers a ping and gives a transaction's result back", async () => {
    await expect(db.ping()).resolves.toBeUndefined();
    expect(await db.transaction(system, async (tx) => (await tx.sellers.list()).length)).toBe(2);
  });

  it("rolls everything back when the work throws, and the next transaction does not see it", async () => {
    await expect(
      db.transaction(system, async (tx) => {
        await tx.orders.setStatus(W.orderA as never, "refunded");
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect((await db.transaction(operator, (tx) => tx.orders.get(W.orderA as never)))?.status).toBe("paid");
  });

  it("never builds the role or the claim from what the caller passes", async () => {
    await expect(db.transaction({ kind: "admin" } as never, async (tx) => tx.sellers.list())).rejects.toThrow();
    const forged = { kind: "seller", sellerId: "x' OR '1'='1" } as never;
    await expect(db.transaction(forged, (tx) => tx.sellers.list())).rejects.toMatchObject({ code: "22P02" });
    await expect(db.transaction({ kind: "seller", sellerId: W.sellerA }, async (tx) => (await tx.sellers.list()).map((s) => s.id))).resolves.toEqual([W.sellerA]);
  });

  it("serialises transactions that take the same lock, and lets different locks run side by side", async () => {
    const order: string[] = [];
    const firstHolds = deferred();
    const firstHas = deferred();
    const first = db.transaction(system, async (tx) => {
      await tx.lock("charge:ch_1Serial00001");
      order.push("first has the lock");
      firstHas.resolve();
      await firstHolds.promise;
      order.push("first done");
    });
    await firstHas.promise;
    const second = db.transaction(system, async (tx) => {
      await tx.lock("charge:ch_1Serial00001");
      order.push("second has the lock");
    });
    const other = db.transaction(system, async (tx) => {
      await tx.lock("charge:ch_1Another0001");
      order.push("other has its own lock");
    });
    await other;
    // the second transaction is asked for in pg_locks: it is waiting for the first one's lock, and has not run
    await waitUntilBlockedOnLock(database, "the second transaction to wait for the lock of the first");
    expect(order).toEqual(["first has the lock", "other has its own lock"]);
    firstHolds.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first has the lock", "other has its own lock", "first done", "second has the lock"]);
  });

  it("gives up waiting for a lock after the lock timeout instead of hanging", async () => {
    const short = openPool({ url: database.appUrl, poolMax: 2, lockTimeoutMs: 200 });
    try {
      const held = deferred();
      const release = deferred();
      const holder = db.transaction(system, async (tx) => {
        await tx.lock("charge:ch_1Timeout0001");
        held.resolve();
        await release.promise;
      });
      await held.promise;
      await expect(short.transaction(system, (tx) => tx.lock("charge:ch_1Timeout0001"))).rejects.toMatchObject({ code: "55P03" });
      release.resolve();
      await holder;
    } finally {
      await short.close();
    }
  });

  describe("a deadlock", () => {
    const crossing = (attempts: number[], barrier: { arrive: () => Promise<void> }) => (mine: string, theirs: string) => (tx: Tx) => {
      attempts.push(1);
      const first = attempts.length <= 2;
      return (async () => {
        await tx.lock(mine);
        if (first) await barrier.arrive();
        await tx.lock(theirs);
      })();
    };

    function barrierOf(parties: number): { arrive: () => Promise<void> } {
      let waiting = 0;
      const all = deferred();
      return {
        arrive: () => {
          waiting += 1;
          if (waiting === parties) all.resolve();
          return all.promise;
        },
      };
    }

    it("is run again by the adapter: the loser's whole transaction repeats and both finish", async () => {
      const attempts: number[] = [];
      const work = crossing(attempts, barrierOf(2));
      await Promise.all([db.transaction(system, work("charge:ch_1DeadlockA01", "charge:ch_1DeadlockB01")), db.transaction(system, work("charge:ch_1DeadlockB01", "charge:ch_1DeadlockA01"))]);
      expect(attempts.length).toBe(3); // two first attempts, one of them repeated
    });

    it("is reported after the last attempt when the adapter may not retry", async () => {
      const single = openPool({ url: database.appUrl, poolMax: 2, maxAttempts: 1 });
      try {
        const attempts: number[] = [];
        const work = crossing(attempts, barrierOf(2));
        const results = await Promise.allSettled([
          single.transaction(system, work("charge:ch_1DeadlockC01", "charge:ch_1DeadlockD01")),
          single.transaction(system, work("charge:ch_1DeadlockD01", "charge:ch_1DeadlockC01")),
        ]);
        expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["40P01"]);
      } finally {
        await single.close();
      }
    });
  });

  it("refuses to read an amount a number cannot hold, and a currency the system does not know, instead of rounding or guessing", async () => {
    await asAdmin(database, async (c) => {
      await insertEntry(c, payoutEntry({ payoutId: "po_1HugeAmount01", sellerId: W.sellerB, currency: "usd", amount: 9_007_199_254_740_993, occurredAt: 5 }));
      await c.query("UPDATE orders SET currency = 'xyz' WHERE id = $1", [W.orderB]);
    });
    await expect(db.transaction(operator, (tx) => tx.ledger.entries())).rejects.toThrow(RangeError);
    await expect(db.transaction(operator, (tx) => tx.orders.get(W.orderB as never))).rejects.toThrow("not one this system knows");
  });

  it("keeps working after a connection is killed in the middle of a transaction, and reports an idle connection that dies", async () => {
    const errors: string[] = [];
    const fragile = new PostgresDatabase({ url: database.appUrl, poolMax: 2, onPoolError: (code) => errors.push(code) });
    try {
      await fragile.ping();
      await expect(
        fragile.transaction(system, async (tx) => {
          await tx.sellers.list();
          await asAdmin(database, (c) => c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'stripe-connect-marketplace-core' AND state = 'idle in transaction'"));
          await tx.sellers.list();
        }),
      ).rejects.toThrow();
      expect(errors).toContain("57P01"); // reported, not thrown at the process
      const reported = errors.length;
      await expect(fragile.ping()).resolves.toBeUndefined();
      // an idle connection that is terminated must not crash the process: the pool reports the code
      await asAdmin(database, (c) => c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'stripe-connect-marketplace-core' AND state = 'idle' AND pid <> pg_backend_pid()"));
      await waitFor("the pool to report the connection that was terminated while idle", () => errors.length > reported);
      await expect(fragile.ping()).resolves.toBeUndefined();
      expect(errors.length).toBeGreaterThan(reported);
      expect(errors.every((c) => c === "57P01" || c === "unknown")).toBe(true);
    } finally {
      await fragile.close();
    }
  });

  it("appends one entry when two connections post the same fact at the same moment", async () => {
    const entry = saleEntry({ chargeId: "ch_1PostedTwice01", sellerId: W.sellerA, currency: "usd", amount: 400, fee: 70, occurredAt: 7 });
    const post = () => db.transaction(system, (tx) => tx.ledger.post(entry, null));
    const results = await Promise.all([post(), post(), post(), post()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const lines = await asAdmin(database, (c) => c.query("SELECT count(*)::int AS n FROM ledger_lines l JOIN ledger_entries e ON e.seq = l.entry_seq WHERE e.posting_key = $1", [entry.postingKey]));
    expect(lines.rows[0]?.n).toBe(3);
  });

  it("refuses to post an entry that does not balance before it reaches the database", async () => {
    const entry = { ...saleEntry({ chargeId: "ch_1Unbalanced01", sellerId: W.sellerA, currency: "usd", amount: 400, fee: 70, occurredAt: 7 }), lines: [{ account: "stripe_funds", side: "debit", amount: 400 }, { account: "seller_balance", side: "credit", amount: 300 }] } as const;
    await expect(db.transaction(system, (tx) => tx.ledger.post(entry as never, null))).rejects.toThrow("ledger entry is not valid: unbalanced");
  });
});

describeDb("a refund and its charge arriving at the same moment", () => {
  let database: TestDatabase;
  let real: PostgresDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
    real = openPool({ url: database.appUrl, poolMax: 6 });
  });
  afterAll(async () => {
    await real.close();
    await database.drop();
  });

  /** A database whose transactions can pause where a refund has just found that its charge is not there, and whose lock can be switched off. */
  function racing(lockOn: boolean) {
    const reached = deferred();
    const gate = deferred();
    const db: Database = {
      ping: () => real.ping(),
      transaction: (actor, work) =>
        real.transaction(actor, (tx) =>
          work(
            Object.create(tx, {
              lock: { value: lockOn ? tx.lock.bind(tx) : async () => undefined },
              payments: {
                value: {
                  ...tx.payments,
                  get: async (chargeId: string) => {
                    const found = await tx.payments.get(chargeId);
                    if (found === undefined) {
                      reached.resolve();
                      await gate.promise;
                    }
                    return found;
                  },
                },
              },
            }) as Tx,
          ),
        ),
    };
    return { db, reached, gate };
  }

  async function setup() {
    const w = makeWorld(real);
    const seller = await enabledSeller(w);
    const started = await startCheckout(w.deps, checkoutRequest(seller, 10_000));
    if (!started.ok) throw new Error("checkout");
    const { chargeId } = w.stripe.pay(sessionOf(started.value));
    await w.stripe.createRefund({ chargeId, amount: 1_000, orderId: started.value.orderId, idempotencyKey: "refund-race-0001" });
    const events = w.stripe.takeEvents() as { type: string }[];
    const charge = events.find((e) => e.type === "charge.succeeded");
    const refund = events.find((e) => e.type === "refund.created");
    return { w, seller, chargeId, charge, refund };
  }

  it("is applied, in whichever order the two reach their locks, because both take the lock of the charge first", async () => {
    const { w, seller, chargeId, charge, refund } = await setup();
    const { db, reached, gate } = racing(true);
    const refundIn = ingestEvent({ ...w.deps, db }, refund);
    await reached.promise; // the refund holds the charge's lock and has found no payment
    let chargeFinished = false;
    const chargeIn = ingestEvent(w.deps, charge).finally(() => {
      chargeFinished = true;
    });
    await waitUntilBlockedOnLock(database, "the charge to wait for the lock the refund holds");
    expect(chargeFinished).toBe(false);
    gate.resolve();
    expect((await refundIn).status).toBe("deferred");
    expect((await chargeIn).status).toBe("applied");
    expect(await real.transaction(system, (tx) => tx.events.listDeferred())).toEqual([]);
    expect((await real.transaction(operator, (tx) => tx.payments.get(chargeId)))?.refunded).toBe(1_000);
    expect(await real.transaction(operator, (tx) => tx.ledger.balanceOf(seller.id))).toEqual({ usd: 8_970 - 897 });
  });

  it("is stranded without that lock: the control that shows what the lock is for, and `retryDeferred` is the way out", async () => {
    const { w, seller, chargeId, charge, refund } = await setup();
    const { db, reached, gate } = racing(false);
    const refundIn = ingestEvent({ ...w.deps, db }, refund);
    await reached.promise; // the refund has found no payment and is about to be recorded as waiting
    expect((await ingestEvent(w.deps, charge)).status).toBe("applied"); // the charge commits and looks for waiting events: there are none yet
    gate.resolve();
    expect((await refundIn).status).toBe("deferred");
    expect((await real.transaction(system, (tx) => tx.events.listDeferred())).map((e) => e.subject)).toEqual([chargeId]);
    expect((await real.transaction(operator, (tx) => tx.payments.get(chargeId)))?.refunded).toBe(0);
    expect(await retryDeferred(w.deps)).toBe(1);
    expect(await real.transaction(operator, (tx) => tx.ledger.balanceOf(seller.id))).toEqual({ usd: 8_970 - 897 });
  });

  it("does not leak a gateway failure into the database either: an account event whose read fails leaves no row", async () => {
    const w = makeWorld(real);
    const seller = await enabledSeller(w);
    w.stripe.requireInformation(seller.accountId, ["x"]);
    const [updated] = w.stripe.takeEvents();
    w.stripe.injectFailure("retrieveAccount", new GatewayError("unavailable", "down"));
    await expect(ingestEvent(w.deps, updated)).rejects.toMatchObject({ code: "unavailable" });
    expect(await real.transaction(system, (tx) => tx.events.exists((updated as { id: string }).id))).toBe(false);
  });
});
