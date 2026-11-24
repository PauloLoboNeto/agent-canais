import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { montarAgente, type Agente, type ConfigTurno } from "../src/agente.js";
import type { DefinicaoTool } from "../src/catalogo.js";
import { Gateway } from "../src/gateway.js";
import { criarMockGateway, type OpcoesMock } from "../src/mockGateway.js";
import type { Modelo } from "../src/modelo.js";
import { ehObjeto, type Sessao } from "../src/tipos.js";

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

export type PassoRoteiro =
  | { escolher: string }
  | { responder: string }
  | { tool: string; args?: Record<string, unknown> };

/**
 * Modelo falso que segue um roteiro. Permite testar o grafo, as guardas e o executor sem
 * rede nem LLM. Como o adaptador real, `escolher` falha se a opção não estiver liberada.
 */
export class ModeloRoteirizado implements Modelo {
  readonly chamadas: Array<{ tipo: "responder" | "escolher"; tools?: string[]; opcoes?: string[]; sistema?: string }> = [];
  private contador = 0;

  constructor(private readonly roteiro: PassoRoteiro[]) {}

  get restante(): number {
    return this.roteiro.length;
  }

  async responder(mensagens: BaseMessage[], tools: DefinicaoTool[]): Promise<AIMessage> {
    const passo = this.roteiro.shift();
    this.chamadas.push({ tipo: "responder", tools: tools.map((t) => t.function.name), sistema: String(mensagens[0]?.content) });
    if (!passo || "escolher" in passo) throw new Error(`Roteiro esperava "responder", veio ${JSON.stringify(passo)}`);
    if ("tool" in passo) {
      this.contador += 1;
      return new AIMessage({ content: "", tool_calls: [{ name: passo.tool, args: passo.args ?? {}, id: `chamada_${this.contador}` }] });
    }
    return new AIMessage(passo.responder);
  }

  async escolher(_mensagens: BaseMessage[], opcoes: string[]): Promise<string> {
    const passo = this.roteiro.shift();
    this.chamadas.push({ tipo: "escolher", opcoes });
    if (!passo || !("escolher" in passo)) throw new Error(`Roteiro esperava "escolher", veio ${JSON.stringify(passo)}`);
    if (!opcoes.includes(passo.escolher)) throw new Error(`Escolha fora das opções permitidas: ${passo.escolher}`);
    return passo.escolher;
  }
}

export const SESSAO: Sessao = { cpf: "12345678901", token: "token-do-cliente", canal: "mobile", idConversa: "conversa-teste" };

export function prepararConversa(roteiro: PassoRoteiro[], opcoes: { mock?: OpcoesMock; sessao?: Partial<Sessao> } = {}) {
  const modelo = new ModeloRoteirizado(roteiro);
  const mock = criarMockGateway(opcoes.mock);
  const { agente } = montarAgente({
    raiz: RAIZ,
    modelo,
    gateway: new Gateway("https://gateway.teste", mock.fetch),
    checkpointer: new MemorySaver(),
  });
  const sessao = { ...SESSAO, ...opcoes.sessao };
  const config: ConfigTurno = { configurable: { thread_id: sessao.idConversa, sessao } };

  const falar = (texto: string) => agente.invoke({ messages: [new HumanMessage(texto)] }, config);
  const confirmar = async () => {
    const { values } = await agente.getState(config);
    const simulacao = values.dados.simulacao;
    if (!ehObjeto(simulacao)) throw new Error("Não há simulação para confirmar");
    return agente.invoke({ acao: { tipo: "confirmar_simulacao", simulacaoId: String(simulacao.id) } }, config);
  };

  return { modelo, banco: mock.banco, agente: agente as Agente, falar, confirmar, config };
}
