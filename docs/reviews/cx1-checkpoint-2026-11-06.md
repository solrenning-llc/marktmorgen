# Continuidade canônica — Codex CX1

Pasta única autorizada: `C:/Users/vinic/Projects/marktmorgen-cx1`. Função: **revisor independente**, ordem `C1-20261106-0021-CX-CX1-1`. Ramos próprios `codex/cx1-*`. Esta é a primeira continuidade consolidada CX1; atualizar este arquivo e ramo, sem criar outro checkpoint.

Antes de retomar, ler o último ponto CX1 no canal e este arquivo inteiro; depois `git fetch origin main`, própria seção Codex em `docs/agent-inbox.md` e mensagens novas. AGENTS.md, CLAUDE.md, cross-product-handoff e CX-122/123 já foram lidos. Não editar a caixa. Confirmar mensagens novas pelo canal. Manter o vigia de caixa de 30 segundos, máximo de dois minutos por ciclo; não usar isso para polling de CI.

## Estado de atuação

- Nenhum PR de produto CX1, merge, deploy, retry ou cancelamento de CI foi feito. Apenas provas e relatórios em ramos próprios e pareceres nos PRs/canal.
- Nenhum produto/ramo de outro agente, preço, limite, comissão, flag, gate, conta, termo ou configuração do Windows foi alterado. Somente testes sintéticos; nenhum pedido foi encaminhado a fornecedor real.
- A última unidade concluída foi o retorno financeiro #2742 no head `56a7b96136034d252b740a2b87e771c39752c4fb`, parecer `5796165925`, relatório final no ramo `codex/cx1-review-2742-final` (último commit observado `5e45c0ae2`). Meus dois MÉDIOS estão fechados. **Não incorporar sem o segundo parecer financeiro aplicável e os nove checks exatos.**
- A discussão #2742 foi lida ao concluir: o único parecer independente D2 publicado localizado era `5795378845`, ainda NOT CLEARED no antigo `1a1f7c171b8692cf06c9fc60eb56468caf9da146`. O autor pediu o retorno D2 no comentário `6677715078`. A prova D2 verde relatada pelo autor não substitui esse parecer. Não sondei CI do head final enquanto a segunda opinião segue pendente.
- Próxima ação: inventário fresco de pedidos sem revisor anunciado; dar prioridade aos retornos nominais quando vierem heads novos. Há pedidos recentes #2770 (números da API) e #2769 (decisão documental Upstash), dirigidos a G2/R2, que exigem conferir a discussão/canal antes de assumir. Não duplicar #2750, já revisto por CX1; S interrompeu a duplicação ao achar o parecer no PR.

## Revisões com pendência do autor

| PR / head revisado | Situação e prova | Relatório mais recente CX1 |
| --- | --- | --- |
| #2726 `b5de47d96212e59cc0ebf3fbbbd8d48b8298916a` | MÉDIO aberto: releitura parcial de gift/preorder é aceita como already e pode confirmar entrega sem grant. Parecer `5795506309`; prova `72f0ee33d72339ffd6419f2c5827c6b980556fa2`, 10 checks/6 falhas + 4 controles. Nenhum corretivo nominal recebido até esta fotografia. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2726/docs/reviews/cx1-2726-2026-11-06.md), ramo atualizado `c701c961e` |
| #2723 `30023e192ae12adc1433de2c7e0ec603a0a6d3f9` | M1/M2 originais fechados com a mesma prova 14/14. MÉDIO residual aberto: `recordNames` usa parser tolerante, descarta versão parcial e apaga texto que o registro real ainda nomeia. Parecer `5795753027`; prova `645c15b1cf1ffcc5f2d0d687e712c6803ef289c0`, 7/5 falhas + 2 controles. Passkeys permanecem com o retorno focal G, separado. | [Retorno](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2723-return/docs/reviews/cx1-2723-return-2026-11-06.md), `fc589f65d` |
| #2761 `d17e4662f8d2b939ec07ff343bf882f835c69905` | Sem achado funcional de contraste, 127/127. **LEVE/CI impeditivo:** os dois títulos novos usam `colour`; oficial US-English 42/1, got 2. Parecer inicial `5796044066` foi complementado/retificado por `5796077438`. Prova oficial/executor `2e31266e9`; não usar o parecer inicial como ausência desse achado. | [Relatório atualizado](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2761/docs/reviews/cx1-2761-2026-11-06.md), `74a68b261` |
| #2764 `b86342b7db1d3cc0250a6c5c6c37047b47635efe` | Três MÉDIOS CX1 fechados; fontes imutáveis 10/10+4/4+8/8. **LEVE residual:** perda de conexão depois de aplicar preço/dc cai no catch/error e a mensagem diz que nada mudou. Parecer `5796127370`; prova `4fb2a6a726a05b4053f2989b91fef5a6de5c7d98`, 6/2 falhas + 4 controles. R2 reproduziu; não alegar cobrança duplicada. Segunda revisão integral ainda requerida pelo autor. | [Aplicabilidade](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2764-unconfirmed-return/docs/reviews/cx1-2764-unconfirmed-2026-11-06.md), `537a54c4e` |

Os dois títulos do #2761 precisam virar `color`, com asserções preservadas e novo head para retorno. Uma única leitura causal mostrou oito workflows success e um failure (`42160817405`, verify `127707029786`), exatamente o teste de inglês; 268/268 bundles passaram. Sem retry, porque a causa está no próprio delta. Merge-tree limpo contra main `121ada2248f192741eddc48fd6bede8c745fc71a`, mas nove verdes não atendidos. O booleano normalizado mergeable false não é razão isolada para perseguir main.

O LEVE do #2764 cobre uma exceção de transporte após aplicar, não a resposta HTTP malformada que já foi corrigida. A prova preserva uma tentativa, nenhum recibo ou POST posterior, e controles de sucesso/recusa conhecida HTTP 400. Não converter toda recusa em incerteza e não cobrar outra vez. O prefixo da prova teve um dígito incorreto no parecer; a precisão com SHA completo foi publicada no comentário `6677723201`.

## Revisões concluídas ou com gates separados

| PR / head exato | Parecer e limites | Evidência |
| --- | --- | --- |
| #2742 `56a7b96136034d252b740a2b87e771c39752c4fb` | `5796165925`, dois MÉDIOS CX1 fechados; 170/170 ligados e mesmas provas 10/10+6/6. D2/segundo parecer e nove checks continuam requisitos. LEVEs R2 de pending antigo/failed-paid não foram promovidos a achados CX1 sem prova própria. | [Final](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2742-final/docs/reviews/cx1-2742-final-2026-11-06.md) |
| #2757 `38a03ac0cd6f64ee1d5458af228e48ccba071180` | `5795613381`, sem achado adicional no parser SES. **DRAFT/HOLD #2612 obrigatório**, mesmo com CI verde. Nenhuma ativação SES/Delivery/Delay ou relatório é autorizada. H2 relatou uma única repetição de verify por review-2556 fora do delta; não repetir por CX1. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2757/docs/reviews/cx1-2757-2026-11-06.md), `15166cc5b` |
| #2750 `102f5eec55ab579464ef421803362468991e12b1` | `5795452439`, sem achado/pode entrar com nove exatos. Só comentário/log/descrição de registry; contratos ligados 25/25. S localizou a revisão e interrompeu duplicação antes de testar. Não reabrir sem novo delta. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2750/docs/reviews/cx1-2750-2026-11-06.md), `76a9c0d23` |
| #2748 `fcadf61fb17c71e8f1cf532ca3ffe12660a70c39` | `5795421507`, sem achado, nove exatos verificados à época. **MERGED pelo autor T**, merge `51874507d9a014b99c35ea299cd17a81e4a0fd03`, confirmado no canal; não reabrir/repetir. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2748/docs/reviews/cx1-2748-2026-11-06.md), `e4cfbaf59` |

### Provas financeiras/contratuais imutáveis para retornos

- #2742 enum: `711c03e076a7b09bbb4638141fb1e32fcbb359a7`, `tests/cx1-review-2742-status.proof.ts`.
- #2742 coerência: `04bc6a1445b8c49b15718949b9d699e766c0612f`, `tests/cx1-review-2742-consistency.proof.ts`.
- #2764 resposta: `08f9d750d340eb3661acccb4b5a2eedfc599ef6a`, `tests/cx1-review-2764-charge-reply.proof.ts`.
- #2764 versão: `2cf954e4f` contém a prova 4/2 original; `1539da13b` só remove import/contador sem uso, sem alterar asserções. `tests/cx1-review-2764-stripe-version.proof.ts`.
- #2764 fatura: `959bdf0eb762e5ab750308fa6959dd63f3120aa1`, `tests/cx1-review-2764-invoice.proof.ts`.
- #2723 original: `23272e6203595f251eb65123d249a5764dd929ec`, blob do teste `5d778356cf7327596f3bc44f0108893bec764204`; 14/14 após 30023e19. A nova prova 645c15b1 é distinta.

Os executores públicos usam `node_modules/.cache/cx1-reviews`, compatível com worktrees. Três executores antigos usavam `.git` como diretório e foram corrigidos sem alterar testes: #2742 `cfdd17a91`, #2726 `c701c961e`, #2723 original `f59ca74e4`. Para replay exato, buscar o teste imutável por `git show` e compilar contra o produto alvo; não afrouxar a fonte para passar.

## Ambiente e verificação honesta

- Dependências locais instaladas por npm ci com cache `.git/npm-cache`, sem scripts; não reinstalar sem causa. Nenhum arquivo fora desta pasta foi lido ou modificado.
- `core.autocrlf=true`: há falhas estáticas LF/CRLF no Windows. `plan-refund-rules` teve 64/67, três comparações literais de fonte em teste/página inalterados; não repetir/alterar só para esconder. Email-site-fields e security-txt também tiveram limitações já descritas no primeiro relatório #2748. Não alegar suíte global verde.
- Não foram executados navegador/leitor local, Redis nativo, Stripe real, suíte global ou certificação de lucro. CI consultado só no #2761 após a revisão, por novidade causal; não houve retry/cancelamento.
- Scanner completo de `df47ab8b3e1cef55184e9cd4f633c41b23e84014`: 3.852 arquivos/zero achados. Alguns archives antigos ficaram sem conclusão e foram interrompidos; a conclusão usou reutilização de blobs iguais e exame individual dos diferentes, sempre com o mesmo detector.
- A igualdade do detector foi conferida nos heads usados: blob `a9823fcbc9fec88703f4df39c8f3822c673edbea` para `scripts/check_public_data.py`. O helper de reutilização agora exige também igualdade entre detector do alvo, referência e arquivo de trabalho; se mudar, não reutilizar o resultado anterior. Símlinks continuam verificados.

### Auxiliares privados persistentes nesta pasta

- `.git/cx1-send.cjs`: lê o pai fresco de para-claude-1, recusa arquivo menor que 20 KB, acrescenta ao fim de messages.md, cria commit com aquele pai e push sem força. Em corrida, esperar pelo menos dois minutos e tentar com pai novo. Após duas falhas, preservar o append no próprio ramo e informar SHA; isso foi feito e resolvido no #2764 e #2761, sem regravar histórico.
- `.git/cx1-targets.mjs`: executa testes focados com aliases/ambiente oficiais e salva saídas em `.git/cx1-results` (válido nesta cópia, onde .git é diretório).
- `.git/cx1-typecheck.cjs`: TypeScript estrito dos roots indicados e imports; não é certificação de TSC global.
- `.git/cx1-scan-snapshot.py` e `.git/cx1-scan-reuse.py`: snapshots exatos e reutilização com guarda de detector. Saídas de cada revisão e scripts de replay estão em `.git/cx1-*`; os achados/provas importantes estão publicados nos ramos acima.

Uso percentual/renovação Codex não estavam visíveis por ferramenta dentro do escopo autorizado; não inventei orçamento nem li configurações externas. Nenhum subagente foi criado. Não marcar lembrete ou alterar automações; continuar trabalhando nas revisões possíveis e manter o vigia da caixa.
