#!/usr/bin/env node
// pnpm model:outdated [options]
//
// List locally-downloaded models whose Hugging Face repo has changed since the
// local copy was downloaded — i.e. HF repo `lastModified` is newer than the local
// file's mtime. That usually means re-quantized weights / an updated chat template
// or tokenizer, which `lms get` will NOT pull on its own (see model:redownload).

import {
  absPathOf,
  c,
  hfLastModified,
  hfRepoOf,
  listDownloadedLocal,
  localMTime,
  modelsFolder,
  parseArgs,
  ymd,
} from "./lib/lms.mjs";

const HELP = `${c.bold("model:outdated")} — list models with an update available upstream

Compares each downloaded model's Hugging Face repo lastModified against the local
file's mtime. A newer HF timestamp means the upstream repo changed after you
downloaded (likely re-quantized weights / chat template / tokenizer).

Usage:
  pnpm model:outdated [options]

Options:
  -u, --updates-only   Show only models with an update available.
      --json           Machine-readable JSON output.
  -h, --help           Show this help.

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

  // One HF request per unique repo (variants of the same model share a repo).
  const repoLookup = new Map(); // "owner/name" -> Promise<result>

  const rows = await Promise.all(
    models.map(async (model) => {
      const repo = hfRepoOf(model);
      const local = await localMTime(absPathOf(model, folder));
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
          if (r.status === 404) note = "not on HF (alias?)";
          else if (r.status === 401 || r.status === 403) note = "gated — needs HF login";
          else note = `HF ${r.status || r.error || "error"}`;
        } else if (!r.lastModified) {
          note = "no lastModified";
        } else {
          remote = r.lastModified;
          if (!local) {
            note = "local file missing";
          } else {
            status = remote.getTime() > local.getTime() ? "update" : "ok";
          }
        }
      }

      return {
        model,
        repo: repo ? `${repo.owner}/${repo.name}` : "—",
        local,
        remote,
        status,
        note,
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
    console.error(c.dim("Update one with: ") + c.yellow("pnpm model:redownload <modelKey>"));
  }
}

main().catch((e) => {
  console.error(c.red(e.message || String(e)));
  process.exitCode = 1;
});
