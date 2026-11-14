# Lote 01 — triagem documental de 44 [H1]

Data: 06/11/2026. Autor: Codex M. Fonte congelada: `90eca6cb59dad6445f63021ab2d81c19740e1f62`, ramo local `codex/m-lot01-h1-triage`. Atribuição: C4-2830-CX-171, recebida pelo coordenador. Reserva do único arquivo deste relatório confirmada pelo coordenador no registro de canal `ba488af2d730a2a2f6640394bda2947639d035c6`, antes da primeira escrita. Claude 4 centraliza a coordenação; nenhuma ação depende de retorno do Claude 1 (C1OFF).

## Resultado e limite da triagem

**44 [H1] continua a fazer como estudo.** Há PWA instalável da loja e do estúdio no código, mas isso não comprova aplicativo nativo, distribuição nas lojas ou aulas offline. A construção do app de gestão do criador pertence a 449–455 [AP1–AP7] e 456 [AN1]; consumo offline do comprador tem dependência própria em 272 [HM1]. Este relatório inventaria o que existe, separa os públicos e prepara o recorte documental restante. Não conclui a avaliação técnica, jurídica ou econômica integral de H1.

O item canônico está em `docs/codex-queue.md:2758–2764`: estudo de iPhone/Android, distribuição, venda digital fora do app, anuidades/manutenção, PWA e ampliação para aulas offline, explicitamente **SOMENTE DOCUMENTO**, sem downloads offline, licenças ou armazenamento novo. O lote em `docs/completeness-audit/lot-01.json:802–807` registra `not started`, `asks: []` e ausência de auditoria. Suas linhas de referência são antigas: o título agora está na linha 2758, o estado na 2760 e a restrição documental na 2762. A matriz abaixo é nova evidência de triagem, sem reescrever o JSON ou declarar o estudo entregue.

## Estado por requisito

Legenda: **presente na fonte** comprova somente o recorte estático descrito; **parcial** não satisfaz o requisito integral; **pendente** significa sem prova suficiente neste recorte; **dependência existente** evita segunda implementação.

| Requisito de H1 | Estado verificado | Arquivo:linha e prova | Destino/documento seguro |
| --- | --- | --- | --- |
| Identificar a oferta móvel atual | Presente na fonte: web instalável; nativo ausente no inventário consultado | `components/install-app.tsx:86–104` diferencia instalação pelo navegador e app nativo ainda não construído; `lib/phone-faq.ts:35–36` distingue notificações web das lojas | Manter a distinção em toda conclusão de H1; instalação não prova publicação nativa |
| PWA da loja com nome/ícone próprios | Presente na fonte; uso em aparelho real não verificado | `lib/store-app.ts:42–45`, `105–128`: escopo da loja, nome, cores e ícones; `app/[handle]/layout.tsx:51` liga o manifesto; `app/[handle]/manifest.webmanifest/route.ts:26–28` o serve | Reutilizar, sem criar outro app/manifesto nesta etapa |
| PWA do estúdio | Presente na fonte; uso em aparelho real não verificado | `public/studio.webmanifest:2–8` declara id, início, escopo e standalone; `app/studio/layout.tsx:15,29` liga manifesto e componente; `components/studio-app.tsx:6–23` registra o worker de escopo `/studio` | Preservar alternativa existente na comparação documental |
| Retorno sem conexão de páginas públicas | Parcial; não equivale a aulas offline | `public/sw.js:10–21` guarda shell; `60–76` tenta rede e depois cache/fallback | Descrever somente o fallback efetivo, sem prometer curso ou arquivo salvo |
| iPhone nativo | Pendente; dependência existente | `docs/codex-queue.md:12562–12566`: 449 [AP1] especifica React Native/Expo, build, autenticação e sessão; `package.json:14–24` só lista dependências web no pacote raiz | Base em 449; H1 avalia trade-offs, sem nova base ou SDK |
| Android nativo e paridade | Pendente; dependência existente | `docs/codex-queue.md:12626–12639`: 456 [AN1] usa o mesmo projeto/AP, com AAB, testes, FCM, TalkBack e publicação próprios | Registrar apenas diferença Android; não criar segundo app/backend |
| Distribuição App Store/Google Play | Pendente; sem prova de build, inscrição, revisão ou listagem deste projeto | `docs/codex-queue.md:12598–12609`, `12639–12647`: inscrição empresarial e submissão dependem do dono; a fila explicita que o registro não é execução | Dossiê futuro em AP7/AN1; nenhuma conta, envio ou roteiro de painel executado |
| Venda digital fora do app e políticas das lojas | Pendente de verificação oficial e enquadramento real | `docs/codex-queue.md:12584–12586` exige conferência Apple 3.1.1/3.1.3/4.2/5.1.1(v); `12634` exige Payments, funcionalidade mínima e exclusão Google | Reutilizar AP4/AN1. Ausência de venda de plano dentro do app não certifica aprovação ou isenção |
| Anuidades, build, notificações e manutenção | Pendente; custos completos desconhecidos | `docs/codex-queue.md:12593–12596`, `12611`, `12638`, `12647`: valores do pedido exigem fonte atual; a fila amplia para CI, operação, abuso, retenção e manutenção | AP6/AN1 e custeio canônico; não copiar preço histórico como orçamento aprovado nem tratar plano grátis como custo zero |
| Aulas offline: texto, PDF e material autorizado | Pendente; dependência existente em HM1 | `docs/codex-queue.md:2764`, `6858–6865`: estudo H1 ampliado; HM1 pede seleção pelo criador, compra válida, marca de comprador e retirada na reconexão | Estudar com HM1, sem download/cache privado/licença/armazenamento novo |
| Vídeo offline e proteção | Pendente, separado do material textual | `docs/codex-queue.md:6859–6860` exige estudo próprio do fornecedor existente e navegadores, segurança e custo; `lib/stream.ts:54–65,116–128` mostra configuração por token do Bunny Stream, não licença offline | Dossiê HM1 futuro; autenticação online não demonstra proteção offline ou direito de baixar vídeo |
| Margens antes/depois nos seis contratos | Pendente; nenhuma conta realizada | `docs/codex-queue.md:2762` diz que não foram calculadas; `AGENTS.md:84–102` e `CLAUDE.md:32–38` estabelecem precedência MR/TX sobre referências históricas | Encaminhar dados faltantes ao custeio canônico, sem modelo financeiro paralelo, preço/limite/comissão novos |

## Por que a PWA atual não comprova aulas offline

`public/sw.js:34–57` exclui expressamente cursos, comunidade, pedidos, área autenticada, consultas privadas e `/api/` do tratamento de cache. `public/studio-sw.js:1–9` declara que não guarda páginas, respostas ou arquivos privados; `33–45` entrega uma página de indisponibilidade quando a navegação falha, com status 503 e `no-store`. Logo, a existência de Cache API e de um ícone instalado não demonstra biblioteca de aulas salvas.

A evidência positiva é instalação web e fallback limitado. Não foi demonstrado armazenamento persistente por comprador, cota por aparelho, expiração de autorização offline, remoção na reconexão, marca de comprador no conteúdo salvo, licença de vídeo, sincronização de progresso ou limpeza entre sessões/lojas. Esses pontos permanecem perguntas do estudo, não defeitos corrigidos por esta triagem. A retirada imediata de conteúdo de um aparelho desconectado tampouco foi provada; HM1 pede retirada na próxima conexão (`docs/codex-queue.md:6859`).

O inventário de caminhos em `git ls-tree -r --name-only HEAD` não encontrou `app.json`, `app.config.*`, `eas.json`, `Podfile`, `AndroidManifest.xml`, `build.gradle`, projeto Xcode ou `docs/offline-lessons-study.md` na fonte congelada. Essa é evidência negativa limitada ao repositório e aos padrões listados; não permite afirmar nada sobre contas externas ou aplicativos fora dele. A lista raiz de dependências também não contém React Native/Expo (`package.json:14–38`). Nenhuma dependência foi instalada para esta conferência.

## Dependências sem duplicação

| Trabalho já identificado | Fronteira preservada |
| --- | --- |
| 449 [AP1], `docs/codex-queue.md:12562–12567` | Base compartilhada, login/passkey/sessão mínima, futura privacidade de loja e links de app. H1 não cria projeto nativo nem preenche formulários de privacidade |
| 450 [AP2], `docs/codex-queue.md:12569–12576` | Gestão do criador: receita/pedidos, edição, caixa de entrada, agenda, compartilhamento e acesso à conta Stripe própria. Não corresponde ao consumo de aulas do comprador |
| 451 [AP3], `docs/codex-queue.md:12578–12582` | Push do app e extensão web já solicitada para mensagem/badge/gestos. Não duplicar a implementação existente nem a ampliação; não ativar push nesta tarefa |
| 452 [AP4], `docs/codex-queue.md:12584–12586` | Funções que continuam no site e leitura das políticas Apple. H1 cita a dependência e mantém a análise pendente |
| 453 [AP5], `docs/codex-queue.md:12588–12591` | Inglês americano, VoiceOver, Dynamic Type, contraste, alvos e movimento. Exigência não equivale a ensaio realizado |
| 454 [AP6], `docs/codex-queue.md:12593–12596,12611` | Fontes oficiais de custos e limites, teto antes de operação e custo integral de manutenção; sem usar valor do briefing como orçamento certificado |
| 455 [AP7], `docs/codex-queue.md:12598–12609` | Inscrição/submissão empresarial pelo dono e autorização expressa. Esta triagem não usa a autorização histórica de construção para sair de SOMENTE DOCUMENTO |
| 456 [AN1], `docs/codex-queue.md:12632–12647` | Mesma base e telas com diferenças Google/Android; nenhum segundo app ou estudo offline duplicado |
| 272 [HM1], `docs/codex-queue.md:6858–6865` | Consumidor de aulas offline, materiais autorizados e análise separada de vídeo. O estudo futuro previsto é `docs/offline-lessons-study.md`; não foi criado agora, pois não está no arquivo reservado |

Há corroboradores documentais existentes: `docs/highlevel-gap-matrix.md:104–105` classifica app móvel/portal como parciais, com PWA e sem app de loja; `docs/zero-cost-value-2026-10-18.md:61` separa PWA e app nativo. `docs/clickfunnels-implementation-baseline.md:148` e `docs/clickfunnels-feature-audit.json:1505–1506` mantêm o nativo não verificado. São inventários históricos, não fontes oficiais atuais de política, preço ou identidade exigida pelas lojas. Sua frase sobre base separada não substitui o pedido posterior de projeto único AP/AN.

`lib/site-pages.ts:210,531` e `lib/blog.ts:891,974` já distinguem ausência de listagem nativa e instalação web. `lib/site-pages.ts:924` contém valores e uma descrição econômica das lojas; esses textos não foram tratados como fonte oficial ou validação do custo total de H1. Não houve alteração de texto público. A menção histórica LQ3 em `docs/codex-queue.md:15572–15576` fica sob cabeçalho de decisão desfeita; não foi usada como regra vigente para absorver ou cancelar escopo.

## Recorte documental seguro restante

A comparação futura deve separar três decisões: manter a PWA já existente como canal web; requisitos de distribuição e manutenção do app de gestão AP/AN; e viabilidade de leitura offline pelo comprador em HM1/H1. O benefício a investigar é continuidade de estudo e conveniência móvel. Retenção, receita incremental ou economia de suporte são hipóteses a medir, sem lucro demonstrado aqui.

O estudo pode registrar, sem execução externa:

1. Matriz oficial datada Apple/Google para pagamentos e links externos por região/categoria de app, funcionalidade mínima, exclusão de conta, rótulos de privacidade e distribuição. O texto deve guardar URL, data editorial quando houver, data de leitura, regra concreta e lacuna de aplicação. A verificação cabe às dependências AP4/AP7/AN1, sem conclusão jurídica de conformidade por esta triagem.
2. Matriz de manutenção: builds e assinaturas, atualizações de sistemas/SDKs, credenciais, renovação, revisão das lojas, suporte, acessibilidade, testes e eventual retorno a versão anterior. Fontes e cotas comerciais devem ser verificadas antes de calcular; nenhuma compra ou nova ferramenta é autorizada.
3. Para texto/PDF/material: seleção do criador, vínculo comprador/loja, autorização no salvamento, versão e integridade, retirada na reconexão, troca de conta, cota do aparelho, perda/evicção, exclusão/exportação, marca de comprador e comportamento acessível offline. Definir cenários documentais, sem gerar arquivos de aula salvos.
4. Para vídeo: verificar primeiro as capacidades e restrições oficiais do fornecedor já existente, além de Safari/iPhone e Chrome/Android. Expiração de URL assinada e armazenamento criptografado isoladamente não são prova de proteção contra cópia, de licença offline ou de revogação. Disponibilidade e limites não foram confirmados nesta triagem.
5. Para cada plano mensal/anual: identificar bytes, tentativas/repetições, entrega, armazenamento, comandos, sincronização, retenção, exclusão, abuso e tetos/reservas anteriores ao gasto; encaminhar ao modelo canônico com impostos aplicáveis pela TX e custos fixos 100% FX275. Custos completos de H1, capacidade e margens continuam desconhecidos; nenhum valor foi convertido em zero.

Não se indica manter PWA como substituição definitiva do app já pedido, nem se autoriza abandoná-la. A conclusão documental segura é reutilizar a PWA existente na comparação e preservar os escopos AP/AN/HM1 até haver evidência de viabilidade e decisão na ordem da fila.

## Reservas, método e verificações

Foram lidos `AGENTS.md`, `CLAUDE.md`, `docs/reservations.md`, todos os arquivos existentes em `docs/reservations/` da fonte congelada e CX-116/120/122/123 em `docs/agent-inbox.md:1487–1553`. As reservas da fonte congelada não substituem o estado vivo de PRs; a confirmação da reserva e a conferência externa ficam com o coordenador. Não se alterou reserva, fila, JSON, arquivo de outro agente ou outra cópia. O único arquivo escrito é este relatório, após a confirmação recebida.

As fontes foram lidas com `git show HEAD:caminho`, `git grep HEAD` e `git ls-tree`, sem checkout, clone, fetch, alteração de refs, execução do produto, login, SDK, conta, fornecedor, contrato, chave, build, download de aula ou submissão. Não houve pesquisa web nesta triagem: políticas, preços atuais, exigências de conta e capacidades oficiais não foram apresentados como conferidos. Não foram acessados dados de comprador, credenciais ou painéis.

Conferência documental: correspondência dos requisitos H1 com a matriz acima, separação de H1/AP/AN/HM1, linhas da fonte congelada e diff do único arquivo. Não foram executados testes de produto, navegador, iPhone/Android, VoiceOver/TalkBack, serviço de vídeo, Redis ou loja de aplicativos. O teste existente `tests/pwa-preview-copy.test.ts:9–34` foi apenas lido: cobre descrição/identidade/ícones do manifesto, não instalação real ou modo offline.

### Acessibilidade

Mudança somente de relatório: 0 → 0 passos e decisões na interface. Cabeçalhos e tabelas textuais organizam requisito, evidência e lacuna. Não houve ensaio com leitor de tela ou pessoas, nem declaração de conformidade AAA. Acessibilidade futura do app permanece AP5/AN1/AX274; a do material offline deve acompanhar HM1.

### Estado de entrega

Triagem documental preparada; H1 não está concluído, construído, testado em aparelho, publicado ou disponível como novo recurso. H2 não foi iniciado. Preços, limites, comissão, direitos, flags, gates, revisões comerciais, idiomas, conteúdo e identificadores não foram alterados. Nenhum resultado jurídico ou financeiro foi certificado. Custos reais de pesquisa/CI/manutenção permanecem desconhecidos, não zero; nenhuma margem ou base mínima nova é apresentada. Publicação, revisão e eventual commit ficam com o coordenador.

## Incremento 1 — primeira matriz de fontes oficiais Apple/Google

Leitura pública em **06/11/2026**, concluída após a marca de conferência **20h51 UTC**. As 84 linhas anteriores ficam preservadas como fotografia da triagem inicial, inclusive sua declaração de que aquela etapa não pesquisou a web. Este incremento acrescenta a primeira leitura oficial, sem substituir a base congelada `90eca6cb59dad6445f63021ab2d81c19740e1f62`, alterar o estado da fila ou concluir H1. As classificações abaixo são requisitos documentados e inferências de triagem, não parecer jurídico, aprovação de loja, elegibilidade concedida ou validação econômica.

### Registro de fontes e datas

Todas as fontes abaixo pertencem a Apple ou Google. A data de consulta é 06/11/2026; data editorial não exibida no trecho recuperado permanece desconhecida, sem substituí-la por data de rastreamento do buscador. Os localizadores de seção permitem conferir a afirmação sem login.

| ID | Fonte oficial pública | Data/editorial efetivamente observada e localizador |
| --- | --- | --- |
| A1 | Apple, [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) | Sem data editorial geral visível; lidas 3.1.1, 3.1.1(a), 3.1.3(a–f), 4.2 e 5.1.1(i–v). Texto vivo, sujeito a nova conferência antes de implementação |
| A2 | Apple, [Updated App Review Guidelines are now available](https://developer.apple.com/news/?id=92th7e5i) | Notícia datada **16/10/2026**; registra revisão das Guidelines, incluindo esclarecimento em 3.1.1(a). Não atribui essa data a toda cláusula da página A1 |
| A3 | Apple, [Distributing “reader” apps with a link to your website](https://developer.apple.com/support/reader-apps/) | Sem data editorial visível; definição inicial e seção de elegibilidade do External Link Account Entitlement |
| A4 | Apple, [Payment options on the App Store in the EU](https://developer.apple.com/support/payment-options-on-the-app-store-in-the-eu) | “What's new” informa acordo atualizado **18/08/2026**, mudanças efetivas **01/10/2026**; lidas opções, duração de escolha e “Entitlement and implementation” |
| A5 | Apple, [App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/) | Sem data editorial visível; “Answering app privacy questions” e “Data collection” |
| A6 | Apple, [5.1.1(v) — Offering account deletion in your app](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion) | Sem data editorial visível; orientação, exclusão e FAQ sobre cadastro no navegador; o endereço antigo de suporte redirecionou para este |
| G1 | Google, [Payments](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en) | Sem data editorial geral visível; texto integral, itens 2–4 e 8–9 |
| G2 | Google, [Understanding Google Play's Payments policy](https://support.google.com/googleplay/android-developer/answer/10281818?hl=en) | Sem data editorial visível; FAQ sobre informação administrativa, links e app somente para consumo |
| G3 | Google, [External content links program for users in the US](https://support.google.com/googleplay/android-developer/answer/16470497?hl=en) | Início cita atualização **22/07/2026**, obrigações de transações desde **01/10/2026** e prazo específico de downloads **01/02/2027**; lidos disponibilidade/requisitos/destinos |
| G4 | Google, [Update regarding policies for developers serving users in the US](https://support.google.com/googleplay/android-developer/answer/15582165?hl=en) | Cronologia inclui **29/10/2025**, **04/03/2026**, **22/07/2026** e **21/10/2026**; confirma que políticas e programas atuais continuam aplicáveis |
| G5 | Google, [External offers program](https://support.google.com/googleplay/android-developer/answer/14372887?hl=en) | Voltado ao **EEE**; seção de tarifas informa atualização efetiva **04/06/2026**. Lidas elegibilidade e exigências do programa, sem aceitar termos |
| G6 | Google, [Functionality, Content, and User Experience](https://support.google.com/googleplay/android-developer/answer/9898783?hl=en) | Sem data editorial visível; lido “Full Policy”, funcionalidade/conteúdo limitado e funcionamento quebrado; resumo não substitui texto integral |
| G7 | Google, [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) | Sem data editorial geral visível; “Overview” e quem precisa preencher, com distinção de faixas de teste |
| G8 | Google, [Understanding app account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en) | Cronologia histórica de 2023/2024; lidas exigência vigente, definição de cadastro no app e FAQ de dados/retenção; não tratar datas históricas como prazo futuro |
| G9 | Google Chrome, [Use web apps — Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en) | Sem data editorial visível; definição, instalação via Chrome e limite de funcionamento offline |

### Matriz de requisitos e aplicação limitada

| Tema/canal | Requisito sustentado pela fonte | Aplicação a H1/AP/AN/HM1 e o que continua desconhecido |
| --- | --- | --- |
| PWA pelo navegador | G9 descreve instalação web pelo Chrome e observa que o funcionamento sem conexão pode ser incompleto | Corrobora a distinção de canal já provada no código. Não comprova aulas salvas, cota, persistência, licença, proteção ou revogação. A instalação iPhone continua sustentada pela fonte do repositório; a página Apple localizada teve falha de leitura integral, registrada abaixo |
| Apple: funcionalidade mínima | A1 §4.2 pede utilidade além de website reempacotado | AP2/HM1 precisam de app executável para demonstrar atendimento. PWA não comprova aceitação |
| Apple: pagamento digital | A1 §3.1.1 estabelece IAP para desbloqueio pago, sujeito a exceções | Criador, comprador e demais fluxos exigem enquadramento próprio, ainda desconhecido |
| Apple: app complementar de gestão | A1 §3.1.3(f) prevê complemento gratuito de certas ferramentas web pagas, sem compra ou chamada externa | AP/AN não foram classificados nessa hipótese; “gestão” e ausência de checkout não provam enquadramento |
| Apple: comprador/reader | A3 exige mídia listada como função principal, acesso a compra prévia e outras condições para o entitlement; mídia acessória não basta | HM1 reúne texto/PDF/material/vídeo; offline não atribui categoria reader. Gestão do criador e atendimento não herdam essa categoria. Nenhum entitlement foi solicitado |
| Apple: links nos EUA | A1 §3.1.1(a) dispensa esses entitlements para links/chamadas na storefront dos EUA | Não generalizar mundialmente nem inferir aprovação integral |
| Apple: ofertas na UE | A4 prevê opções alternativas, inclusive ofertas externas, com regras próprias, entitlement, APIs nos casos descritos, proteção etária e escolha de opções por 12 meses | UE não equivale automaticamente ao EEE de G5. AP/AN não escolheram rota, termos ou opções. Taxas aplicáveis dependem da rota; custo total permanece desconhecido. Nenhuma API, termo ou recurso é adotado |
| Google: pagamento digital | G1 cobre funções digitais, educação e software de produtividade; itens 3/8/9 delimitam exceções/programas e restrição a direcionamento externo | AN1 exige análise das telas e destinos. Uso de Stripe, navegador ou webview não prova dispensa de Billing. Nenhuma compra de assinatura é adicionada |
| Google: somente consumo | G2 admite acesso a conteúdo/serviço pago fora, sem compra no app; informação administrativa não deve desembocar em pagamento externo proibido | Alternativa a estudar para HM1 e acesso a serviço prévio. “Manage account” não é salvo-conduto para upsell/pagamento no destino. Classificação concreta continua desconhecida |
| Google: links nos EUA | G3 exige inscrição/aprovação, recorte EUA/territórios, APIs, informação de destino e suporte/reembolso; prevê reporte e taxas | G4 mantém os programas mesmo ao relatar mudança judicial. Não inferir permissão irrestrita ou custo zero. Prazos de downloads e transações são distintos; nenhuma inscrição é realizada |
| Google: ofertas no EEE | G5 exige desenvolvedor empresarial, elegibilidade, inscrição/aprovação, recorte EEE e APIs; proíbe certas combinações com Play Billing no programa descrito | Não se transfere essa regra ao programa dos EUA nem a todo Android. Custo e implementação completos continuam desconhecidos; não há decisão de adesão |
| Google: funcionalidade mínima | G6 exige estabilidade/utilidade móvel e rejeita funcionalidade limitada; cita apps estáticos apenas de texto/PDF | Material offline pode integrar uma experiência maior; esse exemplo não permite concluir que todo leitor de PDF é proibido ou que HM1 seria aprovado. AN1 precisará de prova funcional |
| Apple: privacidade | A5 exige descrição correta dos dados do app e de terceiros, mantida atualizada; coleta funcional também pode exigir declaração | Reutilizar o mapeamento AP1 já pedido em `docs/codex-queue.md:12567`. Política web/inventário atual não validam automaticamente app futuro, sessão local, push ou sincronização de aula |
| Apple: exclusão | A6 exige iniciar exclusão no app quando há cadastro, inclusive se o cadastro é remetido à web; desativar temporariamente não basta | Mapear exclusão de conta e dados, retenções justificadas e experiência real. Cadastro externo não elimina a exigência. Nenhuma exclusão real ou alteração de fluxo ocorreu |
| Google: Data safety | G7 inclui bibliotecas/SDKs e requer declaração mesmo sem coleta; distingue teste interno exclusivo de faixas fechada/aberta/produção | Não preencher por suposição ou copiar rótulo Apple. Mapear famílias, finalidades, coleta/compartilhamento e proteção quando o app existir; nenhum formulário foi preenchido |
| Google: exclusão | G8 requer caminho no app e recurso web para solicitar exclusão quando há cadastro; redirecionar cadastro para fora também conta. Dados associados e retenção precisam de tratamento explícito | Reutilizar AP1/AN1 e exclusão/exportação existentes como base de estudo. Desinstalar, sair, revogar sessão e apagar aula local são operações distintas; nenhuma prova ponta a ponta foi executada |

### Lacunas, temporalidade e próximos documentos

A primeira leitura reduz a lacuna de fontes, mas não demonstra que a regra de cada programa se aplica ao produto. O complemento de AP4/AN1 ainda precisa ligar **cada tela, CTA e destino final** a público, storefront/região, tipo de compra e hipótese aplicável. Os botões que abrem o site em AP4 devem ser inspecionados também pelo destino subsequente; esta é uma inferência de triagem a partir de G1/G2, não uma decisão jurídica. O estudo de privacidade deve confrontar o app efetivo com `lib/data-families.ts` e a política, incluindo qualquer futura sincronização de progresso, antes de declarar os formulários.

Não se adotou uma regra global “todo app de curso é reader”, “todo app empresarial é enterprise”, “vender só na web resolve” ou “link externo não tem taxa”. H1 continua parcial: faltam enquadramento por fluxo/região, revisão completa das rotas possíveis, custos integrais, limites de capacidade, evidência em aparelhos e estudo técnico HM1 de armazenamento/vídeo. As fontes de política acima não comprovam licença offline, DRM, criptografia, persistência, remoção durante desconexão ou limite do fornecedor de vídeo. Nenhuma fonte deste incremento autoriza downloads ou novos dados locais.

Foi localizado o guia Apple “Turn a website into an app in Safari on iPhone”, identificador `iphea86e5236`, por busca no domínio oficial. As aberturas integrais dos endereços de suporte retornaram indisponibilidade/HTTP 429; por isso ele não integra o registro de fontes confirmadas nem sustenta afirmação nova de capacidade. Não houve login, tentativa de contornar bloqueio ou instalação para suprir a falha. A prova do código da PWA já descrita continua separada da orientação de plataforma.

Documentos antigos de termos da UE apareceram na busca, mas não foram usados como regra atual: A4 apresenta mudanças efetivas em outubro de 2026. A comparação deve guardar a data/versão observada e revalidar imediatamente antes da implementação. Datas de corte, regras e tarifas regionais não são imutáveis; a leitura pública não confirma termos aceitos por uma conta deste projeto. Não foram extraídos preços novos para a fila, estabelecido orçamento, alterada comissão ou criado modelo de custo.

Este incremento acrescentou apenas Markdown no mesmo arquivo reservado. Não houve conta, aceite, contato, inscrição, submissão, chave, build, SDK, download de aula, licença, armazenamento, CI ou alteração de refs. Acessibilidade permanece 0 → 0 passos/decisões de interface, sem ensaio com leitor real ou conformidade certificada. Publicação e revisão continuam com o coordenador; H1 permanece estudo parcial e H2 não foi iniciado.


## Nota de coordenação — alcance histórico de H2

As menções anteriores a H2 como não iniciado pertencem às fotografias documentais preservadas nesta unidade. A triagem documental separada de H2 já foi preparada no mesmo lote, em `docs/reviews/m-lot01-h2-triage.md` (fonte original `4ff5844714dd3b4db5fb917ef82e6195cdef6391`, blob `fe9ac66223bfc0d332ded5e644a39bcc9c9880d3`). Isso não conclui o item H2 nem comprova transmissão, captura, privacidade dos aparelhos ou custo completo; os dois estudos continuam parciais, sem implementação ou alteração do estado da fila. Esta nota apenas resolve a leitura temporal entre os relatórios, preservando integralmente o texto e as fontes anteriores de H1.
