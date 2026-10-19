// The window: sidebar with the name as wordmark, Conversa › Agora, Histórico and
// Ajustes › Escuta, Voz, Cérebro; the microphone in the status line; one page per item.
// Tarefas waits for phase 2 (decided on 12/10/2026: no menu item that does nothing).
import AppKit
import SwiftUI

enum Pane: String, CaseIterable, Identifiable {
    case now, history, listening, voice, brain
    var id: String { rawValue }

    var group: String { self == .now || self == .history ? "Conversa" : "Ajustes" }
    var title: String {
        switch self {
        case .now: return "Agora"
        case .history: return "Histórico"
        case .listening: return "Escuta"
        case .voice: return "Voz"
        case .brain: return "Cérebro"
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
        case .now: return "A conversa em curso: o que ele ouviu, o que fez e o que respondeu. Escreva embaixo quando não der para falar."
        case .history: return "Cada conversa, com o que foi pedido, quantas respostas teve e quanto custou."
        case .listening: return "O nome que o chama, o microfone que ele usa e quanto tempo ele espera por uma resposta."
        case .voice: return "A voz que responde, a velocidade e o que acontece quando a Fish não responde."
        case .brain: return "A sessão do Claude Code por trás da voz: modelo, pastas que ela alcança e o que pede confirmação."
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
                ForEach(["Conversa", "Ajustes"], id: \.self) { group in
                    MacSidebarGroup(title: group) {
                        ForEach(Pane.allCases.filter { $0.group == group }) { p in
                            MacSidebarItem(icon: p.icon, title: p.title,
                                           badge: p == .history && !model.history.isEmpty ? "\(model.history.count)" : nil,
                                           active: nav.pane == p) { nav.pane = p }
                        }
                    }
                }
            } status: {
                MacStatusLine(on: model.isMicOn, onText: "Microfone ligado", offText: "Microfone desligado") {
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
            Button { model.newConversation() } label: { ButtonLabel(title: "Conversa nova", icon: "message-plus") }
                .buttonStyle(ZenButtonStyle(kind: .secondary))
            Button { model.stop() } label: { ButtonLabel(title: "Parar", icon: "player-stop") }
                .buttonStyle(ZenButtonStyle(kind: .secondary))
            Button { model.listen() } label: { ButtonLabel(title: "Ouvir agora", icon: "microphone", color: .white) }
                .buttonStyle(ZenButtonStyle())
        case .voice:
            Button { model.sample() } label: { ButtonLabel(title: "Ouvir amostra", icon: "player-play", color: .white) }
                .buttonStyle(ZenButtonStyle())
        case .brain:
            Button { NSWorkspace.shared.open(logURL) } label: { ButtonLabel(title: "Abrir log", icon: "file-text") }
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
                Cell(label: "Estado", note: stateNote) {
                    StateGlyph(state: model.state, level: level)
                    Text(model.state.word).zenDisplay(22).lineLimit(1).minimumScaleFactor(0.7)
                }
                Cell(label: "Microfone", note: micNote) {
                    Text(model.snapshot.map { Format.device($0.device) } ?? "—").zenDisplay(22).lineLimit(2)
                }
                Cell(label: "Sessão", note: sessionNote) {
                    Text(model.snapshot.map { Format.model($0.session.model) } ?? "—").zenDisplay(22)
                }
                Cell(label: "Nesta conversa", note: costNote, isLast: true) {
                    Text(Format.usd(model.snapshot?.conversation.costUsd ?? 0)).zenDisplay(22)
                }
            }
            .padding(.bottom, 28)

            if let t = model.snapshot?.timings {
                BlockLabel(text: "Última resposta")
                CellRow {
                    Cell(label: "Transcrição", note: t.isSpoken ? "do fim da sua fala ao texto, no Whisper" : "escrita, sem transcrição") {
                        Text(t.transcribeMs.map(Format.seconds) ?? "—").zenDisplay(22)
                    }
                    Cell(label: "Modelo", note: "da pergunta à primeira palavra do Claude") {
                        Text(Format.seconds(t.modelMs)).zenDisplay(22)
                    }
                    Cell(label: "Voz", note: "da primeira frase pronta ao som, na Fish") {
                        Text(Format.seconds(t.voiceMs)).zenDisplay(22)
                    }
                    Cell(label: "Até ouvir", note: t.isSpoken ? "do fim da fala ao primeiro som; não conta os 0,75 s de silêncio que fecham a fala" : "do envio ao primeiro som", isLast: true) {
                        Text(Format.seconds(t.totalMs)).zenDisplay(22)
                    }
                }
                .padding(.bottom, 28)
            }

            BlockLabel(text: "Conversa")
            let rows = model.snapshot?.conversation.rows ?? []
            if rows.isEmpty {
                Rows {
                    Text("Nenhuma conversa ainda. Diga \u{201C}\(model.snapshot?.settings.wakeWords.dropFirst().first ?? "assistente")\u{201D} ou aperte ⌥ Espaço."
                         + ((model.snapshot?.memory?.journalDays ?? 0) > 0 ? " Ele lembra o resumo das conversas recentes." : ""))
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
                TextField("Escreva em vez de falar", text: $draft)
                    .textFieldStyle(.plain)
                    .font(Zen.font(15, .medium))
                    .foregroundStyle(Zen.gray9)
                    .frame(height: 44)
                    .overlay(alignment: .bottom) { Rectangle().fill(Zen.gray3).frame(height: 1) }
                    .onSubmit(send)
                Button(action: send) { Text("Enviar") }
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
        case .thinking, .speaking: return "diga o nome para interromper"
        case .muted: return model.snapshot?.isMuted == true ? "silenciado no menu da barra" : "o clique no rodapé abre os Ajustes"
        case .offline: return "o processo de voz não respondeu"
        case .waiting: return "diga o nome ou aperte ⌥ Espaço"
        case .drafting: return "diga \u{201C}\(model.snapshot?.settings.actionPhrases?.first ?? "pode fazer")\u{201D} para executar"
        default: return "fale sem precisar do nome"
        }
    }

    private var micNote: String {
        guard model.snapshot != nil else { return "" }
        return "o primeiro conectado da lista em Escuta"
    }

    private var sessionNote: String {
        guard let s = model.snapshot?.session else { return "" }
        guard s.startedAt > 0 else { return "Claude Code \(s.claudeVersion), reabrindo" }
        return "Claude Code \(s.claudeVersion), \(Format.since(s.startedAt, now: model.now))"
    }

    private var costNote: String {
        let n = model.snapshot?.conversation.answers ?? 0
        return "diferença do custo acumulado que a sessão informa, em \(n) \(n == 1 ? "resposta" : "respostas")"
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
        case "user": return "Você"
        case "tool": return "Ferramenta"
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
        if row.role == "tool" { return row.durationMs.map(Format.seconds) ?? "em curso" }
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
                BlockLabel(text: "Rascunho")
                Spacer()
                HStack(spacing: 8) {
                    Button { model.clearDraft() } label: { ButtonLabel(title: "Limpar", icon: "x") }
                        .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    Button { model.act() } label: { ButtonLabel(title: "Executar", icon: "player-play") }
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
            Text("Diga \u{201C}\(model.snapshot?.settings.actionPhrases?.first ?? "pode fazer")\u{201D} e o Claude monta o pedido a partir destes trechos.")
                .zenNote().padding(.top, 10)
        }
        }
    }
}

/// "O que ouvi" on Agora: the last things heard in two minutes, and what was done with each.
struct HeardBlock: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
        // What was heard in the last two minutes: a request that went nowhere shows its reason.
        let heard = (model.snapshot?.heard ?? []).filter { model.now.timeIntervalSince1970 * 1000 - $0.at < 120_000 }.prefix(4)
        if !heard.isEmpty {
            BlockLabel(text: "O que ouvi").padding(.top, 28)
            Rows {
                ForEach(Array(heard.enumerated()), id: \.element.id) { i, h in
                    if i > 0 { RowRule() }
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        Text(h.action).zenLabel(10, color: h.action == "aceito" ? Zen.gray5 : Zen.gray9).frame(width: 110, alignment: .leading)
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
            BlockLabel(text: "Conversas")
            Rows {
                if model.history.isEmpty {
                    Text("Nenhuma conversa guardada ainda.").zenBody(13).padding(16).frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(Array(model.history.enumerated()), id: \.element.id) { i, c in
                    if i > 0 { RowRule() }
                    DataRow(label: Format.day(c.startedAt), value: c.firstQuestion,
                            detail: "\(c.answers) \(c.answers == 1 ? "resposta" : "respostas") · \(Format.usd(c.costUsd))", labelWidth: 120)
                }
            }
            Text("Uma conversa termina depois de dez minutos sem nada dito. O custo de cada resposta é a diferença do total que a sessão do Claude Code informa.")
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
            BlockLabel(text: "Microfone e transcrição")
            SettingRows {
                SettingRow(title: "Cancelamento de eco", hint: model.snapshot?.isEchoCancelled == true
                           ? "Ligado: o app grava e toca, e o macOS tira a voz dele do microfone."
                           : "Desligado: grava com o sox e toca com o ffplay; o eco só é reconhecido pelas palavras.") {
                    ZenSwitch(isOn: s?.isEchoCancelOn ?? true) { model.set("isEchoCancelOn", $0) }
                }
                SettingRow(title: "Microfone", hint: "O medidor segue a sua voz.") {
                    MicMeter(level: model.inLevel)
                    ZenSelect(value: model.snapshot.map { Format.device($0.device) } ?? "—",
                              choices: (model.options?.inputs ?? []).map { ($0, Format.device($0)) },
                              selected: model.snapshot?.device,
                              isBusy: model.applying == "inputDevice") { model.set("inputDevice", $0) }
                }
                .zIndex(2)
                SettingRow(title: "Transcrição", hint: "Whisper no Mac: o maior entende melhor e demora mais.") {
                    ZenSelect(value: s?.whisperModel ?? "—",
                              choices: (model.options?.whisperModels ?? []).map { ($0, $0) },
                              selected: s?.whisperModel,
                              isBusy: model.applying == "whisperModel") { model.set("whisperModel", $0) }
                }
                .zIndex(1)
            }
            .padding(.bottom, 32)

            BlockLabel(text: "Como chamar")
            SettingRows {
                SettingRow(title: "Entender sem o nome", hint: "Um modelo rápido lê cada frase sem o nome e decide se é para ele. Se for, executa; se não, vai para o rascunho.") {
                    ZenSwitch(isOn: s?.isDirectedOn ?? true) { model.set("isDirectedOn", $0) }
                }
                SettingRow(title: "Ouvir tudo", hint: "O que você diz sem o nome vai para um rascunho, e o comando de ação manda executar.") {
                    ZenSwitch(isOn: s?.isDraftOn ?? true) { model.set("isDraftOn", $0) }
                }
                SettingRow(title: "Comando de ação", hint: "Separe por vírgula. Qualquer um deles manda o rascunho para o Claude montar e executar. Enter salva.") {
                    ZenTextField(placeholder: "pode fazer", value: s?.actionPhrases?.joined(separator: ", ") ?? "pode fazer", width: 240) { text in
                        model.set("actionPhrases", text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                    }
                }
                SettingRow(title: "Rascunho guarda", hint: "Trechos mais antigos que isso saem do rascunho.") {
                    ZenSelect(value: s.map { "\(Int(($0.draftMaxAgeMs ?? 600_000) / 60_000)) min" } ?? "—",
                              choices: [5, 10, 20, 30, 60].map { (String($0 * 60_000), "\($0) min") },
                              selected: s.map { String(Int($0.draftMaxAgeMs ?? 600_000)) }, width: 160) { model.set("draftMaxAgeMs", Int($0) ?? 600_000) }
                }
                .zIndex(5)
                SettingRow(title: "Nome", hint: "Separe por vírgula. O primeiro é o nome; os outros, como o Whisper escreve errado. Enter salva.") {
                    ZenTextField(placeholder: "assistant, assistente", value: s?.wakeWords.joined(separator: ", ") ?? "", width: 320) { text in
                        model.set("wakeWords", text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                    }
                }
                SettingRow(title: "Ouvir agora", hint: model.hotKeyProblem ?? "Faz o mesmo que dizer o nome, de qualquer app.") {
                    KeyRecorder(shortcut: shortcuts.listen, shortcuts: shortcuts) { shortcuts.listen = $0 }
                }
                SettingRow(title: "Parar", hint: "Vale enquanto ele pensa ou fala; fora disso a tecla fica livre para os outros apps.") {
                    KeyRecorder(shortcut: shortcuts.stop, allowsKeyAlone: true, shortcuts: shortcuts) { shortcuts.stop = $0 }
                }
            }
            .padding(.bottom, 32)

            BlockLabel(text: "Tempos da conversa")
            SettingRows {
                SettingRow(title: "Pausa que encerra a frase", hint: "Num comando longo, as pausas para pensar ficam abaixo deste tempo. Pedaços que chegam logo depois são juntados ao pedido.") {
                    ZenSelect(value: s.map { Format.seconds($0.endSilenceMs ?? 1_200) } ?? "—",
                              choices: secondsChoices([0.8, 1.2, 1.6, 2, 2.5]),
                              selected: s.map { String(Int($0.endSilenceMs ?? 1_200)) }, width: 160) { model.set("endSilenceMs", Int($0) ?? 1_200) }
                }
                .zIndex(4)
                SettingRow(title: "Depois de responder", hint: "Quanto tempo ele aceita a sua resposta sem o nome.") {
                    ZenSelect(value: s.map { Format.seconds($0.followUpMs) } ?? "—",
                              choices: secondsChoices([15, 30, 45, 60, 90, 120]),
                              selected: s.map { String(Int($0.followUpMs)) }, width: 160) { model.set("followUpMs", Int($0) ?? 15_000) }
                }
                .zIndex(3)
                SettingRow(title: "Depois do nome sozinho", hint: "Quanto tempo ele espera a frase.") {
                    ZenSelect(value: s.map { Format.seconds($0.summonMs) } ?? "—",
                              choices: secondsChoices([4, 6, 8, 10, 15, 20]),
                              selected: s.map { String(Int($0.summonMs)) }, width: 160) { model.set("summonMs", Int($0) ?? 8_000) }
                }
                .zIndex(2)
                SettingRow(title: "Margem contra eco", hint: "Fala que começa colada à voz dele é ignorada. Com fone, pode ser menor.") {
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
                SettingRow(title: "Voz", hint: "O id da voz na biblioteca da Fish. Enter salva.") {
                    ZenTextField(placeholder: "id da voz", value: s?.voiceId ?? "", width: 320) { model.set("voiceId", $0) }
                }
                SettingRow(title: "Nome da voz", hint: "Como ela aparece aqui e como o assistente se refere a ela.") {
                    ZenTextField(placeholder: "nome da voz", value: s?.voiceName ?? "", width: 240) { model.set("voiceName", $0) }
                }
                SettingRow(title: "Velocidade") {
                    ZenSelect(value: s.map { Self.speed($0.voiceSpeed) } ?? "—",
                              choices: speeds.map { (String($0), Self.speed($0)) },
                              selected: s.map { String($0.voiceSpeed) }, width: 160) { model.set("voiceSpeed", Double($0) ?? 1.5) }
                }
                .zIndex(2)
                SettingRow(title: "Modelo", hint: "O s2.1-pro-free vale até 30/11/2026.") {
                    ZenSelect(value: s?.fishModel ?? "—",
                              choices: (model.options?.fishModels ?? []).map { ($0, $0) },
                              selected: s?.fishModel, width: 200) { model.set("fishModel", $0) }
                }
                .zIndex(1)
            }
            .padding(.bottom, 32)

            BlockLabel(text: "Sem rede")
            SettingRows {
                SettingRow(title: "Voz do Mac", hint: "Entra sozinha quando a Fish não responde.") {
                    ZenSelect(value: s?.fallbackVoice ?? "—",
                              choices: (model.options?.macVoices ?? []).map { ($0, $0) },
                              selected: s?.fallbackVoice, width: 200) { model.set("fallbackVoice", $0) }
                }
            }
        }
    }

    static func speed(_ value: Double) -> String {
        // 1,0× · 1,25× · 1,5×: no trailing zero after the first decimal.
        var text = String(format: "%.2f", value)
        if text.hasSuffix("0") { text.removeLast() }
        return text.replacingOccurrences(of: ".", with: ",") + "×"
    }
}

struct BrainScreen: View {
    @ObservedObject var model: AssistantModel

    var body: some View {
        let s = model.snapshot?.settings
        let session = model.snapshot?.session
        let folders = s?.folders ?? []
        VStack(alignment: .leading, spacing: 0) {
            BlockLabel(text: "Sessão")
            SettingRows {
                SettingRow(title: "Modelo", hint: "Haiku responde mais rápido; Opus pensa mais. A conversa continua na troca.") {
                    ZenSelect(value: session.map { Format.model($0.model) } ?? "—",
                              choices: (model.options?.models ?? []).map { ($0, Format.model($0)) },
                              selected: session?.model,
                              isBusy: model.applying == "brainModel") { model.set("brainModel", $0) }
                }
                .zIndex(2)
                SettingRow(title: "Claude Code", hint: "As instalações encontradas neste Mac.") {
                    ZenSelect(value: session.map { "\($0.claudeVersion) · \(Self.home($0.claudePath))" } ?? "—",
                              choices: (model.options?.claudePaths ?? []).map { ($0.path, "\($0.version) · \(Self.home($0.path))") },
                              selected: session?.claudePath, width: 320) { model.set("claudePath", $0) }
                }
                .zIndex(1)
                SettingRow(title: "Quando cai", hint: "Para na quinta falha seguida e avisa.") {
                    SettingValue(text: "Reabre com espera crescente")
                }
            }
            .padding(.bottom, 32)

            HStack(alignment: .firstTextBaseline) {
                BlockLabel(text: "Pastas que ele lê")
                Spacer()
                Button(action: addFolder) { ButtonLabel(title: "Adicionar pasta", icon: "folder-plus") }
                    .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    .padding(.bottom, 10)
            }
            SettingRows {
                SettingRow(title: Self.home(s?.workingFolder ?? ""), hint: "A pasta de trabalho: sempre aberta, com as regras do CLAUDE.md dela.") {
                    SettingValue(text: "Sempre")
                }
                ForEach(folders, id: \.self) { folder in
                    SettingRow(title: Self.home(folder)) {
                        Button { model.set("folders", folders.filter { $0 != folder }) } label: {
                            ButtonLabel(title: "Remover", icon: "x")
                        }
                        .buttonStyle(ZenButtonStyle(kind: .secondary, height: 30))
                    }
                }
            }
            .padding(.bottom, 32)

            BlockLabel(text: "Pergunta antes de")
            SettingRows {
                ForEach(model.options?.confirmActions ?? [], id: \.id) { action in
                    let isOn = s?.confirmActions.contains(action.id) ?? true
                    SettingRow(title: action.label, hint: isOn ? "Só depois do seu \u{201C}pode\u{201D} nesta conversa." : "Faz sem perguntar.") {
                        ZenSwitch(isOn: isOn) { on in
                            let current = s?.confirmActions ?? []
                            model.set("confirmActions", on ? current + [action.id] : current.filter { $0 != action.id })
                        }
                    }
                }
            }
            Text("Ler, pesquisar e editar arquivos locais ele sempre faz sem perguntar. Trocar pastas ou confirmações reabre a sessão, continuando a mesma conversa.")
                .zenNote().padding(.top, 16).frame(maxWidth: 640, alignment: .leading)
        }
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Adicionar"
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory())
        guard panel.runModal() == .OK else { return }
        let current = model.snapshot?.settings.folders ?? []
        let added = panel.urls.map(\.path).filter { !current.contains($0) }
        if !added.isEmpty { model.set("folders", current + added) }
    }

    static func home(_ path: String) -> String { path.replacingOccurrences(of: NSHomeDirectory(), with: "~") }
}
