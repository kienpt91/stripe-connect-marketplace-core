import { describe, expect, it } from "vitest";
import { applySnapshot, canTakePayments, canTransition, deriveSellerState, parseAccountSnapshot, SELLER_STATES, type AccountSnapshot, type SellerState } from "../../src/domain/seller.js";

const base: AccountSnapshot = {
  accountId: "acct_1AbCdEfGh", chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false,
  currentlyDue: ["external_account"], pastDue: [], pendingVerification: [], disabledReason: null,
};
const snap = (patch: Partial<AccountSnapshot>): AccountSnapshot => ({ ...base, ...patch });

const live = snap({ chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, currentlyDue: [] });

describe("deriveSellerState: what a Stripe account says about a seller", () => {
  it.each<[string, AccountSnapshot, SellerState, SellerState]>([
    ["a new account with requirements due", base, "new", "requirements_due"],
    ["details not submitted", snap({ currentlyDue: [] }), "requirements_due", "requirements_due"],
    ["details submitted but something is still due", snap({ detailsSubmitted: true }), "requirements_due", "requirements_due"],
    ["everything submitted and Stripe verifying", snap({ detailsSubmitted: true, currentlyDue: [], pendingVerification: ["individual.id_number"] }), "requirements_due", "pending_review"],
    ["charges and payouts on", live, "pending_review", "enabled"],
    ["enabled with later requirements only eventually due", snap({ ...live, currentlyDue: [] }), "enabled", "enabled"],
    ["a seller that was live and is now past due", snap({ ...live, chargesEnabled: false, pastDue: ["external_account"], disabledReason: "requirements.past_due" }), "enabled", "restricted"],
    ["a live seller whose charges were switched off", snap({ ...live, chargesEnabled: false }), "enabled", "restricted"],
    ["a seller that was live and is being re-verified", snap({ detailsSubmitted: true, currentlyDue: [], pendingVerification: ["company.tax_id"] }), "enabled", "restricted"],
    ["a restricted seller that fixed everything", live, "restricted", "enabled"],
    ["a restricted seller that has not fixed it", snap({ currentlyDue: [], detailsSubmitted: true }), "restricted", "restricted"],
    ["a hold: under review", snap({ ...live, disabledReason: "under_review" }), "enabled", "restricted"],
    ["a hold: paused by the platform", snap({ ...live, disabledReason: "platform_paused" }), "enabled", "restricted"],
    ["a hold: listed", snap({ ...live, disabledReason: "listed" }), "requirements_due", "restricted"],
    ["a hold: other", snap({ disabledReason: "other" }), "new", "restricted"],
    ["rejected for fraud", snap({ ...live, disabledReason: "rejected.fraud" }), "enabled", "rejected"],
    ["rejected for terms of service", snap({ disabledReason: "rejected.terms_of_service" }), "new", "rejected"],
  ])("%s", (_name, snapshot, previous, expected) => {
    expect(deriveSellerState(snapshot, previous)).toBe(expected);
  });

  it("does not call a seller enabled while anything is past due", () => {
    expect(deriveSellerState(snap({ ...live, pastDue: ["x"] }), "enabled")).toBe("restricted");
    expect(deriveSellerState(snap({ ...live, pastDue: ["x"] }), "new")).toBe("requirements_due");
  });
});

describe("the transition table", () => {
  it("lets a rejected seller go nowhere", () => {
    for (const to of SELLER_STATES) expect(canTransition("rejected", to)).toBe(to === "rejected");
  });

  it("lets every other state reach rejected", () => {
    for (const from of SELLER_STATES) expect(canTransition(from, "rejected")).toBe(true);
  });

  it("lets a live seller only stay enabled, become restricted or be rejected", () => {
    expect(SELLER_STATES.filter((to) => canTransition("enabled", to))).toEqual(["enabled", "restricted", "rejected"]);
    expect(SELLER_STATES.filter((to) => canTransition("restricted", to))).toEqual(["enabled", "restricted", "rejected"]);
  });

  it("never goes back to new", () => {
    for (const from of SELLER_STATES) expect(canTransition(from, "new")).toBe(false);
  });

  it("is consistent with the derivation: no snapshot can derive a move the table forbids, except out of rejected", () => {
    const flags = [true, false];
    const lists: string[][] = [[], ["x"]];
    const reasons = [null, "requirements.past_due", "under_review", "platform_paused", "listed", "other", "rejected.fraud"];
    for (const previous of SELLER_STATES) {
      for (const chargesEnabled of flags) for (const payoutsEnabled of flags) for (const detailsSubmitted of flags)
        for (const currentlyDue of lists) for (const pastDue of lists) for (const disabledReason of reasons) {
          const s = snap({ chargesEnabled, payoutsEnabled, detailsSubmitted, currentlyDue, pastDue, disabledReason });
          const wanted = deriveSellerState(s, previous);
          if (previous !== "rejected" && wanted !== previous) {
            expect(canTransition(previous, wanted), `${previous} -> ${wanted} for ${JSON.stringify(s)}`).toBe(true);
          }
        }
    }
  });
});

describe("applySnapshot", () => {
  it("reports no change, a move, or a refused move", () => {
    expect(applySnapshot("enabled", live)).toEqual({ kind: "unchanged", state: "enabled" });
    expect(applySnapshot("pending_review", live)).toEqual({ kind: "moved", from: "pending_review", state: "enabled" });
    expect(applySnapshot("rejected", live)).toEqual({ kind: "refused", from: "rejected", wanted: "enabled" });
    expect(applySnapshot("rejected", snap({ disabledReason: "rejected.fraud" }))).toEqual({ kind: "unchanged", state: "rejected" });
  });

  it("only an enabled seller takes payments", () => {
    for (const state of SELLER_STATES) expect(canTakePayments(state)).toBe(state === "enabled");
  });
});

describe("parseAccountSnapshot", () => {
  const object = {
    id: "acct_1AbCdEfGh", object: "account", charges_enabled: true, payouts_enabled: false, details_submitted: true,
    requirements: { currently_due: ["a"], past_due: [], pending_verification: ["b"], disabled_reason: "requirements.past_due", errors: [] },
  };

  it("reads a Stripe account object and keeps only what the state machine reads", () => {
    expect(parseAccountSnapshot(object)).toEqual({
      ok: true,
      value: { accountId: "acct_1AbCdEfGh", chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true, currentlyDue: ["a"], pastDue: [], pendingVerification: ["b"], disabledReason: "requirements.past_due" },
    });
  });

  it("treats missing requirement lists and a missing reason as empty and none", () => {
    const r = parseAccountSnapshot({ id: "acct_1AbCdEfGh", charges_enabled: false, payouts_enabled: false, details_submitted: false });
    expect(r).toMatchObject({ ok: true, value: { currentlyDue: [], pastDue: [], pendingVerification: [], disabledReason: null } });
    expect(parseAccountSnapshot({ ...object, requirements: { currently_due: null, disabled_reason: null } }).ok).toBe(true);
  });

  it.each([
    ["not an object", "acct"],
    ["null", null],
    ["no id", { ...object, id: undefined }],
    ["an id of another kind", { ...object, id: "cus_1AbCdEfGh" }],
    ["a flag that is not a boolean", { ...object, charges_enabled: "true" }],
    ["requirements that are not an object", { ...object, requirements: "none" }],
    ["a list that is not a list", { ...object, requirements: { currently_due: "a" } }],
    ["a list with a number in it", { ...object, requirements: { past_due: [1] } }],
    ["an enormous list", { ...object, requirements: { past_due: Array.from({ length: 201 }, () => "x") } }],
    ["a reason that is not a string", { ...object, requirements: { disabled_reason: 5 } }],
    ["a reason that is far too long", { ...object, requirements: { disabled_reason: "x".repeat(101) } }],
  ])("refuses %s", (_name, value) => {
    expect(parseAccountSnapshot(value)).toEqual({ ok: false, error: "invalid_account" });
  });
});
