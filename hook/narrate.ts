// Narrates a list of chapters with the voice settings of speak.sh, saves them to the
// player history as one group, and plays them in order while the rest is generated.
// Usage: bun narrate.ts <chapters.json> <group> [project]
// Needs a Fish Audio voice: FISH_API_KEY and fishVoiceId, as in speak.sh.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const expand = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const DIR = process.env.VOICE_HOOK_DIR ?? join(homedir(), ".claude", "voice");
const HISTORY = join(DIR, "history");
const CONFIG_FILE = expand(process.env.VOICE_ASSISTANT_CONFIG ?? "~/.config/voice-assistant/config.json");
const config: Record<string, any> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
const keyFromFile = () => {
  if (!config.fishApiKeyFile || !existsSync(expand(config.fishApiKeyFile))) return undefined;
  return readFileSync(expand(config.fishApiKeyFile), "utf8").match(/^FISH_API_KEY=["']?([^"'\n]*)["']?$/m)?.[1];
};
const KEY = process.env.FISH_API_KEY ?? keyFromFile();
const VOICE_ID = process.env.FISH_VOICE_ID ?? config.fishVoiceId;
const MODEL = config.fishModel ?? "s2.1-pro";
const SPEED = typeof config.voiceSpeed === "number" ? config.voiceSpeed : 1;
const FFPLAY = Bun.which("ffplay") ?? "/opt/homebrew/bin/ffplay";
if (!KEY || !VOICE_ID) {
  console.error("narrate.ts needs FISH_API_KEY and a Fish voice id (fishVoiceId in the config, or FISH_VOICE_ID)");
  process.exit(1);
}
mkdirSync(HISTORY, { recursive: true });
const [file, group, project = group] = process.argv.slice(2);
const chapters: string[] = JSON.parse(readFileSync(file, "utf8"));
if (existsSync(join(DIR, "off"))) process.exit(0);
writeFileSync(join(DIR, "pid"), String(process.pid));

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const ids = chapters.map((_, i) => `${stamp}-${group}-${String(i + 1).padStart(2, "0")}`);

async function tts(text: string, out: string) {
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", model: MODEL },
    body: JSON.stringify({ text, reference_id: VOICE_ID, format: "mp3", latency: "balanced", prosody: { speed: SPEED } }),
  });
  if (!res.ok) throw new Error(`Fish ${res.status}: ${await res.text()}`);
  writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

// Three at a time; each chapter is logged in order, as soon as it and the ones before it exist.
const done: Promise<void>[] = [];
const slots = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
chapters.forEach((text, i) => {
  const slot = i % 3;
  slots[slot] = slots[slot].then(() => tts(text, join(HISTORY, `${ids[i]}.mp3`)));
  done.push(slots[slot]);
});

for (let i = 0; i < chapters.length; i++) {
  await done[i];
  appendFileSync(join(HISTORY, "index.jsonl"),
    JSON.stringify({ id: ids[i], at: new Date().toISOString(), text: chapters[i], project, group }) + "\n");
  const p = Bun.spawn([FFPLAY, "-nodisp", "-autoexit", "-loglevel", "error", join(HISTORY, `${ids[i]}.mp3`)]);
  await p.exited;
  if (p.exitCode !== 0) break;   // stopped from the player
}
