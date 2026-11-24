import { describe, expect, it } from "vitest";
import { colecaoParaOpenapi, type Colecao } from "../src/collection.js";

const colecao: Colecao = {
  info: { name: "Crédito Pessoal" },
  item: [
    {
      name: "Limite",
      item: [
        {
          name: "Consultar limite",
          request: { method: "GET", url: { raw: "{{baseUrl}}/credito/cdc/v1/clientes/:cpf/limite", path: ["credito", "cdc", "v1", "clientes", ":cpf", "limite"] } },
        },
      ],
    },
    {
      name: "Simular empréstimo",
      request: {
        method: "POST",
        url: "{{baseUrl}}/credito/cdc/v1/simulacoes",
        body: { mode: "raw", raw: '{ "cpf": "11122233344", "valor": 3000, "prazoMeses": 12, "seguro": false, "taxa": 4.9 }' },
      },
    },
  ],
};

describe("collection para OpenAPI", () => {
  const spec = colecaoParaOpenapi(colecao, { basePath: "/credito/cdc/v1" }) as { paths: Record<string, Record<string, any>> };

  it("gera caminhos, operationIds e parâmetros de path", () => {
    expect(Object.keys(spec.paths)).toEqual(["/clientes/{cpf}/limite", "/simulacoes"]);
    const limite = spec.paths["/clientes/{cpf}/limite"]!.get;
    expect(limite.operationId).toBe("consultarLimite");
    expect(limite.parameters[0]).toMatchObject({ name: "cpf", in: "path", required: true });
  });

  it("infere tipos do corpo, marca para revisão e não copia os valores de exemplo", () => {
    const simular = spec.paths["/simulacoes"]!.post;
    expect(simular.operationId).toBe("simularEmprestimo");
    expect(simular["x-revisar"]).toBe(true);
    const schema = simular.requestBody.content["application/json"].schema;
    expect(schema.properties.prazoMeses.type).toBe("integer");
    expect(schema.properties.taxa.type).toBe("number");
    expect(schema.properties.seguro.type).toBe("boolean");
    expect(schema.required).toBeUndefined();
    expect(JSON.stringify(spec)).not.toContain("11122233344");
  });
});
