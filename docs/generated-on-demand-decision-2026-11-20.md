# Relatórios de preço, margem e custo gerados na hora: decisão do dono (20/11/2026)

Aplicada no código e nos testes pelo Claude 4 (sessão `01S9eVA3Rj`) no mesmo PR que grava este registro. A regra resumida está em [AGENTS.md](../AGENTS.md): regra AC (b) e (d) e seção "One receiving model for every unit". Nenhum número, preço, limite, imposto, teto, comissão, trava ou flag muda por esta decisão.

## Proveniência

O coordenador (Claude 5) deixou uma pendência para o dono na medição C5-20261121-0535 (20/11/2026, 08h31 UTC). Todo PR de custo carregava os documentos gerados de preço e margem. Quando um deles entrava no main, todos os outros voltavam a conflitar nesses arquivos: das 08h00 às 08h20 UTC, 8 dos 20 PRs recém-juntados voltaram ao conflito. A proposta era um workflow que regenerasse os documentos depois de cada entrada no main.

O Claude 4 apresentou a pendência ao dono em 20/11/2026, por volta das 13h (Fortaleza). O dono respondeu com uma variante de atraso zero, transcrita abaixo na íntegra. Ficaram de fora só o cabeçalho de e-mail e o nome do dono. A resposta foi enviada ao Claude 4, com cópia ao Claude 5 (coordenador, autor da proposta) e ao Codex (faixa de dinheiro e custos).

## Texto do dono

> Assunto: Relatórios de preço e margem gerados na hora, sem cópia guardada (atraso zero), no lugar do workflow de regeneração
>
> Autorizo, com atraso zero: em vez de regenerar os documentos depois de cada entrada no main, eles deixam de ser guardados como cópia e passam a ser gerados na hora, pelos próprios scripts, sempre que alguém precisar deles. Condições:
>
> 1. Os relatórios gerados por script deixam de ter cópia guardada: docs/margin-alignment-2026-10-18.md, docs/pricing-optimization-2026-10-18.md, docs/pricing-optimization-milp-input-2026-10-18.json, docs/limits-proposal-2026-10-18.md, docs/pricing-usage-proposal-2026-10-18.md e os outros gerados por script que a regra AC (b) já lista. Cada um fica no mesmo caminho com um texto curto e fixo, que nunca muda: "Generated on demand: run node scripts/<script>.mjs; the output is always computed from the current code." Assim os links antigos continuam funcionando, o arquivo nunca conflita e nunca fica atrasado. O conteúdo antigo fica no histórico do git.
>
> 2. Ficam guardados, porque não são gerados: docs/pricing-optimization-data-2026-10-18.json (dados de concorrentes, que são a entrada do cálculo) e todo documento escrito à mão, como docs/value-presentation-2026-10-18.md, cujos números continuam conferidos contra o código em todo PR.
>
> 3. Resultado do solucionador (docs/pricing-optimization-milp-output-2026-10-18.json): se o solucionador roda no CI em tempo aceitável, ele também passa a ser gerado na hora. Se não roda, o resultado continua guardado e vai junto, no mesmo PR, só quando a entrada do solucionador mudar, o que é raro; assim ele também nunca fica atrasado. Conferir qual dos dois casos vale antes de mudar, e registrar no PR.
>
> 4. Nada de proteção sai. Todo teste que hoje compara o documento com o script passa a conferir a saída gerada na hora, com as mesmas contas: tetos, margens, unidade à venda que dá prejuízo, algo à venda com unidade reprovada e a leitura de imposto que passa uma unidade. Esses testes continuam em todo PR, sobre o resultado da junção. Os testes que leem esses arquivos (por exemplo, tests/margin-alignment.test.ts, tests/lq17-cost-document.test.ts e tests/limits-proposal.test.ts) mudam para ler a saída gerada, sem tirar nenhuma conferência de número.
>
> 5. Para eu poder ler os relatórios no GitHub sem rodar nada: o CI de cada entrada no main publica os relatórios gerados no resumo da execução, marcados com o commit de onde vieram. Isso é opcional; se custar minutos de Actions sem retorno, fica de fora.
>
> 6. Números mostrados ao dono: todo número de margem, lucro, custo ou preço que um agente me apresentar é calculado na hora pelo próprio script, sobre o main atual.
>
> 7. O PR desta mudança tem teste que falha antes, revisão independente (o Codex revisa a parte de dinheiro e custos), as 9 verificações verdes no head exato e git merge-tree limpo, seguindo as regras CV, MV e AC. O AGENTS.md é atualizado onde diz que esses documentos são gerados e conferidos como cópia (seção "One receiving model for every unit" e regra AC (b) e (d)), dizendo que agora são gerados na hora, sem mudar mais nada.
>
> 8. Depois que este PR entrar, cada PR de custo aberto tira esses arquivos na próxima junção do main que já precisaria fazer, sem push extra só para isso (regra MV (c)).
>
> Nenhum número, preço, limite, imposto, teto, comissão, trava ou flag muda. Nenhum valor cobrado do cliente, preço do site ou limite depende desses relatórios: o site e a cobrança leem tudo direto do código.

## Como foi aplicada

**1. Os 9 relatórios sem cópia guardada.** Estão em `ON_DEMAND_REPORTS`, em tests/generated-on-demand.ts:
- os cinco que o dono nomeou;
- a saída do solucionador (item 3, abaixo);
- três outros gerados por script, que são "afins" na regra AC (b): docs/pack-cost-decomposition-2026-10-18.md, docs/per-use-resale-2026-10-18.md e docs/feature-videos-cost.md.

Em cada caminho fica só a frase do dono, com o comando do próprio relatório. Nos dois arquivos .json, a frase vai como `{"generatedOnDemand": "..."}`, para o arquivo continuar sendo um JSON válido. Os roteiros só imprimem o relatório e não gravam nada.

**2. Os arquivos guardados.** Continuam guardados os dados de entrada (docs/pricing-optimization-data-2026-10-18.json e docs/per-use-resale-data-2026-10-18.json) e os documentos escritos à mão. Em docs/value-presentation-2026-10-18.md, só o link para a tabela de margem mudou: a âncora dentro do relatório deixou de existir, e o texto agora cita a seção pelo nome.

**3. O solucionador vale pelo primeiro caso.** Conferido antes da mudança:
- ele leva cerca de 10,5 segundos e dá o mesmo resultado a cada execução;
- mas a saída guardada mudou 31 vezes no main em 7 dias, porque a entrada muda com quase todo PR de custo, então guardá-la manteria o conflito.

Por isso a saída também é gerada na hora. O job de testes (product-checks, behavior-regressions) instala numpy e scipy nas versões exatas de scripts/requirements-solver.txt, num ambiente Python próprio, e `MILP_PYTHON` aponta para ele.

**4. Nenhuma conferência saiu.** Os testes que comparavam o arquivo com o roteiro passam a conferir que o caminho guarda só o texto fixo. As demais conferências de número leem a saída gerada na hora:
- tetos, margens e o pior mês de cada plano;
- toda solução mantendo os 60% e igual à busca exaustiva;
- os avisos de histórico;
- as fontes citadas.

O teste novo, tests/generated-on-demand.test.ts, reprova quatro situações:
- um caminho que volte a guardar uma cópia;
- um roteiro que volte a gravar arquivo;
- um comando que não imprima o relatório;
- o job de testes sem o solucionador.

**5. O resumo no CI não foi feito.** O push no main não repete os testes já aprovados na fila (regra MV (a)), então publicar o resumo exigiria um passo novo, que gastaria minutos de Actions a cada entrada só para isso. Quem quiser ler um relatório roda o comando do próprio caminho.

**6. Os números mostrados ao dono** saem do comando do relatório, rodado sobre o main atual.

**7. O AGENTS.md.** Mudaram só a frase da seção "One receiving model for every unit" e as regras AC (b) e (d).

**8. Os PRs de custo abertos.** Na próxima junção do main, cada um fica com o texto fixo do main nesses caminhos.
- **Conferido antes do envio:** dos 75 PRs abertos que tocam esses arquivos, 72 já estavam em conflito com o main, e nenhum passa a conflitar por causa desta mudança.

**Fora do escopo:** docs/accessibility-inventory.json, que não é relatório de preço ou margem. Ele continua como está, salvo nova decisão do dono.
