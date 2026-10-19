// The window: sidebar with the name as wordmark, Conversa › Agora, Histórico and
// Ajustes › Escuta, Voz, Cérebro; the microphone in the status line; one page per item.
// Tarefas waits for phase 2 (decided on 12/10/2026: no menu item that does nothing).
import AppKit
import SwiftUI

enum Pane: String, CaseIterable, Identifiable {
    case now, history, listening, voice, brain
    var id: String { rawValue }

    /// The group's id; its title is L("group.<id>").
    var group: String { self == .now || self == .history ? "conversation" : "settings" }
    var title: String {
        switch self {
        case .now: return L("pane.now")
        case .history: return L("pane.history")
        case .listening: return L("pane.listening")
        case .voice: return L("pane.voice")
        case .brain: return L("pane.brain")
        }
    }
    var icon: String {
        switch self {
        case .now: return "message"
        case .history: return "history"
        case .listening: return "ear"
        case .voice: return "volume"
        case .brain: return "terminal-2"
        }
    }
    var subtitle: String {
        switch self {
        case .now: return L("pane.now.subtitle")
        case .history: return L("pane.history.subtitle")
        case .listening: return L("pane.listening.subtitle")
        case .voice: return L("pane.voice.subtitle")
        case .brain: return L("pane.brain.subtitle")
        }
    }
}

final class Navigation: ObservableObject {
    @Published var pane: Pane = .now
}

let microphoneSettingsURL = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Microphone")!

struct AppView: View {
    @ObservedObject var model: AssistantModel
    @ObservedObject var nav: Navigation
    @ObservedObject var shortcuts: Shortcuts

    var body: some View {
        MacShellView {
            MacSidebar(app: "Assistant") {
                ForEach(["conversation", "settings"], id: \.self) { group in
                    MacSidebarGroup(title: L("group.\(group)")) {
                        ForEach(Pane.allCases.filter { $0.group == group }) { p in
                            MacSidebarItem(icon: p.icon, title: p.title,
                                           badge: p == .history && !model.history.isEmpty ? "\(model.history.count)" : nil,
                                           active: nav.pane == p) { nav.pane = p }
                        }
                    }
                }
            } status: {
                MacStatusLine(on: model.isMicOn, onText: L("status.micOn"), offText: L("status.micOff")) {
                    NSWorkspace.shared.open(microphoneSettingsURL)
                }
            }
        } content: {
            MacPage {
                MacPageHeader(crumb: "Assistant", title: nav.pane.title, subtitle: nav.pane.subtitle) { actions }
                switch nav.pane {
                case .now: NowScreen(model: model)
                case .history: HistoryScreen(model: model)
                case .listening: ListeningScreen(model: model, shortcuts: shortcuts)
                case .voice: VoiceScreen(model: model)
                case .brain: BrainScreen(model: model)
                }
            }
        }
    }

    @ViewBuilder private var actions: some View {
        switch nav.pane {
        case .now:
            Button { model.newConversation() } label: { ButtonLabel(title: L("button.newConversation"), icon: "message-plus") }
                .buttonStyle(ZenButtonStyle(kind: .secondary))
            Button { model.stop() } label: { ButtonLabel(title: L("menu.stop"), icon: "player-stop") }
                .buttonStyle(ZenButtonStyle(kind: .secondary))
            Button { model.listen() } label: { ButtonLabel(title: L("menu.listen"), icon: "microphone", color: .white) }
                .buttonStyle(ZenButtonStyle())
        case .voice:
            Button { model.sample() } label: { ButtonLabel(title: L("button.sample"), icon: "player-play", color: .white) }
                .buttonStyle(ZenButtonStyle())
        case .brain:
            Button { NSWorkspace.shared.open(logURL) } label: { ButtonLabel(title: L("button.openLog"), icon: "file-text") }
                .buttonStyle(ZenButtonStyle(kind: .secondary))
        default:
            EmptyView()
        }
    }
}

// MARK: - Agora

struct NowScreen: View {
    @ObservedObject var model: AssistantModel
    @State private var draft = ""

    private var level: Double { model.state == .speaking ? model.outLevel : model.inLevel }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CellRow {
                Cell(label: L("now.state"), note: stateNote) {
                    StateGlyph(state: model.state, level: level)
                    Text(model.state.word).zenDisplay(22).lineLimit(1).minimumScaleFactor(0.7)
                }
                Cell(label: L("now.microphone"), note: micNote) {
                    Text(model.snapshot.map { Format.device($0.device) } ?? "—").zenDisplay(22).lineLimit(2)
                }
                Cell(label: L("now.session"), note: sessionNote) {
                    Text(model.snapshot.map { Format.model($0.session.model) } ?? "—").zenDisplay(22)
                }
                Cell(label: L("now.thisConversation"), note: costNote, isLast: true) {
                    Text(Format.usd(model.snapshot?.conversation.costUsd ?? 0)).zenDisplay(22)
                }
            }
            .padding(.bottom, 28)

            if let t = model.snapshot?.timings {
                BlockLabel(text: L("now.lastAnswer"))
                CellRow {
                    Cell(label: L("now.transcription"), note: t.isSpoken ? L("now.transcription.note") : L("now.transcription.typed")) {
                        Text(t.transcribeMs.map(Format.seconds) ?? "—").zenDisplay(22)
                    }
                    Cell(label: L("now.model"), note: L("now.model.note")) {
                        Text(Format.seconds(t.modelMs)).zenDisplay(22)
                    }
                    Cell(label: L("now.voice"), note: L("now.voice.note")) {
                        Text(Format.seconds(t.voiceMs)).zenDisplay(22)
                    }
                    Cell(label: L("now.untilHeard"), note: t.isSpoken ? L("now.untilHeard.note") : L("now.untilHeard.typed"), isLast: true) {
                        Text(Format.seconds(t.totalMs)).zenDisplay(22)
                    }
                }
                .padding(.bottom, 28)
            }

            BlockLabel(text: L("now.conversation"))
            let rows = model.snapshot?.conversation.rows ?? []
            if rows.isEmpty {
                Rows {
                    Text(L("now.empty", model.snapshot?.settings.wakeWords.first ?? "assistant")
                         + ((model.snapshot?.memory?.journalDays ?? 0) > 0 ? " " + L("now.empty.remembers") : ""))
                        .zenBody(13).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                Rows {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                        if i > 0 { RowRule() }
                        ConversationRow(row: row, isLive: model.state == .speaking && i == rows.count - 1)
                    }
                }
            }

            DraftBlock(model: model)
            HeardBlock(model: model)

            HStack(spacing: 12) {
                TextField(L("now.typeInstead"), text: $draft)
                    .textFieldStyle(.plain)
                    .font(Zen.font(15, .medium))
                    .foregroundStyle(Zen.gray9)
                    .frame(height: 44)
                    .overlay(alignment: .bottom) { Rectangle().fill(Zen.gray3).frame(height: 1) }
                    .onSubmit(send)
                Button(action: send) { Text(L("now.send")) }
                    .buttonStyle(ZenButtonStyle(kind: .secondary))
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.top, 20)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.say(text)
        draft = ""
    }

    private var stateNote: String {
        switch model.state {
        case .thinking, .speaking: return L("note.interrupt")
        case .muted: return model.snapshot?.isMuted == true ? L("note.mutedInMenu") : L("note.openSettings")
        case .offline: return L("note.offline")
        case .waiting: return L("note.waiting")
        case .drafting: return L("note.drafting", model.snapshot?.settings.actionPhrases?.first ?? L("default.actionPhrase"))
        default: return L("note.noNameNeeded")
        }
    }

    private var micNote: String {
        guard model.snapshot != nil else { return "" }
        return L("note.microphone")
    }

    private var sessionNote: String {
        guard let s = model.snapshot?.session else { return "" }
        guard s.startedAt > 0 else { return L("note.session.reopening", s.claudeVersion) }
        return L("note.session", s.claudeVersion, Format.since(s.startedAt, now: model.now))
    }

    private var costNote: String {
        let n = model.snapshot?.conversation.answers ?? 0
        return L("note.cost", count: n)
    }
}

struct ConversationRow: View {
    let row: Snapshot.Row
    let isLive: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 16) {
            Text(who).zenLabel(10, color: row.role == "user" ? Zen.gray9 : Zen.gray5).frame(width: 110, alignment: .leading)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                text
                if isLive { Rectangle().fill(Zen.gray9).frame(width: 7, height: 14).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 } }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(meta).zenData(12, color: Zen.gray5)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private var who: String {
        switch row.role {
        case "user": return L("row.you")
        case "tool": return L("row.tool")
        default: return "Assistant"
        }
    }

    @ViewBuilder private var text: some View {
        switch row.role {
        case "user":
            Text(row.text).font(Zen.font(13, .bold)).foregroundStyle(Zen.gray9).fixedSize(horizontal: false, vertical: true)
        case "tool":
            Text(row.text).font(.system(size: 12, design: .monospaced)).foregroundStyle(Zen.gray5).fixedSize(horizontal: false, vertical: true)
        default:
            Text(row.text).zenData(13).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var meta: String {
        if row.role == "tool" { return row.durationMs.map(Format.seconds) ?? L("row.running") }
        return row.isOpen == true ? "" : Format.clock(row.at)
    }
}

/// The draft on Agora: what he said without the name, with Executar and Limpar.
struct DraftBlock: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
        // The draft: what he said without the name, waiting for the action phrase.
        let draft = model.snapshot?.draft ?? []
        if !draft.isEmpty {
            HStack(alignment: .firstTextBaseline) {
                BlockLabel(text: L("draft.title"))
                Spacer()
                HStack(spacing: 8) {
                    Button { model.clearDraft() } label: { ButtonLabel(title: L("button.clear"), icon: "x") }
                        .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    Button { model.act() } label: { ButtonLabel(title: L("button.run"), icon: "player-play") }
                        .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                }
                .padding(.bottom, 10)
            }
            .padding(.top, 28)
            Rows {
                ForEach(Array(draft.enumerated()), id: \.element.id) { i, entry in
                    if i > 0 { RowRule() }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(entry.text).zenData(13, color: Zen.gray9).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(Format.clock(entry.at)).zenData(12, color: Zen.gray5)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
            }
            Text(L("draft.note", model.snapshot?.settings.actionPhrases?.first ?? L("default.actionPhrase")))
                .zenNote().padding(.top, 10)
        }
        }
    }
}

/// "What I heard" on Now: the last things heard in two minutes, and what was done with each.
struct HeardBlock: View {
    @ObservedObject var model: AssistantModel

    /// The engine sends an id (engine/src/main.ts, noteHeard); an unknown one shows as it came.
    static func action(_ id: String) -> String {
        let key = "heard.action.\(id)"
        let text = L(key)
        return text == key ? id : text
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
        // What was heard in the last two minutes: a request that went nowhere shows its reason.
        let heard = (model.snapshot?.heard ?? []).filter { model.now.timeIntervalSince1970 * 1000 - $0.at < 120_000 }.prefix(4)
        if !heard.isEmpty {
            BlockLabel(text: L("heard.title")).padding(.top, 28)
            Rows {
                ForEach(Array(heard.enumerated()), id: \.element.id) { i, h in
                    if i > 0 { RowRule() }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(Self.action(h.action)).zenLabel(10, color: h.action == "accepted" ? Zen.gray5 : Zen.gray9).frame(width: 110, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(h.text).zenData(13, color: Zen.gray9).fixedSize(horizontal: false, vertical: true)
                            if let reason = h.reason { Text(reason).zenData(12, color: Zen.gray5).fixedSize(horizontal: false, vertical: true) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Text(Format.clock(h.at)).zenData(12, color: Zen.gray5)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 10)
                }
            }
        }
        }
    }
}

// MARK: - Histórico

struct HistoryScreen: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BlockLabel(text: L("history.title"))
            Rows {
                if model.history.isEmpty {
                    Text(L("history.empty")).zenBody(13).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(model.history.enumerated()), id: \.element.id) { i, c in
                    if i > 0 { RowRule() }
                    DataRow(label: Format.day(c.startedAt), value: c.firstQuestion,
                            detail: L("history.answers", count: c.answers) + " · " + Format.usd(c.costUsd), labelWidth: 120)
                }
            }
            Text(L("history.note"))
                .zenNote().padding(.top, 16).frame(maxWidth: 640, alignment: .leading)
        }
        .onAppear { model.loadHistory() }
    }
}

// MARK: - Ajustes
// Every row writes through model.set(...): the loop applies it at once and keeps it in
// settings.json in the data folder (~/Library/Application Support/voice-assistant by default). Shortcuts live in the app.

/// "1,5 s", "15 s": the choices of a time select.
private func secondsChoices(_ values: [Double]) -> [(id: String, title: String)] {
    values.map { (String(Int($0 * 1000)), Format.seconds($0 * 1000)) }
}

struct ListeningScreen: View {
    @ObservedObject var model: AssistantModel
    @ObservedObject var shortcuts: Shortcuts

    var body: some View {
        let s = model.snapshot?.settings
        VStack(alignment: .leading, spacing: 0) {
            BlockLabel(text: L("listening.micBlock"))
            SettingRows {
                SettingRow(title: L("listening.echo"), hint: model.snapshot?.isEchoCancelled == true
                           ? L("listening.echo.on")
                           : L("listening.echo.off")) {
                    ZenSwitch(isOn: s?.isEchoCancelOn ?? true) { model.set("isEchoCancelOn", $0) }
                }
                SettingRow(title: L("listening.microphone"), hint: L("listening.microphone.hint")) {
                    MicMeter(level: model.inLevel)
                    ZenSelect(value: model.snapshot.map { Format.device($0.device) } ?? "—",
                              choices: (model.options?.inputs ?? []).map { ($0, Format.device($0)) },
                              selected: model.snapshot?.device,
                              isBusy: model.applying == "inputDevice") { model.set("inputDevice", $0) }
                }
                .zIndex(2)
                SettingRow(title: L("listening.transcription"), hint: L("listening.transcription.hint")) {
                    ZenSelect(value: s?.whisperModel ?? "—",
                              choices: (model.options?.whisperModels ?? []).map { ($0, $0) },
                              selected: s?.whisperModel,
                              isBusy: model.applying == "whisperModel") { model.set("whisperModel", $0) }
                }
                .zIndex(1)
            }
            .padding(.bottom, 32)

            BlockLabel(text: L("listening.callBlock"))
            SettingRows {
                SettingRow(title: L("listening.directed"), hint: L("listening.directed.hint")) {
                    ZenSwitch(isOn: s?.isDirectedOn ?? true) { model.set("isDirectedOn", $0) }
                }
                SettingRow(title: L("listening.draft"), hint: L("listening.draft.hint")) {
                    ZenSwitch(isOn: s?.isDraftOn ?? true) { model.set("isDraftOn", $0) }
                }
                SettingRow(title: L("listening.actionPhrase"), hint: L("listening.actionPhrase.hint")) {
                    ZenTextField(placeholder: L("default.actionPhrase"), value: s?.actionPhrases?.joined(separator: ", ") ?? L("default.actionPhrase"), width: 240) { text in
                        model.set("actionPhrases", text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                    }
                }
                SettingRow(title: L("listening.draftAge"), hint: L("listening.draftAge.hint")) {
                    ZenSelect(value: s.map { "\(Int(($0.draftMaxAgeMs ?? 600_000) / 60_000)) min" } ?? "—",
                              choices: [5, 10, 20, 30, 60].map { (String($0 * 60_000), "\($0) min") },
                              selected: s.map { String(Int($0.draftMaxAgeMs ?? 600_000)) }, width: 160) { model.set("draftMaxAgeMs", Int($0) ?? 600_000) }
                }
                .zIndex(5)
                SettingRow(title: L("listening.name"), hint: L("listening.name.hint")) {
                    ZenTextField(placeholder: L("listening.name.placeholder"), value: s?.wakeWords.joined(separator: ", ") ?? "", width: 320) { text in
                        model.set("wakeWords", text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                    }
                }
                SettingRow(title: L("menu.listen"), hint: model.hotKeyProblem ?? L("listening.listenShortcut.hint")) {
                    KeyRecorder(shortcut: shortcuts.listen, shortcuts: shortcuts) { shortcuts.listen = $0 }
                }
                SettingRow(title: L("menu.stop"), hint: L("listening.stopShortcut.hint")) {
                    KeyRecorder(shortcut: shortcuts.stop, allowsKeyAlone: true, shortcuts: shortcuts) { shortcuts.stop = $0 }
                }
            }
            .padding(.bottom, 32)

            BlockLabel(text: L("listening.timesBlock"))
            SettingRows {
                SettingRow(title: L("listening.endSilence"), hint: L("listening.endSilence.hint")) {
                    ZenSelect(value: s.map { Format.seconds($0.endSilenceMs ?? 1_200) } ?? "—",
                              choices: secondsChoices([0.8, 1.2, 1.6, 2, 2.5]),
                              selected: s.map { String(Int($0.endSilenceMs ?? 1_200)) }, width: 160) { model.set("endSilenceMs", Int($0) ?? 1_200) }
                }
                .zIndex(4)
                SettingRow(title: L("listening.followUp"), hint: L("listening.followUp.hint")) {
                    ZenSelect(value: s.map { Format.seconds($0.followUpMs) } ?? "—",
                              choices: secondsChoices([15, 30, 45, 60, 90, 120]),
                              selected: s.map { String(Int($0.followUpMs)) }, width: 160) { model.set("followUpMs", Int($0) ?? 15_000) }
                }
                .zIndex(3)
                SettingRow(title: L("listening.summon"), hint: L("listening.summon.hint")) {
                    ZenSelect(value: s.map { Format.seconds($0.summonMs) } ?? "—",
                              choices: secondsChoices([4, 6, 8, 10, 15, 20]),
                              selected: s.map { String(Int($0.summonMs)) }, width: 160) { model.set("summonMs", Int($0) ?? 8_000) }
                }
                .zIndex(2)
                SettingRow(title: L("listening.echoGuard"), hint: L("listening.echoGuard.hint")) {
                    ZenSelect(value: s.map { Format.seconds($0.echoGuardMs) } ?? "—",
                              choices: secondsChoices([0, 0.5, 0.8, 1.2, 1.5, 2]),
                              selected: s.map { String(Int($0.echoGuardMs)) }, width: 160) { model.set("echoGuardMs", Int($0) ?? 1_200) }
                }
                .zIndex(1)
            }
        }
    }
}

struct VoiceScreen: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        let s = model.snapshot?.settings
        let speeds: [Double] = [1, 1.25, 1.5, 1.75, 2]
        VStack(alignment: .leading, spacing: 0) {
            BlockLabel(text: "Fish Audio")
            SettingRows {
                SettingRow(title: L("voice.voice"), hint: L("voice.voice.hint")) {
                    ZenTextField(placeholder: L("voice.voice.placeholder"), value: s?.voiceId ?? "", width: 320) { model.set("voiceId", $0) }
                }
                SettingRow(title: L("voice.name"), hint: L("voice.name.hint")) {
                    ZenTextField(placeholder: L("voice.name.placeholder"), value: s?.voiceName ?? "", width: 240) { model.set("voiceName", $0) }
                }
                SettingRow(title: L("voice.speed")) {
                    ZenSelect(value: s.map { Format.speed($0.voiceSpeed) } ?? "—",
                              choices: speeds.map { (String($0), Format.speed($0)) },
                              selected: s.map { String($0.voiceSpeed) }, width: 160) { model.set("voiceSpeed", Double($0) ?? 1.5) }
                }
                .zIndex(2)
                SettingRow(title: L("voice.model"), hint: L("voice.model.hint")) {
                    ZenSelect(value: s?.fishModel ?? "—",
                              choices: (model.options?.fishModels ?? []).map { ($0, $0) },
                              selected: s?.fishModel, width: 200) { model.set("fishModel", $0) }
                }
                .zIndex(1)
            }
            .padding(.bottom, 32)

            BlockLabel(text: L("voice.offlineBlock"))
            SettingRows {
                SettingRow(title: L("voice.macVoice"), hint: L("voice.macVoice.hint")) {
                    ZenSelect(value: s?.fallbackVoice ?? "—",
                              choices: (model.options?.macVoices ?? []).map { ($0, $0) },
                              selected: s?.fallbackVoice, width: 200) { model.set("fallbackVoice", $0) }
                }
            }
        }
    }
}

struct BrainScreen: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        let s = model.snapshot?.settings
        let session = model.snapshot?.session
        let folders = s?.folders ?? []
        VStack(alignment: .leading, spacing: 0) {
            BlockLabel(text: L("brain.sessionBlock"))
            SettingRows {
                SettingRow(title: L("brain.model"), hint: L("brain.model.hint")) {
                    ZenSelect(value: session.map { Format.model($0.model) } ?? "—",
                              choices: (model.options?.models ?? []).map { ($0, Format.model($0)) },
                              selected: session?.model,
                              isBusy: model.applying == "brainModel") { model.set("brainModel", $0) }
                }
                .zIndex(2)
                SettingRow(title: "Claude Code", hint: L("brain.claude.hint")) {
                    ZenSelect(value: session.map { "\($0.claudeVersion) · \(Self.home($0.claudePath))" } ?? "—",
                              choices: (model.options?.claudePaths ?? []).map { ($0.path, "\($0.version) · \(Self.home($0.path))") },
                              selected: session?.claudePath, width: 320) { model.set("claudePath", $0) }
                }
                .zIndex(1)
                SettingRow(title: L("brain.whenDown"), hint: L("brain.whenDown.hint")) {
                    SettingValue(text: L("brain.whenDown.value"))
                }
            }
            .padding(.bottom, 32)

            HStack(alignment: .firstTextBaseline) {
                BlockLabel(text: L("brain.foldersBlock"))
                Spacer()
                Button(action: addFolder) { ButtonLabel(title: L("button.addFolder"), icon: "folder-plus") }
                    .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    .padding(.bottom, 10)
            }
            SettingRows {
                SettingRow(title: Self.home(s?.workingFolder ?? ""), hint: L("brain.workingFolder.hint")) {
                    SettingValue(text: L("brain.always"))
                }
                ForEach(folders, id: \.self) { folder in
                    SettingRow(title: Self.home(folder)) {
                        Button { model.set("folders", folders.filter { $0 != folder }) } label: {
                            ButtonLabel(title: L("button.remove"), icon: "x")
                        }
                        .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    }
                }
            }
            .padding(.bottom, 32)

            BlockLabel(text: L("brain.confirmBlock"))
            SettingRows {
                ForEach(model.options?.confirmActions ?? [], id: \.id) { action in
                    let isOn = s?.confirmActions.contains(action.id) ?? true
                    SettingRow(title: action.label, hint: isOn ? L("brain.confirm.on") : L("brain.confirm.off")) {
                        ZenSwitch(isOn: isOn) { on in
                            let current = s?.confirmActions ?? []
                            model.set("confirmActions", on ? current + [action.id] : current.filter { $0 != action.id })
                        }
                    }
                }
            }
            Text(L("brain.note"))
                .zenNote().padding(.top, 16).frame(maxWidth: 640, alignment: .leading)
        }
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = L("brain.addFolder.prompt")
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory())
        guard panel.runModal() == .OK else { return }
        let current = model.snapshot?.settings.folders ?? []
        let added = panel.urls.map(\.path).filter { !current.contains($0) }
        if !added.isEmpty { model.set("folders", current + added) }
    }

    static func home(_ path: String) -> String { path.replacingOccurrences(of: NSHomeDirectory(), with: "~") }
}
