# Retorno nominal #2807 — identidade e preflight

Head revisado: `f82e077e2c94cea3628e27137882fefa50b92fa7`; PR aberto com nove arquivos, base `738a7124c3fd75cdbcf1b3fed4e544cf7d5a8575`. Root anunciou a revisão antes das novas leituras/testes. Somente provas/documentos próprios: nenhuma alteração de produto, ramo do autor ou CI.

**Não pode entrar como correção global: um MÉDIO funcional permanece no snapshot de entregas.** O segundo GET agora vincula corretamente a identidade. Os controles de primeiro GET desconhecido/alheio são resolvidos com segurança pelo fallback e não constituem achados nesta prova. O golden real anterior do próprio curso, com o mesmo id, deixa trabalho, arquivo e espaço órfãos depois da remoção confirmada.

## Identidade original — recorte fechado

SAME14 permaneceu byte a byte: blob `182102a1678d45ece1071f494480965f6e3a3132`, conferido no GitHub em `d2dd8e92028b57f483d4bdf727b5efe0ed61bd2b` e idêntico ao permanente do autor. SAME9 também permaneceu intacto: blob `7a744d81a44f14eb4a78affa564d2fc122323b76`.

O delta `3767a989a..f82e077e2` acrescenta somente `course.id !== id` ao leitor exato. SAME14: **14/14**; permanente: **14/14**. O permanente inteiro no pai `3767a989adf6115f81a8e984324d851d9fb652c0` faz **14 verificações, cinco falhas**. Não se repetiu o ensaio antigo em 9369. Isso fecha o segundo GET da prova original, sem certificar toda a preparação anterior.

## MÉDIO causal — golden anterior do mesmo curso perde a preparação de entregas

Crédito: o Revisor 2 e o parecer anterior de J pediram conferir também o preflight. A extensão de J usa escritores reais para distinguir os efeitos efetivamente reproduzidos.

`app/api/store/product/route.ts:289` lê beforeCourse com readCourse; o leitor exato corrigido ocorre depois, no callback de removeProduct. Em `:328–329`, a igualdade entre os ids faz usar os taskDrops da primeira leitura. Uma versão anterior válida do mesmo curso pode ter a lista de tarefas diferente da versão exata removida. Os ids continuam iguais e o snapshot vazio é aplicado; o fallback que releria as entregas não é chamado.

A prova cria dois cursos **da mesma loja**, usando claimHandle, session/autenticação, addProduct, rotas reais de curso/lição/tarefa, takeRoom e handIn reais. Ambos têm tarefa, submissão, índice de arquivo, arquivo no Map do provider sintético e espaço contado. Apenas o **primeiro GET do curso alvo** é alterado. Nenhum curso, contador, cota ou estado de entrega é forjado. O golden é o JSON real produzido pelo writer quando o próprio curso ainda não tinha a lição; depois a lição, tarefa e submissão são criadas pelos writers reais.

| Primeiro GET | Resultado e limpeza do alvo | Outro curso | Espaço dos arquivos |
| --- | --- | --- | --- |
| Saudável | 200; curso/produto, tarefa/submissão, hashes/índices e arquivo removidos | Integralmente retido | 2000 → 1000 |
| Envelope `[]` | 200; fallback relê o curso exato e limpa tudo do alvo | Integralmente retido | 2000 → 1000 |
| Curso alheio válido, real, da mesma loja | 200; ids diferem, fallback relê o curso exato e limpa tudo do alvo | Integralmente retido | 2000 → 1000 |
| Golden anterior do próprio curso, mesmo id | **200, produto/curso removidos; entregas e arquivo retidos** | Integralmente retido | **2000 → 2000** |

No golden permanecem prompt da tarefa, submissão do aluno, hash do arquivo com **1000 bytes**, índices tasks:all/tasks:waiting, espaço de dados **ca:<curso> = 1072** e arquivo no provider sintético. Há **zero pedidos de exclusão** desse arquivo; a identidade que permitiria retomar o pedido já foi removida. Isso é falha funcional sintética de limpeza e retenção cobrada, sem demonstração de ataque entre lojas ou perda de dados reais. Não certifica custo zero.

A extensão final faz **33 verificações, uma falha esperada**, no assert de ausência de órfãos. As verificações de integridade do outro curso e ausência de órfãos foram preservadas; a conferência de limpeza inclui agora também os dois espaços e o índice waiting.

## Correção transparente do contrato do harness

O commit durável `170ae75fa4873158cded59cdcc0cdf70574fd6b8` conserva a primeira extensão **33/5**. Das cinco falhas, **quatro eram expectativas arquiteturais excessivas do harness**, e não defeitos: exigir HTTP 503 e retenção do produto para `[]` e curso alheio, embora a leitura independente segura e a limpeza completa resolvessem ambos. A quinta era o golden causal. O recibo 33/5 permanece no arquivo de saída como histórico limitado; não fundamenta quatro achados adicionais.

A coordenação autorizou a correção em commit separado. O contrato corrigido aceita para os controles somente: **200 com todos os dados/arquivo do alvo removidos, curso/produto ausentes, ca liberado, bytes 2000→1000 e outro curso intacto**; ou **503 com identidade, curso, snapshot inteiro das entregas e os dois espaços retidos**. Nenhum 200 genérico é aceito. SAME14/SAME9 e os asserts de integridade do outro curso/orfandade não foram afrouxados.

Por isso, **não confirmamos a hipótese inicial de que primeiro GET `[]` isoladamente deixe órfãos, nem de que um curso alheio isoladamente apague suas entregas**: o fallback em `:329` usa removedCourse exato e limpa corretamente o alvo. O achado é a escolha de `:328` para um snapshot válido antigo do mesmo id. Trocar apenas o primeiro leitor por readCourseExact não elimina esse golden; é necessário ligar a preparação à mesma versão removida ou reler com segurança antes de perder a identidade. Nenhuma solução foi implementada nesta unidade.

## Transporte: protótipo descartado e prova final isolada

O primeiro protótipo substituía globalThis.fetch. O SDK importa sua própria undici.fetch e ignorou esse stub: houve **POST externo não previsto para https://vercel.com/api/blob/delete**, com credencial sintética, e resposta traduzida em **BlobStoreNotFoundError / code store_not_found**. O **status HTTP numérico não foi capturado**. Não era apenas validação local. O ensaio foi descartado como evidência de isolamento; o log integral está no arquivo de saída, sem valor de credencial. Não afirmamos ausência de custo ou resultado sobre conta real.

A prova final usa MockAgent.disableNetConnect e setGlobalDispatcher da **mesma undici do SDK**. O primeiro controle chama um destino não registrado e exige recusa local **UND_MOCK_ERR_MOCK_NOT_MATCHED**; se falhar, para antes de qualquer remoção. O callback local de `/api/blob/delete` registra as exclusões no Map sintético, sem fallback de rede. A credencial sintética final é efêmera, gerada depois do controle, nunca impressa ou salva. Outros destinos via fetch global são recusados localmente. O runner instala também dispatcher sem rede e fetch global recusado **antes de cada filho**, inclusive nos grupos ligados. Não houve nova chamada real depois do protótipo.

## Verificações e limites

- SAME14 e permanente no head: **28/28**; permanente inteiro no pai: **14/5 falhas**.
- SAME9 inalterado: **9 verificações, duas falhas apenas por esperado HTTP 500 versus obtido HTTP 503**. Os asserts de recuperação/limpeza passam; não alterei o arquivo. Permanente corretivo atual course-removal-comments: **12/12**, com 503 e retry reais.
- Quinze grupos completamente verdes: **573/573**, incluindo os dois grupos de identidade e os ligados de comentários, exclusão, privacidade, templates, bloqueios e assignments.
- Os 16 grupos de replay offline sem a extensão fazem **582 verificações, duas falhas históricas do SAME9**. Somando a extensão corrigida no mesmo head: **615 verificações, três falhas** (uma causal da extensão; duas expectativas históricas). Os logs distinguem a execução consolidada anterior da execução separada do contrato corrigido.
- TypeScript strict/noEmit, configuração herdada e imports reais de fontes/provas, sem aliases de mocks: **zero diagnósticos**.
- ESLint de produto/permanentes: zero erros, três avisos existentes (dois imports de lib/store.ts e um part não usado no permanente). Prova nova/runner: zero erros/avisos.
- Scanner tracked: **4079 arquivos, zero ocorrências**; scanner explícito dos **quatro novos paths, zero ocorrências**. Diff-check do produto e whitespace dos quatro paths: aprovados. Hashes originais reconferidos com o GitHub: idênticos.

Runner: `TMPDIR=/dev/shm node scripts/j-review-2807-preflight.mjs`; nomes adicionais de testes podem ser passados como argumentos. Usa testAliases/testEnvironment canônicos. Executar a prova sobre **f82e077**: o ramo de evidências preserva sua base anterior e seus commits históricos, sem copiar produto do autor.

Não rodei navegador, Redis nativo, publicação, teste de conta/fornecedor real ou CI nova. A chamada externa não prevista do protótipo está registrada separadamente; toda evidência causal final de arquivo/provider usa somente o transporte isolado. Nenhum preço, limite, comissão, flag ou trava foi alterado; nenhuma conta foi criada e nenhum pagamento foi autorizado ou realizado.
