import { describe, expect, test } from "bun:test";
import { ECHO_GUARD_MS, FOLLOW_UP_MS, SUMMON_MS } from "./config";
import { CONTINUE_MS, Conversation, type Moment } from "./conversation";
import { isTruncated, preferredInput } from "./ear";
import { forSpeech, SentenceBuffer } from "./sentences";
import { isNewConversation, isNoise, matchWake } from "./wake";

const WAKE = ["assistant", "assistente"];

describe("matchWake", () => {
  test("keeps what comes after the name, with its accents", () => {
    expect(matchWake("Assistant, qual é o status do deploy?", WAKE)).toEqual({ hasWake: true, rest: "qual é o status do deploy?" });
  });
  test("finds the name in the middle and accepts a mishearing", () => {
    expect(matchWake("Ô Assistente. Abre o projeto", WAKE)).toEqual({ hasWake: true, rest: "Abre o projeto" });
  });
  test("the name alone has nothing after it", () => {
    expect(matchWake("Assistant!", WAKE)).toEqual({ hasWake: true, rest: "" });
  });
  test("no name, no wake", () => {
    expect(matchWake("vamos almoçar", WAKE).hasWake).toBe(false);
  });
});

test("isNoise drops Whisper's silence hallucinations and keeps speech", () => {
  expect(isNoise("Legendas pela comunidade Amara.org")).toBe(true);
  expect(isNoise("[Música]")).toBe(true);
  expect(isNoise("Obrigado.")).toBe(true);
  expect(isNoise("www.soups.com/contactuals.com/contactuals")).toBe(true);
  expect(isNoise("obrigado pelo resumo")).toBe(false);
  expect(isNoise("abre o site do site e vê o deploy")).toBe(false);
});

describe("SentenceBuffer", () => {
  test("releases each sentence as soon as it closes", () => {
    const b = new SentenceBuffer();
    expect(b.push("Vou olhar o CI do back")).toEqual([]);
    expect(b.push("end. Já volto")).toEqual(["Vou olhar o CI do backend."]);
    expect(b.flush()).toEqual(["Já volto"]);
  });
  test("holds a too-short piece until the next one", () => {
    const b = new SentenceBuffer();
    expect(b.push("Sim. Fiz o commit agora. ")).toEqual(["Sim. Fiz o commit agora."]);
  });
  test("does not break numbers like 1.5", () => {
    const b = new SentenceBuffer();
    expect(b.push("A velocidade está em 1.5 agora. ")).toEqual(["A velocidade está em 1.5 agora."]);
  });
});

test("forSpeech strips what only the eye reads", () => {
  expect(forSpeech("Veja [o doc](https://x.y) em `main.ts` e em /tmp/a.md. **Pronto** <!-- voz: x -->"))
    .toBe("Veja o doc em main.ts e em. Pronto");
});

describe("Conversation", () => {
  const quiet = (now: number, extra: Partial<Moment> = {}): Moment =>
    ({ now, startedAt: now - 1000, isSpeaking: false, lastSilentAt: 0, isBusy: false, ...extra });

  test("ignores speech without the name when nothing is open", () => {
    expect(new Conversation(WAKE).decide("abre o projeto", quiet(10_000)).kind).toBe("ignore");
  });
  test("the name with a question sends the question", () => {
    expect(new Conversation(WAKE).decide("Assistant, abre o projeto", quiet(10_000))).toEqual({ kind: "send", text: "abre o projeto" });
  });
  test("the name alone opens a window for the next sentence", () => {
    const c = new Conversation(WAKE);
    expect(c.decide("Assistant", quiet(10_000)).kind).toBe("summon");
    expect(c.decide("abre o projeto", quiet(10_000 + SUMMON_MS - 1))).toEqual({ kind: "send", text: "abre o projeto" });
  });
  test("after an answer he can reply without the name, until the window closes", () => {
    const c = new Conversation(WAKE);
    c.afterAnswer(10_000);
    expect(c.decide("pode", quiet(10_000 + FOLLOW_UP_MS - 1, { lastSilentAt: 9_000 })).kind).toBe("send");
    c.afterAnswer(50_000);
    expect(c.decide("pode", quiet(50_000 + FOLLOW_UP_MS + 1, { startedAt: 50_000 + FOLLOW_UP_MS + 1 })).kind).toBe("ignore");
  });
  test("my own voice is echo: ignored unless it carries the name", () => {
    const c = new Conversation(WAKE);
    c.afterAnswer(10_000);
    expect(c.decide("estou ouvindo", quiet(11_000, { isSpeaking: true })).kind).toBe("ignore");
    expect(c.decide("estou ouvindo", quiet(11_000, { startedAt: 10_000 + ECHO_GUARD_MS - 1, lastSilentAt: 10_000, recentSpoken: "Estou ouvindo." })).kind).toBe("ignore");
  });
  test("his reply running into the tail of my voice is not echo when the words are his", () => {
    const c = new Conversation(WAKE);
    c.afterAnswer(10_000);
    const tail = { startedAt: 10_000 + 200, lastSilentAt: 10_000, recentSpoken: "O deploy do backend terminou sem erro." };
    expect(c.decide("então abre o painel do painel e vê os chats de hoje", quiet(14_000, tail)).kind).toBe("send");
    expect(c.decide("terminou sem erro", quiet(14_000, tail)).kind).toBe("ignore");
  });
  test("the name alone, then a long request that starts inside the window and ends after it", () => {
    const c = new Conversation(WAKE);
    expect(c.decide("Assistant", quiet(10_000)).kind).toBe("summon");
    const request = "e faz o seguinte no editor quando nós clicarmos fora do retângulo fecha o retângulo";
    expect(c.decide(request, quiet(10_000 + SUMMON_MS + 6_000, { startedAt: 10_000 + SUMMON_MS - 1_000 })))
      .toEqual({ kind: "send", text: request });
  });
  test("a pause in a long request: the next piece is its rest, resent whole", () => {
    const c = new Conversation(WAKE);
    const busy = { isBusy: true, lastAsk: { text: "revisa o README do projeto", endedAt: 10_000 } };
    expect(c.decide("e depois atualiza a data no topo", quiet(14_000, { ...busy, startedAt: 12_000 })))
      .toEqual({ kind: "continue", text: "revisa o README do projeto e depois atualiza a data no topo" });
  });
  test("no continuation once I started answering, or after the pause got long", () => {
    const c = new Conversation(WAKE);
    const busy = { isBusy: true, lastAsk: { text: "revisa o README", endedAt: 10_000 } };
    expect(c.decide("e a data", quiet(14_000, { ...busy, startedAt: 12_000, hasAnswerStarted: true })).kind).toBe("ignore");
    expect(c.decide("e a data", quiet(20_000, { ...busy, startedAt: 10_000 + CONTINUE_MS + 1 })).kind).toBe("ignore");
  });
  test("the name over my voice interrupts", () => {
    expect(new Conversation(WAKE).decide("Assistant, para", quiet(11_000, { isSpeaking: true }))).toEqual({ kind: "bargeIn", text: "para" });
    expect(new Conversation(WAKE).decide("Assistant", quiet(11_000, { isBusy: true }))).toEqual({ kind: "bargeIn", text: "" });
  });
});

test("isNewConversation takes the whole sentence as the command", () => {
  expect(isNewConversation("Conversa nova.")).toBe(true);
  expect(isNewConversation("vamos começar uma nova conversa")).toBe(true);
  expect(isNewConversation("Começa do zero, por favor.")).toBe(true);
  expect(isNewConversation("esquece essa conversa")).toBe(true);
  expect(isNewConversation("como eu abro uma conversa nova no Chats?")).toBe(false);
});

test("isTruncated: a long utterance that came back as one word", () => {
  expect(isTruncated("assist", 2100)).toBe(true);
  expect(isTruncated("Assistente, que horas são?", 2100)).toBe(false);
  expect(isTruncated("Assistente", 900)).toBe(false);
  expect(isTruncated("", 1800)).toBe(true);
});

test("preferredInput: the chosen mic if connected, else the first preferred one that is", () => {
  const inputs = ["Built-in Microphone", "USB Mic"];
  expect(preferredInput("USB Mic", inputs, ["Built-in Microphone"])).toBe("USB Mic");
  expect(preferredInput("Headset", inputs, ["Desk Mic", "Built-in Microphone"])).toBe("Built-in Microphone");
  expect(preferredInput(undefined, inputs, ["Desk Mic"])).toBeUndefined();
});
