import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_CONVERSATION_AFTER_MS, readHistory, Transcript } from "./transcript";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
const tempFile = () => { dir = mkdtempSync(join(tmpdir(), "transcript-")); return join(dir, "history.jsonl"); };

describe("Transcript", () => {
  test("joins streaming deltas into one row and times each tool", () => {
    const t = new Transcript();
    t.user("o deploy terminou?", 1000);
    t.delta("Vou ", 1100);
    t.delta("olhar.", 1200);
    t.blockEnd(1250);
    t.tool("Bash: gh run list", 1300);
    t.delta("Terminou sem erro.", 3100);
    t.turnEnd(0.12, 3200);
    expect(t.rows.map((r) => [r.role, r.text, r.durationMs])).toEqual([
      ["user", "o deploy terminou?", undefined],
      ["assistant", "Vou olhar.", undefined],
      ["tool", "Bash: gh run list", 1800],
      ["assistant", "Terminou sem erro.", undefined],
    ]);
  });

  test("an answer costs the difference of the session's running total", () => {
    const t = new Transcript();
    t.user("a", 0); t.turnEnd(0.12, 10);
    t.user("b", 20); t.turnEnd(0.128, 30);
    t.user("c", 40); t.turnEnd(0.135, 50);
    expect(t.costUsd).toBeCloseTo(0.135, 6);
    expect(t.answers).toBe(3);
  });

  test("a restarted session starts its total from zero again", () => {
    const t = new Transcript();
    t.user("a", 0); t.turnEnd(0.2, 10);
    t.user("b", 20); t.turnEnd(0.05, 30); // new process: 0.05 is the whole answer
    expect(t.costUsd).toBeCloseTo(0.25, 6);
  });

  test("a long pause starts a new conversation", () => {
    const t = new Transcript();
    t.user("a", 0);
    const first = t.conversationId;
    t.user("b", NEW_CONVERSATION_AFTER_MS + 1);
    expect(t.conversationId).not.toBe(first);
    expect(t.rows.map((r) => r.text)).toEqual(["b"]);
  });
});

test("readHistory groups the file by conversation, newest first", () => {
  const file = tempFile();
  const t = new Transcript(file);
  t.user("primeira pergunta", 1000); t.delta("resposta", 1100); t.turnEnd(0.12, 1200);
  t.user("segunda", 1300); t.turnEnd(0.13, 1400);
  t.user("outra conversa", 1400 + NEW_CONVERSATION_AFTER_MS + 1); t.turnEnd(0.01, 1500 + NEW_CONVERSATION_AFTER_MS);
  const history = readHistory(file);
  expect(history.map((c) => [c.firstQuestion, c.answers])).toEqual([["outra conversa", 1], ["primeira pergunta", 2]]);
  expect(history[1].costUsd).toBeCloseTo(0.13, 6);
});

test("restore brings back one conversation's rows, cost and answers", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tr-")), "history.jsonl");
  const t = new Transcript(file);
  t.user("status?", 1000);
  t.delta("Passou.", 2000);
  t.turnEnd(0.01, 3000);
  const id = t.conversationId;
  const back = new Transcript(file);
  back.restore(id);
  expect(back.rows.map((r) => [r.role, r.text])).toEqual([["user", "status?"], ["assistant", "Passou."]]);
  expect(back.answers).toBe(1);
  expect(back.costUsd).toBeCloseTo(0.01);
  expect(back.lastActivity).toBe(3000);
});
