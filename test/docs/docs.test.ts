import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SKIP = new Set(["node_modules", "dist", "out", ".git", "package-lock.json"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(ROOT);
const markdown = files.filter((f) => f.endsWith(".md"));
const read = (f: string): string => readFileSync(f, "utf8");

describe("the documentation points at things that exist", () => {
  it("has every document the README promises", () => {
    for (const name of ["README.md", "SECURITY.md", "CHANGELOG.md", "RELEASING.md", "LICENSE", "docs/adapting.md", "docs/deployment.md", "docs/demo-output.txt", ".env.example"]) {
      expect(existsSync(join(ROOT, name)), name).toBe(true);
    }
    expect(readdirSync(join(ROOT, "docs/adr")).filter((n) => /^\d{4}-.+\.md$/.test(n)).length).toBeGreaterThanOrEqual(7);
  });

  it.each(markdown.map((f) => [relative(ROOT, f), f] as const))("%s: every relative link resolves", (_name, file) => {
    for (const m of read(file).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1] as string;
      if (/^[a-z]+:/i.test(target)) continue;
      expect(existsSync(resolve(dirname(file), target)), `${relative(ROOT, file)} -> ${target}`).toBe(true);
    }
  });

  it("names a real test for every claim of the threat model, and a real test title where it quotes one", () => {
    const text = read(join(ROOT, "SECURITY.md"));
    const rows = text.split("\n").filter((l) => /^\| .* \| .* \| .* \|$/.test(l) && !l.startsWith("| Threat") && !l.startsWith("| ---"));
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const row of rows) {
      const cell = row.split(" | ").slice(2).join(" | ");
      const tokens = [...cell.matchAll(/`((?:[a-z-]+\/)+[A-Za-z0-9.-]+\.(?:test|scenarios)\.ts)`|"([^"]+)"/g)];
      let current: string | undefined;
      let named = 0;
      for (const t of tokens) {
        if (t[1] !== undefined) {
          current = join(ROOT, "test", t[1]);
          named += 1;
          expect(existsSync(current), `${t[1]} (${row.slice(0, 50)})`).toBe(true);
        } else if (current !== undefined) {
          const title = (t[2] as string).replace(/ \.\.\.$/, "");
          expect(read(current), `"${title}" in ${relative(ROOT, current)}`).toContain(title);
        }
      }
      const scripted = /scripts\/|CI job|demo section/.test(cell);
      expect(named > 0 || scripted, `no test named in: ${row.slice(0, 60)}`).toBe(true);
    }
  });

  it("lists the scripts and the migrations it mentions", () => {
    for (const f of markdown) {
      for (const m of read(f).matchAll(/`(scripts\/[a-z-]+\.(?:sh|mjs))`/g)) expect(existsSync(join(ROOT, m[1] as string)), `${relative(ROOT, f)}: ${m[1]}`).toBe(true);
    }
  });
});

describe("the repository text", () => {
  const textFiles = files.filter((f) => /\.(md|ts|sh|mjs|sql|json|yml|yaml|txt|example)$/.test(f) || f.endsWith("LICENSE") || f.endsWith(".gitignore"));

  it("carries no contact information: no e-mail address, phone number or social handle", () => {
    const email = /(?<![/:\w.-])[\w.+-]+@[\w-]+\.(?:com|org|net|io|dev|me|app|co)\b/i;
    const phone = /(?<![\w.-])\+\d[\d ()-]{8,}\d/;
    const hits = textFiles.filter((f) => !f.includes("/test/") && !f.endsWith("package.json")).flatMap((f) => read(f).split("\n").map((line, i) => ({ f, i, line })).filter((x) => email.test(x.line) || phone.test(x.line)).map((x) => `${relative(ROOT, x.f)}:${x.i + 1}`));
    expect(hits).toEqual([]);
  });

  it("says nothing about gambling or lottery", () => {
    const pattern = /\b(gambl\w*|lotter\w*|casino|betting|wager\w*)\b/i;
    const hits = textFiles.filter((f) => !f.endsWith("docs.test.ts")).filter((f) => pattern.test(read(f))).map((f) => relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
