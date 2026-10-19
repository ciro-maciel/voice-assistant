// Only one assistant at a time: a new start stops the one already holding the HUD port,
// instead of dying with EADDRINUSE while the old one keeps the microphone.

function listenerOf(port: number): number | undefined {
  const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim();
  return out ? Number(out.split("\n")[0]) : undefined;
}

function commandOf(pid: number): string {
  return Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]).stdout.toString().trim();
}

export async function takeOver(port: number): Promise<number | undefined> {
  const pid = listenerOf(port);
  if (!pid || pid === process.pid) return undefined;
  if (!commandOf(pid).includes("src/main.ts")) {
    throw new Error(`a porta ${port} está ocupada por outro programa: ${commandOf(pid)}`);
  }
  // SIGTERM runs the old one's shutdown, which also stops its sox, whisper-server and Claude Code.
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50 && listenerOf(port); i++) await Bun.sleep(100);
  if (listenerOf(port)) process.kill(pid, "SIGKILL");
  await Bun.sleep(300);
  return pid;
}
