import { ehObjeto, type Dados, type Sessao } from "./tipos.js";

export class ErroDeContexto extends Error {}

/**
 * Preenche os parâmetros que nunca vêm da LLM, a partir da sessão autenticada ou dos fatos
 * já produzidos na conversa. Ex.: { cpf: "sessao.cpf", simulacaoId: "dados.confirmacao.simulacaoId" }.
 */
export function resolverContexto(
  mapa: Readonly<Record<string, string>>,
  sessao: Sessao,
  dados: Dados,
): Record<string, unknown> {
  const raizes: Record<string, unknown> = { sessao, dados };
  const resolvidos: Record<string, unknown> = {};
  for (const [parametro, origem] of Object.entries(mapa)) {
    const valor = origem.split(".").reduce<unknown>((atual, chave) => (ehObjeto(atual) ? atual[chave] : undefined), raizes);
    if (valor === undefined || valor === null) {
      throw new ErroDeContexto(`O parâmetro ${parametro} depende de ${origem}, que ainda não existe nesta conversa.`);
    }
    resolvidos[parametro] = valor;
  }
  return resolvidos;
}
