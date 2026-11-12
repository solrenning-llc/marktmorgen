# Navegadores e aparelhos — item201

Iniciado em20/10/2026 17:29 de Fortaleza. Estado: em andamento; nenhuma conformidade AAA global ou validação em aparelho real afirmada.

## Etapa1: motores adicionais na suíte existente

Playwright-core1.56.1 do lockfile instala Firefox/WebKit e dependências Linux no CI. E2E_BROWSER seleciona explicitamente o motor; instalação/lançamento falho reprova sem fallback para Chromium. O job Chromium original continua. A suíte existente inteira de studio/páginas públicas roda em cada motor, com serviços sintéticos. Não há conta, pagamento ou envio real.

**Estado da matriz automática (conferido no main em 12/11/2026, complemento C1-20261105-1919-C4-1).** O texto anterior dizia que a matriz completa "ainda precisa ser acrescentada"; ela já existe no main, em cinco arquivos, cada um com seu workflow, nos três motores (`browser: [chromium, firefox, webkit]`), nas cinco larguras 320, 390, 768, 1280 e 1920 px e nos modos `baseline`, `text-spacing` (1.4.12), `reduced-motion`, `forced-colors`, `reflow-320` e, no repositório público, `dark`, com axe-core injetado na página:

| Arquivo | Workflow | O que cobre |
| --- | --- | --- |
| `tests/e2e/accessibility-public-matrix.mjs` | `.github/workflows/accessibility-public-matrix.yml` | Páginas públicas `/`, `/pricing` e `/signin`, com teclado (foco e alvo do conteúdo) e auditoria axe por largura e modo |
| `tests/e2e/accessibility-studio-matrix.mjs` | `.github/workflows/accessibility-studio-matrix.yml` | Estúdio: `/studio` e `/studio/pages` de uma loja sintética |
| `tests/e2e/accessibility-signup-actions.mjs` | `.github/workflows/accessibility-signup-actions.yml` | Cadastro, com caixa de entrada, sessão e reserva do nome da loja sintéticos e descartáveis |
| `tests/e2e/accessibility-product-actions.mjs` | `.github/workflows/accessibility-product-actions.yml` | Formulário de produto no estúdio e criação de um produto descartável |
| `tests/e2e/accessibility-buyer-actions.mjs` | `.github/workflows/accessibility-buyer-actions.yml` | Lado do comprador: página da loja, página do produto, checkout sintético, página de agradecimento e `/library` |

Isso é automação de motor, não conformidade: o axe não certifica critérios que exigem avaliação humana, e os resultados "incomplete" ficam registrados como lacunas pelos próprios arquivos. Continuam abertas, sem nenhum resultado afirmado aqui: aparelhos reais (iPhone/iPad, Android, Windows/Edge), tecnologias assistivas reais (VoiceOver, TalkBack, NVDA, JAWS), o zoom real de 400% do navegador (a matriz mede reflow em 320 px, que não substitui o zoom do usuário) e a verificação contra robôs (BotID, `lib/bot-check.ts`), que o complemento mantém como conferência manual. Rodar estas matrizes não encerra o item 201.

## Custo de CI

Fonte oficial consultada20/10/2026: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Runners padrão em repositórios públicos são gratuitos. Este repositório é público e usa ubuntu-latest padrão. Matriz nova:2jobs, teto45min cada =90min adicionais/execução; Rexecuções consomem no máximo90Rmin. Consumo observado pendente da primeira execução. Sem upload de artefato/cache customizado/runner maior novo. Nenhuma franquia de fornecedor por cliente foi usada para reduzir um custo unitário: teste é custo fixo operacional, sem operação por cliente.

Elegibilidade atual: custo incremental cobrado de minutos padrão USD0/mês e USD0/ano; não é promessa de custo futuro. Se mudar para privado ou runner pago, recalcular antes de operar usando maior tarifa aplicável e impostos; não assumir franquia gratuita. Não há assinatura/conta nova autorizada. Preços, direitos e todos os gates intactos.

## Aparelhos reais: lacunas e opções para decisão do dono

Linux WebKit não é Safari instalado no iPhone/macOS. Viewports não validam toque/teclado virtual, VoiceOver/TalkBack/NVDA/JAWS, renderização do sistema, gestos, contraste do Windows, hardware/energia, orientação física ou fluxos com apps de pagamento. Precisam de iPhone/iPad, Android/tablet e Windows/Edge reais; não foram testados aqui. Automação de motor não substitui os participantes do item202.

Preços oficiais consultados20/10/2026, somente pesquisa, sem conta/contato/contratação:

- [Sauce Labs](https://saucelabs.com/pricing): Live Testing USD49/mês mensal (USD588/12meses), ou USD39/mês com cobrança anual (USD468/ano); Real Device Cloud USD249/mês mensal (USD2988/12meses), ou USD199/mês anual (USD2388/ano),1teste paralelo. Confirmar dispositivos/tecnologias assistivas incluídos antes de qualquer decisão.
- [BrowserStack](https://www.browserstack.com/pricing): Automate Desktop & Mobile USD175/mês faturado anualmente (USD2100/ano),1paralelo; Pro USD225/mês anual (USD2700/ano). Valores não equivalem a orçamento final de acessibilidade/participantes. Mensalidade sem fidelidade, impostos e recursos assistivos específicos não confirmados: desconhecidos, não zero.

Compra de aparelhos físicos não orçada; impostos Brasil/EUA, câmbio, remessa, pessoas executando testes, reserva e preços finais completos permanecem desconhecidos. Nenhum gasto aprovado nem margem certificada. Antes de contratar, calcular custo fixo integral mensal/anual e base mínima de clientes sob leitura mais onerosa. Mínimo60% líquido por cliente isolado a100% dos direitos e global permanece obrigatório; vendas fechadas.

## Reconciliação da prova automatizada —23/10/2026

A lacuna anterior de criação do endereço e publicação inicial já foi coberta em tests/e2e/accessibility-signup-actions.mjs. Não criar uma matriz duplicada. No head db916f1bc78c3347043eb65d9abc51903457e55c do PR826, todos os22checks passaram; incorporação498d0c3d850d04cd598665c6b899088232114ebb em23/10/2026 às03:47:13Fortaleza. Entrega177 READY03:48:03.421Fortaleza, dpl_8vPKKLFXWPJRR4bgYHBJD5n23T97, domínio/SHAexato e5rotas200mesmoDPL.

Run39910764633: WebKit26.0 job120273200893, Chromium141.0.7390.37 job120273200865, Firefox142.0.1 job120273200633. Cada motor concluiu25casos,125auditorias e0falhas; total75casos/375auditorias. Viewports320/390/768/1280/1920, modos baseline/text-spacing/reduced-motion/forced-colors/reflow-320. O fluxo executa autenticação local com e-mail capturado no simulador, confirmação explícita e criação real da primeira loja somente no banco descartável; remove a sessão e recarrega anonimamente o novo endereço, exigindo200e nome exato. São permitidas apenas as três mutações locais de acesso/confirmação/claim; rede estrangeira é recusada. Cada etapa é auditada para violações e overflow. Incompletos do axe permanecem como lacunas manuais, não aprovações.

Isso fecha somente a lacuna automatizável específica de claim/publicação inicial; não encerra201, não prova checkout/comprador por esse fluxo, nem certificaAAA. Aparelhos físicos, pessoas com deficiência, tecnologias assistivas, zoom real400%, comportamento de produção BotID e revisão manual de scroll continuam abertos conforme as seções anteriores. WebKit pode não expor corpo de beacon; somente a chamada estatística sintética exata recebe204sem gravação, e a prova de payload continua manual.

Esta reconciliação não adiciona teste, job, operação de produto, fornecedor ou gasto autorizado: incremento máximo mensal/anual0/0porStore/Studio/Scale. Custos reaisCI/deploy e cotações completas permanecem desconhecidos,nãozero. Manter60%líquido individual/global após todos os impostos sob leitura mais onerosa e100%LLC; nenhuma margem certificada ou gate aberto. Valores históricos pesquisados acima não são cotações atuais nem autorização de compra.
