#!/usr/bin/env node
// pnpm model:redownload [modelKey] [options]
//
// Force-update a downloaded model: delete the local variant, then re-`lms get` it
// from Hugging Face. `lms get` on its own SKIPS an already-present variant
// ("Model already downloaded") even when the upstream repo has newer files, so an
// in-place update is impossible (lms issue #579). Deleting first makes the fresh
// pull actually happen. Hub-aliased models (e.g. "google/gemma-4-31b-qat") are
// resolved to their real underlying repo via the model-index cache.

import {
  c,
  confirm,
  enrichModel,
  formatBytes,
  hfRepoFromPath,
  listDownloadedLocal,
  loadModelIndex,
  loadedBlockers,
  modelsFolder,
  parseArgs,
  pathIsAtOrInside,
  redownloadModel,
  resolveTarget,
  wantsYes,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:redownload")} — delete then re-download a model (force-update)

Usage:
  pnpm model:redownload [modelKey] [options]

Arguments:
  modelKey            e.g. "gemma-4-26b-a4b-it@q4_k_m". Omit to pick interactively.

Options:
  -y, --yes           Skip the confirmation prompt. Fully non-interactive: if the same
                      quant can't be re-fetched, fail instead of opening lms's variant picker.
      --unload        Unload the model first if it is currently loaded.
      --keep-partials Do not clean leftover download partials before re-fetching.
  -h, --help          Show this help.`;

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    return;
  }

  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.error(c.red("No local models found."));
    process.exitCode = 1;
    return;
  }

  const target = await resolveTarget(positionals[0], models, "re-download");
  if (!target) {
    console.error(c.dim("Cancelled."));
    return;
  }

  const folder = modelsFolder();
  const index = loadModelIndex();
  const { fileAbsPath, repoRelPath, sourceType } = enrichModel(target, folder, index);

  if (!pathIsAtOrInside(folder, fileAbsPath)) {
    console.error(
      c.red(
        sourceType === "bundled"
          ? `"${target.modelKey}" is a bundled model and can't be re-downloaded.`
          : `Refusing to touch a path outside the models folder:\n  ${fileAbsPath}`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const repo = hfRepoFromPath(repoRelPath);
  if (!repo) {
    console.error(c.red(`Can't derive a Hugging Face repo for "${target.modelKey}".`));
    if (sourceType === "user") {
      console.error(c.dim("This looks like a locally imported/created model — nothing to pull from HF."));
    }
    process.exitCode = 1;
    return;
  }
  const repoUrl = `https://huggingface.co/${repo.owner}/${repo.name}`;
  const quant = target.quantization?.name?.toLowerCase();

  // Friendly loaded-model guard: refuse early unless --unload (redownloadModel does the actual unload).
  const blockers = loadedBlockers(fileAbsPath, folder);
  if (blockers.length > 0 && !flags.unload) {
    console.error(c.red("This model is currently loaded:"));
    for (const b of blockers) console.error(`  ${c.yellow(b.identifier)}`);
    console.error(`Unload it first (\`lms unload\`) or pass ${c.yellow("--unload")}.`);
    process.exitCode = 1;
    return;
  }

  console.error(
    `\n${c.bold("Re-download:")} ${c.cyan(target.modelKey)}` + (quant ? ` ${c.dim(quant.toUpperCase())}` : ""),
  );
  console.error(`${c.dim("Delete:  ")} ${fileAbsPath} ${c.dim(`(${formatBytes(target.sizeBytes)})`)}`);
  console.error(`${c.dim("Re-get:  ")} ${repoUrl}`);

  if (!wantsYes(flags)) {
    const ok = await confirm(c.yellow("\nDelete the local copy and re-download from Hugging Face?"));
    if (!ok) {
      console.error(c.dim("Aborted. Nothing changed."));
      return;
    }
  }
  console.error(c.dim("\nStarting `lms get` …"));

  const res = await redownloadModel(target, folder, {
    yes: wantsYes(flags),
    unload: Boolean(flags.unload),
    keepPartials: Boolean(flags["keep-partials"]),
    index,
  });

  if (res.ok) {
    console.error(c.green("\n✓ Done. Load it with: ") + c.yellow(`lms load ${target.modelKey}`));
  } else if (res.reason) {
    console.error(c.red(`\nFailed: ${res.reason}`));
    process.exitCode = 1;
  } else {
    console.error(
      c.red(
        `\n\`lms get\` exited with code ${res.code}. If it says "already downloaded", restart LM Studio to refresh its model index, then retry.`,
      ),
    );
    process.exitCode = res.code || 1;
  }
}

main().catch((e) => {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
});
