import { ingestEvent, type IngestResult } from "../../src/application/ingest.js";
import { startCheckout, type Checkout, type CheckoutRequest } from "../../src/application/checkout.js";
import { registerSeller } from "../../src/application/sellers.js";
import type { Deps, Logger } from "../../src/application/ports.js";
import type { Database, SellerRecord } from "../../src/application/store.js";
import type { FeePolicy } from "../../src/domain/money.js";
import { FakeStripe } from "../../src/infrastructure/stripe/fake-stripe.js";
import { ManualClock, SequentialIds } from "../../src/infrastructure/system.js";
import { chargeObject, event } from "./stripe-fixtures.js";

export const START = Date.UTC(2026, 10, 7, 9, 0, 0);
export const FEES: FeePolicy = { percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 };
export const ORIGIN = "https://market.example";

export interface Captured {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** Everything a scenario needs: a database, the fake Stripe, a clock that only moves when told to, and the use cases' dependencies. */
export interface World {
  readonly db: Database;
  readonly clock: ManualClock;
  readonly stripe: FakeStripe;
  readonly deps: Deps;
  readonly logs: Captured[];
  readonly ids: SequentialIds;
}

let worlds = 0;

/** Every world has object ids of its own, so that scenarios can share one database. */
export function makeWorld(db: Database): World {
  worlds += 1;
  const clock = new ManualClock(START);
  const logs: Captured[] = [];
  const logger: Logger = {
    info: (event, fields) => void logs.push({ level: "info", event, fields }),
    warn: (event, fields) => void logs.push({ level: "warn", event, fields }),
    error: (event, fields) => void logs.push({ level: "error", event, fields }),
  };
  const stripe = new FakeStripe(clock, { idStart: worlds * 100_000 });
  const ids = new SequentialIds((0xa0000000 + worlds).toString(16));
  return { db, clock, stripe, logs, ids, deps: { db, clock, ids, stripe, logger, fees: FEES, appOrigin: ORIGIN } };
}

/** Delivers events to the ingestion use case one after the other, as a webhook endpoint would. */
export async function deliver(world: World, events: readonly unknown[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const event of events) results.push(await ingestEvent(world.deps, event));
  return results;
}

/** Delivers whatever the fake has produced so far. */
export async function deliverAll(world: World): Promise<IngestResult[]> {
  return deliver(world, world.stripe.takeEvents());
}

let sellerCounter = 0;
export function sellerUuid(n = ++sellerCounter): string {
  return `5e11e700-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A registered seller whose onboarding is complete, as far as the ledger knows: `account.updated` was delivered. */
export async function enabledSeller(world: World, sellerId: string = sellerUuid(), name = "Alba Ceramics"): Promise<SellerRecord> {
  const registered = await registerSeller(world.deps, { sellerId, displayName: name, country: "DE" });
  if (!registered.ok) throw new Error(registered.error);
  world.stripe.completeOnboarding(registered.value.accountId);
  await deliverAll(world);
  const seller = await world.db.transaction({ kind: "system" }, (tx) => tx.sellers.get(registered.value.id));
  if (seller?.state !== "enabled") throw new Error(`the seller is ${seller?.state ?? "missing"}`);
  return seller;
}

let keyCounter = 0;
export function checkoutRequest(seller: SellerRecord, amount: number, patch: Partial<Record<keyof CheckoutRequest, unknown>> = {}): CheckoutRequest {
  keyCounter += 1;
  return {
    sellerId: seller.id, buyerRef: "buyer-1001", amount, currency: "usd", description: "Hand-thrown mug", idempotencyKey: `purchase-${String(keyCounter).padStart(6, "0")}`,
    successPath: "/orders/done", cancelPath: "/orders/cancelled", ...patch,
  };
}

/** The id of the Checkout Session inside the URL the fake hands out. */
export function sessionOf(checkout: Checkout): string {
  const id = checkout.checkoutUrl.split("/").pop();
  if (id === undefined) throw new Error("no session in the URL");
  return id;
}

/** Starts a checkout, lets the buyer pay, delivers the events: returns the checkout and the charge. */
export async function sale(world: World, seller: SellerRecord, amount: number, patch: Partial<Record<keyof CheckoutRequest, unknown>> = {}): Promise<{ checkout: Checkout; chargeId: string; transferId: string }> {
  const started = await startCheckout(world.deps, checkoutRequest(seller, amount, patch));
  if (!started.ok) throw new Error(started.error);
  const paid = world.stripe.pay(sessionOf(started.value));
  await deliverAll(world);
  return { checkout: started.value, ...paid };
}

let handCounter = 0;
/** A `charge.succeeded` event written by hand (the fake only makes honest ones), for an order the seller has open. */
export function handCharge(seller: SellerRecord, order: { id: string; amount: number; fee: number }, patch: Record<string, unknown> = {}, envelope: { id?: string } = {}): Record<string, unknown> {
  handCounter += 1;
  return event(
    "charge.succeeded",
    chargeObject({ id: `ch_1Hand${String(handCounter).padStart(8, "0")}`, amount: order.amount, application_fee_amount: order.fee, transfer_data: { destination: seller.accountId }, metadata: { order_id: order.id }, ...patch }),
    envelope,
  );
}
