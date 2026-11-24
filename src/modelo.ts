import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { DefinicaoTool } from "./catalogo.js";

/**
 * Tudo o que o runtime precisa de uma LLM. Trocar de provedor (Anthropic, OpenAI...) é
 * trocar a implementação, e os testes usam um modelo roteirizado sem rede.
 */
export interface Modelo {
  /** Responde à conversa, podendo pedir tools. */
  responder(mensagens: BaseMessage[], tools: DefinicaoTool[]): Promise<AIMessage>;
  /** Escolhe exatamente uma das opções (saída estruturada com enum). */
  escolher(mensagens: BaseMessage[], opcoes: string[]): Promise<string>;
}

export interface ConfigModelo {
  nome: string;
  provedor: string;
  parametros?: Record<string, unknown>;
}

export async function criarModelo(config: ConfigModelo): Promise<Modelo> {
  const { initChatModel } = await import("langchain/chat_models/universal");
  const llm = await initChatModel(config.nome, { modelProvider: config.provedor, ...config.parametros });

  return {
    async responder(mensagens, tools) {
      const executavel = tools.length > 0 ? llm.bindTools(tools) : llm;
      const resposta = await executavel.invoke(mensagens);
      return new AIMessage({
        content: resposta.content,
        tool_calls: resposta.tool_calls ?? [],
        id: resposta.id,
      });
    },

    async escolher(mensagens, opcoes) {
      const schema = {
        title: "escolha",
        description: "Escolha exatamente uma das opções permitidas.",
        type: "object",
        properties: {
          opcao: { type: "string", enum: opcoes },
          motivo: { type: "string", description: "Uma frase explicando a escolha." },
        },
        required: ["opcao", "motivo"],
      };
      const resposta = (await llm.withStructuredOutput(schema).invoke(mensagens)) as { opcao?: string };
      if (!resposta.opcao || !opcoes.includes(resposta.opcao)) {
        throw new Error(`Escolha fora das opções permitidas: ${String(resposta.opcao)}`);
      }
      return resposta.opcao;
    },
  };
}

/** Extrai o texto de uma resposta (alguns provedores devolvem uma lista de blocos). */
export function textoDe(mensagem: BaseMessage): string {
  const { content } = mensagem;
  if (typeof content === "string") return content;
  return content
    .map((bloco) => (typeof bloco === "string" ? bloco : bloco.type === "text" ? String(bloco.text ?? "") : ""))
    .join("")
    .trim();
}
