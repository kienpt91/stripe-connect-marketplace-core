import { describe } from "vitest";
import { MemoryDatabase } from "../support/memory-db.js";
import { allScenarios } from "../contract/all.js";

// The same scenarios run on the PostgreSQL adapter in test/integration/marketplace.pg.test.ts; the double is only trusted where both agree.
describe("on the in-memory double", () => {
  allScenarios(async () => ({ db: new MemoryDatabase(), close: async () => undefined }), 60);
});
