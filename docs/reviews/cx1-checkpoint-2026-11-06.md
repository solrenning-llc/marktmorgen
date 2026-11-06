# Continuidade canônica — Codex CX1

Pasta única autorizada: `C:/Users/vinic/Projects/marktmorgen-cx1`. Função: **revisor independente**, ordem `C1-20261106-0021-CX-CX1-1`. Ramos próprios `codex/cx1-*`. Esta é a primeira continuidade consolidada CX1; atualizar este arquivo e ramo, sem criar outro checkpoint.

Antes de retomar, ler o último ponto CX1 no canal e este arquivo inteiro; depois `git fetch origin main`, própria seção Codex em `docs/agent-inbox.md` e mensagens novas. AGENTS.md, CLAUDE.md, cross-product-handoff e CX-122/123 já foram lidos. Não editar a caixa. Confirmar mensagens novas pelo canal. Manter o vigia de caixa de 30 segundos, máximo de dois minutos por ciclo; não usar isso para polling de CI.

## Estado de atuação

- Nenhum PR de produto CX1, merge, deploy, retry ou cancelamento de CI foi feito. Apenas provas e relatórios em ramos próprios e pareceres nos PRs/canal.
- Nenhum produto/ramo de outro agente, preço, limite, comissão, flag, gate, conta, termo ou configuração do Windows foi alterado. Somente testes sintéticos; nenhum pedido foi encaminhado a fornecedor real.
- A última unidade concluída foi o retorno financeiro #2742 no head `bbde49fe4752d482cda069e858a88de47280588b`, parecer `5796445931`, relatório `codex/cx1-review-2742-r2-return@134b52eafc3f6c8e277317ec7e754b8da76a1a6a`. Meus dois MÉDIOS continuam fechados, 174/174 ligados e mesmas provas 10/10+6/6. #2764 mantém LEVE e três MÉDIOS fechados no `9cb8244c`, parecer `5796250041`, relatório `codex/cx1-review-2764-transport-return@daa4dd0f5`. **Ambos continuam dependendo do segundo parecer financeiro/integral aplicável e dos nove checks exatos.**
- A discussão #2742 foi lida ao concluir: o único parecer independente D2 publicado localizado era `5795378845`, ainda NOT CLEARED no antigo `1a1f7c171b8692cf06c9fc60eb56468caf9da146`. O autor pediu o retorno D2 no comentário `6677715078`. A prova D2 verde relatada pelo autor não substitui esse parecer. Não sondei CI do head final enquanto a segunda opinião segue pendente.
- Próxima ação: inventário fresco de pedidos sem revisor anunciado; dar prioridade aos retornos nominais quando vierem heads novos. #2769 (decisão documental Upstash) é candidato, dirigido a G2/R2, e exige conferir discussão/canal antes de assumir. Não duplicar #2750, já revisto por CX1; S interrompeu a duplicação ao achar o parecer no PR.
- #2770 foi revisto integralmente no `cac700ed4bb4f358effe588c4c43a600ef55becc`, parecer `5796418480`: MÉDIO residual de conteúdo financeiro ilegível ainda aberto, prova imutável 4/3 falhas+1 controle. Publicado no PR e canal `b701c6b716bf20708c7b979412994f5ca8c4b92e`. Autor S deve retornar com novo head; não repetir os 184 ligados sem causa.
- #2742/bbde teve retorno novo, portanto o parecer aplicável agora é `5796445931`. Canal `ec81257ac2c22bcf6fc63023db124380386089ea`. D2 continua separado; API inicial mergeable:false, sem alteração no ramo do autor ou CI. Não alegar 241/241 local: rules67 tem limitações LF/CRLF já registradas.

## Revisões com pendência do autor

| PR / head revisado | Situação e prova | Relatório mais recente CX1 |
| --- | --- | --- |
| #2770 `cac700ed4bb4f358effe588c4c43a600ef55becc` | MÉDIO residual aberto: cópia com cabeçalho exato e totals.d7.cents ilegível é devolvida como conhecida; summaryOf real exporta receita textual/booleana/nula com paid_figures_complete:true. Parecer `5796418480`; prova imutável `1d8732e3857b338a21c3f55e9c0839ce6c6ade6f`, 4/3 falhas+1 controle, também no pai; 184/184 ligados. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2770/docs/reviews/cx1-2770-2026-11-06.md), `0bdee0873781489c7cd08ec1dcc666ac0559f0f6` |
| #2726 `b5de47d96212e59cc0ebf3fbbbd8d48b8298916a` | MÉDIO aberto: releitura parcial de gift/preorder é aceita como already e pode confirmar entrega sem grant. Parecer `5795506309`; prova `72f0ee33d72339ffd6419f2c5827c6b980556fa2`, 10 checks/6 falhas + 4 controles. Nenhum corretivo nominal recebido até esta fotografia. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2726/docs/reviews/cx1-2726-2026-11-06.md), ramo atualizado `c701c961e` |
| #2723 `30023e192ae12adc1433de2c7e0ec603a0a6d3f9` | M1/M2 originais fechados com a mesma prova 14/14. MÉDIO residual aberto: `recordNames` usa parser tolerante, descarta versão parcial e apaga texto que o registro real ainda nomeia. Parecer `5795753027`; prova `645c15b1cf1ffcc5f2d0d687e712c6803ef289c0`, 7/5 falhas + 2 controles. Passkeys permanecem com o retorno focal G, separado. | [Retorno](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2723-return/docs/reviews/cx1-2723-return-2026-11-06.md), `fc589f65d` |
| #2761 `d17e4662f8d2b939ec07ff343bf882f835c69905` | Sem achado funcional de contraste, 127/127. **LEVE/CI impeditivo:** os dois títulos novos usam `colour`; oficial US-English 42/1, got 2. Parecer inicial `5796044066` foi complementado/retificado por `5796077438`. Prova oficial/executor `2e31266e9`; não usar o parecer inicial como ausência desse achado. | [Relatório atualizado](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2761/docs/reviews/cx1-2761-2026-11-06.md), `74a68b261` |

Os dois títulos do #2761 precisam virar `color`, com asserções preservadas e novo head para retorno. Uma única leitura causal mostrou oito workflows success e um failure (`42160817405`, verify `127707029786`), exatamente o teste de inglês; 268/268 bundles passaram. Sem retry, porque a causa está no próprio delta. Merge-tree limpo contra main `121ada2248f192741eddc48fd6bede8c745fc71a`, mas nove verdes não atendidos. O booleano normalizado mergeable false não é razão isolada para perseguir main.

O LEVE histórico do #2764 cobria uma exceção de transporte após aplicar, não a resposta HTTP malformada. Foi fechado no `9cb8244c` pela mesma prova 6/6, preservando uma tentativa, nenhum recibo ou POST posterior e controles de sucesso/recusa conhecida HTTP 400. Um probe de entrada HTTP 500 após aplicar, com asserções originais, também passou 6/6. Não converter toda recusa em incerteza e não cobrar outra vez. O prefixo da prova teve um dígito incorreto no parecer antigo; a precisão com SHA completo foi publicada no comentário `6677723201`.

## Revisões concluídas ou com gates separados

| PR / head exato | Parecer e limites | Evidência |
| --- | --- | --- |
| #2742 `bbde49fe4752d482cda069e858a88de47280588b` | `5796445931`, dois MÉDIOS CX1 continuam fechados e sem novo achado; 174/174 ligados e mesmas provas 10/10+6/6. RED novo 3fa66672462/4 reproduzido. D2/segundo parecer e nove checks continuam requisitos. Ajuste R2 lido integralmente; parecer do 56a7 foi substituído por este retorno aplicável. | [Retorno R2](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2742-r2-return/docs/reviews/cx1-2742-r2-return-2026-11-06.md), `134b52eaf` |
| #2764 `9cb8244c4e07466d27900e3b00162a1df7c65d84` | `5796250041`, três MÉDIOS e LEVE CX1 fechados; quatro fontes imutáveis 28/28, permanentes/ligados 97/97 e probe HTTP 500 identificado 6/6. Segunda integral e nove checks continuam requisitos, não consultados/certificados por CX1. | [Transporte fechado](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2764-transport-return/docs/reviews/cx1-2764-transport-return-2026-11-06.md), `daa4dd0f5` |
| #2757 `38a03ac0cd6f64ee1d5458af228e48ccba071180` | `5795613381`, sem achado adicional no parser SES. **DRAFT/HOLD #2612 obrigatório**, mesmo com CI verde. H2 informou que a repetição única terminou success e os nove ficaram verdes; preservou DRAFT/HOLD sem incorporar. Nenhuma ativação SES/Delivery/Delay ou relatório é autorizada. Não repetir por CX1. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2757/docs/reviews/cx1-2757-2026-11-06.md), `15166cc5b` |
| #2750 `102f5eec55ab579464ef421803362468991e12b1` | `5795452439`, sem achado. **MERGED pela C3**, confirmado na API após novidade do canal: merge `c1c2bcd6ab91a9a28d920be8787569766cbe2cc4`. Só comentário/log/descrição de registry; ligados 25/25. S interrompeu duplicação antes de testar. Não reabrir. | [Relatório](https://github.com/solrenning-llc/marktmorgen/blob/codex/cx1-review-2750/docs/reviews/cx1-2750-2026-11-06.md), `76a9c0d23` |
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
