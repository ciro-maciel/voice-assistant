// What survives a restart. Two layers:
// - the session: Claude Code keeps the whole conversation on disk; we keep its id, so after the
//   app or the Mac restarts the same session is resumed (same day only) with all its context;
// - the journal: when a conversation ends, a short summary goes to a file per day, and every
//   new session reads the recent days, so a fresh start still knows what was decided.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER_NAME } from "./config";
import type { Row } from "./transcript";

export type SavedSession = {
  sessionId: string;
  conversationId: string;
  lastActivityAt: number;
  /// The last conversation already in the journal, so none is summarized twice or skipped.
  summarizedConversationId?: string;
};

export function loadSession(file: string): SavedSession | undefined {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return typeof s.sessionId === "string" && typeof s.lastActivityAt === "number" ? s : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(file: string, session: SavedSession | undefined) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, session ? JSON.stringify(session, null, 2) + "\n" : "{}\n");
}

/// Resume only what was said today: a session from yesterday is history, not context.
export function shouldResume(session: SavedSession | undefined, now = Date.now()): boolean {
  if (!session) return false;
  return dayKey(session.lastActivityAt) === dayKey(now);
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// --- journal ------------------------------------------------------------------------------

/// The conversation as plain text for the summarizer: who said what, and the tools used.
export function conversationText(rows: Row[], user = USER_NAME ?? "Pessoa"): string {
  return rows
    .map((r) => (r.role === "user" ? `${user}: ${r.text}` : r.role === "tool" ? `(ferramenta: ${r.text})` : `Assistente: ${r.text}`))
    .join("\n");
}

export function appendJournal(dir: string, at: number, summary: string) {
  const file = join(dir, `${dayKey(at)}.md`);
  mkdirSync(dir, { recursive: true });
  const time = new Date(at).toTimeString().slice(0, 5);
  const head = existsSync(file) ? "" : `# Conversas de ${dayKey(at).split("-").reverse().join("/")}\n`;
  appendFileSync(file, `${head}\n## ${time}\n\n${summary.trim()}\n`);
}

/// The last `days` days of journal, newest last, cut to `maxChars` keeping the most recent.
export function recentJournal(dir: string, now = Date.now(), days = 2, maxChars = 6000): string {
  const parts: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const file = join(dir, `${dayKey(now - i * 86_400_000)}.md`);
    if (existsSync(file)) parts.push(readFileSync(file, "utf8").trim());
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? "…\n" + text.slice(-maxChars) : text;
}

export const SUMMARY_PROMPT = `
Abaixo está uma conversa por voz entre uma pessoa e o assistente dela. Escreva um resumo para o
próprio assistente ler amanhã, em português, em no máximo seis tópicos curtos começando com "- ":
o que foi pedido, o que foi feito (com o nome de repositórios e arquivos quando houver), o que foi
decidido e o que ficou pendente. Nada de introdução nem conclusão. Se a conversa não teve nada que
valha lembrar (só cumprimentos ou testes), responda apenas: NADA
`.trim();

/// Asks a one-shot Claude Code (no tools, no settings) for the summary. Undefined when there is
/// nothing worth keeping or the call fails.
export async function summarize(claudePath: string, rows: Row[], model = "claude-haiku-5-5"): Promise<string | undefined> {
  const text = conversationText(rows);
  if (!rows.some((r) => r.role === "user")) return undefined;
  const proc = Bun.spawn(
    [claudePath, "-p", "--model", model, "--setting-sources", "", "--tools", "", "--output-format", "text"],
    { stdin: new TextEncoder().encode(`${SUMMARY_PROMPT}\n\n---\n${text}`), stdout: "pipe", stderr: "ignore",
      env: { ...process.env, ASSISTANT_SESSION: "1" } },
  );
  const timer = setTimeout(() => proc.kill(), 60_000);
  const out = (await new Response(proc.stdout).text()).trim();
  clearTimeout(timer);
  if ((await proc.exited) !== 0 || !out || /^NADA\.?$/i.test(out)) return undefined;
  return out;
}
