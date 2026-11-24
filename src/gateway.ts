import type { Operacao, Produto } from "./catalogo.js";
import type { Sessao } from "./tipos.js";

export interface RespostaGateway {
  status: number;
  corpo: unknown;
}

export type Fetch = typeof fetch;

/**
 * Toda chamada sai pelo gateway, como hoje: mesma autenticação, rate limit e observabilidade.
 * O token repassado é o do cliente, então quem decide o que ele pode ver continua sendo a API
 * do time, e não o agente com uma credencial de acesso amplo.
 */
export class Gateway {
  constructor(
    private readonly urlBase: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async chamar(
    produto: Produto,
    operacao: Operacao,
    parametros: Record<string, unknown>,
    sessao: Sessao,
    chaveIdempotencia?: string,
  ): Promise<RespostaGateway> {
    let caminho = operacao.caminho;
    const query = new URLSearchParams();
    const corpo: Record<string, unknown> = {};

    for (const [nome, valor] of Object.entries(parametros)) {
      switch (operacao.locais[nome]) {
        case "path":
          caminho = caminho.replace(`{${nome}}`, encodeURIComponent(String(valor)));
          break;
        case "query":
          query.append(nome, String(valor));
          break;
        case "body":
          corpo[nome] = valor;
          break;
        default:
          throw new Error(`Parâmetro sem local conhecido: ${nome}`);
      }
    }

    const cabecalhos: Record<string, string> = {
      authorization: `Bearer ${sessao.token}`,
      "x-canal": sessao.canal,
      "x-correlation-id": sessao.idConversa,
    };
    const temCorpo = Object.keys(corpo).length > 0;
    if (temCorpo) cabecalhos["content-type"] = "application/json";
    if (chaveIdempotencia) cabecalhos["idempotency-key"] = chaveIdempotencia;

    const sufixoQuery = query.size > 0 ? `?${query.toString()}` : "";
    const resposta = await this.fetchImpl(`${this.urlBase}${produto.basePath}${caminho}${sufixoQuery}`, {
      method: operacao.metodo,
      headers: cabecalhos,
      body: temCorpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const texto = await resposta.text();
    let corpoResposta: unknown = texto;
    try {
      corpoResposta = texto ? JSON.parse(texto) : null;
    } catch {
      // Resposta não JSON: devolve o texto como veio.
    }
    return { status: resposta.status, corpo: corpoResposta };
  }
}
