import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "./brain";

// Fake claude executables: one answers every stdin line with a result, one dies at once.
const dir = mkdtempSync(join(tmpdir(), "brain-"));
function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
const ANSWERS = script("answers", `echo '{"type":"system","subtype":"init","session_id":"s"}'
while read -r line; do echo '{"type":"result","is_error":false,"total_cost_usd":0}'; done`);
const DIES = script("dies", "exit 3");

const brains: Brain[] = [];
function brain(bin: string): Brain {
  process.env.ASSISTANT_CLAUDE = bin;
  const b = new Brain();
  b.memory = "";
  b.folders = [];
  brains.push(b);
  return b;
}
const once = (b: Brain, event: string) => new Promise<any[]>((resolve) => b.once(event, (...args) => resolve(args)));
const pending = (b: Brain) => (b as any).pending as number;

afterEach(() => {
  for (const b of brains.splice(0)) { b.removeAllListeners(); b.stop(); }
});
afterAll(() => {
  delete process.env.ASSISTANT_CLAUDE;
  rmSync(dir, { recursive: true, force: true });
});

describe("brain session", () => {
  test("a request after the session died opens a new one and its turn ends", async () => {
    const b = brain(DIES);
    const exited = once(b, "exit");
    b.start();
    expect((await exited)[0]).toBe(3);

    process.env.ASSISTANT_CLAUDE = ANSWERS;
    const ended = once(b, "turnEnd");
    b.send("oi");
    expect(pending(b)).toBe(1);
    expect(b.isBusy).toBe(true);
    await ended;
    expect(pending(b)).toBe(0);
    expect(b.isBusy).toBe(false);
  });

  test("start() drops turns left over from a dead session", () => {
    const b = brain(ANSWERS);
    (b as any).pending = 2;
    b.isBusy = true;
    b.start();
    expect(pending(b)).toBe(0);
    expect(b.isBusy).toBe(false);
  });

  test("start() with a live session does not spawn a second one", async () => {
    const b = brain(ANSWERS);
    let starts = 0;
    b.on("started", () => starts++);
    const ready = once(b, "ready");
    b.start();
    const proc = (b as any).proc;
    b.start();
    expect(starts).toBe(1);
    expect((b as any).proc).toBe(proc);
    await ready;
  });

  test("restart() replaces the session without reporting an exit", async () => {
    const b = brain(ANSWERS);
    let exits = 0;
    b.on("exit", () => exits++);
    b.start();
    const first = (b as any).proc;
    b.restart();
    const second = (b as any).proc;
    expect(second).not.toBe(first);
    await first.exited;
    await once(b, "ready");
    expect(exits).toBe(0);
    expect((b as any).proc).toBe(second);
  });

  test("reload() reopens the session after the old one exits", async () => {
    const b = brain(ANSWERS);
    let exits = 0;
    b.on("exit", () => exits++);
    b.start();
    const first = (b as any).proc;
    const restarted = new Promise<void>((resolve) => b.on("started", () => resolve()));
    b.reload();
    await restarted;
    expect((b as any).proc).not.toBe(first);
    expect(exits).toBe(0);
  });
});
