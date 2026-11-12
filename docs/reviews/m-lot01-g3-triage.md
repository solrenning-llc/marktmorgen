# Triagem do lote 01 — item 41 [G3]

Data da leitura: 06/11/2026; conferência final às 20h41 UTC (17h41 Fortaleza). Autor: Codex M. Base examinada: `90eca6cb59dad6445f63021ab2d81c19740e1f62`, ramo local `codex/m-lot01-g3-triage`. Reserva para este documento confirmada pelo coordenador em `ba488af2d730a2a2f6640394bda2947639d035c6`, antes da escrita. Somente Claude 4 coordena; C1OFF preservado.

**Resultado:** o item permanece **na fila**. Há mecanismos incorporados de avaliações da própria loja e um link público opcional para avaliar no Google. Eles não constituem integração com Google Business Profile (GBP). Não encontrei documentação técnica dedicada, cliente GBP ou preparo testado da publicação de respostas Google no recorte examinado. A disponibilidade ao cliente e a aprovação da conta/projeto são **unknown**: não foram acessadas. Este documento é triagem e proposta de recorte documental, sem implementação ou ativação.

## Base, método e limites

Li `CLAUDE.md`, `AGENTS.md`, `docs/cross-product-handoff.md`, `docs/reservations.md`, os cinco arquivos em `docs/reservations/` e as mensagens CX-116, CX-120, CX-122 e CX-123 em `docs/agent-inbox.md:1487–1553`. Aplicadas as precedências LC/TX/MR/VR e a proibição de alterações operacionais. O trabalho usa `git show HEAD:caminho`, `git ls-tree` e `git grep HEAD`; a cópia foi fornecida sem checkout e sem remote. Não fiz checkout, fetch, clone, instalação, testes, alterações de referências, canal ou CI. Os numerosos `D` do status inicial resultam da cópia sem checkout; não são exclusões feitas por esta triagem.

A busca de implementação cobriu `lib/`, `app/`, `tests/` e `components/`, pelos termos `Google Business`, `Business Profile`, `Google My Business`, `mybusiness`, `business.manage`, `accounts.locations.reviews`, `businessprofile` e `google-business`. Não houve ocorrência de cliente/escopo/endpoint GBP; as ocorrências de `GBP` isolado eram a moeda libra esterlina. Nos documentos, as ocorrências adicionais foram pesquisa de concorrente em `docs/highlevel-gap-matrix.md:117–118`, seu JSON e o comentário de `lib/review-elsewhere.ts:4`; isso não documenta a integração do Marktmorgen.

Não inferi ausência pela tabela histórica de PRs em `docs/reservations.md:19`. Consultei o GitHub atual, em leitura, conforme a seção de sobreposições. A pesquisa não é um inventário de todos os ramos remotos ou arquivos de todos os PRs; ausência global fora do recorte é **unknown**. Também não conferi a publicação, registros de produção, configuração de projeto Google ou conta real.

## Requisito por requisito

| Requisito de G3 | Evidência concreta na base | Estado e diferença confirmada |
| --- | --- | --- |
| Registrar o pedido e preservar sua identidade | `docs/codex-queue.md:2741–2745`: documentar GBP, preparar respostas desligadas até aprovação, calcular quotas/custos/aprovação/armazenamento. `docs/completeness-audit/lot-01.json:761–766`: `not started`, `Not audited`, `asks: []`. | Pedido presente; a matriz ainda não auditava seus requisitos. Não criar outro item nem usar `asks: []` como prova de cobertura. |
| Documentar os requisitos específicos de GBP | A busca documental acima encontrou somente fila, auditoria não feita e comparação com HighLevel. | Lacuna no recorte: falta documento de acesso, autorização, operação, limites, dados e critério de ativação. Fontes oficiais alcançadas abaixo permitem um primeiro documento sem conta. |
| Conectar e autorizar GBP | `app/api/integrations/google/start/route.ts:5–15` conecta Calendar; o callback em `app/api/integrations/google/callback/route.ts:11–28` distingue Calendar, Search Console e login. `lib/meet-providers.ts:74–81` pede escopos de Calendar; `lib/search-console.ts:36` pede `webmasters.readonly`; `lib/google-signin.ts:57–60` mantém a aprovação de login false e pede apenas `openid`/`email`. | Incorporação dessas integrações não prova aprovação GBP. Falta preparo específico de autorização GBP no código examinado. Não ampliar o callback compartilhado nem copiar a aprovação de login. |
| Ler avaliações Google e publicar/editar a resposta | `lib/reviews.ts:74–81` usa chaves Redis próprias; `lib/reviews.ts:506–511` modifica a resposta interna por produto. `app/api/store/reviews/route.ts:82–101` exige produto/id e chama esse `setReply`. `app/studio/reviews/page.tsx:11–18` importa os leitores internos. | Respostas internas incorporadas; não são transporte GBP. Não há prova de listagem Google, vínculo conta/local/avaliação ou `updateReply` no recorte. |
| Aproveitar o que já existe sem duplicar | `lib/review-elsewhere.ts:28–65` valida URL pública Google/Trustpilot/Facebook. `tests/review-elsewhere.test.ts:17–38,54–68` verifica destinos e inclusão no pedido de avaliação. `tests/review-reply-ai.test.ts:2–9,20–24,35–53` usa modelo simulado e avaliações internas. | Reaproveitamento possível de conceitos, permissões e apresentação, sujeito a revisão. Link externo e rascunho de IA não comprovam leitura ou resposta pela API Google. Estes testes foram lidos, não executados nesta triagem. |
| Permanecer desligado até aprovação | Exigência explícita em `docs/codex-queue.md:2741`; `lib/opening.ts:32–33` mantém `OPENING_REQUESTED` false e deriva `PLANS_ON_SALE` pelos gates existentes. Nenhum adaptador GBP foi encontrado. | Ainda não cabe dizer “construído e testado, desligado pelas travas”. O recurso GBP está na fila. Falta contrato próprio do que seria aprovação suficiente e teste de zero chamadas antes dela. Não mudar flags/gates existentes. |
| Calcular quotas e custos antes de fornecedor | `docs/codex-queue.md:2745` exige o cálculo. Busca específica não encontrou linha GBP em `tests/plan-cost-registry.ts`. | Lacuna: quantidade de locais, páginas, chamadas, renovação de token, repetição e custo completo por plano mensal/anual não demonstrados. A cota efetiva do projeto e de Reviews v4 é unknown. Tarifa pública da API não fecha hospedagem, Redis, filas, operação, IA eventual nem FX275. |
| Definir armazenamento, exclusão e exportação | Busca específica não encontrou família/integração GBP em `tests/store-data-registry.ts`, `lib/person-data.ts` ou `lib/person-erasure.ts`. Os registros de avaliações internas não provam cobertura de dados Google. | Lacuna: esquema mínimo, prazo, proteção de credenciais, desligamento e tratamento de cópias Google ainda não demonstrados. Regras Google não devem ser herdadas das avaliações internas por suposição. |
| Aprovação real e prova operacional | Nenhuma conta, console ou API autenticada acessada. | **Unknown**, não “negada”, “aprovada” ou “aguardando terceiros”. Nenhum pedido enviado. Não há prova de jornada real, publicação ou logs sem erro de G3. |

## Sobreposições e reservas

Leitura dos cinco arquivos de reservas no HEAD não mostrou reserva específica de GBP/G3 ou deste documento. Isso não libera arquivos ocupados por PRs atuais. A confirmação posterior da reserva deste relatório foi recebida pelo coordenador; não alterei o arquivo central de reservas.

Consultas GitHub em 06/11/2026: `search_prs`, repositório `solrenning-llc/marktmorgen`, estado `open`, `topn:100`, buscas `Google Business Profile`, `G3` e `lot01`: zero resultados. Busca `google`: nove resultados, incluindo login, Calendar e anúncios. Busca `review`: atingiu 100 resultados, portanto truncada para fins de ausência. Não foi usada para concluir inexistência global.

Confirmei metadados, conteúdo e todos os nomes de arquivos dos três PRs relacionados abaixo via `fetch_pr` e `list_pr_changed_filenames`; todos estavam abertos e não incorporados na consulta:

| PR e head exato consultado | Arquivos/sobreposição | Consequência |
| --- | --- | --- |
| [#2841](https://github.com/solrenning-llc/marktmorgen/pull/2841), `62f243d3e836040422a178fa933fd39f42ace680` | `app/studio/reviews/page.tsx`, `app/studio/blog/page.tsx`, `components/empty-state.tsx`, dois testes de estados vazios. O conteúdo trata avaliações internas. | A página Reviews está ocupada. Não iniciar UI GBP nela. |
| [#2819](https://github.com/solrenning-llc/marktmorgen/pull/2819), `3aac53168eb0686b7eb0ed4427fd1e473d42bd24` | `lib/meet-routes.ts`, três testes de callbacks e `tests/test-config.mjs`; Calendar/Zoom e recibos de contador. | Não alterar ou reutilizar o fluxo de callback em paralelo sem coordenação. Não implementa GBP pelo conteúdo lido. |
| [#2671](https://github.com/solrenning-llc/marktmorgen/pull/2671), `a1ba165cc837e56c7efbba102825c55008297bad` | `components/google-signin.tsx`, `docs/google-signin.md`, teste do botão. | Documentação e identidade de login ocupadas; aprovação de login não é aprovação GBP. |

## Fontes oficiais alcançadas nesta triagem

Páginas públicas lidas em 06/11/2026, sem login, formulário ou aceite. Os números de linha abaixo identificam o texto extraído na sessão; os URLs são a referência durável. A data indicada pela página é distinta da data de leitura.

| Fonte oficial | Conteúdo confirmado e limite da prova |
| --- | --- |
| [Prerequisites](https://developers.google.com/my-business/content/prereqs), atualização indicada 28/08/2026, linhas 75–98 | Acesso depende de projeto e aprovação; requer perfil verificado e ativo há mais de 60 dias e website. Distingue quota 0 de 300 QPM como indicação de aprovação. Não prova o estado de projeto do dono. |
| [Basic setup](https://developers.google.com/my-business/content/basic-setup), linhas 59–88 | Aprovação precede habilitação; dados protegidos usam OAuth 2.0. A página menciona possíveis solicitações de billing/termos; nenhuma foi executada. Não completar essas ações por este documento. |
| [updateReply](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply), atualização indicada 07/04/2026, linhas 341–366 | `PUT https://mybusiness.googleapis.com/v4/{name=accounts/*/locations/*/reviews/*}/reply`, objeto `ReviewReply`, local verificado; escopo `business.manage` (a referência também lista o escopo legado). É contrato público, não chamada testada. |
| [Policies](https://developers.google.com/my-business/content/policies), atualização indicada 28/08/2026, linhas 50,68,76–78,97–109 | Exige autoridade sobre o perfil e autorização para responder; ações automatizadas precisam de consentimento prévio específico e expresso. Restringe acesso indireto/programático de terceiros. Conteúdo temporário limitado: seguro, até 30 dias, sem manipulação/agregação. Desvinculação deve ser possível em sete dias úteis. A adequação do desenho concreto continua pendente. |
| [Usage limits](https://developers.google.com/my-business/content/limits), linhas 44–68 | Há quotas e recusa 429. A tabela lista 300 QPM para APIs nomeadas; não é prova de quota efetiva de Reviews v4 no projeto do dono. Nenhum aumento solicitado. |
| [Pricing](https://developers.google.com/my-business/content/pricing), atualização indicada 28/08/2026, linhas 34–41 | A página informa que a API Google My Business não cobra pelo uso de usuários registrados. Isso não atribui zero ao custo completo do recurso e não autoriza consumo de franquia como custo zero. |
| [FAQ](https://developers.google.com/my-business/content/faq), linhas 69–102 | Aprovação do projeto não dá acesso a todo perfil; a API Reviews está na família v4.9. Dados de qualquer perfil não podem ser consultados por mera aprovação do projeto. |

`https://developers.google.com/my-business/content/oauth` retornou erro de acesso nesta ferramenta. Não extraí conclusão dessa falha; o requisito OAuth acima vem de Basic setup e do contrato de updateReply. Cobertura de verificação OAuth, configuração, quotas e credenciais reais: **unknown**.

## Próximo recorte documental seguro

Proposta para coordenação, sem iniciar implementação: um documento dedicado de requisitos de G3, com as fontes acima datadas, uma matriz de aprovação/projeto/perfil/consentimento, contrato da resposta e uma planilha de operações/custos/dados ainda desconhecidos. Manter o mesmo item 41 e sua posição; não editar a fila ou o JSON como se a preparação estivesse pronta.

O documento deverá separar o link público já existente, as respostas internas e o transporte Google futuro; mapear os mecanismos reutilizáveis; especificar estados desconhecidos e recusas; definir prova mínima de ativação sem preencher aprovação; registrar as condições de proteção e retenção da fonte oficial; e fechar quais dados realmente precisam ser guardados. A modelagem de custos precisa contar chamadas e repetições máximas, páginas, locais, renovação de token, CPU/rede, Redis, filas, exclusão, suporte e eventual IA, por plano mensal e anual, com tetos antes do gasto. Sem teto e custo completos não há margem demonstrada. Nenhum valor desconhecido deve virar zero.

Critério para uma implementação futura, após reserva e autorização de escopo: testes sintéticos do código real que provem ausência de chamada Google enquanto não aprovado, isolamento entre lojas, autorização do perfil e da ação, recusa de credenciais/escopos insuficientes, envelopes incompletos como unknown e tratamento de 401/403/429/timeout sem sucesso inventado. A confirmação de gravação remota não deve ser confundida com visibilidade pública da resposta. Esse preparo não precisa nem autoriza um perfil falso, conta de teste real, login, contato ou solicitação de aprovação.

Benefício proposto: o criador responder a avaliações no lugar em que trabalha. Caminho de lucro ainda é hipótese de retenção/redução de trabalho; não foi medido. Não há cálculo de lucro ou base mínima nesta triagem.

## Verificação e estado entregue

Somente este arquivo foi criado após a reserva. Não houve alteração de código, teste, preço, limite, comissão, chave, conta, fornecedor, conteúdo de criador, PII, termo ou gate. Não houve envio de mensagem externa, PR, push, ação de CI ou acesso autenticado ao Google. O coordenador é responsável pela publicação deste relatório no próprio fluxo autorizado.

Acessibilidade: relatório Markdown com títulos e tabelas; nenhuma interface alterada, 0 → 0 passos e decisões. Não houve navegador, leitor de tela, teste humano ou certificação AAA. Leitura estática e busca documental não equivalem a teste funcional. O cliente não ganhou recurso novo por esta triagem.

## Incremento documental — requisitos de GBP

Solicitado pelo coordenador após a entrega do snapshot de triagem acima, na mesma reserva e no mesmo HEAD. Data: 06/11/2026. O texto anterior permanece como registro daquela leitura; as propostas desta seção não foram implementadas, testadas ou aprovadas pelo Google. G3 continua **na fila**, agora com requisitos documentais detalhados. Não houve nova consulta de PRs neste incremento, pois nenhum arquivo de produto foi reservado ou alterado.

### Obrigações e contratos confirmados em fonte oficial

As exigências de projeto, perfil e autorização estão nas fontes Prerequisites, Basic setup, FAQ e Policies já identificadas. São condições diferentes: aprovação do projeto não confirma autorização sobre um perfil; autorização OAuth não substitui a autorização específica para a resposta. Os critérios operacionais propostos adiante servem para verificar essas condições, sem declarar que a conta real as cumpre.

Novas fontes públicas alcançadas em 06/11/2026, aproximadamente 20h50 UTC, sem chamada autenticada:

| Fonte oficial e data indicada | Contrato confirmado |
| --- | --- |
| [Review e ReviewReply](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews), atualização 24/07/2026; linhas extraídas 349–444 | `Review.name` identifica conta/local/avaliação. `ReviewReply.comment` aceita até 4096 **bytes**; `updateTime` é saída do servidor. Há estados de moderação `PENDING`, `REJECTED`, `APPROVED` e não especificado. A referência admite novos valores de violação no futuro. |
| [reviews.list](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list), atualização 07/04/2026; linhas 343–396 | GET de avaliações de local verificado; corpo vazio; página de até 50 avaliações e continuação por `nextPageToken`. A resposta inclui avaliações e campos de total/média. Este máximo por página não determina a quota de chamadas nem o limite de produto. |
| [reviews.get](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/get), atualização 07/04/2026; linhas 341–366 | GET da avaliação indicada, somente em local verificado; `NOT_FOUND` para avaliação inexistente ou apagada. Sucesso devolve `Review`. |
| [Work with review data](https://developers.google.com/my-business/content/review-data), atualização 02/11/2026; linhas 100–110 | Aviso explícito: `reviews.get` não devolve atualmente `reviewReplyState` nem `policyViolation`; esses campos são obtidos por `reviews.list` ou `batchGetReviews`. Não inferir aprovação de moderação a partir de `get`. |
| [deleteReply](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/deleteReply), atualização 07/04/2026; linhas 341–366 | DELETE do caminho da resposta, somente para local verificado, corpo de pedido vazio e objeto JSON vazio no sucesso. Remove a resposta, não a avaliação do comprador. A operação não foi executada. |
| [OAuth para aplicação web — revogação](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke), atualização 30/10/2026; linhas 1737–1815 | Existe revogação por `oauth2.googleapis.com/revoke`; sucesso é 200 e pode demorar a produzir efeito completo. A documentação alerta que a revogação remove os escopos concedidos ao projeto para aquele usuário e invalida tokens dos clientes do projeto. Isso exige avaliar o impacto sobre outras integrações; nenhuma revogação foi feita. |

Nenhuma fonte consultada demonstra a aprovação, identidade, credenciais, perfil, local verificado ou escopos efetivos da conta real do dono. A compatibilidade jurídica e contratual do desenho completo, inclusive exportação e uso de dados em IA, permanece **unknown**. Não há conclusão jurídica ou aceite de termos neste documento.

### Desenho proposto — identidade, alvo e consentimento

Esta matriz é especificação proposta do Marktmorgen, não descrição de comportamento já existente nem lista de garantias dadas pelo Google. Na futura implementação, uma condição desconhecida impede a escrita; não preenchemos as condições por inferência de um login Google já disponível.

| Checagem antes de qualquer resposta | Evidência que o desenho deverá conferir | Se faltar ou divergir |
| --- | --- | --- |
| Identidade da aplicação | Identificador do projeto/cliente GBP e prova de aprovação aplicável, com data e escopo, no mecanismo de revisão autorizado futuramente. | Nenhuma chamada GBP. Aprovação de login, Calendar ou Search Console não satisfaz essa checagem. |
| Pessoa e loja | Sessão atual, loja efetivamente selecionada e permissão atual de responder. O vínculo da conexão pertence à mesma loja e continua ativo. | Negar sem trocar para outra conexão ou usar a última conta do navegador. |
| Conexão Google | Resultado do fluxo OAuth ligado à sessão/loja, uso único do estado e escopos realmente concedidos. A identidade da conexão não pode ser apenas um e-mail digitado. | Não usar token de outra conexão nem tratar recusa parcial como permissão completa. |
| Conta e local | Recurso escolhido a partir dos locais legitimamente acessíveis à conexão, com identificação legível para a pessoa; conferir vínculo servidor → loja → conexão → conta/local e condição de local verificado. | Não aceitar caminho ou URL arbitrário enviado pelo navegador. Se não houver mecanismo documentado para confirmar uma condição, registrar unknown e parar. |
| Avaliação | Nome canônico de avaliação lido pela conexão e pertencente ao local selecionado; conservar a versão exibida para revisão. | Não transformar id interno de produto ou URL pública de avaliação em autoridade para uma resposta Google. |
| Autorização da ação | Mostrar local, avaliação, texto exato e se a resposta existente será substituída; a pessoa confirma aquela ação. Vincular a confirmação à loja, conexão, recurso, conteúdo e versão de conexão. | Texto alterado, alvo diferente, troca de loja, perda de acesso ou desvinculação exigem nova confirmação; nenhum envio automático. |

O botão de conectar permitiria solicitar autorização de acesso; o de publicar confirmaria uma resposta específica. Essa separação é proposta para tornar verificável o consentimento descrito na fonte. O aceite de uma ação não é autorização genérica para responder a todas as avaliações. Rascunhos por IA, gatilhos, filas de publicação automática e acesso por agentes não fazem parte deste recorte proposto; sua adequação e seu custo não foram demonstrados.

### Desenho proposto — gravação, leitura e resultado desconhecido

Contrato de envio proposto: usar somente o host/caminho fixo de `updateReply` já citado; enviar o campo `comment`, sem copiar campos de saída do Google. Validar texto e tamanho em bytes UTF-8 antes da confirmação; não truncar silenciosamente o texto que a pessoa aprovou. Texto vazio não deverá ser interpretado como exclusão: a fonte oferece `deleteReply` como operação própria, sujeita a autorização específica e fora da ativação deste recorte.

| Situação observada pelo futuro transporte | Estado e comportamento propostos |
| --- | --- |
| Condição de acesso, custo, reserva ou confirmação não satisfeita | `não enviado`: nenhuma chamada de gravação. A ausência de custo revisto impede implementação operacional, sem criar um cálculo financeiro paralelo. |
| Reserva/registro local de operação sem recibo exato | `unknown`: não iniciar a gravação. A futura reserva atômica deve ligar a operação à confirmação e à versão da conexão; não separar verificação e marcação em passos vulneráveis a corrida. |
| Pedido despachado, sem resposta utilizável, timeout, conexão interrompida, 5xx ou corpo ilegível | `resultado desconhecido`: não dizer que falhou sem gravar nem que publicou; não repetir PUT automaticamente. Uma conferência posterior também exige acesso e custeio e pode continuar inconclusiva. |
| HTTP de sucesso e objeto `ReviewReply` validado, com conteúdo esperado | `gravação confirmada pelo Google`: não equivale a aprovação de moderação ou visibilidade pública. Tipos inválidos, conteúdo divergente ou tempo inválido impedem declarar confirmação da resposta esperada. Campos opcionais novos não autorizam inventar valores para campos ausentes. |
| Estado de moderação conhecido em fonte que o fornece | Preservar `pendente`, `rejeitado` ou `aprovado pelo Google` com momento da leitura. Valor ausente, não especificado ou desconhecido permanece desconhecido; não vira aprovado. Não prometer visibilidade pública medida por esse campo. |
| 401/403 ou escopo insuficiente | Parar a operação e mostrar que o acesso precisa ser revisto. Não pedir novo consentimento em segundo plano nem trocar de conta. O código HTTP isolado não prova qual condição comercial/de perfil faltou. |
| 429 | Não gravado como sucesso. Uma política futura de espera/repetição precisa de limites e custeio; nenhum prazo, quota ou tentativa automática foi escolhido aqui. |
| Leitura paginada parcial, cursor repetido, item de outro local, total/média inválidos ou envelope ambíguo | Mostrar leitura incompleta/indisponível, conservar a distinção entre “nenhuma avaliação” e “não foi possível conferir”. Campos omitidos não viram zero/lista vazia sem prova do envelope válido de ausência. |

Uma trava local evita dois despachos concorrentes do próprio sistema; não prova execução única no fornecedor. As fontes lidas não estabelecem chave de idempotência nem atualização condicional para `updateReply`. Mesmo uma releitura com texto coincidente não demonstra qual tentativa o gravou. Se o proprietário responder por outro aplicativo entre leitura e PUT, não há garantia de prevenção de sobrescrita demonstrada. Registrar essa limitação e exigir revisão do texto atual antes de uma tentativa posterior; não anunciar proteção contra conflito remoto que não foi provada.

### Desenho proposto — dados mínimos e ciclo de vida

Aplicar as restrições de armazenamento e desligamento de Policies já resumidas acima. Os prazos dessa fonte não se tornam licença para copiar todos os dados nem prazo padrão de retenção de credenciais. A proposta inicial privilegia exibição transitória, sem cópia histórica de avaliações Google, e não alimenta médias, resumos, perfis ou modelos internos com esse conteúdo.

| Classe proposta | Mínimo necessário para a tarefa | Persistência/exportação/exclusão a especificar antes de código |
| --- | --- | --- |
| Vínculo da integração | Loja, identificador opaco da conexão, referências de conta/local, versão ativa e permissões conferidas. | Acesso por loja; invalidar a versão ao desligar. Referências e rótulos retornados pelo Google também precisam de classificação e política de prazo; não presumir que metadados estão isentos. |
| Credenciais | Apenas tokens e material estritamente necessário ao fluxo autorizado. | Segredo protegido no servidor, nunca em URL, log, exportação ou navegador. Retenção, renovação, revogação e efeito em outros escopos precisam de desenho revisto; não armazenar senha Google. |
| Conteúdo recebido | Identificação do local/avaliação e texto/resposta necessários à tela atual. | Preferir memória da requisição. Se cache for indispensável, justificar campos e prazo, proteger, apagar no vencimento/desligamento e respeitar a restrição oficial; sem indexação ou cópia em analytics/logs. Sem fotos, mídia e perfil do avaliador por padrão. |
| Rascunho e confirmação | Texto que a pessoa compôs, ação e alvo aprovados, versão de conexão e estado da operação. | Preferir rascunho local/transitório; não arquivar a avaliação de terceiro para provar consentimento. Qualquer prova durável, texto ou impressão digital precisa de finalidade, prazo, custo e revisão; hash não é dado anônimo presumido. |
| Estado técnico mínimo | Identificador aleatório da operação, resultado classificado e momento, sem corpo, token ou nome do avaliador nos logs. | Não criar log permanente. Prazo, capacidade, descarte e comportamento após expiração permanecem unknown até revisão; sem isso não habilitar operação. |
| Cópia da pessoa/loja | Configurações próprias e estado real da integração que possam ser exportados com segurança. | O formato completo e a permissão de incluir conteúdo recebido do Google ainda são unknown. Não exportar segredos nem conteúdo de terceiros por padrão; não chamar a cópia de completa enquanto essa lacuna existir. |

Desvinculação proposta: invalidar primeiro a versão da conexão para impedir novos despachos e impedir que trabalhos antigos a reutilizem; retirar rascunhos/pendências locais; apagar cópias e caches sob controle do Marktmorgen e seus índices. O fluxo deverá diferenciar trabalho ainda não enviado de pedido já despachado com resultado desconhecido. Desligar não desfaz a resposta já enviada ao Google e não deve disparar `deleteReply`.

A remoção local e a retirada de acesso Google são resultados distintos. A revogação remota pode atingir Calendar ou outros escopos do mesmo projeto/usuário, conforme a fonte OAuth; escolher outro client ID dentro do mesmo projeto não demonstra isolamento desse efeito. A topologia real é unknown. Documentar o mecanismo adequado para abandonar o acesso sem dano às integrações existentes antes de propor qualquer execução. Falha/atraso remoto não pode aparecer como “acesso Google removido”; trabalhos da conexão antiga continuam proibidos localmente.

Exclusão e exportação precisam cobrir os registros propostos desde o primeiro PR de implementação, nos registries e caminhos já exigidos pela CX-123. Exclusão local não pode ser relatada como exclusão da avaliação pública de um terceiro. Uma conta/aplicação que deixou de usar GBP não autoriza buscar novamente conteúdo para completar sua cópia ou reconstituir dados apagados. O tratamento de backups, exceções de retenção, direitos da pessoa e dados que Google mantém não foi verificado juridicamente; fica como lacuna explícita, sem prazo inventado ou promessa de apagamento externo.

### Aceitação documental e pendências para implementação

| Prova sintética futura | Resultado necessário antes de considerar preparo testado |
| --- | --- |
| Projeto não aprovado, aprovação unknown, escopo faltante, local não confirmado ou permissão retirada | Zero chamadas GBP de gravação e mensagem fiel à condição conhecida. |
| Duas lojas, troca de conta/local e alteração do texto depois da confirmação | Nenhum token ou consentimento atravessa loja/alvo/conteúdo; confirmação antiga não é reutilizada. |
| Resposta com emoji/acentos no limite de 4096 bytes e acima dele | Medida em bytes, revisão do texto exato e recusa antes do despacho quando excedido; sem corte oculto. |
| Cliques repetidos, corrida com desvinculação e recibo local ambíguo | Uma operação local sob o mesmo proprietário; conexão invalidada não autoriza novo envio; nenhum sucesso fabricado. |
| PUT aceito com corpo perdido e outro aplicativo editando a resposta | Resultado unknown preservado; nenhuma repetição cega ou alegação de controle de concorrência remoto. |
| GET sem estado, list com moderação pendente/rejeitada/desconhecida e paginação parcial | Não mostrar aprovação, lista vazia ou totais completos sem evidência correspondente. |
| Desligamento, expiração e exclusão, incluindo cópias/índices | Sem novo trabalho com a versão antiga; contagem e recibos de remoção exatos; falha parcial não vira exclusão completa. |
| Exportação e logs | Sem tokens, corpos indevidos ou dados de outro local; a cópia informa o que não pôde ser incluído. |

Essas provas ainda **não foram escritas nem executadas**. O próximo passo seguro é a revisão deste contrato documental pela coordenação, junto das lacunas de topologia/autorização de terceiros, dados/exportação, concorrência remota e custos. Não há quantidades máximas de chamadas, duração de fila, preços, limite de plano ou revisão financeira novos neste incremento. Todos os valores não conferidos continuam unknown; nenhum passa a zero.

Verificação do incremento: apenas este Markdown foi acrescentado, sem tocar no snapshot anterior. Sem implementação, instalação, credencial, chamada autenticada, conta, termo, contato, GitHub mutante, canal, referência Git ou CI. Não há autorização real ou recurso novo para o cliente. A seção documental de acessibilidade anterior continua aplicável.
