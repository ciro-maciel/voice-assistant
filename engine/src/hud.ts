// The HUD: one local page that shows what I hear, think and say, and a small API so a
// keyboard shortcut (macOS Shortcuts running curl) can call me without the name.
import { audioBridge } from "./audio-bridge";
import { HUD_PORT } from "./config";

type Handlers = {
  state: () => unknown;
  options: () => unknown;
  settings: (patch: Record<string, string>) => Promise<unknown>;
  history: () => unknown;
  sample: () => void;
  listen: () => void;
  newConversation: () => void;
  act: () => void;
  clearDraft: () => void;
  say: (text: string) => void;
  stop: () => void;
  mute: () => boolean;
};

const page = Bun.file(new URL("./hud.html", import.meta.url));

export function startHud(handlers: Handlers) {
  const clients = new Set<ReadableStreamDefaultController<string>>();

  Bun.serve({
    port: HUD_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    // The Mac app's microphone and speaker, with echo cancellation (audio-bridge.ts).
    websocket: {
      open: (ws) => audioBridge.open(ws),
      message: (ws, data) => audioBridge.message(ws, data),
      close: (ws) => audioBridge.close(ws),
      maxPayloadLength: 32 * 1024 * 1024,
    },
    async fetch(req, server) {
      const { pathname } = new URL(req.url);
      if (pathname === "/audio") {
        if (server.upgrade(req)) return undefined;
        return new Response("esperava um WebSocket", { status: 400 });
      }
      if (req.method === "GET" && pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (req.method === "GET" && pathname === "/events") {
        let self: ReadableStreamDefaultController<string>;
        return new Response(
          new ReadableStream<string>({
            start(c) { self = c; clients.add(c); },
            cancel() { clients.delete(self); },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        );
      }
      if (req.method === "GET" && pathname === "/state") return Response.json(handlers.state());
      if (req.method === "GET" && pathname === "/options") return Response.json(handlers.options());
      if (req.method === "POST" && pathname === "/settings") return Response.json(await handlers.settings(await req.json()));
      if (req.method === "GET" && pathname === "/history") return Response.json(handlers.history());
      if (req.method === "POST" && pathname === "/sample") { handlers.sample(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/act") { handlers.act(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/draft/clear") { handlers.clearDraft(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/new") { handlers.newConversation(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/listen") { handlers.listen(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/stop") { handlers.stop(); return Response.json({ ok: true }); }
      if (req.method === "POST" && pathname === "/mute") return Response.json({ isMuted: handlers.mute() });
      if (req.method === "POST" && pathname === "/say") {
        const { text } = (await req.json()) as { text?: string };
        if (text?.trim()) handlers.say(text.trim());
        return Response.json({ ok: true });
      }
      return new Response("não encontrado", { status: 404 });
    },
  });

  return {
    send(event: string, data: unknown) {
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const c of clients) {
        try { c.enqueue(msg); } catch { clients.delete(c); }
      }
    },
  };
}
