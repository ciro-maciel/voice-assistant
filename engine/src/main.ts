// Starts Assistant: ear (local Whisper), brain (persistent Claude Code session),
// mouth (Fish Audio, or the Mac's voice) and the HUD on http://localhost:4780.
import { Brain, claudeBin, claudeCandidates } from "./brain";
import { CONFIG_FILE, HISTORY_FILE, HUD_PORT, INPUT_PREFERENCE, JOURNAL_DIR, LANGUAGE, SESSION_FILE, UI_LANGUAGE, WORKING_DIR } from "./config";
import { appendJournal, loadSession, recentJournal, saveSession, shouldResume, summarize } from "./memory";
import { isNewConversation } from "./wake";
import { audioBridge } from "./audio-bridge";
import { Conversation, looksLikeEcho } from "./conversation";
import { buildRequest, Draft, findTrigger } from "./draft";
import { buildQuestion, DirectedClassifier } from "./directed";
import { Ear, listInputs, type Utterance } from "./ear";
import {
  BRAIN_MODELS, confirmActions, FISH_MODELS, loadSettings, macVoices, pick, saveSettings, type Settings,
  voiceRules, whisperModels, whisperPrompt,
} from "./settings";
import { startHud } from "./hud";
import { Mouth } from "./mouth";
import { SentenceBuffer } from "./sentences";
import { type Key, t } from "./strings";
import { takeOver } from "./single-instance";
import { NEW_CONVERSATION_AFTER_MS, readHistory, Transcript } from "./transcript";

// Words on screen follow the Mac's language; what is said out loud follows the conversation's.
const ui = (key: Key, params?: Record<string, string | number>) => t(UI_LANGUAGE, key, params);
const spoken = (key: Key, params?: Record<string, string | number>) => t(LANGUAGE, key, params);

const previous = await takeOver(HUD_PORT);
if (previous) console.log(`parei a instância anterior (pid ${previous})`);

let settings = loadSettings();
const ear = new Ear();
const brain = new Brain();
const mouth = new Mouth();
const conversation = new Conversation(settings.wakeWords);
const sentences = new SentenceBuffer();
const transcript = new Transcript(HISTORY_FILE);
const versions = new Map<string, string>();
const versionOf = (path: string) => {
  if (!versions.has(path)) versions.set(path, Bun.spawnSync([path, "--version"]).stdout.toString().trim().split(" ")[0] || "?");
  return versions.get(path)!;
};
let sessionStartedAt = 0;

// --- memory: resume today's session, keep a journal of every conversation ------------------
const saved = loadSession(SESSION_FILE);
let summarizedConversationId = saved?.summarizedConversationId;
const isResuming = shouldResume(saved);
if (isResuming && saved) {
  brain.sessionId = saved.sessionId;
  transcript.restore(saved.conversationId);
}
brain.memory = recentJournal(JOURNAL_DIR);

function persist() {
  if (!brain.sessionId) return;
  saveSession(SESSION_FILE, {
    sessionId: brain.sessionId,
    conversationId: transcript.conversationId,
    lastActivityAt: transcript.lastActivity || Date.now(),
    summarizedConversationId,
  });
}

/// Writes one conversation to today's journal, once. Runs in the background (a few seconds).
async function journal(conversationId: string, rows: typeof transcript.rows, at: number) {
  if (!conversationId || conversationId === summarizedConversationId || !rows.length) return;
  summarizedConversationId = conversationId;
  persist();
  const summary = await summarize(claudeBin(settings.claudePath), rows);
  if (!summary) return;
  appendJournal(JOURNAL_DIR, at, summary);
  brain.memory = recentJournal(JOURNAL_DIR);
  hud.send("status", ui("status.journalSaved"));
}

// A conversation that ended while the app was closed is summarized at the next start.
if (saved?.conversationId && saved.conversationId !== summarizedConversationId && !isResuming) {
  const past = new Transcript(HISTORY_FILE);
  past.restore(saved.conversationId);
  journal(saved.conversationId, past.rows, past.lastActivity);
}

// Ten minutes without anything said closes the conversation: summarize it then.
let journalTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleJournal() {
  clearTimeout(journalTimer);
  const id = transcript.conversationId;
  journalTimer = setTimeout(() => {
    if (transcript.conversationId === id) journal(id, [...transcript.rows], transcript.lastActivity);
  }, NEW_CONVERSATION_AFTER_MS + 5_000);
}

/// "Conversa nova", by voice or by the app: the current one goes to the journal and the next
/// question opens a session with no past, only the journal. The session opens lazily, on that
/// question, so the summary (a few seconds) is normally in the journal by then.
function newConversation() {
  interruptAll();
  journal(transcript.conversationId, [...transcript.rows], transcript.lastActivity);
  transcript.reset();
  brain.newSession();
  sessionStartedAt = 0;
  saveSession(SESSION_FILE, undefined);
  hud.send("status", ui("status.newConversation"));
  mouth.say(spoken("say.newConversation"));
}

// --- timings: how long each stage of the last answer took ----------------------------------
type Turn = { heardAt?: number; transcribedAt?: number; askedAt: number; firstTextAt?: number; firstSentenceAt?: number };
let turn: Turn | undefined;
let lastTimings: { transcribeMs?: number; modelMs: number; voiceMs: number; totalMs: number; isSpoken: boolean } | undefined;

/// Puts every setting where it is used. Called at start and after each change from the app.
function apply(s: Settings) {
  conversation.wakeWords = s.wakeWords;
  conversation.followUpMs = s.followUpMs;
  conversation.summonMs = s.summonMs;
  conversation.echoGuardMs = s.echoGuardMs;
  ear.endSilenceMs = s.endSilenceMs;
  audioBridge.isEnabled = s.isEchoCancelOn;
  mouth.voiceId = s.voiceId;
  mouth.speed = s.voiceSpeed;
  mouth.fishModel = s.fishModel;
  mouth.fallbackVoice = s.fallbackVoice;
  ear.whisperPrompt = whisperPrompt(s);
  brain.model = s.brainModel;
  brain.folders = s.folders;
  brain.rules = voiceRules(s);
  brain.claudePath = s.claudePath;
}
apply(settings);

const hud = startHud({
  state: () => {
    const claudePath = claudeBin(settings.claudePath);
    return {
      state: state(),
      isMuted: ear.isMuted,
      isMicDead: ear.isDead,
      isEchoCancelled: ear.isEchoCancelled,
      device: ear.device,
      conversation: {
        startedAt: transcript.startedAt,
        rows: transcript.rows,
        costUsd: transcript.costUsd,
        answers: transcript.answers,
      },
      heard: recentHeard,
      draft: draft.entries,
      session: { model: brain.model, claudePath, claudeVersion: versionOf(claudePath), startedAt: sessionStartedAt, isReady: sessionStartedAt > 0 },
      settings: { ...settings, whisperModel: ear.whisperModel, inputPreference: INPUT_PREFERENCE, workingFolder: WORKING_DIR, configFile: CONFIG_FILE, language: LANGUAGE },
      timings: lastTimings,
      memory: { isResumed: isResuming, journalDays: recentJournal(JOURNAL_DIR) ? 2 : 0 },
    };
  },
  history: () => readHistory(HISTORY_FILE),
  options: () => ({
    inputs: listInputs(),
    models: BRAIN_MODELS,
    whisperModels: whisperModels(),
    fishModels: FISH_MODELS,
    macVoices: macVoices(),
    claudePaths: claudeCandidates().map((path) => ({ path, version: versionOf(path) })),
    confirmActions: confirmActions(),
  }),
  // Applied at once and saved for the next start. Only what changed is touched.
  settings: async (raw) => {
    const patch = pick(raw);
    if (patch.whisperModel && !whisperModels().includes(patch.whisperModel)) delete patch.whisperModel;
    const before = settings;
    settings = saveSettings(patch);
    apply(settings);
    if (patch.inputDevice) {
      ear.useDevice(patch.inputDevice);
      hud.send("status", ui("status.microphone", { device: ear.device }));
    }
    const changed = (k: keyof Settings) => k in patch && JSON.stringify(before[k]) !== JSON.stringify(settings[k]);
    if (changed("brainModel") || changed("folders") || changed("confirmActions") || changed("claudePath")
        || changed("wakeWords") || changed("voiceName")) {
      brain.reload();
      hud.send("status", ui("status.sessionReopened"));
    }
    if (changed("isEchoCancelOn")) ear.setEchoCancel(settings.isEchoCancelOn);
    if (changed("whisperModel") || changed("wakeWords")) {
      hud.send("status", ui("status.whisperLoading", { model: settings.whisperModel }));
      await ear.useWhisperModel(settings.whisperModel);
      hud.send("status", ui("status.whisper", { model: settings.whisperModel }));
    }
    return { ok: true };
  },
  sample: () => mouth.say(spoken("say.sample")),
  newConversation: () => newConversation(),
  act: () => act(),
  clearDraft: () => { draft.clear(); publishState(); },
  listen: () => summon(),
  say: (text) => ask(text),
  stop: () => interruptAll(),
  mute: () => {
    ear.isMuted = !ear.isMuted;
    hud.send("muted", ear.isMuted);
    return ear.isMuted;
  },
});

type State = "waiting" | "listening" | "hearing" | "drafting" | "thinking" | "speaking" | "muted";
let hearing = false;
let hearingSince = 0;

function state(): State {
  if (mouth.isSpeaking) return "speaking";
  if (brain.isBusy) return "thinking";
  if (ear.isMuted || ear.isDead) return "muted";
  // Speech while nobody called me is the room, not a request: it stays "waiting".
  // A request that began inside the window keeps "Escutando" until it ends, even past the window.
  if (hearing && (conversation.isOpen(hearingSince) || settings.isDraftOn)) return "hearing";
  if (conversation.isOpen()) return "listening";
  return draft.isEmpty ? "waiting" : "drafting";
}
let lastState: State | undefined;
let ticks = 0;
function publishState() {
  const s = state();
  // Repeat every two seconds too, so a page opened later catches up.
  if (s !== lastState || ++ticks % 8 === 0) hud.send("state", s);
  lastState = s;
}
setInterval(publishState, 250);

function summon() {
  conversation.open(conversation.summonMs);
  mouth.chime();
  publishState();
}

// Only a real answer opens the follow-up window; "Estou ouvindo." at startup and the voice
// sample are not answers, and opening it then sent room talk ("Vamos lá.") as a question.
let isAnswering = false;
function answered() {
  if (!isAnswering || brain.isBusy || mouth.hasPending) return;
  isAnswering = false;
  conversation.afterAnswer();
}

// For the conversation's decisions: the last request, whether an answer to it was already
// spoken, and what my voice said lately (echo is my own words coming back).
let lastAsk: { text: string; endedAt: number } | undefined;
let hasAnswerStarted = false;
const spokenLines: { at: number; text: string }[] = [];
const recentSpoken = () => spokenLines.filter((l) => Date.now() - l.at < 30_000).map((l) => l.text).join(" ");

// What he said without the name, waiting for an action phrase ("pode fazer") or the name.
const draft = new Draft();
// "Is this for me?" for what comes without the name (directed.ts).
const directed = new DirectedClassifier();

function toDraft(text: string, why?: string) {
  draft.prune(settings.draftMaxAgeMs);
  draft.add(text);
  noteHeard({ at: Date.now(), text, action: "drafted",
    reason: ui("heard.drafted", { why: why ? `${why}; ` : "", count: draft.entries.length, phrase: settings.actionPhrases[0] }) });
  hud.send("heard", { text, action: "draft" });
  publishState();
}

/// Sends a request. With a draft, the draft goes along: the pieces said before are context
/// (or the request itself), and Claude Code gets them with the prompt that assembles them.
function ask(text: string, heard?: { endedAt: number; transcribedAt: number }) {
  draft.prune(settings.draftMaxAgeMs);
  const brainText = draft.isEmpty ? text : buildRequest(draft.entries, text);
  if (!draft.isEmpty) text = [draft.text, text].filter(Boolean).join(" ");
  draft.clear();
  lastAsk = { text, endedAt: heard?.endedAt ?? Date.now() };
  hasAnswerStarted = false;
  if (isNewConversation(text)) {
    newConversation();
    return;
  }
  turn = { askedAt: Date.now(), heardAt: heard?.endedAt, transcribedAt: heard?.transcribedAt };
  isAnswering = true;
  transcript.user(text);
  hud.send("user", text);
  brain.send(brainText);
  publishState();
}

/// The action phrase, or "Executar" in the app: run what the draft holds.
function act(extra = "", heard?: { endedAt: number; transcribedAt: number }) {
  draft.prune(settings.draftMaxAgeMs);
  if (draft.isEmpty && !extra.trim()) {
    mouth.say(spoken("say.nothingDrafted"));
    return;
  }
  if (mouth.isSpeaking || brain.isBusy) interruptAll();
  ask(extra, heard);
}

function interruptAll() {
  mouth.stop();
  brain.interrupt();
  sentences.flush();
}

ear.on("speechStart", () => { hearing = true; hearingSince = Date.now(); publishState(); });
ear.on("speechEnd", () => { hearing = false; publishState(); });
ear.on("level", (level: number) => hud.send("level", level));
// The last things heard and what was done with them, so a request that went nowhere has a
// reason on screen (Agora) and in the log, instead of "Escutando" followed by silence.
// `action` is an id the app puts in words: accepted, drafted, run, forMe, ignored, dropped, joined, error.
type Heard = { at: number; text: string; action: string; reason?: string };
const recentHeard: Heard[] = [];
const REASONS: Record<string, Key> = { noName: "reason.noName", echo: "reason.echo", busy: "reason.busy" };
function noteHeard(h: Heard) {
  recentHeard.unshift(h);
  recentHeard.splice(8);
  console.log(`ouvi: "${h.text}" → ${h.action}${h.reason ? ` (${h.reason})` : ""}`);
}
ear.on("dropped", (text: string, seconds: number) => {
  noteHeard({ at: Date.now(), text: text || ui("heard.nothing"), action: "dropped",
    reason: ui(text ? "heard.noise" : "heard.empty", { seconds }) });
  hud.send("heard", { text, action: "ignore", reason: "noise" });
});
ear.on("utterance", (u: Utterance) => {
  const heardAt = { endedAt: u.endedAt, transcribedAt: Date.now() };
  const isEcho = (mouth.isSpeaking || u.startedAt < mouth.lastSilentAt + conversation.echoGuardMs)
    && looksLikeEcho(u.text, recentSpoken());
  // The action phrase runs the draft, also over my voice or my work (it interrupts them).
  const trigger = settings.isDraftOn ? findTrigger(u.text, settings.actionPhrases) : undefined;
  if (trigger?.found && !isEcho) {
    const count = draft.entries.length;
    noteHeard({ at: Date.now(), text: u.text, action: "run", reason: ui(count === 1 ? "heard.actionPhrase.one" : "heard.actionPhrase.other", { count }) });
    hud.send("heard", { text: u.text, action: "act" });
    act([trigger.before, trigger.after].filter(Boolean).join(" "), heardAt);
    return;
  }
  const action = conversation.decide(u.text, {
    now: Date.now(),
    startedAt: u.startedAt,
    isSpeaking: mouth.isSpeaking,
    lastSilentAt: mouth.lastSilentAt,
    isBusy: brain.isBusy,
    recentSpoken: recentSpoken(),
    lastAsk,
    hasAnswerStarted,
  });
  // Without the name and outside the window: ask "is this for me?" (Device-directed
  // Utterance Detection, Amazon 2018). Yes runs it now; no keeps it in the draft.
  if (action.kind === "ignore" && action.reason === "noName" && settings.isDirectedOn && !isEcho) {
    const question = buildQuestion(u.text, transcript.rows, draft.entries.map((e) => e.text));
    directed.classify(question).then((verdict) => {
      if (verdict.isDirected) {
        noteHeard({ at: Date.now(), text: u.text, action: "forMe", reason: verdict.reason });
        hud.send("heard", { text: u.text, action: "send" });
        ask(u.text, heardAt);
      } else if (settings.isDraftOn) {
        toDraft(u.text, ui("heard.notForMe", { reason: verdict.reason }));
      } else {
        noteHeard({ at: Date.now(), text: u.text, action: "ignored", reason: ui("heard.notForMe", { reason: verdict.reason }) });
      }
    });
    return;
  }
  // Not for me right now, but his words: into the draft, instead of the bin.
  if (action.kind === "ignore" && settings.isDraftOn && action.reason !== "echo" && !isEcho) {
    toDraft(u.text);
    return;
  }
  hud.send("heard", { text: u.text, action: action.kind, reason: "reason" in action ? action.reason : undefined });
  noteHeard({ at: Date.now(), text: u.text, action: action.kind === "ignore" ? "ignored" : action.kind === "continue" ? "joined" : "accepted",
    reason: "reason" in action ? ui(REASONS[action.reason]) : undefined });
  const heard = { endedAt: u.endedAt, transcribedAt: Date.now() };
  if (action.kind === "summon") summon();
  if (action.kind === "send") ask(action.text, heard);
  if (action.kind === "continue") {
    // The first piece already went: stop that turn and send the request whole.
    console.log(`continuação: reenviando o pedido inteiro`);
    interruptAll();
    ask(action.text, { endedAt: u.endedAt, transcribedAt: Date.now() });
  }
  if (action.kind === "bargeIn") {
    interruptAll();
    if (action.text) ask(action.text, heard);
    else summon();
  }
});
ear.on("error", (error) => {
  console.log(`ouvido: ${String(error)}`);
  noteHeard({ at: Date.now(), text: ui("heard.lostAudio"), action: "error", reason: ui("heard.transcriptionFailed", { error: String(error) }) });
  hud.send("error", ui("error.ear", { error: String(error) }));
});
ear.on("deadMic", (device: string) => {
  console.log(`o microfone (${device}) só entrega silêncio`);
  hud.send("error", ui("error.deadMic", { device, help: ui("error.deadMicHelp") }));
  mouth.say(spoken("say.deadMic", { help: spoken("error.deadMicHelp") }));
});
ear.on("echoCancel", (isOn: boolean) => {
  console.log(isOn ? `cancelamento de eco ligado: o app grava e toca (${ear.device})` : "cancelamento de eco desligado: o app saiu; voltei ao sox");
  hud.send("status", ui(isOn ? "status.echoOn" : "status.echoOff"));
});
ear.on("liveMic", (device: string) => hud.send("status", ui("status.micBack", { device })));

brain.on("started", () => {
  sessionStartedAt = Date.now();
  transcript.resetSessionTotal();
});
brain.on("session", () => persist());
brain.on("ready", () => hud.send("status", ui("status.brainReady")));
function speak(sentence: string) {
  if (turn && !turn.firstSentenceAt) turn.firstSentenceAt = Date.now();
  mouth.say(sentence);
}
brain.on("text", (delta: string) => {
  if (turn && !turn.firstTextAt) turn.firstTextAt = Date.now();
  transcript.delta(delta);
  hud.send("delta", delta);
  for (const sentence of sentences.push(delta)) speak(sentence);
});
brain.on("blockEnd", () => {
  transcript.blockEnd();
  for (const sentence of sentences.flush()) speak(sentence);
});
brain.on("tool", (description: string) => {
  transcript.tool(description);
  hud.send("tool", description);
});
brain.on("turnEnd", (info) => {
  transcript.turnEnd(info.costUsd);
  persist();
  scheduleJournal();
  for (const sentence of sentences.flush()) speak(sentence);
  hud.send("turnEnd", info);
  answered();
});
// Reopen a dead session, waiting longer each time; after five failures in a row, stop and
// say why instead of looping forever. A session that reached "ready" resets the count.
const MAX_BRAIN_FAILURES = 5;
let brainFailures = 0;
brain.on("ready", () => { brainFailures = 0; });
brain.on("exit", (code: number, stderr: string) => {
  sessionStartedAt = 0;
  brainFailures++;
  const reason = stderr ? `: ${stderr.split("\n").slice(-3).join(" ")}` : "";
  console.log(`a sessão do Claude Code saiu (código ${code})${reason}`);
  if (brainFailures >= MAX_BRAIN_FAILURES) {
    hud.send("error", ui("error.claudeGaveUp", { count: brainFailures, reason }));
    mouth.say(spoken("say.claudeDown"));
    return;
  }
  const delayMs = 1000 * 2 ** (brainFailures - 1);
  hud.send("error", ui("error.claudeExited", { code, reason, seconds: delayMs / 1000 }));
  setTimeout(() => brain.start(), delayMs);
});

mouth.on("line", (text: string) => {
  hasAnswerStarted = true;
  spokenLines.push({ at: Date.now(), text });
  spokenLines.splice(0, Math.max(0, spokenLines.length - 20));
  hud.send("spoken", text);
  // The first audio of an answer closes its timing.
  if (turn?.firstTextAt && turn.firstSentenceAt) {
    const now = Date.now();
    lastTimings = {
      transcribeMs: turn.heardAt && turn.transcribedAt ? turn.transcribedAt - turn.heardAt : undefined,
      modelMs: turn.firstTextAt - turn.askedAt,
      voiceMs: now - turn.firstSentenceAt,
      totalMs: now - (turn.heardAt ?? turn.askedAt),
      isSpoken: !!turn.heardAt,
    };
    turn = undefined;
    hud.send("timings", lastTimings);
  }
});
mouth.on("level", (level: number) => hud.send("outLevel", level));
mouth.on("idle", () => {
  answered();
  publishState();
});
mouth.on("error", (error) => hud.send("error", ui("error.voice", { error: String(error) })));

function shutdown() {
  directed.stop();
  persist();
  ear.stop();
  brain.stop();
  mouth.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

brain.start();
// Open the classifier now, so the first "is this for me?" does not pay the session's start.
directed.classify(buildQuestion(LANGUAGE === "pt-BR" ? "teste" : "test", [], [])).catch(() => undefined);
console.log(`painel: http://localhost:${HUD_PORT}`);
await ear.start({
  device: settings.inputDevice,
  whisperModel: whisperModels().includes(settings.whisperModel) ? settings.whisperModel : undefined,
});
console.log(`microfone: ${ear.device}`);
console.log(`ouvindo. Diga "${settings.wakeWords[0]}" para chamar.`);
console.log(`idioma da conversa: ${LANGUAGE}; da tela: ${UI_LANGUAGE}`);
mouth.say(spoken(isResuming && transcript.rows.length ? "say.readyResumed" : "say.ready"));
