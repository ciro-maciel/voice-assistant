// The brain: one Claude Code session that stays open between turns (stream-json in and
// out), so each question costs no startup and the conversation keeps its context.
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { BRAIN_MODEL, CLAUDE_CANDIDATES, FOLDERS, LANGUAGE, USER_NAME, WORKING_DIR } from "./config";
import { DEFAULTS, voiceRules } from "./settings";

/// The claude to run: the one chosen in the app if it still exists, else the first candidate found.
export function claudeBin(chosen?: string): string {
  if (process.env.ASSISTANT_CLAUDE) return process.env.ASSISTANT_CLAUDE;
  if (chosen && existsSync(chosen)) return chosen;
  return CLAUDE_CANDIDATES.find((path) => existsSync(path)) ?? "claude";
}

/// The installed candidates, for the app's Cérebro screen.
export function claudeCandidates(): string[] {
  return CLAUDE_CANDIDATES.filter((path) => existsSync(path));
}



type Event = Record<string, any>;

/// The line above the journal in the system prompt, in the conversation's language.
function journalIntro(): string {
  return LANGUAGE === "pt-BR"
    ? `O que ficou das conversas recentes${USER_NAME ? ` com ${USER_NAME}` : ""} (resumos seus, do mais antigo ao mais novo; use como contexto, não leia em voz alta):`
    : `What remains of the recent conversations${USER_NAME ? ` with ${USER_NAME}` : ""} (your own summaries, oldest to newest; use them as context, do not read them aloud):`;
}

export class Brain extends EventEmitter {
  isBusy = false;
  /// Messages sent and not yet answered. An interrupted turn's end arrives after the request
  /// that replaced it was sent: busy stays on until every one has ended.
  private pending = 0;
  private proc?: ReturnType<typeof Bun.spawn>;
  /// The Claude Code session; set before start() to resume one saved on disk.
  sessionId?: string;
  /// The recent journal, read by every session as background (memory.ts).
  memory = "";
  private stderrTail = "";
  model = BRAIN_MODEL;
  folders = FOLDERS;
  rules = voiceRules(DEFAULTS);
  claudePath?: string;

  /// Switch models keeping the conversation: the new session resumes the same one.
  useModel(model: string) {
    this.model = model;
    this.reload();
  }

  /// "Conversa nova": closes the current session; the next message opens one with no past
  /// (by then the journal has the summary of the one that closed).
  newSession() {
    this.sessionId = undefined;
    this.isBusy = false;
    this.pending = 0;
    const proc = this.proc;
    this.proc = undefined; // its exit is expected: no restart, no failure
    proc?.kill();
  }

  /// Folders, rules or the claude binary changed: reopen the session, resuming the conversation.
  reload() {
    if (!this.proc) return;
    this.isSwitching = true;
    this.proc.kill();
  }
  private isSwitching = false;
  private isReady = false;

  start() {
    const args = [
      claudeBin(this.claudePath), "-p",
      "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages",
      "--model", this.model,
      "--permission-mode", "bypassPermissions",
      "--append-system-prompt", this.memory
        ? `${this.rules}\n\n${journalIntro()}\n\n${this.memory}`
        : this.rules,
      ...this.folders.flatMap((dir) => ["--add-dir", dir]),
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
    this.proc = Bun.spawn(args, {
      cwd: WORKING_DIR,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      // The spoken-summary hook (hook/speak.sh) stays quiet for this session: the assistant
      // already speaks everything.
      env: { ...process.env, ASSISTANT_SESSION: "1" },
    });
    this.isReady = false;
    this.emit("started");
    this.readLines(this.proc.stdout as ReadableStream<Uint8Array>);
    this.readStderr(this.proc.stderr as ReadableStream<Uint8Array>);
    const proc = this.proc;
    proc.exited.then((code) => {
      if (this.proc !== proc) return;
      this.isBusy = false;
      this.pending = 0;
      // A model switch is not a failure: start again at once, resuming the conversation.
      if (this.isSwitching) {
        this.isSwitching = false;
        this.start();
        return;
      }
      this.emit("exit", code, this.stderrTail.trim());
    });
  }

  // Keep the end of stderr: when the session dies, that is the only place that says why.
  private async readStderr(stream: ReadableStream<Uint8Array>) {
    this.stderrTail = "";
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000);
  }

  send(text: string) {
    if (!this.proc) this.start();
    this.pending++;
    this.isBusy = true;
    this.write({ type: "user", message: { role: "user", content: text } });
  }

  interrupt() {
    if (!this.isBusy) return;
    this.write({ type: "control_request", request_id: `int-${Date.now()}`, request: { subtype: "interrupt" } });
  }

  restart() {
    this.proc?.kill();
    this.start();
  }

  stop() {
    this.proc?.kill();
  }

  private write(event: Event) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
    stdin?.write(JSON.stringify(event) + "\n");
    stdin?.flush();
  }

  private async readLines(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { this.onEvent(JSON.parse(line)); } catch { /* not JSON: CLI noise */ }
      }
    }
  }

  private onEvent(event: Event) {
    if (event.type === "system" && event.subtype === "init") {
      // stream-json repeats init on every turn; only the first one means "ready".
      const isNew = this.sessionId !== event.session_id;
      this.sessionId = event.session_id;
      if (isNew) this.emit("session", event.session_id);
      if (!this.isReady) { this.isReady = true; this.emit("ready", event.session_id); }
    } else if (event.type === "stream_event") {
      const delta = event.event?.delta;
      if (event.event?.type === "content_block_delta" && delta?.type === "text_delta") this.emit("text", delta.text);
      // A new text block after a tool call starts a new thought; keep sentences apart.
      if (event.event?.type === "content_block_stop") this.emit("blockEnd");
    } else if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") this.emit("tool", describeTool(block.name, block.input));
      }
    } else if (event.type === "result") {
      this.pending = Math.max(0, this.pending - 1);
      this.isBusy = this.pending > 0;
      this.emit("turnEnd", { isError: event.is_error, costUsd: event.total_cost_usd });
    }
  }
}

function describeTool(name: string, input: Record<string, any> = {}): string {
  const detail = input.description ?? input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? "";
  return detail ? `${name}: ${String(detail).slice(0, 140)}` : name;
}
