#!/usr/bin/env bash
# Symlinks bin/lms-helper.mjs onto $PATH so `lms-helper <cmd>` works from anywhere,
# without pnpm/npm/corepack — just Node. See README "Install".
#
# Usage:
#   ./install.sh              # links into ~/bin (default)
#   ./install.sh /usr/local/bin
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$repo_dir/bin/lms-helper.mjs"
dest_dir="${1:-$HOME/bin}"
dest="$dest_dir/lms-helper"

if [ ! -f "$target" ]; then
  echo "error: $target not found — run this from the lms-helper repo root." >&2
  exit 1
fi

mkdir -p "$dest_dir"

if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
  echo "Already installed: $dest -> $target"
else
  ln -sf "$target" "$dest"
  echo "Installed: $dest -> $target"
fi

case ":$PATH:" in
  *":$dest_dir:"*)
    echo "Try it: lms-helper ls"
    ;;
  *)
    case "$(basename "${SHELL:-}")" in
      zsh) profile="$HOME/.zshrc" ;;
      bash) profile="$HOME/.bashrc" ;;
      *) profile="$HOME/.profile" ;;
    esac
    echo
    echo "$dest_dir is not on \$PATH yet. Run this to add it and reload your shell:"
    echo
    echo "  echo 'export PATH=\"$dest_dir:\$PATH\"' >> $profile && source $profile"
    echo
    echo "Then run: lms-helper ls"
    ;;
esac
