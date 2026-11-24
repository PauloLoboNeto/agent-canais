import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalogo } from "../src/catalogo.js";
import { Executor } from "../src/executor.js";
import { Gateway } from "../src/gateway.js";
import { criarMockGateway } from "../src/mockGateway.js";
import type { Dados } from "../src/tipos.js";
import { RAIZ, SESSAO } from "./apoio.js";

function preparar() {
  const catalogo = Catalogo.carregar(join(RAIZ, "catalogo"));
  const mock = criarMockGateway();
  const executor = new Executor(catalogo, new Gateway("https://gateway.teste", mock.fetch));
  return { executor, banco: mock.banco };
}

const simular = { nome: "consignado__simularContrato", argumentos: { ofertaId: "OF-CONS-1", valor: 10000, prazoMeses: 48 } };
const ctxSimulacao = { produto: "consignado", etapa: "simulacao", sessao: SESSAO, dados: {} as Dados };

describe("executor", () => {
  it("injeta o CPF da sessão e guarda o resultado em dados", async () => {
    const { executor, banco } = preparar();
    const resultado = await executor.executar(simular, ctxSimulacao);
    expect(resultado.ok).toBe(true);
    expect(banco.chamadas[0]?.corpo).toMatchObject({ cpf: SESSAO.cpf, valor: 10000 });
    expect(resultado.dados.simulacao).toMatchObject({ prazoMeses: 48 });
  });

  it("recusa CPF vindo da LLM: o parâmetro nem existe no schema dela", async () => {
    const { executor, banco } = preparar();
    const resultado = await executor.executar(
      { ...simular, argumentos: { ...simular.argumentos, cpf: "99999999999" } },
      ctxSimulacao,
    );
    expect(resultado.ok).toBe(false);
    expect(JSON.stringify(resultado.conteudo)).toContain("Argumentos inválidos");
    expect(banco.chamadas).toHaveLength(0);
  });

  it("valida limites do OpenAPI antes de chamar o gateway", async () => {
    const { executor, banco } = preparar();
    const resultado = await executor.executar({ ...simular, argumentos: { ...simular.argumentos, prazoMeses: 200 } }, ctxSimulacao);
    expect(resultado.ok).toBe(false);
    expect(JSON.stringify(resultado.conteudo)).toContain("prazoMeses");
    expect(banco.chamadas).toHaveLength(0);
  });

  it("recusa tool de outra etapa", async () => {
    const { executor } = preparar();
    const resultado = await executor.executar({ nome: "consignado__efetivarContrato", argumentos: {} }, ctxSimulacao);
    expect(JSON.stringify(resultado.conteudo)).toContain("não está disponível nesta etapa");
  });

  it("recusa tool de produto que não está no canal", async () => {
    const { executor } = preparar();
    const resultado = await executor.executar(
      { nome: "fgts__consultarCondicoes", argumentos: {} },
      { produto: "fgts", etapa: "oferta", sessao: { ...SESSAO, canal: "gerente" }, dados: {} },
    );
    expect(resultado.ok).toBe(false);
  });

  it("bloqueia a efetivação sem confirmação e não chama o gateway", async () => {
    const { executor, banco } = preparar();
    const { dados } = await executor.executar(simular, ctxSimulacao);
    const chamadasAntes = banco.chamadas.length;
    const resultado = await executor.executar(
      { nome: "consignado__efetivarContrato", argumentos: {} },
      { produto: "consignado", etapa: "efetivacao", sessao: SESSAO, dados },
    );
    expect(resultado.ok).toBe(false);
    expect(JSON.stringify(resultado.conteudo)).toContain("confirmacao_do_cliente");
    expect(banco.chamadas).toHaveLength(chamadasAntes);
  });

  it("confirmação de uma simulação antiga não vale para a nova", async () => {
    const { executor, banco } = preparar();
    const primeira = await executor.executar(simular, ctxSimulacao);
    const antiga = (primeira.dados.simulacao as { id: string }).id;
    const segunda = await executor.executar({ ...simular, argumentos: { ...simular.argumentos, valor: 12000 } }, ctxSimulacao);
    const dados: Dados = { ...segunda.dados, confirmacao: { simulacaoId: antiga } };
    const resultado = await executor.executar(
      { nome: "consignado__efetivarContrato", argumentos: {} },
      { produto: "consignado", etapa: "efetivacao", sessao: SESSAO, dados },
    );
    expect(resultado.ok).toBe(false);
    expect(banco.contratos).toHaveLength(0);
  });

  it("efetiva com confirmação, manda chave de idempotência e consome a confirmação", async () => {
    const { executor, banco } = preparar();
    const simulacao = await executor.executar(simular, ctxSimulacao);
    const id = (simulacao.dados.simulacao as { id: string }).id;
    const dados: Dados = { ...simulacao.dados, confirmacao: { simulacaoId: id } };
    const ctx = { produto: "consignado", etapa: "efetivacao", sessao: SESSAO, dados };

    const resultado = await executor.executar({ nome: "consignado__efetivarContrato", argumentos: {} }, ctx);
    expect(resultado.ok).toBe(true);
    expect(resultado.dados.confirmacao).toBeNull();
    expect(resultado.dados.contrato).toMatchObject({ status: "EFETIVADO", simulacaoId: id });

    // Mesmo que alguém reenvie a mesma escrita, o gateway devolve o mesmo contrato.
    await executor.executar({ nome: "consignado__efetivarContrato", argumentos: {} }, ctx);
    expect(banco.contratos).toHaveLength(1);
  });
});
