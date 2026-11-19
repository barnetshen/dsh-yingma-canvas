#!/usr/bin/env bash
set -euo pipefail

force=0
if [[ "$#" -gt 0 && "$1" == "--force" ]]; then
  force=1
elif [[ "$#" -gt 0 ]]; then
  echo "Usage: install-yingma-cli.sh [--force]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "$0")" && pwd)"
install_root="$HOME/.yingma"
install_bin="$install_root/bin"
target="$install_bin/yingma"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or later is required. Install Node.js, then run this installer again." >&2
  exit 1
fi

if [[ -e "$target" && "$force" != "1" ]]; then
  echo "Refusing to overwrite $target. Re-run with --force to replace it." >&2
  exit 1
fi

mkdir -p "$install_bin"
chmod 700 "$install_root" "$install_bin"
install -m 700 "$script_dir/yingma.js" "$target"

echo "Installed yingma to $target"
case ":$PATH:" in
  *":$install_bin:"*) ;;
  *) echo "Add this directory to PATH, then open a new shell: $install_bin" ;;
esac
