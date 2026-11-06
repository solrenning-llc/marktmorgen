# Codex G — retorno independente de #2826/e194

**Head exatoe1940a15219ec3d0efbeccc95f0de4f2ca452f31: MÉDIO5805110853 fechado para os casos demonstrados; um LEVE residual de contrato para descendente que cria grupo próprio.** Não é certificação de toda árvore arbitrária ou de Windows/macOS.

## Leitura e proveniência

Retorno nominalC5/15h43. AnúncioG antes do código/testes: canal **33e6d7676b3ab774ca3691886f1135fb0ae219ff**, depois de publicar o fechamento do #1963/163. Li TODOdelta b418..e194: **2arquivos138+/11-**, runner e seus testes; tests/run.mjs permanece igual. Li também o patch efetivo contra main, preservando o escopo revisado em b418. As mudanças de diagnóstico têm anotação da regra23 e as duas provas novas permanentes mantêm crédito às provasG. Instruções no main18f7f897 foram conferidas: os quatro blobs continuam idênticos às leituras integrais anteriores.

Cada worker agora nasce em grupo próprio POSIX; o fim/timeout/sinais varrem esse grupo. O fallback Windows usa taskkill/T/F; não o executei.600s, medida anterior dos logs, serialização, compilação com limite e diagnóstico são preservados. A prova do diagnóstico agora usa o que o ambiente realmente mostrou de /proc; onde o PID não tem entrada acessível, exige o fallback proc=unreadable, não aceita qualquer texto.

## MÉDIO anterior fechado nas provas

- Prova original285f70bb, SHAa09a97f5ff501d63ba1b538f744470d470057ded769edf2940bc5d08e2624de5, **INALTERADA**: b4186verificações/1falha→e1946/6. Worker e descendente ordinário somem por signal0 neste ambiente; diagnose que lança e próximo teste saudável continuam corretos.
- Prova original43c69845, SHA0a12a598f59fb206aff313c9b75590c2ed3d7e8254f646e22421ace1b9609488, preservada: no novohead, as três primeiras assertivas passam, o descendente já morreu e close já chegou. Depois ela tenta matar incondicionalmente esse PID e lança ESRCH **na limpeza do harness**, antes da quarta assertiva. Não anuncio4/4 para esse arquivo congelado.
- [Variante identificadaf9fb5172](https://github.com/solrenning-llc/marktmorgen/blob/f9fb51727d96ca0fa64a7dfae10c5805237de0b9/tests/g2826-output-idempotent.proof.mjs), SHA2e14867c67aeebd9945d7109572b8b244f90c990270382ca5cf5cadfea76a643: só tolera ESRCH nessa limpeza própria; **todas as4expressões is originais textualmente exatas por AST**, nenhum valor esperado/caso removido. MESMOSbytes no b418 **4/2falhas→e1944/4**. O rótulo legado da última assertiva diz “killing... releases close”; noheadcorrigido a saída já fechou antes e a limpeza é um no-op.
- Arquivo final13testes do autor BYTE-ID, copiado para o b418 completo como prova própria: **13/2falhas→e19413/13**. As duas causais anteriores fecham. Não usei a alteração de /proc para mascarar as provas de processos/saída.
- Na prova de ciclo de vida abaixo, os **9checks dos três casos ordinários** (término normal, SIGINT e SIGTERM do executor) passam no e194, preservando os respectivos códigos/sinais e liberando os pipes/descendentes. No b418 esses três casos tinham seis falhas. Processos reais e barreira IPC ready; sem mock de spawn/kill/stdio.

A advertência do autor sobre zumbis é válida em geral: signal0 pode responder para estadoZ, que não executa nem segura saída. Não tive de inferir isso aqui: nas provas finais ordinárias signal0 fica indisponível, e close é observado. Em toda a análise, /proc inacessível não foi usado como confirmação de ausência.

## LEVE residual — “whole process tree” é mais amplo que o grupo protegido

**tests/test-runner.mjs:91–99**, especialmente98. endTree mata o grupo cujo PGID é o PID do worker. Um descendente que chama fork/spawn com **detached:true** cria outro grupo e não recebe esse sinal. O mesmo ocorre se o worker termina normalmente: a limpeza do grupo anterior não o alcança.

[Prova própria24dd1a6c](https://github.com/solrenning-llc/marktmorgen/blob/24dd1a6c5aa8c1c439507855422b304fa303454b/tests/g2826-group-lifecycle.proof.mjs), SHA6fd42748b79b01b12c9a2387b8f7837e107ce4e4500f846d790a44ac6b3f7ef5:
- cinco casos: normal ordinário, SIGINT, SIGTERM, descendente detached com timeout e descendente detached com término normal;
- supervisor/worker/fork reais; mensagem IPC confirma que o descendente iniciou; status/código/sinal do executor é observado; pipes esperados por evento close com guarda;
- **MESMOSbytes b418:15checks/10falhas→e19415/4falhas**. Os4remanescentes são só os dois detached: filho vivo e saída ainda aberta depois de o executor terminar. Os cinco controles de status e os novechecks ordinários do novohead passam (os controles de status estão contidos nesses15, sem somar cobertura dupla).
- a guarda de presença após o sinal permite o encerramento assíncrono ser observado; a exploração preliminar que olhava signal0 imediatamente em SIGTERM foi descartada como janela de observação, não virou achado;
- cada finally mata APENAS PIDs lidos dos próprios arquivos e observa todos present:false. Nenhum processo persistente ou grupo alheio.

**Grau LEVE/contrato latente**, não o MÉDIO ordinário anterior: inventário de tests/scripts não achou testes canônicos *.test.ts criando esse descendente destacado. As duas ocorrências existentes de detached:true são tests/e2e/run.mjs:231 e agreements.mjs:155, executores independentes fora deste runBundle; não afirmo que eles sejam afetados por este patch nem que o verify atual use esses caminhos. A prova demonstra o limite do helper e da promessa de “whole process tree”, sem inventar impacto produtivo.

Delimitar explicitamente o contrato aos processos do grupo próprio, ou tratar/testar descendentes destacados caso a exigência seja toda a árvore. Não é um pedido para mudar prazo, cobertura, preço, flag ou gate de produto. Não implementei solução. O PR não deve prometer que encerra qualquer descendente arbitrário ou todas as plataformas a partir destas provas POSIX.

## Ligados e limites

Backup-run96/96 e backup-store32/32, **128/128**, agora executados pelo **runTestFiles/runBundle REAIS do novohead**, com os aliases/environment do repositório e os mesmos600s/diagnóstico. [Driver7e43e3cb](https://github.com/solrenning-llc/marktmorgen/blob/7e43e3cb2f15fcfdc063e316a8faf19ce533eda0/tests/g2826-linked-through-runner.mjs) retornou failed0; sem linha TIMEOUT de verdade nesses ligados.

Tipos focais1raiz/imports exit0; lint5caminhos0erros/avisos; scanner4068rastreados0+4próprios novos0; diff-check b418..e1940. Códigos e provas foram executados em Node24.22.1/Linux local; não executei Windows/taskkill ou macOS, build/CI inteiro ou a causa do travamento original de backup. As medidas de600s já foram reconferidas em b418; não repeti downloads ou inventei custo zero.

[Saídas7daf82be](https://github.com/solrenning-llc/marktmorgen/blob/7daf82bed7b497380bc4f66150665358c1848488/docs/reviews/g-2826-e194-output.txt),24764caracteres, incluem provas congeladas com o erro de limpeza, variante, ciclo de vida/RED13, ligados e qualidade. Cópias próprias /tmp/g2826-return-e194 e /tmp/g2826-review-b418; branch codex/g-review-2826-return-e194 BASEe194real; rastreados limpos, sete arquivos próprios não rastreados já preservados/remontáveis.

C4 única/C1OFF. Nenhum produto, reserva, ref/CI alheio ou merge, conta, fornecedor, pagamento ou contato externo. Parecer adicional não substitui cruzado fixo por inferência.
