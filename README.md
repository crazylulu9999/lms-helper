# lms-helper

Small, zero-dependency CLI helpers for managing **LM Studio** models — as the `lms-helper`
command (see Install) or as pnpm scripts (see Commands).

The `lms` CLI has no delete command (feature request
[lms#579](https://github.com/lmstudio-ai/lms/issues/579), implementation PR
[lms#580](https://github.com/lmstudio-ai/lms/pull/580) — still open), and `lms get`
**skips a model that is already downloaded** even when the upstream repo has newer
files — tracked upstream (not in `lms` itself, but in the shared app/backend tracker) as
[lmstudio-bug-tracker#2121](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/2121)
("downloaded model is out of date / has been replaced upstream") and
[#835](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/835)
("no option to download the newer version"), both still open. These scripts fill both
gaps until `lms remove`/an update path ships upstream.

They talk only to the `lms` CLI (`lms ls/ps --json`, `lms get`, `lms unload`) plus the
filesystem — no extra dependencies.

## Install

```bash
./install.sh                  # symlinks bin/lms-helper.mjs onto ~/bin as `lms-helper`
./install.sh /usr/local/bin   # or any other directory already on $PATH
```

Then:

```bash
lms-helper ls
lms-helper outdated --all -y
lms-helper rm gemma-4-26b-a4b-it@q4_k_m
lms-helper redownload gemma-4-26b-a4b-it@q4_k_m -y --unload
```

No pnpm, npm, or corepack involved — just Node 18+. The symlink resolves to this repo's
real path, so `lms-helper` works from any directory once it's on `$PATH`.

Skipping the install works too — call the scripts directly:

```bash
node scripts/list-models.mjs
node scripts/outdated-models.mjs --all -y
```

(This is also the fallback if pnpm/corepack isn't cooperating — e.g. an older corepack
that doesn't read `devEngines` yet.)

## Commands

Each `lms-helper <name>` above is a thin wrapper around one of these — use them directly
if you're already working inside this repo with pnpm:

```bash
pnpm model:ls                       # list models downloaded on THIS machine (size + path)
pnpm model:outdated                 # list models whose upstream HF repo has newer files
pnpm model:rm [modelKey]            # delete a downloaded model from disk
pnpm model:redownload [modelKey]    # delete + re-download (force-update to the latest upstream files)
```

### `model:ls`

Besides size + on-disk path, `model:ls` checks every GGUF vision model (`vision: true`
in `lms ls --json`) for a usable `mmproj` projector file next to it:

```text
  gemma-4-e4b-it Q4_K_XL  7.04 GB  unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf
  gemma-4-26b-a4b-it Q4_K_M  16.87 GB  unsloth/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_M.gguf
    ⚠ vision model, mmproj is 0 bytes — won't load ("Failed to load CLIP model")
```

LM Studio pairs a vision model with its `mmproj` file by filename, not content, so a
transfer that leaves a 0-byte or missing mmproj still shows up as a normal vision model —
the failure ("Failed to load CLIP model from ...") only surfaces when you actually load
it. This check reads the real file on disk (not LM Studio's cached model size, which sums
whatever it indexed and won't reflect a file that changed since), so it catches the
problem at listing time and exits non-zero if any vision model is affected — usable as a
deploy-verification gate (`pnpm model:ls || alert`). GGUF only; MLX/safetensors vision
models bundle the vision tower differently and aren't covered.

If this fires, don't just drop a fixed file in place — LM Studio doesn't re-scan a model
directory once it's indexed. Use `model:rm` then re-fetch/re-transfer so LM Studio
indexes the corrected files from scratch.

⚠ **Known blind spot**: this only catches a 0-byte/corrupt mmproj. `vision: true` turns out
to be *derived* from mmproj's current presence, not read from the base GGUF's own
architecture — deleting the mmproj file entirely flips `vision` back to `false`, so the
model silently drops out of this check too. `model:outdated` doesn't have this problem — it
cross-checks against the upstream repo's actual file listing instead, see below.

### `model:outdated`

Compares each downloaded model's Hugging Face repo `lastModified` against the local
file's mtime; a newer HF timestamp means the upstream repo changed after you downloaded
(re-quantized weights, chat template, or tokenizer) — updates `lms get` won't pull on its
own. Pair it with `model:redownload` to actually update.

```bash
pnpm model:outdated              # all models, grouped by status (⬆ update / ✓ up-to-date / ? unknown)
pnpm model:outdated -u           # only models with an update available
pnpm model:outdated -i           # interactive: pick outdated models and re-download them
pnpm model:outdated --all        # re-download every outdated model, no picker
pnpm model:outdated --all -y     # same, fully unattended (skips the confirmation too)
pnpm model:outdated --json       # machine-readable
```

**Interactive update (`-i`)** lists the models with an update as an arrow-key checkbox
list — **↑/↓** to move, **space** to toggle, **a** to toggle all, **s** to cycle sort
(update date / name / size / local age), **r** to reverse, **enter** to confirm, **esc**
to cancel — then deletes and re-downloads each selected model, unloading any that are
loaded and fetching the same quant non-interactively. Add `-y` to skip the final
confirmation. (Sorting survives selection; when stdin isn't a TTY it falls back to numbered
input.) The `rm` / `redownload` model pickers offer the same UI, sortable by name / size.

**Batch update (`--all`)** skips the picker and re-downloads every model with an update —
same delete-then-fetch behavior as selecting all in `-i`. Combine with `-y` for a fully
unattended run (e.g. cron).

```text
  ⬆ update      gemma-4-26b-a4b-it@q4_k_m Q4_K_M   local 2026-04-10 → HF 2026-07-17
  ✓ up-to-date  gemma-4-26b-a4b-it@q4_k_xl Q4_K_XL   local 2026-07-21 → HF 2026-07-17
  ? unknown     llama-guard-3-8b-mlx 4bit   local 2026-04-10 → HF —  (imported locally (not on HF))

  16 update(s) available · 11 up-to-date · 1 unknown
```

The check is repo-level (any file change bumps `lastModified`). **Hub-aliased** models
(e.g. `google/gemma-4-31b-qat` → `lmstudio-community/gemma-4-31B-it-QAT-GGUF`) and **bundled**
models are resolved to their real underlying repo via LM Studio's model-index cache. What
still shows `unknown`: models you imported/created locally (no HF repo — e.g. a self-converted
MLX), and — without a token — gated repos.

**Vision check (ground-truth version of `model:ls`'s)**: for each GGUF model, the repo's
file listing (already fetched for the freshness check, no extra request) is checked for an
`mmproj` file. If the upstream repo ships one but the local copy is missing or 0 bytes,
that's flagged the same way `model:ls` does:

```text
  ✓ up-to-date  gemma-4-e4b-it Q4_K_XL   local 2026-07-21 → HF 2026-07-17
    ⚠ vision model, no mmproj file found — won't load ("Failed to load CLIP model")

1 vision model(s) missing a usable mmproj file (upstream repo ships one — see ⚠ above).
```

Unlike `model:ls`, this doesn't depend on LM Studio's local `vision` flag, so it also
catches an mmproj deleted entirely (not just corrupted) — at the cost of needing network
access. Also exits non-zero, so `-u` surfaces affected models even when otherwise
up-to-date, and it's usable as the same kind of deploy-verification gate
(`pnpm model:outdated -u || alert`). GGUF only.

Set a Hugging Face read token to check gated repos — either export it, or drop it in a
`.env` (auto-loaded, gitignored):

```bash
# option A — shell
export HF_TOKEN=hf_xxx        # a read token from https://huggingface.co/settings/tokens

# option B — .env (auto-loaded on every run)
cp .env.example .env          # then set HF_TOKEN=hf_xxx inside

pnpm model:outdated
```

Omit `modelKey` to pick interactively. Get a model's key from `pnpm model:ls` or `lms ls`.

### Examples

```bash
pnpm model:rm gemma-4-26b-a4b-it@q4_k_m           # confirm, then delete
pnpm model:rm gemma-4-26b-a4b-it@q4_k_m --dry-run # show what would be deleted
pnpm model:rm gemma-4-26b-a4b-it@q4_k_m -y --unload

pnpm model:redownload gemma-4-26b-a4b-it@q4_k_m   # delete, then interactive re-get (pick same quant)
pnpm model:redownload gemma-4-26b-a4b-it@q4_k_m -y --unload   # unattended, same quant
```

> If a flag isn't forwarded, put it after `--`: `pnpm model:rm -- gemma-4-... -y`.

## Options

| Flag | `rm` | `redownload` | Meaning |
| --- | :-: | :-: | --- |
| `-y`, `--yes` | ✓ | ✓ | Skip confirmation. For `redownload`, also try a non-interactive same-quant fetch. |
| `--unload` | ✓ | ✓ | Unload the model first if it is currently loaded. |
| `--dry-run` | ✓ | | Show what would be deleted, without deleting. |
| `--keep-partials` | | ✓ | Don't clean leftover download partials before re-fetching. |
| `-h`, `--help` | ✓ | ✓ | Show help. |

## Safety model (ported from lms PR #580)

- **Local only** — operates on models stored on this machine (`deviceIdentifier === null`);
  remote LM Link peers are never touched.
- **Containment check** — refuses to delete anything outside the resolved models folder
  (read from `~/.lmstudio/settings.json` → `downloadsFolder`, default `~/.lmstudio/models`).
- **Loaded-model guard** — refuses to delete a model that is currently loaded (use `--unload`).
- **Confirmation** before any deletion (skip with `-y`).
- **Prunes** now-empty publisher/repo folders after a delete.
- **Cleans stale `downloading_*.part` files**, avoiding the "ghost resume" failure from lms#579.

## Why `redownload` deletes first

`lms get` matches by variant name and checks only whether that quant exists on disk — it
never compares the upstream Hugging Face revision. So re-running `lms get` on an updated
repo prints `Model already downloaded` and does nothing. `redownload` deletes the local
variant, then re-fetches the **same** quant with
`lms get "https://huggingface.co/<publisher>/<repo>@<quant>" -y` (full HF URL — the short
`owner/repo` form stalls on LM Studio's catalog search) so a fresh copy is pulled with no
variant menu to re-pick. If that exact variant can't be found it falls back to LM Studio's
interactive `--select` picker (skipped under `-y`). It keeps sibling files (config / mmproj
/ other quants) intact. To switch to a *different* quant, use `lms get <repo>` directly —
`redownload` is for in-place same-variant updates.

## Environment

- `LMS_BIN` — path to the `lms` binary (default: `~/.lmstudio/bin/lms`, else `lms` on `PATH`).
- `LMSTUDIO_HOME` — LM Studio home dir (default: `~/.lmstudio`).
- `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) — Hugging Face read token, used by
  `model:outdated` to check gated repos. Never committed (`.env` is gitignored).
- `NO_COLOR` — disable colored output.

A `.env` file in the project root is auto-loaded on every run (see `.env.example`).
Values already set in your shell take precedence; override the path with `$DOTENV_PATH`.

Requires Node 18+ (uses `node:readline/promises`).
