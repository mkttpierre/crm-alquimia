import { describe, expect, it } from "vitest";
import { semWhatsapp } from "./sem-whatsapp";

describe("detecção de número sem WhatsApp", () => {
  it.each([
    ['evolution_400: {"response":{"message":[{"exists":false}]}}', true],
    ['{"response":{"exists":true}}', false],
    ['evolution_400: {"response": {"exists" : false', true],
    ['{"message":"\\"exists\\":false"}', false],
    ['{"exists":"false"}', false],
    ['timeout do canal', false],
    ['x'.repeat(250) + '{"exists":false}', true],
  ])("classifica %s", (erro, esperado) => expect(semWhatsapp(erro)).toBe(esperado));
});
