# Triagem do lote 01 — item 40 [G2]

Data da leitura: 06/11/2026 (UTC). Autor: Codex M. Base local: `90eca6cb59dad6445f63021ab2d81c19740e1f62`, ramo `codex/m-lot01-g2-triage`, sem checkout. Reserva do caminho confirmada pelo coordenador no commit `ba488af2d730a2a2f6640394bda2947639d035c6` antes da escrita. Escopo exclusivo: este relatório; publicação centralizada pelo coordenador.

## Resultado

O agendamento/publicação de posts Meta/TikTok não foi encontrado no recorte examinado. Há peças vizinhas construídas: rascunhos sociais com IA, roteiros fixos, links para perfis, calendários de chamadas e conexão Meta para leitura de gastos. Nenhuma dessas peças demonstra um agendador social. O item 228 [HL9] já contém o estudo mais amplo que abrange o item 40 [G2]; isso é sobreposição de pedido, não absorção por implementação comprovada. Não alterar estados da fila ou do lote por esta triagem.

Estado operacional deste trabalho: **triagem documental local**. O recurso G2 continua **na fila**. Não foi construído um recurso desligado, não houve publicação, ativação, uso com fornecedor nem prova de disponibilidade ao cliente.

## Requisito → estado → evidência

As linhas abaixo referem-se ao HEAD local acima, salvo indicação expressa de GitHub ou fonte externa. “Falta” significa não localizado pelas leituras e buscas descritas, sem alegação de auditoria de todas as versões ou da implantação.

| Requisito ou peça reaproveitável | Estado | Evidência e limite |
| --- | --- | --- |
| Pedido de documentar/preparar Meta/TikTok, desligado até aprovação | presente no pedido | `docs/codex-queue.md:2735–2739`: item 40 [G2], a fazer; custos de postagem, renovação, token e filas exigidos, sem solicitação de aprovação. A presença do pedido não prova execução. |
| Auditoria anterior do lote 01 | falta | `docs/completeness-audit/lot-01.json:752–759`: G2 está `not started`, com `asks: []` e `Not audited`. Não preencher ou editar esse JSON neste recorte. |
| Estudo técnico específico de publicação social | falta | `docs/codex-queue.md:5919–5922` pede `docs/social-scheduler-study.md`; o caminho não consta de `git ls-tree -r --name-only HEAD`. `docs/highlevel-gap-matrix.md:63` registra H14 como lacuna e distingue rascunhos/links de agendamento/publicação. |
| Coordenação com 228 [HL9] | parcial | `docs/codex-queue.md:1553` liga expressamente G2↔HL9; `:7668` exige conferi-los juntos. HL9 cobre Instagram/Facebook/TikTok e mais quatro redes, mas apenas o pedido foi localizado. Falta estudo executado que permita decidir o destino do pedido menor sem duplicação. |
| Rascunhos sociais editáveis e copiáveis | presente como peça vizinha | `lib/ai.ts:819–851` gera X/Instagram/LinkedIn por `counted`; `components/ai-posts.tsx:28–41` chama somente `/api/store/ai`, e `:59–64` copia. `:81` informa que nada é postado. Não agenda nem envia ao provedor social. |
| Prova existente dos rascunhos | presente, não executada nesta triagem | `tests/product-posts-ai.test.ts:18–25,36–56`: modelo substituído por `fetch`; confere fatos, idioma, limites, contagem de tentativa e links. Não é teste de publicação Meta/TikTok, nem evidência de execução com fornecedor. |
| Roteiros para Instagram/TikTok/YouTube | presente como peça vizinha | `docs/marktmorgen-path.md:341–347`: seleção e cópia locais, sem novo rascunho persistido, agenda ou integração de postagem. Isso não cobre o agendador. |
| Links dos perfis sociais | presente como peça vizinha | `lib/store-socials.ts:1–11,16–19,41–43,75–103`: normaliza perfis/@ e URLs dos domínios admitidos. Não contém autorização de publicação. |
| Conexão Meta que autorize publicar posts | falta no recorte; conexão de leitura presente | `lib/meta-ads.ts:277–295`, especialmente `:293`, pede só `ads_read`. `docs/highlevel-gap-matrix.md:65` descreve integração de anúncios somente leitura. A mesma função foi relida via GitHub no `main`, blob `d8a029f40077936a7d403d1c138c22dd39841a52`, e continua pedindo apenas `ads_read`. Não ampliar escopos existentes. |
| Conexão TikTok para postagem | falta no recorte | Inventário `app/api/integrations/` possui Google, Meta e Zoom; não possui TikTok. Busca por `video.publish`, `video.upload`, `media_publish`, `content.publish` e permissões usuais de publicação não localizou implementação de postagem em `lib/`, `app/`, `components/` ou `tests/`. Pixels e APIs de conversão não são postagem. |
| Agenda, fila durável e rotina de posts | falta no recorte | `vercel.json:3–80` lista rotinas de plano, correio, importações e outras tarefas; não há rotina social. `/api/cron/shares` não é compartilhamento social: `app/api/cron/shares/route.ts:5–6,10–24` trata comissão e `settleShares`. Não reutilizar a rotina pelo nome. |
| Calendário existente resolve o agendamento social | falta; finalidade distinta comprovada | `lib/calendar-sync.ts:1–38` importa horários ocupados e exporta chamadas/sessões; `app/studio/calendar/page.tsx:104–107` trata disponibilidade para chamadas de equipe. `app/studio/integrations/page.tsx:17–20,60–65` trata plataformas de e-mail. Nenhuma dessas telas prova agendamento de posts. |
| Custos de postagem, renovação, token, filas, retenção, tentativas e teto anterior ao gasto | desconhecido para G2 | Exigência em `docs/codex-queue.md:2739`; não foi localizada linha específica do agendador em `tests/plan-cost-registry.ts` pela busca de termos sociais/publicação. A linha de serviços externos em `:1245` cobre integrações já existentes e não prova custeio de posts futuros. Nenhum custo desconhecido foi tratado como zero; não há certificação de margem. |
| Desligamento testado do futuro agendador | falta | Não foi localizada implementação G2 cuja ausência de chamadas/oferta pública possa ser testada. A ausência atual do recurso não equivale a código preparado e desligado. Nenhuma flag foi criada ou modificada. |
| Aprovação real de app/conta e publicação ao cliente | desconhecido, não conferido | Sem login, conta, segredo, solicitação de revisão ou chamada produtiva. Documentação, código de leitura e fonte oficial não provam aprovação da conta real ou implantação. |

## Fontes oficiais externas: leitura mínima e limites

Consultadas em 06/11/2026, apenas para distinguir a API de publicação das integrações existentes. Isto não é o estudo completo HL9 e não fixa preços, franquias, limites comerciais ou parâmetros de código.

| Fonte | Resultado verificável | Pendência |
| --- | --- | --- |
| [TikTok — Get Started: Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started), atualizada em 04/08/2026; pré-requisitos e postagem direta | A página foi lida. O fluxo exige app registrado, Content Posting API/Direct Post e escopo `video.publish` aprovado e autorizado pelo usuário. Clientes sem auditoria ficam com visibilidade privada; a retirada dessa restrição exige auditoria. A documentação pede consulta atual das informações do criador e acompanhamento do status da publicação. | Não foi criado app, autorizado usuário ou solicitada auditoria. A página não demonstra agendamento futuro pronto, aprovação do Marktmorgen, custo completo, termos aceitos ou operação real. |
| [Meta — Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) | Tentativa de leitura retornou HTTP 429 em 06/11/2026. | Permissões, elegibilidade por tipo de conta, revisões, versão, mídia, agendamento e condições atuais permanecem desconhecidos nesta triagem. Não substituir a falha por memória ou pelo escopo `ads_read`. |

Sem cotação de fornecedor ou declaração de gratuidade. A preparação exige conferir o custo completo inclusive quando uma API não expõe preço direto na página lida.

## Sobreposições, reservas e PRs

Foram lidos `CLAUDE.md`, `AGENTS.md`, `docs/reservations.md`, os cinco arquivos em `docs/reservations/` e as instruções CX-116/120/122/123 de `docs/agent-inbox.md`. A atribuição do coordenador restringe esta unidade ao relatório e centraliza toda publicação. Não editar reservas, caixa, fila, JSON de lote ou produto.

Reservas locais relevantes: `docs/reservations/codex.md:62` mantém a unidade de hidratação de `components/socials-editor.tsx`/testes de Codex M, distinta deste relatório; `:94` registra provas de retorno OAuth de Codex Z; `:95` registra `lib/ai.ts`/contadores e testes de Codex Z; `:47–53` registra provas/calendário/registros de reuniões de Codex W. As reservas não autorizam mudanças nesses caminhos nesta unidade. O arquivo de Claude 4 conserva uma reserva de janela de vídeo; Claude 2 conserva estoque/carrinho; Claude 3 conserva ferramentas MCP; não há autorização de escrita social daí.

Conferência GitHub somente leitura, em 06/11/2026:

- Busca de PRs abertos por Meta, calendário e termos de agendamento encontrou trabalhos vizinhos, não um agendador demonstrado. Busca dirigida a `HL9`, `social-scheduler-study`, `lot01-g2` e `TikTok` no título não retornou PRs. Busca por texto não prova ausência de todo trabalho não anunciado.
- [#2819](https://github.com/solrenning-llc/marktmorgen/pull/2819): retorno de calendário; a lista real de arquivos é `lib/meet-routes.ts`, três testes de retorno e `tests/test-config.mjs`. Não cobre publicação social.
- [#2835](https://github.com/solrenning-llc/marktmorgen/pull/2835): leituras paralelas da tela Today; a lista real inclui `app/studio/page.tsx`, testes Today/demo e `tests/test-config.mjs`. Nenhum desses arquivos deve ser alterado por esta triagem.
- [#2845](https://github.com/solrenning-llc/marktmorgen/pull/2845) e [#2732](https://github.com/solrenning-llc/marktmorgen/pull/2732): encontrados pela busca, tratam conversões/anúncios. Título e descrição não foram usados como prova de implementação de agendamento, nem houve revisão dos diffs nesta unidade.

As reservas e PRs mudam: a próxima unidade deve repetir a conferência antes de escrever. Nenhuma publicação GitHub/canal, comentário, PR, push, execução ou alteração de CI foi realizada por este subagente.

## Próximo recorte documental seguro

Recomendação ao coordenador: uma única continuação documental de 40 [G2] em conjunto com 228 [HL9], sem abrir uma segunda implementação. Depois de reservar o caminho previsto pelo próprio HL9, elaborar `docs/social-scheduler-study.md`, primeiro com Meta/TikTok e com as demais redes explicitamente pendentes. O caminho ainda não foi escrito ou reservado por esta unidade.

O documento deve separar por rede: produto/API e tipo de conta; ações e mídias admitidas; aprovação do aplicativo versus autorização do criador; documentação lida/data/versão; permissões exatas; vencimento/renovação/revogação; publicação imediata versus agenda local ou nativa; status confirmado versus aceitação sem resultado; requisitos de uso e dados; custos completos de armazenamento/transferência/filas/repetição e revisões; decisões que exigem o dono. Cada ponto sem fonte legível fica desconhecido.

Antes de propor implementação, documentar critérios de aceitação sintéticos: nenhum envio ou anúncio público enquanto desligado; isolamento da loja e do criador; horário/fuso e mudanças de horário; edição/cancelamento antes do despacho; reserva atômica com titular da operação; recusa de resposta parcial/desconhecida; recuperação de timeout sem duplicar postagem; status final confirmado; revogação e exclusão sem recriar dados; mídia acessível e aprovação do conteúdo pelo criador. Isso é contrato proposto para revisão, não código ou garantia já existente.

CSV, recorrência, categoria, RSS, texto alternativo e aprovação por link já estão no complemento de HL9 em `docs/codex-queue.md:22306`; escuta social em `:22307` é outro escopo do mesmo estudo, não autorização para coletar perfis. Não implementar esses complementos nesta triagem. Também não incorporar anúncios de 632 [AA2], mensagens de 39 [G1], blog de 557 [BG1], calendários de chamadas ou pixels ao agendador pela semelhança do nome.

## Validação e acessibilidade

Método: leitura por `git show HEAD:path`, inventário por `git ls-tree`, buscas por `git grep`, leitura atual de arquivo/PRs pelo conector GitHub e duas tentativas de fonte oficial. Nenhum checkout, clone, instalação de dependência ou teste com conta real. Os testes citados foram lidos, não executados; não há resultado RED/GREEN novo, ensaio de navegador, Redis nativo, implantação, log produtivo ou teste humano nesta unidade. O diff deste relatório deve ser conferido pelo coordenador antes de publicação.

Benefício do recorte: evitar duplicar G2/HL9 e confundir funções existentes com uma integração ainda não demonstrada. Caminho de retorno econômico apenas proposto: reduzir retrabalho da preparação; não há receita ou economia medida. Custo de tempo/CI e custo futuro do recurso continuam desconhecidos, nunca zero.

Acessibilidade: relatório em Markdown com títulos e tabela requisito/estado/evidência. Nenhuma interface alterada; passos e decisões do cliente: 0→0. AAA, leitor de tela e usabilidade humana não foram certificados. Preços, limites, comissão, gates, revisão comercial e flags foram preservados; nenhuma ação com fornecedor foi executada.

## Incremento documental — escopos, aprovação e consentimento

Acrescentado em 06/11/2026 por continuidade expressa do coordenador, no mesmo arquivo reservado e HEAD congelado. Este acréscimo registra fontes públicas alcançadas e critérios a conferir; não é solicitação de aprovação, conexão de conta, código pronto ou permissão de publicação. A falha de leitura Meta registrada antes permanece verdadeira como histórico; a coleção oficial alcançada depois reduz somente algumas lacunas de documentação, como discriminado abaixo.

| Produto/fluxo | Escopo identificado e finalidade | Aprovação/autorização conferida na fonte | O que continua desconhecido |
| --- | --- | --- | --- |
| TikTok Content Posting API — Direct Post | `video.publish` para postagem direta; [guia Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-get-started), pré-requisitos, lido em 06/11/2026; atualização indicada 04/08/2026. | O guia exige escopo aprovado para o app e autorizado pelo usuário; distingue auditoria do cliente API da autorização individual. Sem auditoria, a visibilidade fica restrita. | Aprovação/auditoria reais do Marktmorgen; autorização de cada criador; adequação de agenda autônoma; renovação/revogação e exposição total. Nenhuma dessas etapas foi executada. |
| TikTok Content Posting API — Upload | `video.upload`; [guia Upload](https://developers.tiktok.com/docs/en/content-posting-api-get-started-upload-content), pré-requisitos e “Upload draft to TikTok”, lido em 06/11/2026; atualização indicada 04/08/2026. | Também exige aprovação do escopo no app e autorização do usuário. Envia conteúdo para revisão e conclusão da postagem pelo usuário dentro do TikTok, por notificação. | Upload não demonstra publicação automática na hora escolhida; não é substituto comprovado do agendador G2. Cobertura da conta, agenda e ciclo de credenciais continuam sem prova. |
| Meta — Instagram API with Facebook Login | A [coleção oficial Instagram API](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), seção homônima, lista `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` entre permissões de vários usos. | O texto exige conta profissional vinculada a uma Página; a coleção apresenta leitura de token de Página. Não comprova revisão ou acesso efetivo do aplicativo. | Conjunto mínimo por mídia/finalidade, tipo de acesso/revisão e condições atuais precisam da documentação completa. Não pedir permissões de comentários só porque aparecem na coleção. |
| Meta — Instagram API with Instagram Login | A mesma coleção, seção homônima, identifica `instagram_business_basic` e `instagram_business_content_publish`, além de permissões de mensagens/comentários para outros usos. | Conta profissional; configuração distinta da anterior. Não há prova de aprovação real. | Rever permissões mínimas e revisão do fluxo escolhido. Não mesclar famílias de escopos nem copiar permissões de inbox para G2. |
| Meta — Facebook Pages: postagem/agendamento | [Pages API posts](https://developers.facebook.com/docs/pages-api/posts/) retornou HTTP 429; [referência de pages_manage_posts](https://developers.facebook.com/docs/permissions/reference/pages_manage_posts/) ficou inacessível em 06/11/2026. | Não conferida nesta sessão. Nome de permissão na URL não equivale a conteúdo lido ou aprovação. | Escopos/dependências, tarefas de Página, token, revisão, agenda nativa, mídias e condições de publicação continuam desconhecidos. Não preencher por memória. |

Proveniência Meta: o [perfil verificado da equipe Meta no Postman](https://www.postman.com/meta), lido em 06/11/2026, identifica suas coleções como oficiais e o workspace Instagram como oficial. A coleção foi aberta, não apenas encontrada em busca. Não foi identificada data de atualização normativa no trecho lido. As páginas primárias principais de [Instagram content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing/) e [Instagram Login content publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) não foram lidas com sucesso. Nenhum espelho ou repositório de terceiros foi usado como autoridade.

A coleção Meta mostra etapas distintas de container, status e publicação de Reel. Isso documenta processamento separado de postagem; não comprova agendamento nativo ou política de recuperação de uma publicação com resposta perdida. A versão API aplicável e a validade temporal do container continuam a conferir; nenhum número dos exemplos virou parâmetro.

As [Content Sharing Guidelines do TikTok](https://developers.tiktok.com/docs/en/content-sharing-guidelines), atualizadas em 04/08/2026 e lidas em 06/11/2026, exigem informação atual do criador, escolha explícita de privacidade sem valor inicial, interações não marcadas por padrão quando permitidas, prévia e conteúdo editável. Exigem consentimento expresso antes do envio e acompanhamento do resultado por status ou webhook. Também distinguem aplicações voltadas a criadores de uso privado/interno e tratam divulgação comercial e avisos antes da postagem. Isso exige estudo do desenho de agendamento: consentir uma conta não é aprovar qualquer conteúdo futuro; não foi certificado que um despacho sem nova interação satisfaz todos os requisitos. Os textos de termos vinculados não foram lidos nem aceitos. Limites variáveis mencionados na página não viraram cota do produto ou promessa de capacidade.

## Ficha concreta de evidência antes de qualquer envio futuro

O estudo conjunto G2/HL9 deve preencher uma ficha por fluxo, sem credencial ou dado pessoal: produto e versão; tipo de conta; ação/mídia; finalidade de cada escopo; documento/data; aprovação de escopo do aplicativo; auditoria ou nível de acesso quando aplicável; autorização individual efetivamente concedida; direito sobre o destino; conteúdo e revisão consentidos; privacidade e divulgações escolhidas; vencimento/renovação/revogação; confirmação final e custo completo. “Conectado”, “pedido aceito” ou exemplo oficial não substituem esses campos. Campo necessário desconhecido não autoriza despacho.

| Momento do contrato proposto | Evidência a exigir | Estado honesto se a evidência faltar |
| --- | --- | --- |
| Planejar conteúdo e destino | Rascunho revisto pelo criador, rede e conta certas, mídia/legenda/privacidade aprovadas, data e fuso mostrados; registrar o escopo do consentimento de envio sem guardar credencial no relatório. | Rascunho; não “agendado com envio garantido”. |
| Aprovar o aplicativo | Prova aplicável ao produto, escopos, versão e ambiente selecionados; separar auditoria/revisão de autorização do usuário e de decisão do dono. | Revisão/auditoria desconhecida; desligado. Não solicitar revisão nesta unidade. |
| Preparar despacho | Autorização ainda válida, destino próprio confirmado, consentimento ainda aplicável, política da rede satisfeita e reserva de todo o custo antes do primeiro envio. | Não enviado; revalidação ou decisão pendente. Não ampliar escopos existentes automaticamente. |
| Receber aceite remoto | Identificador e envelope exatos; distinguir recebimento, transferência, processamento e publicação. Resposta parcial ou timeout não equivale a falha sem efeito nem a post publicado. | Resultado desconhecido/em processamento; recuperar por observação suportada antes de repetir publicação. |
| Confirmar resultado | Estado final do provedor e vínculo com a mesma operação/destino/conteúdo; só então anunciar a publicação correspondente. | Não confirmado. O `publish_id` de Upload não prova conclusão manual pelo usuário. |
| Revogar/cancelar/apagar | Parar despachos ainda não iniciados; conciliar operação em andamento e direitos de apagar/exportar sem recriar dados. Cancelar a fila local não prova retirada de algo já publicado. | Cancelamento/remoção remotos ainda não confirmados; informar o limite e manter exposição necessária. |

Custos adicionais permanecem sem quantificação: aprovação/manutenção aplicável, chamadas de autorização/renovação e status, mídia armazenada/transferida, filas/tentativas, retorno desconhecido, acessibilidade, retenção/exportação e remoção. Ausência de tarifa na página da API não significa custo zero. Não foi criada ou alterada política financeira, preço, limite, gate, flag ou fornecedor.

Validação deste incremento: leitura pública de documentos oficiais e revisão do Markdown; nenhum bot, token, app registrado, login, chamada de publicação, termo aceito, conta real, teste executado, GitHub/canal/CI ou alteração de ref. Continua pendente o estudo completo e a implementação autorizada posteriormente; este anexo não muda o estado de G2/HL9.
