import type { Fetch } from "./gateway.js";

/**
 * Gateway falso, em memória, que imita as APIs de consignado, crédito pessoal e FGTS.
 * Serve para rodar o chat sem rede e para as evals: o "banco" final (contratos criados)
 * é o que a avaliação compara com o estado esperado, como no τ-bench.
 */

export interface ContratoMock {
  id: string;
  produto: string;
  cpf: string;
  simulacaoId: string;
  status: "EFETIVADO";
  [campo: string]: unknown;
}

interface SimulacaoMock {
  id: string;
  produto: string;
  cpf: string;
  validaAte: string;
  [campo: string]: unknown;
}

export class BancoMock {
  readonly simulacoes = new Map<string, SimulacaoMock>();
  readonly contratos: ContratoMock[] = [];
  readonly chamadas: Array<{ metodo: string; caminho: string; corpo?: unknown }> = [];
  private readonly porIdempotencia = new Map<string, ContratoMock>();
  private sequencia = 0;

  proximoId(prefixo: string): string {
    this.sequencia += 1;
    return `${prefixo}-${String(this.sequencia).padStart(4, "0")}`;
  }

  contratar(chave: string | null, criar: () => ContratoMock): { contrato: ContratoMock; repetido: boolean } {
    const existente = chave ? this.porIdempotencia.get(chave) : undefined;
    if (existente) return { contrato: existente, repetido: true };
    const contrato = criar();
    this.contratos.push(contrato);
    if (chave) this.porIdempotencia.set(chave, contrato);
    return { contrato, repetido: false };
  }
}

export interface OpcoesMock {
  /** CPFs que ainda não autorizaram o banco no saque-aniversário. */
  cpfsSemAutorizacaoFgts?: string[];
  relogio?: () => Date;
}

const OFERTA_CONSIGNADO = { id: "OF-CONS-1", taxaMensal: 1.66, valorMaximo: 25_000, prazoMaximoMeses: 84 };
const LIMITE_CDC = { valorMaximo: 8_000, taxaMensal: 4.9, prazoMaximoMeses: 36 };
const CONDICOES_FGTS = { taxaMensal: 1.79, maximoParcelas: 10, valorAnualEstimado: 1_200 };

export function criarMockGateway(opcoes: OpcoesMock = {}): { fetch: Fetch; banco: BancoMock } {
  const banco = new BancoMock();
  const relogio = opcoes.relogio ?? (() => new Date());
  const pendentes = new Set(opcoes.cpfsSemAutorizacaoFgts ?? []);

  const fetchMock: Fetch = async (entrada, init) => {
    const url = new URL(String(entrada));
    const metodo = (init?.method ?? "GET").toUpperCase();
    const cabecalhos = new Headers(init?.headers);
    const corpo = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const caminho = url.pathname;
    banco.chamadas.push({ metodo, caminho, corpo: init?.body ? corpo : undefined });

    if (!cabecalhos.get("authorization")?.startsWith("Bearer ")) return json(401, { mensagem: "Token ausente" });

    const validade = () => new Date(relogio().getTime() + 30 * 60_000).toISOString();
    let m: RegExpMatchArray | null;

    // ---------------- Consignado ----------------
    if ((m = caminho.match(/^\/credito\/consignado\/v1\/clientes\/(\d{11})\/ofertas$/)) && metodo === "GET") {
      return json(200, { ofertas: [OFERTA_CONSIGNADO] });
    }
    if (caminho === "/credito/consignado/v1/simulacoes" && metodo === "POST") {
      const { cpf, ofertaId, valor, prazoMeses } = corpo as { cpf: string; ofertaId: string; valor: number; prazoMeses: number };
      if (ofertaId !== OFERTA_CONSIGNADO.id) return json(404, { mensagem: `Oferta ${ofertaId} não encontrada` });
      if (valor > OFERTA_CONSIGNADO.valorMaximo) return json(422, { mensagem: `Valor acima do máximo da oferta (R$ ${OFERTA_CONSIGNADO.valorMaximo})` });
      if (prazoMeses > OFERTA_CONSIGNADO.prazoMaximoMeses) return json(422, { mensagem: `Prazo acima do máximo da oferta (${OFERTA_CONSIGNADO.prazoMaximoMeses} meses)` });
      const simulacao: SimulacaoMock = {
        id: banco.proximoId("SIM-CONS"),
        produto: "consignado",
        cpf,
        valor,
        prazoMeses,
        parcela: parcelaPrice(valor, OFERTA_CONSIGNADO.taxaMensal, prazoMeses),
        taxaMensal: OFERTA_CONSIGNADO.taxaMensal,
        cetAnual: cetAnual(OFERTA_CONSIGNADO.taxaMensal, 0.38),
        validaAte: validade(),
      };
      banco.simulacoes.set(simulacao.id, simulacao);
      return json(201, publico(simulacao));
    }

    // ---------------- Crédito pessoal (CDC) ----------------
    if ((m = caminho.match(/^\/credito\/cdc\/v1\/clientes\/(\d{11})\/limite$/)) && metodo === "GET") {
      return json(200, LIMITE_CDC);
    }
    if (caminho === "/credito/cdc/v1/simulacoes" && metodo === "POST") {
      const { cpf, valor, prazoMeses, diaVencimento } = corpo as { cpf: string; valor: number; prazoMeses: number; diaVencimento: number };
      if (valor > LIMITE_CDC.valorMaximo) return json(422, { mensagem: `Valor acima do limite pré-aprovado (R$ ${LIMITE_CDC.valorMaximo})` });
      if (prazoMeses > LIMITE_CDC.prazoMaximoMeses) return json(422, { mensagem: `Prazo acima do máximo (${LIMITE_CDC.prazoMaximoMeses} meses)` });
      const simulacao: SimulacaoMock = {
        id: banco.proximoId("SIM-CDC"),
        produto: "cdc",
        cpf,
        valor,
        prazoMeses,
        diaVencimento,
        parcela: parcelaPrice(valor, LIMITE_CDC.taxaMensal, prazoMeses),
        taxaMensal: LIMITE_CDC.taxaMensal,
        cetAnual: cetAnual(LIMITE_CDC.taxaMensal, 0.38 + 3),
        validaAte: validade(),
      };
      banco.simulacoes.set(simulacao.id, simulacao);
      return json(201, publico(simulacao));
    }

    // ---------------- FGTS ----------------
    if (caminho === "/credito/fgts/v1/condicoes" && metodo === "GET") {
      return json(200, { taxaMensal: CONDICOES_FGTS.taxaMensal, maximoParcelas: CONDICOES_FGTS.maximoParcelas });
    }
    if ((m = caminho.match(/^\/credito\/fgts\/v1\/clientes\/(\d{11})\/autorizacao$/)) && metodo === "GET") {
      return json(200, { status: pendentes.has(m[1]!) ? "PENDENTE" : "AUTORIZADO" });
    }
    if (caminho === "/credito/fgts/v1/simulacoes" && metodo === "POST") {
      const { cpf, quantidadeParcelas } = corpo as { cpf: string; quantidadeParcelas: number };
      if (pendentes.has(cpf)) return json(403, { mensagem: "Banco não autorizado no saque-aniversário" });
      const taxa = CONDICOES_FGTS.taxaMensal / 100;
      let valorLiberado = 0;
      for (let ano = 1; ano <= quantidadeParcelas; ano++) {
        valorLiberado += CONDICOES_FGTS.valorAnualEstimado / (1 + taxa) ** (12 * ano);
      }
      const simulacao: SimulacaoMock = {
        id: banco.proximoId("SIM-FGTS"),
        produto: "fgts",
        cpf,
        quantidadeParcelas,
        valorLiberado: arredondar(valorLiberado),
        taxaMensal: CONDICOES_FGTS.taxaMensal,
        cetAnual: cetAnual(CONDICOES_FGTS.taxaMensal, 0.38),
        validaAte: validade(),
      };
      banco.simulacoes.set(simulacao.id, simulacao);
      return json(201, publico(simulacao));
    }

    // ---------------- Contratos (todos os produtos) ----------------
    if ((m = caminho.match(/^\/credito\/(consignado|cdc|fgts)\/v1\/contratos$/)) && metodo === "POST") {
      const produto = m[1]!;
      const { cpf, simulacaoId } = corpo as { cpf: string; simulacaoId: string };
      const simulacao = banco.simulacoes.get(simulacaoId);
      if (!simulacao || simulacao.produto !== produto || simulacao.cpf !== cpf) {
        return json(404, { mensagem: "Simulação não encontrada para este cliente" });
      }
      if (new Date(simulacao.validaAte).getTime() <= relogio().getTime()) {
        return json(422, { mensagem: "Simulação expirada. Simule novamente." });
      }
      const { contrato, repetido } = banco.contratar(cabecalhos.get("idempotency-key"), () => ({
        ...publico(simulacao),
        id: banco.proximoId("CT"),
        produto,
        cpf,
        simulacaoId,
        status: "EFETIVADO",
        creditoPrevisto: "em até 1 dia útil",
      }));
      return json(repetido ? 200 : 201, contrato);
    }

    return json(404, { mensagem: `Rota não encontrada no mock: ${metodo} ${caminho}` });
  };

  return { fetch: fetchMock, banco };
}

function json(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

/** Remove os campos internos do mock antes de responder. */
function publico(simulacao: SimulacaoMock): Record<string, unknown> {
  const { produto: _produto, cpf: _cpf, ...resto } = simulacao;
  return resto;
}

function parcelaPrice(valor: number, taxaMensalPercentual: number, meses: number): number {
  const i = taxaMensalPercentual / 100;
  return arredondar((valor * i) / (1 - (1 + i) ** -meses));
}

/** Aproximação didática do CET: taxa anual equivalente mais um custo fixo de IOF/tarifas. */
function cetAnual(taxaMensalPercentual: number, custosAnuaisPercentual: number): number {
  return arredondar(((1 + taxaMensalPercentual / 100) ** 12 - 1) * 100 + custosAnuaisPercentual);
}

function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}
