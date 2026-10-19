// Every short text the engine shows or says, in both languages. Long prompts live next to the
// code that sends them (settings.ts, directed.ts, draft.ts, memory.ts). A key missing in
// Portuguese falls back to English, never to the key's name.
import type { Language } from "./language";

const en = {
  // Spoken (the conversation's language).
  "say.newConversation": "New conversation.",
  "say.sample": "This is my voice, at the current speed.",
  "say.nothingDrafted": "I have nothing noted since the last action.",
  "say.deadMic": "I can't hear anything through the microphone. {help}",
  "say.claudeDown": "Claude Code is not opening. I stopped trying; the reason is in the log.",
  "say.ready": "I'm listening.",
  "say.readyResumed": "I'm listening. Picking up our earlier conversation.",

  // On screen (the Mac's language): statuses, errors and reasons.
  "status.journalSaved": "conversation summary saved to the journal",
  "status.newConversation": "new conversation",
  "status.microphone": "microphone: {device}",
  "status.sessionReopened": "session reopened with the new settings",
  "status.whisperLoading": "loading Whisper {model}",
  "status.whisper": "Whisper: {model}",
  "status.echoOn": "echo cancellation on",
  "status.echoOff": "echo cancellation off",
  "status.micBack": "microphone is back: {device}",
  "status.brainReady": "brain ready",
  "error.ear": "ear: {error}",
  "error.voice": "voice: {error}",
  "error.deadMic": "the microphone ({device}) only delivers silence. {help}",
  "error.deadMicHelp": "Allow the app that opened me in System Settings, Privacy & Security, Microphone, and restart me.",
  "error.claudeGaveUp": "the Claude Code session failed {count} times in a row and I stopped reopening it{reason}",
  "error.claudeExited": "the Claude Code session exited (code {code}){reason}; reopening in {seconds} s",
  "heard.drafted": "{why}in the draft ({count}); say “{phrase}” to run it",
  "heard.notForMe": "not for me: {reason}",
  "heard.actionPhrase.one": "action phrase: {count} piece noted",
  "heard.actionPhrase.other": "action phrase: {count} pieces noted",
  "heard.nothing": "(nothing)",
  "heard.lostAudio": "(audio lost)",
  "heard.noise": "Whisper returned something that looks like noise ({seconds} s of audio)",
  "heard.empty": "Whisper understood nothing ({seconds} s of audio)",
  "heard.transcriptionFailed": "transcription failed: {error}",
  "reason.noName": "no name, and the reply window was closed",
  "reason.echo": "started right on my voice: treated as echo",
  "reason.busy": "I was working; only the name interrupts",
  "device.systemDefault": "system default",
  "classifier.late": "the classifier took too long",
  "classifier.noJson": "answer without JSON",
  "classifier.badJson": "invalid JSON",

  // The actions that can need a spoken yes (labels on the Brain screen; the voice rules use them too).
  "confirm.push": "Push",
  "confirm.deploy": "Deploy",
  "confirm.publish": "Publish",
  "confirm.message": "Message someone",
  "confirm.delete": "Delete",
  "confirm.pay": "Pay",
};

export type Key = keyof typeof en;

const ptBR: Partial<Record<Key, string>> = {
  "say.newConversation": "Conversa nova.",
  "say.sample": "Esta é a minha voz, na velocidade de agora.",
  "say.nothingDrafted": "Não tenho nada anotado desde a última ação.",
  "say.deadMic": "Não estou ouvindo nada pelo microfone. {help}",
  "say.claudeDown": "O Claude Code não está abrindo. Parei de tentar; o motivo está no log.",
  "say.ready": "Estou ouvindo.",
  "say.readyResumed": "Estou ouvindo. Continuo a conversa de antes.",

  "status.journalSaved": "resumo da conversa guardado no diário",
  "status.newConversation": "conversa nova",
  "status.microphone": "microfone: {device}",
  "status.sessionReopened": "sessão reaberta com os ajustes novos",
  "status.whisperLoading": "carregando o Whisper {model}",
  "status.whisper": "Whisper: {model}",
  "status.echoOn": "cancelamento de eco ligado",
  "status.echoOff": "cancelamento de eco desligado",
  "status.micBack": "microfone voltou: {device}",
  "status.brainReady": "cérebro pronto",
  "error.ear": "ouvido: {error}",
  "error.voice": "voz: {error}",
  "error.deadMic": "o microfone ({device}) só entrega silêncio. {help}",
  "error.deadMicHelp": "Libere o app que me abriu em Ajustes do Sistema, Privacidade e Segurança, Microfone, e me reinicie.",
  "error.claudeGaveUp": "a sessão do Claude Code falhou {count} vezes seguidas e eu parei de reabrir{reason}",
  "error.claudeExited": "a sessão do Claude Code saiu (código {code}){reason}; reabrindo em {seconds} s",
  "heard.drafted": "{why}no rascunho ({count}); diga “{phrase}” para executar",
  "heard.notForMe": "não era para mim: {reason}",
  "heard.actionPhrase.one": "comando de ação: {count} trecho anotado",
  "heard.actionPhrase.other": "comando de ação: {count} trechos anotados",
  "heard.nothing": "(nada)",
  "heard.lostAudio": "(áudio perdido)",
  "heard.noise": "o Whisper devolveu algo que parece ruído ({seconds} s de áudio)",
  "heard.empty": "o Whisper não entendeu nada ({seconds} s de áudio)",
  "heard.transcriptionFailed": "a transcrição falhou: {error}",
  "reason.noName": "sem o nome, e a janela de resposta estava fechada",
  "reason.echo": "começou colada à minha voz: tratei como eco",
  "reason.busy": "eu estava trabalhando; só o nome interrompe",
  "device.systemDefault": "padrão do sistema",
  "classifier.late": "o classificador demorou",
  "classifier.noJson": "resposta sem JSON",
  "classifier.badJson": "JSON inválido",

  "confirm.push": "Push",
  "confirm.deploy": "Deploy",
  "confirm.publish": "Publicar",
  "confirm.message": "Mandar mensagem a alguém",
  "confirm.delete": "Apagar",
  "confirm.pay": "Pagar",
};

const TABLES: Record<Language, Partial<Record<Key, string>>> = { en, "pt-BR": ptBR };

export function t(lang: Language, key: Key, params: Record<string, string | number> = {}): string {
  const template = TABLES[lang][key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/// Every key, for the test that both languages are complete.
export const KEYS = Object.keys(en) as Key[];
export const hasKey = (lang: Language, key: Key) => TABLES[lang][key] !== undefined;
