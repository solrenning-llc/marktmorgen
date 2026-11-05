# Revisão independente Codex G — #2697
Head EXATO 28fed93939f4905e5653a8c86b755c39ab2c53e8. Segunda revisão financeira pedida C4-19h33; Revisor1 é primeiro. Base de comparação REAL:695c095be524779c2295f226d2e949cb845a720c, não o main avançado d7bbf9d. Todo o diff de18 caminhos,1036 inserções/93remoções, foi lido.

## MÉDIO novo — snapshot de consentimento/teto fica velho durante a leitura externa
Arquivo lib/outreach.ts:262–277 e :291–312. startPitch passou a ler stop local/global, pitches e contador do dia ANTES de aguardar robots/página. Quando o domínio final é o mesmo, não há nova leitura e pitchProblem recebe esse snapshot antigo.

Prova independente opt-in tests/g-2697-outreach-snapshot.proof.ts, blob b32c83bcc69978cf65b8cda2a6de35ff531fb64a: MESMO arquivo13/13 no código anterior695c095b ->13verificações/6falhas no28fed939. Quatro controles estáveis continuam verdes (permitido/stop local/stopglobal/teto já presente), e três asserções confirmam o interleaving aplicado.
1. Reader sintético de PAGE escreve SADD stop local e depois devolve HTML legítimo no MESMO domínio. Antes retorna stopped, zero chamadas ao modelo e dia14. Head retorna written, chama modelo uma vez e dia15.
2. SADD no stop global durante o mesmo reader: o mesmo resultado indevido.
3. Dia começa14; reader aplica INCR para15, simulando outra operação enquanto a página está em voo. Antes retorna day e não chama modelo; head escreve o16º rascunho e chama o modelo.

São comandos reais do MemoryRedis entre awaits do startPitch real, não respostas malformadas forjadas. Só o leitor externo e a resposta do modelo são sintéticos. O efeito observado é rascunho criado+invocação do modelo, NÃO e-mail enviado/contato efetivo nem prejuízo financeiro calculado. A regressão elimina a oportunidade que o código anterior tinha de ver a atualização confirmada ao terminar a leitura. Não alego que o código anterior fosse atomicamente seguro para TODAS as corridas possíveis.
Preservar a pré-checagem antes da reserva paga, mas não usar seu snapshot como decisão definitiva depois de uma leitura externa que pode demorar; a decisão antes do modelo precisa respeitar os bloqueios/teto atuais, com custeio das verificações necessárias. Nenhum preço, valor de limite, flag ou trava deve mudar.

## Parecer anterior e limites
O LEVE de créditos confirmados não devolvidos do Revisor1 é anterior e não o conto como achado novo meu; não o fecho por silêncio. Seu MÉDIO em watch.ts é do L8/#2699 empilhado, que não faz parte deste headL1. lib/redis-reply.ts permanece a versão antiga neste head, e seu corretivo#2672 tem controladorS: não atribuo aprovação nova ao helper comum ou ao PR empilhado.
Não liberado por causa do MÉDIO acima; exige retorno no head corrigido, duas revisões financeiras e os nove checks exatos. Nenhuma alteração a produto, reserva, ramo ou CI do autor, nenhum merge.

## Execução
- Sete novos do autor no head:95+42+40+43+26+7+20=273/273.
- RED com os MESMOS arquivos finais/test-aliases na merge-base real: counts95/50falhas; outreach42/35; delivery-watch43/38; serve-file26/16; outreach-order7/6; usage-cron20/6. O novo redis-count não compila no anterior porque o módulo não existe (não conto como teste verde). Estes números são minhas execuções, sem substituir por números declarados do autor em outro RED intermediário.
- 28 ligados:1154 verificações/testes reportados, todos verdes. Arquivos:blob-download-attachment,closing-cost,closing-families,closing-plan-guard,closing-plan-routes,closing-refunds-unknown,delivery-check-rules,delivery-faq,delivery-watch,file-download-refusals,order-data,outreach-faq,outreach,plan-closing-news,plan-closing,plan-cost-registry,plan-margin,store-closing-fair,store-data-registry,store-data,stream-measurement,stream,traffic-admission,traffic,usage-meter,vault-upload,vault,watch.
- ESLint de18 caminhos e prova/runner:zero. Scanner público3807 rastreados/zero; git diff --check zero.
- Comando:node tests/g-2697-run.mjs g-2697-outreach-snapshot.proof.ts. Launcher usa mkdtemp distinto por execução, evitando colisões.
- TSC global ainda em execução na gravação inicial deste relatório; resultado será registrado separadamente, sem alegar aprovação antecipada.
- Sem Redis nativo, browser, fornecedor real, pagamento ou CI do autor.