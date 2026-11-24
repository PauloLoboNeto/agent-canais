import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carregarFluxos, opcoesDeTransicao } from "../src/fluxo.js";
import { RAIZ } from "./apoio.js";

const fluxos = carregarFluxos(join(RAIZ, "fluxos"));
const padrao = fluxos.get("credito_padrao")!;
const fgts = fluxos.get("fgts")!;
const agora = new Date("2026-11-24T12:00:00Z");
const simulacao = { id: "SIM-1", validaAte: "2026-11-24T12:30:00Z" };

describe("fluxos declarativos", () => {
  it("FGTS herda o fluxo padrão e acrescenta a autorização", () => {
    expect(Object.keys(fgts.nos).sort()).toEqual(["autorizacao", "concluido", "efetivacao", "oferta", "simulacao"]);
    expect(fgts.inicio).toBe("oferta");
    expect(fgts.transicoes.oferta?.map((t) => t.para)).toEqual(["autorizacao"]);
    expect(fgts.transicoes.efetivacao).toEqual(padrao.transicoes.efetivacao);
  });

  it("sem confirmação, a efetivação não aparece como opção", () => {
    const opcoes = opcoesDeTransicao(padrao, "simulacao", { simulacao }, agora);
    expect(opcoes).toEqual({ automatica: undefined, permitidas: ["simulacao", "oferta"] });
  });

  it("com a simulação confirmada, a transição para a efetivação é automática", () => {
    const opcoes = opcoesDeTransicao(padrao, "simulacao", { simulacao, confirmacao: { simulacaoId: "SIM-1" } }, agora);
    expect(opcoes.automatica).toBe("efetivacao");
  });

  it("simulação vencida não libera a efetivação", () => {
    const depois = new Date("2026-11-24T13:00:00Z");
    const opcoes = opcoesDeTransicao(padrao, "simulacao", { simulacao, confirmacao: { simulacaoId: "SIM-1" } }, depois);
    expect(opcoes.automatica).toBeUndefined();
  });

  it("no FGTS, a efetivação também exige a autorização", () => {
    const dados = { simulacao, confirmacao: { simulacaoId: "SIM-1" }, autorizacao: { status: "PENDENTE" } };
    expect(opcoesDeTransicao(fgts, "simulacao", dados, agora).automatica).toBeUndefined();
    const autorizado = { ...dados, autorizacao: { status: "AUTORIZADO" } };
    expect(opcoesDeTransicao(fgts, "simulacao", autorizado, agora).automatica).toBe("efetivacao");
  });
});
