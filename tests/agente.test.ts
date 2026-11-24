import { describe, expect, it } from "vitest";
import { ehObjeto } from "../src/tipos.js";
import { prepararConversa } from "./apoio.js";

describe("grafo de atendimento", () => {
  it("contrata consignado de ponta a ponta: triagem, oferta, simulação, confirmação e efetivação", async () => {
    const conversa = prepararConversa([
      // Turno 1: triagem escolhe o produto; o fluxo começa na oferta (sem LLM no roteamento).
      { escolher: "consignado" },
      { tool: "consignado__consultarOfertas" },
      { responder: "Você tem até R$ 25.000,00 em até 84 meses. Quanto quer?" },
      // Turno 2: roteador escolhe simulação entre as opções liberadas.
      { escolher: "simulacao" },
      { tool: "consignado__simularContrato", args: { ofertaId: "OF-CONS-1", valor: 10000, prazoMeses: 48 } },
      { responder: "A parcela fica em R$ 328,00. Confira os detalhes no cartão." },
      // Turno 3: o toque em "Confirmar" libera a transição automática para a efetivação.
      { tool: "consignado__efetivarContrato" },
      { responder: "Contrato efetivado! O dinheiro cai em até 1 dia útil." },
    ]);

    const turno1 = await conversa.falar("quero fazer um consignado");
    expect(turno1.produto).toBe("consignado");
    expect(turno1.etapa).toBe("oferta");
    expect(conversa.modelo.chamadas[1]?.tools).toEqual(["consignado__consultarOfertas"]);

    const turno2 = await conversa.falar("10 mil em 48 meses");
    expect(turno2.etapa).toBe("simulacao");
    expect(conversa.modelo.chamadas.find((c) => c.tipo === "escolher" && c.opcoes?.includes("oferta"))?.opcoes).toEqual([
      "oferta",
      "simulacao",
    ]);
    expect(ehObjeto(turno2.dados.simulacao) && turno2.dados.simulacao.prazoMeses).toBe(48);

    const turno3 = await conversa.confirmar();
    expect(turno3.etapa).toBe("concluido");
    expect(turno3.dados.confirmacao).toBeNull();
    expect(conversa.banco.contratos).toHaveLength(1);
    expect(conversa.banco.contratos[0]).toMatchObject({ produto: "consignado", valor: 10000, prazoMeses: 48, cpf: "12345678901" });
    expect(turno3.rastro.map((p) => p.tipo)).toEqual(["acao", "transicao_automatica", "tool", "transicao_automatica"]);
    expect(conversa.modelo.restante).toBe(0);
  });

  it("não contrata sem o toque em Confirmar, mesmo que a LLM tente", async () => {
    const conversa = prepararConversa([
      { escolher: "consignado" },
      { tool: "consignado__consultarOfertas" },
      { responder: "Você tem até R$ 25.000,00." },
      { escolher: "simulacao" },
      { tool: "consignado__simularContrato", args: { ofertaId: "OF-CONS-1", valor: 5000, prazoMeses: 24 } },
      { responder: "Parcela de R$ 252,00." },
      // Turno 3: o roteador tenta ir para a efetivação, mas ela não está liberada.
      { escolher: "efetivacao" },
      // Dentro da simulação, a LLM tenta chamar a tool de contratação mesmo assim.
      { tool: "consignado__efetivarContrato" },
      { responder: "Para contratar, toque em Confirmar no cartão." },
    ]);

    await conversa.falar("quero consignado");
    await conversa.falar("5 mil em 24 meses");
    const turno3 = await conversa.falar("pode contratar!");

    expect(turno3.etapa).toBe("simulacao");
    expect(conversa.banco.contratos).toHaveLength(0);
    const tentativa = turno3.rastro.find((p) => p.tipo === "tool");
    expect(tentativa?.detalhe.ok).toBe(false);
    expect(JSON.stringify(tentativa?.detalhe.resultado)).toContain("não está disponível nesta etapa");
  });

  it("confirmar um cartão antigo não libera a efetivação", async () => {
    const conversa = prepararConversa([
      { escolher: "cdc" },
      { tool: "cdc__consultarLimite" },
      { responder: "Seu limite é de R$ 8.000,00." },
      { escolher: "simulacao" },
      { tool: "cdc__simularEmprestimo", args: { valor: 3000, prazoMeses: 12, diaVencimento: 10 } },
      { responder: "Parcela de R$ 339,00." },
      // A confirmação é recusada pelo nó de ações; o roteador só tem simulação e oferta liberadas.
      { escolher: "simulacao" },
      { responder: "Esse cartão não é o da simulação atual. Confira o cartão mais recente." },
    ]);
    await conversa.falar("quero um empréstimo pessoal");
    await conversa.falar("3 mil em 12x, vencimento dia 10");

    const turno = await conversa.agente.invoke(
      { acao: { tipo: "confirmar_simulacao", simulacaoId: "SIM-CDC-ANTIGA" } },
      conversa.config,
    );
    expect(turno.etapa).toBe("simulacao");
    expect(turno.dados.confirmacao).toBeUndefined();
    expect(turno.rastro[0]).toMatchObject({ tipo: "acao", detalhe: { aceita: false } });
    expect(conversa.banco.contratos).toHaveLength(0);
  });

  it("triagem indefinida faz uma pergunta e não entra em fluxo nenhum", async () => {
    const conversa = prepararConversa([{ escolher: "indefinido" }, { responder: "Você pensa em consignado, pessoal ou FGTS?" }]);
    const turno = await conversa.falar("quero dinheiro");
    expect(turno.produto).toBeNull();
    expect(turno.etapa).toBeNull();
  });

  it("FGTS só simula depois da autorização e segue sozinho para a simulação quando autorizado", async () => {
    const conversa = prepararConversa(
      [
        { escolher: "fgts" },
        { tool: "fgts__consultarCondicoes" },
        { responder: "Você antecipa até 10 saques-aniversário. Vamos verificar a autorização?" },
        { escolher: "autorizacao" },
        { tool: "fgts__verificarAutorizacao" },
        { responder: "Está autorizado! Quantos anos quer antecipar?" },
        // Próximo turno já começa na simulação (transição automática depois da autorização);
        // o roteador só pode ficar na simulação ou voltar para a autorização.
        { escolher: "simulacao" },
        { tool: "fgts__simularAntecipacao", args: { quantidadeParcelas: 5 } },
        { responder: "Você recebe R$ 4.000,00 agora." },
      ],
    );
    await conversa.falar("quero antecipar meu FGTS");
    const turno2 = await conversa.falar("sim, pode verificar");
    expect(turno2.etapa).toBe("simulacao");
    const turno3 = await conversa.falar("5 anos");
    expect(turno3.etapa).toBe("simulacao");
    expect(ehObjeto(turno3.dados.simulacao) && turno3.dados.simulacao.quantidadeParcelas).toBe(5);
  });

  it("FGTS com autorização pendente fica na etapa de autorização", async () => {
    const conversa = prepararConversa(
      [
        { escolher: "fgts" },
        { tool: "fgts__consultarCondicoes" },
        { responder: "Vamos verificar a autorização?" },
        { escolher: "autorizacao" },
        { tool: "fgts__verificarAutorizacao" },
        { responder: "Ainda falta autorizar o banco no app FGTS." },
      ],
      { mock: { cpfsSemAutorizacaoFgts: ["12345678901"] } },
    );
    await conversa.falar("FGTS");
    const turno2 = await conversa.falar("pode verificar");
    expect(turno2.etapa).toBe("autorizacao");
    expect(conversa.banco.simulacoes.size).toBe(0);
  });
});
