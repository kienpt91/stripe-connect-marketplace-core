import { afterAll, beforeAll } from "vitest";
import { accountBalance, totalsOf, ACCOUNTS, type Account, type Entry } from "../../src/domain/ledger.js";
import type { Actor, Database, ObjectKind, SellerRecord } from "../../src/application/store.js";
import { makeWorld, type World } from "../support/world.js";

/** A database a scenario group runs on, and how to dispose of it. */
export interface DbHandle {
  readonly db: Database;
  close(): Promise<void>;
}
export type DbFactory = () => Promise<DbHandle>;

export const system: Actor = { kind: "system" };
export const operator: Actor = { kind: "operator" };
export const asSeller = (seller: Pick<SellerRecord, "id">): Actor => ({ kind: "seller", sellerId: seller.id });

/** One database for a whole group of scenarios; each scenario makes its own world (its own Stripe, its own ids) on it. */
export function sharedDb(open: DbFactory): () => World {
  let handle: DbHandle | undefined;
  beforeAll(async () => {
    handle = await open();
  });
  afterAll(async () => {
    await handle?.close();
  });
  return () => {
    if (handle === undefined) throw new Error("the database is not open");
    return makeWorld(handle.db);
  };
}

/** A world on a database of its own, for scenarios that look at the whole ledger. */
export async function freshWorld(open: DbFactory): Promise<{ world: World; close: () => Promise<void> }> {
  const handle = await open();
  return { world: makeWorld(handle.db), close: () => handle.close() };
}

/** The balance of every account over the whole ledger, per currency (the operator's view). */
export async function platformBalances(world: World): Promise<Record<string, number>> {
  const rows = await world.db.transaction(operator, (tx) => tx.ledger.totals());
  const out: Record<string, number> = {};
  for (const row of rows) out[`${row.currency}/${row.account}`] = accountBalance(row.account as Account, row);
  return out;
}

export const sellerBalance = (world: World, seller: Pick<SellerRecord, "id">): Promise<Record<string, number>> => world.db.transaction(operator, (tx) => tx.ledger.balanceOf(seller.id));

export const orderOf = (world: World, id: string) => world.db.transaction(system, (tx) => tx.orders.get(id as never));
export const paymentOf = (world: World, chargeId: string) => world.db.transaction(system, (tx) => tx.payments.get(chargeId));
export const objectOf = (world: World, kind: ObjectKind, id: string) => world.db.transaction(system, (tx) => tx.objects.get(kind, id));
export const eventOf = async (world: World, id: string) => world.db.transaction(system, async (tx) => (await tx.events.listDeferred()).find((e) => e.id === id));

/** The ledger entries of one seller (the operator's view, cut to the seller so that scenarios can share a database). */
export async function entriesOf(world: World, seller: Pick<SellerRecord, "id">): Promise<Entry[]> {
  return (await world.db.transaction(operator, (tx) => tx.ledger.entries())).filter((e) => e.sellerId === seller.id);
}

/** The balance of every account over the entries of one seller, per currency. */
export async function accountsOf(world: World, seller: Pick<SellerRecord, "id">): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const entries = await entriesOf(world, seller);
  for (const currency of new Set(entries.map((e) => e.currency))) {
    const lines = entries.filter((e) => e.currency === currency).flatMap((e) => e.lines);
    for (const account of ACCOUNTS) out[`${currency}/${account}`] = accountBalance(account, totalsOf(lines, account));
  }
  return out;
}
