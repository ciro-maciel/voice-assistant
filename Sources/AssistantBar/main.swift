// The Assistant for macOS: the letter A in the menu bar, the floating strip, and one window in
// the Cleaner frame. The voice loop itself is the bundled engine/ (Bun); the app talks to it on
// http://127.0.0.1:4780.
import AppKit
import AVFoundation
import Carbon.HIToolbox
import Combine
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let model = AssistantModel()
    private let nav = Navigation()
    private let backend = Backend()
    /// The microphone and the voice through the app, with echo cancellation (AudioIO.swift).
    private let audioLink = AudioLink()
    private let hotKeys = HotKeys()
    private let shortcuts = Shortcuts()
    private var listenItem: NSMenuItem!
    private var stopItem: NSMenuItem!
    /// The strip shows the assistant thinking or speaking: "Parar" holds its key only then.
    private var isStopNeeded = false
    private var statusItem: NSStatusItem!
    private var stateItem: NSMenuItem!
    private var muteItem: NSMenuItem!
    private var window: NSWindow?
    private var strip: StripController?
    private var watch: AnyCancellable?

    private enum HotKey: UInt32 { case listen = 1, stop = 2 }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // The system is light for now; the app forces it.
        NSApp.appearance = NSAppearance(named: .aqua)
        Zen.registerFonts()

        setUpMenuBar()
        strip = StripController(model: model) { [weak self] in self?.openWindow(.now) }
        strip?.onEscapeNeeded = { [weak self] needed in
            guard let self, needed != self.isStopNeeded else { return }
            self.isStopNeeded = needed
            self.registerShortcuts()
        }
        shortcuts.onChange = { [weak self] in self?.registerShortcuts() }
        registerShortcuts()

        model.start()
        // Ask for the microphone before the loop opens it: macOS answers an app without the
        // permission with silence, not an error.
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { self.backend.start(); self.audioLink.start() }
            }
        default:
            backend.start()
            audioLink.start()
        }
    }

    /// Quitting never waits on the main thread: the loop stops in the background (at most two
    /// seconds) and only then the app answers "terminate".
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        backend.note("saindo: pedido de saída recebido")
        audioLink.restoreDefaultInput()
        backend.stop(within: 2) {
            self.backend.note("saindo: pronto")
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: - Menu bar

    private func setUpMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let url = Bundle.main.url(forResource: "menubar", withExtension: "pdf", subdirectory: "Icons"),
           let glyph = NSImage(contentsOf: url) {
            glyph.isTemplate = true
            glyph.size = NSSize(width: 18, height: 18)
            statusItem.button?.image = glyph
        } else {
            statusItem.button?.title = "A"
        }
        statusItem.button?.toolTip = "Assistant"

        let menu = NSMenu()
        menu.delegate = self
        stateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)
        menu.addItem(.separator())
        listenItem = item("Ouvir agora", #selector(listen))
        menu.addItem(listenItem)
        stopItem = item("Parar", #selector(stop))
        menu.addItem(stopItem)
        muteItem = item("Silenciar o microfone", #selector(toggleMute))
        menu.addItem(muteItem)
        menu.addItem(.separator())
        menu.addItem(item("Abrir o Assistant…", #selector(openFromMenu), key: "o"))
        menu.addItem(.separator())
        menu.addItem(item("Sair", #selector(quit), key: "q"))
        statusItem.menu = menu

        watch = model.$snapshot.receive(on: RunLoop.main).sink { [weak self] _ in self?.updateMenu() }
        updateMenu()
    }

    func menuWillOpen(_ menu: NSMenu) { model.refresh(); updateMenu() }

    private func updateMenu() {
        let device = model.snapshot.map { " · " + $0.device } ?? ""
        stateItem.title = model.state.word + device
        muteItem.title = model.snapshot?.isMuted == true ? "Reativar o microfone" : "Silenciar o microfone"
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: key)
        menuItem.target = self
        return menuItem
    }

    /// (Re)registers both global shortcuts from what was recorded in Escuta, and shows them in
    /// the menu. Off while a recorder listens.
    private func registerShortcuts() {
        hotKeys.unregister(id: HotKey.listen.rawValue)
        hotKeys.unregister(id: HotKey.stop.rawValue)
        model.hotKeyProblem = nil
        if !shortcuts.isPaused, let s = shortcuts.listen {
            if !hotKeys.register(id: HotKey.listen.rawValue, keyCode: Int(s.keyCode), modifiers: Int(s.carbonModifiers), action: { [weak self] in self?.model.listen() }) {
                model.hotKeyProblem = "\(s.text) já está em uso por outro app"
            }
        }
        if !shortcuts.isPaused, isStopNeeded, let s = shortcuts.stop {
            hotKeys.register(id: HotKey.stop.rawValue, keyCode: Int(s.keyCode), modifiers: Int(s.carbonModifiers)) { [weak self] in self?.model.stop() }
        }
        for (menuItem, s) in [(listenItem, shortcuts.listen), (stopItem, shortcuts.stop)] {
            menuItem?.keyEquivalent = s?.menuKey ?? ""
            menuItem?.keyEquivalentModifierMask = s?.modifiers ?? []
        }
    }

    @objc private func listen() { model.listen() }
    @objc private func stop() { model.stop() }
    @objc private func toggleMute() { model.toggleMute() }
    @objc private func openFromMenu() { openWindow(nil) }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Window

    private func openWindow(_ pane: Pane?) {
        if let pane { nav.pane = pane }
        if window == nil {
            window = MacShell.window(title: "Assistant", size: CGSize(width: 1120, height: 760),
                                     minSize: CGSize(width: 960, height: 640), autosave: "AssistantWindow",
                                     root: AppView(model: model, nav: nav, shortcuts: shortcuts))
            window?.appearance = NSAppearance(named: .aqua)
        }
        model.loadHistory()
        model.loadOptions()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWindow(nil)
        return true
    }
}

// Top-level code runs on the main thread; say so, since AppDelegate is main-actor isolated.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
