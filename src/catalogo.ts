import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { guardaExiste } from "./guardas.js";
import { ehObjeto, type Efeito, type JsonSchema } from "./tipos.js";
import { validar } from "./validacao.js";

/**
 * Catálogo de APIs: o que cada time entrega, numa pasta `catalogo/<produto>/`:
 *
 * - openapi.yaml: o spec que o time já publica no gateway. É o contrato que o runtime
 *   usa para gerar o schema das tools e validar os argumentos antes de chamar a API.
 * - manifesto.yaml: o complemento escrito para a LLM (quando usar, quando não usar,
 *   exemplos) e as regras aplicadas em código (etapa, efeito, guardas, parâmetros que
 *   vêm da sessão).
 * - skills/<etapa>.md: o roteiro do produto em cada etapa (opcional, há um padrão).
 *
 * Tudo é carregado e validado no boot: manifesto inconsistente derruba a subida, não a conversa.
 */

type Local = "path" | "query" | "body";

export type FormatoCampo = "moeda" | "meses" | "anos" | "percentualMes" | "percentualAno" | "texto";

export interface CampoCartao {
  campo: string;
  rotulo: string;
  formato: FormatoCampo;
}

export interface Exemplo {
  descricao: string;
  argumentos: Record<string, unknown>;
}

export interface Operacao {
  produto: string;
  operationId: string;
  /** Nome exposto para a LLM. Único no catálogo inteiro. */
  nomeTool: string;
  etapa: string;
  efeito: Efeito;
  metodo: string;
  /** Caminho relativo ao basePath do produto, ex.: /clientes/{cpf}/ofertas */
  caminho: string;
  /** Texto que a LLM lê para decidir quando usar a tool. */
  descricao: string;
  /** Schema que a LLM preenche (sem os parâmetros que vêm do contexto). */
  schemaEntrada: JsonSchema;
  /** Schema completo da operação, validado de novo depois de injetar o contexto. */
  schemaCompleto: JsonSchema;
  locais: Record<string, Local>;
  /** parâmetro -> origem, ex.: { cpf: "sessao.cpf", simulacaoId: "dados.confirmacao.simulacaoId" } */
  doContexto: Record<string, string>;
  /** Chave em `dados` onde o resultado é guardado. */
  produz?: string;
  /** Guardas que precisam passar para a chamada sair. */
  requer: string[];
  canais: string[];
  exemplos: Exemplo[];
}

export interface Produto {
  nome: string;
  nomeExibicao: string;
  descricao: string;
  fluxo: string;
  basePath: string;
  canais: string[];
  cartaoConfirmacao: CampoCartao[];
  pasta: string;
  operacoes: Operacao[];
}

interface ManifestoOperacao {
  etapa: string;
  efeito: Efeito;
  quandoUsar?: string;
  quandoNaoUsar?: string;
  doContexto?: Record<string, string>;
  produz?: string;
  requer?: string[];
  canais?: string[];
  exemplos?: Exemplo[];
}

interface Manifesto {
  produto: string;
  nomeExibicao: string;
  descricao: string;
  fluxo: string;
  openapi: string;
  basePath: string;
  canais: string[];
  cartaoConfirmacao?: CampoCartao[];
  operacoes: Record<string, ManifestoOperacao>;
}

const METODOS = ["get", "post", "put", "patch", "delete"] as const;
const ORIGENS_CONTEXTO = ["sessao.", "dados."];

export class Catalogo {
  private readonly porTool = new Map<string, Operacao>();

  private constructor(readonly produtos: ReadonlyMap<string, Produto>) {
    for (const produto of produtos.values()) {
      for (const operacao of produto.operacoes) this.porTool.set(operacao.nomeTool, operacao);
    }
  }

  static carregar(raiz: string): Catalogo {
    const produtos = new Map<string, Produto>();
    for (const nome of readdirSync(raiz).sort()) {
      const pasta = join(raiz, nome);
      if (!statSync(pasta).isDirectory() || !existsSync(join(pasta, "manifesto.yaml"))) continue;
      const produto = carregarProduto(pasta);
      if (produtos.has(produto.nome)) throw new Error(`Produto duplicado no catálogo: ${produto.nome}`);
      produtos.set(produto.nome, produto);
    }
    return new Catalogo(produtos);
  }

  produto(nome: string): Produto {
    const produto = this.produtos.get(nome);
    if (!produto) throw new Error(`Produto não encontrado no catálogo: ${nome}`);
    return produto;
  }

  produtosDoCanal(canal: string): Produto[] {
    return [...this.produtos.values()].filter((p) => p.canais.includes(canal));
  }

  /** Só as operações desta etapa, deste produto e deste canal: é tudo o que a LLM enxerga. */
  operacoes(produto: string, etapa: string, canal: string): Operacao[] {
    return this.produto(produto).operacoes.filter((op) => op.etapa === etapa && op.canais.includes(canal));
  }

  operacao(nomeTool: string): Operacao | undefined {
    return this.porTool.get(nomeTool);
  }
}

/** Formato de tool aceito por todos os provedores via LangChain (OpenAI, Anthropic...). */
export interface DefinicaoTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export function definicaoTool(operacao: Operacao): DefinicaoTool {
  return {
    type: "function",
    function: { name: operacao.nomeTool, description: operacao.descricao, parameters: operacao.schemaEntrada },
  };
}

function lerYaml(caminho: string): unknown {
  return parse(readFileSync(caminho, "utf8"));
}

function carregarProduto(pasta: string): Produto {
  const manifesto = lerYaml(join(pasta, "manifesto.yaml")) as Manifesto;
  const spec = lerYaml(join(pasta, manifesto.openapi)) as Record<string, unknown>;
  const indice = indexarOperacoes(spec);
  const erro = (msg: string) => new Error(`[catalogo/${manifesto.produto}] ${msg}`);

  const operacoes: Operacao[] = Object.entries(manifesto.operacoes ?? {}).map(([operationId, m]) => {
    const encontrada = indice.get(operationId);
    if (!encontrada) throw erro(`operationId ${operationId} não existe no OpenAPI`);
    if (m.efeito !== "leitura" && m.efeito !== "escrita") throw erro(`${operationId}: efeito deve ser leitura ou escrita`);
    if (!m.etapa) throw erro(`${operationId}: etapa é obrigatória`);

    const requer = m.requer ?? [];
    for (const guarda of requer) if (!guardaExiste(guarda)) throw erro(`${operationId}: guarda desconhecida ${guarda}`);

    const doContexto = m.doContexto ?? {};
    for (const [parametro, origem] of Object.entries(doContexto)) {
      if (!ORIGENS_CONTEXTO.some((prefixo) => origem.startsWith(prefixo))) {
        throw erro(`${operationId}: origem de contexto inválida para ${parametro}: ${origem}`);
      }
    }

    const { schema: schemaCompleto, locais } = schemaDaOperacao(encontrada.operacao, encontrada.itemCaminho, spec, erro);
    const propriedades = schemaCompleto.properties as Record<string, unknown>;
    for (const parametro of Object.keys(doContexto)) {
      if (!(parametro in propriedades)) throw erro(`${operationId}: ${parametro} está em doContexto mas não existe no OpenAPI`);
    }
    const schemaEntrada = semParametros(schemaCompleto, Object.keys(doContexto));

    const exemplos = m.exemplos ?? [];
    for (const exemplo of exemplos) {
      const resultado = validar(schemaEntrada, exemplo.argumentos);
      if (!resultado.ok) throw erro(`${operationId}: exemplo "${exemplo.descricao}" não bate com o schema: ${resultado.erros}`);
    }

    const operacao: Operacao = {
      produto: manifesto.produto,
      operationId,
      nomeTool: `${manifesto.produto}__${operationId}`,
      etapa: m.etapa,
      efeito: m.efeito,
      metodo: encontrada.metodo,
      caminho: encontrada.caminho,
      descricao: "",
      schemaEntrada,
      schemaCompleto,
      locais,
      doContexto,
      produz: m.produz,
      requer,
      canais: m.canais ?? manifesto.canais,
      exemplos,
    };
    operacao.descricao = montarDescricao(manifesto, encontrada.operacao, m, operacao);
    return operacao;
  });

  return {
    nome: manifesto.produto,
    nomeExibicao: manifesto.nomeExibicao,
    descricao: manifesto.descricao.trim(),
    fluxo: manifesto.fluxo,
    basePath: manifesto.basePath,
    canais: manifesto.canais,
    cartaoConfirmacao: manifesto.cartaoConfirmacao ?? [],
    pasta,
    operacoes,
  };
}

interface OperacaoOpenApi {
  metodo: string;
  caminho: string;
  operacao: Record<string, unknown>;
  itemCaminho: Record<string, unknown>;
}

function indexarOperacoes(spec: Record<string, unknown>): Map<string, OperacaoOpenApi> {
  const indice = new Map<string, OperacaoOpenApi>();
  const caminhos = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [caminho, itemCaminho] of Object.entries(caminhos)) {
    for (const metodo of METODOS) {
      const operacao = itemCaminho[metodo];
      if (ehObjeto(operacao) && typeof operacao.operationId === "string") {
        indice.set(operacao.operationId, { metodo: metodo.toUpperCase(), caminho, operacao, itemCaminho });
      }
    }
  }
  return indice;
}

/** Junta parâmetros de path/query e o corpo JSON num único objeto de entrada para a tool. */
function schemaDaOperacao(
  operacao: Record<string, unknown>,
  itemCaminho: Record<string, unknown>,
  spec: Record<string, unknown>,
  erro: (msg: string) => Error,
): { schema: JsonSchema; locais: Record<string, Local> } {
  const propriedades: Record<string, unknown> = {};
  const obrigatorios = new Set<string>();
  const locais: Record<string, Local> = {};

  const adicionar = (nome: string, schema: unknown, local: Local) => {
    if (nome in propriedades) throw erro(`${String(operacao.operationId)}: parâmetro ${nome} aparece duas vezes`);
    propriedades[nome] = schema;
    locais[nome] = local;
  };

  const parametros = [
    ...((itemCaminho.parameters as unknown[]) ?? []),
    ...((operacao.parameters as unknown[]) ?? []),
  ].map((p) => resolverRefs(p, spec) as Record<string, unknown>);

  for (const parametro of parametros) {
    const local = parametro.in;
    // Headers e cookies (auth, idempotência, correlação) são responsabilidade do runtime.
    if (local !== "path" && local !== "query") continue;
    const nome = String(parametro.name);
    const schema = { ...((parametro.schema as Record<string, unknown>) ?? { type: "string" }) };
    if (typeof parametro.description === "string" && !schema.description) schema.description = parametro.description;
    adicionar(nome, schema, local);
    if (parametro.required === true || local === "path") obrigatorios.add(nome);
  }

  if (operacao.requestBody) {
    const corpo = resolverRefs(operacao.requestBody, spec) as Record<string, any>;
    const schemaCorpo = corpo?.content?.["application/json"]?.schema as Record<string, unknown> | undefined;
    if (!schemaCorpo || schemaCorpo.type !== "object") {
      throw erro(`${String(operacao.operationId)}: só corpo JSON do tipo object é suportado neste esboço`);
    }
    for (const [nome, schema] of Object.entries((schemaCorpo.properties as Record<string, unknown>) ?? {})) {
      adicionar(nome, schema, "body");
    }
    for (const nome of (schemaCorpo.required as string[]) ?? []) obrigatorios.add(nome);
  }

  return {
    schema: { type: "object", properties: propriedades, required: [...obrigatorios], additionalProperties: false },
    locais,
  };
}

/**
 * Remove do schema da LLM os parâmetros preenchidos pelo runtime. Com
 * additionalProperties: false, se a LLM tentar mandar um CPF, a validação recusa.
 */
function semParametros(schema: JsonSchema, remover: string[]): JsonSchema {
  const propriedades = { ...(schema.properties as Record<string, unknown>) };
  for (const nome of remover) delete propriedades[nome];
  const obrigatorios = (schema.required as string[]).filter((nome) => !remover.includes(nome));
  return { ...schema, properties: propriedades, required: obrigatorios };
}

function montarDescricao(
  manifesto: Manifesto,
  operacaoSpec: Record<string, unknown>,
  m: ManifestoOperacao,
  operacao: Operacao,
): string {
  const partes: string[] = [];
  const resumo = [operacaoSpec.summary, operacaoSpec.description].filter((t) => typeof t === "string").join(" ");
  partes.push(`[${manifesto.nomeExibicao}] ${resumo}`.trim());
  if (m.quandoUsar) partes.push(`Quando usar: ${m.quandoUsar}`);
  if (m.quandoNaoUsar) partes.push(`Quando NÃO usar: ${m.quandoNaoUsar}`);
  if (operacao.efeito === "escrita") partes.push("Operação de ESCRITA: altera a situação do cliente.");
  if (operacao.requer.length) {
    partes.push(`O runtime só executa se estas condições forem verdadeiras: ${operacao.requer.join(", ")}.`);
  }
  for (const exemplo of operacao.exemplos) {
    partes.push(`Exemplo (${exemplo.descricao}): ${JSON.stringify(exemplo.argumentos)}`);
  }
  return partes.join("\n");
}

/** Resolve $ref locais (#/components/...). Refs externas ficam para depois do esboço. */
function resolverRefs(no: unknown, spec: Record<string, unknown>, profundidade = 0): unknown {
  if (profundidade > 32) throw new Error("$ref circular ou profundo demais no OpenAPI");
  if (Array.isArray(no)) return no.map((item) => resolverRefs(item, spec, profundidade + 1));
  if (!ehObjeto(no)) return no;
  if (typeof no.$ref === "string") return resolverRefs(seguirRef(no.$ref, spec), spec, profundidade + 1);
  return Object.fromEntries(Object.entries(no).map(([k, v]) => [k, resolverRefs(v, spec, profundidade + 1)]));
}

function seguirRef(ref: string, spec: Record<string, unknown>): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Só $ref locais são suportadas neste esboço: ${ref}`);
  let atual: unknown = spec;
  for (const parte of ref.slice(2).split("/")) {
    const chave = parte.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!ehObjeto(atual) || !(chave in atual)) throw new Error(`$ref não encontrada: ${ref}`);
    atual = atual[chave];
  }
  return atual;
}
