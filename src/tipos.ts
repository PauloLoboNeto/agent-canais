/** Tipos compartilhados pelo runtime. */

export type Efeito = "leitura" | "escrita";

/**
 * Quem está sendo atendido e por onde. Vem do canal já autenticado e trafega só na
 * config de cada chamada do grafo: nunca entra no estado, então não é gravada pelo
 * checkpointer nem enviada para a LLM.
 */
export interface Sessao {
  cpf: string;
  /** Token do próprio cliente. O gateway e as APIs decidem o que ele pode ver. */
  token: string;
  /** mobile | gerente | operacoes */
  canal: string;
  idConversa: string;
}

/** Fatos que as tools produziram na conversa (oferta, simulação, contrato...). */
export type Dados = Record<string, unknown>;

export type JsonSchema = Record<string, unknown>;

/** Ação estruturada vinda do canal, como o toque no botão "Confirmar" do cartão. */
export type Acao = { tipo: "confirmar_simulacao"; simulacaoId: string };

/** Registro do que aconteceu em cada turno, para observabilidade (Langfuse, logs). */
export interface Passo {
  tipo: "triagem" | "roteamento" | "tool" | "transicao_automatica" | "acao";
  etapa?: string | null;
  detalhe: Record<string, unknown>;
}

export function ehObjeto(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}
