# 0003. The ledger, and who bears what

Status: accepted

## Context

Stripe holds the money; the platform still has to know what it owes each seller, what it earned, and what is in dispute, and be able to explain every figure. Some questions (who pays for a refund, who pays for a lost dispute) have no single answer, so the repository has to pick one and say so.

## Decision

`src/domain/ledger.ts` defines four fixed accounts. Normal sides: `stripe_funds` (debit, everything Stripe holds), `seller_balance` (credit, what the platform owes sellers; the only account whose lines carry a seller id), `platform_fees` (credit, revenue), `disputed_funds` (debit, money withdrawn for an open dispute).

One business fact is one entry with a posting key that names it (`sale:ch_...`); posting it again is a no-op (unique `posting_key`). Debits equal credits.

| Fact | Debit | Credit |
|---|---|---|
| sale | stripe_funds (amount) | seller_balance (net), platform_fees (fee) |
| refund | seller_balance (amount - fee part - absorbed), platform_fees (fee part + absorbed) | stripe_funds (amount) |
| refund reversal (a succeeded refund failed) | mirror of the refund | |
| dispute opened | disputed_funds | stripe_funds |
| dispute won | stripe_funds | disputed_funds |
| dispute lost | seller_balance (amount - fee part - absorbed), platform_fees (fee part + absorbed) | disputed_funds |
| payout | seller_balance | stripe_funds |
| payout reversal (failed or canceled) | mirror of the payout | |

The policies below are this repository's rules, not Stripe's:

- A refund takes the seller's share and the platform's fee share pro rata (0002). `requestRefund` in `src/application/refunds.ts` writes nothing; `StripeGateway.createRefund` always asks Stripe to reverse the transfer and refund the fee, and the ledger changes only when the signed `refund.*` event arrives.
- A lost dispute is charged to the seller's share and the platform's fee share in the ledger. At Stripe the platform absorbs it until an operator reverses the transfer, so reconciliation shows `balance_mismatch` and `transfer_mismatch` until then (`test/contract/money.scenarios.ts`, "a dispute that is lost"). That Stripe debits the platform is how the fake models destination charges; not verified against the real API.
- A refund after a payout leaves a negative seller balance. It is flagged as `negative_seller_balance`, not hidden (same file, "a refund after the payout").
- A refund and a lost dispute can be for the same money: Stripe lets a charge in dispute be refunded (the fake follows that, and refuses a refund once the dispute is lost; neither is checked against the real API). The sale can give back only once, so `takeBack` in `src/application/apply.ts` charges whichever of the two is applied second to the seller and the fee only for what the sale has left, in proportion as usual. The rest, `absorbed` in the entry, is the platform's: it is debited to `platform_fees`, which then reads as the net revenue and can be below zero, and it is recorded in `secondary_amount` of the refund or dispute that carried it. Without this, a dispute lost on a refunded charge would stay in `disputed_funds` for ever (it used to be rejected). Both orders end in the same books (`test/contract/money.scenarios.ts`, "ends in the same books when the loss is applied before the refund it overlaps"); which of the two carries the `absorbed` amount depends on the order. Refunds alone still cannot add up to more than the charge (`refund_exceeds_charge`), and a dispute for more than the charge is still rejected.
- One sequence is not symmetric. If a refund that was applied first fails afterwards, the part of the lost dispute that was `absorbed` because of it stays with the platform: the seller's share is not charged to the seller after the fact. The books stay balanced, the seller is owed what Stripe's connected account holds again, and the platform's loss shows in `platform_fees`. An operator who recovers that money from the seller at Stripe then sees `balance_mismatch` and `transfer_mismatch` in reconciliation, because the ledger has not charged the seller (`test/contract/money.scenarios.ts`, "keeps the loss on the platform when the refund fails after the loss was applied").

## Consequences

- `occurred_at` is the Stripe object's created time, not the delivery time, so a late event does not move history.
- Stripe's own processing fees and dispute fees are not modelled. The ledger's `stripe_funds` is the gross movement and will not equal a Stripe statement net of fees.
- A different policy (the seller bears nothing for a lost dispute, or the platform's fee is not refunded) means changing the calls to `allocateReversal` in `src/application/apply.ts` and the refund request that `HttpStripeGateway` and `FakeStripe` make, together.
