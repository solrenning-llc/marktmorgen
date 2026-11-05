# Revisão Codex G — #1856, retorno
Head EXATO347e3d9a01a36f34dc31550b1e8a6ebf115366ae. Anúncio d8d96445 antes da leitura. Diff inteiro próprio de sete caminhos desde6b02cc4e82a6dac8b43dcdc4cec7244ac3fd302b (commits2d7c4cd0/347e3d9a) lido; preservada minha revisão integral anterior. Pai#1821 continua com seus achados separados. Nenhuma alteração a produto/reserva/ramo/CI do autor ou merge.

## Fechamentos
A corrida comum de confirmação/undo que sobrescrevia edição concorrente está FECHADA: WRITE_ABOUT_IF compara o texto antes do efeito. MESMO teste final agent-confirm-cas-evidence: RED7/5falhas -> head7/7.
A leitura desconhecida do livro que virava vazio e o falso sucesso de addProposal com SET não confirmado também fecham nos casos conferidos: MESMO agent-book-envelope-evidence RED9/7 ->9/9. Não confundir esses fechamentos com a durabilidade do efeito/histórico abaixo.

## MÉDIO residual M2 — efeito já aplicado, mas gravação do histórico falha
lib/agent-book.ts:122–128, :196–203 e :223–227.
Pela confirmação REAL do produto: somente SET nl:agent:book:<statsId> é recusado antes de aplicar (exceção ou reply[]). Texto muda para Agent; método falha; livro permanece waiting1/history0. Pelo undo REAL, texto é restaurado, mas erro no SET deixa a entrada sem undone. O novo ACK exato apenas sinaliza a falha; não dá uma prova durável/reconciliação do efeito que já ocorreu. Controle importante: SET APLICADO e depois reply[] mantém history1; não classifico todo ACK perdido como perda de histórico.

## MÉDIO residual M3 — autoridade de execução/escrita do livro não é confirmada
lib/agent-book.ts:118–119 e :122–128.
Reprodução de expiração agora com DOIS PRODUTOS REAIS, não callback de tipo execute fictício: primeira confirmação aplica A e para antes do SET final; avanço determinístico de61s no relógio Redis; segunda confirmação aplica B e confirma historyB; primeira volta e grava o livro antigo, apagando historyB e recolocando B em waiting. Os textos de A/B realmente ficaram aplicados. Não alego envio ou pagamento duplicado.
Outro vetor da mesma autoridade: uma trava de outro titular já existe; a tentativa SET NX é substituída por resposta[] sem aplicação. held fica undefined, que não énull, e confirmFor muda o produto apesar de outro token continuar dono. Controle nativo[null] recusa. Só o OK exato pode conferir posse; a escrita tardia também precisa preservar a execução/livro sucessores.

Essas duas famílias estão na prova opt-in tests/g-1856-book-effects.proof.ts, blob5d875afeaccf66419cac8af9e19f58b6b56f7f66: MESMA20verificações/6falhas tanto no anterior6b02 quanto no head,14controles/alcances verdes. São resíduos das duas famílias anteriores, não seis achados. A reprodução antiga de callback genérico não é usada aqui como prova de envio atual; o produto corrente é a descrição.

## MÉDIO MR adicional — rollback da reserva solta o espaço do texto de outro escritor
lib/product-about.ts:95–107 (especialmente107).
ConfirmFor REAL admite crescimento do texto. Entre essa admissão e o EVAL, o escritor REAL do estúdio salva outra descrição, definindo a vaga ab:<produto> no tamanho dela. O CAS corretamente devolve changed e preserva os674caracteres do criador; giveData(grown) subsequente desconta uma reserva que aquele escritor já substituiu. Resultado observado: vaga0, mas dataBytes do texto REAL=816. A descrição permanece guardada sem sua contagem de sala; é teto/contabilidade, sem USD ou lucro calculado.
Prova tests/g-1856-about-room.proof.ts, blobcbdea572bb2290c43e0f3981a7ef2fabb3dc3ff2, MESMO arquivo: anterior3/2falhas (texto do criador era sobrescrito e sala816 para texto que exigia3280); head3/1falha (texto preservado, mas sala0 em vez de816). A classe de contabilidade é herdada da concorrência de escritores; o rollback introduzido no helper novo continua sem propriedade da reserva. Não atribuo um vetor remoto, não proponho aumentar limite nem afrouxar teste.
A primeira tentativa LOCAL desta prova usou store anterior à marca about e não alcançou a injeção. Foi descartada; a fixture final relê a loja como a rota real faz, confirma injected1 e é idêntica em ambos os códigos. Nenhuma asserção foi relaxada.

## Execução e limites
- Autor:9/9+7/7 no head; mesmos arquivos finais no anterior9/7+7/5.
- Duas provas adicionais:20/6falhas+3/1falha no head; controles descritos acima, sem substituir falhas por resultados positivos.
- 23grupos relacionados382verdes: agent-book13,agent-confirm24,coverage13,keys23,rules37,propose10,agentic-catalog3,feed3,data-recount13,llms17,mcp-channel29,course10,dispatch26,oauth42,page-test10,page12,versions8,read18,saved7,tools5,plan-cost19,store-data-registry7,store-data33.
- Tipos strict do recorte/imports/duas provas:exit0; ESLint0; scanner3266rastreados/0; diff0.
- Runners com mkdtemp individual. MemoryRedis real do teste, transporte sintético e bloqueios por Promise; nenhum sleep, fornecedor, Redis nativo, browser, hostedCI, build global ou certificação de margem completa.
Não liberado. Corrigir no ramo do autor, preservar estes REDs, retornar com head exato e os gates de revisão/CI aplicáveis. Pai#1821 não fica liberado por um corretivo desta camada.
