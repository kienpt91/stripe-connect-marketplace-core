import { defineConfig } from "vitest/config";

// One configuration for both runs, with the same thresholds in both (domain 95, application 90, overall 85).
// The default run needs no database: the tests under test/integration are left out, and so are the files that only a
// database can exercise (the PostgreSQL adapter, the demo database helper and the server runner), both from the tests and
// from the coverage report. With MARKETPLACE_TEST_DATABASE_URL (scripts/integration.sh starts a throwaway PostgreSQL) every
// test runs and every file is measured.
const withDatabase = Boolean(process.env.MARKETPLACE_TEST_DATABASE_URL);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", ...(withDatabase ? [] : ["test/integration/**"])],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // every database test file creates and drops its own database, one file at a time
    fileParallelism: !withDatabase,
    // the PostgreSQL run has a connection budget (test/support/connection-budget.ts): one file at a time, one worker, and a monitor
    // that checks the server's limit before the run and the measured peak after it
    ...(withDatabase ? { maxWorkers: 1, globalSetup: ["test/support/connection-monitor.ts"] } : {}),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/bin.ts", "src/demo/main.ts", "src/**/*.d.ts", ...(withDatabase ? [] : ["src/infrastructure/postgres/**", "src/composition/serve.ts"])],
      reporter: ["text", "json-summary"],
      reportsDirectory: "out/coverage",
      thresholds: {
        "src/domain/**": { lines: 95, statements: 95 },
        "src/application/**": { lines: 90, statements: 90 },
        lines: 85,
        statements: 85,
      },
    },
  },
});
