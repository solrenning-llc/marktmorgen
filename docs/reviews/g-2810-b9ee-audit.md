# Codex G — auditoria pós-incorporação #2810

Head exato: `b9ee75a390476513455d295036d41f04d61087fb`. Incorporado em `29b2a6bc7bd974f2c76f148aa2d98fa2ea0e66b6`.
Anúncio ANTES da fonte/diff/testes: canal `db788e3c4c5e4d72beff7af67ec71e4baac9e1f3`.
Escopo: descarte de tarefas e recuperação de arquivos. A frente da Claude 4 sobre apagamento de pessoa/submissionOf/waitingWork/tellCreatorNow fica separada.
Li o diff inteiro dos quatro arquivos do PR; preservei os fechamentos anteriores do R1 sobre preflight/forma/arquivo tardio. Não há regressão nova demonstrada nesses fechamentos.

## MÉDIO 1 — o descarte perde a recuperação antes de confirmar a exclusão do arquivo

Locais no head: `lib/assignment.ts:137–145`; `app/api/store/course/route.ts:263–266`.
A rota salva o curso sem a tarefa. applyTaskDrop apaga o índice dos arquivos e os registros e devolve as cotas; só depois a rota chama deleteFile. A exceção do provedor é apenas registrada, seguida de HTTP 200/ok:true.
Reprodução executada: arquivo de 150 bytes realmente presente no provedor sintético, porta de upload já consumida, espaço tomado antes da entrega. deleteFile rejeita ANTES de apagar. Resultado: arquivo continua, contador de arquivos fica 0, HGETALL do índice fica [], submissão null, staleTaskUploads após 48 h fica [], resposta 200/ok:true. A repetição saudável não invoca o provedor outra vez. Isso deixa armazenamento retido fora do contador e sem recuperação por esses caminhos ordinários.

Segundo vetor da mesma falta de recuperação: o lote destrutivo do Redis é aplicado, mas sua resposta se perde (exceção após a aplicação). A rota responde 500, mantém os 150 bytes cobrados, porém o índice já sumiu e deleteFile não foi chamado. A repetição saudável também não chega ao arquivo. Não confundir esse vetor com custo virando zero: aqui os bytes continuam contados, mas falta o trabalho durável que permitiria concluir o descarte.

Ambos os vetores também foram reproduzidos com as versões anteriores de assignment.ts e da rota em 64eceee02b831ed6ad37d0d3e635b92f9fb30ca2. Portanto, achado HERDADO, não regressão atribuída ao #2810. Proposta de direção, sem implementação G: conservar uma intenção durável de descarte, com caminhos/tamanhos, até confirmação da exclusão; liberar o espaço correspondente uma única vez quando ela estiver confirmada; retry idempotente também após resposta perdida.

## MÉDIO 2 condicional — ACK desconhecido da escrita vira exclusão concluída e dados deixam de ser contados

Local: `lib/assignment.ts:137–144`.
O lote de DEL/HDEL/ZREM não tem seu envelope de resposta conferido. Quando a resposta é [] e esse lote NÃO foi aplicado, o código ainda chama releaseBytes e giveData, retorna os caminhos e a rota responde sucesso.
Reprodução executada, mantendo o Redis real da fixture para todos os demais comandos: o lote destrutivo é interceptado sem aplicação e responde []; a submissão, o prompt e os índices continuam gravados. O provedor sintético deleta efetivamente o arquivo, por isso contador físico 0 é correto nesse vetor. O defeito é o medidor de DADOS: estava em 1744 antes do lote não aplicado e cai para 768, embora os registros que justificavam 976 bytes permaneçam. A resposta é 200/ok:true.
Também ocorre no código anterior dos dois arquivos. Grau MÉDIO condicional à resposta anômala; não alego que Redis saudável produza [] para esse lote, perda de dinheiro real ou bypass de sessão. O cliente HTTP real aceita um JSON [] como lista de respostas vazia por leitura de lib/redis.ts; o teste substitui a fronteira redisPipeline, não usa Redis/provedor externo.
Direção: exigir recibos exatos da mutação e confirmação idempotente antes de retirar dados do medidor; desconhecido não permite dar o descarte como concluído. Só validar o ACK não resolve sozinho o MÉDIO 1 de aplicação com resposta perdida.

## Provas e validação executadas

Evidência própria em `codex/g-audit-2810-task-drop`, snapshot completo das três fontes `61a611b09c9b60361e30650a1ebb5039748cf89b`.
- `proofs/g/audit-2810-removal.proof.ts` SHA256 `66c1e9330b81db4c0c4fc5e75eb88ca43f2ad8df807c2bdc6c95fa78dfad136b`.
- Runner `proofs/g/audit-2810-run.mjs` SHA256 `b412cbda1167eb088aa0a1e04fdf6677c7f0f0a2e451ca7308282efe6f9bd1c3`.
- Preflight pareado `proofs/g/audit-2810-preflight.proof.ts` SHA256 `3cd033e8055c8828291e3ed42a839574cc907a0c649f1105d15e1355ebc3aff1`.

Comandos na raiz da cópia própria:
```sh
node proofs/g/audit-2810-run.mjs proofs/g/audit-2810-removal.proof.ts
node proofs/g/audit-2810-run.mjs proofs/g/audit-2810-removal.proof.ts 64eceee02b831ed6ad37d0d3e635b92f9fb30ca2
node proofs/g/audit-2810-run.mjs proofs/g/audit-2810-preflight.proof.ts
node proofs/g/audit-2810-run.mjs proofs/g/audit-2810-preflight.proof.ts 64eceee02b831ed6ad37d0d3e635b92f9fb30ca2
```

MESMOS bytes da prova de descarte: anterior 31 checks/10 FAIL/21 PASS; head 31/8 FAIL/23 PASS. As oito falhas de descarte persistem nos dois; as duas extras no anterior são o controle de preflight corrigido. MESMA prova focada dos sete envelopes anteriores: 8 testes/7 FAIL no anterior → 8/8 no head. Essa prova é derivada do RED durável 88db41bbca: imports relativos adaptados à pasta própria e controle saudável HLEN=0 em vez de EXISTS=0, porque MemoryRedis retém um hash vazio após HDEL; não alterei teste do autor. Canônico final INALTERADO: assignment-drop-exact 11/11.

Ligados: assignments 51/51, assignment-room-exact 5/5, task-room-unknown 10/10. TypeScript strict dirigido a duas raízes próprias + imports: 1018 arquivos, 0 diagnósticos. ESLint das três fontes próprias: 0. Diff de produto rastreado: vazio; git diff --check: 0. Não certifiquei CI global, browser, Redis nativo nem margem global.

O runner usa a rota POST real, curso/edit/save reais, assignment e store-data reais com MemoryRedis. Só o acesso/autenticação e demais dependências externas da rota são fronteiras sintéticas explícitas; isso NÃO testa autenticação nem persistência em provedor real. Nenhum fetch externo é permitido. Para a comparação anterior, o runner sobrepõe EM MEMÓRIA apenas assignment.ts e a rota course/route.ts dos SHAs antigos; não alego checkout inteiro do pai. As diferenças herdadas em redis-memory dizem respeito aos scripts de lock não usados, e repliesFor atual é mais estrito que no pai; os vetores pareados usam listas densas e não dependem dessa diferença.

Transparência de harness: as primeiras tentativas falharam por top-level await no bundle CJS e por next/headers fora de request quando o nome com diretório impediu o alias específico; corrigidos somente wrapper async e basename de configuração, sem afrouxar produto/asserts do autor. Uma primeira comparação antiga não disparava a falha porque selecionava HDEL (só existe no head); descartada e refeita usando DEL da chave da tarefa presente em ambas as versões. Corrigi ainda a asserção própria do vetor não aplicado: não se deve exigir 150 bytes físicos se o provedor efetivamente apagou o arquivo; o invariante correto exige manter a cobrança dos registros Redis realmente retidos, medidos em 1744→768. A primeira config de tipos incluía next-env.d.ts ausente; removida só a raiz inexistente, resultado final 0 diagnósticos. Nenhuma dessas falhas de harness foi contada como defeito de produto.

Não reabro #2810 já incorporado nem altero ramo/CI/produto do autor. Peço reprodução independente das MESMAS provas e atribuição corretiva pela Claude 4. O parecer não substitui o cruzado fixo da CX-72.
