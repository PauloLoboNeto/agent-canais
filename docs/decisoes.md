# Decisões de arquitetura

Registro das decisões que deram forma a este esboço e do porquê de cada uma.

## 1. A LLM não chama APIs: ela pede, o runtime executa

A LLM nunca tem acesso direto às APIs. Ela devolve um pedido estruturado ("chame a tool X com estes argumentos"), e quem executa é o nosso runtime, com as credenciais do cliente, timeout, logs e validação. É isso que permite colocar allowlist, guardas e idempotência no meio do caminho.

## 2. Tools nativas, sem MCP

O MCP seria só uma forma de empacotar as mesmas ferramentas. Preferimos tools nativas do provedor, geradas dentro do nosso serviço. Isso elimina um processo e um protocolo a mais e deixa a troca de modelo restrita ao adaptador (`src/modelo.ts`). O formato de tool muda um pouco entre provedores, mas o LangChain faz a conversão.

## 3. Catálogo: OpenAPI como contrato, manifesto como complemento

Cada time entrega uma pasta com o OpenAPI que já publica no gateway e um manifesto curto. O OpenAPI dá o schema que o runtime valida, com tipos, limites, enums e obrigatórios. O manifesto dá o que a LLM precisa para escolher bem (quando usar, quando não usar, exemplos) e o que o runtime aplica (etapa, efeito, guardas, parâmetros de contexto, canais, cartão).

A collection do Postman foi considerada como fonte do schema e descartada: ela mostra uma chamada que funcionou, mas não as regras, e costuma carregar dados reais. Ela entra de duas formas. Os exemplos (sem dados pessoais) vão para o manifesto. Para quem não tem spec, existe um conversor de collection para um rascunho de OpenAPI, que o time revisa uma única vez.

## 4. Grafo declarativo: a ordem obrigatória fica nas transições, não numa skill

A primeira ideia era ter uma skill inicial dizendo a ordem de execução das etapas. Isso foi trocado por transições declaradas em YAML com guardas em código, porque, com uma skill, a ordem viraria instrução, e instrução a LLM segue quase sempre, não sempre. No LangGraph, o trabalho acontece nos nós (uma etapa = uma capacidade = skill + tools da etapa), e as arestas decidem o próximo passo.

A LLM só escolhe onde existe escolha de verdade (por exemplo, voltar da simulação para a oferta), e mesmo assim a saída é um enum com as opções que as guardas liberaram. Transições como "confirmou, então efetiva" são automáticas e não passam pela LLM. O grafo é montado em tempo de execução a partir dos YAML, então um produto com um passo a mais (FGTS e a autorização) estende o fluxo padrão sem código novo.

## 5. Skills por etapa e produto, carregadas pelo nó

O nó sabe a etapa e o produto e carrega a skill certa, com fallback para a skill padrão da etapa. A LLM não precisa de uma tool para escolher skills nem enxerga roteiros de outros produtos. O contexto fica curto e com poucas tools, e isso reduz erro tanto na escolha da tool quanto no preenchimento dos argumentos.

## 6. Confirmação é ação estruturada, não texto

"Pode contratar" escrito no chat não contrata nada. A confirmação é o toque no botão do cartão, que o canal envia como ação ligada a uma simulação específica. Uma nova simulação invalida a confirmação anterior, e a confirmação é consumida por uma única tentativa de escrita. O cartão com taxa e CET é desenhado por código a partir da resposta da API, com os campos que o time declarou.

## 7. Token do cliente e parâmetros sensíveis fora da LLM

O gateway recebe o token do próprio cliente, então quem decide o que ele pode ver continua sendo a API do time. CPF e IDs de simulação confirmada vêm do contexto (`doContexto`) e são removidos do schema que a LLM enxerga. Como o schema tem `additionalProperties: false`, se a LLM tentar mandar um CPF, a validação recusa.

## 8. Avaliação por estado final e pass^k, como no τ-bench

Benchmarks de "seguir instruções" (IFEval, IFBench) medem restrições de formato numa resposta e dizem pouco sobre seguir um roteiro de negócio com APIs. O τ-bench mede exatamente esse cenário: agente com tools, documento de política e usuário simulado, avaliado pelo estado final do banco de dados. Ele também introduziu o pass^k, a chance de acertar a mesma tarefa em todas as k tentativas.

Referências consultadas em novembro de 2026:

- τ-bench: no artigo original, até modelos de ponta da época acertavam menos de 50% das tarefas e tinham pass^8 abaixo de 25% no varejo ([arXiv 2406.12045](https://arxiv.org/abs/2406.12045)).
- τ³-Banking, o domínio de atendimento bancário com base de conhecimento ([blog da Sierra](https://sierra.ai/blog/bench-advancing-agent-benchmarking-to-knowledge-and-voice)). No [leaderboard](https://www.mercor.com/apex/partner-benchmarks/tau-3-banking-leaderboard/sample-task/) aparecem Claude Opus 5.5 com 55,0%, Claude Sonnet 5.5 com 54,0% e GPT-6 Astra com 46,7%.
- IFBench ([Ai2](https://allenai.org/blog/ifbench-artificial-analysis)) e IFEval ([arXiv 2311.07911](https://arxiv.org/abs/2311.07911)), como referência geral de seguir instruções.

A conclusão prática é que modelos melhores sobem o teto, mas não chegam a 100%. Por isso as garantias ficam em código e o modelo é escolhido pelas nossas próprias evals. Como a diferença entre o Opus 5.5 e o Sonnet 5.5 é pequena nesse benchmark, vale medir se o modelo mais barato e mais rápido já atende o canal.

## 9. Mudanças de texto têm peso de deploy

Skills, manifestos e fluxos mudam o comportamento do canal em produção. Toda alteração passa pelas evals antes de ser publicada, do mesmo jeito que código passa pelos testes.
