// Runs the voice loop: the bundled Bun runtime on engine/src/main.ts, restarted if it dies
// and stopped on quit. Its output goes to ~/Library/Logs/voice-assistant/assistant.log.
import Foundation

let logURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/voice-assistant/assistant.log")

// launchd gives a GUI app a minimal PATH; the loop finds sox, whisper-server and ffplay by path,
// and claude by full path too (engine/src/config.ts), but keep the user installs first anyway.
let toolPath = [
    "\(NSHomeDirectory())/.local/bin",
    "\(NSHomeDirectory())/.npm-global/bin",  // before /usr/local/bin, which may hold an old claude
    "\(NSHomeDirectory())/.bun/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin", "/bin", "/usr/sbin", "/sbin",
].joined(separator: ":")

final class Backend {
    private var process: Process?
    private var isQuitting = false
    private(set) var problem: String?

    func start() {
        guard let resources = Bundle.main.resourceURL else { return }
        let bun = resources.appendingPathComponent("bun")
        let dir = resources.appendingPathComponent("engine")
        guard FileManager.default.isExecutableFile(atPath: bun.path) else {
            problem = "Pacote incompleto: falta o Bun"
            return
        }

        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        // Append mode: the loop's output and the app's own notes (Backend.note) share this file;
        // with a plain write handle, each overwrote the other's lines.
        let fd = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else { return }
        let log = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        log.write(Data("\n--- \(Date()) iniciando ---\n".utf8))

        let p = Process()
        p.executableURL = bun
        p.arguments = ["src/main.ts"]
        p.currentDirectoryURL = dir
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = toolPath
        // The app records and plays (AudioIO, echo cancelled): the loop must not open sox.
        environment["ASSISTANT_APP_AUDIO"] = "1"
        p.environment = environment
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.exited() }
        }
        do {
            try p.run()
            process = p
        } catch {
            log.write(Data("não consegui iniciar o assistente: \(error)\n".utf8))
        }
    }

    /// Stops the loop without ever blocking the app: SIGTERM runs its shutdown (microphone,
    /// Whisper and Claude Code go with it); if it is still alive after `seconds`, its children
    /// and then the loop itself get SIGKILL. `done` runs on the main queue.
    func stop(within seconds: Double = 2, done: @escaping () -> Void) {
        isQuitting = true
        guard let p = process, p.isRunning else { done(); return }
        let pid = p.processIdentifier
        note("saindo: parando o processo de voz (pid \(pid))")
        p.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(seconds)
            while p.isRunning && Date() < deadline { usleep(50_000) }
            if p.isRunning {
                self.note("saindo: o processo de voz não parou em \(seconds) s; encerrando à força")
                let pkill = Process()
                pkill.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
                pkill.arguments = ["-KILL", "-P", String(pid)]
                try? pkill.run()
                pkill.waitUntilExit()
                kill(pid, SIGKILL)
            }
            DispatchQueue.main.async(execute: done)
        }
    }

    func note(_ line: String) { Backend.note(line) }

    /// One line in ~/Library/Logs/voice-assistant/assistant.log, from anywhere in the app.
    static func note(_ line: String) {
        guard let log = try? FileHandle(forWritingTo: logURL) else { return }
        log.seekToEndOfFile()
        log.write(Data("\(line)\n".utf8))
        try? log.close()
    }

    private func exited() {
        process = nil
        guard !isQuitting else { return }
        // A pause, so a crash does not turn into a tight loop.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.start() }
    }
}
