# lms-helper

Small, zero-dependency pnpm helpers for managing **LM Studio** models from the CLI.

The `lms` CLI has no delete command (feature request
[lms#579](https://github.com/lmstudio-ai/lms/issues/579), implementation PR
[lms#580](https://github.com/lmstudio-ai/lms/pull/580) — still open), and `lms get`
**skips a model that is already downloaded** even when the upstream repo has newer
files. These scripts fill both gaps until `lms remove` ships upstream.

They talk only to the `lms` CLI (`lms ls/ps --json`, `lms get`, `lms unload`) plus the
filesystem — no extra dependencies, nothing to install.

## Commands

```bash
pnpm model:ls                       # list models downloaded on THIS machine (size + path)
pnpm model:outdated                 # list models whose upstream HF repo has newer files
pnpm model:rm [modelKey]            # delete a downloaded model from disk
pnpm model:redownload [modelKey]    # delete + re-download (force-update to the latest upstream files)
```

### `model:outdated`

Compares each downloaded model's Hugging Face repo `lastModified` against the local
file's mtime; a newer HF timestamp means the upstream repo changed after you downloaded
(re-quantized weights, chat template, or tokenizer) — updates `lms get` won't pull on its
own. Pair it with `model:redownload` to actually update.

```bash
pnpm model:outdated              # all models, grouped by status (⬆ update / ✓ up-to-date / ? unknown)
pnpm model:outdated -u           # only models with an update available
pnpm model:outdated -i           # interactive: pick outdated models and re-download them
pnpm model:outdated --json       # machine-readable
```

**Interactive update (`-i`)** lists the models with an update, lets you multi-select
(`1 3 5`, `a` for all, Enter to cancel), then deletes and re-downloads each — unloading
any that are loaded and fetching the same quant non-interactively. Add `-y` to skip the
final confirmation.

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
MLX), and — without a token — gated repos. Set a Hugging Face read token to check gated repos —
either export it, or drop it in a `.env` (auto-loaded, gitignored):

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
variant, then runs `lms get "https://huggingface.co/<publisher>/<repo>" --select` (full HF
URL — the short `owner/repo` form stalls on LM Studio's catalog search) so a fresh copy is
pulled. It keeps sibling files (config / mmproj / other quants) intact.

## Environment

- `LMS_BIN` — path to the `lms` binary (default: `~/.lmstudio/bin/lms`, else `lms` on `PATH`).
- `LMSTUDIO_HOME` — LM Studio home dir (default: `~/.lmstudio`).
- `HF_TOKEN` (or `HUGGING_FACE_HUB_TOKEN`) — Hugging Face read token, used by
  `model:outdated` to check gated repos. Never committed (`.env` is gitignored).
- `NO_COLOR` — disable colored output.

A `.env` file in the project root is auto-loaded on every run (see `.env.example`).
Values already set in your shell take precedence; override the path with `$DOTENV_PATH`.

Requires Node 18+ (uses `node:readline/promises`).
