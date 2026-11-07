# 0002. Money is integers, and the fee is the platform's

Status: accepted

## Context

A commission computed in floating point drifts by a unit now and then, and a fee that arrives from the caller is a fee the caller can set to zero. A refund of part of a sale has to give back part of the fee as well, and a series of partial refunds must not create or lose a cent of it.

## Decision

Amounts are integers in the minor unit. `src/domain/money.ts` knows the exponent of a fixed list of currencies (`CURRENCY_EXPONENT`) and refuses any other. `MAX_CHARGE_MINOR` is 99,999,999, the eight-digit maximum the code uses for a Stripe charge.

`splitCharge` computes `amount * percentBps / 10000` rounded half up, in `BigInt`, plus the fixed part. A fee that would leave the seller nothing is refused as `fee_not_below_amount`, never clipped, because a silent cap would change the commission the seller agreed to. The same rule is a CHECK in `migrations/0003_payments_objects_and_events.sql` (`fee < amount`). The caller cannot set the fee: `CheckoutRequest` has no fee field, and `test/contract/checkout.scenarios.ts` sends extra `fee`, `applicationFee` and `application_fee_amount` fields and shows they are ignored.

`allocateReversal` splits an amount taken back (a refund or a lost dispute) between platform and seller. The fee reversed after `taken + amount` is `floor(fee * (taken + amount) / sale)`, and this reversal gets the difference. The parts of any series add up exactly to the fee and the net, and the final total does not depend on the order. `test/domain/money.test.ts` checks both over random series, and checks exactness where a floating point product would overflow.

## Consequences

- If a refund that succeeded later fails, its fee part is taken back and the counters can sit one unit away from the cumulative rule. `allocateReversal` then clamps to the amount and the fee still left; the test "stays inside the amount and the fee that is left" covers it. Intermediate figures can differ by one unit from the ideal; the final total after a full reversal does not.
- The rounding rule belongs to this repository. Stripe's own proportional rounding when it reverses a transfer may differ by a unit. Reconciliation would show it as a `transfer_mismatch` warning; this has not been compared with the real API.
- Only the listed currencies work. Adding one means adding its exponent.
- The fee policy is one for all currencies, and its fixed fee and minimum charge are minor units of whichever currency the charge is in: 30 is 0.30 USD but 30 yen. That is documented in `docs/adapting.md` and recorded for JPY by `test/contract/checkout.scenarios.ts` ("applies one fee policy in the minor unit of whichever currency is charged"); a platform that sells in currencies of different exponents looks the policy up by currency in `startCheckout`.
