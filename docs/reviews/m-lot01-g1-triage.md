# Lote 01 — triagem de completude do item 39 [G1]

Data da leitura: 06/11/2026, até 20h39 UTC (17h39 Fortaleza). Autor: Codex M, frente G1. Documento de triagem; sem implementação de produto.

## Resultado

**O estudo documental do G1 permanece pendente; existe uma fundação parcial incorporada pelo complemento 480 [SB3].** Não é correto concluir que nada existe pelo `not started` antigo, nem que o G1 foi absorvido pelas regras puras. Nenhum transporte de mensagens, inbox social ou aprovação Meta foi demonstrado nesta frente. O próximo recorte seguro é uma matriz documental das fontes e diferenças por canal, antes de qualquer unidade de transporte.

Base imutável lida por `git show HEAD:path` e `git grep HEAD`: `90eca6cb59dad6445f63021ab2d81c19740e1f62`. Todos os `arquivo:linha` abaixo se referem a essa base, salvo indicação de consulta atual ao GitHub. Não houve checkout, instalação, teste executado, edição de código ou mutação remota. A única escrita desta frente é este documento, depois da confirmação da reserva pelo root no commit de canal `ba488af2d730a2a2f6640394bda2947639d035c6`. O root centraliza publicação e coordenação com Claude 4; Claude 1 permanece OFF nesta tarefa.

Foram lidos CLAUDE.md, AGENTS.md, as regras CX-116/118/120/122/123 de `docs/agent-inbox.md`, `docs/reservations.md` e os cinco arquivos individuais de reservas. A atribuição específica restringe esta frente a leitura e ao relatório próprio; não autoriza executar as rotinas históricas de envio, atualização de ramo ou CI. A CX-118 não é autorização para reabrir nesta frente os reparos anteriores do estúdio.

## Pedido e evidência histórica

- `docs/codex-queue.md:2729`: documentar requisitos Meta para AutoDM, comentários, inbox Instagram/Messenger e WhatsApp; só depois código preparado e desligado até aprovação.
- `docs/codex-queue.md:2731`: estado registrado “a fazer”, com obrigação de conferir sobreposição antes de implementar.
- `docs/codex-queue.md:2733`: estudo da unidade oficial de cobrança, prazos e custeio; nenhum pedido de aprovação autorizado. Este relatório não calcula nem altera valores.
- `docs/codex-queue.md:1213`: G1 é estudo da Meta; o 480 depende dele.
- `docs/completeness-audit/lot-01.json:745`: o registro do 39 diz `not started`, mas a própria evidência em `:748` termina em “Not audited” e já reconhece SB3. Não serve como prova de ausência de código.
- `docs/codex-queue.md:13957`: SB3 é complemento diferencial; não substitui nem renumera o 39.

## Estado por requisito

| Requisito | Estado verificável | Presença ou lacuna e prova |
| --- | --- | --- |
| Requisitos oficiais Meta com fonte e data, separados por produto/login/canal | Pendente de evidência oficial alcançada | `lib/autodm-rules.ts:35` registra que não foram lidas as páginas oficiais e não incorpora janelas ou limites Meta; `lib/autodm-reply-rules.ts:33` repete a lacuna antes da unidade de canal. A nova tentativa de 06/11 também não alcançou os documentos técnicos, conforme seção seguinte. |
| AutoDM por comentário: palavras-chave, repetição e modo de teste | Fundação incorporada em SB3; sem canal | `lib/autodm-rules.ts:7` descreve matching; `:280` aplica intervalo; `:311` valida contas de teste. `tests/autodm-rules.test.ts:45` e `:190` contêm verificações de bloqueio/modos. PR #2073 incorporado, confirmado pela API. Não há prova de comentário real recebido nem mensagem enviada. |
| Regra completa, resposta, teste antes de ligar e decisão por comentário | Fundação incorporada em SB3; sem persistência ou envio | `lib/autodm-reply-rules.ts:203` lê a regra; `:239` documenta a trava; `:247` decide sem transporte; `:280` monta texto/link. `tests/autodm-reply-rules.test.ts:229`, `:297` e `:318` cobrem teste anterior, bloqueio live e identidade ausente. PR #2499 incorporado, confirmado pela API. |
| Receber comentários e enviar resposta privada Instagram/Facebook | Não demonstrado; próxima unidade explicitamente dependente do estudo | `lib/autodm-reply-rules.ts:40` exige fontes, custeio e privacidade antes de construir o canal. Busca por consumidores de `autodm-rules`/`autodm-reply-rules` em produção retornou apenas a importação da unidade 1 pela unidade 2; os demais consumidores encontrados são testes. Não foram encontrados endpoints `private_replies` ou permissões de mensagens no recorte pesquisado de lib/app/docs/tests. Esta é ausência na busca delimitada, não prova universal sobre todo ramo remoto. |
| Inbox Instagram/Messenger dentro da loja | Não demonstrado; inbox existente é infraestrutura reaproveitável | `lib/inbox-rules.ts:6` cobre chat próprio e formulário; `:53` define `Source = chat/contact/affiliate`. Não contém fonte social ou identidade de canal. `lib/inbox.ts:4` descreve a persistência própria, que não comprova ingestão Meta. |
| WhatsApp na caixa de entrada e envio automatizado | Não demonstrado | `lib/crm-rules.ts:208` e `:213` implementam apenas abrir `wa.me`, explicitamente sem escrever ou enviar. Isso não satisfaz G1. As lacunas Meta/WhatsApp já constam em `lib/autodm-rules.ts:42` e `docs/codex-queue.md:13959`. |
| Permissões, revisão de aplicativo e prova de aprovação | Desconhecido; nenhuma aprovação verificada | A integração Meta já existente pede somente `ads_read` (`lib/meta-ads.ts:17`, `:293`, `:351`). A rota `app/api/integrations/meta/callback/route.ts:9` delega ao fluxo de conexão de anúncios. Não prova autorização de mensagens ou comentários. |
| Código desligado até aprovação | Presente na fundação; não equivale a produto integral preparado | `lib/autodm-rules.ts:51`: `AUTODM_LIVE = false`; `lib/autodm-reply-rules.ts:262` mantém a trava por conta própria. `tests/autodm-reply-rules.test.ts:297` contém os dois vetores com caller live. Não foi verificada configuração publicada nem fluxo real de aprovação. |
| Janelas de resposta, exceções por superfície, limites de API e tamanho de mensagem | Pendente | `lib/autodm-rules.ts:39` exclui deliberadamente números Meta não conferidos. `lib/autodm-reply-rules.ts:37` distingue seu teto próprio do limite Meta. Nenhum número da implementação local deve virar regra do fornecedor. |
| Custos, unidade oficial vigente e teto antes do gasto | Pendente; desconhecido | O próprio bloqueio consta em `lib/autodm-reply-rules.ts:41` e `docs/codex-queue.md:13960`. As regras puras não fazem IO; isso não torna gratuito um futuro recebimento/envio, retries, armazenamento ou operação. Nenhuma tarifa, custo zero ou margem foi inferida. |
| Privacidade: identidade do comentarista, retenção, exclusão/exportação e deduplicação | Dependência aberta antes do canal | `lib/autodm-reply-rules.ts:42` pede onde e por quanto tempo o id será guardado; `lib/autodm-rules.ts:375` limita a marca do link ao id da regra. Essa marca agregada não resolve a identidade necessária à repetição. Esta triagem não cria chaves nem dados pessoais. |
| Testes do canal, interface, acessibilidade e publicação | Não verificados | Foram lidos testes puros, sem executá-los. Não houve navegador, Redis nativo, fornecedor, conta, webhook real ou conferência de publicação. `AGENTS.md:305` exige evidência de ponta a ponta antes de chamar pronto. |

A busca negativa foi feita em `lib`, `app`, `docs` e `tests` para `instagram_manage`, `instagram_business_manage`, `pages_messaging`, `whatsapp_business`, `private_replies` e `messaging_postbacks`, sem correspondência nesse snapshot. O inventário `app/api/integrations` tem fluxos Meta de start/callback/disconnect/deauthorize para anúncios; o nome Meta sozinho não demonstra mensageria.

## Consulta oficial de 06/11/2026

Foi feita busca web restrita a `developers.facebook.com`, sem resultado utilizável, seguida de abertura direta destas três URLs. O leitor retornou **HTTP 429 Too Many Requests** para todas:

| Página técnica tentada | Resultado da leitura | Uso permitido nesta triagem |
| --- | --- | --- |
| https://developers.facebook.com/docs/instagram-platform/private-replies | 429; conteúdo não lido | Registrar endereço candidato e falha, sem extrair regra |
| https://developers.facebook.com/docs/messenger-platform/overview | 429; conteúdo não lido | Registrar endereço candidato e falha, sem extrair regra |
| https://developers.facebook.com/docs/whatsapp/cloud-api/overview | 429; conteúdo não lido | Registrar endereço candidato e falha, sem extrair regra |

A busca ampla anterior também retornou espelhos e artigos de terceiros; nenhum foi usado como prova normativa ou técnica. A falha de leitura não prova API inexistente, proibida ou gratuita. Permissões, janelas, limites, custos e prazos atuais permanecem desconhecidos. O resultado atual é 429 do leitor, distinto da recusa de rede relatada pelos autores em 04–05/11; não foi apresentado como reprodução idêntica dessa recusa.

`docs/meta-marketing-api-version-2026-11-04.md:3` trata da versão da API de anúncios, e `:15` limita a aplicação ao leitor de anúncios. Essa prova histórica não fecha documentação de mensagens. Não foi reaproveitada sua versão como versão obrigatória de G1.

## Sobreposições e reservas atuais

Consultas GitHub somente leitura em `solrenning-llc/marktmorgen`, em 06/11. Metadados de PR e listas de caminhos foram conferidos; títulos/corpos não substituem revisão dos respectivos diffs. As reservas atuais individuais também foram buscadas pelo conector. O canal é lido e publicado pelo root; esta frente não o acessou diretamente.

| Frente | Evidência atual | Consequência para G1 |
| --- | --- | --- |
| SB3 unidade 1, Claude 4 | [#2073](https://github.com/solrenning-llc/marktmorgen/pull/2073), merged em 04/11 11h00m21 UTC; merge `b2d3c88088a184a476fb8c6e8ec175e427b2a4b9`; head `77d7d77b7d7ee6091378c6ea59bf68c508f1eca6` | Reaproveitar regras puras; não construir outro matching/modo/contador. |
| SB3 unidade 2, Claude 4 | [#2499](https://github.com/solrenning-llc/marktmorgen/pull/2499), merged em 06/11 11h55m06 UTC; merge `2edb020fa664e1b4513adfe454b998f999047a25`; head `42017f66d5474ab2c7605a83b2e969e730caed53` | O progresso antigo “testada num PR” em `docs/codex-queue.md:13960` não é mais o melhor estado de incorporação. Corrigir só esse estado em futura unidade documental centralizada, preservando G1 aberto. |
| Codex L | [#2794](https://github.com/solrenning-llc/marktmorgen/pull/2794), aberto; head `80be1e1c8e1416b2ef78af0b84b6b154b49f7e2a`; caminhos `lib/imported-purchases.ts`, `lib/learn.ts`, `tests/imported-purchases-exact-replies.test.ts`; reserva em `docs/reservations/codex.md:78` | Nenhum AutoDM identificado nesta frente L pelo PR consultado. Não declarar que L não possui trabalho fora desse recorte; o root confere os anúncios mais recentes antes de qualquer reserva nova. |
| Claude 3 / caixa de entrada | [#1965](https://github.com/solrenning-llc/marktmorgen/pull/1965), aberto; head `d6b17cd9eb7a78e8ee1f5c35ed1acf1cc76c88db`; lista atual inclui `lib/inbox.ts`, `lib/inbox-rules.ts`, `components/inbox-studio.tsx`, `app/studio/inbox/page.tsx`, privacidade e registros de custo/dados | Esses caminhos estão ocupados mesmo com tabela individual de Claude 3 enxuta. Não editar nem absorver o trabalho; a lista de caminhos do PR prevalece como alerta de conflito. Não foi demonstrado suporte social pelo conteúdo consultado. |
| Codex N / caixa de entrada | [#2674](https://github.com/solrenning-llc/marktmorgen/pull/2674), aberto na busca; lista de caminhos inclui `lib/inbox.ts`; reserva em `docs/reservations/codex.md:66` | Custeio/admissão de e-mail já tem dono. Qualquer futura integração de inbox precisa coordenação prévia com Claude 4, sem assumir arquivo livre. |
| Codex Z / página Inbox | [#2800](https://github.com/solrenning-llc/marktmorgen/pull/2800), aberto na busca; exceção explícita de trecho para `app/studio/inbox/page.tsx`, registrada em `docs/reservations/codex.md:99` | Não alterar página, saldo de IA ou aviso dessa frente. |
| FF1(f) e SZ8(30) | `docs/codex-queue.md:20691` e `:20711` reutilizam G1 para inbox social, com estudo anterior à aprovação; `:22004` complementa WhatsApp pela conta do próprio criador | Mapear as diferenças na documentação de G1; não criar outro item/inbox, mover fila ou antecipar o escopo posterior à abertura de FF1. |

As buscas de PRs por AutoDM e G1 mostraram #2073/#2499 e a auditoria documental #2696; por WhatsApp em PR aberto não retornaram resultado. Isso não é certificação de ausência em todos os ramos. A atribuição do root já limita esta frente a `docs/reviews/m-lot01-g1-triage.md`; nenhuma linha de reserva foi alterada.

## Próximo recorte documental concreto

Propor a Claude 4, por meio do root, **uma única unidade documental do 39 [G1], sem código**, reaproveitando esta matriz e o 480:

1. Montar um dossiê com seis linhas separadas: comentário Instagram → resposta privada; inbox Instagram; comentário Facebook → resposta privada; inbox Messenger; WhatsApp recebido; WhatsApp enviado. Para cada linha, registrar API e fluxo de login, superfície/conta aplicável, permissões exatas, acesso de teste versus produção, revisão necessária, evento de webhook, autenticação/assinatura, identificadores, janela e exceções, resposta de entrega/erro, limites, retenção/exclusão e unidade de custo. Cada célula exige URL primária, data da leitura e trecho aplicável; fonte não alcançada fica “desconhecida”.
2. Começar pelo comentário Instagram → resposta privada, pois a interface pura de decisão já existe em SB3. A primeira saída é a especificação do contrato de entrada/saída que um futuro adaptador precisaria cumprir, vinculada a `decideReply`; sem criar adaptador, rota, chave, flag ou pedido de aprovação.
3. Documentar as fronteiras entre repetição escolhida pelo criador e permissão do canal; entre decisão de enviar e aceitação/entrega pelo fornecedor; e entre tentativa desconhecida e retry autorizado. Nenhum erro ou resposta parcial pode virar envio confirmado, contador zero ou liberação de reserva.
4. Abrir uma tabela de dados necessários por finalidade, sem dados reais: identidade limitada ao canal/loja, deduplicação, última resposta, exportação/exclusão e fim de retenção. A política efetiva e sua implementação só serão definidas em recorte autorizado posterior, com os donos dos arquivos ocupados.
5. Deixar unidade oficial de custo, tarifas, cobertura de webhook/retries/armazenamento e teto de operação como dependência da faixa financeira. O dossiê não atesta margem nem atribui custo zero à leitura/envio. Prazos de revisão Meta só entram com fonte; não estimar aprovação.
6. Separar “fontes lidas”, “requisitos ainda desconhecidos”, “fundação SB3 incorporada” e “produto não verificado”. Só depois de fontes e dependências fechadas poderá ser proposta unidade de código, com nova reserva e RED causal. O root decide o caminho documental próprio e confere novamente canal/PRs antes da escrita seguinte.

Critério de saída desta próxima unidade: matriz por canal auditável, diferenças G1/SB3/FF1/SZ8 sem duplicação, todas as lacunas explicitadas e nenhuma afirmação de permissão, gratuidade, aprovação ou prontidão sem evidência. A indisponibilidade das páginas não impede produzir o inventário e registrar as dependências; impede certificar o conteúdo dessas páginas.

## Validação e limites desta entrega

Foi conferida a presença dos arquivos, dos trechos citados, dos importadores das regras AutoDM, das buscas negativas delimitadas, dos metadados exatos de #2073/#2499 e das listas de arquivos de #1965/#2794/#2674. Não foram rodados testes de produto, build, lint, CI, navegador, Redis nativo, Meta ou publicação; não há nova execução verde atribuída a esta triagem. Contagens de testes relatadas nos PRs não foram reexecutadas nem convertidas em prova de operação real.

Acessibilidade: documento em texto com títulos e tabelas; nenhuma interface alterada, 0 → 0 passos/decisões. Não há ensaio com leitor de tela nem certificação AAA. Benefício desta unidade: evitar duplicar as duas fundações existentes e tornar verificável o estudo ainda necessário antes de transporte social. Nenhum custo de trabalho/CI é presumido zero. Nenhum preço, limite, comissão, chave, conta, termo, pagamento, dado pessoal ou trava foi alterado. Estado da entrega: triagem documental própria para revisão/publicação centralizada; G1 não declarado absorvido, pronto ou disponível ao cliente.


## Estudo complementar — seis fluxos e contratos futuros (06/11/2026, 20h51 UTC)

Este acréscimo executa o recorte documental autorizado pelo root na mesma frente e no mesmo arquivo. As 88 linhas anteriores permanecem byte a byte como prova da primeira triagem; as novas leituras abaixo ampliam seu estado de evidência. A base de código continua congelada em `90eca6cb59dad6445f63021ab2d81c19740e1f62`. Nenhuma proposta desta seção é uma permissão concedida, uma política já implementada, uma conta apta ou uma autorização para ligar o canal.

### Fontes primárias alcançadas e seu alcance exato

Leitura pública por web em 06/11/2026, entre a entrega inicial e 20h51 UTC. Não houve login, token, assinatura de termos, pedido de aprovação ou execução de chamadas das coleções. A rota alternativa foi buscar as coleções publicadas pela própria Meta no Postman; não foi usado conteúdo de outros publicadores desse serviço.

| ID | Fonte primária e localização lida | O que sustenta; limite de evidência |
| --- | --- | --- |
| S0 | [Equipe Meta no Postman](https://www.postman.com/meta), linhas 17–27, 74–79; [workspace Instagram](https://www.postman.com/meta/instagram/overview), linhas 37–47; [workspace Messenger](https://www.postman.com/meta/messenger-platform-api/overview), linhas 38–44 | A equipe se identifica como oficial e mantenedora das coleções; os workspaces se identificam como oficiais. Isso estabelece a proveniência das leituras abaixo, não a compatibilidade real de uma conta. |
| S1 | [Instagram API — documentação oficial da coleção Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api), seções Instagram API with Facebook Login, Instagram API with Instagram Login e Send API; linhas 64–88, 439–510 | Distingue dois caminhos. Facebook Login usa conta profissional vinculada a Página e lista, para a coleção, `pages_show_list`, `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, `instagram_manage_comments`. Instagram Login lista `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`; sua Send API exige mensagem anterior do destinatário e token da conta profissional. Testadores precisam de papéis e permissões. São listas da coleção, não um conjunto mínimo aprovado para cada um dos seis fluxos. Não foi encontrada seção técnica de private replies nessa leitura. |
| S2 | [Messenger Platform API — documentação oficial da coleção Meta](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api), Requirements/Send API, linhas 51–86; exemplo de destinatário, linha 123 | Lista Página, token de Página e `pages_messaging`; descreve mensagem anterior nas últimas 24 horas ou concordância para comunicação fora da janela padrão. O destinatário do exemplo é PSID. A modalidade exata de exceção, condições de concordância, revisão e elegibilidade de produção não foram fechadas. A frase genérica da coleção não será tratada como licença de marketing nem como regra para comentário privado. |
| S3 | [WhatsApp Cloud API — coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api?action=share&creator=22794852), Getting Started/Permissions, linhas 65–97 | Lista portfólio empresarial, WABA e telefone comercial como ativos; `whatsapp_business_management` e `whatsapp_business_messaging`, com `business_management` para consultas ao portfólio conforme o caso. A concessão pelo próprio usuário para teste não prova acesso aos ativos dos clientes nem revisão para SaaS. Nenhum ativo foi criado ou consultado. |
| S4 | [Política canônica de mensagens WhatsApp Business](https://whatsappbusiness.com/policy/), atualização declarada 23/09/2026, linhas 104–143 | Exige fornecimento do telefone/username e opt-in para mensagens posteriores, respeito à recusa, avisos e privacidade. Iniciar conversa usa modelo aprovado; resposta sem modelo fica na janela de 24 horas aberta/reiniciada por mensagem do usuário; automação exige saída clara para atendimento. Não define os preços nesta página: remete à política de preços. Esses fatos não provam consentimento real, aprovação de modelo, disponibilidade de escalonamento ou cobertura financeira no Marktmorgen. |
| S5 | [Send Message Template Text — coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text), linhas 173, 187–210 | Mostra `/Phone-Number-ID/messages`, tipo template e identificador de sucesso prefixado por `wamid`. O prefixo isolado não é esquema completo de validação nem prova de entrega; exemplos não autorizam enviar modelos ou registrar conta. |
| S6 | [Send Text Message — coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/request/8gvd47s/send-text-message), linhas 148–161 | A leitura expõe o endereço de operação e informa ausência de descrição. O leitor não trouxe corpo/resposta de texto suficientes para fixar um contrato completo. |
| S7 | [Received Text Message — coleção oficial Meta](https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message), linhas 28–94 e 140 | O índice separa mensagens recebidas de notificações de status; o payload não foi exposto pelo leitor. Não foram inferidos campos, assinatura, política de ACK ou retries a partir dos títulos. |
| S8 | [Webhooks — coleção oficial Meta, seção marcada MOVED](https://www.postman.com/meta/whatsapp-business-platform/folder/6lt7to2/webhooks), linhas 30–42 e 79–85 | Apenas enumera inscrição/remoção e liga os guias técnicos. Por ser uma seção movida, não certifica o fluxo atual nem o formato recebido. |

As amostras das coleções incluem datas/versões antigas de respostas. A data de leitura atual não transforma uma amostra antiga em versão vigente obrigatória. Não foi escolhida uma versão de Graph API ou de qualquer produto para a implementação futura.

### Fontes não alcançadas e divergências preservadas

| Endereço ou mecanismo tentado nesta ampliação | Resultado observado | Lacuna que permanece |
| --- | --- | --- |
| `https://developers.facebook.com/documentation/instagram-platform/private-replies` | HTTP 429 Too Many Requests pelo leitor | Requisitos próprios do comentário Instagram → mensagem privada, incluindo janela, superfície e limite |
| `https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies` | HTTP 429 Too Many Requests | Caminho alternativo também não resolveu o mesmo fluxo |
| `https://developers.facebook.com/documentation/business-messaging/messenger-platform` | HTTP 429 Too Many Requests | Overview técnico atualizado de Messenger |
| `https://developers.facebook.com/docs/messenger-platform/discovery/private-replies` | HTTP 429 Too Many Requests | Regras próprias do comentário Facebook → mensagem privada |
| `https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview` | HTTP 429 Too Many Requests | Payload, assinatura, confirmação e reentrega oficiais de webhook |
| Busca primária em dois mecanismos, por host e depois por equipe `/meta` do Postman | Fontes S0–S8 alcançadas; pesquisas de private replies não trouxeram documento técnico primário utilizável | Não foi demonstrada inexistência de API nem fechamento dessas regras |
| [Conversations API da coleção Messenger](https://www.postman.com/meta/messenger-platform-api/folder/22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a) | Busca trouxe texto primário indexado; abertura direta trouxe só navegação/convite de login, sem seção técnica | Evidência parcial; não usada para preencher definitivamente permissões de sincronização ou aprovação |
| URL pública da documentação Messenger com parâmetro de pasta `entity=folder-22794852-255610cd-47f5-4f4d-b3fa-71aec360be9a` | Ferramenta informou URL inacessível, sem status HTTP fornecido | Não converter em 404 nem afirmar que a pasta foi removida |

A primeira busca também encontrou `business.whatsapp.com/policy/preview?lang=pt_BR`. É uma rota de prévia, com redação diferente da canônica atual. Não foi usada para estabelecer cobrança ou copiar requisito antigo de consentimento. A política canônica foi aberta pelo redirecionamento de `https://business.whatsapp.com/policy` para S4 e traz sua própria data. Isso resolve qual texto foi efetivamente usado neste estudo, sem apagar o resultado histórico da busca. Divergências entre o texto canônico e documentação técnica inacessível continuam pendentes nos pontos não verificáveis.

### Matriz dos seis fluxos

“Confirmado na fonte” abaixo significa somente leitura documental. “Proposto” significa requisito de projeto a discutir no recorte autorizado seguinte, sem alegar que é exigência textual da Meta. `unknown` é ausência de evidência suficiente, nunca uma decisão positiva.

| Fluxo | API/login, identidade e elegibilidade documental | Contrato de entrada proposto | Saída proposta e condição ainda aberta |
| --- | --- | --- | --- |
| F1 — Instagram comentário → resposta privada | S1 distingue logins; fonte própria do fluxo inacessível. Conjunto mínimo de permissões, ativos, acesso padrão/avançado, revisão e superfícies cobertas: desconhecidos. Não aplicar regra de inbox a comentário. | Evento autenticado ligado à loja, app, conta profissional, mídia e comentário; identidade do autor, tempo de criação e forma de obter o id de destino demonstrados por fonte. Se qualquer vínculo for desconhecido, nenhuma decisão de envio. | `decideReply` pode fornecer somente decisão local; adaptador futuro ainda deve verificar a capacidade específica do canal. Recusa, pendência documental ou tentativa com estado conhecido são resultados distintos. Endpoint exato, limite de respostas por comentário, janela, exceções e ACK do fornecedor: desconhecidos. |
| F2 — Instagram inbox | S1 fornece a trilha de inbox; login escolhido precisa permanecer explícito. A relação de conta/loja e a elegibilidade do destinatário exigem prova própria. Aprovação e contrato de webhook: abertos. | Mensagem recebida autenticada, conta destinatária e interlocutor no namespace correto, id do evento/mensagem, tempo, direção, tipo e conteúdo permitido. Não converter comentário, echo ou recibo em nova mensagem de usuário. | Incorporar mensagem à conversa somente com gravação confirmada; resposta futura depende da regra aplicável de canal e permissão do atendente. Histórico parcial não autoriza declarar “sem mensagens”. Sem prazo de resposta de Instagram imposto por este dossiê. |
| F3 — Facebook comentário → resposta privada | Página precisa ser identificada; S2 não substitui a documentação de private replies, bloqueada. Permissões específicas, ativos e revisão: desconhecidos para este fluxo. | Comentário autenticado e vinculado à Página/loja e ao objeto comentado; autor e elegibilidade de resposta comprováveis. Não reutilizar um id de usuário como PSID por suposição. | Construir decisão local reaproveitável somente após definir diferenças de canal. Não afirmar que o mecanismo F1 ou o Send API de F4 serve para F3. Janela, repetição, endpoint e resposta esperada: desconhecidos. |
| F4 — Messenger inbox | S2 é evidência parcial do Send API, com destinatário de Página. Sincronização histórica, eventos e revisão completa não fechados. | Mensagem autenticada da Página correta, pessoa no namespace dessa Página, id e direção; metadados de autorização de comunicação separados do conteúdo. | Gravação confirmada gera mensagem visível; transporte pode produzir aceitação, recusa ou desconhecido. A exceção mencionada por S2 não será ativada com um booleano genérico de consentimento. |
| F5 — WhatsApp recebido | S3 identifica a trilha Cloud API/ativos; S7 só confirma separação de classes no índice. Esquema e assinatura ainda desconhecidos. | Evidência autenticada da conta/telefone comercial e do interlocutor; id de mensagem/evento e tempo legíveis; distinguir conteúdo de atualização de status. Identidade técnica não implica opt-in posterior. | Ingestão confirmada, duplicata já confirmada, evento fora de escopo ou processamento pendente. Nenhuma resposta automática pelo simples recebimento. A página de webhook inacessível ainda impede fechar o ACK ao fornecedor. |
| F6 — WhatsApp enviado | S3/S4/S5 dão base parcial; preservar ativo, destinatário e finalidade do próprio criador. Não autorizar campanha nem aprovação de modelo. | Intenção de mensagem ligada à conversa/finalidade; evidências de consentimento, recusa e condição de resposta ou modelo aplicável; texto/versão do modelo e parâmetros previstos, quando essa modalidade for futuramente autorizada. | Distinguir não tentado, aceitação comprovada, entrega comprovada, recusa e tentativa desconhecida. S5 não basta para validar todo envelope. Faltam contrato técnico de status, erros, retries, unidade de custo, teto e cobertura do transporte. |

Para F1–F6 permanecem abertos, salvo o alcance literal de S1–S8: lista final de eventos/subscrições e campos; assinatura e rotação; versão suportada; enumeração e paginação; limites de tamanho/taxa; prazos de revisão; testes permitidos; contrato de reentrega; retenção obrigatória pelo fornecedor; e custo integral. Não extrapolar a política de um produto para outro. Nenhuma lacuna recebe número padrão.

### Contrato comum proposto: entrada, decisão e saída

Os nomes seguintes são conceituais para especificação. Não criam tipos de código, chaves Redis, permissões novas ou campos persistidos.

| Fronteira | Evidência mínima proposta | Resultado quando faltar ou divergir |
| --- | --- | --- |
| Origem e integridade | Corpo recebido e assinatura verificados conforme documentação específica, com vínculo à configuração/geração corrente do próprio app | `untrusted` ou `unknown`; nenhuma gravação de conversa e nenhum envio. O algoritmo e cabeçalhos exatos não foram definidos sem fonte. |
| Roteamento | Correspondência inequívoca canal → app → conta/Página/WABA/telefone comercial → loja autorizada | Não escolher primeira loja por padrão; não reaproveitar conexão de anúncios; não encaminhar a equipe de outra loja. |
| Identidade | Interlocutor e objeto com namespace do canal e ativo; vínculo à conversa demonstrado pelo evento/documentação | Não unir pessoas por nome, handle, telefone normalizado ou endereço de e-mail; não deduzir id de destino a partir do comentário. |
| Forma | Envelope exato, campos obrigatórios próprios e tipos válidos; arrays densos; tempo/ids validados segundo o contrato futuro | Não preencher faltantes com zero, agora, vazio ou “nunca respondeu”. Evento ilegível não é evento vazio confirmado. |
| Semântica | Mensagem de usuário, comentário, echo, atualização/remoção, status ou evento desconhecido identificados separadamente | Não alimentar AutoDM com echo/status nem converter evento novo em texto comum. Tipo sem suporte não produz resposta. |
| Estado local | Regra da própria loja, versão estável, resultado conhecido de última resposta/teste/recusa e recurso publicado correspondente | `blocked` para impedimento conhecido; `unknown` para leitura insuficiente. Uma regra incompleta não é regra desligada confirmada. |
| Capacidade do canal | Prova documental e operacional futura de que a intenção específica pode ser enviada ao destinatário nessa modalidade e momento | Uma decisão `send: true` da regra pura não autoriza o transporte. Mantém-se pendente antes do gasto. |
| Consentimento/finalidade | Evidência aplicável ao canal/finalidade e recusa vigente; para resposta, vínculo à mensagem que a justifica | Não herdar marketing de uma compra, comentário, endereço informado ou opt-in de e-mail. Prova desconhecida não vira consentimento ausente definitivo nem consentimento concedido. |
| Gasto | Admissão e reserva anteriores à tentativa, com unidade e cobertura reais definidas pela faixa financeira | Sem envio ou readback não financiado; documentação de API não atesta custo conhecido. |
| Persistência | Deduplicação, escrita e contagem coerentes, ligadas a uma tomada própria e operação idempotente | ACK desconhecido não confirma gravação, não solta a tomada alheia e não conta envio. A atomização concreta será especificada pelo dono dos módulos ocupados. |
| Exposição na tela | Estado apresentado sustentado pelo recibo local ou de fornecedor realmente disponível | Não exibir “entregue”, “enviado”, “sem histórico” ou número confirmado por inferência. Qualquer texto futuro exige teste causal e idiomas/acessibilidade. |

Estados conceituais de saída: `rejected` (entrada comprovadamente inválida), `duplicate_confirmed` (a mesma operação já foi comprovadamente incorporada), `recorded` (persistência confirmada), `blocked` (impedimento conhecido), `pending_evidence` (pré-condição desconhecida), `attempt_not_posted` (prova de que nada saiu), `provider_accepted` (aceitação inequívoca), `provider_delivered` (prova própria de entrega), `provider_rejected` (erro com significado documentado) e `attempt_unknown` (pode ter sido recebido pelo fornecedor). Esses nomes não são respostas HTTP já escolhidas nem traduzem automaticamente os códigos do fornecedor.

### Aplicação concreta ao F1 e à fundação SB3

O contrato puro de `lib/autodm-reply-rules.ts:247` recebe `rule`, `comment`, `personId`, `ownAccountId`, `lastSentAtSeconds`, `nowSeconds` e `live`. O produtor confiável futuro precisa demonstrar o significado de cada campo antes de chamá-lo:

| Campo existente | Proposta de prova do produtor futuro |
| --- | --- |
| `rule` | Regra lida da própria loja, com versão e marca de teste originadas no servidor; a conexão do canal não substitui essa prova. |
| `comment` | Texto do comentário do evento correto, sem buscar ou carregar outra mídia por adivinhação; edição/remoção exige semântica documentada própria. |
| `personId` | Id de autor no namespace que permita a comparação e repetição; não presumir que já é destino de envio. |
| `ownAccountId` | Id da conta dona do post obtido de vínculo autorizado, no mesmo namespace de comparação. Não passar handle, Página ou app como se fossem o mesmo id. |
| `lastSentAtSeconds` | Instante de resposta comprovadamente aceita conforme a semântica que o recorte futuro aprovar. `null` somente com leitura exata provando ausência; ACK perdido mantém tentativa pendente em registro separado. |
| `nowSeconds` | Relógio do servidor, com unidade definida. Tempo do evento fica separado para validar elegibilidade; não substituí-lo por agora. |
| `live` | Uma entrada que apenas estreita a decisão existente. Este documento não muda a trava nem oferece um valor que a contorne. |

A saída pura `send: true` continua sendo candidata local. O adaptador proposto precisaria ainda comprovar modalidade, janela, identidade do destinatário e custo antes de tentar enviar. `noteTested` não pode ser acionado por prévia de texto: a marca de teste exige a prova da tentativa de teste apropriada, em recorte futuro autorizado. `replyMessage` apenas monta conteúdo; não prova que a Meta aceita esse formato em private replies. Nenhum desses produtores, recibos ou adaptadores foi implementado aqui.

### Unknown, erro, repetição e recuperação

Esta tabela é proposta interna baseada nas regras CX-123(24/25/26/28), não uma descrição de garantias Meta. Códigos específicos de erro, prazo, quantidade de tentativas, backoff e idempotência do fornecedor continuam sem definição documental completa.

| Observação | Interpretação proposta | Ação admissível no desenho futuro |
| --- | --- | --- |
| Fonte, permissão, origem ou destinatário não comprovados antes da tentativa | Pré-condição desconhecida | Não fazer POST; aguardar evidência. Não registrar como enviada nem como recusa do fornecedor. |
| Limite/recusa conhecidos antes do POST | Operação não tentada por impedimento conhecido | Mostrar motivo preciso; não fazer tentativa automática enquanto o impedimento persistir. |
| Falha local com prova de que o POST não começou | Não postado | Pode voltar à espera somente após revalidar todas as condições e existir cobertura da tentativa futura. |
| POST começou, mas houve timeout, corpo ilegível, conexão perdida ou ACK incompleto | Aceitação desconhecida | Não reenviar às cegas, não desfazer contador/reserva e não afirmar sucesso. A possibilidade de reconciliação precisa fonte, identidade e custo próprios. |
| HTTP de erro com corpo válido | Erro documentado ou desconhecido, conforme o contrato real | Só classificar retryable quando a fonte específica sustentar isso; um 429 não prova que toda operação anterior falhou. |
| Aceitação íntegra com identificador esperado | Aceitação confirmada | Registrar tentativa correspondente; aguardar status próprio se houver. Aceitação não equivale a entrega, leitura ou venda. |
| Callback válido de status | Evidência ligada à mesma conta, mensagem e operação | Atualizar apenas o estado sustentado; callbacks repetidos/fora de ordem não duplicam mensagens ou contagens. Não usar o horário de chegada como ordem absoluta. |
| Evento duplicado com incorporação anterior comprovada | Duplicata confirmada | Sem nova escrita/envio/contagem. Id do evento e da mensagem podem ter funções distintas; não inventar equivalência. |
| Evento chega, persistência pode ter ocorrido, ACK local se perde | Estado local desconhecido | Recuperar por prova vinculada à própria operação; não confirmar nem repetir efeito por adivinhação. ACK externo e status HTTP aguardam contrato oficial. |
| Pessoa pediu exclusão, geração mudou ou conexão foi revogada durante a tentativa | Autoridade anterior deixou de valer | Próximo efeito deve recusar sob a mesma verificação atômica da escrita. Execução velha não recria dado, não envia e não remove tomada nova. Resultado de POST já em voo permanece o realmente observado. |

### Identidade, consentimento e retenção propostos

| Finalidade | Dados estritamente necessários a especificar, sem valores reais | Requisito proposto antes de criar persistência |
| --- | --- | --- |
| Vínculo de conta à loja | Canal, app, ativo e geração da autorização | Dono inequívoco; desconexão/revogação invalida novas operações. Não compartilhar identidade ou token entre lojas. |
| Conversa | Id de conversa e interlocutor no namespace do ativo, tipo/direção e conteúdo permitido | Nenhum perfil global de comprador. Nome visível não serve de chave. Exportação/exclusão da pessoa não podem depender só de e-mail inexistente no canal. |
| Deduplicação | Id autenticado de evento/mensagem e operação local vinculada | Escolher retenção suficiente com fonte e cobertura, sem TTL inventado. Hash de texto não prova duplicata e não substitui id inexistente. |
| Repetição do AutoDM | Regra/post/namespace do autor e última aceitação comprovada | Intervalo escolhido pelo criador não amplia direito do canal; a guarda de identidade exige finalidade e prazo explícitos. |
| Consentimento/recusa | Empresa/canal/finalidade abrangidos, origem, versão do texto, momento e revogação, conforme aplicável | Mensagem recebida não adiciona a pessoa à lista de marketing. Recusa alcança intenção pendente antes de enviar; dado excluído não é recriado por callback antigo. |
| Estado da tentativa | Identificador da própria operação, fase observada e recibo sanitizado | Separar incerto, aceito e entregue. Não guardar payload completo nem credencial em logs para facilitar depuração. |
| Exclusão/exportação | Correspondência legítima da pessoa com ids de canal, índices, caches, filas e conteúdo | Definir caminho próprio e autorizado para comprovar identidade sem transferi-la entre lojas. Toda cópia/índice entra no inventário e não é regenerada após exclusão. |
| Encerramento e expiração | Estado da conexão, prazo por finalidade e vínculo às políticas de dados/custeio | Prazo de inbox próprio existente não vira automaticamente prazo Meta/WhatsApp. Não aumentar retenção para contornar recuperação desconhecida. |

Não foi definido prazo novo de retenção, texto público de opt-in, mecanismo de identificação da pessoa nem política jurídica efetiva. São dependências concretas de especificação e revisão, preservando a privacidade já exigida. A leitura de S4 não autoriza aceitar termos, operar campanhas ou coletar números.

### Saída desta ampliação e próximos bloqueios verificáveis

O dossiê agora contém os seis fluxos, fontes primárias efetivamente lidas, contratos conceituais de entrada/saída, semântica de unknown/retry e inventário de identidade/consentimento/retenção. A fundamentação de inbox e WhatsApp avançou; o contrato de private replies continua sem fonte técnica alcançada. **Bloqueio externo exato:** as cinco URLs técnicas listadas nesta ampliação retornaram HTTP 429 no leitor; uma pasta Postman devolveu só navegação e sua alternativa por parâmetro foi declarada inacessível pela ferramenta. Isso bloqueia confirmar suas regras, não a continuidade do trabalho documental.

Próximos recortes documentais possíveis, sem código: obter fonte técnica primária legível de F1/F3 e preencher as células ainda desconhecidas; depois fechar esquemas/assinaturas/ACK de F2/F4/F5/F6. O root coordena com Claude 4 e os donos de inbox antes de qualquer contrato de persistência definitivo. Preço, custo, custeio e teto permanecem dependência da faixa financeira; prazos de revisão e aprovação de conta continuam desconhecidos. Não há tarefa de criar conta, pedir revisão ou enviar mensagem.

Validação desta ampliação: apenas leitura pública e consistência documental. Nenhuma chamada autenticada, código, flag, conta, contato, aceite, pagamento, CI ou teste de produto. Os caminhos e reservas da triagem inicial não foram reescritos nem reconferidos como se fossem atuais neste novo horário. Interface permanece 0 → 0 passos/decisões; nenhum ensaio de navegador/leitor de tela. O documento continua em estado de estudo próprio para revisão/publicação pelo root, sem declarar G1 pronto, absorvido ou disponível ao cliente.
