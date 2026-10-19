// The mouth: a queue of sentences. Each one is synthesized by Fish Audio as soon as it arrives
// (up to two ahead of the one playing) and played in order with ffplay. Without a Fish voice id
// or key, the Mac's own voice (`say`) speaks. Only the text of the answer is sent to Fish.
import { EventEmitter } from "node:events";
import { audioBridge } from "./audio-bridge";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FALLBACK_VOICE, FISH_MODEL, FISH_VOICE_ID, fishApiKey, tool, VOICE_SPEED } from "./config";

const PREFETCH = 2;

type Line = { text: string; audio?: Promise<Uint8Array | null> };

export class Mouth extends EventEmitter {
  // Live: the app's Voz screen changes them without a restart.
  voiceId = FISH_VOICE_ID;
  speed = VOICE_SPEED;
  fishModel = FISH_MODEL;
  fallbackVoice = FALLBACK_VOICE;

  isSpeaking = false;
  lastSilentAt = 0;
  private queue: Line[] = [];
  private player?: ReturnType<typeof Bun.spawn>;
  private aborter = new AbortController();
  private isDraining = false;
  private key = fishApiKey();

  /// Playing, or with lines still waiting for their audio.
  get hasPending(): boolean {
    return this.isDraining || this.queue.length > 0;
  }

  say(text: string) {
    this.queue.push({ text });
    this.prefetch();
    if (!this.isDraining) this.drain();
  }

  stop() {
    this.queue = [];
    this.aborter.abort();
    this.aborter = new AbortController();
    this.player?.kill();
    audioBridge.stop();
  }

  // A short sound for "I'm listening", without spending a TTS call.
  chime() {
    if (audioBridge.isActive) return audioBridge.chime();
    Bun.spawn(["afplay", "/System/Library/Sounds/Tink.aiff"]);
  }

  private prefetch() {
    for (const line of this.queue.slice(0, PREFETCH)) {
      line.audio ??= this.synthesize(line.text, this.aborter.signal);
    }
  }

  private async drain() {
    this.isDraining = true;
    while (this.queue.length) {
      this.prefetch();
      const line = this.queue[0];
      const audio = await line.audio;
      if (this.queue[0] !== line) continue; // stopped while synthesizing
      this.queue.shift();
      this.prefetch();
      this.setSpeaking(true);
      this.emit("line", line.text);
      await this.play(line.text, audio ?? null);
    }
    this.isDraining = false;
    this.setSpeaking(false);
  }

  private setSpeaking(isSpeaking: boolean) {
    if (this.isSpeaking === isSpeaking) return;
    this.isSpeaking = isSpeaking;
    if (!isSpeaking) this.lastSilentAt = Date.now();
    this.emit(isSpeaking ? "start" : "idle");
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<Uint8Array | null> {
    if (!this.key || !this.voiceId) return null;
    try {
      const res = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", model: this.fishModel },
        body: JSON.stringify({
          text, reference_id: this.voiceId, format: "mp3", latency: "balanced", prosody: { speed: this.speed },
        }),
      });
      if (!res.ok) throw new Error(`Fish ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      if (!signal.aborted) this.emit("error", error);
      return null;
    }
  }

  // The loudness of an mp3 every 100 ms, so the app's "Falando" bars follow the real voice.
  private async envelope(audio: Uint8Array): Promise<number[]> {
    try {
      const ffmpeg = Bun.spawn([tool("ffmpeg"), "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"],
        { stdin: audio, stdout: "pipe" });
      const pcm = new Int16Array(await new Response(ffmpeg.stdout).arrayBuffer());
      const step = 800; // 100 ms at 8 kHz
      const levels: number[] = [];
      for (let i = 0; i < pcm.length; i += step) {
        let sum = 0;
        const end = Math.min(pcm.length, i + step);
        for (let j = i; j < end; j++) sum += (pcm[j] / 32768) ** 2;
        levels.push(Math.min(1, Math.sqrt(sum / (end - i)) / 0.2));
      }
      return levels;
    } catch {
      return [];
    }
  }

  // Through the app: its engine plays it, so macOS can cancel it from the microphone.
  private async playInApp(text: string, audio: Uint8Array | null) {
    let format: "mp3" | "aiff" = "mp3";
    if (!audio) {
      // Without Fish, the Mac's voice, rendered to a file so it also goes through the app.
      const file = join(tmpdir(), `assistant-say-${process.pid}-${Date.now()}.aiff`);
      const say = Bun.spawn(["say", "-v", this.fallbackVoice, "-r", String(Math.round(170 * this.speed)), "-o", file, text]);
      await say.exited;
      try { audio = new Uint8Array(await Bun.file(file).arrayBuffer()); } catch { return; }
      Bun.spawn(["rm", "-f", file]);
      format = "aiff";
    }
    const levels = format === "mp3" ? await this.envelope(audio) : [];
    const token = {};
    this.playing = token;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const i = Math.floor((Date.now() - startedAt) / 100);
      if (i >= levels.length || this.playing !== token) { clearInterval(timer); this.emit("level", 0); return; }
      this.emit("level", levels[i]);
    }, 100);
    // At most the line's length plus a margin (or 60 s when the length is unknown).
    await audioBridge.play(audio, format, levels.length ? levels.length * 100 + 4_000 : 60_000);
    clearInterval(timer);
    this.playing = undefined;
  }
  private playing?: object;

  private async play(text: string, audio: Uint8Array | null) {
    if (audioBridge.isActive) return this.playInApp(text, audio);
    // Without Fish (no key, no network), the Mac's own voice still answers.
    this.player = audio
      ? Bun.spawn([tool("ffplay"), "-nodisp", "-autoexit", "-loglevel", "error", "-i", "pipe:0"], { stdin: audio })
      : Bun.spawn(["say", "-v", this.fallbackVoice, "-r", String(Math.round(170 * this.speed)), text]);
    if (audio) {
      const startedAt = Date.now();
      const player = this.player;
      this.envelope(audio).then((levels) => {
        const timer = setInterval(() => {
          const i = Math.floor((Date.now() - startedAt) / 100);
          if (i >= levels.length || this.player !== player) { clearInterval(timer); this.emit("level", 0); return; }
          this.emit("level", levels[i]);
        }, 100);
      });
    }
    await this.player.exited;
  }
}
