import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  type BaseCheckpointSaver,
  type LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { join } from "node:path";
import { Catalogo, definicaoTool, type Produto } from "./catalogo.js";
import { Executor } from "./executor.js";
import { carregarFluxos, opcoesDeTransicao, type Fluxo } from "./fluxo.js";
import type { Gateway } from "./gateway.js";
import { textoDe, type Modelo } from "./modelo.js";
import { Skills } from "./skills.js";
import { ehObjeto, type Acao, type Dados, type Passo, type Sessao } from "./tipos.js";

/**
 * Estado da conversa, gravado pelo checkpointer. Guarda só o que é da conversa:
 * mensagens de cliente e atendente, produto, etapa e os fatos que as tools produziram.
 * Token e CPF ficam na Sessao, que viaja na config de cada chamada.
 */
export const EstadoConversa = Annotation.Root({
  ...MessagesAnnotation.spec,
  produto: Annotation<string | null>({ reducer: (_antes, depois) => depois, default: () => null }),
  etapa: Annotation<string | null>({ reducer: (_antes, depois) => depois, default: () => null }),
  dados: Annotation<Dados>({ reducer: (antes, depois) => ({ ...antes, ...depois }), default: () => ({}) }),
  acao: Annotation<Acao | null>({ reducer: (_antes, depois) => depois, default: () => null }),
  /** Passos do turno atual (triagem, roteamento, tools), para observabilidade e evals. */
  rastro: Annotation<Passo[], Passo[] | { novoTurno: Passo[] }>({
    reducer: (antes, depois) => (Array.isArray(depois) ? [...antes, ...depois] : [...depois.novoTurno]),
    default: () => [],
  }),
});

export type Estado = typeof EstadoConversa.State;
export type Atualizacao = typeof EstadoConversa.Update;

export interface ConfigTurno {
  configurable: { thread_id: string; sessao: Sessao };
}

/** Visão do grafo compilado usada pelo CLI, pelas evals e pelos testes. */
export interface Agente {
  invoke(entrada: Atualizacao, config: ConfigTurno): Promise<Estado>;
  getState(config: { configurable: { thread_id: string } }): Promise<{ values: Estado }>;
}

export interface OpcoesAgente {
  /** Raiz do projeto, onde ficam catalogo/, fluxos/ e skills/. */
  raiz: string;
  modelo: Modelo;
  gateway: Gateway;
  checkpointer?: BaseCheckpointSaver;
  relogio?: () => Date;
  passosPorTurno?: number;
}

const INDEFINIDO = "indefinido";

// O LangGraph tipa os nomes dos nós como literais; aqui eles vêm do YAML, então usamos uma
// visão dinâmica do builder. O comportamento é o mesmo do StateGraph normal.
interface GrafoDinamico {
  addNode(nome: string, acao: (estado: Estado, config: LangGraphRunnableConfig) => Promise<Atualizacao> | Atualizacao): GrafoDinamico;
  addEdge(de: string, para: string): GrafoDinamico;
  addConditionalEdges(de: string, rota: (estado: Estado) => string, destinos: string[]): GrafoDinamico;
  compile(opcoes?: { checkpointer?: BaseCheckpointSaver }): Agente;
}

export function montarAgente(opcoes: OpcoesAgente) {
  const { modelo, gateway } = opcoes;
  const relogio = opcoes.relogio ?? (() => new Date());
  const passosPorTurno = opcoes.passosPorTurno ?? 6;

  const catalogo = Catalogo.carregar(join(opcoes.raiz, "catalogo"));
  const fluxos = carregarFluxos(join(opcoes.raiz, "fluxos"));
  const skills = new Skills(join(opcoes.raiz, "catalogo"), join(opcoes.raiz, "skills"));
  const executor = new Executor(catalogo, gateway, relogio);

  // Falha no boot se um produto aponta para fluxo inexistente ou tem operação em etapa que o fluxo não tem.
  for (const produto of catalogo.produtos.values()) {
    const fluxo = fluxos.get(produto.fluxo);
    if (!fluxo) throw new Error(`[catalogo/${produto.nome}] fluxo ${produto.fluxo} não existe em fluxos/`);
    for (const operacao of produto.operacoes) {
      if (!fluxo.nos[operacao.etapa]) {
        throw new Error(`[catalogo/${produto.nome}] ${operacao.operationId} usa a etapa ${operacao.etapa}, que não existe no fluxo ${fluxo.nome}`);
      }
    }
  }

  const nomeNo = (fluxo: string, parte: string) => `${fluxo}__${parte}`;

  // ---------------------------------------------------------------------------------------
  // Nó: ações estruturadas do canal (ex.: botão "Confirmar"). Determinístico, sem LLM.
  // ---------------------------------------------------------------------------------------
  const acoes = (estado: Estado): Atualizacao => {
    const atualizacao: Atualizacao = { acao: null, rastro: { novoTurno: [] } };
    const acao = estado.acao;
    if (!acao) return atualizacao;

    if (acao.tipo === "confirmar_simulacao") {
      const simulacao = estado.dados.simulacao;
      const aceita = ehObjeto(simulacao) && simulacao.id === acao.simulacaoId;
      if (aceita) {
        atualizacao.dados = { confirmacao: { simulacaoId: acao.simulacaoId, em: relogio().toISOString() } };
      }
      atualizacao.messages = [
        new HumanMessage(
          aceita
            ? `[Ação do canal] O cliente tocou em "Confirmar" no cartão da simulação ${acao.simulacaoId}.`
            : `[Ação do canal] O cliente tentou confirmar a simulação ${acao.simulacaoId}, que não é a simulação atual.`,
        ),
      ];
      atualizacao.rastro = { novoTurno: [{ tipo: "acao", detalhe: { ...acao, aceita } }] };
    }
    return atualizacao;
  };

  // ---------------------------------------------------------------------------------------
  // Nó: triagem. A LLM escolhe o produto, mas só entre os produtos do canal (enum).
  // ---------------------------------------------------------------------------------------
  const triagem = async (estado: Estado, config: LangGraphRunnableConfig): Promise<Atualizacao> => {
    const sessao = sessaoDe(config);
    const produtos = catalogo.produtosDoCanal(sessao.canal);
    const lista = produtos.map((p) => `- ${p.nome}: ${p.nomeExibicao}. ${p.descricao}`).join("\n");
    const sistema = `${skills.politica()}\n\n${skills.triagem()}\n\nProdutos disponíveis neste canal:\n${lista}`;

    let escolha = INDEFINIDO;
    try {
      escolha = await modelo.escolher(
        [new SystemMessage(sistema), new HumanMessage(transcricao(estado.messages))],
        [...produtos.map((p) => p.nome), INDEFINIDO],
      );
    } catch {
      // Escolha inválida conta como indefinido: o cliente recebe uma pergunta, não um palpite.
    }

    if (escolha !== INDEFINIDO) {
      return { produto: escolha, etapa: null, rastro: [{ tipo: "triagem", detalhe: { produto: escolha } }] };
    }
    const pergunta = await modelo.responder(
      [new SystemMessage(`${sistema}\n\nAinda não está claro qual produto o cliente quer. Responda com uma pergunta curta.`), ...estado.messages],
      [],
    );
    return { messages: [new AIMessage(textoDe(pergunta))], rastro: [{ tipo: "triagem", detalhe: { produto: null } }] };
  };

  // ---------------------------------------------------------------------------------------
  // Nó por fluxo: roteador. Transições automáticas não passam pela LLM; quando há escolha,
  // a LLM só pode devolver uma das etapas permitidas pelas guardas.
  // ---------------------------------------------------------------------------------------
  const roteador = (fluxo: Fluxo) => async (estado: Estado): Promise<Atualizacao> => {
    if (!estado.etapa || !fluxo.nos[estado.etapa]) {
      return { etapa: fluxo.inicio, rastro: [{ tipo: "roteamento", etapa: fluxo.inicio, detalhe: { motivo: "início do fluxo" } }] };
    }
    const atual = estado.etapa;
    const { automatica, permitidas } = opcoesDeTransicao(fluxo, atual, estado.dados, relogio());
    if (automatica) {
      return { etapa: automatica, rastro: [{ tipo: "transicao_automatica", etapa: automatica, detalhe: { de: atual } }] };
    }
    if (permitidas.length === 1) return {};

    const opcoesTexto = permitidas
      .map((e) => `- ${e}${e === atual ? " (etapa atual)" : ""}: ${fluxo.nos[e]?.objetivo ?? ""}`)
      .join("\n");
    const sistema =
      `Você é o roteador de um atendimento de crédito. A etapa atual é "${atual}". ` +
      `Leia a conversa e decida em qual etapa a próxima resposta deve acontecer. ` +
      `Só estas opções estão liberadas agora:\n${opcoesTexto}\nNa dúvida, fique na etapa atual.`;

    let escolhida = atual;
    try {
      escolhida = await modelo.escolher([new SystemMessage(sistema), new HumanMessage(transcricao(estado.messages))], permitidas);
    } catch {
      // Qualquer falha no roteamento mantém a etapa atual, que é sempre um estado válido.
    }
    return { etapa: escolhida, rastro: [{ tipo: "roteamento", etapa: escolhida, detalhe: { de: atual, permitidas } }] };
  };

  // ---------------------------------------------------------------------------------------
  // Nó por etapa: a LLM com a skill da etapa e só as tools da etapa. As mensagens de tool
  // ficam locais ao turno; o que importa delas vai para `dados`.
  // ---------------------------------------------------------------------------------------
  const noDeEtapa = (fluxo: Fluxo, etapa: string) => async (estado: Estado, config: LangGraphRunnableConfig): Promise<Atualizacao> => {
    const sessao = sessaoDe(config);
    if (!estado.produto) throw new Error("Etapa executada sem produto definido");
    const produto = catalogo.produto(estado.produto);
    const operacoes = catalogo.operacoes(produto.nome, etapa, sessao.canal);
    const tools = operacoes.map(definicaoTool);

    const dados: Dados = { ...estado.dados };
    const novosDados: Dados = {};
    const rastro: Passo[] = [];
    const sistema = new SystemMessage(promptDaEtapa(produto, fluxo, etapa, dados, tools.length > 0));
    const locais: BaseMessage[] = [];

    for (let passo = 0; passo < passosPorTurno; passo++) {
      const resposta = await modelo.responder([sistema, ...estado.messages, ...locais], tools);
      const chamadas = resposta.tool_calls ?? [];
      if (chamadas.length === 0) {
        return { messages: [new AIMessage(textoDe(resposta))], dados: novosDados, rastro };
      }
      locais.push(resposta);
      for (const chamada of chamadas) {
        const resultado = await executor.executar(
          { nome: chamada.name, argumentos: chamada.args ?? {} },
          { produto: produto.nome, etapa, sessao, dados },
        );
        Object.assign(dados, resultado.dados);
        Object.assign(novosDados, resultado.dados);
        locais.push(new ToolMessage({ tool_call_id: chamada.id ?? chamada.name, content: JSON.stringify(resultado.conteudo) }));
        rastro.push({
          tipo: "tool",
          etapa,
          detalhe: { tool: chamada.name, argumentos: chamada.args, ok: resultado.ok, resultado: resultado.conteudo },
        });
      }
    }
    return {
      messages: [new AIMessage("Desculpe, não consegui concluir agora. Pode me dizer de novo o que você precisa?")],
      dados: novosDados,
      rastro,
    };
  };

  const promptDaEtapa = (produto: Produto, fluxo: Fluxo, etapa: string, dados: Dados, temTools: boolean): string =>
    [
      skills.politica(),
      `# Produto: ${produto.nomeExibicao}\n${produto.descricao}`,
      `# Etapa atual: ${etapa}\nObjetivo: ${fluxo.nos[etapa]?.objetivo ?? ""}`,
      skills.daEtapa(produto.nome, etapa),
      temTools ? "" : "Nesta etapa você não tem tools: responda só com o que já está na conversa.",
      `# Dados já obtidos nesta conversa\n${JSON.stringify(dados, null, 2)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

  // ---------------------------------------------------------------------------------------
  // Nó por fluxo: depois da etapa, segue transições automáticas (ex.: contrato efetivado -> concluído).
  // ---------------------------------------------------------------------------------------
  const posEtapa = (fluxo: Fluxo) => (estado: Estado): Atualizacao => {
    if (!estado.etapa) return {};
    const { automatica } = opcoesDeTransicao(fluxo, estado.etapa, estado.dados, relogio());
    if (!automatica) return {};
    return { etapa: automatica, rastro: [{ tipo: "transicao_automatica", etapa: automatica, detalhe: { de: estado.etapa } }] };
  };

  // ---------------------------------------------------------------------------------------
  // Montagem do grafo a partir dos fluxos declarados.
  // ---------------------------------------------------------------------------------------
  const grafo = new StateGraph(EstadoConversa) as unknown as GrafoDinamico;
  grafo.addNode("acoes", acoes);
  grafo.addNode("triagem", triagem);
  grafo.addEdge(START, "acoes");

  const entradas: string[] = [];
  for (const fluxo of fluxos.values()) {
    const etapas = Object.keys(fluxo.nos);
    const noRoteador = nomeNo(fluxo.nome, "roteador");
    const noPos = nomeNo(fluxo.nome, "pos_etapa");
    entradas.push(noRoteador);

    grafo.addNode(noRoteador, roteador(fluxo));
    grafo.addNode(noPos, posEtapa(fluxo));
    for (const etapa of etapas) {
      grafo.addNode(nomeNo(fluxo.nome, etapa), noDeEtapa(fluxo, etapa));
      grafo.addEdge(nomeNo(fluxo.nome, etapa), noPos);
    }
    grafo.addConditionalEdges(
      noRoteador,
      (estado) => nomeNo(fluxo.nome, estado.etapa ?? fluxo.inicio),
      etapas.map((e) => nomeNo(fluxo.nome, e)),
    );
    grafo.addEdge(noPos, END);
  }

  const entradaDoProduto = (estado: Estado): string | undefined => {
    const produto = estado.produto ? catalogo.produtos.get(estado.produto) : undefined;
    return produto ? nomeNo(produto.fluxo, "roteador") : undefined;
  };
  grafo.addConditionalEdges("acoes", (estado) => entradaDoProduto(estado) ?? "triagem", ["triagem", ...entradas]);
  grafo.addConditionalEdges("triagem", (estado) => entradaDoProduto(estado) ?? END, [END, ...entradas]);

  return { agente: grafo.compile({ checkpointer: opcoes.checkpointer }), catalogo, fluxos };
}

function sessaoDe(config: LangGraphRunnableConfig): Sessao {
  const sessao = config.configurable?.sessao as Sessao | undefined;
  if (!sessao) throw new Error("Sessão ausente: passe configurable.sessao em cada chamada do grafo");
  return sessao;
}

/** Conversa recente em texto corrido, para triagem e roteamento. */
function transcricao(mensagens: BaseMessage[], ultimas = 8): string {
  const linhas = mensagens.slice(-ultimas).map((m) => `${m.getType() === "human" ? "Cliente" : "Atendente"}: ${textoDe(m)}`);
  return `Conversa recente:\n${linhas.join("\n")}`;
}
