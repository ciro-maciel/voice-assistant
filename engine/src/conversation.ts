// Decides what to do with each thing the person says. Pure state, no audio: main.ts wires it
// to the ear, the brain and the mouth, and the tests drive it directly.
import { ECHO_GUARD_MS, FOLLOW_UP_MS, SUMMON_MS } from "./config";
import { matchWake, normalize } from "./wake";

// A piece that starts this soon after the last request, before any answer was spoken, is the
// rest of that request: a long command has pauses for thought.
export const CONTINUE_MS = 6_000;

export type Action =
  | { kind: "ignore"; reason: string }
  | { kind: "summon" }                              // name alone: chime and wait
  | { kind: "send"; text: string }                  // a question for the brain
  | { kind: "bargeIn"; text: string }               // he spoke over me: stop, then maybe send
  | { kind: "continue"; text: string };             // the rest of the last request: resend it whole

export type Moment = {
  now: number;
  startedAt: number;     // when his speech began
  isSpeaking: boolean;   // my voice is playing
  lastSilentAt: number;  // when my voice last stopped
  isBusy: boolean;       // the brain is working
  recentSpoken?: string; // what my voice said in the last seconds, to tell echo from him
  lastAsk?: { text: string; endedAt: number }; // the last request sent, and when its speech ended
  hasAnswerStarted?: boolean; // my voice already said something about that request
};

/// Echo is my own words coming back through the microphone: most of what was heard is in what
/// I just said. Timing alone also threw away his reply when it ran into the tail of my voice.
export function looksLikeEcho(heard: string, spoken: string): boolean {
  const words = normalize(heard).split(" ").filter((w) => w.length >= 3);
  if (!words.length) return true;
  const said = new Set(normalize(spoken).split(" "));
  return words.filter((w) => said.has(w)).length / words.length >= 0.6;
}

export class Conversation {
  private openUntil = 0;

  // Live: the app's Escuta screen changes them without a restart.
  followUpMs = FOLLOW_UP_MS;
  summonMs = SUMMON_MS;
  echoGuardMs = ECHO_GUARD_MS;

  constructor(public wakeWords: string[]) {}

  open(ms: number, now = Date.now()) {
    this.openUntil = Math.max(this.openUntil, now + ms);
  }

  close() {
    this.openUntil = 0;
  }

  isOpen(now = Date.now()) {
    return now < this.openUntil;
  }

  decide(transcript: string, m: Moment): Action {
    const wake = matchWake(transcript, this.wakeWords);

    // The rest of a long request, cut by a pause: send it again, whole.
    if (m.lastAsk && m.isBusy && !m.hasAnswerStarted && !m.isSpeaking
        && m.startedAt - m.lastAsk.endedAt < CONTINUE_MS && !looksLikeEcho(transcript, m.recentSpoken ?? "")) {
      return { kind: "continue", text: `${m.lastAsk.text} ${wake.hasWake ? wake.rest : transcript.trim()}`.trim() };
    }

    // Started right as my voice stopped: echo only if it repeats what I said.
    const isEchoTail = !m.isSpeaking && m.startedAt < m.lastSilentAt + this.echoGuardMs
      && looksLikeEcho(transcript, m.recentSpoken ?? "");
    const overlapsMyVoice = m.isSpeaking || isEchoTail;

    // While I talk or work, only the name gets through: everything else may be my own echo.
    if (overlapsMyVoice || m.isBusy) {
      if (!wake.hasWake) return { kind: "ignore", reason: overlapsMyVoice ? "eco" : "ocupado" };
      this.open(this.summonMs, m.now);
      return { kind: "bargeIn", text: wake.rest };
    }

    if (wake.hasWake) {
      if (!wake.rest) {
        this.open(this.summonMs, m.now);
        return { kind: "summon" };
      }
      this.close();
      return { kind: "send", text: wake.rest };
    }

    // Open when he STARTED speaking: a long request begins inside the window and ends after it.
    if (this.isOpen(m.startedAt)) {
      this.close();
      return { kind: "send", text: wake.rest };
    }
    return { kind: "ignore", reason: "sem o nome" };
  }

  // After I finish answering, he can reply without saying the name.
  afterAnswer(now = Date.now()) {
    this.open(this.followUpMs, now);
  }
}
