import type { FormatoCampo, Produto } from "./catalogo.js";
import { ehObjeto } from "./tipos.js";

/**
 * O cartão de confirmação é montado por código a partir da simulação devolvida pela API,
 * com os campos que o time declarou no manifesto. Taxa e CET aparecem sempre e corretos,
 * sem depender da LLM lembrar de mostrá-los. O canal renderiza o cartão com o botão
 * "Confirmar", que volta para o grafo como uma ação estruturada.
 */
export interface Cartao {
  simulacaoId: string;
  titulo: string;
  linhas: Array<{ rotulo: string; valor: string }>;
}

export function cartaoDeConfirmacao(produto: Produto, simulacao: unknown): Cartao | undefined {
  if (!ehObjeto(simulacao) || typeof simulacao.id !== "string") return undefined;
  const linhas = produto.cartaoConfirmacao
    .filter((c) => simulacao[c.campo] !== undefined)
    .map((c) => ({ rotulo: c.rotulo, valor: formatar(simulacao[c.campo], c.formato) }));
  return { simulacaoId: simulacao.id, titulo: produto.nomeExibicao, linhas };
}

export function cartaoEmTexto(cartao: Cartao): string {
  const largura = Math.max(...cartao.linhas.map((l) => l.rotulo.length));
  const corpo = cartao.linhas.map((l) => `  ${l.rotulo.padEnd(largura)}  ${l.valor}`).join("\n");
  return `┌ ${cartao.titulo} — simulação ${cartao.simulacaoId}\n${corpo}\n└ Digite /confirmar para tocar em "Confirmar"`;
}

const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const decimal = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function formatar(valor: unknown, formato: FormatoCampo): string {
  const numero = Number(valor);
  switch (formato) {
    case "moeda":
      return moeda.format(numero);
    case "meses":
      return `${numero} meses`;
    case "anos":
      return numero === 1 ? "1 ano" : `${numero} anos`;
    case "percentualMes":
      return `${decimal.format(numero)}% a.m.`;
    case "percentualAno":
      return `${decimal.format(numero)}% a.a.`;
    default:
      return String(valor);
  }
}
