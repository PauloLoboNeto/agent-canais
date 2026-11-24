import { ehObjeto, type Dados } from "./tipos.js";

/**
 * Guardas são as regras que não podem depender da LLM obedecer a uma instrução.
 * Elas decidem quais transições do grafo existem e se uma tool pode ser executada.
 * Ficam em código, versionadas e testadas; manifestos e fluxos só as referenciam pelo nome.
 */
export type Guarda = (dados: Dados, agora: Date) => boolean;

export const GUARDAS: Readonly<Record<string, Guarda>> = {
  /** Existe uma simulação e ela ainda está dentro da validade informada pela API. */
  simulacao_valida: (dados, agora) => {
    const simulacao = dados.simulacao;
    if (!ehObjeto(simulacao) || typeof simulacao.id !== "string") return false;
    if (typeof simulacao.validaAte !== "string") return true;
    return new Date(simulacao.validaAte).getTime() > agora.getTime();
  },

  /**
   * O cliente confirmou exatamente a simulação atual pelo canal (botão do cartão).
   * Se ele simular de novo depois de confirmar, a confirmação antiga deixa de valer.
   */
  confirmacao_do_cliente: (dados) => {
    const { simulacao, confirmacao } = dados;
    return ehObjeto(simulacao) && ehObjeto(confirmacao) && confirmacao.simulacaoId === simulacao.id;
  },

  autorizacao_fgts_ok: (dados) => ehObjeto(dados.autorizacao) && dados.autorizacao.status === "AUTORIZADO",

  contrato_efetivado: (dados) => ehObjeto(dados.contrato) && dados.contrato.status === "EFETIVADO",
};

/** Devolve os nomes das guardas que falharam (lista vazia = tudo liberado). */
export function guardasQueFalham(nomes: readonly string[], dados: Dados, agora: Date): string[] {
  return nomes.filter((nome) => {
    const guarda = GUARDAS[nome];
    if (!guarda) throw new Error(`Guarda desconhecida: ${nome}`);
    return !guarda(dados, agora);
  });
}

export function guardaExiste(nome: string): boolean {
  return nome in GUARDAS;
}
