import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/** The SQL migrations shipped with the package. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

export interface MigrationReport {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

const FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/**
 * Applies the plain SQL files of a directory in order, each in its own transaction, once. The checksum of every applied
 * file is recorded and a file that was edited after it ran is refused, so a database and the files cannot drift apart
 * unnoticed. Run it with the owner role of the schema (it creates tables, roles and policies), never with the
 * application's login role. An advisory lock keeps two deployments from migrating at the same time.
 */
export async function migrate(adminUrl: string, directory: string): Promise<MigrationReport> {
  const files = (await readdir(directory)).filter((name) => FILE.test(name)).sort();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('stripe-connect-marketplace-core:migrations', 0))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Map((await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations")).rows.map((r) => [r.version, r.checksum]));
    const applied: string[] = [];
    const already: string[] = [];
    for (const name of files) {
      const sql = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const recorded = done.get(name);
      if (recorded !== undefined) {
        if (recorded !== checksum) throw new Error(`migration ${name} was changed after it was applied`);
        already.push(name);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [name, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(name);
    }
    return { applied, alreadyApplied: already };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('stripe-connect-marketplace-core:migrations', 0))").catch(() => undefined);
    await client.end();
  }
}
