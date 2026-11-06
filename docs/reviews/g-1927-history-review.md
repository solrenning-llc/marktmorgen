# Codex G — revisão independente adicional #1927

Head EXATO e4f446e6094e52e0f06318401881fa7ea589355a. Anúncio canal65d15f76869f44ca784fb6bf16c400852115e48d antes da leitura/testes. Li TODO diff próprio do PR contra basee84cc9d035b35e3b7beec25b5172a338ccdb22dc:18arquivos,804adições/33remoções, inclusive rota/permissões, UI/textos, regras, famílias, CAS/MemoryRedis e testes. Li também o corretivo próprio1743533e12f7677477201b03bf0eb92e483873da..e4f nos módulos/history-tests. As307mudanças herdadas de main nesse intervalo não são apresentadas como revisão de autoria própria desse PR.

## Resultado

A recontagem obsoleta do G2 está corrigida no caminho exercitado, mas há **1 MÉDIO residual de retenção, com dois vetores**. Esta é revisão adicional G, não substitui G2, Revisor2 ou cruzado fixoCX72.

**MÉDIO — histórico de workflow removido fica órfão e a limpeza completa deixa de encontrá-lo.** lib/flows.ts:420-422,456,524-527 e lib/flow-versions.ts:91-102,154-161. Dois casos reais em MemoryRedis, sem falsificar registros/retornos de sucesso:

1. Escrita atrasada depois da remoção. saveFlow confirma a mudança das definições e para antes de LRANGE no histórico. Uma segunda chamada REAL removeFlow termina, depois forgetStoreWorkflows termina; histórico ausente confirmado. A primeira retoma keepFlowVersion, que não verifica que o workflow ainda existe nem uma marca de removido: cria nl:wf:ver:<list>:<id> após a exclusão. Definições ficam vazias. Nova execução saudável de forgetStoreWorkflows lê só as definições vazias e deixa a versão antiga retida. Prova **tests/g1927-history-after-removal.proof.ts@f1f3150895c50de67655fcb69253a4ddd8b4315a**:7verificações/2falhas no atual e no1743; controle sem interleaving7/7. Saída atual saved=true,removed=true,forgotten=true,deletedBeforeResume=0,definitions=[],history=[Original subject],afterSecondForget=1,charged=400. Não há retorno Redis forjado nesse vetor, apenas pausa por barreira de evento e chamadas reais.

2. Exclusão desconhecida aceita pelo chamador. Com uma versão realmente guardada, interceptar somente DROP_FLOW_VERSIONS, sem aplicar e devolvendo[], faz o helper lançar corretamente. Porém removeFlow:456 engole a exceção e termina ok; já retirou a definição. forgetStoreWorkflows posterior não alcança a lista, que permanece. Prova **tests/g1927-history-unknown-removal.proof.ts@f5a6b63f0c333c63978f95894bc95d06fb405fac**:5/2falhas no atual e no1743, controle saudável5/5. No1743 a mesma prova reconhece o DEL antigo, no atual o EVAL novo: estímulo transportável identificado; ambas asserções/dados iguais. Nenhuma aplicação parcial é confundida com ACK perdido após aplicação.

São vetores herdados dentro da versão anterior deste PR, não regressão nova do último corretivo. O fix sequencial de forgetStoreWorkflows agora apaga versões dos workflows ainda listados (confirmado pelos testes canônicos); isso não fecha a retenção sob estes dois casos. Crédito do problema de limpeza de histórico anterior permanece do Revisor2. Não alego que este dado seja de uma terceira pessoa nem certifico apagamento global da loja: a prova exercita os helpers reais de workflow e a retenção do conteúdo do criador. Precisa de confirmação/descoberta durável e coordenação entre exclusão e escrita para a limpeza alcançar o histórico, sem depender apenas das definições removidas. Não implementei solução.

## Recontagem e RED anterior, sem esconder controle não atingido

Prova G2 original718223e4524f743cdbc4080612a2472293331fd2, blob **bd9e3691d40c0477afa528e38771b3c409ceebb5**, preservada em tests/g1927-original-room-race.proof.ts@06902a8c7536650848cacd844a369bb34ef6ecca. Byte-identidade conferida por git hash-object antes dos ensaios finais.

-1743original:2testes/1passa/1falha causal;3entradas,charged1104<required2240.
- Atualoriginal:2testes/1passa/1falha de instrumentação phase1!=2, porque LRANGE de recontagem deixou de ocorrer; asserção de sala desse segundo teste NÃO é alcançada. Não declaro originalGREEN.
- A cópia identificada permanente flow-history-refused-third-push-evidence coloca a terceira gravação logo após a resposta do EVAL recusado, preservando as3+6chamadas assert dos dois testes originais (AST, desconsiderando só whitespace, conferida). Atual3/3,charged2240=required2240. No1743 a mesma permanente3testes/2passam/1falha no teste novo que exige nenhuma leitura da lista após recusa. Esse teste distingue o antigo LRANGE. Adaptação explícita, não byte-id da prova congelada.
- Permanente flow-history-room-evidence:2/2,charged2240; flow-versions-evidence:6/6, inclusive leitura503, sala conservada sob DEL desconhecido, restauração sem room recusada e pausa concorrente preservada. flow-versions:20/20, inclusive remoção e limpeza sequenciais normais.

## Verificações relacionadas

18entradas adicionais flow-stop-ses-network,closing-families,flow-books-call,flow-stop-action,flow-rotate-action,closing-cost,flow-mutation-reads,flow-halves,flow-actions,flow-conditions,flow-list,flow-review,flow-next-action,plan-cost-registry,flow-people,store-data-registry,locked-deletes,flow-stats:525verificaçõescustomizadas+42testesnode,0fail/skip. Somando os4canônicos focais acima:545custom+53node aprovados. Não somar provas falhas a esses números nem afirmar que o registro estático prova retenção real.

- tsc --noEmit -p tsconfig.g1927.json@7a26c52670fab46f442db3569e143c3d55734c69:exit0, incluindo módulos,rota,UIcanônica,teste de recontagem e a primeira prova nova. A segunda prova não foi incluída nesse recorte; não alego tipo global.
- ESLint lib/flow-versions.ts lib/flows.ts lib/flow-list.ts components/workflow-versions.tsx app/api/store/mail/route.ts tests/flow-history-refused-third-push-evidence.test.ts:exit0,nenhum diagnóstico.
- git diff --check e84cc9d03 HEAD:exit0.

Comandos: node tests/g-proof-run.mjs g1927-history-after-removal.proof.ts e node tests/g-proof-run.mjs g1927-history-unknown-removal.proof.ts; controles com G_ERASE_RACE=control. Runner próprio2ddbd4c99d98d369b73a62d41b3137375928254c usa os aliases de teste do próprio head. Stand-in Redis e escritores reais; nenhum envio, conta, pagamento, browser, Redisnativo ou serviço externo. O ensaio Redisnativo de G2 no passado é do G2; não executei nem reivindico esse ensaio. SemCIglobal/build/certificaçãoAAA/margemglobal.

Saídas completas **docs/reviews/g-1927-history-output.txt@0eaf778bbc8a80289b21f7e4dfde44da8b8e9850**. Ramo **codex/g-review-1927-history-retention**, evidências apenas. Nenhum produto/reserva/ref/base/CI alheio ou merge alterado. C4 única coordenadora,C1 desligado.
