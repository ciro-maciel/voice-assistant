// Finds the wake word in a transcript and returns what was said after it.
// Pure, so the matching can be tested without a microphone.

export type WakeMatch = { hasWake: boolean; rest: string };

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchWake(transcript: string, wakeWords: string[]): WakeMatch {
  // Walk the original words so the rest keeps its accents and punctuation.
  const words = transcript.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (wakeWords.includes(normalize(words[i]))) {
      const rest = words.slice(i + 1).join(" ").replace(/^[\s,.;:!?-]+/, "").trim();
      return { hasWake: true, rest };
    }
  }
  return { hasWake: false, rest: transcript.trim() };
}

// Whisper invents these on silence, noise and breathing.
const HALLUCINATIONS = [
  "legendas pela comunidade amara org", "obrigado", "obrigada", "tchau", "e ai",
  "inscreva se no canal", "legenda", "musica", "aplausos", "risos", "silencio",
];

export function isNoise(transcript: string): boolean {
  const n = normalize(transcript);
  const looksLikeAddress = /\b(www|https?)\b|\.(com|org|net|br)\b|\S+\/\S+/i.test(transcript);
  return n.length < 2 || HALLUCINATIONS.includes(n) || looksLikeAddress || /^\[.*\]$|^\(.*\)$/.test(transcript.trim());
}

// "Conversa nova", "nova conversa", "começa do zero", "esquece essa conversa": the whole
// sentence is the command, so a question that only mentions a new conversation still goes on.
const NEW_CONVERSATION = [
  /^(vamos )?(comecar |abrir |abre |abra |inicia |iniciar )?(uma )?(conversa nova|nova conversa)( por favor)?$/,
  /^(comeca|comecar|vamos comecar) do zero( por favor)?$/,
  /^esquece (essa|esta) conversa( por favor)?$/,
];

export function isNewConversation(text: string): boolean {
  const n = normalize(text);
  return NEW_CONVERSATION.some((re) => re.test(n));
}
