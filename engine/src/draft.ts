// Listening to everything: what the person says goes into a running draft instead of being thrown
// away for lack of the name or a closed window. An action phrase ("pode fazer") hands the draft
// to Claude Code, with a prompt that turns the pieces into the request and runs it. Pure, so
// the tests drive it without a microphone.
import { LANGUAGE } from "./config";
import type { Language } from "./language";
import { normalize } from "./wake";

export type Entry = { at: number; text: string };

export class Draft {
  entries: Entry[] = [];

  add(text: string, at = Date.now()) {
    const clean = text.trim();
    if (clean) this.entries.push({ at, text: clean });
  }

  /// Drops what is older than maxAgeMs: a draft is the last few minutes, not the whole day.
  prune(maxAgeMs: number, now = Date.now()) {
    this.entries = this.entries.filter((e) => now - e.at <= maxAgeMs);
  }

  clear() {
    this.entries = [];
  }

  get isEmpty() {
    return this.entries.length === 0;
  }

  /// The pieces as one readable line, for the conversation on screen.
  get text() {
    return this.entries.map((e) => e.text).join(" ");
  }
}

export type Trigger = { found: boolean; before: string; after: string };

/// Finds an action phrase as a sequence of whole words, accent- and case-blind, and returns
/// what was said before and after it, in the original spelling.
export function findTrigger(transcript: string, phrases: string[]): Trigger {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const norm = words.map((w) => normalize(w));
  for (const phrase of phrases) {
    const target = normalize(phrase).split(" ").filter(Boolean);
    if (!target.length) continue;
    for (let i = 0; i + target.length <= norm.length; i++) {
      if (target.every((t, k) => norm[i + k] === t)) {
        const trim = (s: string) => s.replace(/^[\s,.;:!?-]+|[\s,.;:!?-]+$/g, "");
        return {
          found: true,
          before: trim(words.slice(0, i).join(" ")),
          after: trim(words.slice(i + target.length).join(" ")),
        };
      }
    }
  }
  return { found: false, before: "", after: transcript.trim() };
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

/// What Claude Code receives when the person acts: the pieces with their times, and how to read them.
export function buildRequest(entries: Entry[], extra = "", lang: Language = LANGUAGE): string {
  const lines = entries.map((e) => `[${clock(e.at)}] ${e.text}`);
  if (extra.trim()) lines.push(`[${lang === "pt-BR" ? "agora" : "now"}] ${extra.trim()}`);
  if (lang === "en") return `
The request below was spoken out loud, in pieces, and the person said to run it. The transcript
comes from speech recognition: it may have wrong words, repetitions, cut sentences, hesitations and
parts that were not meant for you (them talking to someone else or to themselves).

Build the request they want from the pieces, ignore what is not for you, and carry it out.
If an essential point is truly ambiguous, ask in one short sentence before acting.

Transcript since the last action:
${lines.join("\n")}
`.trim();
  return `
O pedido abaixo foi falado em voz alta, em pedaços, e a pessoa mandou executar. A transcrição vem de
reconhecimento de voz: pode ter palavras trocadas, repetições, frases cortadas, hesitações e
trechos que não eram para você (ela falando com outra pessoa ou consigo mesma).

Monte o pedido que ela quer a partir dos pedaços, ignore o que não for para você e execute.
Se algum ponto essencial ficar ambíguo de verdade, pergunte numa frase curta antes de agir.

Transcrição desde a última ação:
${lines.join("\n")}
`.trim();
}
