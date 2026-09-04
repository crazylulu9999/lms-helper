#!/usr/bin/env node
// pnpm model:ls — list models downloaded on THIS machine, with sizes and on-disk paths.
import {
  c,
  checkVisionMmproj,
  describe,
  formatBytes,
  listDownloadedLocal,
  loadModelIndex,
  modelsFolder,
} from "./lib/lms.mjs";

try {
  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.log("No local models.");
    process.exit(0);
  }
  models.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  const total = models.reduce((s, m) => s + (m.sizeBytes || 0), 0);
  const folder = modelsFolder();
  const index = loadModelIndex();
  console.log(c.dim(`Models folder: ${folder}`));
  console.log(c.dim(`${models.length} local models · ${formatBytes(total)} total\n`));
  let broken = 0;
  for (const m of models) {
    console.log("  " + describe(m));
    const check = checkVisionMmproj(m, folder, index);
    if (check && !check.ok) {
      broken++;
      console.log(c.yellow(`    ⚠ vision model, ${check.reason} — won't load ("Failed to load CLIP model")`));
    }
  }
  if (broken > 0) {
    console.error(
      c.yellow(`\n${broken} vision model(s) missing a usable mmproj file (GGUF only, see ⚠ above).`),
    );
    process.exitCode = 1;
  }
} catch (e) {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
}
