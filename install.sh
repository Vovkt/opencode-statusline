#!/bin/sh
set -eu

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins/statusline"
RAW_URL="https://raw.githubusercontent.com/Vovkt/opencode-statusline/main/plugins/statusline/tui.tsx"

mkdir -p "$PLUGIN_DIR"
curl -fsSL "$RAW_URL" -o "$PLUGIN_DIR/tui.tsx"

printf "Установлено в %s/tui.tsx\n" "$PLUGIN_DIR"
