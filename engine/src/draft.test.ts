import { describe, expect, test } from "bun:test";
import { buildRequest, Draft, findTrigger } from "./draft";

const PHRASES = ["pode fazer", "manda ver"];

describe("findTrigger", () => {
  test("finds the phrase blind to case and accents, and keeps what surrounds it", () => {
    expect(findTrigger("e fecha o retângulo, Pode Fazer. E capricha", PHRASES))
      .toEqual({ found: true, before: "e fecha o retângulo", after: "E capricha" });
  });
  test("the phrase alone has nothing around it", () => {
    expect(findTrigger("Pode fazer!", PHRASES)).toEqual({ found: true, before: "", after: "" });
  });
  test("whole words only: 'podem fazer' or 'pode refazer' are not the command", () => {
    expect(findTrigger("eles podem fazer isso amanhã", PHRASES).found).toBe(false);
    expect(findTrigger("você pode refazer o teste", PHRASES).found).toBe(false);
  });
  test("any of the configured phrases works", () => {
    expect(findTrigger("então manda ver", PHRASES)).toEqual({ found: true, before: "então", after: "" });
  });
});

describe("Draft", () => {
  test("keeps the pieces in order and drops the old ones", () => {
    const d = new Draft();
    d.add("no editor", 1_000);
    d.add("quando clicar fora do retângulo", 500_000);
    d.add("   ", 500_001);
    d.prune(600_000, 550_000);
    expect(d.entries.map((e) => e.text)).toEqual(["no editor", "quando clicar fora do retângulo"]);
    d.prune(600_000, 700_000);
    expect(d.text).toBe("quando clicar fora do retângulo");
  });
});

test("the request lists every piece with its time, and the words said with the command", () => {
  const at = new Date(2026, 9, 12, 9, 15, 3).getTime();
  const request = buildRequest([{ at, text: "no editor, quando clicar fora" }], "fecha o retângulo");
  expect(request).toContain("[09:15:03] no editor, quando clicar fora");
  expect(request).toContain("[agora] fecha o retângulo");
  expect(request).toContain("ignore o que não for para você e execute");
});
