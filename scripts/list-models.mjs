#!/usr/bin/env node
// pnpm model:ls — list models downloaded on THIS machine, with sizes and on-disk paths.
import { c, describe, formatBytes, listDownloadedLocal, modelsFolder } from "./lib/lms.mjs";

try {
  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.log("No local models.");
    process.exit(0);
  }
  models.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  const total = models.reduce((s, m) => s + (m.sizeBytes || 0), 0);
  console.log(c.dim(`Models folder: ${modelsFolder()}`));
  console.log(c.dim(`${models.length} local models · ${formatBytes(total)} total\n`));
  for (const m of models) console.log("  " + describe(m));
} catch (e) {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
}
