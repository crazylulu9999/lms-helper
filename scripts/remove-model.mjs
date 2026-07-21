#!/usr/bin/env node
// pnpm model:rm [modelKey] [options]
//
// Delete a downloaded LM Studio model from disk — the missing `lms remove`.
// Ported from lmstudio-ai/lms PR #580 (issue #579): a filesystem delete of the
// model's path under the resolved models folder, made safe (containment check,
// loaded-model guard, confirmation, empty-folder pruning).

import fsp from "node:fs/promises";
import {
  absPathOf,
  c,
  cleanPartials,
  confirm,
  formatBytes,
  listDownloadedLocal,
  lmsInteractive,
  loadedBlockers,
  modelsFolder,
  parseArgs,
  pathIsAtOrInside,
  pruneEmptyParents,
  resolveTarget,
  wantsYes,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:rm")} — delete a downloaded LM Studio model from disk

Usage:
  pnpm model:rm [modelKey] [options]

Arguments:
  modelKey        e.g. "gemma-4-26b-a4b-it@q4_k_m". Omit to pick interactively.

Options:
  -y, --yes       Skip the confirmation prompt.
      --unload    Unload the model first if it is currently loaded.
      --dry-run   Show what would be deleted, without deleting.
  -h, --help      Show this help.`;

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    return;
  }

  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.error(c.red("No local models to remove.") + " Download one with `lms get <model>`.");
    process.exitCode = 1;
    return;
  }

  const target = await resolveTarget(positionals[0], models, "remove");
  if (!target) {
    console.error(c.dim("Cancelled."));
    return;
  }

  const folder = modelsFolder();
  const absPath = absPathOf(target, folder);

  // Never delete anything outside the models folder.
  if (!pathIsAtOrInside(folder, absPath)) {
    console.error(c.red(`Refusing to delete a path outside the models folder:\n  ${absPath}`));
    process.exitCode = 1;
    return;
  }

  // Refuse (or auto-unload) if the model is currently loaded.
  const blockers = loadedBlockers(absPath, folder);
  if (blockers.length > 0) {
    if (flags.unload) {
      for (const b of blockers) {
        console.error(c.dim(`Unloading ${b.identifier} …`));
        lmsInteractive(["unload", b.identifier]);
      }
    } else {
      console.error(c.red("This model is currently loaded:"));
      for (const b of blockers) console.error(`  ${c.yellow(b.identifier)}`);
      console.error(`Unload it first (\`lms unload\`) or pass ${c.yellow("--unload")}.`);
      process.exitCode = 1;
      return;
    }
  }

  console.error(
    `\n${c.bold("Remove:  ")}${c.cyan(target.modelKey)}` +
      (target.quantization?.name ? ` ${c.dim(target.quantization.name)}` : ""),
  );
  console.error(`${c.dim("Size:    ")}${formatBytes(target.sizeBytes)}`);
  console.error(`${c.dim("Location:")} ${absPath}`);

  if (flags["dry-run"]) {
    console.error(c.yellow("\n[dry-run] Nothing was deleted."));
    return;
  }

  if (!wantsYes(flags)) {
    const ok = await confirm(
      c.red(`\nPermanently delete this model (${formatBytes(target.sizeBytes)})?`),
    );
    if (!ok) {
      console.error(c.dim("Aborted. Nothing removed."));
      return;
    }
  }

  // `recursive: true` handles both single-file (.gguf) and folder-style variant paths.
  await fsp.rm(absPath, { recursive: true, force: true });
  await cleanPartials(absPath);
  await pruneEmptyParents(absPath, folder);
  console.error(c.green(`✓ Removed "${target.modelKey}" — freed ${formatBytes(target.sizeBytes)}.`));
}

main().catch((e) => {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
});
