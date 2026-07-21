#!/usr/bin/env node
// pnpm model:outdated [options]
//
// List locally-downloaded models whose Hugging Face repo has changed since the
// local copy was downloaded — i.e. HF repo `lastModified` is newer than the local
// file's mtime. That usually means re-quantized weights / an updated chat template
// or tokenizer, which `lms get` will NOT pull on its own (see model:redownload).

import {
  c,
  confirm,
  enrichModel,
  formatBytes,
  hfLastModified,
  hfRepoFromPath,
  hfToken,
  listDownloadedLocal,
  loadModelIndex,
  localMTime,
  modelsFolder,
  parseArgs,
  pickMany,
  redownloadModel,
  wantsYes,
  ymd,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:outdated")} — list models with an update available upstream

Compares each downloaded model's Hugging Face repo lastModified against the local
file's mtime. A newer HF timestamp means the upstream repo changed after you
downloaded (likely re-quantized weights / chat template / tokenizer).

Usage:
  pnpm model:outdated [options]

Options:
  -i, --interactive    Pick models with an update and re-download them.
                       (picker: ↑/↓ move · space toggle · a all · s sort · r reverse)
  -y, --yes            With -i: skip the confirmation before re-downloading.
  -u, --updates-only   Show only models with an update available.
      --json           Machine-readable JSON output.
  -h, --help           Show this help.

Auth: set $HF_TOKEN (or $HUGGING_FACE_HUB_TOKEN) to check gated repos (Google,
Nvidia, …); without it they show as "unknown".

Note: the check is repo-level (any file change bumps lastModified). Models whose
path is not a Hugging Face repo (LM Studio catalog aliases) show as "unknown".`;

const STATUS_LABEL = {
  update: "⬆ update    ",
  ok: "✓ up-to-date",
  unknown: "? unknown   ",
};

function badge(status) {
  const label = STATUS_LABEL[status];
  if (status === "update") return c.yellow(label);
  if (status === "ok") return c.green(label);
  return c.dim(label);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(HELP);
    return;
  }

  const models = listDownloadedLocal();
  if (models.length === 0) {
    console.error("No local models.");
    return;
  }
  const folder = modelsFolder();
  const index = loadModelIndex();

  // One HF request per unique repo (variants of the same model share a repo).
  const repoLookup = new Map(); // "owner/name" -> Promise<result>

  const rows = await Promise.all(
    models.map(async (model) => {
      // Consult the model-index cache so Hub aliases / bundled models resolve to real paths.
      const { fileAbsPath, repoRelPath, sourceType } = enrichModel(model, folder, index);
      const repo = hfRepoFromPath(repoRelPath);
      const local = await localMTime(fileAbsPath);
      let status = "unknown";
      let remote = null;
      let note = "";

      if (!repo) {
        note = "no HF repo in path";
      } else {
        const key = `${repo.owner}/${repo.name}`;
        if (!repoLookup.has(key)) repoLookup.set(key, hfLastModified(repo.owner, repo.name));
        const r = await repoLookup.get(key);
        if (!r.ok) {
          if (r.status === 404) note = sourceType === "user" ? "imported locally (not on HF)" : "not on HF";
          else if (r.status === 401 || r.status === 403) note = "gated — set $HF_TOKEN";
          else note = `HF ${r.status || r.error || "error"}`;
        } else if (!r.lastModified) {
          note = "no lastModified";
        } else {
          remote = r.lastModified;
          if (!local) note = "local file missing";
          else status = remote.getTime() > local.getTime() ? "update" : "ok";
        }
      }

      return {
        model,
        repo: repo ? `${repo.owner}/${repo.name}` : "—",
        local,
        remote,
        status,
        note,
        sourceType,
      };
    }),
  );

  if (flags.json) {
    console.log(
      JSON.stringify(
        rows.map((r) => ({
          modelKey: r.model.modelKey,
          quant: r.model.quantization?.name || null,
          repo: r.repo,
          source: r.sourceType || undefined,
          localDate: ymd(r.local),
          remoteDate: ymd(r.remote),
          status: r.status,
          note: r.note || undefined,
        })),
        null,
        2,
      ),
    );
    return;
  }

  // Interactive mode: pick from the models that have updates and re-download them.
  if (flags.i || flags.interactive) {
    const candidates = rows
      .filter((r) => r.status === "update")
      .sort((a, b) => (b.remote?.getTime() || 0) - (a.remote?.getTime() || 0))
      .map((r) => r.model);
    if (candidates.length === 0) {
      console.error(c.green("\nAll models are up to date — nothing to re-download. 🎉"));
      return;
    }
    const rowOf = new Map(rows.map((r) => [r.model, r]));
    const dateOf = (m) => `${ymd(rowOf.get(m)?.local)} → ${ymd(rowOf.get(m)?.remote)}`;
    const render = (m) =>
      `${c.cyan(m.modelKey)}${m.quantization?.name ? ` ${c.dim(m.quantization.name)}` : ""}  ` +
      `${c.dim(dateOf(m))}  ${c.dim(formatBytes(m.sizeBytes))}`;
    // Sort modes cycled with `s` (reverse with `r`) inside the picker.
    const sorts = [
      { label: "update date", cmp: (a, b) => (rowOf.get(b)?.remote?.getTime() || 0) - (rowOf.get(a)?.remote?.getTime() || 0) },
      { label: "name", cmp: (a, b) => a.modelKey.localeCompare(b.modelKey) },
      { label: "size", cmp: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0) },
      { label: "local age", cmp: (a, b) => (rowOf.get(a)?.local?.getTime() || 0) - (rowOf.get(b)?.local?.getTime() || 0) },
    ];
    const chosen = await pickMany(
      candidates,
      render,
      `${c.bold("Select models to re-download")} ${c.dim("(delete local → fresh pull from Hugging Face)")}:`,
      { sorts },
    );
    if (chosen.length === 0) {
      console.error(c.dim("Cancelled. Nothing changed."));
      return;
    }
    const total = chosen.reduce((s, m) => s + (m.sizeBytes || 0), 0);
    console.error(
      `\n${c.bold(`${chosen.length} model(s) selected`)} · ${formatBytes(total)} will be deleted and re-downloaded.`,
    );
    console.error(c.dim("Any that are currently loaded will be unloaded first."));
    if (!wantsYes(flags)) {
      const ok = await confirm(c.yellow("Proceed?"));
      if (!ok) {
        console.error(c.dim("Cancelled. Nothing changed."));
        return;
      }
    }
    let done = 0;
    let failed = 0;
    for (const m of chosen) {
      console.error(
        `\n${c.bold("──")} ${c.cyan(m.modelKey)}${m.quantization?.name ? ` ${c.dim(m.quantization.name)}` : ""}`,
      );
      const res = await redownloadModel(m, folder, { yes: true, unload: true, keepPartials: false, index });
      if (res.ok) {
        done++;
        console.error(c.green(`✓ ${m.modelKey} updated.`));
      } else {
        failed++;
        console.error(c.red(`✗ ${m.modelKey}: ${res.reason || `lms get exit ${res.code}`}`));
      }
    }
    console.error(
      `\n${c.green(`${done} updated`)}${failed ? ` · ${c.red(`${failed} failed`)}` : ""}.` +
        (done ? ` Reload with ${c.yellow("lms load <modelKey>")}.` : ""),
    );
    return;
  }

  const order = { update: 0, unknown: 1, ok: 2 };
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (b.remote?.getTime() || 0) - (a.remote?.getTime() || 0),
  );

  const onlyUpdates = Boolean(flags.u || flags.updates || flags["updates-only"]);
  const shown = onlyUpdates ? rows.filter((r) => r.status === "update") : rows;

  console.error(
    c.dim(`Models folder: ${folder}  ·  comparing HF repo lastModified vs local mtime\n`),
  );
  for (const r of shown) {
    const q = r.model.quantization?.name ? ` ${c.dim(r.model.quantization.name)}` : "";
    const dates = `${c.dim("local")} ${ymd(r.local)} ${c.dim("→ HF")} ${ymd(r.remote)}`;
    const note = r.note ? c.dim(`  (${r.note})`) : "";
    console.log(`  ${badge(r.status)}  ${c.cyan(r.model.modelKey)}${q}   ${dates}${note}`);
  }
  if (onlyUpdates && shown.length === 0) {
    console.log(c.green("  All models are up to date. 🎉"));
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  console.error(
    `\n${c.yellow(`${count("update")} update(s) available`)} · ` +
      `${c.green(`${count("ok")} up-to-date`)} · ` +
      `${c.dim(`${count("unknown")} unknown`)}`,
  );
  if (count("update") > 0) {
    console.error(
      c.dim("Update interactively: ") +
        c.yellow("pnpm model:outdated -i") +
        c.dim("   ·   one model: ") +
        c.yellow("pnpm model:redownload <modelKey>"),
    );
  }
  if (count("unknown") > 0 && !hfToken()) {
    console.error(
      c.dim("Set ") + c.yellow("$HF_TOKEN") + c.dim(" to check gated repos (Google, Nvidia, …)."),
    );
  }
}

main().catch((e) => {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
});
