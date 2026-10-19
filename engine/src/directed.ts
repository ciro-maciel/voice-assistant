// "Is this for me?": decides, per utterance, whether the person is talking to the assistant, so
// the name is not needed. After "Device-directed Utterance Detection" (Mallidi et al., Amazon, 2018,
// arXiv 1808.02504), which separates device-directed queries from background speech using the
// ASR text and acoustics; here the text and the conversation so far go to a small model.
//
// A dedicated Claude Code session (Haiku, no tools, no settings, no MCP) stays open so each
// decision costs only its answer; it is renewed every RESET_AFTER decisions so its history does
// not grow. A late or broken answer is "not for me": the words still go to the draft.
import { EventEmitter } from "node:events";
import { claudeBin } from "./brain";
import { LANGUAGE, UI_LANGUAGE, USER_NAME, WORKING_DIR } from "./config";
import type { Language } from "./language";
import { t } from "./strings";

export type Verdict = { isDirected: boolean; reason: string };

const RESET_AFTER = 30;
export const TIMEOUT_MS = 4_000;

const CLASSIFIER_PROMPT_PT = `
Você decide se uma frase dita em voz alta, numa sala, foi dirigida a um assistente de voz.
O assistente trabalha nos projetos de software de quem o usa (código, repositórios, apps, deploys,
textos) e conversa com essa pessoa. A frase vem de reconhecimento de voz e pode ter palavras trocadas.

É para o assistente: pedido, pergunta, ordem ou instrução; resposta a uma pergunta que o
assistente acabou de fazer; continuação ou correção de um pedido recente; comentário sobre o
que o assistente está fazendo ("não, espera", "isso, pode").

Não é para o assistente: conversa com outra pessoa ou ao telefone; pensar alto sem pedir nada;
som de vídeo, música ou TV; fragmento sem intenção ("é", "então", "tá"); frase sem sentido,
típica de erro de transcrição.

Na dúvida entre as duas, responda que não é: a frase não se perde, fica anotada.

Responda só com uma linha de JSON, sem mais nada:
{"para_mim": true ou false, "motivo": "até 12 palavras"}
`.trim();

const CLASSIFIER_PROMPT_EN = `
You decide whether a sentence said out loud, in a room, was addressed to a voice assistant.
The assistant works on the software projects of the person who uses it (code, repositories, apps,
deploys, texts) and talks with that person. The sentence comes from speech recognition and may
have wrong words.

It is for the assistant: a request, question, order or instruction; an answer to a question the
assistant just asked; the continuation or correction of a recent request; a comment on what the
assistant is doing ("no, wait", "yes, go on").

It is not for the assistant: talking to someone else or on the phone; thinking out loud without
asking anything; sound from a video, music or TV; a fragment with no intent ("uh", "so", "ok");
a sentence that makes no sense, typical of a transcription error.

When in doubt, answer that it is not: the sentence is not lost, it is noted.

Answer with one line of JSON only, nothing else:
{"for_me": true or false, "reason": "up to 12 words"}
`.trim();

/// The classifier's instructions in the conversation's language.
export const classifierPrompt = (lang: Language = LANGUAGE) => (lang === "pt-BR" ? CLASSIFIER_PROMPT_PT : CLASSIFIER_PROMPT_EN);

/// The model's line → a verdict. Anything that is not the expected JSON is "not for me".
/// Both prompts' keys are read: "for_me"/"reason" and "para_mim"/"motivo".
export function parseVerdict(text: string, lang: Language = UI_LANGUAGE): Verdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { isDirected: false, reason: t(lang, "classifier.noJson") };
  try {
    const data = JSON.parse(match[0]) as { for_me?: unknown; reason?: unknown; para_mim?: unknown; motivo?: unknown };
    const reason = data.reason ?? data.motivo;
    return { isDirected: (data.for_me ?? data.para_mim) === true, reason: typeof reason === "string" ? reason : "" };
  } catch {
    return { isDirected: false, reason: t(lang, "classifier.badJson") };
  }
}

/// What the classifier reads: the last exchanges, the draft, and the new utterance.
export function buildQuestion(utterance: string, recent: { role: string; text: string }[], draft: string[], user = USER_NAME,
  lang: Language = LANGUAGE): string {
  const pt = lang === "pt-BR";
  const person = user ?? (pt ? "Pessoa" : "Person");
  const who = (role: string) => (role === "user" ? person : role === "assistant" ? (pt ? "Assistente" : "Assistant") : (pt ? "Ferramenta" : "Tool"));
  const history = recent.filter((r) => r.role !== "tool").slice(-6).map((r) => `${who(r.role)}: ${r.text.slice(0, 300)}`);
  return [
    history.length ? `${pt ? "Conversa recente" : "Recent conversation"}:\n${history.join("\n")}` : pt ? "Conversa recente: nenhuma." : "Recent conversation: none.",
    draft.length ? `${pt ? "Anotado antes, ainda sem ação" : "Noted before, not acted on yet"}:\n${draft.map((d) => `- ${d}`).join("\n")}` : "",
    `${pt ? "Frase nova" : "New sentence"}: "${utterance}"`,
  ].filter(Boolean).join("\n\n");
}

export class DirectedClassifier extends EventEmitter {
  model = "claude-haiku-5-5";
  private proc?: ReturnType<typeof Bun.spawn>;
  private turns = 0;
  private waiting?: (text: string) => void;
  private text = "";
  private queue: Promise<unknown> = Promise.resolve();

  /// One decision at a time; the session answers in order.
  classify(question: string): Promise<Verdict> {
    const run = this.queue.then(() => this.ask(question));
    this.queue = run.catch(() => undefined);
    return run;
  }

  stop() {
    this.proc?.kill();
    this.proc = undefined;
  }

  private ask(question: string): Promise<Verdict> {
    if (!this.proc || this.turns >= RESET_AFTER) this.restart();
    this.turns++;
    this.text = "";
    return new Promise<Verdict>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        this.restart(); // a stuck session would make every next decision late too
        resolve({ isDirected: false, reason: t(UI_LANGUAGE, "classifier.late") });
      }, TIMEOUT_MS);
      this.waiting = (text) => { clearTimeout(timer); resolve(parseVerdict(text)); };
      const stdin = this.proc!.stdin as import("bun").FileSink;
      stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: question } }) + "\n");
      stdin.flush();
    });
  }

  private restart() {
    this.proc?.kill();
    this.turns = 0;
    this.proc = Bun.spawn([
      claudeBin(), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", this.model, "--tools", "", "--setting-sources", "", "--strict-mcp-config",
      "--no-session-persistence", "--system-prompt", classifierPrompt(),
    ], { cwd: WORKING_DIR, stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { ...process.env, ASSISTANT_SESSION: "1" } });
    this.read(this.proc.stdout as ReadableStream<Uint8Array>, this.proc);
  }

  private async read(stream: ReadableStream<Uint8Array>, proc: ReturnType<typeof Bun.spawn>) {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream) {
      if (this.proc !== proc) return;
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event: Record<string, any>;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "assistant") {
          for (const block of event.message?.content ?? []) if (block.type === "text") this.text += block.text;
        } else if (event.type === "result") {
          const done = this.waiting;
          this.waiting = undefined;
          done?.(this.text || String(event.result ?? ""));
        }
      }
    }
  }
}
