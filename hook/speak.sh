#!/bin/bash
# Claude Code Stop hook: speaks the spoken summary Claude leaves at the end of a finished task.
# Claude marks it with an HTML comment at the end of its final message:
#   <!-- voz: Terminei a revisão e subi a correção. -->     (or <!-- voice: ... -->)
# No marker = silence. Turn everything off with: touch ~/.claude/voice/off
#
# Voice: Fish Audio when FISH_API_KEY and a voice id are set; the Mac's `say` otherwise. Reads
# the same config file as the assistant (~/.config/voice-assistant/config.json, or the file
# VOICE_ASSISTANT_CONFIG names): fishVoiceId, voiceSpeed, fishModel, fishApiKeyFile,
# fallbackVoice. FISH_VOICE_ID and FISH_API_KEY in the environment win over it.
#
# Each spoken line is kept, text and audio, in ~/.claude/voice/history on this Mac only, for
# the player (hook/player). Only the summary text is sent to Fish.
set -u
DIR="${VOICE_HOOK_DIR:-$HOME/.claude/voice}"
[ -f "$DIR/off" ] && exit 0
# The voice assistant speaks its own session; stay quiet there.
[ -n "${ASSISTANT_SESSION:-}" ] && exit 0

CONFIG="${VOICE_ASSISTANT_CONFIG:-$HOME/.config/voice-assistant/config.json}"
conf() { [ -f "$CONFIG" ] && jq -r --arg k "$1" '.[$k] // empty' "$CONFIG" 2>/dev/null; }
VOICE_ID="${FISH_VOICE_ID:-$(conf fishVoiceId)}"
SPEED="$(conf voiceSpeed)"; SPEED="${SPEED:-1}"
MODEL="$(conf fishModel)"; MODEL="${MODEL:-s2.1-pro}"
FALLBACK="$(conf fallbackVoice)"; FALLBACK="${FALLBACK:-Luciana}"
if [ -z "${FISH_API_KEY:-}" ]; then
  KEY_FILE="$(conf fishApiKeyFile)"; KEY_FILE="${KEY_FILE/#\~/$HOME}"
  if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
    FISH_API_KEY="$(sed -n 's/^FISH_API_KEY=["'\'']\{0,1\}\([^"'\'']*\)["'\'']\{0,1\}$/\1/p' "$KEY_FILE" | head -1)"
  fi
fi

input=$(cat)
project=$(printf '%s' "$input" | jq -r '.cwd // empty' | xargs basename 2>/dev/null)
msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
if [ -z "$msg" ]; then
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty')
  [ -f "$transcript" ] || exit 0
  msg=$(tail -n 200 "$transcript" | jq -rs '
    [ .[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text ] | last // empty')
fi

text=$(printf '%s' "$msg" | perl -0ne 'print $1 if /<!--\s*(?:voz|voice):\s*(.*?)\s*-->/s')
[ -z "$text" ] && exit 0

# Stop whatever is still speaking from a previous turn.
if [ -f "$DIR/pid" ]; then old=$(cat "$DIR/pid"); pkill -P "$old" 2>/dev/null; kill "$old" 2>/dev/null; fi

FFPLAY="$(command -v ffplay || echo /opt/homebrew/bin/ffplay)"
id=$(date +%Y%m%d-%H%M%S)-$$
mkdir -p "$DIR/history"
# Log first so the player shows the line while it is still being spoken.
jq -cn --arg id "$id" --arg t "$text" --arg p "$project" \
  '{id: $id, at: (now | todate), text: $t, project: $p}' >> "$DIR/history/index.jsonl"
(
  set -o pipefail
  rate=$(awk -v s="$SPEED" 'BEGIN { printf "%d", 175 * s }')
  if [ -z "${FISH_API_KEY:-}" ] || [ -z "$VOICE_ID" ]; then
    say -v "$FALLBACK" -r "$rate" "$text"
    exit 0
  fi
  body=$(jq -n --arg t "$text" --arg v "$VOICE_ID" --argjson s "$SPEED" \
    '{text: $t, reference_id: $v, format: "mp3", latency: "balanced", prosody: {speed: $s}}')
  # Save the audio while it plays, so the player can replay it instantly.
  if curl -sf --no-buffer --max-time 60 -X POST https://api.fish.audio/v1/tts \
      -H "Authorization: Bearer $FISH_API_KEY" -H 'Content-Type: application/json' \
      -H "model: $MODEL" -d "$body" \
      | tee "$DIR/history/$id.mp3" \
      | "$FFPLAY" -nodisp -autoexit -loglevel error -i pipe:0; then
    :
  else
    rm -f "$DIR/history/$id.mp3"
    say -v "$FALLBACK" -r "$rate" "$text"   # offline fallback
  fi
) >/dev/null 2>&1 &
echo $! > "$DIR/pid"
exit 0
