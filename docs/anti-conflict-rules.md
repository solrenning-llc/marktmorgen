# Regras anticonflito (dono, 15/11/2026)

Pedido do dono (14/11/2026 e 15/11/2026, Fortaleza): "resolva todos os conflitos. procure e resolva todos os conflitos. gere regras para que novos conflitos nao sejam criados" e "faça regras para nao ocorrer mais conflitos".

Valem para todo agente deste repositório (Claudes, Codex e sessões de nuvem), junto da ALL-203 e da ALL-204 do canal. Não mudam nenhum preço, limite, comissão, trava, flag ou proibição de AGENTS.md.

## Por que os conflitos aparecem

Um PR entra em conflito quando o main muda as mesmas linhas que ele muda. Quanto mais tempo um PR fica aberto e quanto mais PRs mexem nos mesmos arquivos (registros de custo e de dados, documentos gerados, reservas, listas), mais conflitos aparecem. As regras abaixo atacam essas três causas: arquivos compartilhados, pilhas de PRs e demora.

## As regras

1. **Vigia de hora em hora, só com git.** Cada agente confere, a cada 60 minutos, todos os próprios PRs abertos contra a base de cada um, sem gastar a API nem o Actions:
   - listar os PRs (`gh api "repos/solrenning-llc/marktmorgen/pulls?state=open&per_page=100&page=N"`, página por página até a última; `--paginate` é bloqueado nas sessões de nuvem);
   - para cada PR: `git fetch origin +pull/N/head:refs/scan/pr-N +BASE:refs/scan/base-N` e `git merge-tree --write-tree refs/scan/base-N refs/scan/pr-N`; saída diferente de 0 é conflito;
   - antes de avisar, buscar de novo o head daquele PR, porque o GitHub atualiza o `mergeable_state` com atraso;
   - conflito achado: a junção começa na mesma hora, sem esperar ninguém pedir.
2. **Arquivos compartilhados fora dos PRs de produto.** PR de produto não mexe em `docs/reservations/*`, `docs/codex-queue.md` nem em arquivo gerado por script. Quando um registro precisa mudar de verdade (por exemplo `tests/plan-cost-registry.ts`, `tests/store-data-registry.ts`, `lib/data-families.ts`), a linha nova entra na posição em ordem alfabética, nunca no fim, e o arquivo gerado é regenerado pelo script na junção, nunca editado à mão.
3. **Registros de custo, um PR por vez.** Se dois PRs abertos mudam o mesmo bloco de `tests/plan-cost-registry.ts`, `lib/receiving-costs.ts` ou das tabelas de margem, os autores combinam no canal quem entra primeiro, e o segundo espera e se ajusta depois.
4. **Pilha de no máximo 1 nível.** Nenhum PR novo é empilhado sobre um PR que já é empilhado. Quando a base de um empilhado entra no main, a base dele vira main na mesma hora (`gh api -X PATCH repos/solrenning-llc/marktmorgen/pulls/N -f base=main`), sem force push.
5. **Antes de cada envio, `git merge-tree` limpo contra a base.** Colisão com outro PR aberto em código de produto vira aviso no canal ("#N colide com #M em <arquivo>"), sem travar; quem entrar depois junta. Gerados e registros nunca travam: quem entra depois regenera ou põe em ordem alfabética. Só pare e pergunte se os dois PRs mudam a mesma função de jeitos opostos.
6. **PRs pequenos e curtos.** Um assunto por PR, de preferência com menos de 400 linhas fora de testes. PR com mais de 48 horas sem revisão é anunciado no canal para ganhar revisor, porque PR parado é o que mais acumula conflito.
7. **Poucos PRs abertos.** No máximo 15 PRs abertos por agente fora da fila de incorporação (ALL-204). Acima disso, trabalho novo fica num ramo sem PR até o número baixar.
8. **Junção sempre com o histórico completo.** Antes de qualquer junção: `test -f .git/shallow && git fetch --unshallow origin`. Um clone raso dá base de junção errada.
9. **Junção certa.** `git merge origin/main` (ou a base, se o PR for empilhado), nunca rebase nem force push; os dois lados mantidos; reservas e gerados com a versão do main; typegen, `tsc` e os testes dos arquivos tocados verdes antes do push; RED→GREEN se a junção quebrou algo. Sem conflito, não se junta o main (TODOS-106): isso só dispara o CI e apaga as aprovações.

Estado: regras documentadas e em uso nas sessões do Claude 4 desde 15/11/2026. Não são verificadas por teste automático; a vigia da regra 1 é o que as mantém.
