#!/usr/bin/env node
// pnpm model:redownload [modelKey] [options]
//
// Force-update a downloaded model: delete the local variant, then re-`lms get` it
// from Hugging Face. `lms get` on its own SKIPS an already-present variant
// ("Model already downloaded") even when the upstream repo has newer files, so an
// in-place update is impossible (lms issue #579). Deleting first makes the fresh
// pull actually happen.

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
  resolveTarget,
  wantsYes,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:redownload")} — delete then re-download a model (force-update)

Usage:
  pnpm model:redownload [modelKey] [options]

Arguments:
  modelKey            e.g. "gemma-4-26b-a4b-it@q4_k_m". Omit to pick interactively.

Options:
  -y, --yes           Skip confirmation AND try a non-interactive fetch of the same
                      quant (falls back to interactive variant selection on failure).
      --unload        Unload the model first if it is currently loaded.
      --keep-partials Do not clean up leftover download partials before re-fetching.
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
  const absPath = absPathOf(target, folder);
  if (!pathIsAtOrInside(folder, absPath)) {
    console.error(c.red(`Refusing to touch a path outside the models folder:\n  ${absPath}`));
    process.exitCode = 1;
    return;
  }

  // Derive the Hugging Face repo from the on-disk path: <publisher>/<repo>/<file...>
  const segs = target.path.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) {
    console.error(c.red(`Can't derive a Hugging Face repo from path "${target.path}".`));
    console.error(
      `Re-download manually, e.g.: ${c.yellow('lms get "https://huggingface.co/<pub>/<repo>" --select')}`,
    );
    process.exitCode = 1;
    return;
  }
  const repoUrl = `https://huggingface.co/${segs[0]}/${segs[1]}`;
  const quant = target.quantization?.name?.toLowerCase();

  // Loaded guard (auto-unload with --unload; re-download implies replacing the file).
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
    `\n${c.bold("Re-download:")} ${c.cyan(target.modelKey)}` +
      (quant ? ` ${c.dim(quant.toUpperCase())}` : ""),
  );
  console.error(`${c.dim("Delete:  ")} ${absPath} ${c.dim(`(${formatBytes(target.sizeBytes)})`)}`);
  console.error(`${c.dim("Re-get:  ")} ${repoUrl}`);

  if (!wantsYes(flags)) {
    const ok = await confirm(
      c.yellow("\nDelete the local copy and re-download from Hugging Face?"),
    );
    if (!ok) {
      console.error(c.dim("Aborted. Nothing changed."));
      return;
    }
  }

  // 1) Delete just this variant file (keep siblings: config.json / mmproj / other quants).
  await fsp.rm(absPath, { recursive: true, force: true });
  if (!flags["keep-partials"]) await cleanPartials(absPath);
  console.error(c.green("✓ Deleted local copy."));

  // 2) Re-download. With -y try the exact quant non-interactively; otherwise (or on
  //    failure) hand off to interactive `--select` so the user picks the same variant.
  console.error(c.dim("\nStarting `lms get` …"));
  let code;
  if (wantsYes(flags) && quant) {
    code = lmsInteractive(["get", `${repoUrl}@${quant}`, "-y"]);
    if (code !== 0) {
      console.error(c.yellow("\nExact-quant fetch failed; falling back to interactive selection."));
      code = lmsInteractive(["get", repoUrl, "--select"]);
    }
  } else {
    if (quant) console.error(c.dim(`(In the variant list, choose: ${c.yellow(quant.toUpperCase())})`));
    code = lmsInteractive(["get", repoUrl, "--select"]);
  }

  if (code === 0) {
    console.error(c.green("\n✓ Done. Load it with: ") + c.yellow(`lms load ${target.modelKey}`));
  } else {
    console.error(
      c.red(
        `\n\`lms get\` exited with code ${code}. If it says "already downloaded", restart LM Studio to refresh its model index, then retry.`,
      ),
    );
    process.exitCode = code;
  }
}

main().catch((e) => {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
});
