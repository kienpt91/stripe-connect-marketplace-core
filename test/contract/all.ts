import { checkoutScenarios } from "./checkout.scenarios.js";
import { convergenceScenarios } from "./convergence.scenarios.js";
import { isolationScenarios } from "./isolation.scenarios.js";
import { moneyScenarios } from "./money.scenarios.js";
import { onboardingScenarios } from "./onboarding.scenarios.js";
import { reconciliationScenarios } from "./reconciliation.scenarios.js";
import type { DbFactory } from "./support.js";
import { webhookScenarios } from "./webhooks.scenarios.js";

/** Every scenario of the marketplace core, against the database `open` gives. `shuffles` is how many random orders of one afternoon are replayed. */
export function allScenarios(open: DbFactory, shuffles: number): void {
  onboardingScenarios(open);
  checkoutScenarios(open);
  webhookScenarios(open);
  moneyScenarios(open);
  isolationScenarios(open);
  reconciliationScenarios(open);
  convergenceScenarios(open, shuffles);
}
