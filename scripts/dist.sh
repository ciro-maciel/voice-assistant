#!/bin/bash
# Local installer: bumps the patch version, builds, packs a .dmg in dist/ and installs it in
# /Applications from the packed image (the same bytes anyone would get). If the app was open,
# it opens the new version in its place.
#   scripts/dist.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IFS=. read -r MAJOR MINOR PATCH < "$ROOT/VERSION"
VERSION="$MAJOR.$MINOR.$((PATCH + 1))"
echo "$VERSION" > "$ROOT/VERSION"

"$ROOT/scripts/build.sh"

DMG="$ROOT/dist/Assistant-$VERSION.dmg"
"$ROOT/scripts/release/dmg-mac.sh" "$ROOT/dist/Assistant.app" "$DMG" "Assistant by Ciro Cesar Maciel $VERSION"

# Quit whatever copy is running and wait for it: the app stops its voice loop on the way out.
WAS_RUNNING=false
if pgrep -f "Contents/MacOS/AssistantBar" >/dev/null; then WAS_RUNNING=true; fi
osascript -e 'tell application id "click.ciromaciel.voice-assistant" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 40); do pgrep -f "Contents/MacOS/AssistantBar" >/dev/null || break; sleep 0.25; done
pkill -f "Contents/MacOS/AssistantBar" >/dev/null 2>&1 || true

MOUNT="$(mktemp -d)"
hdiutil attach "$DMG" -nobrowse -mountpoint "$MOUNT" >/dev/null
rm -rf /Applications/Assistant.app
cp -R "$MOUNT/Assistant.app" /Applications/
hdiutil detach "$MOUNT" >/dev/null
echo "Installed /Applications/Assistant.app ($VERSION) from $DMG"
if [ "$WAS_RUNNING" = true ]; then
    sleep 1
    open /Applications/Assistant.app
fi
