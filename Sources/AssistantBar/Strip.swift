// The floating strip: the gray.9 band of Speech to Text and Text to Speech, centered at the
// bottom of the screen, over whatever app is in front. It shows while the assistant is called,
// hearing, thinking or speaking, and hides five seconds after it goes back to waiting.
// Clicking it opens the window on Agora. Outside the main window, so no sidebar.
import AppKit
import Combine
import SwiftUI

struct StripView: View {
    @ObservedObject var model: AssistantModel
    var open: () -> Void

    var body: some View {
        // The Speech to Text overlay's measures: 40 tall, 14 at the sides, 12 between, label 10/800, text 12/500.
        HStack(spacing: 12) {
            StateGlyph(state: model.state, level: model.state == .speaking ? model.outLevel : model.inLevel, isInverted: true, isCompact: true)
            Text(model.state.word)
                .font(Zen.font(10, .extraBold)).tracking(1.5).textCase(.uppercase)
                .foregroundStyle(Zen.gray0).lineLimit(1).fixedSize()
            Text(line).font(Zen.font(12, .medium)).foregroundStyle(Zen.gray3).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if model.state == .thinking || model.state == .speaking {
                Text("Esc").font(Zen.font(10, .extraBold)).tracking(1.5).textCase(.uppercase).foregroundStyle(Zen.gray5)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(Rectangle().strokeBorder(Zen.gray7, lineWidth: 1))
            }
        }
        .padding(.horizontal, 14)
        .frame(width: StripController.size.width, height: StripController.size.height)
        .background(Zen.gray9)
        .contentShape(Rectangle())
        .onTapGesture(perform: open)
    }

    /// What goes beside the state: what it is about to do, what it heard, what it is saying.
    private var line: String {
        let rows = model.snapshot?.conversation.rows ?? []
        switch model.state {
        case .listening: return "Diga o que precisa"
        case .drafting:
            let n = model.snapshot?.draft?.count ?? 0
            let phrase = model.snapshot?.settings.actionPhrases?.first ?? "pode fazer"
            return "\(n) \(n == 1 ? "trecho anotado" : "trechos anotados") · diga \u{201C}\(phrase)\u{201D}"
        case .hearing: return "…"
        case .thinking:
            if let last = rows.last, last.role == "tool" { return last.text }
            return rows.last(where: { $0.role == "user" })?.text ?? ""
        case .speaking: return model.spokenLine
        case .muted: return model.snapshot?.isMuted == true ? "Microfone silenciado no menu" : "Falta ligar o Microfone para o Assistant"
        default: return ""
        }
    }
}

@MainActor
final class StripController {
    static let size = CGSize(width: 440, height: 40)
    private let panel: NSPanel
    private var hideWork: DispatchWorkItem?
    private var watch: AnyCancellable?
    var onEscapeNeeded: (Bool) -> Void = { _ in }

    init(model: AssistantModel, open: @escaping () -> Void) {
        panel = NSPanel(contentRect: NSRect(origin: .zero, size: Self.size),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.hasShadow = false
        panel.isOpaque = true
        panel.backgroundColor = NSColor(Zen.gray9)
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .aqua)
        panel.contentView = NSHostingView(rootView: StripView(model: model, open: open))

        watch = model.$snapshot.combineLatest(model.$isMicAuthorized)
            .receive(on: RunLoop.main)
            .sink { [weak self, weak model] _ in
                guard let self, let model else { return }
                self.update(model)
            }
    }

    private func update(_ model: AssistantModel) {
        let state = model.state
        // Muted by choice is not news; a microphone that went silent is.
        let isWanted: Bool
        switch state {
        case .listening, .hearing, .drafting, .thinking, .speaking: isWanted = true
        case .muted: isWanted = model.snapshot?.isMuted == false
        default: isWanted = false
        }
        onEscapeNeeded(isWanted && (state == .thinking || state == .speaking))
        if isWanted {
            hideWork?.cancel()
            hideWork = nil
            show()
        } else if panel.isVisible, hideWork == nil {
            let work = DispatchWorkItem { [weak self] in
                self?.panel.orderOut(nil)
                self?.hideWork = nil
            }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: work)
        }
    }

    private func show() {
        guard !panel.isVisible else { return }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            panel.setFrameOrigin(NSPoint(x: visible.midX - Self.size.width / 2, y: visible.minY + 48))
        }
        panel.orderFrontRegardless()
    }
}
