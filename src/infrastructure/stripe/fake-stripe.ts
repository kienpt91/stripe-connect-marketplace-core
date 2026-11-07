import { GatewayError, type CheckoutInput, type Clock, type CreateAccountInput, type RefundInput, type StripeGateway } from "../../application/ports.js";
import { allocateReversal, type Currency } from "../../domain/money.js";
import type { StripeBalance, StripeCharge, StripePayout } from "../../domain/reconciliation.js";
import type { AccountSnapshot } from "../../domain/seller.js";
import type { DisputeStatus, PayoutStatus, RefundStatus } from "../../domain/stripe-events.js";

interface FakeAccount {
  readonly id: string;
  readonly sellerId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
  pastDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
  readonly balance: Map<Currency, { available: number; pending: number }>;
}

interface FakeSession { readonly id: string; readonly input: CheckoutInput; paid: boolean }
interface FakeCharge { readonly id: string; readonly input: CheckoutInput; readonly createdAt: number; readonly transferId: string; refunded: number; reversed: number; reversedFee: number; destination: string }
interface FakeRefund { readonly id: string; readonly chargeId: string; readonly amount: number; readonly currency: Currency; status: RefundStatus; readonly createdAt: number; feePart: number; applied: boolean }
interface FakeDispute { readonly id: string; readonly chargeId: string; readonly amount: number; readonly currency: Currency; status: DisputeStatus; readonly createdAt: number }
interface FakePayout { readonly id: string; readonly accountId: string; readonly amount: number; readonly currency: Currency; status: PayoutStatus; readonly createdAt: number }
interface FakeTransfer { readonly id: string; readonly chargeId: string; readonly accountId: string; readonly amount: number; amountReversed: number; readonly currency: Currency; readonly createdAt: number }

type Method = keyof StripeGateway;

/**
 * A stand-in for Stripe that runs in memory: tests and the offline demo use it, so nothing needs a key or a network. It keeps the
 * state Stripe would keep (accounts and their requirements, balances, sessions, charges, transfers, refunds, disputes, payouts), it
 * answers the `StripeGateway` calls, idempotency keys included (the same key and parameters return the same answer, other
 * parameters under the same key are refused), and every action of the outside world (a buyer pays, a payout is made, a dispute is
 * opened) puts the events Stripe would send into `takeEvents()`. The caller decides when, in which order and how often they are
 * delivered, which is exactly what the webhook tests need.
 *
 * It follows Stripe's documented shapes and rules; it is not Stripe. Where the rule is ours (how a refund splits the platform's fee from
 * the seller's share) it uses the same allocation function as the ledger, so a difference between the two is a bug here and not rounding.
 */
export class FakeStripe implements StripeGateway {
  /** every gateway call, in order: tests count them to prove a retry or a duplicate did not reach Stripe */
  readonly calls: { readonly method: Method; readonly input: unknown }[] = [];
  private readonly clock: Clock;
  private readonly accounts = new Map<string, FakeAccount>();
  private readonly sessions = new Map<string, FakeSession>();
  private readonly charges = new Map<string, FakeCharge>();
  private readonly transfers = new Map<string, FakeTransfer>();
  private readonly refunds = new Map<string, FakeRefund>();
  private readonly disputes = new Map<string, FakeDispute>();
  private readonly payouts = new Map<string, FakePayout>();
  private readonly idempotent = new Map<string, { fingerprint: string; response: unknown }>();
  private readonly failures = new Map<Method, GatewayError[]>();
  private pending: Record<string, unknown>[] = [];
  private counter = 0;
  /** the status the next refund is created with ("pending" until `settleRefund`) */
  nextRefundStatus: RefundStatus = "succeeded";

  /** `idStart` offsets the object ids, so two fakes that share one database never hand out the same id. */
  constructor(clock: Clock, options: { idStart?: number } = {}) {
    this.clock = clock;
    this.counter = options.idStart ?? 0;
  }

  // ---- the gateway -------------------------------------------------------------------------------------------------------

  async createAccount(input: CreateAccountInput): Promise<{ accountId: string }> {
    return this.call("createAccount", input, () =>
      this.once(input.idempotencyKey, { sellerId: input.sellerId, country: input.country }, () => {
        const id = this.id("acct");
        this.accounts.set(id, {
          id, sellerId: input.sellerId, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, currentlyDue: ["external_account", "business_type"],
          pastDue: [], pendingVerification: [], disabledReason: "requirements.past_due", balance: new Map(),
        });
        return { accountId: id };
      }),
    );
  }

  async createAccountLink(input: { accountId: string; returnUrl: string; refreshUrl: string }): Promise<{ url: string; expiresAt: number }> {
    return this.call("createAccountLink", input, () => {
      this.account(input.accountId);
      return { url: `https://connect.fake.invalid/setup/${input.accountId}`, expiresAt: this.clock.now() + 5 * 60_000 };
    });
  }

  async retrieveAccount(accountId: string): Promise<AccountSnapshot> {
    return this.call("retrieveAccount", accountId, () => this.snapshot(this.account(accountId)));
  }

  async createCheckoutSession(input: CheckoutInput): Promise<{ sessionId: string; url: string }> {
    return this.call("createCheckoutSession", input, () =>
      this.once(input.idempotencyKey, input, () => {
        const account = this.account(input.accountId);
        if (!account.chargesEnabled) throw new GatewayError("invalid_request", "the account cannot accept charges");
        if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.applicationFee < 0 || input.applicationFee >= input.amount) throw new GatewayError("invalid_request", "invalid amount or fee");
        const id = this.id("cs");
        this.sessions.set(id, { id, input, paid: false });
        return { sessionId: id, url: `https://checkout.fake.invalid/pay/${id}` };
      }),
    );
  }

  async createRefund(input: RefundInput): Promise<{ refundId: string; status: RefundStatus }> {
    return this.call("createRefund", input, () =>
      this.once(input.idempotencyKey, input, () => {
        const charge = this.charges.get(input.chargeId);
        if (charge === undefined) throw new GatewayError("not_found", "no such charge");
        if ([...this.disputes.values()].some((d) => d.chargeId === charge.id && d.status === "lost")) throw new GatewayError("invalid_request", "the charge has been charged back");
        if (!Number.isSafeInteger(input.amount) || input.amount < 1 || input.amount > charge.input.amount - charge.refunded) throw new GatewayError("invalid_request", "amount is more than what is left to refund");
        const refund: FakeRefund = { id: this.id("re"), chargeId: charge.id, amount: input.amount, currency: charge.input.currency, status: this.nextRefundStatus, createdAt: this.clock.now(), feePart: 0, applied: false };
        this.refunds.set(refund.id, refund);
        if (refund.status === "succeeded") this.applyRefund(charge, refund);
        this.emit("refund.created", this.refundObject(refund));
        return { refundId: refund.id, status: refund.status };
      }),
    );
  }

  async retrieveBalance(accountId: string): Promise<StripeBalance[]> {
    return this.call("retrieveBalance", accountId, () => [...this.account(accountId).balance].map(([currency, b]) => ({ currency, available: b.available, pending: b.pending })));
  }

  async listPayouts(accountId: string, since: number): Promise<StripePayout[]> {
    return this.call("listPayouts", { accountId, since }, () =>
      [...this.payouts.values()].filter((p) => p.accountId === accountId && p.createdAt >= since).map((p) => ({ id: p.id, amount: p.amount, currency: p.currency, status: p.status, createdAt: p.createdAt })),
    );
  }

  async listCharges(since: number): Promise<StripeCharge[]> {
    return this.call("listCharges", { since }, () =>
      [...this.charges.values()].filter((c) => c.createdAt >= since).map((c) => ({
        id: c.id, amount: c.input.amount, currency: c.input.currency, applicationFee: c.input.applicationFee, amountRefunded: c.refunded, destination: c.destination,
        orderId: c.input.orderId, createdAt: c.createdAt,
      })),
    );
  }

  // ---- the outside world -------------------------------------------------------------------------------------------------

  /** The events produced since the last call, oldest first. */
  takeEvents(): Record<string, unknown>[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  /** Makes the next call of `method` fail with `error` (`times` calls in a row). */
  injectFailure(method: Method, error: GatewayError, times = 1): void {
    this.failures.set(method, Array.from({ length: times }, () => error));
  }

  /** Sends the `account.updated` event of an account as it is now (Stripe sends one for any change, and the ones we did not model). */
  touch(accountId: string): void {
    this.emitAccount(this.account(accountId));
  }

  /** The seller finished onboarding: charges and payouts are on and nothing is due. */
  completeOnboarding(accountId: string): void {
    const a = this.account(accountId);
    Object.assign(a, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, currentlyDue: [], pastDue: [], pendingVerification: [], disabledReason: null });
    this.emitAccount(a);
  }

  /** Details are in and Stripe is verifying them. */
  submitForReview(accountId: string): void {
    const a = this.account(accountId);
    Object.assign(a, { detailsSubmitted: true, currentlyDue: [], pendingVerification: ["individual.verification.document"], disabledReason: "requirements.pending_verification" });
    this.emitAccount(a);
  }

  /** Stripe wants more information and the deadline has passed: the account can no longer take charges. */
  requireInformation(accountId: string, pastDue: string[]): void {
    const a = this.account(accountId);
    Object.assign(a, { chargesEnabled: false, payoutsEnabled: false, pastDue, currentlyDue: pastDue, disabledReason: "requirements.past_due" });
    this.emitAccount(a);
  }

  /** A hold or a rejection (`rejected.fraud`, `under_review`, ...). */
  disable(accountId: string, reason: string): void {
    const a = this.account(accountId);
    Object.assign(a, { chargesEnabled: false, payoutsEnabled: false, disabledReason: reason });
    this.emitAccount(a);
  }

  /** The buyer pays a checkout session: a charge succeeds, the net is transferred to the connected account (pending). */
  pay(sessionId: string, options: { destination?: string } = {}): { chargeId: string; transferId: string } {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.paid) throw new Error("no open session");
    session.paid = true;
    const input = session.input;
    const chargeId = this.id("ch");
    const transferId = this.id("tr");
    const destination = options.destination ?? input.accountId;
    const charge: FakeCharge = { id: chargeId, input, createdAt: this.clock.now(), transferId, refunded: 0, reversed: 0, reversedFee: 0, destination };
    this.charges.set(chargeId, charge);
    const transfer: FakeTransfer = { id: transferId, chargeId, accountId: destination, amount: input.amount - input.applicationFee, amountReversed: 0, currency: input.currency, createdAt: charge.createdAt };
    this.transfers.set(transferId, transfer);
    this.balance(this.account(destination), input.currency).pending += transfer.amount;
    this.emit("charge.succeeded", {
      id: chargeId, object: "charge", amount: input.amount, currency: input.currency, status: "succeeded", created: seconds(charge.createdAt), application_fee_amount: input.applicationFee,
      transfer_data: { destination, amount: transfer.amount }, transfer: transferId, payment_intent: this.id("pi"), metadata: { order_id: input.orderId },
    });
    this.emit("transfer.created", this.transferObject(transfer));
    return { chargeId, transferId };
  }

  /** Pending funds become available, as they do a few days after a charge. */
  settleBalances(): void {
    for (const a of this.accounts.values()) {
      for (const b of a.balance.values()) {
        b.available += b.pending;
        b.pending = 0;
      }
    }
  }

  /** A pending refund settles: it succeeds (money moves) or fails. */
  settleRefund(refundId: string, outcome: "succeeded" | "failed"): void {
    const refund = this.refunds.get(refundId);
    if (refund === undefined || refund.status !== "pending") throw new Error("no pending refund");
    refund.status = outcome;
    if (outcome === "succeeded") this.applyRefund(this.mustCharge(refund.chargeId), refund);
    this.emit("refund.updated", this.refundObject(refund));
  }

  /** A refund that had succeeded fails afterwards (the bank returned it): the money comes back to the seller and the platform. */
  failRefund(refundId: string): void {
    const refund = this.refunds.get(refundId);
    if (refund === undefined || refund.status !== "succeeded") throw new Error("no succeeded refund");
    this.undoRefund(this.mustCharge(refund.chargeId), refund);
    refund.status = "failed";
    this.emit("refund.updated", this.refundObject(refund));
  }

  openDispute(chargeId: string, amount?: number): string {
    const charge = this.mustCharge(chargeId);
    const dispute: FakeDispute = { id: this.id("du"), chargeId, amount: amount ?? charge.input.amount - charge.refunded, currency: charge.input.currency, status: "needs_response", createdAt: this.clock.now() };
    this.disputes.set(dispute.id, dispute);
    this.emit("charge.dispute.created", this.disputeObject(dispute));
    return dispute.id;
  }

  updateDispute(disputeId: string, status: "under_review" | "needs_response"): void {
    const dispute = this.mustDispute(disputeId);
    dispute.status = status;
    this.emit("charge.dispute.updated", this.disputeObject(dispute));
  }

  /** The dispute ends. A lost dispute is paid by the platform's balance; the transfer to the seller stays until `reverseTransfer`. */
  closeDispute(disputeId: string, outcome: "won" | "lost"): void {
    const dispute = this.mustDispute(disputeId);
    dispute.status = outcome;
    this.emit("charge.dispute.closed", this.disputeObject(dispute));
  }

  /** What an operator does to recover a lost dispute from the seller: reverse part of the transfer. */
  reverseTransfer(chargeId: string, amount: number): void {
    const charge = this.mustCharge(chargeId);
    const transfer = this.transfers.get(charge.transferId);
    if (transfer === undefined || amount < 1 || transfer.amountReversed + amount > transfer.amount) throw new Error("invalid reversal");
    transfer.amountReversed += amount;
    this.balance(this.account(transfer.accountId), transfer.currency).available -= amount;
    this.emit("transfer.reversed", this.transferObject(transfer));
  }

  /** A payout of `amount` (default: everything available) leaves the account's balance. */
  payout(accountId: string, currency: Currency, amount?: number): string {
    const balance = this.balance(this.account(accountId), currency);
    const value = amount ?? balance.available;
    if (value < 1 || value > balance.available) throw new Error("insufficient available balance");
    balance.available -= value;
    const payout: FakePayout = { id: this.id("po"), accountId, amount: value, currency, status: "pending", createdAt: this.clock.now() };
    this.payouts.set(payout.id, payout);
    this.emit("payout.created", this.payoutObject(payout), accountId);
    return payout.id;
  }

  settlePayout(payoutId: string): void {
    const payout = this.mustPayout(payoutId);
    payout.status = "paid";
    this.emit("payout.paid", this.payoutObject(payout), payout.accountId);
  }

  /** A payout fails (in the bank): the money returns to the account's balance. */
  failPayout(payoutId: string): void {
    const payout = this.mustPayout(payoutId);
    payout.status = "failed";
    this.balance(this.account(payout.accountId), payout.currency).available += payout.amount;
    this.emit("payout.failed", this.payoutObject(payout), payout.accountId);
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------

  private call<T>(method: Method, input: unknown, run: () => T): T {
    this.calls.push({ method, input });
    const failing = this.failures.get(method);
    const failure = failing?.shift();
    if (failure !== undefined) throw failure;
    return run();
  }

  private once<T>(key: string, parameters: unknown, make: () => T): T {
    const fingerprint = JSON.stringify(parameters);
    const seen = this.idempotent.get(key);
    if (seen !== undefined) {
      if (seen.fingerprint !== fingerprint) throw new GatewayError("invalid_request", "the idempotency key was used with different parameters");
      return seen.response as T;
    }
    const response = make();
    this.idempotent.set(key, { fingerprint, response });
    return response;
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}_1Fake${String(this.counter).padStart(10, "0")}`;
  }

  private account(id: string): FakeAccount {
    const a = this.accounts.get(id);
    if (a === undefined) throw new GatewayError("not_found", "no such account");
    return a;
  }

  private mustCharge(id: string): FakeCharge {
    const c = this.charges.get(id);
    if (c === undefined) throw new Error("no such charge");
    return c;
  }

  private mustDispute(id: string): FakeDispute {
    const d = this.disputes.get(id);
    if (d === undefined) throw new Error("no such dispute");
    return d;
  }

  private mustPayout(id: string): FakePayout {
    const p = this.payouts.get(id);
    if (p === undefined) throw new Error("no such payout");
    return p;
  }

  private balance(account: FakeAccount, currency: Currency): { available: number; pending: number } {
    let b = account.balance.get(currency);
    if (b === undefined) {
      b = { available: 0, pending: 0 };
      account.balance.set(currency, b);
    }
    return b;
  }

  private snapshot(a: FakeAccount): AccountSnapshot {
    return {
      accountId: a.id, chargesEnabled: a.chargesEnabled, payoutsEnabled: a.payoutsEnabled, detailsSubmitted: a.detailsSubmitted,
      currentlyDue: [...a.currentlyDue], pastDue: [...a.pastDue], pendingVerification: [...a.pendingVerification], disabledReason: a.disabledReason,
    };
  }

  /** A refund that succeeded reverses the seller's share of the transfer and gives back the platform's share of the fee. */
  private applyRefund(charge: FakeCharge, refund: FakeRefund): void {
    const split = allocateReversal({ amount: charge.input.amount, fee: charge.input.applicationFee }, { amount: charge.reversed, fee: charge.reversedFee }, refund.amount);
    if (!split.ok) throw new GatewayError("invalid_request", "amount is more than what is left to refund");
    refund.feePart = split.value.feePart;
    refund.applied = true;
    charge.refunded += refund.amount;
    charge.reversed += refund.amount;
    charge.reversedFee += split.value.feePart;
    const transfer = this.mustTransfer(charge);
    transfer.amountReversed += split.value.sellerPart;
    this.balance(this.account(transfer.accountId), transfer.currency).available -= split.value.sellerPart;
    if (split.value.sellerPart > 0) this.emit("transfer.reversed", this.transferObject(transfer));
  }

  private undoRefund(charge: FakeCharge, refund: FakeRefund): void {
    charge.refunded -= refund.amount;
    charge.reversed -= refund.amount;
    charge.reversedFee -= refund.feePart;
    const transfer = this.mustTransfer(charge);
    const sellerPart = refund.amount - refund.feePart;
    transfer.amountReversed -= sellerPart;
    this.balance(this.account(transfer.accountId), transfer.currency).available += sellerPart;
  }

  private mustTransfer(charge: FakeCharge): FakeTransfer {
    const t = this.transfers.get(charge.transferId);
    if (t === undefined) throw new Error("no such transfer");
    return t;
  }

  private emitAccount(a: FakeAccount): void {
    this.emit("account.updated", {
      id: a.id, object: "account", charges_enabled: a.chargesEnabled, payouts_enabled: a.payoutsEnabled, details_submitted: a.detailsSubmitted,
      requirements: { currently_due: a.currentlyDue, past_due: a.pastDue, pending_verification: a.pendingVerification, disabled_reason: a.disabledReason },
    }, a.id);
  }

  private refundObject(r: FakeRefund): Record<string, unknown> {
    return { id: r.id, object: "refund", amount: r.amount, charge: r.chargeId, currency: r.currency, status: r.status, created: seconds(r.createdAt) };
  }

  private disputeObject(d: FakeDispute): Record<string, unknown> {
    return { id: d.id, object: "dispute", amount: d.amount, charge: d.chargeId, currency: d.currency, status: d.status, created: seconds(d.createdAt) };
  }

  private payoutObject(p: FakePayout): Record<string, unknown> {
    return { id: p.id, object: "payout", amount: p.amount, currency: p.currency, status: p.status, created: seconds(p.createdAt), arrival_date: seconds(p.createdAt) + 2 * 86_400 };
  }

  private transferObject(t: FakeTransfer): Record<string, unknown> {
    return { id: t.id, object: "transfer", amount: t.amount, amount_reversed: t.amountReversed, currency: t.currency, destination: t.accountId, source_transaction: t.chargeId, created: seconds(t.createdAt) };
  }

  private emit(type: string, object: Record<string, unknown>, account?: string): void {
    this.pending.push({
      id: this.id("evt"), object: "event", type, created: seconds(this.clock.now()), livemode: false, ...(account === undefined ? {} : { account }), data: { object }, pending_webhooks: 1,
    });
  }
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}
