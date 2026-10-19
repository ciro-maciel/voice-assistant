// Loaded before every test (bunfig.toml): the tests never read the personal config file, and
// the defaults follow Brazilian Portuguese whatever the Mac's language is. Tests of English
// pass the language explicitly.
process.env.VOICE_ASSISTANT_CONFIG = "/nonexistent/voice-assistant-test-config.json";
process.env.ASSISTANT_LANGUAGES = "pt-BR";
delete process.env.FISH_VOICE_ID;
delete process.env.ASSISTANT_MODEL;
