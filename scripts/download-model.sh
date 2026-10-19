#!/bin/bash
# Downloads a Whisper model (ggml format, from the whisper.cpp repository on Hugging Face) into
# the folder the assistant reads models from.
#   scripts/download-model.sh [model]      model: tiny, base, small, medium, large-v3-turbo (default)
# The folder is whisperModelsDir in the config, or ~/Library/Application Support/voice-assistant/models.
set -euo pipefail

MODEL="${1:-large-v3-turbo}"
CONFIG="${VOICE_ASSISTANT_CONFIG:-$HOME/.config/voice-assistant/config.json}"
DIR=""
if [ -f "$CONFIG" ] && command -v jq >/dev/null; then DIR="$(jq -r '.whisperModelsDir // empty' "$CONFIG")"; fi
DIR="${DIR:-$HOME/Library/Application Support/voice-assistant/models}"
DIR="${DIR/#\~/$HOME}"
mkdir -p "$DIR"
FILE="$DIR/ggml-$MODEL.bin"
if [ -f "$FILE" ]; then echo "Already here: $FILE"; exit 0; fi
curl -fL --progress-bar -o "$FILE.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin"
mv "$FILE.part" "$FILE"
echo "Downloaded: $FILE"
