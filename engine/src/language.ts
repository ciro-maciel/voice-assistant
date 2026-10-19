// Which language the assistant speaks and shows. Two of them: Brazilian Portuguese and English.
// - The conversation (what it says out loud, the prompts sent to Claude, Whisper's language)
//   follows the config's `language` key; without it, the Mac's language.
// - The words on screen (statuses and reasons the app and the panel show) follow the Mac's
//   language, like the app around them.
// The rule is the same everywhere: a language that starts with "pt" is Portuguese, anything
// else is English.

export type Language = "en" | "pt-BR";

export function chooseLanguage(configured: string | undefined, preferred: string[]): Language {
  const pick = (code: string) => (code.trim().toLowerCase().startsWith("pt") ? "pt-BR" : "en");
  if (configured?.trim()) return pick(configured);
  return preferred[0] ? pick(preferred[0]) : "en";
}

/// The Mac's preferred languages, first one first. The app passes its own (so `-AppleLanguages`
/// reaches the engine); a terminal run reads them from the system.
export function macLanguages(env: Record<string, string | undefined> = process.env): string[] {
  if (env.ASSISTANT_LANGUAGES?.trim()) return env.ASSISTANT_LANGUAGES.split(",").map((l) => l.trim()).filter(Boolean);
  try {
    const out = Bun.spawnSync(["defaults", "read", "-g", "AppleLanguages"]).stdout.toString();
    const list = [...out.matchAll(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?\s*,?\s*$/gm)].map((m) => m[1]);
    if (list.length) return list;
  } catch { /* not a Mac, or no defaults */ }
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (fromEnv) return [fromEnv.split(".")[0]];
  return [Intl.DateTimeFormat().resolvedOptions().locale];
}

/// Whisper's code for a language.
export const whisperCode = (lang: Language) => (lang === "pt-BR" ? "pt" : "en");
