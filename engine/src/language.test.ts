import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerdict, buildQuestion, classifierPrompt } from "./directed";
import { buildRequest } from "./draft";
import { chooseLanguage, macLanguages, whisperCode } from "./language";
import { conversationText, summaryPrompt } from "./memory";
import { confirmActions, DEFAULTS, voiceRules } from "./settings";
import { hasKey, KEYS, t } from "./strings";
import { isNewConversation, isNoise } from "./wake";

describe("chooseLanguage", () => {
  test("without the config key, the Mac's first language decides: pt is Portuguese, anything else English", () => {
    expect(chooseLanguage(undefined, ["pt-BR", "en-BR"])).toBe("pt-BR");
    expect(chooseLanguage(undefined, ["pt-PT"])).toBe("pt-BR");
    expect(chooseLanguage(undefined, ["pt_BR"])).toBe("pt-BR");
    expect(chooseLanguage(undefined, ["en-US", "pt-BR"])).toBe("en");
    expect(chooseLanguage(undefined, ["es-ES"])).toBe("en");
    expect(chooseLanguage(undefined, [])).toBe("en");
  });

  test("the config key wins over the Mac, and follows the same rule", () => {
    expect(chooseLanguage("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(chooseLanguage("en", ["pt-BR"])).toBe("en");
    expect(chooseLanguage("fr", ["pt-BR"])).toBe("en");
    expect(chooseLanguage("  ", ["pt-BR"])).toBe("pt-BR");
  });

  test("the app's languages reach the engine through the environment", () => {
    expect(macLanguages({ ASSISTANT_LANGUAGES: "en-US, pt-BR" })).toEqual(["en-US", "pt-BR"]);
  });

  test("Whisper's code follows the conversation", () => {
    expect(whisperCode("pt-BR")).toBe("pt");
    expect(whisperCode("en")).toBe("en");
  });
});

test("every text exists in both languages, and a missing one falls back to English, not to its key", () => {
  const missing = KEYS.filter((k) => !hasKey("pt-BR", k));
  expect(missing).toEqual([]);
  expect(t("en", "say.ready")).toBe("I'm listening.");
  expect(t("pt-BR", "say.ready")).toBe("Estou ouvindo.");
  expect(t("pt-BR", "status.microphone", { device: "USB" })).toBe("microfone: USB");
});

describe("the conversation in English", () => {
  test("voice rules speak English and list the actions in English", () => {
    const rules = voiceRules({ ...DEFAULTS, wakeWords: ["jarvis"], confirmActions: ["push", "pay"] }, "Ana", "", "en");
    expect(rules).toContain("Your name is Jarvis.");
    expect(rules).toContain("Ana talks to you through the microphone");
    expect(rules).toContain("Answer in short, spoken English");
    expect(rules).toContain("in this conversation: push, pay.");
    expect(voiceRules({ ...DEFAULTS, confirmActions: [] }, undefined, "", "en")).toContain("No action needs spoken permission");
    expect(voiceRules(DEFAULTS, undefined, "", "pt-BR")).toContain("Responda em português falado");
  });

  test("the confirmation labels follow the language asked", () => {
    expect(confirmActions("en").map((a) => a.label)).toEqual(["Push", "Deploy", "Publish", "Message someone", "Delete", "Pay"]);
    expect(confirmActions("pt-BR").find((a) => a.id === "publish")?.label).toBe("Publicar");
  });

  test("draft request, classifier question and journal text are in English", () => {
    const at = new Date(2026, 9, 12, 9, 15, 3).getTime();
    const request = buildRequest([{ at, text: "in the editor" }], "close the rectangle", "en");
    expect(request).toContain("[now] close the rectangle");
    expect(request).toContain("ignore what is not for you, and carry it out");
    const q = buildQuestion("close it", [{ role: "assistant", text: "Shall I change the click?" }], ["in the editor"], undefined, "en");
    expect(q).toContain("Assistant: Shall I change the click?");
    expect(q).toContain('New sentence: "close it"');
    expect(classifierPrompt("en")).toContain('{"for_me": true or false');
    expect(classifierPrompt("pt-BR")).toContain('{"para_mim": true ou false');
    expect(conversationText([{ role: "user", text: "status?", at: 1 }, { role: "tool", text: "Bash: ls", at: 2 }], undefined, "en"))
      .toBe("Person: status?\n(tool: Bash: ls)");
    expect(summaryPrompt("en")).toContain("answer only: NOTHING");
  });

  test("the English classifier's keys are read too", () => {
    expect(parseVerdict('{"for_me": true, "reason": "a question about the editor"}'))
      .toEqual({ isDirected: true, reason: "a question about the editor" });
    expect(parseVerdict("no json here", "en").reason).toBe("answer without JSON");
  });

  test("new conversation and Whisper's silence hallucinations in English", () => {
    expect(isNewConversation("New conversation.")).toBe(true);
    expect(isNewConversation("Let's start a new conversation, please")).toBe(true);
    expect(isNewConversation("start over")).toBe(true);
    expect(isNewConversation("how do I open a new conversation in Chats?")).toBe(false);
    expect(isNoise("Thanks for watching!")).toBe(true);
    expect(isNoise("thank you for the summary")).toBe(false);
  });
});

describe("defaults follow the conversation's language", () => {
  // config.ts resolves once per process: read it in a fresh one.
  const defaults = (env: Record<string, string>, config?: object) => {
    const dir = mkdtempSync(join(tmpdir(), "language-"));
    const file = join(dir, "config.json");
    if (config) writeFileSync(file, JSON.stringify(config));
    const script = 'const c = await import("./src/config.ts"); const s = await import("./src/settings.ts");'
      + " console.log(JSON.stringify({ language: c.LANGUAGE, ui: c.UI_LANGUAGE, whisper: c.WHISPER_LANGUAGE, wake: c.WAKE_WORDS,"
      + " voice: c.FALLBACK_VOICE, phrases: s.DEFAULTS.actionPhrases }))";
    const out = Bun.spawnSync(["bun", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, VOICE_ASSISTANT_CONFIG: file, ...env },
    }).stdout.toString();
    rmSync(dir, { recursive: true, force: true });
    return JSON.parse(out);
  };

  test("a Portuguese Mac: Portuguese, Whisper in pt, both spellings of the name", () => {
    expect(defaults({ ASSISTANT_LANGUAGES: "pt-BR,en-US" })).toEqual({
      language: "pt-BR", ui: "pt-BR", whisper: "pt", wake: ["assistant", "assistente"], voice: "Luciana", phrases: ["pode fazer"],
    });
  });

  test("an English Mac: English, Whisper in en, the name alone", () => {
    expect(defaults({ ASSISTANT_LANGUAGES: "en-US" })).toEqual({
      language: "en", ui: "en", whisper: "en", wake: ["assistant"], voice: "Samantha", phrases: ["go ahead"],
    });
  });

  test("the config's language keeps the conversation in Portuguese on an English Mac; the screen stays English", () => {
    expect(defaults({ ASSISTANT_LANGUAGES: "en-US" }, { language: "pt-BR" })).toMatchObject({ language: "pt-BR", ui: "en", whisper: "pt" });
  });
});
