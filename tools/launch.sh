#!/usr/bin/env bash
# SIFIR NOKTA - desktop launcher for Linux / macOS.
# Opens the offline build in a chrome-less "app" window when Chrome/Chromium/Edge
# is available, otherwise falls back to the default browser.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GAME="$HERE/../dist/SifirNokta.html"

if [[ ! -f "$GAME" ]]; then
  echo "[HATA] dist/SifirNokta.html yok. Önce: npm run build"
  exit 1
fi

URL="file://$(cd "$(dirname "$GAME")" && pwd)/$(basename "$GAME")"

for BIN in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
  if command -v "$BIN" >/dev/null 2>&1 || [[ -x "$BIN" ]]; then
    exec "$BIN" --app="$URL" --window-size=1600,900 --user-data-dir="${TMPDIR:-/tmp}/sifirnokta-profile" --no-first-run
  fi
done

case "$(uname -s)" in
  Darwin) open "$GAME" ;;
  *) xdg-open "$GAME" ;;
esac
