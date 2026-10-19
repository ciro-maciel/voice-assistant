// The window with sample data and nothing running: no voice loop, no microphone, no network.
// For screenshots of the interface in each language:
//   Assistant.app/Contents/MacOS/AssistantBar --preview now --capture /tmp/now.png -AppleLanguages "(en)"
// --preview takes a pane (now, history, listening, voice, brain); --capture writes the window
// as a PNG and quits.
import AppKit
import SwiftUI

enum Preview {
    static var pane: Pane? {
        guard let i = CommandLine.arguments.firstIndex(of: "--preview") else { return nil }
        let next = CommandLine.arguments.dropFirst(i + 1).first
        return next.flatMap(Pane.init(rawValue:)) ?? .now
    }

    static var capturePath: String? {
        guard let i = CommandLine.arguments.firstIndex(of: "--capture") else { return nil }
        return CommandLine.arguments.dropFirst(i + 1).first
    }

    /// Fills the model as a running loop would, in the interface's language.
    @MainActor
    static func fill(_ model: AssistantModel) {
        let pt = Localization.isPortuguese
        let now = Date().timeIntervalSince1970 * 1000
        let ask = pt ? "Como está o deploy do site?" : "How is the site's deploy going?"
        let tool = pt ? "Bash: gh run list --limit 1" : "Bash: gh run list --limit 1"
        let answer = pt ? "O último deploy passou há dez minutos, sem erro." : "The last deploy passed ten minutes ago, with no errors."
        let snapshot: [String: Any] = [
            "state": "waiting", "isMuted": false, "isMicDead": false, "isEchoCancelled": true,
            "device": pt ? "Microfone do MacBook Pro" : "MacBook Pro Microphone",
            "conversation": [
                "startedAt": now - 300_000, "costUsd": 0.0124, "answers": 1,
                "rows": [
                    ["role": "user", "text": ask, "at": now - 300_000],
                    ["role": "tool", "text": tool, "at": now - 297_000, "durationMs": 1400],
                    ["role": "assistant", "text": answer, "at": now - 294_000],
                ],
            ],
            "session": ["model": "claude-haiku-5-5", "claudePath": NSHomeDirectory() + "/.local/bin/claude", "claudeVersion": "2.1.0",
                        "startedAt": now - 1_500_000, "isReady": true],
            "heard": [["at": now - 300_000, "text": pt ? "Assistant, como está o deploy do site?" : "Assistant, how is the site's deploy going?", "action": "accepted"]],
            "draft": [],
            "settings": [
                "wakeWords": pt ? ["assistant", "assistente"] : ["assistant"], "inputPreference": [], "whisperModel": "large-v3-turbo",
                "followUpMs": 60_000, "summonMs": 8_000, "echoGuardMs": 1_200, "endSilenceMs": 1_200,
                "isDraftOn": true, "isEchoCancelOn": true, "isDirectedOn": true,
                "actionPhrases": [L("default.actionPhrase")], "draftMaxAgeMs": 600_000,
                "voiceId": "", "voiceName": "", "voiceSpeed": 1.25, "fishModel": "s2.1-pro", "fallbackVoice": pt ? "Luciana" : "Samantha",
                "brainModel": "claude-haiku-5-5", "folders": [NSHomeDirectory() + "/code/website"],
                "confirmActions": ["push", "deploy", "publish", "message", "delete", "pay"],
                "workingFolder": NSHomeDirectory() + "/code",
            ],
            "timings": ["transcribeMs": 420, "modelMs": 1800, "voiceMs": 650, "totalMs": 2870, "isSpoken": true],
            "memory": ["isResumed": false, "journalDays": 2],
        ]
        let labels = pt
            ? ["Push", "Deploy", "Publicar", "Mandar mensagem a alguém", "Apagar", "Pagar"]
            : ["Push", "Deploy", "Publish", "Message someone", "Delete", "Pay"]
        let ids = ["push", "deploy", "publish", "message", "delete", "pay"]
        let options: [String: Any] = [
            "inputs": [snapshot["device"]!], "models": ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
            "whisperModels": ["large-v3-turbo"], "fishModels": ["s2.1-pro-free", "s2.1-pro"],
            "macVoices": [pt ? "Luciana" : "Samantha"],
            "claudePaths": [["path": NSHomeDirectory() + "/.local/bin/claude", "version": "2.1.0"]],
            "confirmActions": zip(ids, labels).map { ["id": $0, "label": $1] },
        ]
        let history: [[String: Any]] = [
            ["conversationId": "b", "startedAt": now - 300_000, "firstQuestion": ask, "answers": 1, "costUsd": 0.0124],
            ["conversationId": "a", "startedAt": now - 90_000_000, "firstQuestion": pt ? "Abre um pull request com a correção do formulário." : "Open a pull request with the form fix.",
             "answers": 4, "costUsd": 0.0871],
        ]
        func decode<T: Decodable>(_ type: T.Type, _ object: Any) -> T? {
            (try? JSONSerialization.data(withJSONObject: object)).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
        }
        model.snapshot = decode(Snapshot.self, snapshot)
        model.options = decode(Options.self, options)
        model.history = decode([ConversationSummary].self, history) ?? []
        model.isMicAuthorized = true
    }

    /// The window's content as a PNG at `path`, then quit.
    @MainActor
    static func capture(_ window: NSWindow?, to path: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            guard let view = window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { exit(1) }
            view.cacheDisplay(in: view.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
            exit(0)
        }
    }
}
