import { describe, expect, test } from "bun:test";
import { buildQuestion, parseVerdict } from "./directed";

describe("parseVerdict", () => {
  test("reads the model's JSON line, also with text around it", () => {
    expect(parseVerdict('{"para_mim": true, "motivo": "pedido sobre o editor"}'))
      .toEqual({ isDirected: true, reason: "pedido sobre o editor" });
    expect(parseVerdict('Resposta: {"para_mim": false, "motivo": "conversa ao telefone"} ok'))
      .toEqual({ isDirected: false, reason: "conversa ao telefone" });
  });
  test("anything else is 'not for me': the words go to the draft, never lost", () => {
    expect(parseVerdict("sim").isDirected).toBe(false);
    expect(parseVerdict('{"para_mim": "true"}').isDirected).toBe(false);
    expect(parseVerdict("{quebrado").isDirected).toBe(false);
  });
});

test("the question carries the recent exchanges, the draft and the new utterance", () => {
  const q = buildQuestion("fecha o retângulo", [
    { role: "user", text: "no editor, quando clicar fora" },
    { role: "tool", text: "Bash: ls" },
    { role: "assistant", text: "Quer que eu mude o comportamento do clique?" },
  ], ["no editor"], "Ana");
  expect(q).toContain("Ana: no editor, quando clicar fora");
  expect(q).toContain("Assistente: Quer que eu mude o comportamento do clique?");
  expect(q).not.toContain("Bash: ls");
  expect(q).toContain("- no editor");
  expect(q).toContain('Frase nova: "fecha o retângulo"');
});
