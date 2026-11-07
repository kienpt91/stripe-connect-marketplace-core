import { describe, expect, it } from "vitest";
import { createOnboardingLink, refreshSeller, registerSeller } from "../../src/application/sellers.js";
import { GatewayError } from "../../src/application/ports.js";
import { reconcile } from "../../src/application/reconcile.js";
import type { SellerRecord } from "../../src/application/store.js";
import type { SellerState } from "../../src/domain/seller.js";
import { deliver, deliverAll, enabledSeller, sellerUuid } from "../support/world.js";
import { asSeller, freshWorld, operator, sharedDb, system, type DbFactory } from "./support.js";

export function onboardingScenarios(open: DbFactory): void {
  describe("seller onboarding", () => {
    const world = sharedDb(open);
    const stateOf = async (w: ReturnType<typeof world>, seller: SellerRecord): Promise<SellerState | undefined> => (await w.db.transaction(system, (tx) => tx.sellers.get(seller.id)))?.state;

    it("registers a seller with a Connect account and starts in `new`; registering again creates nothing", async () => {
      const w = world();
      const id = sellerUuid();
      const first = await registerSeller(w.deps, { sellerId: id, displayName: "  Alba Ceramics ", country: "DE" });
      expect(first.ok && first.value).toMatchObject({ id, displayName: "Alba Ceramics", state: "new", snapshot: null });
      const again = await registerSeller(w.deps, { sellerId: id.toUpperCase(), displayName: "Someone Else", country: "FR" });
      expect(again.ok && again.value.accountId).toBe(first.ok && first.value.accountId);
      expect(again.ok && again.value.displayName).toBe("Alba Ceramics");
      expect(w.stripe.calls.filter((c) => c.method === "createAccount")).toHaveLength(1);
    });

    it("creates one seller and one Stripe account when the same registration arrives ten times at once", async () => {
      const w = world();
      const id = sellerUuid();
      const results = await Promise.all(Array.from({ length: 10 }, () => registerSeller(w.deps, { sellerId: id, displayName: "Alba Ceramics", country: "DE" })));
      expect(results.every((r) => r.ok)).toBe(true);
      expect(new Set(results.map((r) => (r.ok ? r.value.accountId : ""))).size).toBe(1);
      expect((await w.db.transaction(system, (tx) => tx.sellers.list())).filter((s) => s.id === id)).toHaveLength(1);
      // Stripe was asked more than once, with one key, and answered with one account
      expect(new Set(w.stripe.calls.filter((c) => c.method === "createAccount").map((c) => (c.input as { idempotencyKey: string }).idempotencyKey))).toEqual(new Set([`seller-${id}`]));
    });

    it("repeats safely after a crash between Stripe's answer and the row: the idempotency key returns the same account", async () => {
      const w = world();
      const id = sellerUuid();
      const created = await w.stripe.createAccount({ sellerId: id, country: "DE", idempotencyKey: `seller-${id}` }); // the call that was answered and then lost
      const registered = await registerSeller(w.deps, { sellerId: id, displayName: "Alba", country: "DE" });
      expect(registered.ok && registered.value.accountId).toBe(created.accountId);
    });

    it("refuses bad input before calling Stripe, and a gateway failure stores nothing so the retry works", async () => {
      const w = world();
      const good = { sellerId: sellerUuid(), displayName: "Alba", country: "DE" };
      const cases: [Partial<typeof good> | { sellerId: unknown } | { displayName: unknown } | { country: unknown }, string][] = [
        [{ sellerId: "not-a-uuid" }, "invalid_seller_id"], [{ sellerId: 7 }, "invalid_seller_id"],
        [{ displayName: "" }, "invalid_name"], [{ displayName: "   " }, "invalid_name"], [{ displayName: "x".repeat(101) }, "invalid_name"], [{ displayName: "two\nlines" }, "invalid_name"], [{ displayName: 5 }, "invalid_name"],
        [{ country: "de" }, "invalid_country"], [{ country: "DEU" }, "invalid_country"], [{ country: undefined }, "invalid_country"],
      ];
      for (const [patch, error] of cases) expect(await registerSeller(w.deps, { ...good, ...patch }), JSON.stringify(patch)).toEqual({ ok: false, error });
      expect(w.stripe.calls).toHaveLength(0);

      w.stripe.injectFailure("createAccount", new GatewayError("unavailable", "down"));
      expect(await registerSeller(w.deps, good)).toEqual({ ok: false, error: "gateway_failed" });
      expect(await w.db.transaction(system, (tx) => tx.sellers.get(good.sellerId as never))).toBeUndefined();
      expect((await registerSeller(w.deps, good)).ok).toBe(true);
    });

    it("moves through requirements due, pending review, enabled, restricted and enabled again as Stripe reports it", async () => {
      const w = world();
      const reg = await registerSeller(w.deps, { sellerId: sellerUuid(), displayName: "Alba", country: "DE" });
      if (!reg.ok) throw new Error("register");
      const seller = reg.value;
      const step = async (act: () => void): Promise<{ state: SellerState | undefined; reason: string | null }> => {
        act();
        const [result] = await deliverAll(w);
        expect(result?.status).toBe("applied");
        return { state: await stateOf(w, seller), reason: result?.reason ?? null };
      };
      expect(await step(() => w.stripe.touch(seller.accountId))).toEqual({ state: "requirements_due", reason: "new->requirements_due" });
      expect(await step(() => w.stripe.submitForReview(seller.accountId))).toEqual({ state: "pending_review", reason: "requirements_due->pending_review" });
      expect(await step(() => w.stripe.completeOnboarding(seller.accountId))).toEqual({ state: "enabled", reason: "pending_review->enabled" });
      expect(await step(() => w.stripe.touch(seller.accountId))).toEqual({ state: "enabled", reason: null });
      expect(await step(() => w.stripe.requireInformation(seller.accountId, ["external_account"]))).toEqual({ state: "restricted", reason: "enabled->restricted" });
      expect(await step(() => w.stripe.completeOnboarding(seller.accountId))).toEqual({ state: "enabled", reason: "restricted->enabled" });
      const stored = await w.db.transaction(system, (tx) => tx.sellers.get(seller.id));
      expect(stored?.snapshot).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, currentlyDue: [] });
    });

    it("keeps a rejected seller rejected: an `enabled` account afterwards is refused and left for a person", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      w.stripe.disable(seller.accountId, "rejected.fraud");
      expect((await deliverAll(w))[0]).toMatchObject({ status: "applied", reason: "enabled->rejected" });
      w.stripe.completeOnboarding(seller.accountId); // Stripe now says enabled again: no valid history gets there
      const [late] = await deliverAll(w);
      expect(late).toMatchObject({ status: "rejected", reason: "illegal_transition:rejected->enabled" });
      expect(await stateOf(w, seller)).toBe("rejected");
      const flagged = await w.db.transaction(operator, (tx) => tx.events.flagged());
      expect(flagged.map((e) => e.reason)).toContain("illegal_transition:rejected->enabled");
    });

    it("ends in the state Stripe reports whatever order two account events arrive in, since the event is only a signal", async () => {
      for (const order of ["old first", "new first"] as const) {
        const w = world();
        const seller = await enabledSeller(w);
        w.stripe.takeEvents();
        w.stripe.requireInformation(seller.accountId, ["external_account"]);
        const restricted = w.stripe.takeEvents();
        w.stripe.completeOnboarding(seller.accountId);
        const enabled = w.stripe.takeEvents();
        const delivery = order === "old first" ? [...restricted, ...enabled] : [...enabled, ...restricted];
        for (const e of delivery) await deliver(w, [e]);
        expect(await stateOf(w, seller), order).toBe("enabled");
      }
    });

    it("never lets an older read of the account replace a newer one", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      const stored = await w.db.transaction(system, (tx) => tx.sellers.get(seller.id));
      const older = await w.db.transaction(system, (tx) => tx.sellers.applySnapshot(seller.id, "restricted", { ...stored!.snapshot!, chargesEnabled: false }, stored!.observedAt - 1));
      expect(older).toBe(false);
      expect(await stateOf(w, seller)).toBe("enabled");
      const same = await w.db.transaction(system, (tx) => tx.sellers.applySnapshot(seller.id, "enabled", stored!.snapshot!, stored!.observedAt));
      expect(same).toBe(true);
    });

    it("answers an onboarding link for the seller's own account only", async () => {
      const w = world();
      const a = await enabledSeller(w);
      const b = await enabledSeller(w);
      const paths = { returnPath: "/onboarding/done", refreshPath: "/onboarding/again" };
      const own = await createOnboardingLink(w.deps, asSeller(a), a.id, paths);
      expect(own.ok && own.value.url).toBe(`https://connect.fake.invalid/setup/${a.accountId}`);
      expect((await createOnboardingLink(w.deps, operator, a.id, paths)).ok).toBe(true);
      // somebody else's seller id and an id that does not exist look the same
      const other = await createOnboardingLink(w.deps, asSeller(a), b.id, paths);
      const nobody = await createOnboardingLink(w.deps, asSeller(a), sellerUuid() as never, paths);
      expect(other).toEqual({ ok: false, error: "not_found" });
      expect(nobody).toEqual(other);
      expect(await createOnboardingLink(w.deps, operator, sellerUuid() as never, paths)).toEqual({ ok: false, error: "not_found" });
      expect(w.stripe.calls.filter((c) => c.method === "createAccountLink")).toHaveLength(2);
    });

    it("refuses a return path that leaves the application, without calling Stripe", async () => {
      const w = world();
      const a = await enabledSeller(w);
      const calls = w.stripe.calls.length;
      for (const bad of ["https://evil.example/", "//evil.example", "/\\evil.example", "relative", ""]) {
        expect(await createOnboardingLink(w.deps, asSeller(a), a.id, { returnPath: bad, refreshPath: "/x" })).toEqual({ ok: false, error: "invalid_redirect" });
        expect(await createOnboardingLink(w.deps, asSeller(a), a.id, { returnPath: "/x", refreshPath: bad })).toEqual({ ok: false, error: "invalid_redirect" });
      }
      expect(w.stripe.calls).toHaveLength(calls);
      w.stripe.injectFailure("createAccountLink", new GatewayError("rate_limited", "slow down"));
      expect(await createOnboardingLink(w.deps, asSeller(a), a.id, { returnPath: "/x", refreshPath: "/y" })).toEqual({ ok: false, error: "gateway_failed" });
    });

    it("repairs a state that an `account.updated` event never reached, and reports it first", async () => {
      const w = await freshWorld(open);
      const seller = await enabledSeller(w.world);
      w.world.stripe.requireInformation(seller.accountId, ["external_account"]);
      w.world.stripe.takeEvents(); // the event is lost
      const report = await reconcile(w.world.deps, { since: 0 });
      expect(report.ok && report.value.findings.map((f) => f.kind)).toEqual(["seller_state_mismatch"]);
      expect(await refreshSeller(w.world.deps, seller.id)).toEqual({ ok: true, value: { state: "restricted", changed: true } });
      const after = await reconcile(w.world.deps, { since: 0 });
      expect(after.ok && after.value.findings).toEqual([]);
      expect(await refreshSeller(w.world.deps, sellerUuid() as never)).toEqual({ ok: false, error: "not_found" });
      w.world.stripe.injectFailure("retrieveAccount", new GatewayError("unavailable", "down"));
      expect(await refreshSeller(w.world.deps, seller.id)).toEqual({ ok: false, error: "gateway_failed" });
      await w.close();
    });

    it("loses an `account.updated` event that overtakes the seller's row, and reconciliation finds it and `refreshSeller` repairs it", async () => {
      const f = await freshWorld(open);
      const w = f.world;
      const id = sellerUuid();
      const account = await w.stripe.createAccount({ sellerId: id, country: "DE", idempotencyKey: `seller-${id}` }); // Stripe has answered; the row is not written yet
      w.stripe.touch(account.accountId);
      expect((await deliverAll(w))[0]).toMatchObject({ status: "ignored", reason: "unknown_account" });
      const registered = await registerSeller(w.deps, { sellerId: id, displayName: "Alba", country: "DE" });
      if (!registered.ok) throw new Error(registered.error);
      expect(registered.value.state).toBe("new");
      const before = await reconcile(w.deps, { since: 0 });
      expect(before.ok && before.value.findings.map((x) => x.kind)).toEqual(["seller_state_mismatch"]);
      expect(await refreshSeller(w.deps, registered.value.id)).toEqual({ ok: true, value: { state: "requirements_due", changed: true } });
      const after = await reconcile(w.deps, { since: 0 });
      expect(after.ok && after.value.findings).toEqual([]);
      await f.close();
    });

    it("refuses to refresh a rejected seller back to life", async () => {
      const w = world();
      const seller = await enabledSeller(w);
      w.stripe.disable(seller.accountId, "rejected.terms_of_service");
      await deliverAll(w);
      w.stripe.completeOnboarding(seller.accountId);
      w.stripe.takeEvents();
      expect(await refreshSeller(w.deps, seller.id)).toEqual({ ok: false, error: "refused" });
    });
  });
}
