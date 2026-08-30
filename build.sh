#!/bin/bash
# Assemble a clean, public-ready Crema skin bundle in dist/.
#
# The working copy in skin/Crema/ carries developer state that must never ship:
#   • crema_settings.tdb  — the maintainer's LAN IP, beans, theme choice
#   • settings.tdb        — desktop simulator screen-size cache (wrong for tablets)
#   • ai/selftest.tcl, ai/devshot.tcl — env-guarded test rigs
#   • log.txt, .DS_Store, .gitignore
# Stripping them makes the bundle boot into pure first-run defaults:
# standalone mode + the setup wizard + dark theme.
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(cat VERSION 2>/dev/null || echo dev)"
SRC="skin/Crema"
OUT="dist/Crema"
ZIP="dist/Crema.zip"

echo "Building Crema $VERSION ..."
rm -rf "$OUT" "$ZIP"
mkdir -p dist
cp -R "$SRC" "$OUT"

# strip developer-only state
rm -f  "$OUT/crema_settings.tdb" \
       "$OUT/settings.tdb" \
       "$OUT/log.txt" \
       "$OUT/.gitignore" \
       "$OUT/ai/selftest.tcl" \
       "$OUT/ai/devshot.tcl"
find "$OUT" -name '.DS_Store' -delete

# stamp the version so About/settings can show it
echo "$VERSION" > "$OUT/VERSION"

( cd dist && zip -qr Crema.zip Crema )

echo "----------------------------------------"
echo "  bundle: $OUT/  ($(find "$OUT" -type f | wc -l | tr -d ' ') files)"
echo "  zip:    $ZIP   ($(du -h "$ZIP" | cut -f1))"
echo "  tcl:    $(find "$OUT/ai" -name '*.tcl' | wc -l | tr -d ' ') advisor modules"
echo "Done. Push $OUT to the tablet's skins/ folder (see DEPLOY.md)."
