import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { startCheckout, type CheckoutRequest } from "../application/checkout.js";
import { ingestEvent } from "../application/ingest.js";
import type { Deps } from "../application/ports.js";
import { reconcile, type ReconcileReport } from "../application/reconcile.js";
import { requestRefund } from "../application/refunds.js";
import { registerSeller } from "../application/sellers.js";
import { sellerLedger } from "../application/views.js";
import type { Actor, SellerRecord } from "../application/store.js";
import { formatMinor } from "../domain/money.js";
import { formatFindings } from "../domain/reconciliation.js";
import { compose, createDemoDatabase, FakeStripe, ManualClock, SequentialIds, signBody, webhookServer, type DemoDatabase } from "../composition/compose.js";

const FEES = { percentBps: 1000, fixedMinor: 30, minimumChargeMinor: 100 } as const;
const usd = (minor: number): string => formatMinor(minor, "usd");
const asSeller = (seller: Pick<SellerRecord, "id">): Actor => ({ kind: "seller", sellerId: seller.id });
const OPERATOR: Actor = { kind: "operator" };

type Event = { id: string; type: string } & Record<string, unknown>;

/** Runs the demonstration against a throwaway PostgreSQL server and prints what happened. Returns the process exit code: 0 when every claim held. */
export async function runDemo(serverAdminUrl: string, out: (line: string) => void): Promise<number> {
  const demo = await createDemoDatabase(serverAdminUrl);
  const secret = randomBytes(24).toString("hex");
  const clock = new ManualClock(Date.UTC(2026, 11, 9, 9, 0));
  const stripe = new FakeStripe(clock);
  const app = compose({ databaseUrl: demo.appUrl, fees: FEES, appOrigin: "https://market.example", stripe, write: () => undefined, clock, ids: new SequentialIds("d3000000"), poolMax: 10 });
  const claims: boolean[] = [];
  const hold = (ok: boolean, text: string): void => {
    claims.push(ok);
    out(`  ${ok ? "->" : "-> NOT HELD:"} ${text}`);
  };
  try {
    out("stripe-connect-marketplace-core demo");
    out(`database: PostgreSQL ${demo.serverVersion}, a throwaway server with no network; Stripe: an in-process fake, nothing leaves this process`);
    await sections(app.deps, stripe, clock, demo, secret, out, hold);
  } finally {
    await app.close();
    await demo.drop();
  }
  const failed = claims.filter((ok) => !ok).length;
  out("");
  out(failed === 0 ? `RESULT: every claim held (${claims.length} of ${claims.length}).` : `RESULT: ${failed} of ${claims.length} claims did NOT hold.`);
  return failed === 0 ? 0 : 1;
}

async function sections(deps: Deps, stripe: FakeStripe, clock: ManualClock, demo: DemoDatabase, secret: string, out: (line: string) => void, hold: (ok: boolean, text: string) => void): Promise<void> {
  const deliver = async (events: readonly unknown[]): Promise<string[]> => {
    const statuses: string[] = [];
    for (const e of events) statuses.push((await ingestEvent(deps, e)).status);
    return statuses;
  };
  const stateOf = async (seller: SellerRecord): Promise<string> => (await deps.db.transaction({ kind: "system" }, (tx) => tx.sellers.get(seller.id)))?.state ?? "missing";
  const register = async (id: string, name: string): Promise<SellerRecord> => {
    const r = await registerSeller(deps, { sellerId: id, displayName: name, country: "DE" });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const request = (seller: SellerRecord, amount: unknown, key: string, patch: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    sellerId: seller.id, buyerRef: "buyer-1001", amount, currency: "usd", description: "Hand-thrown mug set", idempotencyKey: key, successPath: "/orders/done", cancelPath: "/orders/cancelled", ...patch,
  });
  const buy = async (seller: SellerRecord, amount: number, key: string) => {
    const started = await startCheckout(deps, request(seller, amount, key));
    if (!started.ok) throw new Error(started.error);
    const paid = stripe.pay(started.value.checkoutUrl.split("/").pop() as string);
    return { ...started.value, ...paid };
  };
  const balance = async (seller: SellerRecord): Promise<number> => (await deps.db.transaction(OPERATOR, (tx) => tx.ledger.balanceOf(seller.id)))["usd"] ?? 0;
  const report = async (): Promise<ReconcileReport> => {
    const r = await reconcile(deps, { since: 0 });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const errorsOf = (r: ReconcileReport): string[] => r.findings.filter((f) => f.severity === "error").map((f) => f.kind).sort();

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("1. a seller's onboarding follows the account at Stripe");
  const alba = await register("a1ba0000-0000-4000-8000-000000000001", "Alba Ceramics");
  out(`  registered ${alba.displayName.padEnd(24)} state ${await stateOf(alba)}`);
  const early = await startCheckout(deps, request(alba, 4_999, "mug-set-0001"));
  out(`  checkout while new               refused: ${early.ok ? "ACCEPTED" : early.error}`);
  stripe.touch(alba.accountId);
  await deliver(stripe.takeEvents());
  out(`  account.updated, details missing -> ${await stateOf(alba)}`);
  stripe.submitForReview(alba.accountId);
  await deliver(stripe.takeEvents());
  const review = await stateOf(alba);
  const duringReview = await startCheckout(deps, request(alba, 4_999, "mug-set-0001"));
  out(`  details submitted, verifying     -> ${review}; checkout refused: ${duringReview.ok ? "ACCEPTED" : duringReview.error}`);
  stripe.completeOnboarding(alba.accountId);
  await deliver(stripe.takeEvents());
  out(`  verified, charges and payouts on -> ${await stateOf(alba)}`);
  hold(!early.ok && !duringReview.ok && (await stateOf(alba)) === "enabled", "no checkout until the account is enabled; the state is read from Stripe, not from the event");

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("2. checkout: a destination charge with the platform's fee in integers of the minor unit");
  const first = await buy(alba, 4_999, "mug-set-0001");
  out(`  order of ${usd(first.amount)}: fee ${usd(first.fee)} (10 % of 49.99 is 4.999, rounded half up to 5.00, plus 0.30), seller gets ${usd(first.sellerNet)}`);
  const again = await startCheckout(deps, request(alba, 4_999, "mug-set-0001"));
  out(`  the same idempotency key again   -> ${again.ok ? `${again.value.orderId === first.orderId ? "the same order" : "ANOTHER order"}, the same session: ${again.value.checkoutUrl === first.checkoutUrl}` : again.error}`);
  const refused: string[] = [];
  for (const amount of [49.99, 4_999.5, "4999", -4_999, 99]) {
    const r = await startCheckout(deps, request(alba, amount, `refused-${refused.length}-key`));
    refused.push(r.ok ? "ACCEPTED" : r.error);
  }
  out(`  amounts 49.99, 4999.5, "4999", -4999, 99 -> ${refused.join(", ")}`);
  const spoof = await startCheckout(deps, { ...request(alba, 10_000, "mug-set-0002"), fee: 1, applicationFee: 1 } as CheckoutRequest);
  out(`  a request that names its own fee -> the fee is ${spoof.ok ? usd(spoof.value.fee) : spoof.error} anyway (the request has no such field)`);
  hold(first.fee === 530 && first.sellerNet === 4_469 && again.ok && again.value.orderId === first.orderId && refused.every((r) => r !== "ACCEPTED") && spoof.ok && spoof.value.fee === 1_030, "the fee is the platform's, whole minor units, half up; a retried key is one order");

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("3. the webhook over HTTP on loopback: signature, replay, tampering, size");
  const server = webhookServer(deps, { secrets: [secret] });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: string, header: string | undefined): Promise<string> => {
    const r = await fetch(`${base}/webhooks/stripe`, { method: "POST", body, headers: { "content-type": "application/json", ...(header === undefined ? {} : { "stripe-signature": header }) } });
    return `HTTP ${r.status} ${await r.text()}`;
  };
  const [charge, transfer] = stripe.takeEvents() as [Event, Event];
  const chargeBody = JSON.stringify(charge);
  const sign = (body: string, at = clock.now(), key = secret): string => signBody(key, at, body);
  const lines: [string, string][] = [];
  lines.push(["charge.succeeded, signed", await post(chargeBody, sign(chargeBody))]);
  lines.push(["the same event delivered again", await post(chargeBody, sign(chargeBody))]);
  lines.push(["signed with another secret", await post(JSON.stringify(transfer), sign(JSON.stringify(transfer), clock.now(), randomBytes(24).toString("hex")))]);
  lines.push(["body changed after signing", await post(chargeBody.replace("4999", "9999"), sign(chargeBody))]);
  lines.push(["signature from ten minutes ago", await post(chargeBody, sign(chargeBody, clock.now() - 600_000))]);
  lines.push(["no signature at all", await post(chargeBody, undefined)]);
  lines.push(["a 70 KB body", await post(JSON.stringify({ filler: "x".repeat(70_000) }), sign("{}"))]);
  lines.push(["transfer.created, signed", await post(JSON.stringify(transfer), sign(JSON.stringify(transfer)))]);
  for (const [label, answer] of lines) out(`  ${label.padEnd(34)} -> ${answer}`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const sales = (await deps.db.transaction(OPERATOR, (tx) => tx.ledger.entries())).filter((e) => e.kind === "sale");
  out(`  ledger: ${sales.length} sale entry, Alba is owed ${usd(await balance(alba))}`);
  const answers = lines.map(([, a]) => a);
  hold(
    answers[0]?.startsWith("HTTP 200") === true && answers[0].includes("applied") && answers[1]?.includes("duplicate") === true && answers.slice(2, 6).every((a) => a.startsWith("HTTP 401")) &&
      answers[6]?.startsWith("HTTP 413") === true && sales.length === 1 && (await balance(alba)) === 4_469,
    "a forged, altered, stale or missing signature never reaches the ledger; a replay is a no-op",
  );

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("4. a sale, a refund and a dispute whose events arrive backwards, and some of them twice");
  const second = await buy(alba, 12_000, "mug-set-0003");
  const opening = stripe.takeEvents() as Event[]; // the charge and its transfer
  const refunded = await stripe.createRefund({ chargeId: second.chargeId, amount: 3_000, orderId: second.orderId, idempotencyKey: "demo-refund-1" });
  const dispute = stripe.openDispute(second.chargeId, 9_000);
  stripe.closeDispute(dispute, "won");
  const history = [...opening, ...(stripe.takeEvents() as Event[])];
  const delivery = [...history].reverse().flatMap((e, i) => (i % 3 === 1 ? [e, e] : [e]));
  const results: string[] = [];
  for (const e of delivery) {
    const r = await ingestEvent(deps, e);
    results.push(`${e.type.padEnd(26)} ${r.status}${r.reason === null ? "" : ` (${r.reason})`}`);
  }
  for (const line of results) out(`  ${line}`);
  const waiting = (await deps.db.transaction({ kind: "system" }, (tx) => tx.events.listDeferred())).length;
  out(`  events still waiting for a charge: ${waiting} (the ${history.length - 1} that were waiting were applied in the transaction that recorded the charge)`);
  const fee = 1_230;
  const refundFee = Math.floor((fee * 3_000) / 12_000);
  const expected = 12_000 - fee - (3_000 - refundFee);
  const got = (await deps.db.transaction(OPERATOR, (tx) => tx.payments.get(second.chargeId)));
  out(`  refund ${usd(3_000)} of ${usd(12_000)}: the platform gives back ${usd(refundFee)} of its ${usd(fee)} (floor of 307.5), the seller ${usd(3_000 - refundFee)}`);
  out(`  Alba's second sale is worth ${usd(expected)} to her in any order; the books say ${usd((await balance(alba)) - 4_469)}`);
  hold(
    refunded.status === "succeeded" && (await balance(alba)) - 4_469 === expected && got?.reversedFee === refundFee && got.refunded === 3_000 && !results.some((r) => r.includes("rejected")) && waiting === 0,
    "out of order and duplicated events end in the same books as in order (a refund before its charge waits for it)",
  );

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("5. a refund after the seller was paid out");
  stripe.settleBalances();
  const payout = stripe.payout(alba.accountId, "usd", 12_000);
  stripe.settlePayout(payout);
  await deliver(stripe.takeEvents());
  out(`  payout of ${usd(12_000)}: Alba is owed ${usd(await balance(alba))}`);
  const late = await requestRefund(deps, asSeller(alba), { orderId: second.orderId, amount: 9_000, idempotencyKey: "demo-refund-2" });
  out(`  refund of the rest (${usd(9_000)}) requested: ${late.ok ? late.value.status : late.error}`);
  await deliver(stripe.takeEvents());
  const owed = await balance(alba);
  const afterPayout = await report();
  out(`  Alba is owed ${usd(owed)}: she owes the platform ${usd(-owed)}`);
  for (const line of formatFindings(afterPayout.findings)) out(`  ${line}`);
  hold(late.ok && owed === 546 - 8_077 && errorsOf(afterPayout).length === 0 && afterPayout.findings.some((f) => f.kind === "negative_seller_balance"), "the ledger records the debt, stays balanced, and reconciliation names it without calling it a mismatch");

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("6. the webhook endpoint was down: reconciliation finds what the ledger missed");
  const bruno = await register("b2b00000-0000-4000-8000-000000000002", "Bruno Leather");
  stripe.completeOnboarding(bruno.accountId);
  await deliver(stripe.takeEvents());
  const brunoSale = await buy(bruno, 25_000, "belt-0001");
  await deliver(stripe.takeEvents());
  stripe.settleBalances();
  const brunoPayout = stripe.payout(bruno.accountId, "usd", 10_000);
  stripe.settlePayout(brunoPayout);
  const lostEvents = stripe.takeEvents();
  const lost = await report();
  for (const line of formatFindings(lost.findings.filter((f) => f.severity === "error"))) out(`  ${line}`);
  await deliver(lostEvents);
  const healed = await report();
  out(`  the ${lostEvents.length} lost events are delivered: ${errorsOf(healed).length === 0 ? "no errors left" : errorsOf(healed).join(", ")}`);
  hold(errorsOf(lost).join() === "balance_mismatch,payout_missing_in_ledger" && errorsOf(healed).length === 0 && brunoSale.chargeId !== "", "a payout the ledger never heard of is an error with both numbers; delivering the events clears it");

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("7. sellers cannot see each other's money, and nobody can rewrite the ledger");
  const forbidden = await sellerLedger(deps, asSeller(bruno), alba.id);
  const own = await sellerLedger(deps, asSeller(bruno), bruno.id);
  const rowsSeenAsBruno = await deps.db.transaction(asSeller(bruno), async (tx) => ({ albaLines: (await tx.ledger.linesFor(alba.id, { afterSeq: 0, limit: 100 })).length, albaOrders: (await tx.orders.listForSeller(alba.id)).length, albaSeller: (await tx.sellers.get(alba.id)) === undefined }));
  out(`  Bruno asks the application for Alba's ledger     -> ${forbidden.ok ? "ALLOWED" : forbidden.error}`);
  out(`  Bruno's own ledger                               -> ${own.ok ? `${own.value.lines.length} lines, balance ${usd(own.value.balance["usd"] ?? 0)}` : own.error}`);
  out(`  as Bruno's database role, asking by Alba's id    -> ${rowsSeenAsBruno.albaLines} ledger lines, ${rowsSeenAsBruno.albaOrders} orders, seller row hidden: ${rowsSeenAsBruno.albaSeller}`);
  let writeRefused = "WRITTEN";
  try {
    await deps.db.transaction(asSeller(bruno), (tx) => tx.orders.setStatus(brunoSale.orderId as never, "refunded"));
  } catch (error) {
    writeRefused = (error as Error).message;
  }
  out(`  Bruno's role tries to change an order            -> ${writeRefused}`);
  const ownerAttempts = await demo.asAdmin(async (c) => {
    const tried: string[] = [];
    for (const sql of ["UPDATE ledger_lines SET amount = amount * 2", "DELETE FROM ledger_entries", "TRUNCATE ledger_lines CASCADE"]) {
      try {
        await c.query(sql);
        tried.push(`${sql.split(" ")[0]}: DONE`);
      } catch (error) {
        tried.push(`${sql.split(" ")[0]}: ${(error as Error).message}`);
      }
    }
    return tried;
  });
  for (const line of ownerAttempts) out(`  the database owner tries ${line}`);
  const unbalanced = await demo.asAdmin(async (c) => {
    await c.query("BEGIN");
    try {
      const head = await c.query("INSERT INTO ledger_entries (posting_key, kind, seller_id, currency, subject, occurred_at, line_count, total_minor) VALUES ('payout:po_1Forged00001', 'payout', $1, 'usd', 'po_1Forged00001', 1, 2, 100000) RETURNING seq", [bruno.id]);
      await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency, seller_id) VALUES ($1, 1, 'seller_balance', 'credit', 100000, 'usd', $2)", [head.rows[0].seq, bruno.id]);
      await c.query("INSERT INTO ledger_lines (entry_seq, line_no, account, side, amount, currency) VALUES ($1, 2, 'stripe_funds', 'debit', 99999, 'usd')", [head.rows[0].seq]);
      await c.query("COMMIT");
      return "COMMITTED";
    } catch (error) {
      await c.query("ROLLBACK");
      return (error as Error).message;
    }
  });
  out(`  an entry whose debits and credits differ         -> ${unbalanced}`);
  hold(
    !forbidden.ok && own.ok && rowsSeenAsBruno.albaLines === 0 && rowsSeenAsBruno.albaOrders === 0 && rowsSeenAsBruno.albaSeller && writeRefused.includes("permission denied") &&
      ownerAttempts.every((a) => a.includes("append-only")) && unbalanced.includes("does not balance"),
    "isolation holds at the application and at the database role; the ledger is append-only even for its owner, and unbalanced entries cannot commit",
  );

  // ------------------------------------------------------------------------------------------------------------------------------
  out("");
  out("8. the books");
  const totals = await deps.db.transaction(OPERATOR, (tx) => tx.ledger.totals());
  const sum = (account: string, side: "debits" | "credits"): number => totals.filter((t) => t.account === account).reduce((s, t) => s + t[side], 0);
  const net = (account: string, normal: "debits" | "credits"): number => sum(account, "debits") * (normal === "debits" ? 1 : -1) + sum(account, "credits") * (normal === "debits" ? -1 : 1);
  const funds = net("stripe_funds", "debits");
  const owedToSellers = net("seller_balance", "credits");
  const fees = net("platform_fees", "credits");
  const disputed = net("disputed_funds", "debits");
  out(`  funds at Stripe ${usd(funds)} + disputed ${usd(disputed)}  =  owed to sellers ${usd(owedToSellers)} + platform fees ${usd(fees)}`);
  const debits = totals.reduce((s, t) => s + t.debits, 0);
  const credits = totals.reduce((s, t) => s + t.credits, 0);
  out(`  all debits ${usd(debits)}, all credits ${usd(credits)}`);
  hold(debits === credits && funds + disputed === owedToSellers + fees, "debits equal credits, and what Stripe holds is what the sellers are owed plus what the platform earned");
}
