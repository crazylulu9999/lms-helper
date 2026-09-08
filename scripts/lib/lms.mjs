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
import { emitKeypressEvents } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

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

// --- .env auto-loading (zero-dependency) ---
/** Absolute path to the project root (two levels up from scripts/lib). */
function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Load KEY=VALUE pairs from a .env file into process.env WITHOUT overriding variables
 * that are already set (real env always wins). Supports blank lines, `#` comments,
 * `export ` prefixes, and single/double-quoted values. Silently no-ops if absent.
 *
 * @param file Optional explicit path; defaults to $DOTENV_PATH or <projectRoot>/.env.
 */
export function loadDotEnv(file) {
  const envPath = file || process.env.DOTENV_PATH || path.join(projectRoot(), ".env");
  let content;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return; // no .env — nothing to do
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!key) continue;
    let value = body.slice(eq + 1).trim();
    const q = value[0];
    if (value.length >= 2 && (q === '"' || q === "'") && value.at(-1) === q) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Auto-load .env on import so every helper script picks up local config (e.g. HF_TOKEN).
loadDotEnv();

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

/**
 * Decide what `model:rm` should actually delete, and how much space that frees. For a flat
 * GGUF repo folder, a quant's own file has siblings (an mmproj projector, config.json) that
 * live NEXT TO it, not inside it — deleting just the quant orphans them, and a stale
 * orphaned mmproj can silently get re-paired with a future re-download of the same repo. So
 * the whole containing folder is swept instead of just the one file, but only when no OTHER
 * downloaded model still has a file in that same folder (a sibling quant needs it).
 *
 * @returns { absPath, dir, deletePath, sweepFolder, sharedBySibling, freedBytes }
 */
export async function planRemoval(target, models, folder) {
  const absPath = absPathOf(target, folder);
  let stat = null;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    // leave null — treated like the folder-style case below (no sweep, plain delete).
  }
  const isFile = Boolean(stat?.isFile());
  const dir = path.dirname(absPath);
  const sharedBySibling =
    isFile && models.some((m) => m !== target && path.dirname(absPathOf(m, folder)) === dir);
  const sweepFolder = isFile && !sharedBySibling;
  return {
    absPath,
    dir,
    deletePath: sweepFolder ? dir : absPath,
    sweepFolder,
    sharedBySibling,
    freedBytes: isFile && sharedBySibling ? stat.size : target.sizeBytes,
  };
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

/**
 * Arrow-key selector rendered on stderr (requires a TTY).
 * - multi=true  → array of chosen items ([] if confirmed with none), or null on cancel.
 * - multi=false → the chosen item, or null on cancel.
 * Controls: ↑/↓ (or k/j) move · space toggle (multi) · a toggle-all (multi) ·
 *           s cycle sort · r reverse sort (when `sorts` provided) · enter confirm · esc/Ctrl-C cancel.
 *
 * @param sorts Optional list of `{ label, cmp }` sort modes; `cmp` is an Array.sort comparator
 *              (omit/null for the given order). Selection is tracked by item identity, so it
 *              survives re-sorting.
 */
export function interactiveSelect({
  items,
  render,
  message,
  multi,
  sorts = [],
  input = process.stdin,
  output = process.stderr,
}) {
  return new Promise((resolve) => {
    const out = output;
    const stdin = input;
    const selected = new Set(); // holds item references (survives re-sort)
    let view = items.slice();
    let index = 0;
    let top = 0;
    let sortIndex = 0;
    let reversed = false;
    let lastLines = 0;

    const applySort = (preserveCursor = true) => {
      const current = preserveCursor ? view[index] : null;
      view = items.slice();
      const cmp = sorts[sortIndex]?.cmp;
      if (cmp) view.sort(cmp);
      if (reversed) view.reverse();
      const at = current ? view.indexOf(current) : -1;
      index = at >= 0 ? at : 0; // keep cursor on the same item across a re-sort; start at top on init
      top = 0;
    };
    if (sorts.length) applySort(false);

    const pageSize = () => Math.max(3, (out.rows || 24) - (sorts.length ? 6 : 5));

    const draw = () => {
      const page = pageSize();
      if (index < top) top = index;
      else if (index >= top + page) top = index - page + 1;
      const end = Math.min(view.length, top + page);

      const lines = [message];
      if (top > 0) lines.push(c.dim("   ↑ more"));
      for (let i = top; i < end; i++) {
        const item = view[i];
        const pointer = i === index ? c.cyan("❯") : " ";
        const box = multi ? (selected.has(item) ? c.green("◉ ") : "◯ ") : "";
        lines.push(`${pointer} ${box}${render(item)}`);
      }
      if (end < view.length) lines.push(c.dim("   ↓ more"));
      if (sorts.length) {
        lines.push(
          c.dim(`sort: `) +
            c.cyan(sorts[sortIndex].label) +
            c.dim(`${reversed ? " ▲" : " ▼"}  (s: next · r: reverse)`),
        );
      }
      lines.push(
        c.dim(
          multi
            ? "↑/↓ move · space toggle · a all · enter confirm · esc cancel"
            : "↑/↓ move · enter select · esc cancel",
        ),
      );

      let s = lastLines > 0 ? `\x1b[${lastLines}A` : "";
      s += `\x1b[0J${lines.join("\n")}\n`;
      out.write(s);
      lastLines = lines.length;
    };

    const wasRaw = Boolean(stdin.isRaw);
    const cleanup = () => {
      stdin.removeListener("keypress", onKey);
      if (stdin.setRawMode) stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write("\x1b[?25h"); // show cursor
    };

    const onKey = (str, key = {}) => {
      const isSpace = key.name === "space" || str === " ";
      if ((key.ctrl && key.name === "c") || key.name === "escape") {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === "up" || key.name === "k") index = (index - 1 + view.length) % view.length;
      else if (key.name === "down" || key.name === "j") index = (index + 1) % view.length;
      else if (sorts.length && key.name === "s") {
        sortIndex = (sortIndex + 1) % sorts.length;
        applySort();
      } else if (sorts.length && key.name === "r") {
        reversed = !reversed;
        applySort();
      } else if (multi && isSpace) {
        const it = view[index];
        selected.has(it) ? selected.delete(it) : selected.add(it);
      } else if (multi && key.name === "a") {
        if (view.every((it) => selected.has(it))) view.forEach((it) => selected.delete(it));
        else view.forEach((it) => selected.add(it));
      } else if (key.name === "return") {
        cleanup();
        if (multi) resolve(view.filter((it) => selected.has(it)));
        else resolve(view[index]);
        return;
      }
      draw();
    };

    emitKeypressEvents(stdin);
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    out.write("\x1b[?25l"); // hide cursor
    stdin.on("keypress", onKey);
    draw();
  });
}

/** Single-select picker: arrow-key UI on a TTY, numbered prompt otherwise. `opts.sorts` optional. */
export async function pick(items, render, message, opts = {}) {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  if (process.stdin.isTTY && process.stderr.isTTY) {
    return interactiveSelect({ items, render, message, multi: false, sorts: opts.sorts || [] });
  }
  return pickNumbered(items, render, message);
}

/** Numbered single-select fallback (used when stdin isn't a TTY). */
async function pickNumbered(items, render, message) {
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
  } catch {
    return null; // e.g. EOF on redirected/closed stdin
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
    return pick(matches, describe, `"${key}" matches multiple variants — choose one to ${action}:`, {
      sorts: modelSorts(),
    });
  }
  return pick(models, describe, `Select a model to ${action}:`, { sorts: modelSorts() });
}

/** Loaded local models whose files sit at/inside the target path (these block deletion). */
export function loadedBlockers(targetAbsPath, folder) {
  return listLoadedLocal().filter((m) => pathIsAtOrInside(targetAbsPath, absPathOf(m, folder)));
}

// --- update checking (Hugging Face repo lastModified vs local file mtime) ---
/** Split a repo-relative path into a Hugging Face { owner, name }, or null. */
export function hfRepoFromPath(relPath) {
  const segs = String(relPath || "")
    .split(/[\\/]/)
    .filter(Boolean);
  if (segs.length < 2) return null;
  return { owner: segs[0], name: segs[1] };
}

/** Derive the Hugging Face repo ({owner, name}) from a model's on-disk path, or null. */
export function hfRepoOf(model) {
  return hfRepoFromPath(model?.path);
}

/**
 * Read LM Studio's internal model-index cache to recover the REAL on-disk location and
 * source repo for models addressed by a Hub/catalog alias (e.g. "google/gemma-4-31b-qat"
 * → "lmstudio-community/gemma-4-31B-it-QAT-GGUF") or stored as bundled models. Best-effort:
 * returns an empty Map if the cache is missing/unparseable (its format is internal to LM
 * Studio and may change between versions).
 *
 * @returns Map keyed by a model's `path` (== the cache's `containingDirSubpath`).
 */
export function loadModelIndex() {
  const map = new Map();
  const file = path.join(lmstudioHome(), ".internal", "model-index-cache.json");
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return map;
  }
  const models = Array.isArray(json?.models) ? json.models : [];
  // Keep the most informative record when several cache entries share a key (LM Studio
  // can hold multiple entries per subpath, some lacking the real Hub→repo mapping).
  const put = (key, rec) => {
    if (!key) return;
    const prev = map.get(key);
    if (!prev || rec.score > prev.score) map.set(key, rec);
  };
  for (const e of models) {
    const id = typeof e.indexedModelIdentifier === "string" ? e.indexedModelIdentifier : "";
    const atSuffix = id.includes("@") ? id.slice(id.indexOf("@") + 1) : null;
    const fileAbsPath = e.entryPoint?.absPath || e.concreteModelDirAbsolutePath || null;
    const repoRelPath = e.entryPoint?.relPath || atSuffix || null;
    const rec = {
      fileAbsPath,
      repoRelPath,
      sourceType: e.sourceDirectoryType || null,
      score: (fileAbsPath ? 1 : 0) + (repoRelPath ? 2 : 0),
    };
    // Key by directory subpath (matches Hub-style `path`) and, when known, by the concrete
    // file relPath (matches file-style `path`, e.g. bundled models).
    put(e.containingDirSubpath, rec);
    if (e.entryPoint?.relPath) put(e.entryPoint.relPath, rec);
  }
  return map;
}

/**
 * Resolve a model's effective delete target, HF repo path, and source type — consulting the
 * model-index cache so Hub-aliased and bundled models map to their real underlying files.
 * Falls back to the model's own `path` when the cache has no entry.
 */
export function enrichModel(model, folder, index) {
  const e = index?.get(model.path);
  return {
    fileAbsPath: e?.fileAbsPath || absPathOf(model, folder),
    repoRelPath: e?.repoRelPath || model.path,
    sourceType: e?.sourceType || null,
  };
}

/**
 * Scan the directory containing `fileAbsPath` for a usable `*mmproj*.gguf` sibling (present
 * and non-empty). Pure filesystem check, no opinion on whether one is expected — see callers.
 *
 * @returns { ok, reason, mmprojPath, mmprojBytes }
 */
export function scanMmprojNear(fileAbsPath) {
  const dir = path.dirname(fileAbsPath);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: "model directory not found", mmprojPath: null, mmprojBytes: null };
  }
  const candidates = entries.filter((e) => e.isFile() && /mmproj/i.test(e.name)).map((e) => e.name);
  if (candidates.length === 0) {
    return { ok: false, reason: "no mmproj file found", mmprojPath: null, mmprojBytes: null };
  }
  // If several mmproj variants exist (rare), the largest is presumably the one in use.
  let best = null;
  for (const name of candidates) {
    let size;
    try {
      size = fs.statSync(path.join(dir, name)).size;
    } catch {
      continue;
    }
    if (!best || size > best.size) best = { path: path.join(dir, name), size };
  }
  if (!best || best.size === 0) {
    return {
      ok: false,
      reason: "mmproj is 0 bytes",
      mmprojPath: best?.path || path.join(dir, candidates[0]),
      mmprojBytes: best?.size ?? 0,
    };
  }
  return { ok: true, reason: null, mmprojPath: best.path, mmprojBytes: best.size };
}

/**
 * For a GGUF vision model, check that a sibling `*mmproj*.gguf` projector file exists and is
 * non-empty. Gated on LM Studio's live `vision` flag — which turns out to be DERIVED from
 * mmproj's current presence, not from the base GGUF's own architecture (confirmed by dumping
 * a real vision GGUF's header: no vision/clip keys anywhere in it). So this catches a 0-byte
 * or corrupted mmproj (vision stays true, a file is just unusable), but NOT one deleted
 * entirely — `vision` flips false right along with the file, so this returns null and the
 * model silently drops out of the check. `sizeBytes` can't catch either case: it sums
 * whatever LM Studio currently finds in the folder, so 0-byte and missing report the same
 * total as the text weights alone. Only meaningful for `format === "gguf"` — MLX/safetensors
 * vision models bundle the vision tower differently and aren't covered.
 *
 * For the "deleted entirely" blind spot, see model:outdated's HF-repo-backed check, which
 * knows a model *should* have an mmproj from the upstream repo's file listing instead of
 * from any local, circular signal.
 *
 * @returns null when not applicable (not vision, or not gguf), otherwise
 *   { ok, reason, mmprojPath, mmprojBytes }
 */
export function checkVisionMmproj(model, folder, index) {
  if (!model.vision || model.format !== "gguf") return null;
  const { fileAbsPath } = enrichModel(model, folder, index);
  return scanMmprojNear(fileAbsPath);
}

/** True if a Hugging Face repo's sibling filenames include an mmproj (GGUF vision projector). */
export function repoHasMmproj(siblings) {
  return Array.isArray(siblings) && siblings.some((f) => /mmproj/i.test(f));
}

/** A Hugging Face access token from the environment, if set (used for gated repos). */
export function hfToken() {
  return process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || "";
}

/**
 * Fetch a repo's `lastModified` timestamp and file listing from the Hugging Face API (auth if
 * $HF_TOKEN set). `siblings` is the repo's filenames — used to check whether the upstream repo
 * ships an mmproj at all (see `repoHasMmproj`), independent of what the local copy has.
 */
export async function hfLastModified(owner, name) {
  const url = `https://huggingface.co/api/models/${owner}/${name}`;
  const headers = { "user-agent": "lms-helper" };
  const token = hfToken();
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return {
      ok: true,
      lastModified: json.lastModified ? new Date(json.lastModified) : null,
      siblings: Array.isArray(json.siblings) ? json.siblings.map((s) => s.rfilename) : [],
    };
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

/** Multi-select picker: arrow-key checkbox UI on a TTY, numbered prompt otherwise. `opts.sorts` optional. */
export async function pickMany(items, render, message, opts = {}) {
  if (items.length === 0) return [];
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const res = await interactiveSelect({
      items,
      render,
      message,
      multi: true,
      sorts: opts.sorts || [],
    });
    return res === null ? [] : res; // cancel and "confirmed none" both mean nothing to do
  }
  return pickManyNumbered(items, render, message);
}

/** Sort modes for a list of model objects (by id / disk size). Pass to pick()/pickMany(). */
export function modelSorts() {
  return [
    { label: "name", cmp: (a, b) => a.modelKey.localeCompare(b.modelKey) },
    { label: "size", cmp: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0) },
  ];
}

/** Numbered multi-select fallback (used when stdin isn't a TTY). */
async function pickManyNumbered(items, render, message) {
  process.stderr.write(`\n${message}\n`);
  items.forEach((it, i) =>
    process.stderr.write(`  ${c.yellow(String(i + 1).padStart(2))}. ${render(it)}\n`),
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const ans = (
      await rl.question(`\n${c.dim("번호 선택 (공백/쉼표 구분, 'a'=전체, 엔터=취소): ")}`)
    ).trim();
    if (!ans) return [];
    if (/^(a|all|\*)$/i.test(ans)) return items.slice();
    const seen = new Set();
    return ans
      .split(/[\s,]+/)
      .map((x) => Number.parseInt(x, 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < items.length && !seen.has(i) && seen.add(i))
      .map((i) => items[i]);
  } catch {
    return []; // e.g. EOF on redirected/closed stdin
  } finally {
    rl.close();
  }
}

// --- direct-from-HF downloads (used when $HF_TOKEN is set — see redownloadModel) ---
// Bypasses `lms get`/LM Studio's own downloader: fetches the file straight from HF's
// `resolve/main` endpoint (auth'd with the token, so gated repos work too) and streams it
// to the final path ourselves. Verified empirically (see plan notes) that LM Studio picks
// up a file rewritten at an already-indexed path immediately — no follow-up `lms get` needed.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a Hugging Face `resolve/main` URL for a file inside a repo (each segment percent-encoded). */
export function hfResolveUrl(owner, name, fileRelPath) {
  const encoded = fileRelPath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `https://huggingface.co/${owner}/${name}/resolve/main/${encoded}`;
}

function drawProgress(label, loaded, total) {
  if (!process.stderr.isTTY) return;
  const pct = total ? ` (${((loaded / total) * 100).toFixed(1)}%)` : "";
  const size = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded);
  process.stderr.write(`\r\x1b[2K  ${c.dim(`${label ? `${label}: ` : ""}${size}${pct}`)}`);
}

function clearProgress() {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
}

/**
 * Download one file straight from Hugging Face, streaming to `destAbsPath` via a
 * `downloading_<name>.part` temp file in the same directory — the same naming
 * `cleanPartials()` already recognizes, so an interrupted attempt is swept automatically
 * on the next run. The original file at `destAbsPath` (if any) is left untouched until the
 * new one is fully verified, then replaced with a single atomic rename.
 *
 * Retries retryable failures (network errors, timeouts, 5xx, an incomplete stream) up to
 * `attempts` times with a short backoff; 401/403 (no access) and 404 (not found) fail
 * immediately. Never throws — returns `{ ok: false, reason, retryable }` so the caller can
 * fall back to `lms get` cleanly.
 */
export async function downloadFileDirect({ url, destAbsPath, token, label, attempts = 3 }) {
  const dir = path.dirname(destAbsPath);
  const tmpPath = path.join(dir, `downloading_${path.basename(destAbsPath)}.part`);
  await fsp.mkdir(dir, { recursive: true });
  const headers = { "user-agent": "lms-helper" };
  if (token) headers.authorization = `Bearer ${token}`;

  let lastReason = "unknown error";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await fsp.rm(tmpPath, { force: true });
    const retry = async (reason) => {
      lastReason = reason;
      if (attempt >= attempts) return false;
      process.stderr.write(
        c.dim(`  ${label ? `${label}: ` : ""}attempt ${attempt}/${attempts} failed (${reason}) — retrying…\n`),
      );
      await sleep(attempt * 1000);
      return true;
    };
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: `access denied (HTTP ${res.status}) — check $HF_TOKEN has access`, retryable: false };
        }
        if (res.status === 404) {
          return { ok: false, reason: "HTTP 404 (file not found)", retryable: false };
        }
        if (await retry(`HTTP ${res.status}`)) continue;
        break;
      }

      const total = Number(res.headers.get("content-length")) || null;
      let loaded = 0;
      let lastDraw = 0;
      const tracker = new Transform({
        transform(chunk, _enc, cb) {
          loaded += chunk.length;
          const now = Date.now();
          if (now - lastDraw > 200) {
            lastDraw = now;
            drawProgress(label, loaded, total);
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), tracker, fs.createWriteStream(tmpPath));
      clearProgress();

      const finalSize = total != null ? (await fsp.stat(tmpPath)).size : null;
      if (total != null && finalSize !== total) {
        if (await retry(`incomplete download (${finalSize}/${total} bytes)`)) continue;
        break;
      }

      await fsp.rename(tmpPath, destAbsPath);
      return { ok: true, bytes: (await fsp.stat(destAbsPath)).size };
    } catch (e) {
      if (await retry(e.message || String(e))) continue;
      break;
    }
  }
  await fsp.rm(tmpPath, { force: true }).catch(() => {});
  return { ok: false, reason: lastReason, retryable: true };
}

/**
 * Direct-download a model's primary file, plus (for a GGUF vision model) its upstream
 * mmproj sibling from the same repo directory — refreshing it too, so redownload can heal a
 * stale or missing mmproj, not just the main weights. mmproj lookup/refresh is best-effort:
 * a failed sibling listing or mmproj fetch doesn't fail the overall redownload, since the
 * primary file is already safely in place by that point.
 *
 * Starts with a cheap repo-existence check (also reused for the mmproj lookup below, so it
 * doesn't cost an extra request on top of what mmproj lookup already needed). A path can
 * *look* like an HF repo (owner/name/file) without actually being one — a self-quantized or
 * fine-tuned model dropped into the models folder under a path that mimics that shape. A 404
 * here means the repo doesn't exist at all, so there's no point starting a (guaranteed-404)
 * file download, or falling back to `lms get` afterward — that would just hit the same
 * nonexistent URL again. Any other failure (gated 401/403, network hiccup) doesn't short-
 * circuit — those repos likely DO exist, so the normal download attempt still proceeds.
 */
async function directRedownload({ fileAbsPath, fileRelPath, repo, token, model, quant }) {
  const label = quant ? `${model.modelKey} ${quant.toUpperCase()}` : model.modelKey;

  const info = await hfLastModified(repo.owner, repo.name);
  if (!info.ok && info.status === 404) {
    return {
      ok: false,
      notOnHf: true,
      reason:
        `no such repo on Hugging Face (${repo.owner}/${repo.name}) — looks like a ` +
        "self-quantized/fine-tuned or manually imported model, not one downloaded from HF",
      retryable: false,
    };
  }

  const primary = await downloadFileDirect({
    url: hfResolveUrl(repo.owner, repo.name, fileRelPath),
    destAbsPath: fileAbsPath,
    token,
    label,
  });
  if (!primary.ok) return primary;

  let mmproj;
  if (model.format === "gguf" && info.ok) {
    const repoDir = path.dirname(fileRelPath);
    const sibling = info.siblings.find((f) => /mmproj/i.test(f) && path.dirname(f) === repoDir);
    if (sibling) {
      const existing = scanMmprojNear(fileAbsPath);
      const destAbsPath = path.join(path.dirname(fileAbsPath), path.basename(sibling));
      const res = await downloadFileDirect({
        url: hfResolveUrl(repo.owner, repo.name, sibling),
        destAbsPath,
        token,
        label: `${label} mmproj`,
      });
      if (res.ok) {
        mmproj = path.basename(sibling);
        if (existing.mmprojPath && existing.mmprojPath !== destAbsPath) {
          await fsp.rm(existing.mmprojPath, { force: true });
        }
      }
    }
  }
  return { ok: true, mmproj };
}

/**
 * Force-update one model: (optionally unload), then re-fetch it from Hugging Face. Does NOT
 * prompt — the caller is responsible for confirmation. Returns
 * { ok, method?, code?, reason?, repoUrl?, quant?, mmproj? }.
 *
 * @param model  A model object from listDownloadedLocal().
 * @param folder The resolved models folder.
 * @param opts   yes: run fully non-interactively — never open lms's `--select` picker (a failed
 *               exact-quant fetch just reports failure instead of falling back to it);
 *               unload: unload the model first if it is loaded;
 *               keepPartials: skip cleaning leftover download partials (`lms get` fallback only);
 *               viaLms: force the `lms get` path even when $HF_TOKEN is set.
 *
 * When $HF_TOKEN is set (and `viaLms` isn't), fetches straight from Hugging Face instead of
 * shelling out to `lms get` — see the direct-download helpers above. That path downloads to a
 * temp file and only replaces the original once complete, so it never needs to delete first.
 * A failed direct attempt falls back to the `lms get` flow below unchanged, which DOES delete
 * first: `lms get` matches by variant name and skips an already-present quant, so the known
 * quant (`model.quantization.name`) is only re-fetched exactly (`get <url>@<quant>`) after the
 * old copy is gone — no variant menu in the normal path; `--select` is only a fallback
 * (interactive runs).
 */
export async function redownloadModel(model, folder, opts = {}) {
  const { yes = false, unload = false, keepPartials = false, index, viaLms = false } = opts;
  const { fileAbsPath, repoRelPath, sourceType } = enrichModel(model, folder, index || loadModelIndex());

  if (!pathIsAtOrInside(folder, fileAbsPath)) {
    return {
      ok: false,
      reason: sourceType === "bundled" ? "bundled model — not re-downloadable" : "path outside models folder",
    };
  }
  const repo = hfRepoFromPath(repoRelPath);
  if (!repo) {
    return { ok: false, reason: "cannot derive Hugging Face repo from path" };
  }
  const repoUrl = `https://huggingface.co/${repo.owner}/${repo.name}`;
  const quant = model.quantization?.name?.toLowerCase();

  const blockers = loadedBlockers(fileAbsPath, folder);
  if (blockers.length > 0) {
    if (!unload) {
      return {
        ok: false,
        reason: `loaded (${blockers.map((b) => b.identifier).join(", ")}) — unload first`,
      };
    }
    for (const b of blockers) lmsInteractive(["unload", b.identifier]);
  }

  const token = hfToken();
  if (!viaLms && token) {
    const segs = String(repoRelPath || "")
      .split(/[\\/]/)
      .filter(Boolean);
    const fileRelPath = segs.length > 2 ? segs.slice(2).join("/") : null;
    if (fileRelPath) {
      const direct = await directRedownload({ fileAbsPath, fileRelPath, repo, token, model, quant });
      if (direct.ok) return { ok: true, method: "hf-direct", repoUrl, quant, mmproj: direct.mmproj };
      if (direct.notOnHf) return { ok: false, reason: direct.reason };
      process.stderr.write(c.dim(`  Direct download failed (${direct.reason}) — falling back to \`lms get\`.\n`));
    }
  }

  await fsp.rm(fileAbsPath, { recursive: true, force: true });
  if (!keepPartials) await cleanPartials(fileAbsPath);

  let code;
  if (quant) {
    // Re-fetch the exact quant the model already had — no variant menu, no re-picking.
    code = lmsInteractive(["get", `${repoUrl}@${quant}`, "-y"]);
    // Only if that exact variant is missing do we (interactively) let lms present its picker.
    if (code !== 0 && !yes) code = lmsInteractive(["get", repoUrl, "--select"]);
  } else if (!yes) {
    // Quant unknown and prompting allowed → lms's variant picker.
    code = lmsInteractive(["get", repoUrl, "--select"]);
  } else {
    return { ok: false, reason: "quant unknown; can't pick non-interactively with -y" };
  }
  return { ok: code === 0, method: "lms-get", code, repoUrl, quant };
}
