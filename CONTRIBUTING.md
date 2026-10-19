# Contributing

Thanks for helping. Assistant listens all day and acts in other people's repositories, so the bar is "never surprise anyone".

## Code

```bash
cd engine && bun test          # the pure parts: wake word, echo, windows, draft, sentences, memory, settings
cd .. && scripts/build.sh      # the app, with the engine inside
```

The tests must pass on your Mac before you open the pull request. If your change touches the conversation (what is accepted, ignored or interrupted), add a test in `engine/src/*.test.ts` and say how you tried it by voice. If it touches the screens, attach a capture.

House rules:

- Bun and TypeScript for the engine, Swift and SwiftUI for the app, built by `swiftc`. No Xcode project, no npm, no new dependencies without a good reason.
- Audio stays on the Mac. No recording, transcript or history leaves it; the only things sent out are the requests to Claude Code and, when configured, the text of each spoken sentence to Fish Audio.
- Nothing personal in the code: names, voices, folders and microphones come from the config file (`config.example.json`).
- Actions that change the outside world (push, deploy, publish, messages, deleting, paying) keep needing a spoken yes unless the person turns that off.

## Reporting a bug

Say which macOS version, which microphone, and what the panel at <http://localhost:4780> showed under what it heard. The app's log is at `~/Library/Logs/voice-assistant/assistant.log`; read it before attaching, since it contains what you said.

For anything that could harm someone's data or security, read [SECURITY.md](SECURITY.md) first.
