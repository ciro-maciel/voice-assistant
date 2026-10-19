// What the app knows about the voice loop. It follows the loop's event stream (/events) and,
// whenever something other than a level changes, reads the whole state again (/state).
import AVFoundation
import Foundation

let hudBase = URL(string: "http://127.0.0.1:4780")!

enum LoopState: String {
    case waiting, listening, hearing, drafting, thinking, speaking, muted, offline

    var word: String {
        switch self {
        case .waiting: return "Disponível"
        case .listening: return "Pode falar"
        case .drafting: return "Anotando"
        case .hearing: return "Escutando"
        case .thinking: return "Pensando"
        case .speaking: return "Falando"
        case .muted: return "Microfone desligado"
        case .offline: return "Desligado"
        }
    }
}

struct Snapshot: Decodable {
    struct Row: Decodable, Identifiable {
        let role: String
        let text: String
        let at: Double
        let durationMs: Double?
        let isOpen: Bool?
        var id: String { "\(at)-\(role)" }
    }
    struct Conversation: Decodable { let startedAt: Double; let rows: [Row]; let costUsd: Double; let answers: Int }
    struct Session: Decodable { let model: String; let claudePath: String; let claudeVersion: String; let startedAt: Double; let isReady: Bool }
    struct Settings: Decodable {
        let inputDevice: String?
        let wakeWords: [String]
        let inputPreference: [String]
        let whisperModel: String
        let followUpMs: Double
        let summonMs: Double
        let echoGuardMs: Double
        let endSilenceMs: Double?
        let isDraftOn: Bool?
        let isEchoCancelOn: Bool?
        let isDirectedOn: Bool?
        let actionPhrases: [String]?
        let draftMaxAgeMs: Double?
        let voiceId: String
        let voiceName: String
        let voiceSpeed: Double
        let fishModel: String
        let fallbackVoice: String
        let brainModel: String
        let claudePath: String?
        /// Full paths of the folders Claude Code may read, besides the working folder.
        let folders: [String]
        let confirmActions: [String]
        let workingFolder: String
    }
    let state: String
    let isMuted: Bool
    let isMicDead: Bool
    let isEchoCancelled: Bool?
    let device: String
    let conversation: Conversation
    let session: Session
    /// The last things heard and what was done with each (newest first).
    struct Heard: Decodable, Identifiable { let at: Double; let text: String; let action: String; let reason: String?; var id: String { "\(at)-\(text)" } }
    let heard: [Heard]?
    /// What he said without the name, waiting for the action phrase.
    struct DraftEntry: Decodable, Identifiable { let at: Double; let text: String; var id: String { "\(at)" } }
    let draft: [DraftEntry]?
    let settings: Settings
    /// How long each stage of the last answer took (assistant/src/main.ts, "timings").
    struct Timings: Decodable { let transcribeMs: Double?; let modelMs: Double; let voiceMs: Double; let totalMs: Double; let isSpoken: Bool }
    let timings: Timings?
    /// Whether this session was resumed after a restart, and whether a journal exists.
    struct Memory: Decodable { let isResumed: Bool; let journalDays: Int }
    let memory: Memory?
}

struct Options: Decodable {
    struct ClaudePath: Decodable { let path: String; let version: String }
    struct Action: Decodable { let id: String; let label: String }
    let inputs: [String]
    let models: [String]
    let whisperModels: [String]
    let fishModels: [String]
    let macVoices: [String]
    let claudePaths: [ClaudePath]
    let confirmActions: [Action]
}

struct ConversationSummary: Decodable, Identifiable {
    let conversationId: String
    let startedAt: Double
    let firstQuestion: String
    let answers: Int
    let costUsd: Double
    var id: String { conversationId }
}

@MainActor
final class AssistantModel: ObservableObject {
    @Published var snapshot: Snapshot?
    @Published var history: [ConversationSummary] = []
    @Published var options: Options?
    /// A setting being applied (the Whisper model takes a moment to load).
    @Published var applying: String?
    @Published var inLevel: Double = 0
    @Published var outLevel: Double = 0
    @Published var spokenLine = ""
    @Published var isMicAuthorized = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    @Published var hotKeyProblem: String?
    @Published var now = Date()

    var state: LoopState { snapshot.flatMap { LoopState(rawValue: $0.state) } ?? .offline }
    var isMicOn: Bool { isMicAuthorized && !(snapshot?.isMicDead ?? false) }

    private var refreshPending = false
    private var clock: Timer?

    func start() {
        Task { await follow() }
        // Once a second: the status line (permission granted in System Settings) and the "há N min".
        clock = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.now = Date()
                self.isMicAuthorized = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
                if self.snapshot == nil { self.refresh() }
            }
        }
        refresh()
        loadHistory()
        loadOptions()
    }

    // MARK: - Reading

    private func follow() async {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .infinity
        config.timeoutIntervalForResource = .infinity
        let session = URLSession(configuration: config)
        while true {
            do {
                let (bytes, _) = try await session.bytes(from: hudBase.appendingPathComponent("events"))
                refresh()
                var event = ""
                for try await line in bytes.lines {
                    if line.hasPrefix("event: ") { event = String(line.dropFirst(7)) }
                    else if line.hasPrefix("data: ") { handle(event, String(line.dropFirst(6))) }
                }
            } catch {
                snapshot = nil
            }
            try? await Task.sleep(nanoseconds: 1_000_000_000)
        }
    }

    private func handle(_ event: String, _ data: String) {
        switch event {
        case "level": inLevel = Double(data) ?? 0
        case "outLevel": outLevel = Double(data) ?? 0
        case "spoken":
            spokenLine = (try? JSONDecoder().decode(String.self, from: Data(data.utf8))) ?? spokenLine
            refresh()
        case "turnEnd":
            refresh()
            loadHistory()
        default: refresh()
        }
    }

    /// Coalesces bursts (a streaming answer sends dozens of deltas) into one read every 100 ms.
    func refresh() {
        guard !refreshPending else { return }
        refreshPending = true
        Task {
            try? await Task.sleep(nanoseconds: 100_000_000)
            refreshPending = false
            var request = URLRequest(url: hudBase.appendingPathComponent("state"))
            request.timeoutInterval = 2
            if let (data, _) = try? await URLSession.shared.data(for: request) {
                snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
            } else {
                snapshot = nil
            }
        }
    }

    func loadOptions() {
        Task {
            if let (data, _) = try? await URLSession.shared.data(from: hudBase.appendingPathComponent("options")) {
                options = try? JSONDecoder().decode(Options.self, from: data)
            }
        }
    }

    /// Applied live by the loop and saved for the next start.
    func set(_ key: String, _ value: Any) {
        applying = key
        var request = URLRequest(url: hudBase.appendingPathComponent("settings"))
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [key: value])
        Task {
            _ = try? await URLSession.shared.data(for: request)
            applying = nil
            refresh()
        }
    }

    func loadHistory() {
        Task {
            if let (data, _) = try? await URLSession.shared.data(from: hudBase.appendingPathComponent("history")),
               let list = try? JSONDecoder().decode([ConversationSummary].self, from: data) {
                history = list
            }
        }
    }

    // MARK: - Commands

    func post(_ path: String, body: [String: Any]? = nil) {
        var request = URLRequest(url: hudBase.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            Task { @MainActor in self?.refresh() }
        }.resume()
    }

    func listen() { post("listen") }
    /// The current conversation goes to the journal; the next question opens a fresh session.
    func newConversation() { post("new") }
    func stop() { post("stop") }
    func toggleMute() { post("mute") }
    func sample() { post("sample") }
    func say(_ text: String) { post("say", body: ["text": text]) }
    func act() { post("act") }
    func clearDraft() { post("draft/clear") }
}

// MARK: - Formatting (pt-BR)

enum Format {
    private static let money: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.numberStyle = .decimal
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    /// Below one cent, three decimals: "US$ 0,004" says more than "US$ 0,00".
    static func usd(_ value: Double) -> String {
        money.maximumFractionDigits = value > 0 && value < 0.01 ? 3 : 2
        return "US$ " + (money.string(from: NSNumber(value: value)) ?? "0,00")
    }

    static func seconds(_ ms: Double) -> String {
        let s = ms / 1000
        if s == s.rounded() || s >= 10 { return "\(Int(s.rounded())) s" }
        return String(format: "%.1f s", s).replacingOccurrences(of: ".", with: ",")
    }

    static func clock(_ ms: Double) -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }

    static func day(_ ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Hoje, \(clock(ms))" }
        if cal.isDateInYesterday(date) { return "Ontem, \(clock(ms))" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "pt_BR")
        f.dateFormat = "dd/MM, HH:mm"
        return f.string(from: date)
    }

    static func since(_ ms: Double, now: Date) -> String {
        let minutes = Int(now.timeIntervalSince1970 - ms / 1000) / 60
        if minutes < 1 { return "aberta agora" }
        if minutes < 60 { return "aberta há \(minutes) min" }
        return "aberta há \(minutes / 60) h \(minutes % 60) min"
    }

    /// "claude-haiku-5-5" → "Haiku 5.5".
    static func model(_ id: String) -> String {
        let parts = id.replacingOccurrences(of: "claude-", with: "").split(separator: "-")
        guard let name = parts.first else { return id }
        return name.capitalized + " " + parts.dropFirst().joined(separator: ".")
    }

    /// "Microfone do Studio Display" → "Studio Display"; "Microfone (MacBook Pro)" → "MacBook Pro".
    static func device(_ name: String) -> String {
        name.replacingOccurrences(of: "Microfone do ", with: "")
            .replacingOccurrences(of: "Microfone (", with: "")
            .replacingOccurrences(of: ")", with: "")
    }
}
