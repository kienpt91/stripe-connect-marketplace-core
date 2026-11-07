import { parseStripeId } from "../domain/ids.js";
import { parseStripeEvent, type Fact, type ParsedEvent } from "../domain/stripe-events.js";
import { applyFact, type Observation, type Outcome } from "./apply.js";
import { GatewayError, type Deps } from "./ports.js";
import type { EventStatus, Tx } from "./store.js";

export interface IngestResult {
  /** what happened to the event; `duplicate` is an event id that was recorded before and changed nothing now */
  readonly status: EventStatus | "duplicate";
  readonly eventId: string | null;
  readonly reason: string | null;
}

/** The lock key of the thing an event is about. Events of one charge, one payout or one account are applied one after the other. */
function subjectOf(event: ParsedEvent): string {
  const fact: Fact = event.fact;
  switch (fact.kind) {
    case "charge_succeeded": return fact.charge.id;
    case "refund": return fact.refund.chargeId;
    case "dispute": return fact.dispute.chargeId;
    case "transfer": return fact.transfer.sourceCharge ?? `transfer:${fact.transfer.id}`;
    case "payout": return `payout:${fact.payout.id}`;
    case "account_updated": return `account:${fact.accountId}`;
    case "ignored": return `event:${event.id}`;
  }
}

/**
 * Takes one verified webhook event (the signature has been checked by the caller, on the raw bytes) and applies it exactly once.
 *
 * - The event id is the idempotency key: an id that was recorded before changes nothing and answers `duplicate`.
 * - The event is recorded and applied in ONE transaction. If anything fails the whole thing rolls back, nothing is recorded and
 *   the caller answers 5xx so that Stripe sends it again.
 * - An event that depends on a charge that has not arrived yet is recorded as `deferred` and applied in the transaction that
 *   records the charge, whichever order they came in.
 * - An event that cannot be trusted (an object that does not parse, money sent to the wrong account) is recorded as `rejected`
 *   with the reason and changes no balance.
 * - `account.updated` is a signal: the state is read from Stripe, because Stripe does not promise the order of events and the
 *   snapshot inside an old event can be older than the one already applied.
 */
export async function ingestEvent(deps: Deps, body: unknown): Promise<IngestResult> {
  const parsed = parseStripeEvent(body);
  if (!parsed.ok) return recordUnreadable(deps, body, parsed.error);
  const event = parsed.value;
  const system = { kind: "system" } as const;

  // an id that is already recorded costs one read: no call to Stripe, no lock. An account that is not a seller of ours needs no call either.
  const before = await deps.db.transaction(system, async (tx) => ({
    duplicate: await tx.events.exists(event.id),
    seller: event.fact.kind === "account_updated" ? await tx.sellers.getByAccount(event.fact.accountId) : undefined,
  }));
  if (before.duplicate) return { status: "duplicate", eventId: event.id, reason: null };

  let observation: Observation | undefined;
  if (event.fact.kind === "account_updated" && before.seller !== undefined) {
    // read before the transaction: a slow network call must not hold a database transaction open
    const observedAt = deps.clock.now();
    const snapshot = await deps.stripe.retrieveAccount(event.fact.accountId);
    if (snapshot.accountId !== event.fact.accountId) throw new GatewayError("unknown", "the account answered is not the one asked for");
    observation = { snapshot, observedAt };
  }

  const subject = subjectOf(event);
  const result = await deps.db.transaction(system, async (tx): Promise<IngestResult> => {
    await tx.lock(subject);
    if (await tx.events.exists(event.id)) return { status: "duplicate", eventId: event.id, reason: null };
    const outcome = await applyFact(tx, event.id, event.fact, observation);
    await tx.events.insert({
      id: event.id, type: event.type, account: event.account, subject, receivedAt: deps.clock.now(), status: outcome.status, reason: outcome.reason, payload: body,
    });
    if (event.fact.kind === "charge_succeeded" && outcome.status === "applied") await applyDeferred(tx, event.fact.charge.id, deps);
    return { status: outcome.status, eventId: event.id, reason: outcome.reason };
  });
  deps.logger.info("webhook.event", { id: event.id, type: event.type, status: result.status, ...(result.reason === null ? {} : { reason: result.reason }) });
  return result;
}

/** An event whose object cannot be read. If it has an id it is recorded as rejected, so that it is seen and is not retried for ever. */
async function recordUnreadable(deps: Deps, body: unknown, reason: string): Promise<IngestResult> {
  const id = typeof body === "object" && body !== null && !Array.isArray(body) ? parseStripeId("evt", (body as Record<string, unknown>)["id"]) : undefined;
  if (id === undefined) {
    deps.logger.warn("webhook.unreadable", { reason });
    return { status: "rejected", eventId: null, reason };
  }
  const type = typeof (body as Record<string, unknown>)["type"] === "string" ? String((body as Record<string, unknown>)["type"]).slice(0, 100) : "unknown";
  return deps.db.transaction({ kind: "system" }, async (tx): Promise<IngestResult> => {
    await tx.lock(`event:${id}`);
    if (await tx.events.exists(id)) return { status: "duplicate", eventId: id, reason: null };
    await tx.events.insert({ id, type, account: null, subject: `event:${id}`, receivedAt: deps.clock.now(), status: "rejected", reason, payload: body });
    deps.logger.warn("webhook.unreadable", { id, reason });
    return { status: "rejected", eventId: id, reason };
  });
}

/** Applies the events that were waiting for a charge, now that it is recorded. Runs inside the transaction that recorded it. */
async function applyDeferred(tx: Tx, chargeId: string, deps: Deps): Promise<number> {
  let count = 0;
  for (const waiting of await tx.events.deferredFor(chargeId)) {
    const parsed = parseStripeEvent(waiting.payload);
    let outcome: Outcome;
    if (!parsed.ok) outcome = { status: "rejected", reason: parsed.error };
    else {
      const next = await applyFact(tx, waiting.id, parsed.value.fact, undefined);
      outcome = next.status === "applied" ? { status: "applied", reason: "applied after the charge arrived" } : next;
    }
    await tx.events.setOutcome(waiting.id, outcome.status, outcome.reason);
    if (outcome.status !== "deferred") count += 1;
    deps.logger.info("webhook.deferred_applied", { id: waiting.id, status: outcome.status });
  }
  return count;
}

/**
 * Tries every deferred event again, for events that are waiting for a charge whose own event was lost and that has since been
 * recorded some other way. Returns how many left the deferred state. Safe to run at any time and from several processes.
 */
export async function retryDeferred(deps: Deps): Promise<number> {
  const system = { kind: "system" } as const;
  const subjects = await deps.db.transaction(system, async (tx) => [...new Set((await tx.events.listDeferred()).map((e) => e.subject))]);
  let moved = 0;
  for (const subject of subjects) {
    moved += await deps.db.transaction(system, async (tx) => {
      await tx.lock(subject);
      return applyDeferred(tx, subject, deps);
    });
  }
  return moved;
}
