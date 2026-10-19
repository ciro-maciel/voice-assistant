// Echo cancellation: the microphone and the assistant's voice go through ONE AVAudioEngine with
// voice processing on, so macOS takes what the engine plays out of what the microphone hears
// (as FaceTime does). The loop (assistant/src/audio-bridge.ts) gets the clean microphone over
// a local WebSocket and sends the voice back here to be played.
// Literature: the ICASSP AEC Challenges (Microsoft) and "Implicit Acoustic Echo Cancellation
// for Keyword Spotting and Device-Directed Speech Detection" (arXiv 2111.10639).
import AVFoundation
import CoreAudio
import Foundation

/// The engine: records the chosen microphone as 16 kHz mono Int16 and plays lines.
final class AudioIO {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// The format lines are converted to before playing; the mixer takes it from there.
    private let playFormat = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private var pendingIds = Set<Int>()
    private let lock = NSLock()
    private var wantedDevice: String?
    private var configObserver: NSObjectProtocol?
    private var originalDefaultInput: AudioDeviceID?

    /// Gives the system its default input back (the app changed it to the chosen microphone).
    func restoreDefaultInput() {
        guard let original = originalDefaultInput else { return }
        Self.setDefaultInput(original)
        originalDefaultInput = nil
    }
    /// Off: use the system's default input as voice processing picks it (no device forcing).
    var selectsDevice = true

    /// 16 kHz mono Int16 little-endian, ~20 ms at a time, from the audio thread.
    var onPCM: (Data) -> Void = { _ in }
    /// A line finished playing (or was stopped).
    var onPlayed: (Int) -> Void = { _ in }
    /// What happened, for the log: the device opened, or why it could not.
    var onNote: (String) -> Void = { _ in }
    /// The engine is (re)started on this microphone.
    var onConfigured: (String) -> Void = { _ in }
    private(set) var deviceName = L("device.systemDefault")

    func start(device: String?) {
        wantedDevice = device
        startWithRetry()
        // A device plugged or unplugged reconfigures the engine: set it up again.
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.onNote("áudio: dispositivos mudaram; reabrindo")
            if !self.isShutDown { try? self.configure() }
        }
    }

    /// Another program holding the microphone makes voice processing fail to start: retry
    /// every 2 s instead of giving up (it frees up when the loop's sox stops).
    private var retryCount = 0
    private func startWithRetry() {
        guard !isShutDown else { return }
        do {
            try configure()
            retryCount = 0
        } catch {
            retryCount += 1
            if retryCount == 1 || retryCount % 15 == 0 {
                onNote("áudio: não consegui abrir o microfone com cancelamento de eco (\(error)); tentando de novo")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.startWithRetry() }
        }
    }

    /// The Escuta switch off: let go of the microphone and give the default input back.
    func shutdown() {
        isShutDown = true
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        restoreDefaultInput()
        onNote("áudio: cancelamento de eco desligado na tela Escuta")
    }
    private var isShutDown = false

    func resume() {
        guard isShutDown else { return }
        isShutDown = false
        startWithRetry()
    }

    func use(device: String?) {
        wantedDevice = device
        try? configure()
    }

    private func configure() throws {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        if engine.attachedNodes.contains(player) { engine.detach(player) }

        // Voice processing records the system's DEFAULT input: choosing a device on the node is
        // accepted and ignored (it kept a laptop's lid-closed microphone and sent pure
        // silence, measured on 12/10/2026). So the chosen microphone becomes the default while
        // the app runs, and the original comes back when it quits (restoreDefaultInput).
        let input = engine.inputNode
        if selectsDevice, let wanted = Self.pickInput(wanted: wantedDevice), let id = Self.deviceID(named: wanted),
           id != Self.defaultInputID() {
            if originalDefaultInput == nil { originalDefaultInput = Self.defaultInputID() }
            Self.setDefaultInput(id)
            onNote("áudio: entrada padrão do macOS agora é \(wanted) (volta à anterior quando o app fecha)")
            if input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(false) }
        }
        // The output side must exist before voice processing is turned on; otherwise the engine
        // fails to initialize with -10875 (measured on macOS 27 with an external display's microphone).
        _ = engine.mainMixerNode
        _ = engine.outputNode
        if !input.isVoiceProcessingEnabled { try input.setVoiceProcessingEnabled(true) }
        if #available(macOS 14.0, *) {
            // Don't turn every other app down while the assistant listens.
            input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
        }
        deviceName = Self.defaultInputName() ?? L("device.systemDefault")

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playFormat)

        let format = input.outputFormat(forBus: 0)
        let resampler = Resampler(from: format.sampleRate, to: 16_000)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            // Channel 0 only: with voice processing the input can report several channels.
            guard let self, let samples = buffer.floatChannelData?[0] else { return }
            let pcm = resampler.process(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)))
            if !pcm.isEmpty { self.onPCM(pcm) }
        }
        engine.prepare()
        try engine.start()
        onNote("áudio: microfone \(deviceName) com cancelamento de eco")
        onConfigured(deviceName)
    }

    /// Plays one line (mp3 or aiff bytes). onPlayed(id) fires when it has been heard.
    func play(id: Int, data: Data, ext: String) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("assistant-line-\(id).\(ext)")
        do {
            try data.write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            let file = try AVAudioFile(forReading: url)
            guard let source = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { throw CocoaError(.fileReadCorruptFile) }
            try file.read(into: source)
            let buffer = try convert(source)
            lock.lock(); pendingIds.insert(id); lock.unlock()
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in self?.finish(id) }
            if !player.isPlaying { player.play() }
        } catch {
            onNote("áudio: não consegui tocar a fala \(id) (\(error))")
            onPlayed(id)
        }
    }

    /// The short "I'm listening" sound, through the engine too.
    func chime() {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: "/System/Library/Sounds/Tink.aiff")) else { return }
        play(id: -1, data: data, ext: "aiff")
    }

    func stop() {
        player.stop()
        lock.lock(); let ids = pendingIds; pendingIds.removeAll(); lock.unlock()
        for id in ids where id >= 0 { onPlayed(id) }
    }

    private func finish(_ id: Int) {
        lock.lock(); let wasPending = pendingIds.remove(id) != nil; lock.unlock()
        if wasPending && id >= 0 { onPlayed(id) }
    }

    private func convert(_ source: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        guard let converter = AVAudioConverter(from: source.format, to: playFormat) else { throw CocoaError(.coderInvalidValue) }
        let ratio = playFormat.sampleRate / source.format.sampleRate
        let capacity = AVAudioFrameCount(Double(source.frameLength) * ratio) + 1024
        guard let out = AVAudioPCMBuffer(pcmFormat: playFormat, frameCapacity: capacity) else { throw CocoaError(.coderInvalidValue) }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed { status.pointee = .endOfStream; return nil }
            fed = true
            status.pointee = .haveData
            return source
        }
        if let error { throw error }
        return out
    }

    // MARK: - Devices (CoreAudio)

    private static func inputDevices() -> [(id: AudioDeviceID, name: String)] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids.compactMap { id in
            var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
            var streamSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(id, &streams, 0, nil, &streamSize) == noErr, streamSize > 0 else { return nil }
            return name(of: id).map { (id, $0) }
        }
    }

    private static func name(of id: AudioDeviceID) -> String? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr, let name else { return nil }
        return name.takeRetainedValue() as String
    }

    private static func deviceID(named wanted: String) -> AudioDeviceID? {
        inputDevices().first { $0.name == wanted }?.id
    }

    private static func defaultInputName() -> String? {
        defaultInputID().flatMap { name(of: $0) }
    }

    private static func defaultInputID() -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr else { return nil }
        return id
    }

    private static func setDefaultInput(_ id: AudioDeviceID) {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = id
        AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &device)
    }

    /// The microphone the loop asked for, if connected, else nil for the system default. The
    /// loop already resolved the preference list (inputPreference in the config).
    private static func pickInput(wanted: String?) -> String? {
        let names = inputDevices().map(\.name)
        if let wanted, names.contains(wanted) { return wanted }
        return nil
    }
}

/// Float at the device rate to 16 kHz Int16, by linear interpolation; keeps its phase across
/// buffers so there is no click at the seams.
final class Resampler {
    private let step: Double
    private var position = 0.0
    private var last: Float = 0

    init(from rate: Double, to target: Double) { step = rate / target }

    func process(_ input: UnsafeBufferPointer<Float>) -> Data {
        var out = [Int16]()
        out.reserveCapacity(Int(Double(input.count) / step) + 2)
        while position < Double(input.count) {
            let i = Int(position)
            let frac = Float(position - Double(i))
            let a = i == 0 ? last : input[i - 1]
            let b = input[min(i, input.count - 1)]
            let v = max(-1, min(1, a + (b - a) * frac))
            out.append(Int16(v * 32_767))
            position += step
        }
        position -= Double(input.count)
        if let tail = input.last { last = tail }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}

/// The local WebSocket to the voice loop: sends the clean microphone, plays what it sends back.
final class AudioLink {
    private let io = AudioIO()
    private var task: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private let url = URL(string: "ws://127.0.0.1:4780/audio")!
    private var isRunning = false

    func start() {
        guard !isRunning else { return }
        isRunning = true
        io.onNote = { line in Backend.note(line) }
        io.onPCM = { [weak self] pcm in self?.task?.send(.data(pcm)) { _ in } }
        io.onPlayed = { [weak self] id in self?.sendJSON(["type": "played", "id": id]) }
        io.onConfigured = { [weak self] name in self?.sendJSON(["type": "device", "device": name]) }
        io.start(device: nil)
        connect()
    }

    private func connect() {
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        sendJSON(["type": "hello", "device": io.deviceName])
        receive(on: task)
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, task === self.task else { return }
            switch result {
            case .failure:
                // The loop is restarting or not up yet: try again shortly.
                self.task = nil
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.connect() }
            case .success(let message):
                if case .string(let text) = message { DispatchQueue.main.async { self.handle(text) } }
                self.receive(on: task)
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["type"] as? String else { return }
        switch type {
        case "play":
            guard let id = msg["id"] as? Int, let b64 = msg["data"] as? String, let audio = Data(base64Encoded: b64) else { return }
            io.play(id: id, data: audio, ext: (msg["format"] as? String) ?? "mp3")
        case "stop":
            io.stop()
        case "enable":
            if msg["on"] as? Bool == false { io.shutdown() } else { io.resume() }
        case "chime":
            io.chime()
        case "input":
            io.use(device: msg["device"] as? String)
            sendJSON(["type": "device", "device": io.deviceName])
        default:
            break
        }
    }

    func restoreDefaultInput() { io.restoreDefaultInput() }

    private func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }
}
