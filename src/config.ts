import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { ConfigModelo } from "./modelo.js";

export interface ConfigRuntime {
  modelo: ConfigModelo;
  gateway: { urlBase: string; timeoutMs: number };
  limites: { passosPorTurno: number };
  avaliacao: { modeloUsuario: ConfigModelo; tentativasPorTarefa: number; maxTurnos: number };
}

/** Raiz do projeto (onde ficam catalogo/, fluxos/, skills/ e config/). */
export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

export function carregarConfig(caminho = join(RAIZ, "config", "runtime.yaml")): ConfigRuntime {
  return parse(readFileSync(caminho, "utf8")) as ConfigRuntime;
}
