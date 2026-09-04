#!/usr/bin/env node
// pnpm model:ls [options] — list models downloaded on THIS machine, with sizes and on-disk paths.
import {
  c,
  checkVisionMmproj,
  checkVisionMmprojStrict,
  describe,
  formatBytes,
  listDownloadedLocal,
  loadModelIndex,
  modelsFolder,
  parseArgs,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:ls")} — list models downloaded on THIS machine

Usage:
  pnpm model:ls [options]

Options:
      --strict    Also flag a GGUF vision model missing its mmproj even when LM Studio's
                  local "vision" flag has already flipped to false because of it (i.e. the
                  mmproj file is gone entirely, not just 0 bytes) — offline, no HF lookup.
                  Allowlist-based (see VISION_ARCHITECTURES in lib/lms.mjs): can miss a
                  brand-new architecture, or flag a genuinely text-only same-family variant.
                  For a network-verified check with neither failure mode, use
                  \`model:outdated -u\` instead.
  -h, --help      Show this help.`;

try {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    process.exit(0);
  }

  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.log("No local models.");
    process.exit(0);
  }
  models.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  const total = models.reduce((s, m) => s + (m.sizeBytes || 0), 0);
  const folder = modelsFolder();
  const index = loadModelIndex();
  const strict = Boolean(flags.strict);
  const checkFn = strict ? checkVisionMmprojStrict : checkVisionMmproj;
  console.log(c.dim(`Models folder: ${folder}${strict ? "  ·  --strict" : ""}`));
  console.log(c.dim(`${models.length} local models · ${formatBytes(total)} total\n`));
  let broken = 0;
  for (const m of models) {
    console.log("  " + describe(m));
    const check = checkFn(m, folder, index);
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
