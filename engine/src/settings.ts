// What was chosen in the app (Escuta, Voz and Cérebro). Every value has a default in config.ts;
// the choices live in settings.json next to the history, are read at start and applied live.
// The app's keyboard shortcuts are the app's own (it registers them), so they are not here.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BRAIN_MODEL, CLAUDE_CANDIDATES, ECHO_GUARD_MS, FALLBACK_VOICE, FISH_MODEL, FISH_VOICE_ID, FOLDERS, FOLLOW_UP_MS,
  INSTRUCTIONS, LANGUAGE, SETTINGS_FILE, SUMMON_MS, UI_LANGUAGE, USER_NAME, VOICE_NAME, VOICE_SPEED, WAKE_WORDS,
  WHISPER_MODEL, WHISPER_MODELS_DIR, WHISPER_PROMPT_TEMPLATE,
} from "./config";
import type { Language } from "./language";
import { type Key, t } from "./strings";

export const BRAIN_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
export const FISH_MODELS = ["s2.1-pro-free", "s2.1-pro"];

// The actions that can require your spoken "pode" first; all of them by default.
export const CONFIRM_ACTION_IDS = ["push", "deploy", "publish", "message", "delete", "pay"];
/// The actions with their labels in one language (the app's screen uses the Mac's).
export const confirmActions = (lang: Language = UI_LANGUAGE) =>
  CONFIRM_ACTION_IDS.map((id) => ({ id, label: t(lang, `confirm.${id}` as Key) }));

export type Settings = {
  inputDevice?: string;
  whisperModel: string;
  wakeWords: string[];
  followUpMs: number;
  summonMs: number;
  echoGuardMs: number;
  endSilenceMs: number;
  /// Listen to everything: what he says without the name goes to a draft, run by an action phrase.
  isDraftOn: boolean;
  /// Record and play through the Mac app with macOS echo cancellation (audio-bridge.ts).
  isEchoCancelOn: boolean;
  /// "Is this for me?" without the name: a small model reads each utterance (directed.ts).
  isDirectedOn: boolean;
  actionPhrases: string[];
  draftMaxAgeMs: number;
  voiceId: string;
  voiceName: string;
  voiceSpeed: number;
  fishModel: string;
  fallbackVoice: string;
  brainModel: string;
  claudePath?: string;
  folders: string[];
  confirmActions: string[];
};

export const DEFAULTS: Settings = {
  whisperModel: WHISPER_MODEL,
  wakeWords: WAKE_WORDS,
  followUpMs: FOLLOW_UP_MS,
  summonMs: SUMMON_MS,
  echoGuardMs: ECHO_GUARD_MS,
  endSilenceMs: 1_200,
  isDraftOn: true,
  isEchoCancelOn: true,
  isDirectedOn: true,
  actionPhrases: [LANGUAGE === "pt-BR" ? "pode fazer" : "go ahead"],
  draftMaxAgeMs: 10 * 60_000,
  voiceId: FISH_VOICE_ID,
  voiceName: VOICE_NAME,
  voiceSpeed: VOICE_SPEED,
  fishModel: FISH_MODEL,
  fallbackVoice: FALLBACK_VOICE,
  brainModel: BRAIN_MODEL,
  folders: FOLDERS,
  confirmActions: CONFIRM_ACTION_IDS,
};

/// The saved choices over the defaults. Unknown keys are ignored; a broken file means defaults.
export function loadSettings(file = SETTINGS_FILE): Settings {
  let saved: Partial<Settings> = {};
  try {
    if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* defaults */ }
  return { ...DEFAULTS, ...pick(saved) };
}

/// Validates a patch from the app; returns only the keys that are well formed.
export function pick(patch: Record<string, unknown>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const isList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
  const isMs = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 120_000;
  if (isText(patch.inputDevice)) out.inputDevice = patch.inputDevice;
  if (isText(patch.whisperModel)) out.whisperModel = patch.whisperModel;
  if (isList(patch.wakeWords)) {
    const words = patch.wakeWords.map((w) => w.trim().toLowerCase()).filter(Boolean);
    if (words.length) out.wakeWords = [...new Set(words)];
  }
  if (isMs(patch.followUpMs)) out.followUpMs = patch.followUpMs;
  if (isMs(patch.summonMs)) out.summonMs = patch.summonMs;
  if (isMs(patch.echoGuardMs)) out.echoGuardMs = patch.echoGuardMs;
  if (typeof patch.isDraftOn === "boolean") out.isDraftOn = patch.isDraftOn;
  if (typeof patch.isEchoCancelOn === "boolean") out.isEchoCancelOn = patch.isEchoCancelOn;
  if (typeof patch.isDirectedOn === "boolean") out.isDirectedOn = patch.isDirectedOn;
  if (isList(patch.actionPhrases)) {
    const phrases = patch.actionPhrases.map((p) => p.trim().toLowerCase()).filter((p) => p.length >= 3);
    if (phrases.length) out.actionPhrases = [...new Set(phrases)];
  }
  if (typeof patch.draftMaxAgeMs === "number" && patch.draftMaxAgeMs >= 60_000 && patch.draftMaxAgeMs <= 60 * 60_000) out.draftMaxAgeMs = patch.draftMaxAgeMs;
  if (typeof patch.endSilenceMs === "number" && patch.endSilenceMs >= 400 && patch.endSilenceMs <= 5_000) out.endSilenceMs = patch.endSilenceMs;
  // Empty is a real choice for the voice: no Fish, the Mac speaks.
  if (typeof patch.voiceId === "string") out.voiceId = patch.voiceId.trim();
  if (typeof patch.voiceName === "string") out.voiceName = patch.voiceName.trim();
  if (typeof patch.voiceSpeed === "number" && patch.voiceSpeed >= 0.5 && patch.voiceSpeed <= 3) out.voiceSpeed = patch.voiceSpeed;
  if (isText(patch.fishModel) && FISH_MODELS.includes(patch.fishModel)) out.fishModel = patch.fishModel;
  if (isText(patch.fallbackVoice)) out.fallbackVoice = patch.fallbackVoice;
  if (isText(patch.brainModel) && BRAIN_MODELS.includes(patch.brainModel)) out.brainModel = patch.brainModel;
  if (isText(patch.claudePath) && CLAUDE_CANDIDATES.includes(patch.claudePath)) out.claudePath = patch.claudePath;
  if (isList(patch.folders)) out.folders = [...new Set(patch.folders.filter((f) => f.startsWith("/")))];
  if (isList(patch.confirmActions)) out.confirmActions = patch.confirmActions.filter((a) => CONFIRM_ACTION_IDS.includes(a));
  return out;
}

export function saveSettings(patch: Partial<Settings>, file = SETTINGS_FILE): Settings {
  let saved: Record<string, unknown> = {};
  try {
    if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* start over */ }
  const next = { ...saved, ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return loadSettings(file);
}

// The Whisper models on this Mac, by short name ("large-v3-turbo"), smallest first.
export function whisperModels(dir = WHISPER_MODELS_DIR): string[] {
  const order = ["tiny", "base", "small", "medium", "large-v3-turbo", "large-v3"];
  try {
    return readdirSync(dir)
      .filter((f) => /^ggml-.+\.bin$/.test(f))
      .map((f) => f.replace(/^ggml-|\.bin$/g, ""))
      .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  } catch {
    return [];
  }
}

export function whisperModelPath(name: string, dir = WHISPER_MODELS_DIR): string {
  return join(dir, `ggml-${name}.bin`);
}

// The Mac's own voices in the conversation's language (`say -v ?`), for when Fish does not answer.
export function macVoices(lang: Language = LANGUAGE): string[] {
  const out = Bun.spawnSync(["say", "-v", "?"]).stdout.toString();
  // "Eddy (Português (Brasil)) pt_BR    # Olá…" or "Luciana             pt_BR    # Olá…"
  const prefix = lang === "pt-BR" ? "pt" : "en";
  const home = lang === "pt-BR" ? "pt_BR" : "en_US";
  const voices = out.split("\n")
    .map((line) => line.match(new RegExp(`^(.*?)\\s+(${prefix}_[A-Z]{2})\\s`)))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ name: m[1].replace(/\s*\(.*\)\s*$/, "").trim(), region: m[2] }));
  // Brazil (or the US) first, each name once.
  voices.sort((a, b) => Number(b.region === home) - Number(a.region === home));
  return Array.from(new Set(voices.map((v) => v.name)));
}

// The voice rules appended to Claude Code's system prompt, from the current settings, in the
// conversation's language.
export function voiceRules(s: Settings, user = USER_NAME, instructions = INSTRUCTIONS, lang: Language = LANGUAGE): string {
  const name = s.wakeWords[0] ? s.wakeWords[0][0].toUpperCase() + s.wakeWords[0].slice(1) : "Assistant";
  const actions = confirmActions(lang).filter((a) => s.confirmActions.includes(a.id)).map((a) => a.label.toLowerCase());
  const voice = s.voiceName.split(" ")[0];
  if (lang === "en") return voiceRulesEnglish(name, user, actions, voice, instructions);
  const who = user ?? "A pessoa";
  const confirm = actions.length
    ? `- Estas ações só depois de ${user ?? "ela"} autorizar aquela ação específica nesta conversa: ${actions.join(", ")}.
  Pergunte de forma direta: "Posso fazer o push?". O resto você faz sem perguntar.`
    : "- Nenhuma ação precisa de autorização falada; faça o que for pedido.";
  return `
Seu nome é ${name}. Você está em modo de voz. ${who} fala com você pelo microfone e ouve, frase por
frase, tudo o que você escreve, ${voice ? `na voz de ${voice}` : "na voz do Mac"}. Ninguém está olhando a tela.

- Responda em português falado e curto: uma a três frases, a menos que peçam detalhe.
- Nada de markdown, listas, tabelas, código, caminhos de arquivo, links, emoji ou siglas
  soletradas. Escreva como se fala.
- Antes de usar qualquer ferramenta, diga numa frase curta o que vai fazer ("Vou olhar o CI do
  projeto."). Quem pediu ouve isso enquanto você trabalha, e o silêncio parece travamento.
- Ao terminar um trabalho, diga o resultado em uma ou duas frases. Detalhe só se pedirem.
- A mensagem vem de reconhecimento de voz e pode ter palavras trocadas. Interprete pelo
  sentido; pergunte só se for ambíguo de verdade.
${confirm}
- Nesta sessão tudo já é falado: não use o marcador de voz em comentário HTML.
- Não agende lembretes nem tarefas dentro da sessão (CronCreate, loop, ScheduleWakeup): eles
  morrem quando a sessão fecha. Quando pedirem para lembrar algo, diga que fica anotado: o
  resumo da conversa vai para o diário que você lê ao começar, e você lembra na próxima conversa.
- O diário das conversas recentes vem no fim destas instruções. Quando perguntarem o que ficou
  pendente ou o que foi feito, responda por ele.
${instructions}
`.trim();
}

function voiceRulesEnglish(name: string, user: string | undefined, actions: string[], voice: string, instructions: string): string {
  const who = user ?? "The person";
  const confirm = actions.length
    ? `- These actions only after ${user ?? "they"} authorize that specific action in this conversation: ${actions.join(", ")}.
  Ask directly: "Shall I push?". Everything else you do without asking.`
    : "- No action needs spoken permission; do what is asked.";
  return `
Your name is ${name}. You are in voice mode. ${who} talks to you through the microphone and hears,
sentence by sentence, everything you write, ${voice ? `in ${voice}'s voice` : "in the Mac's voice"}. Nobody is looking at the screen.

- Answer in short, spoken English: one to three sentences, unless asked for detail.
- No markdown, lists, tables, code, file paths, links, emoji or spelled-out acronyms.
  Write the way people talk.
- Before using any tool, say in one short sentence what you are about to do ("I'll check the
  project's CI."). The person hears it while you work, and silence sounds like a freeze.
- When you finish a piece of work, say the result in one or two sentences. Details only if asked.
- The message comes from speech recognition and may have wrong words. Go by the meaning;
  ask only if it is truly ambiguous.
${confirm}
- In this session everything is already spoken: do not use the voice marker in an HTML comment.
- Do not schedule reminders or tasks inside the session (CronCreate, loop, ScheduleWakeup): they
  die when the session closes. When asked to remember something, say it is noted: the
  conversation's summary goes to the journal you read when you start, and you remember it next time.
- The journal of recent conversations comes at the end of these instructions. When asked what is
  pending or what was done, answer from it.
${instructions}
`.trim();
}

// Whisper reads its prompt as an example of what it will hear: a natural sentence with the name.
export function whisperPrompt(s: Settings, template = WHISPER_PROMPT_TEMPLATE): string {
  const name = s.wakeWords[0] ? s.wakeWords[0][0].toUpperCase() + s.wakeWords[0].slice(1) : "Assistant";
  return template.replaceAll("{name}", name);
}
