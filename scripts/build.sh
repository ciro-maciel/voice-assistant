#!/bin/bash
# Builds dist/Assistant.app with swiftc (no Xcode needed: Command Line Tools are enough).
#   scripts/build.sh
#
# The app is self-contained for the assistant itself: it embeds the Bun runtime and the engine
# source (engine/src), and starts them on launch. The external tools (sox, whisper-server,
# ffmpeg/ffplay and Claude Code) are read from their usual install paths.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
APP="$ROOT/dist/Assistant.app"
RESOURCES="$APP/Contents/Resources"

# With only the Command Line Tools, the macOS 27 SDK turns SwiftUI's @State into a macro whose
# plugin ships with Xcode alone; the 26.x SDK builds the same app for macOS 14 and later.
SDK_ARGS=()
if xcode-select -p | grep -q CommandLineTools; then
    SDK="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26.*.sdk 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$SDK" ]; then SDK_ARGS=(-sdk "$SDK"); fi
fi

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "bun is required to build (https://bun.sh)"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RESOURCES"
swiftc -O ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} -target arm64-apple-macosx14.0 -swift-version 5 -module-name AssistantBar \
    "$ROOT"/Sources/AssistantBar/*.swift -o "$APP/Contents/MacOS/AssistantBar"
# The symbols out of the shipped binary: half its size. Crash reports still locate each frame.
strip -rSTx "$APP"/Contents/MacOS/*
# Every build carries VERSION; the window's footer reads it back.
sed "s/__VERSION__/$VERSION/g" "$ROOT/Resources/Info.plist" > "$APP/Contents/Info.plist"
# en.lproj and pt-BR.lproj: the interface in English and Brazilian Portuguese (the Mac's language picks).
cp -R "$ROOT/Resources/AppIcon.icns" "$ROOT/Resources/Fonts" "$ROOT/Resources/Icons" \
    "$ROOT/Resources/en.lproj" "$ROOT/Resources/pt-BR.lproj" "$RESOURCES/"

# The Bun runtime, copied out of its symlink, so the bundle does not depend on ~/.bun.
cp "$(readlink -f "$BUN")" "$RESOURCES/bun"

# The engine source. The app runs `bun src/main.ts` in this folder, and the single-instance
# check looks for "src/main.ts" in the process command line, so keep that layout.
mkdir -p "$RESOURCES/engine"
cp -R "$ROOT/engine/src" "$ROOT/engine/package.json" "$RESOURCES/engine/"
rm -f "$RESOURCES"/engine/src/*.test.ts

# Three ways to sign, best first (macOS ties the Microphone grant to the signature, so it must
# be the same on every build):
#   1. Developer ID Application (the official build), with hardened runtime and a timestamp,
#      which notarization requires.
#   2. "Assistant Local Signing" (scripts/signing-identity.sh): a fixed certificate for a clone.
#   3. Ad hoc, when neither exists: macOS asks for the microphone again after every build.
# `|| true`: without a certificate (a fresh clone) security exits 44, and pipefail would stop
# the build instead of falling back.
DEVELOPER_ID="$(security find-identity -v -p codesigning 2>/dev/null | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1 || true)"
LOCAL_IDENTITY="Assistant Local Signing"
if [ -n "$DEVELOPER_ID" ]; then
    SIGN="$DEVELOPER_ID"
elif security find-certificate -c "$LOCAL_IDENTITY" >/dev/null 2>&1; then
    SIGN="$LOCAL_IDENTITY"
else
    echo "warning: no Developer ID nor '$LOCAL_IDENTITY' certificate (scripts/signing-identity.sh); signing ad hoc" >&2
    SIGN="-"
fi
TIMESTAMP=(); if [ "$SIGN" != "-" ]; then TIMESTAMP=(--timestamp); fi

# The nested runtime first, with its own entitlements (Bun's JIT); then the app around it
# (no --deep: it would re-sign bun with the app's entitlements).
codesign --force --options runtime ${TIMESTAMP[@]+"${TIMESTAMP[@]}"} --identifier click.ciromaciel.voice-assistant.bun \
    --entitlements "$ROOT/scripts/bun.entitlements" --sign "$SIGN" "$RESOURCES/bun"
codesign --force --options runtime ${TIMESTAMP[@]+"${TIMESTAMP[@]}"} \
    --entitlements "$ROOT/scripts/Assistant.entitlements" --sign "$SIGN" "$APP"
codesign --verify --deep --strict "$APP"
echo "signed with: $([ "$SIGN" = "-" ] && echo "ad hoc" || echo "$SIGN")"
echo "Assistant $VERSION → $APP"
