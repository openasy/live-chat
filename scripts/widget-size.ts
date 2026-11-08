// The window is loaded on every page of a site, so its size is watched: the build fails when the gzipped script grows
// past the budget.
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const BUDGET = 14 * 1024;
const file = new URL("../dist/widget/w.js", import.meta.url);
const raw = readFileSync(file);
const gz = gzipSync(raw, { level: 9 }).length;
console.log(`dist/widget/w.js: ${(raw.length / 1024).toFixed(1)} KiB, ${(gz / 1024).toFixed(1)} KiB gzipped (budget ${BUDGET / 1024} KiB)`);
if (gz > BUDGET) {
  console.error("The window script is over its budget; make it smaller or raise BUDGET with a reason.");
  process.exit(1);
}
