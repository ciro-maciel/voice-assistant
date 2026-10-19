// The ear: captures the microphone with sox, cuts it into utterances by energy, and
// transcribes each one with a local whisper-server that keeps the model loaded.
import { EventEmitter } from "node:events";
import { INPUT_PREFERENCE, SAMPLE_RATE, tool, WHISPER_LANGUAGE, WHISPER_MODEL, WHISPER_PORT } from "./config";
import { DEFAULTS, whisperModelPath, whisperPrompt } from "./settings";
import { isNoise } from "./wake";
import { audioBridge } from "./audio-bridge";

const FRAME = 480;                 // 30 ms at 16 kHz
const FRAME_MS = 30;
const START_FRAMES = 3;            // 90 ms above the threshold opens an utterance
export const END_SILENCE_MS = 1_200; // this much quiet closes it (a pause to think fits under it)
const PRE_ROLL_FRAMES = 10;        // keep 300 ms before the start, so the first syllable survives
const MIN_UTTERANCE_MS = 400;
const MAX_UTTERANCE_MS = 60_000;   // a long, complex command fits in one piece
const MIN_RMS = 0.004;             // absolute floor, below this is never speech
const DEAD_RMS = 0.0001;           // a real room never gets this quiet: the mic is blocked or off
const DEAD_AFTER_MS = 4000;

export type Utterance = { text: string; startedAt: number; endedAt: number };

export class Ear extends EventEmitter {
  isMuted = false;
  private recorder?: ReturnType<typeof Bun.spawn>;
  private whisper?: ReturnType<typeof Bun.spawn>;
  private noiseFloor = 0.005;
  private aboveCount = 0;
  private silentMs = 0;
  private preRoll: Int16Array[] = [];
  private current: Int16Array[] | null = null;
  private currentStartedAt = 0;
  private leftover = new Uint8Array(0);
  private lastLevelAt = 0;
  private peakSince = { at: Date.now(), rms: 0 };
  isDead = false;
  device = "padrão do sistema";
  whisperModel = WHISPER_MODEL;
  whisperPrompt = whisperPrompt(DEFAULTS);
  /// Live: the app's Escuta screen sets how long a pause closes a sentence.
  endSilenceMs = END_SILENCE_MS;
  // Bumped on every recorder swap, so the old stream ending is not reported as a dead microphone.
  private recorderGeneration = 0;
  /// The app is feeding the microphone (echo cancelled); sox is off meanwhile.
  isEchoCancelled = false;
  private wantedDevice?: string;

  async start(options: { device?: string; whisperModel?: string } = {}) {
    if (options.whisperModel) this.whisperModel = options.whisperModel;
    this.wantedDevice = options.device;
    await this.startWhisper();
    // The app's microphone, with my voice already cancelled, wins over sox whenever it is there.
    audioBridge.on("connected", () => { if (audioBridge.isEnabled) this.useBridge(); });
    audioBridge.on("disconnected", () => {
      if (!this.isEchoCancelled) return;
      this.isEchoCancelled = false;
      this.emit("echoCancel", false);
      this.startRecorder(this.wantedDevice);
    });
    audioBridge.on("device", (name: string) => { if (this.isEchoCancelled) this.device = name; });
    audioBridge.on("pcm", (bytes: Uint8Array) => { if (this.isEchoCancelled) this.feed(bytes); });
    if (audioBridge.isActive) return this.useBridge();
    // Started by the Mac app: its microphone is coming. Opening sox meanwhile would take the
    // device and make voice processing fail to start (-10875, measured on 12/10/2026).
    if (process.env.ASSISTANT_APP_AUDIO) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        audioBridge.once("connected", () => { clearTimeout(timer); resolve(); });
      });
      if (audioBridge.isActive) return;
      if (audioBridge.isEnabled) console.log("o app não mandou o microfone em 10 s; usando o sox");
    }
    this.startRecorder(options.device);
  }

  /// The Escuta switch. On: the app records with echo cancellation. Off: back to sox (after the
  /// app lets go of the microphone; both at once make voice processing fail).
  setEchoCancel(on: boolean) {
    audioBridge.enable(on);
    if (on && audioBridge.isConnected) return this.useBridge();
    if (!on && this.isEchoCancelled) {
      this.isEchoCancelled = false;
      this.emit("echoCancel", false);
      setTimeout(() => { if (!this.isEchoCancelled) this.startRecorder(this.wantedDevice); }, 800);
    }
  }

  private useBridge() {
    this.recorderGeneration++; // the sox stream ending now is not a dead microphone
    this.recorder?.kill();
    this.recorder = undefined;
    this.resetCapture();
    this.isEchoCancelled = true;
    this.device = audioBridge.device ?? this.device;
    audioBridge.useInput(pickInput(this.wantedDevice));
    this.emit("echoCancel", true);
  }

  private resetCapture() {
    this.current = null;
    this.preRoll = [];
    this.leftover = new Uint8Array(0);
    this.peakSince = { at: Date.now(), rms: 0 };
  }

  stop() {
    this.recorder?.kill();
    this.whisper?.kill();
  }

  /// Switch microphones live; a name that is not connected falls back to the preference list.
  useDevice(name?: string) {
    this.wantedDevice = name;
    if (this.isEchoCancelled) {
      this.resetCapture();
      audioBridge.useInput(pickInput(name));
      return;
    }
    this.recorder?.kill();
    this.startRecorder(name);
  }

  /// Switch Whisper models live. Transcription pauses while the new model loads.
  async useWhisperModel(name: string) {
    this.whisperModel = name;
    this.whisper?.kill();
    await this.whisper?.exited;
    await this.startWhisper();
  }

  private startRecorder(wanted?: string) {
    const generation = ++this.recorderGeneration;
    const device = pickInput(wanted);
    this.device = device ?? "padrão do sistema";
    this.resetCapture();
    // sox with an explicit coreaudio device; rec when the system default is the best we have.
    const input = device ? [tool("sox"), "-q", "-t", "coreaudio", device] : [tool("rec"), "-q"];
    this.recorder = Bun.spawn(
      [...input, "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"],
      { stdout: "pipe", stderr: "ignore" },
    );
    this.read(this.recorder.stdout as ReadableStream<Uint8Array>, generation);
  }

  private async startWhisper() {
    this.whisper = Bun.spawn(
      [tool("whisper-server"), "-m", whisperModelPath(this.whisperModel), "-l", WHISPER_LANGUAGE, "--port", String(WHISPER_PORT),
        // -nc: each utterance stands alone. With the previous text as context, a long-running
        // server got stuck: "Assistente, que horas são?" came back as "assist" (12/10/2026).
        "--host", "127.0.0.1", "-nt", "-nc", "--prompt", this.whisperPrompt],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let i = 0; i < 120; i++) {
      try {
        await fetch(`http://127.0.0.1:${WHISPER_PORT}/`);
        return;
      } catch {
        await Bun.sleep(250);
      }
    }
    throw new Error("whisper-server não subiu em 30 segundos");
  }

  private async read(stream: ReadableStream<Uint8Array>, generation: number) {
    for await (const chunk of stream) {
      if (generation !== this.recorderGeneration) break;
      this.feed(chunk);
    }
    if (generation === this.recorderGeneration) this.emit("error", new Error("o microfone fechou"));
  }

  /// Raw 16 kHz mono Int16 from sox or from the app, cut into 30 ms frames.
  private feed(chunk: Uint8Array) {
    const bytes = new Uint8Array(this.leftover.length + chunk.length);
    bytes.set(this.leftover);
    bytes.set(chunk, this.leftover.length);
    const frameBytes = FRAME * 2;
    const whole = Math.floor(bytes.length / frameBytes) * frameBytes;
    for (let off = 0; off < whole; off += frameBytes) {
      this.onFrame(new Int16Array(bytes.slice(off, off + frameBytes).buffer));
    }
    this.leftover = bytes.slice(whole);
  }

  private onFrame(frame: Int16Array) {
    let sum = 0;
    for (const s of frame) sum += (s / 32768) ** 2;
    const rms = Math.sqrt(sum / frame.length);
    const threshold = Math.max(MIN_RMS, this.noiseFloor * 3);

    const now = Date.now();
    if (now - this.lastLevelAt > 100) {
      this.lastLevelAt = now;
      this.emit("level", Math.min(1, rms / 0.2));
    }
    this.watchForDeadMic(rms, now);
    if (this.isMuted) return;

    if (!this.current) {
      // Only quiet frames teach the noise floor.
      if (rms < threshold) this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.aboveCount = rms > threshold ? this.aboveCount + 1 : 0;
      if (this.aboveCount >= START_FRAMES) {
        this.current = [...this.preRoll];
        this.currentStartedAt = now - this.preRoll.length * FRAME_MS;
        this.silentMs = 0;
        this.emit("speechStart");
      }
      return;
    }

    this.current.push(frame);
    this.silentMs = rms < this.noiseFloor * 2 || rms < MIN_RMS ? this.silentMs + FRAME_MS : 0;
    const durationMs = this.current.length * FRAME_MS;
    if (this.silentMs >= this.endSilenceMs || durationMs >= MAX_UTTERANCE_MS) {
      const frames = this.current;
      const startedAt = this.currentStartedAt;
      this.current = null;
      this.preRoll = [];
      this.aboveCount = 0;
      this.emit("speechEnd");
      if (durationMs - this.silentMs >= MIN_UTTERANCE_MS) this.transcribe(frames, startedAt, now);
    }
  }

  // macOS hands silence, not an error, to an app without microphone permission.
  private watchForDeadMic(rms: number, now: number) {
    this.peakSince.rms = Math.max(this.peakSince.rms, rms);
    if (now - this.peakSince.at < DEAD_AFTER_MS) return;
    const isDead = this.peakSince.rms < DEAD_RMS;
    if (isDead !== this.isDead) this.emit(isDead ? "deadMic" : "liveMic", this.device);
    this.isDead = isDead;
    this.peakSince = { at: now, rms: 0 };
  }

  private async transcribe(frames: Int16Array[], startedAt: number, endedAt: number) {
    const pcm = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let off = 0;
    for (const f of frames) { pcm.set(f, off); off += f.length; }
    const wav = toWav(pcm);
    try {
      let text = await this.inference(wav, 0);
      // A long utterance that comes back as one word was cut by Whisper, not by the speaker:
      // try once more with some temperature, which takes it off the stuck path.
      if (isTruncated(text, pcm.length / SAMPLE_RATE * 1000)) text = await this.inference(wav, 0.4);
      if (!isNoise(text)) this.emit("utterance", { text, startedAt, endedAt } satisfies Utterance);
      // Dropped as noise: say so, or the app shows "Escutando" and then nothing, with no reason.
      else this.emit("dropped", text, Math.round((endedAt - startedAt) / 100) / 10);
    } catch (error) {
      this.emit("error", error);
    }
  }

  private async inference(wav: Uint8Array, temperature: number): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    form.append("response_format", "json");
    form.append("temperature", String(temperature));
    const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, { method: "POST", body: form });
    const { text = "" } = (await res.json()) as { text?: string };
    return text.replace(/\s+/g, " ").trim();
  }
}

/// One word or less for more than a second and a half of speech: the transcription stopped short.
export function isTruncated(text: string, durationMs: number): boolean {
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  return durationMs >= 1500 && words <= 1;
}

// The microphones connected now, by the name coreaudio knows them by.
export function listInputs(): string[] {
  try {
    const out = Bun.spawnSync(["system_profiler", "SPAudioDataType", "-json"]).stdout.toString();
    const devices: { _name: string; coreaudio_device_input?: number }[] = JSON.parse(out).SPAudioDataType?.[0]?._items ?? [];
    return devices.filter((d) => d.coreaudio_device_input).map((d) => d._name);
  } catch {
    return [];
  }
}

// The chosen microphone if it is connected, else the first preferred one that is, else
// undefined for the system default. ASSISTANT_INPUT still forces one.
function pickInput(wanted?: string): string | undefined {
  return preferredInput(wanted, listInputs());
}

export function preferredInput(wanted: string | undefined, inputs: string[], preference = INPUT_PREFERENCE): string | undefined {
  if (process.env.ASSISTANT_INPUT) return process.env.ASSISTANT_INPUT;
  if (wanted && inputs.includes(wanted)) return wanted;
  return preference.find((name) => inputs.includes(name));
}

export function toWav(pcm: Int16Array): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const write = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  write(0, "RIFF"); v.setUint32(4, 36 + pcm.byteLength, true); write(8, "WAVE");
  write(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  write(36, "data"); v.setUint32(40, pcm.byteLength, true);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(new Uint8Array(header));
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
}
