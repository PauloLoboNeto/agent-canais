import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Catalogo, definicaoTool } from "../src/catalogo.js";
import { RAIZ } from "./apoio.js";

const catalogo = Catalogo.carregar(join(RAIZ, "catalogo"));

describe("catálogo", () => {
  it("carrega os produtos e filtra por canal", () => {
    expect([...catalogo.produtos.keys()]).toEqual(["cdc", "consignado", "fgts"]);
    expect(catalogo.produtosDoCanal("operacoes").map((p) => p.nome)).toEqual(["consignado"]);
    expect(catalogo.produtosDoCanal("mobile")).toHaveLength(3);
  });

  it("gera o schema da tool a partir do OpenAPI, sem os parâmetros que vêm da sessão", () => {
    const [simular] = catalogo.operacoes("consignado", "simulacao", "mobile");
    const schema = simular!.schemaEntrada as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["ofertaId", "prazoMeses", "valor"]);
    expect(schema.required).not.toContain("cpf");
    expect(schema.properties.prazoMeses).toMatchObject({ type: "integer", minimum: 6, maximum: 96 });
  });

  it("tool de escrita não expõe nada para a LLM preencher", () => {
    const [efetivar] = catalogo.operacoes("consignado", "efetivacao", "mobile");
    expect(efetivar!.schemaEntrada).toMatchObject({ properties: {}, required: [] });
    // O header de idempotência é do runtime, não da LLM.
    expect(JSON.stringify(efetivar!.schemaCompleto)).not.toContain("Idempotency-Key");
  });

  it("monta a descrição com o complemento do manifesto e os exemplos", () => {
    const [simular] = catalogo.operacoes("consignado", "simulacao", "mobile");
    const { function: fn } = definicaoTool(simular!);
    expect(fn.name).toBe("consignado__simularContrato");
    expect(fn.description).toContain("Quando usar:");
    expect(fn.description).toContain("Quando NÃO usar:");
    expect(fn.description).toContain('"prazoMeses":48');
  });

  it("enum do OpenAPI chega até a LLM", () => {
    const [simular] = catalogo.operacoes("cdc", "simulacao", "gerente");
    expect(JSON.stringify(simular!.schemaEntrada)).toContain("[5,10,15,20]");
  });

  it("um exemplo desatualizado no manifesto derruba o boot", () => {
    const pasta = mkdtempSync(join(tmpdir(), "catalogo-"));
    cpSync(join(RAIZ, "catalogo", "consignado"), join(pasta, "consignado"), { recursive: true });
    const manifesto = join(pasta, "consignado", "manifesto.yaml");
    writeFileSync(manifesto, readFileSync(manifesto, "utf8").replace("prazoMeses: 48 }", "prazoMeses: 200 }"));
    expect(() => Catalogo.carregar(pasta)).toThrow(/exemplo "cliente pede 10 mil em 48 meses" não bate com o schema/);
  });
});
