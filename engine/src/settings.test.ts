import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadSettings, pick, saveSettings, voiceRules, whisperPrompt } from "./settings";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
const tempFile = () => { dir = mkdtempSync(join(tmpdir(), "settings-")); return join(dir, "settings.json"); };

describe("pick", () => {
  test("keeps well-formed values and drops the rest", () => {
    expect(pick({
      followUpMs: 20_000, summonMs: -1, voiceSpeed: 9, brainModel: "claude-opus-5-5", fishModel: "gpt",
      folders: ["/tmp/x", "relative/path", "/tmp/x"], confirmActions: ["push", "nuke"],
    })).toEqual({ followUpMs: 20_000, brainModel: "claude-opus-5-5", folders: ["/tmp/x"], confirmActions: ["push"] });
  });

  test("wake words are trimmed, lowercased and deduplicated; an empty list is ignored", () => {
    expect(pick({ wakeWords: [" Jarvis", "jarvis", "Jarbas "] }).wakeWords).toEqual(["jarvis", "jarbas"]);
    expect(pick({ wakeWords: ["  "] }).wakeWords).toBeUndefined();
  });

  test("an empty confirmation list is a real choice, not a missing one", () => {
    expect(pick({ confirmActions: [] }).confirmActions).toEqual([]);
  });
});

test("saved choices sit over the defaults, and a broken file means defaults", () => {
  const file = tempFile();
  saveSettings({ followUpMs: 30_000 }, file);
  expect(loadSettings(file)).toEqual({ ...DEFAULTS, followUpMs: 30_000 });
  writeFileSync(file, "{ not json");
  expect(loadSettings(file)).toEqual(DEFAULTS);
});

describe("voiceRules", () => {
  test("names the assistant and lists only the actions that still need a yes", () => {
    const rules = voiceRules({ ...DEFAULTS, wakeWords: ["jarvis"], confirmActions: ["push", "pay"] });
    expect(rules).toContain("Seu nome é Jarvis.");
    expect(rules).toContain("autorizar aquela ação específica nesta conversa: push, pagar.");
    expect(rules).not.toContain("deploy");
  });

  test("with nothing to confirm, it says so instead of an empty list", () => {
    expect(voiceRules({ ...DEFAULTS, confirmActions: [] })).toContain("Nenhuma ação precisa de autorização falada");
  });
});

test("the Whisper prompt carries the name, as a sentence", () => {
  expect(whisperPrompt({ ...DEFAULTS, wakeWords: ["pardal"] }, "{name}, olha o deploy do site.")).toBe("Pardal, olha o deploy do site.");
});

test("the voice rules name the person when the config does, and carry the extra instructions", () => {
  expect(voiceRules(DEFAULTS, "Ana", "- Os projetos ficam em ~/code.")).toContain("Ana fala com você pelo microfone");
  expect(voiceRules(DEFAULTS, "Ana", "- Os projetos ficam em ~/code.")).toEndWith("- Os projetos ficam em ~/code.");
  expect(voiceRules(DEFAULTS, undefined, "")).toContain("A pessoa fala com você pelo microfone");
});
