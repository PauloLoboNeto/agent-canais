import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { stringify } from "yaml";
import { colecaoParaOpenapi, type Colecao } from "../src/collection.js";

/**
 * Para o time que ainda não tem OpenAPI:
 *
 *   npm run collection -- colecao.json --base-path /credito/cdc/v1 --saida catalogo/cdc/openapi.yaml
 *
 * O arquivo gerado é um rascunho: revise limites, enums e campos obrigatórios (procure por
 * REVISAR e x-revisar) antes de usar como contrato.
 */
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "base-path": { type: "string" },
    saida: { type: "string" },
  },
});

const arquivo = positionals[0];
if (!arquivo) {
  console.error("Uso: npm run collection -- <colecao.json> [--base-path /prefixo/v1] [--saida openapi.yaml]");
  process.exit(1);
}

const colecao = JSON.parse(readFileSync(arquivo, "utf8")) as Colecao;
const yaml = stringify(colecaoParaOpenapi(colecao, { basePath: values["base-path"] }));
const cabecalho = "# RASCUNHO gerado de uma collection. Revise todos os pontos marcados com REVISAR.\n";

if (values.saida) {
  writeFileSync(values.saida, cabecalho + yaml);
  console.log(`Rascunho salvo em ${values.saida}`);
} else {
  process.stdout.write(cabecalho + yaml);
}
