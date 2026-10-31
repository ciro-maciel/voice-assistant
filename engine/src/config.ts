// Every knob of Assistant in one place. What is personal (the name it answers to, the voice, the
// folders it works in, the microphones) comes from a config file outside the repository:
// ~/.config/voice-assistant/config.json, or the file VOICE_ASSISTANT_CONFIG names. Every key is
// optional; config.example.json at the repository root lists them all.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chooseLanguage, type Language, macLanguages, whisperCode } from "./language";

export type UserConfig = {
  /// The conversation's language: "pt-BR" or "en". Default: the Mac's language (pt → Portuguese,
  /// anything else → English). It sets the voice rules, the spoken phrases and Whisper's default.
  language?: string;
  /// The name first, then the ways Whisper mishears it. Lowercase.
  wakeWords?: string[];
  /// How the assistant refers to you in its instructions ("Ana"). Empty: "a pessoa".
  userName?: string;
  /// Where the Claude Code session runs (its CLAUDE.md and memory). Default: your home folder.
  workingDir?: string;
  /// Extra folders the session may read and edit (--add-dir). Also editable in the app.
  folders?: string[];
  /// Microphones by name, in order of preference; the first one connected wins.
  inputPreference?: string[];
  /// Where the ggml Whisper models are (ggml-<name>.bin).
  whisperModelsDir?: string;
  whisperModel?: string;
  /// Whisper's language code ("pt", "en", "auto").
  whisperLanguage?: string;
  /// An example sentence Whisper reads before each utterance; {name} becomes the wake word.
  whisperPrompt?: string;
  /// Fish Audio voice (reference_id). Without it, the Mac's own voice speaks.
  fishVoiceId?: string;
  voiceName?: string;
  voiceSpeed?: number;
  fishModel?: string;
  /// A dotenv file holding FISH_API_KEY=…, read when the variable is not in the environment
  /// (an app opened from the Finder gets no shell environment).
  fishApiKeyFile?: string;
  /// The Mac voice (`say -v ?`) used when Fish is not configured or does not answer.
  fallbackVoice?: string;
  /// Claude model for the conversation.
  brainModel?: string;
  /// Where history, journal, session and the app's settings live.
  dataDir?: string;
  /// Extra lines appended to the voice rules of the session (your context, in your words).
  instructions?: string;
};

const expand = (path: string) => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export const CONFIG_FILE = expand(process.env.VOICE_ASSISTANT_CONFIG ?? "~/.config/voice-assistant/config.json");

function readConfig(file: string): UserConfig {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.log(`config: ${file} is not valid JSON, using defaults (${String(error)})`);
  }
  return {};
}

export const CONFIG = readConfig(CONFIG_FILE);

const list = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") && v.length ? v : undefined;
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

// The conversation follows the config (else the Mac); the words on screen follow the Mac.
const MAC_LANGUAGES = macLanguages();
export const LANGUAGE: Language = chooseLanguage(text(CONFIG.language), MAC_LANGUAGES);
export const UI_LANGUAGE: Language = chooseLanguage(undefined, MAC_LANGUAGES);

export const WORKING_DIR = expand(text(CONFIG.workingDir) ?? "~");
export const FOLDERS = (list(CONFIG.folders) ?? []).map(expand);
export const USER_NAME = text(CONFIG.userName);
export const INSTRUCTIONS = text(CONFIG.instructions) ?? "";

// The first entry is the name; the rest are what Whisper writes when it mishears it.
// "assistant" works in both languages; Whisper writes it "assistente" when it hears Portuguese.
export const WAKE_WORDS = (list(CONFIG.wakeWords) ?? (LANGUAGE === "pt-BR" ? ["assistant", "assistente"] : ["assistant"])).map((w) => w.toLowerCase());

// HUD and its local API (POST /listen, /say, /stop, /mute).
export const HUD_PORT = 4780;

// Ear: local Whisper, nothing leaves the Mac.
export const WHISPER_PORT = 4781;
export const DATA_DIR = expand(text(CONFIG.dataDir) ?? "~/Library/Application Support/voice-assistant");
export const WHISPER_MODELS_DIR = expand(text(CONFIG.whisperModelsDir) ?? join(DATA_DIR, "models"));
export const WHISPER_MODEL = text(CONFIG.whisperModel) ?? "large-v3-turbo";
export const WHISPER_LANGUAGE = text(CONFIG.whisperLanguage) ?? whisperCode(LANGUAGE);
// A natural sentence, not a word list: Whisper imitates the prompt's style, and a list of
// names made it answer in comma-separated fragments.
export const WHISPER_PROMPT_TEMPLATE = text(CONFIG.whisperPrompt)
  ?? (LANGUAGE === "pt-BR" ? "{name}, olha o deploy do site e o commit no repositório, por favor." : "{name}, check the site's deploy and the last commit in the repository, please.");
export const SAMPLE_RATE = 16000;
// Which microphone, in order of preference; the first one connected wins (a laptop's own mic
// goes silent with the lid closed, so an external one usually comes first). ASSISTANT_INPUT
// forces one by name.
export const INPUT_PREFERENCE = list(CONFIG.inputPreference) ?? [];

// Brain: one persistent Claude Code session, kept warm between turns.
export const BRAIN_MODEL = process.env.ASSISTANT_MODEL ?? text(CONFIG.brainModel) ?? "claude-haiku-5-5";
// Which claude to run, by full path, not by PATH order: an old global install earlier in the
// PATH may not know the streaming flags. ASSISTANT_CLAUDE forces one.
export const CLAUDE_CANDIDATES = [
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".npm-global", "bin", "claude"),
  join(homedir(), ".claude", "local", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

// Mouth: Fish Audio when a voice and a key are configured; the Mac's voice otherwise.
export const FISH_VOICE_ID = process.env.FISH_VOICE_ID ?? text(CONFIG.fishVoiceId) ?? "";
export const FISH_MODEL = text(CONFIG.fishModel) ?? "s2.1-pro";
export const VOICE_SPEED = typeof CONFIG.voiceSpeed === "number" ? CONFIG.voiceSpeed : 1.0;
export const VOICE_NAME = text(CONFIG.voiceName) ?? "";
export const FALLBACK_VOICE = text(CONFIG.fallbackVoice) ?? (LANGUAGE === "pt-BR" ? "Luciana" : "Samantha");

/// FISH_API_KEY from the environment, else from the dotenv file the config names.
export function fishApiKey(): string | undefined {
  if (process.env.FISH_API_KEY) return process.env.FISH_API_KEY;
  const file = text(CONFIG.fishApiKeyFile);
  if (!file) return undefined;
  try {
    return readFileSync(expand(file), "utf8").match(/^FISH_API_KEY=["']?([^"'\n]*)["']?$/m)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Every closed row of every conversation, for the app's History screen.
export const HISTORY_FILE = join(DATA_DIR, "history.jsonl");
// The Claude Code session to resume after a restart, and the journal of past conversations (memory.ts).
export const SESSION_FILE = join(DATA_DIR, "session.json");
export const JOURNAL_DIR = join(DATA_DIR, "journal");
// What was chosen in the app: microphone, Claude model, Whisper model (settings.ts).
export const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// Conversation timing.
export const FOLLOW_UP_MS = 60_000;   // after I finish talking, you can answer without the name (15 s was too short to think)
export const SUMMON_MS = 8_000;       // after the name alone (or the hotkey), how long I wait
export const ECHO_GUARD_MS = 1_200;   // speech that started this close to my own voice is echo (speaker buffer and room reverb)

/// Finds a command-line tool: Homebrew first (an app opened from the Finder has a minimal PATH),
/// then the PATH.
export function tool(name: string): string {
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return Bun.which(name) ?? name;
}
