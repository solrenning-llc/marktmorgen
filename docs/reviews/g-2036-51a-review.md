# Revisão Codex G de #2036 / 51a85e9d — MÉDIO residual e LEVE anterior

Head exato **51a85e9d038fef9e23688aff51f9e6668f6188a3**, OPEN reconfirmado. Retorno nominal pedido por Claude3; anúncio prévio **d98f79360faa132f70e801c7cdb39361269addf4**. A tentativa anterior409 NÃO assumiu esta revisão; aguardei mais de120s, reli FULL/blob e só avancei após o append confirmado. N permanece nominal anterior e os créditos são preservados.

Reconciliei os32 arquivos do PR: **29 blobs idênticos ao8c4 já lido/revisado**, inclusive pipeline-access, mais TODO delta de3 arquivos lido integralmente (lib/team.ts e os dois testes novos). Não alego32 novas leituras redundantes; é continuação da revisão integral registrada em G5803684178. As quatro instruções do main foram reconferidas e mantêm os mesmos blobs.

## MÉDIO condicional HERDADO — elementos nulos ainda apagam o time e sua regra

**lib/team.ts:204–206 → :151–173; escrita em :440 e :226–231.** O novo teamFromReply valida que members/invites são arrays, mas delega a parseTeam sem validar seus elementos. Um elemento null faz m.role/i.role lançar; o catch de parseTeam devolve time vazio SEM requireTwoStep, mesmo com requireTwoStep:true no JSON recebido. Não é ausência confirmada.

Reprodução primária usa **inviteMember REAL**, chamado pela rota de produção app/api/store/team/route.ts:67; não depende do putMember reservado à demo:
1. Registre saudavelmente Amy(admin), Ben(support) e requireTwoStep:true. O registro REAL em MemoryRedis continua íntegro.
2. Somente a resposta do GET desse time é trocada por JSON com **members:[null,...]** ou **invites:[null]**, mantendo as duas listas e requireTwoStep:true. Demais comandos executam normalmente.
3. readTeam aceita e fica vazio; teamTwoStepBlocks retorna false no teste direto do helper.
4. Chame inviteMember como faz a rota do proprietário. A tentativa termina **{ok:false,reason:'unsent'}**, pois o transporte está desligado, mas o SET REAL já gravou **members:[], uma nova invite e nenhum requireTwoStep**. A tentativa de revogar o convite também lê a resposta malformada e não o retira. Ao restaurar o transporte de leitura, os dois membros continuam perdidos e a regra desligada.

**Prova durável anterior ao parecer:** codex/g-review-2036-return-51a@**62912724182ac501cd762c62574b0c729e0ad87a**, tests/g2036-team-invite-inner-null.proof.ts, SHA256 **2de823621bba1543333f3a9b9b4c4062d49bd823b2cc53e3ae20252690e2446e**. **MESMAS16 verificações:12 falhas/4 controles TANTO no8c4 quanto no51a**. Dois vetores, seis invariantes cada; controle saudável da mesma recusa de e-mail preserva ambos os membros e a regra, e confirma ZERO chamadas de provedor. São17 comandos observados por vetor depois da preparação, dentro da cerca sintética de200 dessa fase. Fixture inicial sintética é separada, não certificação de custo produtivo.

**Grau MÉDIO condicional, não regressão do51a.** Depende de resposta malformada de leitura; não demonstrei injeção remota, ataque a Redis saudável, login real de invasor, uso de chave de API, pagamento ou bypass completo do endpoint autenticado. O retorno falso do helper de segunda etapa é observado diretamente; a perda persistente da regra e dos membros foi demonstrada no escritor produtivo. Não chamo o resultado unsent de sucesso.

Direção: um elemento não reconhecido torna a leitura inteira desconhecida antes de qualquer alteração; o parser usado para escrever não pode converter erro em vazio/filtrar silenciosamente e devolver estado gravável. Preservar ausência null e compatibilidades legítimas. **R2: peço EXECUTAR a MESMA16 e classificar antes do reparo, sem mudar asserções.** A mesma família existe no parseTeam exportado consumido por lib/api-keys.ts; esse chamador não foi reproduzido nesta unidade, portanto não lhe atribuo outro achado.

A sondagem inicial G27 usava putMember (só demo) e quatro formas internas. Está preservada separadamente em4200eecb, mas NÃO é a base do grau de produção. Depois de conferir os chamadores, construí a prova distinta de16 com inviteMember; nenhum teste anterior foi afrouxado.

## Correção autoral e achado anterior

- **MESMOS37 canônicos do autor** contra team.ts antigo8c4: **35 falhas/2 controles →51a37/37**. Os sete envelopes descritos pelo autor foram fechados, e os controles null conhecido permanecem. Isso não cobre elementos nulos dentro de listas válidas.
- Prova original G de cópia aplicada/ACK perdido, BYTE-ID blob6bba5d87: **188/188 no51a**. O MÉDIO5803482928 continua fechado nos casos anteriores.
- Matriz congelada **30b80d9da7dac3ecfa4789f2148fd02388ca7b1d**, blob9e515efac080b727b4394202260a9e29c35da342 conferido: **MESMOS124,10 falhas no51a**. **LEVE local de accessor** G5803684178 permanece: pipeline-access.ts:112–113/:171–174 executa getter de recibo JavaScript local e perde o contexto do undo. JSON REST não cria getter; não reclassifico como exploração remota. Os100 controles comuns continuam aprovados.

## Ligados, evidência e limites

Doze grupos completos: team-roles43, team-two-step14, team-two-step-session30, team-pick23, team-scheduling100, pipeline-access40, pipeline-access-team42, pipeline-access-edges97, pipeline-access-names18, pipeline-copy11, api-key-second-step189, locked-deletes115: **722/722**. O188 congelado é contado separadamente; os grupos se sobrepõem, não representam910 cenários únicos. As falhas de16 e124 são registradas separadamente, não escondidas entre verdes.

Strict dirigido a team.ts, teste autoral e prova produtiva: **3 raízes/753 arquivos com imports/0 diagnósticos**. ESLint5caminhos0; scanner oficial dirigido aos mesmos5caminhos0, não global; diff-check focal8c4..51a0. A primeira tentativa do validador usou jsxImportSource do main mais novo, ausente neste ramo; corrigido somente o harness para a configuração REAL deste head. Testes que leem fontes pelo fs precisaram de materialização adicional de app/components/lib; os ENOENT anteriores não são achados nem resultados canônicos aprovados. Repeti só os grupos afetados após fornecer os bytes exatos, sem alterar testes.

Cópia própria /tmp/g2036-return-51a, módulos de SHAs explícitos por git show; os REDs são replay por origem de módulos, não checkout físico integral do pai. Runner **b7e0c5c3da7e47fa18a22529ee970f0ef2c06aed**, validador **e048fd55be6c7676242f2e3d2870c824143daa56**. Saídas completas: **b3adc5a67fc98ba4150ca54919e70ccd07763fe6** g-2036-51a-core-output.txt e **d3c3650953e085b59692202fa1ba675a5f0aa95b** g-2036-51a-linked-output.txt.

Comando principal: node proofs/g/review-2036-return.mjs tests/g2036-team-invite-inner-null.proof.ts SHA40, com8c4 e51a acima. Sem SHA, usa51a. Nenhum e-mail enviado, fornecedor, conta ou dado real; Redis em memória, sem Lua/Redis nativo, browser/AT, CI global ou margem certificada. Não alterei produto, reserva, ref/CI alheio nem fiz merge. **Não é parecer liberatório enquanto o MÉDIO residual estiver aberto.** C4 única/C1OFF; cruzado fixo CX-72 preservado.
