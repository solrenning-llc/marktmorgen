# Codex CX1 — retorno da versão Stripe no PR #2764

Head exato: `36425f5a575d3be755cf7c6e0662e87c87b1d463`. [Parecer 5795933911](https://github.com/solrenning-llc/marktmorgen/pull/2764#pullrequestreview-5795933911): **MÉDIO de versão fechado; MÉDIO de fatura permanece; não liberado integralmente**.

Todo o delta `652f1aa8..36425f5a` foi lido: três arquivos. As duas cobranças agora passam `SWITCH_STRIPE_VERSION = "2026-08-26.dahlia"` à quinta posição de `onAccount`; o cabeçalho não depende mais do padrão da conta. Essa versão contempla a metadata em atualizações pendentes, conforme o [changelog oficial de 27/05/2026](https://docs.stripe.com/changelog/dahlia/2026-05-27/pending-subscription-update-metadata). A prova promovida é byte a byte idêntica ao arquivo do commit `1539da13b`.

Resultados das mesmas fontes imutáveis, sem alterar asserções:

| Prova | Resultado no head 36425f5a |
| --- | --- |
| Resposta de cobrança `08f9d750d` | 10/10; primeiro MÉDIO continua fechado |
| Versão Stripe `2cf954e4f` | 4/4; segundo MÉDIO fechado |
| Fatura desconhecida `959bdf0eb` | 8 checks, 6 falhas causais e 2 controles; residual permanece |
| Permanente de versão do autor | 4/4 |

O residual em `lib/tier-switch.ts` e `lib/yearly-switch.ts` continua sendo a conversão de total de fatura desconhecido em zero. A simulação aplica preço/dc e define uma fatura paga de 1.000 centavos; somente a fatura retornada é omitida ou deformada. O recibo ainda declara `Nothing was charged today.`. A prova não exige desfazer a troca, nem exige `result.ok: false`; exige não afirmar zero sem ler o valor. Não autoriza cobrar outra vez. O [retorno anterior 5795913207](https://github.com/solrenning-llc/marktmorgen/pull/2764#pullrequestreview-5795913207) e a prova durável permanecem aplicáveis.

TypeScript estrito dos módulos/imports e permanente novo: zero diagnósticos; ESLint zero; diff-check limpo. Scanner do head: 3.854 arquivos/zero achados, por blobs idênticos ao snapshot `df47ab8b` já coberto (3.852/0) e seis blobs diferentes examinados individualmente pelo mesmo `findings` oficial.

Não repeti os 330/340 checks anteriores: o delta somente fixa a versão e promove a prova, e os três grupos causais foram reexecutados. Sem navegador, leitor de tela, Redis nativo, Stripe real, suíte global ou leitura/repetição de CI. Nenhum produto, ramo ou CI de outro agente alterado; nenhum merge. O segundo parecer independente e os nove checks do head final continuam necessários após a correção do residual.
