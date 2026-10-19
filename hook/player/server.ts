// Local voice player for the spoken summaries of hook/speak.sh: lists every spoken line, replays
// the cached audio, streams new lines live. Only on 127.0.0.1.
//   bun hook/player/server.ts   → http://127.0.0.1:4777
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.env.VOICE_HOOK_DIR ?? join(homedir(), ".claude", "voice");
const HISTORY = join(DIR, "history");
const INDEX = join(HISTORY, "index.jsonl");
const OFF = join(DIR, "off");
const PID = join(DIR, "pid");
const PORT = 4777;

type Item = { id: string; at: string; text: string; project: string };

function readItems(): Item[] {
  if (!existsSync(INDEX)) return [];
  return readFileSync(INDEX, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line) as Item; } catch { return null; }
    })
    .filter((i): i is Item => !!i && existsSync(join(HISTORY, `${i.id}.mp3`)))
    .reverse()
    .slice(0, 300);
}

const clients = new Set<ReadableStreamDefaultController>();
let known = new Set(readItems().map((i) => i.id));

function broadcast() {
  const items = readItems();
  const fresh = items.filter((i) => !known.has(i.id));
  known = new Set(items.map((i) => i.id));
  for (const item of fresh.reverse()) {
    const msg = `event: item\ndata: ${JSON.stringify(item)}\n\n`;
    for (const c of clients) {
      try { c.enqueue(msg); } catch { clients.delete(c); }
    }
  }
}

mkdirSync(HISTORY, { recursive: true });
if (!existsSync(INDEX)) writeFileSync(INDEX, "");
watch(HISTORY, () => setTimeout(broadcast, 150));

function stopSpeaking() {
  if (!existsSync(PID)) return;
  const pid = readFileSync(PID, "utf8").trim();
  Bun.spawnSync(["pkill", "-P", pid]);
  Bun.spawnSync(["kill", pid]);
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    const PUBLIC = ["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/site.webmanifest"];
    if (PUBLIC.includes(path)) return new Response(Bun.file(join(import.meta.dir, "public", path.slice(1))));
    if (path === "/") return new Response(Bun.file(join(import.meta.dir, "index.html")));

    if (path === "/api/items") return Response.json({ items: readItems(), muted: existsSync(OFF) });

    if (path.startsWith("/audio/")) {
      const id = path.slice(7).replace(/\.mp3$/, "");
      if (!/^[\w-]+$/.test(id)) return new Response("bad id", { status: 400 });
      const file = Bun.file(join(HISTORY, `${id}.mp3`));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "content-type": "audio/mpeg" } });
    }

    if (path === "/api/events") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) { ctrl = c; clients.add(c); c.enqueue(": connected\n\n"); },
        cancel() { clients.delete(ctrl); },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    if (req.method === "POST" && path === "/api/stop") { stopSpeaking(); return Response.json({ ok: true }); }

    if (req.method === "POST" && path === "/api/mute") {
      const { muted } = (await req.json()) as { muted: boolean };
      if (muted) { writeFileSync(OFF, ""); stopSpeaking(); } else rmSync(OFF, { force: true });
      return Response.json({ muted });
    }

    return new Response("not found", { status: 404 });
  },
});

// Keep SSE connections alive.
setInterval(() => { for (const c of clients) { try { c.enqueue(": ping\n\n"); } catch { clients.delete(c); } } }, 25000);

console.log(`voice player on http://127.0.0.1:${PORT}`);
