import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";
import type { JsonSchema } from "./tipos.js";

// ajv-formats é CommonJS; dependendo do loader, o plugin vem no default ou no próprio módulo.
type PluginFormats = (ajv: Ajv) => Ajv;
const modulo = addFormatsModule as unknown as PluginFormats & { default?: PluginFormats };
const addFormats: PluginFormats = modulo.default ?? modulo;

// strict: false porque specs OpenAPI reais trazem palavras como `example` e `nullable`.
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const cache = new WeakMap<JsonSchema, ValidateFunction>();

export interface ResultadoValidacao {
  ok: boolean;
  erros?: string;
}

export function validar(schema: JsonSchema, valor: unknown): ResultadoValidacao {
  let validador = cache.get(schema);
  if (!validador) {
    validador = ajv.compile(schema);
    cache.set(schema, validador);
  }
  if (validador(valor)) return { ok: true };
  return { ok: false, erros: ajv.errorsText(validador.errors, { dataVar: "argumentos" }) };
}
