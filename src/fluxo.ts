import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { guardaExiste, guardasQueFalham } from "./guardas.js";
import type { Dados } from "./tipos.js";

/**
 * Fluxos declarados em YAML viram grafos LangGraph em tempo de execução. A ordem
 * obrigatória das etapas mora nas transições (código), não em uma skill.
 */

export interface Transicao {
  para: string;
  requer: string[];
  automatica: boolean;
}

export interface NoFluxo {
  objetivo: string;
}

export interface Fluxo {
  nome: string;
  inicio: string;
  nos: Record<string, NoFluxo>;
  transicoes: Record<string, Transicao[]>;
}

interface FluxoYaml {
  nome: string;
  estende?: string;
  inicio?: string;
  nos?: Record<string, NoFluxo>;
  transicoes?: Record<string, Array<{ para: string; requer?: string[]; automatica?: boolean }>>;
}

export function carregarFluxos(pasta: string): Map<string, Fluxo> {
  const brutos = new Map<string, FluxoYaml>();
  for (const arquivo of readdirSync(pasta).filter((a) => a.endsWith(".yaml")).sort()) {
    const fluxo = parse(readFileSync(join(pasta, arquivo), "utf8")) as FluxoYaml;
    if (brutos.has(fluxo.nome)) throw new Error(`Fluxo duplicado: ${fluxo.nome}`);
    brutos.set(fluxo.nome, fluxo);
  }

  const resolvidos = new Map<string, Fluxo>();
  const resolver = (nome: string, cadeia: string[] = []): Fluxo => {
    const pronto = resolvidos.get(nome);
    if (pronto) return pronto;
    if (cadeia.includes(nome)) throw new Error(`Herança circular de fluxos: ${[...cadeia, nome].join(" -> ")}`);
    const bruto = brutos.get(nome);
    if (!bruto) throw new Error(`Fluxo não encontrado: ${nome}`);

    const base = bruto.estende ? resolver(bruto.estende, [...cadeia, nome]) : undefined;
    const transicoesProprias = Object.fromEntries(
      Object.entries(bruto.transicoes ?? {}).map(([origem, lista]) => [
        origem,
        (lista ?? []).map((t) => ({ para: t.para, requer: t.requer ?? [], automatica: t.automatica ?? false })),
      ]),
    );
    const fluxo: Fluxo = {
      nome: bruto.nome,
      inicio: bruto.inicio ?? base?.inicio ?? "",
      nos: { ...base?.nos, ...bruto.nos },
      // Transições declaradas no fluxo filho substituem as do pai para a mesma origem.
      transicoes: { ...base?.transicoes, ...transicoesProprias },
    };
    validarFluxo(fluxo);
    resolvidos.set(nome, fluxo);
    return fluxo;
  };

  for (const nome of brutos.keys()) resolver(nome);
  return resolvidos;
}

function validarFluxo(fluxo: Fluxo): void {
  const erro = (msg: string) => new Error(`[fluxo ${fluxo.nome}] ${msg}`);
  if (!fluxo.nos[fluxo.inicio]) throw erro(`etapa inicial ${fluxo.inicio} não existe`);
  for (const [origem, lista] of Object.entries(fluxo.transicoes)) {
    if (!fluxo.nos[origem]) throw erro(`transição sai de uma etapa inexistente: ${origem}`);
    for (const t of lista) {
      if (!fluxo.nos[t.para]) throw erro(`transição ${origem} -> ${t.para} aponta para etapa inexistente`);
      for (const g of t.requer) if (!guardaExiste(g)) throw erro(`guarda desconhecida em ${origem} -> ${t.para}: ${g}`);
    }
  }
}

export interface OpcoesDeTransicao {
  /** Transição automática liberada, se houver: o runtime segue sem perguntar à LLM. */
  automatica?: string;
  /** Etapas para onde o turno pode ir, incluindo ficar na atual. */
  permitidas: string[];
}

export function opcoesDeTransicao(fluxo: Fluxo, etapa: string, dados: Dados, agora: Date): OpcoesDeTransicao {
  const liberadas = (fluxo.transicoes[etapa] ?? []).filter((t) => guardasQueFalham(t.requer, dados, agora).length === 0);
  const automatica = liberadas.find((t) => t.automatica)?.para;
  const permitidas = [etapa, ...liberadas.map((t) => t.para)].filter((e, i, todas) => todas.indexOf(e) === i);
  return { automatica, permitidas };
}
