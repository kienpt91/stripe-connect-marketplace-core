import type { SellerId } from "../domain/ids.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Deps } from "./ports.js";
import type { Actor, OrderRecord, StoredLine } from "./store.js";

export type ViewError = "forbidden";

export interface LedgerPage {
  readonly lines: readonly StoredLine[];
  /** pass this as `afterSeq` for the next page; null when there is none */
  readonly next: number | null;
  /** what the platform owes the seller now, per currency */
  readonly balance: Readonly<Record<string, number>>;
}

/**
 * A seller's own ledger: the lines of their own accounts, a page at a time. There are three locks on this door, and each one has a
 * test: (1) here, a seller asking for somebody else's ledger is refused; (2) the query filters on the seller id; (3) the database
 * role of a seller only sees rows whose seller id is theirs, whatever the query says.
 */
export async function sellerLedger(deps: Deps, actor: Actor, sellerId: SellerId, page: { afterSeq?: number; limit?: number } = {}): Promise<Result<LedgerPage, ViewError>> {
  if (actor.kind === "seller" && actor.sellerId !== sellerId) return err("forbidden");
  if (actor.kind === "system") return err("forbidden");
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 200);
  const afterSeq = Math.max(Math.trunc(page.afterSeq ?? 0), 0);
  return ok(
    await deps.db.transaction(actor, async (tx) => {
      const lines = await tx.ledger.linesFor(sellerId, { afterSeq, limit: limit + 1 });
      const shown = lines.slice(0, limit);
      return { lines: shown, next: lines.length > limit ? (shown[shown.length - 1]?.seq ?? null) : null, balance: await tx.ledger.balanceOf(sellerId) };
    }),
  );
}

/** A seller's orders, newest first. Row level security is what keeps another seller's orders out; the filter repeats it. */
export async function sellerOrders(deps: Deps, actor: Actor, sellerId: SellerId): Promise<Result<readonly OrderRecord[], ViewError>> {
  if (actor.kind === "seller" && actor.sellerId !== sellerId) return err("forbidden");
  if (actor.kind === "system") return err("forbidden");
  return ok(await deps.db.transaction(actor, (tx) => tx.orders.listForSeller(sellerId)));
}
