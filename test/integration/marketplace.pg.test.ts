import { describe } from "vitest";
import { allScenarios } from "../contract/all.js";
import { openPool } from "../support/connection-budget.js";
import { createTestDatabase, describeDb } from "../support/pg.js";

// The same scenarios as test/application/marketplace.test.ts, on PostgreSQL: each group gets a database of its own, with every
// migration applied and the application's login role, and the adapter switches into the role of the actor as it does in production.
describeDb("on PostgreSQL", () => {
  describe("the scenarios of the marketplace core", () => {
    allScenarios(async () => {
      const database = await createTestDatabase();
      const db = openPool({ url: database.appUrl, poolMax: 10 });
      return {
        db,
        async close() {
          await db.close();
          await database.drop();
        },
      };
    }, 8);
  });
});
