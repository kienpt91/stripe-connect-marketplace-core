import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(import.meta.dirname, "../../src");

type Layer = "domain" | "application" | "infrastructure" | "composition" | "entry";

/** Which layers a layer may import from. The dependency rule: domain <- application <- infrastructure <- composition. */
const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: ["domain"],
  application: ["domain", "application"],
  infrastructure: ["domain", "application", "infrastructure"],
  composition: ["domain", "application", "infrastructure", "composition"],
  entry: ["domain", "application", "composition", "entry"],
};

/** Imports of packages and Node built-ins. Only the outer layers may do IO. */
const EXTERNAL_OK: Record<Layer, boolean> = { domain: false, application: false, infrastructure: true, composition: true, entry: true };

/** Sources of nondeterminism and IO that the pure layers must never touch: time, randomness, the process, the network, logs. */
const FORBIDDEN_IN_PURE =
  /\bDate\.now\b|\bnew Date\(\s*\)|Math\.random|performance\.now|\bprocess\.|\brequire\(|\bfetch\(|\bsetTimeout\b|\bsetInterval\b|\bglobalThis\.crypto\b|\bcrypto\.(randomUUID|getRandomValues)|\bconsole\./;

/** The one place that may talk to the database driver. */
const PG_ALLOWED_PREFIX = "infrastructure/postgres/";

function layerOf(file: string): Layer {
  const first = relative(SRC, file).split(/[\\/]/)[0] ?? "";
  if (first === "domain" || first === "application" || first === "infrastructure" || first === "composition") return first;
  return "entry";
}

export function importsOf(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(re)) out.push((m[1] ?? m[2] ?? m[3]) as string);
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function violations(file: string, source: string): string[] {
  const layer = layerOf(file);
  const rel = relative(SRC, file).split("\\").join("/");
  const code = stripComments(source);
  const found: string[] = [];
  for (const spec of importsOf(code)) {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec);
      const targetLayer = layerOf(target);
      if (!ALLOWED[layer].includes(targetLayer)) found.push(`${layer} must not import ${targetLayer}: ${spec}`);
    } else if (!EXTERNAL_OK[layer]) {
      found.push(`${layer} must not import ${spec}`);
    } else if ((spec === "pg" || spec.startsWith("pg/")) && !rel.startsWith(PG_ALLOWED_PREFIX)) {
      found.push(`only ${PG_ALLOWED_PREFIX} may import the database driver: ${spec}`);
    }
  }
  if ((layer === "domain" || layer === "application") && FORBIDDEN_IN_PURE.test(code)) {
    found.push(`${layer} touches the clock, randomness, the process, the network or the console`);
  }
  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

describe("dependency rule over the real source tree", () => {
  const files = walk(SRC);

  it("finds the source files of every layer", () => {
    const layers = new Set(files.map(layerOf));
    expect([...layers].sort()).toEqual(["application", "composition", "domain", "entry", "infrastructure"]);
  });

  it.each(files.map((f) => [relative(SRC, f), f] as const))("%s respects the layers", (_name, file) => {
    expect(violations(file, readFileSync(file, "utf8"))).toEqual([]);
  });
});

describe("the SQL of the adapter", () => {
  /** every `${...}` inside a template string that is passed to a query: the only ones that may exist are listed, with why they are safe */
  const interpolations = (file: string, call = "(?:client\\.query|rows|affected)"): string[] => {
    const source = readFileSync(join(SRC, "infrastructure/postgres", file), "utf8");
    const found: string[] = [];
    for (const m of source.matchAll(new RegExp(`${call}\\(\\s*(?:client,\\s*)?\`([^\`]*)\``, "g"))) {
      for (const inner of (m[1] as string).matchAll(/\$\{([^}]*)\}/g)) found.push(inner[1] as string);
    }
    return found;
  };

  it("covers every file of the adapter: a file added to it has to be looked at here", () => {
    expect(readdirSync(join(SRC, "infrastructure/postgres")).sort()).toEqual(["database.ts", "demo-database.ts", "errors.ts", "migrate.ts", "repositories.ts"]);
  });

  it("puts no value into SQL text: the only interpolations are a role from a fixed map and a list of placeholders", () => {
    expect(interpolations("repositories.ts")).toEqual(['tuples.join(", ")']);
    expect(interpolations("database.ts")).toEqual(["ROLE[actor.kind]"]);
    expect(interpolations("migrate.ts")).toEqual([]);
    expect(interpolations("errors.ts")).toEqual([]);
  });

  it("builds the tuples from numbered placeholders only", () => {
    const source = readFileSync(join(SRC, "infrastructure/postgres/repositories.ts"), "utf8");
    expect(source).toContain("`($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}, $${at + 6}, $${at + 7})`");
  });

  it("lists the interpolations of the demo database helper too: names and a password it generated itself, which DDL cannot take as parameters", () => {
    // CREATE DATABASE, CREATE ROLE ... PASSWORD, GRANT and DROP take identifiers and a literal, never bind parameters
    expect(interpolations("demo-database.ts", "\\b[a-z]+\\.query")).toEqual(["name", "role", "password", "role", "name", "role"]);
    const source = readFileSync(join(SRC, "infrastructure/postgres/demo-database.ts"), "utf8");
    for (const line of ['const suffix = randomBytes(5).toString("hex");', "const name = `demo_${suffix}`;", "const role = `marketplace_demo_${suffix}`;", 'const password = randomBytes(16).toString("hex");']) {
      expect(source).toContain(line);
    }
  });
});

describe("the checker itself", () => {
  const domainFile = join(SRC, "domain/x.ts");
  const appFile = join(SRC, "application/x.ts");
  const infraFile = join(SRC, "infrastructure/x.ts");
  const pgFile = join(SRC, "infrastructure/postgres/x.ts");
  const httpFile = join(SRC, "infrastructure/http/x.ts");

  it("flags a domain file importing the application or infrastructure layer", () => {
    expect(violations(domainFile, 'import { a } from "../application/a.js";')).toHaveLength(1);
    expect(violations(domainFile, 'export { b } from "../infrastructure/b.js";')).toHaveLength(1);
  });

  it("flags a domain file importing node built-ins or packages", () => {
    expect(violations(domainFile, 'import { readFile } from "node:fs";')).toHaveLength(1);
    expect(violations(domainFile, 'import pg from "pg";')).toHaveLength(1);
    expect(violations(domainFile, 'const m = await import("node:crypto");')).toHaveLength(1);
    expect(violations(domainFile, 'import "node:os";')).toHaveLength(1);
  });

  it("flags an application file importing infrastructure", () => {
    expect(violations(appFile, 'import { x } from "../infrastructure/x.js";')).toHaveLength(1);
  });

  it("lets infrastructure import inward and use node and packages", () => {
    expect(violations(infraFile, 'import { x } from "../domain/x.js"; import { y } from "../application/y.js"; import { z } from "node:fs";')).toEqual([]);
  });

  it("lets only the postgres adapter import the driver", () => {
    expect(violations(pgFile, 'import pg from "pg";')).toEqual([]);
    expect(violations(httpFile, 'import pg from "pg";')).toHaveLength(1);
    expect(violations(join(SRC, "composition/x.ts"), 'import { Pool } from "pg";')).toHaveLength(1);
  });

  it("flags infrastructure importing composition", () => {
    expect(violations(infraFile, 'import { x } from "../composition/x.js";')).toHaveLength(1);
  });

  it("flags the entry layer importing infrastructure directly", () => {
    expect(violations(join(SRC, "bin.ts"), 'import { x } from "./infrastructure/x.js";')).toHaveLength(1);
    expect(violations(join(SRC, "bin.ts"), 'import { x } from "./composition/x.js";')).toEqual([]);
  });

  it("flags clocks, randomness, console and process access in the pure layers", () => {
    expect(violations(domainFile, "const t = Date.now();")).toHaveLength(1);
    expect(violations(appFile, "const r = Math.random();")).toHaveLength(1);
    expect(violations(domainFile, "const e = process.env.X;")).toHaveLength(1);
    expect(violations(domainFile, "const d = new Date();")).toHaveLength(1);
    expect(violations(appFile, "console.log(1);")).toHaveLength(1);
  });

  it("allows a date built from a given number, which is pure", () => {
    expect(violations(domainFile, "const d = new Date(ms);")).toEqual([]);
  });

  it("ignores forbidden words that only appear in comments", () => {
    expect(violations(domainFile, "// uses Date.now() in a comment\n/* process.exit */\nconst a = 1;")).toEqual([]);
  });

  it("finds multi-line imports", () => {
    expect(importsOf('import {\n  a,\n  b,\n} from "../x.js";')).toEqual(["../x.js"]);
  });
});
