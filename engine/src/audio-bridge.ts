// The Mac app's audio, over a local WebSocket (/audio). When the app is connected, the
// microphone and my voice both go through its AVAudioEngine with voice processing on: macOS
// uses what it plays as the reference and hands over a microphone with my voice already taken
// out (acoustic echo cancellation, as FaceTime does). Without the app (run from the Terminal),
// the ear falls back to sox and the mouth to ffplay, and echo is only caught by its words.
//
// App → here: binary frames of 16 kHz mono Int16 PCM; {"type":"hello"|"device","device"};
//             {"type":"played","id"} when a line finished (or was stopped).
// Here → app: {"type":"play","id","format","data"(base64)}; {"type":"stop"};
//             {"type":"input","device"}; {"type":"chime"}.
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";

export class AudioBridge extends EventEmitter {
  private socket?: ServerWebSocket<unknown>;
  private nextId = 1;
  private pending = new Map<number, () => void>();
  /// The microphone the app opened, as macOS names it.
  device?: string;

  get isConnected() {
    return !!this.socket;
  }

  /// The Escuta switch: with it off, the app neither records nor plays (sox and ffplay do).
  isEnabled = true;
  get isActive() {
    return this.isConnected && this.isEnabled;
  }

  enable(on: boolean) {
    this.isEnabled = on;
    this.socket?.send(JSON.stringify({ type: "enable", on }));
  }

  open(ws: ServerWebSocket<unknown>) {
    if (this.socket && this.socket !== ws) this.socket.close();
    this.socket = ws;
    ws.send(JSON.stringify({ type: "enable", on: this.isEnabled }));
    this.emit("connected");
  }

  close(ws: ServerWebSocket<unknown>) {
    if (this.socket !== ws) return;
    this.socket = undefined;
    this.finishAll();
    this.emit("disconnected");
  }

  message(ws: ServerWebSocket<unknown>, data: string | Buffer) {
    if (this.socket !== ws) return;
    if (typeof data !== "string") {
      this.emit("pcm", new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    let msg: { type?: string; id?: number; device?: string };
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "played" && typeof msg.id === "number") {
      this.pending.get(msg.id)?.();
      this.pending.delete(msg.id);
    }
    if ((msg.type === "hello" || msg.type === "device") && msg.device) {
      this.device = msg.device;
      this.emit("device", msg.device);
    }
  }

  /// Plays one line in the app and resolves when it has been heard (or stopped). maxMs keeps a
  /// lost "played" from freezing the queue.
  play(audio: Uint8Array, format: "mp3" | "aiff", maxMs: number): Promise<void> {
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(); }, maxMs);
      this.pending.set(id, () => { clearTimeout(timer); resolve(); });
      socket.send(JSON.stringify({ type: "play", id, format, data: Buffer.from(audio).toString("base64") }));
    });
  }

  stop() {
    this.socket?.send(JSON.stringify({ type: "stop" }));
    this.finishAll();
  }

  useInput(device?: string) {
    this.socket?.send(JSON.stringify({ type: "input", device: device ?? null }));
  }

  chime() {
    this.socket?.send(JSON.stringify({ type: "chime" }));
  }

  private finishAll() {
    for (const done of this.pending.values()) done();
    this.pending.clear();
  }
}

export const audioBridge = new AudioBridge();
