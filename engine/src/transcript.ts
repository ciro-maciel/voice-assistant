// The conversation as the app shows it: who said what, which tools ran and for how long, and
// what it cost. The current one lives in memory; every closed row also goes to a JSON Lines
// file, which is where the History screen reads from.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "user" | "assistant" | "tool";
export type Row = { role: Role; text: string; at: number; durationMs?: number; isOpen?: boolean };

type Record =
  | { conversationId: string; at: number; role: Role; text: string; durationMs?: number }
  | { conversationId: string; at: number; role: "turn"; costUsd: number };

export type ConversationSummary = {
  conversationId: string;
  startedAt: number;
  firstQuestion: string;
  answers: number;
  costUsd: number;
};

// A pause this long starts a new conversation.
export const NEW_CONVERSATION_AFTER_MS = 10 * 60_000;

export class Transcript {
  conversationId = "";
  startedAt = 0;
  rows: Row[] = [];
  costUsd = 0;
  answers = 0;
  private lastActivityAt = 0;
  private sessionTotalUsd = 0;

  constructor(private file?: string) {}

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /// A new Claude Code process reports its running total from zero again.
  resetSessionTotal() {
    this.sessionTotalUsd = 0;
  }

  /// "Conversa nova": the next thing said starts another conversation.
  reset() {
    this.conversationId = "";
    this.rows = [];
    this.costUsd = 0;
    this.answers = 0;
    this.lastActivityAt = 0;
  }

  /// After a restart, bring back the screen of a conversation that is being resumed.
  restore(conversationId: string) {
    if (!this.file || !existsSync(this.file)) return;
    const rows: Row[] = [];
    let costUsd = 0, answers = 0, last = 0, first = Infinity;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.includes(conversationId)) continue;
      let r: Record;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.conversationId !== conversationId) continue;
      first = Math.min(first, r.at);
      last = Math.max(last, r.at);
      if (r.role === "turn") { costUsd += r.costUsd; answers++; continue; }
      rows.push({ role: r.role, text: r.text, at: r.at, ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) });
    }
    if (!rows.length) return;
    this.conversationId = conversationId;
    this.rows = rows.sort((a, b) => a.at - b.at);
    this.startedAt = first;
    this.costUsd = costUsd;
    this.answers = answers;
    this.lastActivityAt = last;
  }

  user(text: string, now = Date.now()) {
    this.touch(now);
    this.closeOpen(now);
    this.push({ role: "user", text, at: now });
  }

  delta(text: string, now = Date.now()) {
    this.touch(now);
    const last = this.rows.at(-1);
    if (last?.role === "assistant" && last.isOpen) {
      last.text += text;
      return;
    }
    this.closeOpen(now);
    this.rows.push({ role: "assistant", text, at: now, isOpen: true });
  }

  // A text block ended: the assistant row is complete.
  blockEnd(now = Date.now()) {
    const last = this.rows.at(-1);
    if (last?.role === "assistant" && last.isOpen) this.close(last, now);
  }

  tool(description: string, now = Date.now()) {
    this.touch(now);
    this.closeOpen(now);
    this.rows.push({ role: "tool", text: description, at: now, isOpen: true });
  }

  // Claude Code reports the session's cost so far; one answer costs the difference. A new
  // session process starts from zero again, so a smaller total is the whole answer.
  turnEnd(sessionTotalUsd: number | undefined, now = Date.now()) {
    this.closeOpen(now);
    this.answers++;
    if (sessionTotalUsd === undefined) return;
    const costUsd = sessionTotalUsd >= this.sessionTotalUsd ? sessionTotalUsd - this.sessionTotalUsd : sessionTotalUsd;
    this.sessionTotalUsd = sessionTotalUsd;
    this.costUsd += costUsd;
    this.write({ conversationId: this.conversationId, at: now, role: "turn", costUsd });
  }

  private touch(now: number) {
    if (!this.conversationId || now - this.lastActivityAt > NEW_CONVERSATION_AFTER_MS) {
      this.conversationId = new Date(now).toISOString();
      this.startedAt = now;
      this.rows = [];
      this.costUsd = 0;
      this.answers = 0;
    }
    this.lastActivityAt = now;
  }

  private closeOpen(now: number) {
    const last = this.rows.at(-1);
    if (last?.isOpen) this.close(last, now);
  }

  private close(row: Row, now: number) {
    delete row.isOpen;
    if (row.role === "tool") row.durationMs = now - row.at;
    this.write({ conversationId: this.conversationId, at: row.at, role: row.role, text: row.text, durationMs: row.durationMs });
  }

  private push(row: Row) {
    this.rows.push(row);
    this.write({ conversationId: this.conversationId, at: row.at, role: row.role, text: row.text });
  }

  private write(record: Record) {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, JSON.stringify(record) + "\n");
    } catch { /* history is a convenience; the conversation goes on without it */ }
  }
}

// Newest first. Reads the whole file: a few thousand lines a day at most.
export function readHistory(file: string, limit = 100): ConversationSummary[] {
  if (!existsSync(file)) return [];
  const byId = new Map<string, ConversationSummary>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let r: Record;
    try { r = JSON.parse(line); } catch { continue; }
    let c = byId.get(r.conversationId);
    if (!c) {
      c = { conversationId: r.conversationId, startedAt: r.at, firstQuestion: "", answers: 0, costUsd: 0 };
      byId.set(r.conversationId, c);
    }
    c.startedAt = Math.min(c.startedAt, r.at);
    if (r.role === "user" && !c.firstQuestion) c.firstQuestion = r.text;
    if (r.role === "turn") { c.answers++; c.costUsd += r.costUsd; }
  }
  return [...byId.values()].filter((c) => c.firstQuestion).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}
