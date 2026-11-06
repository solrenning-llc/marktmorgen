# Revisão Codex G de #2848 — sem achado no cálculo focal de blob-list

Head exato `3d34bc1ab62c36f24f3f6171628392a1771b067d`, OPEN reconfirmado; base atual `0e7bcae82c67296d03e0caccbe51f6485a29cc3d`. Anúncio de revisão financeira anterior à fonte/diff/testes: canal `b66ce98ff04850ed7e6acac6d2a898aad1656164`. Li o diff inteiro dos cinco arquivos, o adaptador completo, armazenamento/reserva, política de upload e todos os chamadores encontrados de filesHeld/storageUsed/listFiles.

A fórmula nova confere no recorte: PAID_UPLOAD_OPENS × uma medição por abertura × no máximo 20 páginas × 11 tentativas × operação Advanced. Valores mensais internos resultantes: Creator 0,055; Pro 0,33; Scale 0,66 USD. A reserva mensal acontece antes de openReservedVault, não é devolvida na falha, e a reserva de armazenamento chama a medição uma única vez. As portas Blob e stream são recusadas antes de medir pelo backend diferente de r2. Conferi os chamadores da página do estúdio e plan-closing como caminhos distintos de plano encerrado; não os tomei por abertura paga.

Fontes públicas primárias lidas em 06/11/2026: https://vercel.com/docs/vercel-blob/usage-and-pricing (página informa atualização de 23/09/2026) e https://vercel.com/pricing confirmam list como operação Advanced e 5 USD por milhão; https://vercel.com/docs/vercel-blob/using-blob-sdk descreve paginação por cursor/hasMore e limite padrão 1000. Não usei franquia grátis ou créditos como custo zero. O pacote INSTALADO e pinado é @vercel/blob 2.8.0: list usa requestApi e o controlador usa getRetries, cujo padrão sem override é 10 retries além da primeira tentativa. Isso confirma 11 no padrão testado; não certifiquei configuração de implantação com override de VERCEL_BLOB_RETRIES.

## RED/GREEN e caso não coberto pelo autor

O teste autoral final está BYTE-ID no RED `74293c656a7c00f5032f7ac23af63ce6c4008de4` e no head, blob `1092c8e1c73213bb09b138c7274b1bc12a0603ee`. Mesmos 14 checks: RED 13 falhas/1 controle → head14/14. O replay troca em memória SOMENTE tests/plan-cost-registry.ts pela versão do RED, não altera código do autor e não é checkout integral do pai.

Prova própria congelada em `codex/g-review-2848-blob-list-cost@3011efe70049614cd2c7c9e1c0680751dbb8a544`:
- proofs/g/review-2848-boundary.proof.ts, SHA256 `2eef4c546e001bd7d6045d528b2ea1ab87d7c4202ab54334a6b4eff933e9354b`;
- proofs/g/review-2848-world.ts, SHA256 `fc7fbe9fd12ad175cb6c985cead639a01a5b8c596a22f197817afe2603387543`;
- proofs/g/review-2848-run.mjs, SHA256 `5aae7ced9d57252c2b59cbcfbde9a924b2cb75b346f1921d646ecbda171ce48b`.

Mesmos28 checks: RED3 falhas de cobertura de custo/25 controles → head28/28. Os controles executam filesHeld/storageUsed/fits REAIS com respostas sintéticas só na fronteira dos três adaptadores:
- 20 páginas COMPLETAS de 1000 registros, mais vault7/video13: bytes20020, available:true, 20 chamadas, cursores/prefixo/limit corretos, uma leitura de cada provedor seguinte;
- resposta que precisaria da 21ª página: unavailable, sem autorização parcial, exatamente20 chamadas, ZERO21ª e nenhum vault/stream depois do teto;
- falha do provedor na terceira página: só3 tentativas e nenhum provedor seguinte;
- cursor repetido, hasMore de tipo errado e soma insegura: recusados, sem autorização;
- a cobertura de cada plano é confrontada com as20 chamadas máximas observadas e todas as11 tentativas.

Comandos:
```sh
node proofs/g/review-2848-run.mjs tests/blob-list-cost.test.ts
node proofs/g/review-2848-run.mjs tests/blob-list-cost.test.ts 74293c656a7c00f5032f7ac23af63ce6c4008de4
node proofs/g/review-2848-run.mjs proofs/g/review-2848-boundary.proof.ts
node proofs/g/review-2848-run.mjs proofs/g/review-2848-boundary.proof.ts 74293c656a7c00f5032f7ac23af63ce6c4008de4
```

O primeiro bundle da prova própria falhou por alias de stream amplo demais, que retirava exports de consumidores fora do adaptador. Corrigi APENAS o runner para substituir provedores nos imports de file-store/storage-quota; as28 asserções e respostas ficaram inalteradas. Não contei falha de harness como achado de produto. O runner final foi publicado com os bytes efetivamente executados.

## Ligados e limites do parecer

Onze grupos ligados, todos status0: plan-cost-registry24, plan-margin39, read-ceilings77, margin-alignment8, lq17-cost-document1, picture-upload-costs14, storage-measurement41, closing-cost6, upload-budget16, automatic-upload-budget8, storage-reservations9: **243 checks/testes**. Os dois grupos de upload confirmam o teto de50 aberturas Creator e a recusa seguinte/controles de ACK perdido; são scripts modelados pela fixture, não Redis nativo. Os testes de reserva usam Redis em memória e transporte R2 sintético. Nenhuma conta, pagamento, fornecedor ou chamada externa real.

ESLint dirigido a seis caminhos: 0 erros/avisos. Scanner4126 rastreados+3 fontes próprias:0. Diff rastreado de produto vazio; git diff --check0. A árvore local tinha4126 caminhos presentes, índice reconciliado e head3d34 antes dos testes. **TypeScript dirigido a cinco raízes/imports morreu com exit137 sem diagnóstico; NÃO alego TSC aprovado.** Compilação dos bundles e lint concluíram; os nove agregadores do head final continuam obrigatórios. Não fiz build/globalCI/browser/Redis nativo/produção.

Este é UM parecer financeiro independente, apenas do acréscimo focal. Não substitui segunda revisão financeira nem libera margem global, exposições de encerramento ou custos ainda declarados desconhecidos. A própria descrição mantém listFiles/dropStamped legado sem teto e outros itens de Blob fora da linha; leio isso como lacunas abertas, não como zero ou cobertas pela fórmula nova. Não certifico que o total interno65,6702 inclua os itens excluídos. O recorte não muda preço/limite/flag/trava nem qualquer caminho de produto. Sem achado novo demonstrado nesse delta; condições de MR e coordenação continuam aplicáveis.
