// Shared helpers for the LM Studio model helper scripts.
//
// Zero-dependency: talks to the `lms` CLI (JSON output) plus the local filesystem.
// The safety model is ported from lmstudio-ai/lms PR #580 ("Add `lms remove`"):
//   - only ever touch models stored on THIS machine (deviceIdentifier === null)
//   - never delete anything outside the resolved models folder (path-containment check)
//   - refuse to delete a model that is currently loaded
// See: https://github.com/lmstudio-ai/lms/pull/580  (issue https://github.com/lmstudio-ai/lms/issues/579)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

// --- tiny ANSI helpers (no dependency) ---
const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = {
  bold: paint(1),
  dim: paint(2),
  red: paint(91),
  green: paint(92),
  yellow: paint(93),
  cyan: paint(96),
};

// --- LM Studio paths ---
export function lmstudioHome() {
  return process.env.LMSTUDIO_HOME || path.join(os.homedir(), ".lmstudio");
}

/** Resolve the `lms` binary: $LMS_BIN → ~/.lmstudio/bin/lms → "lms" on PATH. */
export function lmsBin() {
  if (process.env.LMS_BIN) return process.env.LMS_BIN;
  const bundled = path.join(lmstudioHome(), "bin", "lms");
  return fs.existsSync(bundled) ? bundled : "lms";
}

/**
 * Resolve the models folder. Reads `downloadsFolder` from LM Studio's settings.json,
 * falling back to <home>/models — the same resolution as PR #580's resolveModelsFolderPath.
 */
export function modelsFolder() {
  const home = lmstudioHome();
  let folder = path.join(home, "models");
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8"));
    if (typeof settings.downloadsFolder === "string" && settings.downloadsFolder) {
      folder = settings.downloadsFolder;
    }
  } catch {
    // ignore — fall back to the default folder
  }
  return folder;
}

// --- lms CLI invocation ---
function run(args, opts = {}) {
  const r = spawnSync(lmsBin(), args, { encoding: "utf8", ...opts });
  if (r.error) {
    if (r.error.code === "ENOENT") {
      throw new Error("Could not find the 'lms' CLI. Set $LMS_BIN or install LM Studio.");
    }
    throw r.error;
  }
  return r;
}

/** Run an `lms ... --json` command and parse stdout. */
export function lmsJson(args) {
  const r = run(args);
  if (r.status !== 0) {
    throw new Error(`\`lms ${args.join(" ")}\` failed:\n${(r.stderr || r.stdout || "").trim()}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new Error(`\`lms ${args.join(" ")}\` did not return valid JSON.`);
  }
}

/** Run an interactive `lms` command (inherits the terminal). Returns the exit code. */
export function lmsInteractive(args) {
  const r = run(args, { stdio: "inherit", encoding: undefined });
  return r.status ?? 1;
}

// --- model queries (local only) ---
/** Downloaded models stored on THIS machine (deviceIdentifier === null; remote LM Link peers excluded). */
export function listDownloadedLocal() {
  const all = lmsJson(["ls", "--json"]);
  return (Array.isArray(all) ? all : []).filter((m) => m.deviceIdentifier == null);
}

/** Loaded models on THIS machine. */
export function listLoadedLocal() {
  let all;
  try {
    all = lmsJson(["ps", "--json"]);
  } catch {
    all = [];
  }
  return (Array.isArray(all) ? all : []).filter((m) => m.deviceIdentifier == null);
}

// --- path safety (ported from PR #580) ---
/** True if childPath equals parentPath or is nested inside it (segment-aware, so ".../ab" ⊄ ".../a"). */
export function pathIsAtOrInside(parentPath, childPath) {
  if (parentPath === childPath) return true;
  const rel = path.relative(parentPath, childPath);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Delete now-empty parent dirs up towards (but never including) the models folder. */
export async function pruneEmptyParents(absolutePath, folder) {
  let dir = path.dirname(absolutePath);
  while (pathIsAtOrInside(folder, dir) && dir !== folder) {
    let entries;
    try {
      entries = await fsp.readdir(dir);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Remove any stale `downloading_<file>.part` / `<file>.part` next to a variant file.
 * Prevents the "ghost resume" failure reported in lms issue #579, where a leftover
 * partial makes `lms get` try to resume a download that no longer exists.
 */
export async function cleanPartials(absolutePath) {
  const dir = path.dirname(absolutePath);
  const base = path.basename(absolutePath);
  for (const name of [`downloading_${base}.part`, `${base}.part`]) {
    await fsp.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
}

// --- formatting ---
/** Decimal (1000-based) size, matching how LM Studio reports model sizes. */
export function formatBytes(n) {
  if (n == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

export function absPathOf(model, folder) {
  return path.isAbsolute(model.path) ? model.path : path.join(folder, model.path);
}

export function describe(model) {
  const q = model.quantization?.name ? ` ${c.dim(model.quantization.name)}` : "";
  return `${c.cyan(model.modelKey)}${q}  ${c.dim(formatBytes(model.sizeBytes))}  ${c.dim(model.path)}`;
}

// --- tiny arg parser ---
export function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (const a of argv) {
    if (a === "--") continue;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      flags[k] = v === undefined ? true : v;
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) flags[ch] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export const wantsYes = (flags) => Boolean(flags.y || flags.yes);

// --- interactive prompts (rendered on stderr so stdout stays clean) ---
export async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(`${question} ${c.dim("[y/N]")} `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** Numbered picker. Returns the chosen item, or null if cancelled. */
export async function pick(items, render, message) {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  process.stderr.write(`\n${message}\n`);
  items.forEach((it, i) =>
    process.stderr.write(`  ${c.yellow(String(i + 1).padStart(2))}. ${render(it)}\n`),
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (await rl.question(`\n${c.dim("번호 선택 (엔터=취소): ")}`)).trim();
    const idx = Number.parseInt(ans, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return null;
    return items[idx];
  } finally {
    rl.close();
  }
}

/**
 * Resolve which downloaded model the user means.
 * - key given & unique → that model
 * - key given & many   → pick among the matching variants
 * - no key             → pick among all downloaded models
 */
export async function resolveTarget(key, models, action) {
  if (key) {
    const matches = models.filter((m) => m.modelKey === key || m.path === key);
    if (matches.length === 0) {
      throw new Error(`No downloaded model matches "${key}".\nRun \`lms ls\` to see downloaded models.`);
    }
    if (matches.length === 1) return matches[0];
    return pick(matches, describe, `"${key}" matches multiple variants — choose one to ${action}:`);
  }
  return pick(models, describe, `Select a model to ${action}:`);
}

/** Loaded local models whose files sit at/inside the target path (these block deletion). */
export function loadedBlockers(targetAbsPath, folder) {
  return listLoadedLocal().filter((m) => pathIsAtOrInside(targetAbsPath, absPathOf(m, folder)));
}

// --- update checking (Hugging Face repo lastModified vs local file mtime) ---
/** Derive the Hugging Face repo ({owner, name}) from a model's on-disk path, or null. */
export function hfRepoOf(model) {
  const segs = String(model.path || "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (segs.length < 2) return null;
  return { owner: segs[0], name: segs[1] };
}

/** Fetch a repo's `lastModified` timestamp from the public Hugging Face API. */
export async function hfLastModified(owner, name) {
  const url = `https://huggingface.co/api/models/${owner}/${name}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": "lms-helper" } });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, lastModified: json.lastModified ? new Date(json.lastModified) : null };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** Newest mtime among the files that make up a downloaded model (single file or folder path). */
export async function localMTime(absolutePath) {
  let st;
  try {
    st = await fsp.stat(absolutePath);
  } catch {
    return null;
  }
  if (st.isFile()) return st.mtime;
  if (!st.isDirectory()) return null;
  let newest = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        try {
          const s = await fsp.stat(p);
          if (s.mtimeMs > newest) newest = s.mtimeMs;
        } catch {
          // ignore unreadable entries
        }
      }
    }
  };
  await walk(absolutePath);
  return newest ? new Date(newest) : null;
}

/** Format a Date as YYYY-MM-DD, or "—" when unavailable. */
export function ymd(d) {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "—";
}
