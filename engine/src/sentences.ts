// Turns the model's streaming text into whole sentences ready to be spoken, so the
// first one goes to the voice while the rest is still being written.

const MIN_CHARS = 12; // shorter pieces wait for the next one, so the voice doesn't stutter

export class SentenceBuffer {
  private pending = "";

  push(delta: string): string[] {
    this.pending += delta;
    const out: string[] = [];
    // A sentence ends at . ! ? … : ; followed by whitespace, or at a line break.
    const boundary = /([.!?…:;]+)(\s+)|\n+/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.pending))) {
      const end = match.index + (match[1]?.length ?? 0);
      const piece = this.pending.slice(start, end).trim();
      if (piece.length >= MIN_CHARS || (piece && match[0].includes("\n"))) {
        out.push(piece);
        start = boundary.lastIndex;
      }
    }
    this.pending = this.pending.slice(start);
    return out.map(forSpeech).filter(Boolean);
  }

  flush(): string[] {
    const last = forSpeech(this.pending);
    this.pending = "";
    return last ? [last] : [];
  }
}

// What the eye reads and the ear can't: markdown, links, paths, code, HTML comments.
export function forSpeech(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|\s)[~.]?\/[\w./-]*[\w/]/g, "$1")
    .replace(/^\s*(#+|[-*]|\d+\.)\s+/gm, "")
    .replace(/[*_|>#]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}
