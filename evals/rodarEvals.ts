import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { montarAgente, type Atualizacao } from "../src/agente.js";
import { cartaoDeConfirmacao, cartaoEmTexto } from "../src/apresentacao.js";
import { carregarConfig, RAIZ } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { criarMockGateway, type BancoMock } from "../src/mockGateway.js";
import { criarModelo, textoDe, type Modelo } from "../src/modelo.js";
import { passHatK } from "../src/passK.js";
import { ehObjeto, type Sessao } from "../src/tipos.js";

/**
 * Evals no estilo τ-bench: um usuário simulado por LLM conversa com o agente, e o resultado
 * é o estado final do banco (gateway mock). Cada tarefa roda k vezes para medir pass^k.
 *
 *   npm run evals                         (todas as tarefas, k do config)
 *   npm run evals -- --k 8 --tarefa fgts  (filtra por id)
 *
 * Rode antes de publicar qualquer mudança em skill, manifesto, fluxo ou modelo.
 */

interface Tarefa {
  id: string;
  usuario: string;
  canal?: string;
  cpf?: string;
  fgtsPendente?: boolean;
  esperado: { contratos: Array<Record<string, unknown>>; semSimulacao?: boolean };
}

const FIM = "###FIM###";
const CONFIRMAR = "/confirmar";

const { values: args } = parseArgs({
  options: {
    k: { type: "string" },
    tarefa: { type: "string" },
    arquivo: { type: "string", default: join(RAIZ, "evals", "tarefas.yaml") },
  },
});

const config = carregarConfig();
const k = Number(args.k ?? config.avaliacao.tentativasPorTarefa);
const tarefas = (parse(readFileSync(args.arquivo!, "utf8")) as Tarefa[]).filter((t) => !args.tarefa || t.id.includes(args.tarefa));
const modeloAgente = await criarModelo(config.modelo);
const modeloUsuario = await criarModelo(config.avaliacao.modeloUsuario);

const resultados: Array<{ tarefa: string; sucessos: number; tentativas: Array<{ ok: boolean; motivo: string; conversa: string[] }> }> = [];

for (const tarefa of tarefas) {
  const tentativas = [];
  for (let tentativa = 1; tentativa <= k; tentativa++) {
    const resultado = await rodarTentativa(tarefa, `${tarefa.id}-${tentativa}`);
    tentativas.push(resultado);
    process.stdout.write(resultado.ok ? "✓" : "✗");
  }
  const sucessos = tentativas.filter((t) => t.ok).length;
  console.log(`  ${tarefa.id}: ${sucessos}/${k}`);
  for (const falha of tentativas.filter((t) => !t.ok)) console.log(`      ✗ ${falha.motivo}`);
  resultados.push({ tarefa: tarefa.id, sucessos, tentativas });
}

console.log(`\nModelo do agente: ${config.modelo.nome} · usuário simulado: ${config.avaliacao.modeloUsuario.nome} · ${tarefas.length} tarefas × ${k} tentativas`);
for (let j = 1; j <= k; j++) {
  const media = resultados.reduce((soma, r) => soma + passHatK(k, r.sucessos, j), 0) / resultados.length;
  console.log(`pass^${j} = ${(media * 100).toFixed(1)}%`);
}

const pasta = join(RAIZ, "evals", "resultados");
mkdirSync(pasta, { recursive: true });
const arquivoSaida = join(pasta, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(arquivoSaida, JSON.stringify({ modelo: config.modelo, k, resultados }, null, 2));
console.log(`Conversas salvas em ${arquivoSaida}`);

async function rodarTentativa(tarefa: Tarefa, idConversa: string) {
  const cpf = tarefa.cpf ?? "12345678901";
  const mock = criarMockGateway({ cpfsSemAutorizacaoFgts: tarefa.fgtsPendente ? [cpf] : [] });
  const { agente, catalogo } = montarAgente({
    raiz: RAIZ,
    modelo: modeloAgente,
    gateway: new Gateway(config.gateway.urlBase, mock.fetch),
    checkpointer: new MemorySaver(),
    passosPorTurno: config.limites.passosPorTurno,
  });
  const sessao: Sessao = { cpf, token: "token-eval", canal: tarefa.canal ?? "mobile", idConversa };
  const configTurno = { configurable: { thread_id: idConversa, sessao } };

  const conversa: string[] = [];
  // Para o usuário simulado, as falas do agente são "humanas" e as dele são do assistente.
  const visaoUsuario: BaseMessage[] = [new HumanMessage("(O atendimento começou. Envie sua primeira mensagem.)")];

  try {
    for (let turno = 0; turno < config.avaliacao.maxTurnos; turno++) {
      const fala = textoDe(await modeloUsuario.responder([new SystemMessage(promptUsuario(tarefa)), ...visaoUsuario], [])).trim();
      visaoUsuario.push(new AIMessage(fala));
      conversa.push(`cliente: ${fala}`);
      if (fala.includes(FIM)) break;

      let entrada: Atualizacao;
      if (fala === CONFIRMAR) {
        const { values } = await agente.getState(configTurno);
        const simulacao = values?.dados?.simulacao;
        if (!ehObjeto(simulacao)) {
          visaoUsuario.push(new HumanMessage("(Não há nenhum cartão de confirmação na tela.)"));
          continue;
        }
        entrada = { acao: { tipo: "confirmar_simulacao", simulacaoId: String(simulacao.id) } };
      } else {
        entrada = { messages: [new HumanMessage(fala)] };
      }

      const estado = await agente.invoke(entrada, configTurno);
      let resposta = textoDe(estado.messages.at(-1)!);
      // O cliente vê o cartão que o canal desenha a partir da simulação.
      if (estado.produto && estado.etapa === "simulacao" && ehObjeto(estado.dados.simulacao)) {
        const cartao = cartaoDeConfirmacao(catalogo.produto(estado.produto), estado.dados.simulacao);
        if (cartao) resposta += `\n\n${cartaoEmTexto(cartao)}`;
      }
      visaoUsuario.push(new HumanMessage(resposta));
      conversa.push(`agente: ${resposta}`);
    }
  } catch (erro) {
    return { ok: false, motivo: `erro de execução: ${(erro as Error).message}`, conversa };
  }

  return { ...conferir(mock.banco, tarefa), conversa };
}

function promptUsuario(tarefa: Tarefa): string {
  return [
    "Você faz o papel de um cliente conversando com o atendimento digital de um banco.",
    `Seu objetivo e seu comportamento: ${tarefa.usuario}`,
    "Escreva só a sua próxima fala, curta e natural, sem narrar o que está fazendo.",
    `Para tocar no botão "Confirmar" do cartão de confirmação, envie exatamente ${CONFIRMAR} e nada mais.`,
    "Não invente dados que não estão no seu objetivo. Seu CPF já é conhecido pelo banco.",
    `Quando o atendimento terminar (contratou, desistiu ou não há mais o que fazer), envie exatamente ${FIM}.`,
  ].join("\n");
}

function conferir(banco: BancoMock, tarefa: Tarefa): { ok: boolean; motivo: string } {
  const { contratos: esperados, semSimulacao } = tarefa.esperado;
  if (semSimulacao && banco.simulacoes.size > 0) return { ok: false, motivo: "simulou quando não podia" };
  if (banco.contratos.length !== esperados.length) {
    return { ok: false, motivo: `esperava ${esperados.length} contrato(s), houve ${banco.contratos.length}` };
  }
  const restantes = [...banco.contratos];
  for (const esperado of esperados) {
    const indice = restantes.findIndex((c) => Object.entries(esperado).every(([campo, valor]) => c[campo] === valor));
    if (indice < 0) return { ok: false, motivo: `nenhum contrato bate com ${JSON.stringify(esperado)}` };
    restantes.splice(indice, 1);
  }
  return { ok: true, motivo: "estado final confere" };
}
