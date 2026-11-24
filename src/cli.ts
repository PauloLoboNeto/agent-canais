import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { montarAgente } from "./agente.js";
import { cartaoDeConfirmacao, cartaoEmTexto } from "./apresentacao.js";
import { carregarConfig, RAIZ } from "./config.js";
import { Gateway } from "./gateway.js";
import { criarMockGateway } from "./mockGateway.js";
import { criarModelo, textoDe } from "./modelo.js";
import { ehObjeto, type Sessao } from "./tipos.js";

/**
 * Chat de terminal que faz o papel de um canal.
 *
 *   npm run chat -- --canal mobile --cpf 12345678901
 *   npm run chat -- --canal mobile --cpf 12345678900 --fgts-pendente   (FGTS sem autorização)
 *   npm run chat -- --gateway-real                                     (usa gateway.urlBase do config)
 *
 * Comandos: /confirmar (toca em "Confirmar" no cartão), /estado, /sair
 */
const { values: args } = parseArgs({
  options: {
    canal: { type: "string", default: "mobile" },
    cpf: { type: "string", default: "12345678901" },
    "gateway-real": { type: "boolean", default: false },
    "fgts-pendente": { type: "boolean", default: false },
    rastro: { type: "boolean", default: true },
  },
});

const config = carregarConfig();
const modelo = await criarModelo(config.modelo);
const mock = criarMockGateway({ cpfsSemAutorizacaoFgts: args["fgts-pendente"] ? [args.cpf!] : [] });
const gateway = new Gateway(config.gateway.urlBase, args["gateway-real"] ? fetch : mock.fetch, config.gateway.timeoutMs);
const { agente, catalogo } = montarAgente({
  raiz: RAIZ,
  modelo,
  gateway,
  checkpointer: new MemorySaver(),
  passosPorTurno: config.limites.passosPorTurno,
});

const sessao: Sessao = {
  cpf: args.cpf!,
  token: process.env.TOKEN_CLIENTE ?? "token-de-teste",
  canal: args.canal!,
  idConversa: randomUUID(),
};
const configTurno = { configurable: { thread_id: sessao.idConversa, sessao } };

console.log(`Canal ${sessao.canal} · CPF ${sessao.cpf} · modelo ${config.modelo.nome} · gateway ${args["gateway-real"] ? "real" : "mock"}`);
console.log("Comandos: /confirmar, /estado, /sair\n");

const terminal = createInterface({ input: process.stdin, output: process.stdout });
let ultimoCartao: string | undefined;

while (true) {
  const linha = (await terminal.question("você › ")).trim();
  if (!linha) continue;
  if (linha === "/sair") break;

  const { values: estadoAtual } = await agente.getState(configTurno);
  if (linha === "/estado") {
    console.log(JSON.stringify({ produto: estadoAtual.produto, etapa: estadoAtual.etapa, dados: estadoAtual.dados }, null, 2));
    continue;
  }

  let entrada;
  if (linha === "/confirmar") {
    const simulacao = estadoAtual?.dados?.simulacao;
    if (!ehObjeto(simulacao) || typeof simulacao.id !== "string") {
      console.log("(não há simulação para confirmar)");
      continue;
    }
    entrada = { acao: { tipo: "confirmar_simulacao" as const, simulacaoId: simulacao.id } };
  } else {
    entrada = { messages: [new HumanMessage(linha)] };
  }

  const estado = await agente.invoke(entrada, configTurno);

  if (args.rastro) {
    for (const passo of estado.rastro) console.log(`  · ${passo.tipo}${passo.etapa ? ` [${passo.etapa}]` : ""} ${JSON.stringify(passo.detalhe)}`);
  }
  const resposta = estado.messages.at(-1);
  if (resposta) console.log(`\nagente › ${textoDe(resposta)}\n`);

  // O canal desenha o cartão a partir da simulação, por código, sempre que ela mudar.
  const simulacao = estado.dados.simulacao;
  if (estado.produto && ehObjeto(simulacao) && simulacao.id !== ultimoCartao && !ehObjeto(estado.dados.contrato)) {
    const cartao = cartaoDeConfirmacao(catalogo.produto(estado.produto), simulacao);
    if (cartao) {
      console.log(`${cartaoEmTexto(cartao)}\n`);
      ultimoCartao = cartao.simulacaoId;
    }
  }
  console.log(`  (etapa: ${estado.etapa ?? "triagem"})\n`);
}

terminal.close();
