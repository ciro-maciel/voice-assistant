import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, conversationText, dayKey, loadSession, recentJournal, saveSession, shouldResume } from "./memory";

const at = (iso: string) => new Date(iso).getTime();

describe("session", () => {
  test("saved and read back", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mem-")), "session.json");
    saveSession(file, { sessionId: "abc", conversationId: "c1", lastActivityAt: 5 });
    expect(loadSession(file)).toEqual({ sessionId: "abc", conversationId: "c1", lastActivityAt: 5 });
    saveSession(file, undefined);
    expect(loadSession(file)).toBeUndefined();
  });

  test("resumes the same day only", () => {
    const s = { sessionId: "abc", conversationId: "c1", lastActivityAt: at("2026-10-12T09:00:00") };
    expect(shouldResume(s, at("2026-10-12T23:50:00"))).toBe(true);
    expect(shouldResume(s, at("2026-10-13T00:10:00"))).toBe(false);
    expect(shouldResume(undefined)).toBe(false);
  });
});

describe("journal", () => {
  test("one file per day, with a heading once and a section per conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    appendJournal(dir, at("2026-10-12T09:05:00"), "- pediu o status do deploy");
    appendJournal(dir, at("2026-10-12T14:30:00"), "- trocou o modelo para Sonnet");
    const text = readFileSync(join(dir, "2026-10-12.md"), "utf8");
    expect(text.match(/# Conversas de 12\/10\/2026/g)?.length).toBe(1);
    expect(text).toContain("## 09:05");
    expect(text).toContain("## 14:30");
  });

  test("recent days, oldest first, cut from the old end", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    appendJournal(dir, at("2026-10-11T10:00:00"), "- ontem");
    appendJournal(dir, at("2026-10-12T10:00:00"), "- hoje");
    appendJournal(dir, at("2026-10-09T10:00:00"), "- antes de ontem");
    const text = recentJournal(dir, at("2026-10-12T12:00:00"));
    expect(text.indexOf("- ontem")).toBeLessThan(text.indexOf("- hoje"));
    expect(text).not.toContain("antes de ontem");
    expect(recentJournal(dir, at("2026-10-12T12:00:00"), 2, 20).endsWith("- hoje")).toBe(true);
  });

  test("conversation text names who spoke", () => {
    expect(conversationText([
      { role: "user", text: "status?", at: 1 },
      { role: "tool", text: "Bash: gh run list", at: 2 },
      { role: "assistant", text: "Passou.", at: 3 },
    ], "Ana", "pt-BR")).toBe("Ana: status?\n(ferramenta: Bash: gh run list)\nAssistente: Passou.");
  });

  test("dayKey is the local date", () => {
    expect(dayKey(at("2026-10-12T23:59:00"))).toBe("2026-10-12");
  });
});
