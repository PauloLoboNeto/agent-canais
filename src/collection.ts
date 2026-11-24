/**
 * Converte uma collection do Postman (v2.1) num RASCUNHO de OpenAPI.
 *
 * A collection mostra chamadas que funcionaram, mas não diz as regras: limites, campos
 * obrigatórios, enums. Por isso o resultado sai marcado com `x-revisar: true` e sem
 * nenhum `required`. O time revisa uma vez, completa as regras e o rascunho vira o contrato.
 *
 * Valores de exemplo NÃO são copiados: collections costumam carregar CPF real, tokens e
 * variáveis de ambiente. Só os tipos são inferidos.
 */

type Json = null | boolean | number | string | Json[] | { [chave: string]: Json };

interface ItemColecao {
  name?: string;
  item?: ItemColecao[];
  request?: {
    method?: string;
    description?: string;
    url?: string | { raw?: string; path?: string[]; query?: Array<{ key: string; disabled?: boolean }> };
    body?: { mode?: string; raw?: string };
  };
}

export interface Colecao {
  info?: { name?: string };
  item?: ItemColecao[];
}

export interface OpcoesConversao {
  /** Prefixo do gateway a remover dos caminhos, ex.: /credito/consignado/v1 */
  basePath?: string;
}

export function colecaoParaOpenapi(colecao: Colecao, opcoes: OpcoesConversao = {}): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const idsUsados = new Set<string>();

  for (const item of achatar(colecao.item ?? [])) {
    const requisicao = item.request!;
    const metodo = (requisicao.method ?? "GET").toLowerCase();
    const { caminho, parametrosCaminho } = extrairCaminho(requisicao.url, opcoes.basePath);
    const query = typeof requisicao.url === "object" ? (requisicao.url.query ?? []).filter((q) => !q.disabled) : [];

    const parameters = [
      ...parametrosCaminho.map((nome) => ({ name: nome, in: "path", required: true, schema: { type: "string" } })),
      ...query.map((q) => ({ name: q.key, in: "query", schema: { type: "string" } })),
    ];

    const operacao: Record<string, unknown> = {
      operationId: operationIdUnico(item.name ?? `${metodo} ${caminho}`, idsUsados),
      summary: item.name ?? "",
      "x-revisar": true,
    };
    if (requisicao.description) operacao.description = requisicao.description;
    if (parameters.length) operacao.parameters = parameters;

    const corpo = lerCorpo(requisicao.body);
    if (corpo !== undefined) {
      operacao.requestBody = { required: true, content: { "application/json": { schema: inferirSchema(corpo) } } };
    }
    operacao.responses = { "200": { description: "REVISAR: descreva a resposta." } };

    paths[caminho] ??= {};
    paths[caminho]![metodo] = operacao;
  }

  return {
    openapi: "3.0.3",
    info: { title: `${colecao.info?.name ?? "API"} (rascunho gerado da collection)`, version: "0.0.0-rascunho" },
    paths,
  };
}

function achatar(itens: ItemColecao[]): ItemColecao[] {
  return itens.flatMap((item) => (item.item ? achatar(item.item) : item.request ? [item] : []));
}

function extrairCaminho(url: NonNullable<ItemColecao["request"]>["url"], basePath?: string) {
  let segmentos: string[];
  if (typeof url === "object" && url.path) {
    segmentos = url.path;
  } else {
    const bruto = typeof url === "string" ? url : (url?.raw ?? "");
    const semHost = bruto.replace(/^\{\{[^}]+\}\}/, "").replace(/^https?:\/\/[^/]+/, "").split("?")[0] ?? "";
    segmentos = semHost.split("/").filter(Boolean);
  }

  const parametrosCaminho: string[] = [];
  const normalizados = segmentos.map((segmento) => {
    const variavel = segmento.match(/^:(\w+)$/) ?? segmento.match(/^\{\{(\w+)\}\}$/);
    if (!variavel) return segmento;
    parametrosCaminho.push(variavel[1]!);
    return `{${variavel[1]}}`;
  });

  let caminho = `/${normalizados.join("/")}`;
  if (basePath && caminho.startsWith(basePath)) caminho = caminho.slice(basePath.length) || "/";
  return { caminho, parametrosCaminho };
}

function lerCorpo(corpo: NonNullable<ItemColecao["request"]>["body"]): Json | undefined {
  if (!corpo || corpo.mode !== "raw" || !corpo.raw?.trim()) return undefined;
  // Variáveis {{x}} fora de aspas quebram o JSON; troca por null só para inferir a estrutura.
  const texto = corpo.raw.replace(/(?<!")\{\{[^}]+\}\}(?!")/g, "null");
  try {
    return JSON.parse(texto) as Json;
  } catch {
    return undefined;
  }
}

export function inferirSchema(valor: Json): Record<string, unknown> {
  const revisar = "REVISAR: limites, formato e obrigatoriedade.";
  if (valor === null) return { description: revisar };
  if (Array.isArray(valor)) return { type: "array", items: valor.length ? inferirSchema(valor[0]!) : {} };
  switch (typeof valor) {
    case "string":
      return { type: "string", description: revisar };
    case "number":
      return { type: Number.isInteger(valor) ? "integer" : "number", description: revisar };
    case "boolean":
      return { type: "boolean" };
    default:
      return {
        type: "object",
        properties: Object.fromEntries(Object.entries(valor).map(([chave, v]) => [chave, inferirSchema(v)])),
      };
  }
}

function operationIdUnico(nome: string, usados: Set<string>): string {
  const palavras = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const base = palavras.map((p, i) => (i === 0 ? p.toLowerCase() : p[0]!.toUpperCase() + p.slice(1).toLowerCase())).join("") || "operacao";
  let id = base;
  for (let n = 2; usados.has(id); n++) id = `${base}${n}`;
  usados.add(id);
  return id;
}
