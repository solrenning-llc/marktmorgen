# Revisão Codex G de #2287 — retorno pós-parecer

**Head EXATOa6e3ae8782045bdd78b1a60e47a92c298c81340c: sem novo achado no delta focal pedido pelo autor. LEVE latente6653093313 preservado; lacuna de custo dos passos continua desconhecida.** Não é liberação integral/financeira da pilha, nem fechamento do MED do J no #2048.

## Proveniência e leitura

Claim antes do código/testes:865e1d50efba1dc0a9fac211a0407c0ca792a7ea. Pedido autor6656234879, recorte85d80282..a6. A conferência corrigiu a identificação abreviada do anúncio: a junção de main é **c8d7df8da319b40bd52858c60707fd1a8a02380b**, pais85d80282c8a42ad00d199a6e58f94e3bbcb42727 e main e84cc9d035b35e3b7beec25b5172a338ccdb22dc; **ff82178295510cbe6846cf51894a3da1d2d33a9f regenera7documentos**, não é o commit da junção; **a6 altera só1testePython6+/3-**.

Li o testePython inteiro e seu corretivo completo, a resolução combinada de MemoryRedis e todos os6patches compartilhados que diferem do85d (lib/data-families/person-data/redis-memory e os3registros de custo/dados), em blocos completos de60597caracteres após uma primeira saída truncada. Li os7patches dos documentos gerados. A comparação contra mainpai mostra47caminhos próprios: **33blobs BYTE-ID ao85d**, incluindo crm/flows/buyer-profile, rotas, página, campo, provas de tomada e notas; **14diferentes**, os7documentos,6compartilhados e1teste acima. Preservei o parecer anterior G2 dos33; não afirmo reauditoria integral de todas as centenas de mudanças herdadas de main.

A junção conserva os ramos person-run-note:v1 e mail-report:v1, cada um com seu return1/fechamento próprio. Core crm.ts/flows.ts/buyer-profile.ts é BYTE-ID ao85d. O novo teste de aridade de MemoryRedis e os testes da nota/DR1 passaram no head real, sem remapear seus modelos para uma cópia antiga.

Nos2JSONs regenerados comparei TODA a estrutura/valores: **12coeficientes/base mudaram na entrada,4objetivos na saída; nenhuma chave, tipo, tamanho de lista, preço/opção ou vetor de solução mudou** entre c8d e ff821. Os testes dos renderers/tabelas verificam os7documentos; isso não certifica uma margem financeira real nem resolve custo desconhecido de workflow.

## Correção do teste e RED possível neste ambiente

SAVE_CRM_DEAL v5 responde **{1}** para criação e **{1,tamanho substituído}** para atualização, ou0cheio. O teste nativo anterior devolvia a lista crua de mixed_save para sum(mixed), e comparava os recibos seguintes a1. O atual transforma a criação confirmada em1 e compara atualização/criação aos respectivos arrays. Conferi o Lua literal em lib/crm.ts:687–704 e o fixture ASCII "existing": lenPython7 coincide com a contagem de bytes do Lua naquele caso.

**Redis nativo NÃO executado:** este host não tem redis-server; não abri serviço nem alterei MARKTMORGEN_REDIS_INTEGRATION. Os11PASS nativos relatados pelo autor não são contados como execução minha.

[Prova lógicaPython43bc6418](https://github.com/solrenning-llc/marktmorgen/blob/43bc6418270327c8643b2bfa4ad39200d9763966/scripts/g2287-mixed-receipt.proof.py), SHA256a9b386bb863f12f0d9164cf2791f87585963bc3e86dc4bfd23dfd4ffb366213d: extrai o AST INALTERADO da função nested mixed_save de cada refexato e o executa com cliente sintético que responde os recibos documentados do v5. Nenhum socket/Lua/flag é executado, e não há alegação de que isso seja o teste nativo completo.
- ff821: **3casos/1falha**, vitória manual provoca TypeError: unsupported operand type(s) for +: 'int' and 'list';
- a6: **3/3**, total1 na vitória manual, total1 na vitória do formulário,0na capacidade cheia.
A primeira tentativa do harness procurava a função só no corpo direto do main, mas ela fica dentro de try: StopIteration em ambos, DESCARTADA. A versão final desce pelo AST e reproduz os casos acima sem mudar a função nem as expectativas.

A sintaxe dos2arquivosPython (fixture do autor e prova própria) passou em py_compile, com bytecode fora do fonte. Isso também não equivale a executar Redis nativo.

## LEVE latente conhecido: não promovido de novo a MÉDIO

Prova G2bb297119509af5f3fef695f76121a8c20f1ccd2d INALTERADA ([cópia09a721ea](https://github.com/solrenning-llc/marktmorgen/blob/09a721ea1b619891e4fd6baf1b3e1d37e963b6c3/tests/review-g2-deal-preflight-shrink.test.ts), SHA25622e4922c8c7ec7d58f99e64fc325a50152851a9ba0f6e1cfd06619da25bd313c): noheadREALa6 **3testes/2falhas**, mesmo contrato latente divulgado pelo G2.
- writeDeal(...,"edit") lê tamanho grande; outro writer real encurta para288; primeiro grava480sem nova admissão. Na sala cheia, total223120000→223120192.
- Controle de encurtamento legítimo na sala cheia passa.
São unidades de dados/sala, não prejuízo em dólares demonstrado.

**Inventário atual de TODOS os chamadores app/lib conferido:** app/api/store/crm/route.ts:156 usa writeDealOver para edição existente e:157 writeDeal para nova identidade; lib/flows.ts:1001–1002 usa writeDeal apenas quando before===null e writeDealOver no existente. Não há chamador produtivo do overload "edit". Portanto mantenho o **LEVE/helper**, como a correção6653093313 do G2, sem reapresentar seu antigo MED retirado nem fingir jornada comum afetada. O contrato exportado continua latente; este delta de teste não o resolve.

A lacuna declarada no corpo do PR (16comandos modelados por passo contra23/26observados, e trabalho adicional) **continua sem certificação financeira**. Os verdes de consistência do modelo não a tornam zero nem aprovam ativação/preço/limite/gate. Não alterei esse modelo ou a revisão comercial.

## Verificações do head real

**18canônicos500checks customizados+91Node PASS,0falhas/skip**, todos18exit0: tomada/conclusão/efeito de workflow, selo de página, escrita/conflito/sala/campo CRM, oportunidade de formulário/links, DR1, aridade, registros de custo/dados e os4grupos de documentos gerados. O teste latente3/2 é separado e não foi contado como verde. Manifesto199367cfcdfbf02cf499dac3bac35830acff358a.

TypeScript **10raízes/imports exit0** (config9aca8819); lint5paths0erros/avisos; scanner **3743rastreados/0correções**,5arquivos próprios0. diff-check do teste e do diff próprio contra mainpai ambos0. Rastreados próprios limpos; só prova/runner/config/manifesto untracked.

[Saídas82ce4c60](https://github.com/solrenning-llc/marktmorgen/blob/82ce4c606dab23f91b9f835ec39dc070c91c6d17/docs/reviews/g-2287-a6-output.txt). Cópia própria /tmp/g2287-return-a6, ramo codex/g-review-2287-post-review-delta BASEa6REAL. Mesmo esbuild/testAliases/testEnvironment do fonte, Redis em memória nos testesTypeScript. Sem navegador, Redis/Lua nativo, fornecedor/conta/pagamento/contato externo, build/CI completo ou margemgeralcertificada.

**Resultado limitado:** nenhum novo achado no corretivoPython/regeneração/resolução examinados; LEVE anterior divulgado e lacunaMR separados. Não fecho os pareceres de #2048/#2036, não substituo o cruzado fixoD/CX72 por inferência e não concedo aprovação financeira global. Autor/coordenação conduz os gates aplicáveis, incluindo o teste nativo em ambiente próprio e os novechecks exatos. C4única/C1OFF; nenhum produto/preço/limite/flag/trava/reserva/ref ouCIalheio/merge alterado.
