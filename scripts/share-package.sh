#!/usr/bin/env bash
# Builds the shareable installer package for classmates:
#   share/MCI-Studien-Manager-<version>.zip
#     MCI-Studien-Manager-<version>.dmg, Installationsanleitung.pdf, Pruefsumme-SHA256.txt, KI-Dateien/
#   share/KI-Dateien-<version>.zip (vault AI files for manual installation)
# Usage: scripts/share-package.sh [--skip-build]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
name="MCI-Studien-Manager-${version}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ "${1:-}" != "--skip-build" ]]; then
  CI=true APPLE_SIGNING_IDENTITY="-" npm run tauri build -- --bundles app,dmg
fi

dmg="src-tauri/target/release/bundle/dmg/study-manager_${version}_aarch64.dmg"
[[ -f "$dmg" ]] || { echo "Missing $dmg. Run without --skip-build." >&2; exit 1; }
[[ -x "$chrome" ]] || { echo "Google Chrome is required to render the PDF guide." >&2; exit 1; }

out="share/${name}"
rm -rf "$out" "share/${name}.zip"
mkdir -p "$out"

cp "$dmg" "$out/${name}.dmg"
sha="$(shasum -a 256 "$out/${name}.dmg" | cut -d' ' -f1)"
printf '%s  %s\n' "$sha" "${name}.dmg" > "$out/Pruefsumme-SHA256.txt"

html="$(mktemp -d)/installation.html"
sed -e "s/{{VERSION}}/${version}/g" \
    -e "s/{{SHA256}}/${sha}/g" \
    -e "s/{{DATE}}/$(date +%d.%m.%Y)/g" \
    docs/installation.html > "$html"
"$chrome" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$root/$out/Installationsanleitung.pdf" "file://$html" 2>/dev/null
rm -rf "$(dirname "$html")"

ai="KI-Dateien-${version}"
node scripts/export-ai-files.mjs "$root/$out/KI-Dateien"
rm -f "share/${ai}.zip"
(cd "$out" && ditto -c -k --norsrc --noextattr --keepParent "KI-Dateien" "$root/share/${ai}.zip")

(cd share && ditto -c -k --norsrc --noextattr --keepParent "$name" "${name}.zip")
echo "Package: share/${name}.zip"
echo "AI files: share/${ai}.zip"
echo "SHA-256 (DMG): $sha"
