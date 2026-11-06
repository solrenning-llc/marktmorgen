# Revisão Codex G de #2721 — retorno integrado do MÉDIO de release

Head EXATO: ae2f4e9c1d1c1c0f6ea5a6003104bc2937211095; base b769d0b052063e581c2148d14a868a963cafd96b, com #2806 já incorporado. Pedido nominal C5 de11h19; anúncio ANTES do diff/testes no canal c6062d648aa1aff2f0fd7bc819a731cb84cda199. Metadados e reviews frescos: só meu parecer antigo5799137499, não dois pareceres limpos nesse head. Li TODO diff atual9arquivos391+/30-, inclusive330linhas do canônico, e os helpers reais claim-mark/redis-lock/repliesFor usados. Comparei os9blobs próprios com a1d9267a: TODOS BYTE-ID; a correção veio da base integrada, não de uma troca escondida nos cron.

## Parecer: sem achado no retorno focal; MÉDIO5799137499 FECHADO

O releaseLock atual usa somente o compare-delete atômico. Se EVAL falha, deixa a trava expirar e não envia GET/DEL separado. A execução antiga não apaga a trava da sucessora. hold/set/delete de escrita protegida também confirmam exatamente o recibo e não usam fallback inseguro. Os blobs de redis-lock, redis-reply e claim-mark são BYTE-ID aos do #2806/bc9d2ade já revisados por G, mas repeti os casos no head REAL integrado, não só numa união simulada:

- lib/redis-lock.ts 6fc20f13985628a973997f9e4ccbc7831c4db12f;
- lib/redis-reply.ts 46519ad14e82a3e0f446a6a17fb236a2f552b686;
- lib/claim-mark.ts 23e3a4c4d1f8a3e77a824ed2b04186afeb03dd23.

### Prova anterior congelada versus prova que atinge a nova fronteira

As provas antigas permanecem com os MESMOS bytes: rota original f9f2a842 e shared dee62e98 (cópias duráveis neste ramo cb4aa969/efd0f8f2). No ae2 a original dá93checks/8falhas e shared15/8. Isso NÃO prova perda de trava: o GET do fallback não acontece; ownRead/got ficam null, a sucessora nunca é criada pelo instrumento, e a trava observada é a original ainda viva. Em ambas EVAL foi efetivamente tentado. Não chamo isso de GREEN, nem de regressão financeira ou nova falha de exclusão mútua.

Usei a adaptação IDENTIFICADA já preservada201266e7, agora tests/g2806-release-route-control.proof.ts@611d45b70cd0ae4f2c0cdbbb20901642a712c113. Ela mantém as mesmas25 chamadas estáticas is da original e os mesmos93 checks em execução; muda só o estímulo: quando não há GET de fallback, observa a trava ao terminar a rota, avança o relógio além do TTL realmente adquirido e faz a sucessora ganhar SET NX EX300 REAL. As quatro GET de produção (courses/reminders/discord/quiet), claimMark/releaseMark e MemoryRedis são REAIS; só a liberação EVAL falha antes de aplicar. Nenhuma substituição direta de token/estado por uma suposta sucessora.

**RED reproduzido no pai a1d9267a:93checks/4falhas**, uma por rota, trava da sucessora apagada e GET final null. **MESMOS bytes no ae2:93/93**; os quatro EVAL falham uma vez, sucessora realmente vence NX depois da expiração e o token permanece. Esse é o fechamento causal; não usei a prova congelada com fronteira extinta como falso GREEN.

## Adversariais e testes ligados

- Canônico L10a81/81: claims desconhecidos NÃO aplicados não executam trabalho nem e-mail/chat; claims aplicados com resposta perdida são reconhecidos só pelo próprio token; busy é preservado; encerramento não apaga outra execução.
- lock-receipt-exact39/39 e lock-release-atomic31/31.
- Mesma prova a586f20d de descriptor/getter com Object.prototype.value:6/6, getter não chamado, próxima trava e registro intactos. Cópia própria acd02131.
- Mesma prova de envelopes do script:18/18, cópia e5d0ecf6. Não aceitou recibo desconhecido como hold/write/delete confirmado.
-17 arquivos relacionados invocados e concluídos:436 checks customizados+31 testes node aprovados,0falha/skip. Incluem claim-mark, quatro L6, checkout-trouble-read-cost, checkup, cobertura de metas/números, plan-break-off-cron, plan-cost-registry, quiet-coverage, recent-sales, store-alerts, store-data-registry e discord. Primeira lista usou nomes L6 inexistentes e abortou o runner; a lista foi corrigida e executada inteira em related-valid, sem esconder falha de produto.
- Com os3 canônicos focais (81+39+31),20arquivos:587 checks custom+31node PASS. Mais117 checks próprios adaptados/adversariais (93+6+18) PASS, separados para não multiplicar independência. Provas congeladas93/8 e15/8 instrumentais ficam fora de qualquer total verde.
- tsc -p tsconfig.g2721-ae2.json:exit0,17raízes/imports, recorte estrito, não global. eslint15paths:exit0/0avisos. git diff --check0. Produto rastreado intocado; só próprias provas/config na cópia destacada /tmp/g2721-return-ae2.

Nota documental herdada fora do diff: comentário de releaseMark ainda menciona “read and deleted in two steps where scripts are not run”. O corpo chamado já NÃO faz isso; li a implementação real e os testes confirmam a ausência de fallback. É uma descrição antiga na base, não comportamento usado para liberar o MÉDIO. Não atribuo à nova integração um fallback que não existe.

## Evidência e limites

Ramo próprio codex/g-review-2721-integrated-return; saídas docs/reviews/g-2721-ae2-output.txt@f10845696feb82ab6a70fcc5f39c7d98cd0ce42a. Config6c5a5f5790ed3c6c259a11eb6a1131beb80644a4. Runner já existia BYTE-ID (blob66355877ed278b87614bf2593ec3ddcf087d1821); não sobrescrevi após tentativa de criação422. Provas antigas preservadas também no ramo histórico; adaptação e originais ambas legíveis.

Não rodei Redis/Lua nativo, provedor, conta/pagamento real, browser/AT, build/CI global, nem verifiquei todos os trabalhos herdados do main incorporado. Não afirmo que release isolado impede toda pausa/expiração possível do trabalho: o parecer fecha especificamente a destruição da trava sucessora pelo fallback e o diff de claims do PR. Sem preço/limite/flag/trava produtiva alterados pelo G, sem reserva, ref/CI alheio ou merge. C4 única coordenação/C1 desligado. Revisão independente adicional, sem substituir revisor fixo CX72 sem ordem.
