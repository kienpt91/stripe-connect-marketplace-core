#!/usr/bin/env node
// Lists every package in package-lock.json whose locked version was published
// after a cutoff date. Exit code 1 if any are found.
//
//   node scripts/check-dep-age.mjs [cutoff-iso-date]
//
// Without an argument the cutoff is 7 days before now (the dependency policy).
import { readFileSync } from "node:fs";

const cutoff = new Date(process.argv[2] ?? Date.now() - 7 * 24 * 60 * 60 * 1000);
if (Number.isNaN(cutoff.getTime())) {
  console.error("Invalid cutoff date");
  process.exit(2);
}

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const locked = new Map();
for (const [path, info] of Object.entries(lock.packages)) {
  if (path === "" || !info.version || info.link) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  locked.set(`${name}@${info.version}`, { name, version: info.version });
}

const packuments = new Map();
async function publishTime(name, version) {
  if (!packuments.has(name)) {
    packuments.set(
      name,
      fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`)
        .then((r) => {
          if (!r.ok) throw new Error(`${name}: registry responded ${r.status}`);
          return r.json();
        })
        .then((doc) => doc.time),
    );
  }
  return (await packuments.get(name))[version];
}

const tooNew = [];
const entries = [...locked.values()];
for (let i = 0; i < entries.length; i += 16) {
  await Promise.all(
    entries.slice(i, i + 16).map(async ({ name, version }) => {
      const time = await publishTime(name, version);
      if (!time) throw new Error(`${name}@${version}: no publish time in registry`);
      if (new Date(time) > cutoff) tooNew.push(`${name}@${version} (${time})`);
    }),
  );
}

console.log(`Checked ${entries.length} locked packages against cutoff ${cutoff.toISOString()}`);
if (tooNew.length > 0) {
  console.log("Published after the cutoff:");
  for (const line of tooNew.sort()) console.log(`  ${line}`);
  process.exit(1);
}
console.log("None published after the cutoff.");
