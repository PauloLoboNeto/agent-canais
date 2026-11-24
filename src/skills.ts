import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Skills são texto: o roteiro de cada etapa. O nó do grafo decide qual carregar
 * (etapa + produto), então a LLM não precisa escolher skill nem ler as dos outros produtos.
 *
 * Ordem de busca para a etapa: catalogo/<produto>/skills/<etapa>.md, depois skills/_padrao/<etapa>.md.
 */
export class Skills {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly raizCatalogo: string,
    private readonly raizSkills: string,
  ) {}

  politica(): string {
    return this.ler(join(this.raizSkills, "_comum", "politica.md")) ?? "";
  }

  triagem(): string {
    return this.ler(join(this.raizSkills, "_comum", "triagem.md")) ?? "";
  }

  daEtapa(produto: string, etapa: string): string {
    return (
      this.ler(join(this.raizCatalogo, produto, "skills", `${etapa}.md`)) ??
      this.ler(join(this.raizSkills, "_padrao", `${etapa}.md`)) ??
      ""
    );
  }

  private ler(caminho: string): string | undefined {
    if (this.cache.has(caminho)) return this.cache.get(caminho);
    if (!existsSync(caminho)) return undefined;
    const texto = semFrontmatter(readFileSync(caminho, "utf8"));
    this.cache.set(caminho, texto);
    return texto;
  }
}

function semFrontmatter(texto: string): string {
  return texto.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}
