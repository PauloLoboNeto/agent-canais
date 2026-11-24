import { createHash } from "node:crypto";
import type { Catalogo } from "./catalogo.js";
import { ErroDeContexto, resolverContexto } from "./contexto.js";
import type { Gateway } from "./gateway.js";
import { guardasQueFalham } from "./guardas.js";
import type { Dados, Sessao } from "./tipos.js";
import { validar } from "./validacao.js";

export interface ChamadaTool {
  nome: string;
  argumentos: Record<string, unknown>;
}

export interface ContextoExecucao {
  produto: string;
  etapa: string;
  sessao: Sessao;
  dados: Dados;
}

export interface ResultadoTool {
  ok: boolean;
  /** O que volta para a LLM como resultado da tool. */
  conteudo: unknown;
  /** Fatos novos para gravar no estado (só quando a chamada deu certo). */
  dados: Dados;
}

/**
 * O único caminho entre a LLM e uma API. Cada barreira devolve um erro legível para a LLM
 * corrigir, em vez de deixar a chamada sair: um deslize vira mensagem de erro, não uma
 * contratação indevida.
 */
export class Executor {
  constructor(
    private readonly catalogo: Catalogo,
    private readonly gateway: Gateway,
    private readonly relogio: () => Date = () => new Date(),
  ) {}

  async executar(chamada: ChamadaTool, contexto: ContextoExecucao): Promise<ResultadoTool> {
    const { produto, etapa, sessao, dados } = contexto;

    // 1. Allowlist: só tools do produto, da etapa e do canal atuais.
    const operacao = this.catalogo.operacao(chamada.nome);
    if (!operacao || operacao.produto !== produto || operacao.etapa !== etapa || !operacao.canais.includes(sessao.canal)) {
      return falha(`A operação ${chamada.nome} não está disponível nesta etapa do atendimento.`);
    }

    // 2. Os argumentos da LLM batem com o schema (inclusive: nada de parâmetros extras, como CPF).
    const entrada = validar(operacao.schemaEntrada, chamada.argumentos ?? {});
    if (!entrada.ok) return falha(`Argumentos inválidos: ${entrada.erros}. Corrija e tente de novo.`);

    // 3. Guardas de negócio, avaliadas em código.
    const falhas = guardasQueFalham(operacao.requer, dados, this.relogio());
    if (falhas.length > 0) {
      return falha(`Bloqueado pelo runtime. Condições não atendidas: ${falhas.join(", ")}. Nada foi executado.`);
    }

    // 4. Parâmetros de contexto (CPF da sessão, simulação confirmada...) e validação completa.
    let parametros: Record<string, unknown>;
    try {
      parametros = { ...chamada.argumentos, ...resolverContexto(operacao.doContexto, sessao, dados) };
    } catch (erro) {
      if (erro instanceof ErroDeContexto) return falha(erro.message);
      throw erro;
    }
    const completa = validar(operacao.schemaCompleto, parametros);
    if (!completa.ok) return falha(`Dados de contexto inválidos: ${completa.erros}.`);

    // 5. Escritas levam chave de idempotência: repetir a mesma chamada não contrata duas vezes.
    const chave = operacao.efeito === "escrita" ? chaveIdempotencia(sessao.idConversa, operacao.nomeTool, parametros) : undefined;

    const resposta = await this.gateway.chamar(this.catalogo.produto(produto), operacao, parametros, sessao, chave);

    // Uma confirmação do cliente vale para uma única tentativa de escrita, com sucesso ou não.
    const consumo: Dados = operacao.efeito === "escrita" ? { confirmacao: null } : {};

    if (resposta.status >= 400) {
      return { ok: false, conteudo: { erro: { status: resposta.status, detalhe: resposta.corpo } }, dados: consumo };
    }
    return {
      ok: true,
      conteudo: resposta.corpo,
      dados: { ...consumo, ...(operacao.produz ? { [operacao.produz]: resposta.corpo } : {}) },
    };
  }
}

function falha(mensagem: string): ResultadoTool {
  return { ok: false, conteudo: { erro: mensagem }, dados: {} };
}

function chaveIdempotencia(idConversa: string, nomeTool: string, parametros: Record<string, unknown>): string {
  return createHash("sha256").update(`${idConversa}|${nomeTool}|${jsonEstavel(parametros)}`).digest("hex");
}

/** JSON com chaves ordenadas em todos os níveis, para a mesma chamada gerar a mesma chave. */
function jsonEstavel(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(jsonEstavel).join(",")}]`;
  if (valor && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${jsonEstavel(v)}`).join(",")}}`;
  }
  return JSON.stringify(valor);
}
