# Notes for coding agents

Assistant is two parts: the voice loop (`engine/`, TypeScript on Bun) and a macOS menu bar app (`Sources/AssistantBar/`, Swift and SwiftUI) that embeds Bun and the engine and talks to it over `http://127.0.0.1:4780`. The app is built by `scripts/build.sh` with `swiftc`, so there is no Xcode project.

## Layout

| Path | What it is |
| --- | --- |
| `engine/src/main.ts` | Wires ear, brain, mouth, memory and the HUD |
| `engine/src/config.ts` | Every knob; personal values come from `~/.config/voice-assistant/config.json` |
| `engine/src/language.ts`, `strings.ts` | Which language (config, else the Mac) and every short text in both |
| `engine/src/ear.ts` | Microphone (sox, or the app's echo-cancelled stream), utterance cutting, local whisper-server |
| `engine/src/conversation.ts`, `wake.ts`, `draft.ts`, `directed.ts` | What to do with each utterance |
| `engine/src/brain.ts` | The persistent `claude -p` session (stream-json) |
| `engine/src/mouth.ts`, `sentences.ts` | Speech: Fish Audio or `say`, sentence by sentence |
| `engine/src/memory.ts`, `transcript.ts`, `settings.ts` | Session resume, journal, history, app settings |
| `engine/src/hud.ts`, `hud.html`, `audio-bridge.ts` | Local panel, API and the app's audio WebSocket |
| `Sources/AssistantBar/` | The menu bar app; `AudioIO.swift` records and plays with voice processing |
| `hook/` | The optional Claude Code Stop hook that speaks `<!-- voz: ... -->` markers, and its player |
| `scripts/` | Build, local install, signing identity, Whisper model download, asset regeneration |
| `scripts/release/` | Packing the `.dmg` and publishing it; used by `.github/workflows/release.yml` |

## Before you say it works

```bash
cd engine && bun test
cd .. && scripts/build.sh
```

## Rules that must hold

- Audio, transcripts and history never leave the Mac. No telemetry.
- Nothing personal in the repository: the config file holds it, and `config.example.json` documents it with generic values.
- The engine's local server listens on 127.0.0.1 only.
- The bundle identifier (`click.ciromaciel.voice-assistant`) never changes: macOS ties the Microphone grant to it.
- Every user-facing string exists in English and Brazilian Portuguese (`Resources/en.lproj` / `Resources/pt-BR.lproj` for the app through `L(...)`, `engine/src/strings.ts` and the prompts beside their code for the engine, the `TEXT` table in `hud.html`); a change that adds text adds both. The app follows the Mac's language; the conversation follows the config's `language`, else the Mac. Code, comments and file names are in English.
