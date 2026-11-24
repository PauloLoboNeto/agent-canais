import { describe, expect, it } from "vitest";
import { passHatK } from "../src/passK.js";

describe("pass^k", () => {
  it("é a média de acertos quando k = 1", () => {
    expect(passHatK(4, 3, 1)).toBe(0.75);
  });

  it("cai rápido quando o agente é inconsistente", () => {
    expect(passHatK(4, 3, 2)).toBe(0.5);
    expect(passHatK(4, 3, 4)).toBe(0);
  });

  it("é 1 quando acerta todas", () => {
    expect(passHatK(8, 8, 8)).toBe(1);
  });
});
