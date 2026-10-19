# Assistant by Ciro Cesar Maciel

**A voice assistant for Claude Code: say its name, ask out loud, and it answers by voice while it works in your repositories.**

Speech is transcribed on your Mac by a local Whisper; the audio never leaves it. Each request goes to one Claude Code session that stays open all day, and the answer is spoken sentence by sentence as it streams. A menu bar app for macOS 14+ on Apple Silicon, with the voice loop written in TypeScript on Bun.

[Português](README.pt-BR.md) · [The page](https://ciromaciel.click/tools/voice-assistant?ref=oss-voice-assistant)

## Install

```bash
curl -fsSL https://blob.ciromaciel.click/tools/voice-assistant/install.sh | bash
```

The script downloads the latest `.dmg`, copies Assistant to `/Applications` and opens it. Prefer the disk image? [Download Assistant-macos.dmg](https://blob.ciromaciel.click/tools/voice-assistant/latest/Assistant-macos.dmg). It is signed with Developer ID and notarized by Apple.

Assistant drives tools you install once:

```bash
brew install sox whisper-cpp ffmpeg       # microphone, local Whisper, audio playback
scripts/download-model.sh large-v3-turbo  # or tiny, base, small, medium (from a clone of this repository)
```

and [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in. On first launch, allow the microphone.

## How you talk to it

| You | Assistant |
| --- | --- |
| "Assistant, what is the status of the deploy?" | answers right away |
| "Assistant" alone | plays a sound and waits 8 seconds for the request |
| a reply after it finishes speaking | accepted without the name for 60 seconds |
| "Assistant" while it speaks or works | stops at once and listens |
| anything else | goes to a draft; say "pode fazer" to run it, or the name |

Before using a tool it says what it is about to do. Reading, searching and editing local files it does without asking. Push, deploy, publish, messaging someone, deleting and paying wait for your spoken yes in that conversation; the list is yours to change in the app.

The prompts, the voice rules and the interface are in Portuguese today.

## How it works

```
microphone ─ app (echo cancelled) or sox ─> engine/src/ear.ts ─ whisper-server (local) ─> text
text ─> conversation.ts: has the name? is the window open? is it my own echo? is it for me?
request ─> brain.ts: one Claude Code session kept open (stream-json)
streaming answer ─> sentences.ts: sentence by sentence ─> mouth.ts: Fish Audio or the Mac's voice
```

- **Ear.** Utterances are cut by energy with an adaptive noise floor. Whisper's hallucinations on silence are dropped. With the app running, macOS voice processing removes the assistant's own voice from the microphone, so you can interrupt it over the speakers.
- **Brain.** `claude -p` in streaming mode, in the folder you choose, with the extra folders you add. Same day, same session: it is resumed after a restart. When a conversation ends, a one-shot Claude Code writes a short summary into a local journal that the next session reads.
- **Is this for me?** Without the name, a small model reads the utterance and the last exchanges and decides whether you were talking to it (after Mallidi et al., *Device-directed Utterance Detection*, 2018). No means it stays in the draft, never lost.
- **Mouth.** With a [Fish Audio](https://fish.audio) key and voice id, each sentence is synthesized up to two ahead of the one playing. Without them, the Mac's own voice speaks.
- **Panel.** <http://localhost:4780> shows what it heard (and what it ignored, and why), the tools it runs and what each answer cost. You can type instead of talking there.

## What leaves your Mac

| Goes out | To |
| --- | --- |
| The text of your requests and the files Claude Code reads | Anthropic, through your Claude Code |
| The text of each spoken sentence, only if you configure Fish | Fish Audio |

Your voice, the recordings and the transcripts stay on the Mac: history, journal and session live in `~/Library/Application Support/voice-assistant`.

## Configure

Everything personal is in one file outside the repository, `~/.config/voice-assistant/config.json` (or the path in `VOICE_ASSISTANT_CONFIG`). Every key is optional; [`config.example.json`](config.example.json) has them all.

| Key | What it does | Default |
| --- | --- | --- |
| `wakeWords` | The name first, then how Whisper mishears it | `["assistant", "assistente"]` |
| `userName` | How the instructions refer to you | "a pessoa" |
| `workingDir` | Where the Claude Code session runs (its `CLAUDE.md`) | your home folder |
| `folders` | Extra folders it may read and edit (`--add-dir`) | none |
| `instructions` | Lines appended to the voice rules | none |
| `inputPreference` | Microphones by name, first connected wins | system default |
| `whisperModelsDir`, `whisperModel`, `whisperLanguage`, `whisperPrompt` | Local Whisper | `…/voice-assistant/models`, `large-v3-turbo`, `pt` |
| `fishVoiceId`, `voiceName`, `voiceSpeed`, `fishModel` | Fish Audio voice | none (Mac voice), 1.0, `s2.1-pro` |
| `fishApiKeyFile` | A dotenv file with `FISH_API_KEY=` for when the app has no shell environment | none |
| `fallbackVoice` | The Mac voice (`say -v ?`) | Luciana |
| `brainModel` | Claude model of the conversation | `claude-haiku-5-5` |
| `dataDir` | History, journal, session and the app's settings | `~/Library/Application Support/voice-assistant` |

Environment variables win over the file: `FISH_API_KEY`, `FISH_VOICE_ID`, `ASSISTANT_MODEL`, `ASSISTANT_INPUT` (a microphone by name) and `ASSISTANT_CLAUDE` (the `claude` binary). The app's Ajustes screens change microphone, Whisper model, voice, model, folders and confirmations live, and save them in `dataDir/settings.json`.

## The spoken summary hook (optional)

[`hook/speak.sh`](hook/speak.sh) gives a voice to your ordinary Claude Code sessions too. As a `Stop` hook, it reads the end of each answer and speaks a marker like `<!-- voz: Terminei e subi a correção. -->` (or `voice:`), with the same voice settings. No marker, no sound; `touch ~/.claude/voice/off` silences it.

```json
{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "/path/to/voice-assistant/hook/speak.sh", "async": true, "timeout": 10 } ] } ] } }
```

Then tell Claude, in your `CLAUDE.md`, to end finished tasks with that marker in one to three spoken sentences. `bun hook/player/server.ts` opens a local player at <http://127.0.0.1:4777> with every line said, to replay. Inside the assistant's own session the hook stays quiet.

## Build it yourself

You need the Xcode Command Line Tools and [Bun](https://bun.sh).

```bash
git clone https://github.com/ciro-maciel/voice-assistant.git
cd voice-assistant
scripts/build.sh                 # dist/Assistant.app, with Bun and the engine inside
open dist/Assistant.app
```

Or run only the engine, from a terminal that has microphone permission (Terminal.app):

```bash
cd engine && bun start           # panel on http://localhost:4780
bun test                         # wake word, echo, conversation windows, sentences, memory
```

`scripts/build.sh` signs with a Developer ID Application certificate when your keychain has one. Otherwise `scripts/signing-identity.sh` creates a local signing certificate once: with it, the microphone permission survives each rebuild; without it, the build is signed ad hoc and macOS asks again every time. `scripts/dist.sh` bumps the version, packs a `.dmg` and installs it in `/Applications`.

## Limits

- Apple Silicon and macOS 14 or newer only.
- Portuguese prompts and interface.
- One model talks and works: during a long task it says what it will do and goes quiet until it ends.
- It does not start at login.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Fonts and icons keep their own licenses: see [NOTICE](NOTICE).

---

Made by [Ciro Cesar Maciel](https://ciromaciel.click/?ref=oss-voice-assistant). I build tools and show how to use them: more [free tools](https://ciromaciel.click/tools?ref=oss-voice-assistant).

**Want the next one?** [Follow @ciro-maciel](https://github.com/ciro-maciel) for the next open-source tools, and click **Watch → Custom → Releases** above to hear about every new version.
