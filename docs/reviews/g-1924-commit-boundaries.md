# Revisão Codex G de #1924
Head EXATO: 29bc2d3b5af05ca28bd235f19ad7bbd886f1def3. Retorno nominal pedido no comentário6656938481, anunciado no canal emfeba4524 antes da leitura/testes. Preservada a revisão integral anterior; lido TODO corretivo próprio8f7ff7cf52b14f603d984044b9ad4f96caa52a8a (7caminhos,798+/110-) e conferida integração no head final, incluindo o modelo Lua e a resolução de data-families. O diff PR atual tem21caminhos. A diferença two-dot desde066 inclui338arquivos do main e NÃO é tratada como mudança própria nem certificação geral do sistema.

## Fechamentos anteriores confirmados
A prova ORIGINAL tests/g-1924-return-proof.test.ts continua byte-idêntica ao10b3d9f3f7257991394917bf8945cac4c6c185ca, blob21342c1953dd9f59223b5ed4e061cd23186f10d1.
MESMO arquivo: RED e554290accc5ce820dfc388775cf205f7c64223f10verificações/3falhas -> head10/10. Retirada/remoção confirmada durante expiração da lease não é desfeita; duas aceitações concorrentes dão changed+busy e compromisso70%. Controles de consentimento pela rota real (mesmo segundo, identidade antiga/atual) continuam passando.
MESMO permanente partner-share-commit, blob210de414d6ed81d00c2c2fb6dbabea8746062595: RED26verificações/21falhas, com subcasos de Lua ausentes no código anterior -> head33/33. A contagem aumenta porque sete subcasos só executam quando PUT_AFFILIATE existe; não são33verificações anteriores. Não contei módulo inexistente como aprovação.
Esses fechamentos não são autorização de merge: os dois MÉDIOS abaixo permanecem.

## MÉDIO 1 — leitura desconhecida vira zero compromissos e passa o teto
lib/affiliates.ts:763–777 (pairs/listAffiliates), :622–632 (sharePromiseProblem), :900–905 (novo commit).
Prova opt-in tests/g-1924-unknown-commitments.proof.ts usa a ROTA autenticada REAL partner-answer, com identidade atual, guardas/session/cookie reais sobre Redis sintético. Só a resposta de HGETALL people é substituída: hash null, envelope ausente, par final sem valor, ou envelope extra. Antes: p10%, q40%, comissão20%; proposta de p40% deveria ser recusada. Tanto a checagem da rota quanto a nova checagem no commit transformam a leitura ilegível em nenhum outro parceiro, EVAL aceita, e a rota devolve303 partner-yes. Após restaurar a leitura íntegra, compromisso efetivo=100%, acima do teto EXISTENTE90%.
Mesma prova14verificações/8falhas no anteriore554 e no head; seis controles/alcances passam. É lacuna HERDADA de leitura agora reutilizada pelo commit, não regressão atribuída ao CAS nem quatro achados diferentes. Rejeitar a observação desconhecida antes de decidir/efetivar, preservando vazio confirmado; não inventar soma zero. Sem saída real de dinheiro ou cálculo USD demonstrados.

## MÉDIO 2 — commit aplicado com ACK desconhecido apaga os índices do próprio registro
lib/affiliates.ts:830–850 (putAffiliate), :889–907 (retry), :1324–1338 e :1178–1187 (letGoClaims).
Prova opt-in tests/g-1924-applied-invite.proof.ts chama acceptPartnership/openAffiliateLink REAIS. O EVAL é realmente aplicado no MemoryRedis e só então devolve[] ou[null]. putAffiliate entende false; a repetição encontra o registro já salvo e devolve there; openAffiliateLink o trata como nunca escrito e letGoClaims apaga tanto emails[email] quanto codes[code]. Resultado expired, pessoa continua approved no hash, os dois índices viramnull.
MESMA prova12/12 no anteriore554 ->12verificações/4falhas no head; controle sem falha e confirmação de uma única injeção passam. Para comparação causal, o teste intercepta a escrita equivalente: HSET anterior ou EVAL novo, SEM mudar o efeito da escrita. É ACK ilegível RESOLVIDO após aplicação; não generalizo o caso a todo erro de transporte que lança. Uma escrita não confirmada não pode ser tratada como ausência confirmada nem apagar referências de algo já aplicado. Preservar evidência e reconhecer o próprio registro aplicado antes de liberar os índices. Não provei exploração, pagamento duplicado ou envio real.

## Verificações executadas
- Prova G original10/10 e permanente33/33 no head, REDs reproduzidos acima.
- 51grupos relacionados,1570 verificações/testes reportados, verdes: todos affiliate/partner/share relevantes, locked-deletes, data-recount, redis, store-data/cost registries e accessibility-statement/public-reads-ceiling. Lista e saídas completas anexas.
- Tipos STRICT do recorte+imports+duas provas novas+prova original: tsc -p tsconfig.g1924-review.json, exit0. Global/build/navegador não certificados.
- ESLint do corretivo/provas/runner: exit0. Scanner público:3767 arquivos rastreados/zero correções. git diff --check:zero.
- Runner usa mkdtemp por execução. Nenhum Redis nativo disponível; Lua conferido por leitura e modelo em memória, NÃO por Redis real. Nenhum fornecedor, conta, pagamento, preço, limite, comissão, flag, trava, reserva, ramo/CI de autor ou merge alterado.
