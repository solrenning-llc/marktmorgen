# Revisão independente Codex G — #1927

Head EXATO: fbf2a21510265fdb1e321cece91b08df673523ad. Retorno nominal anunciado no canal bac8f8ad52635fae7ce48edef320c5dd910b1401, antes de diff/testes. Base do PR e84cc9d035b35e3b7beec25b5172a338ccdb22dc; diff próprio atual 23 arquivos,1094+/35-. Diff anterior e4f integralmente lido na revisão5801070835; neste retorno li TODO e4f..fbf (14 arquivos,324+/36-), inclusive Lua, implementação MemoryRedis, mensagens e provas copiadas. Não auditei como novo todo main incorporado historicamente.

## Parecer: 1 MÉDIO residual e 1 LEVE reproduzidos; não é sem achado

### MÉDIO — lib/flow-versions.ts:81, via saveFlow/removeFlow

A busca string.find(flows, '\"id\":<id>',1,true) não limita o ID aos fluxos na raiz: encontra também o ID de um PASSO de outro fluxo vivo. O escritor cleanStep em lib/flows.ts:199 admite o ID válido de16hex informado, sem exigir diferença em relação a IDs dos fluxos. Portanto a condição nova não prova que o fluxo removido continua lá.

Prova tests/g1927-nested-id.proof.ts@5cbc6175f64dfdcdcb64a6415c8515af8ceb7736: cria A pelo saveFlow real; cria B pelo mesmo escritor com um passo cujo id=A.id (ambos IDs válidos, sem JSON/registro/resposta forjados). Pausa a gravação real de A ANTES do LRANGE do histórico; remove A pelo removeFlow real; confirma histórico ausente; retoma a gravação. A fica ausente, B vivo, mas o histórico de A volta com Original subject: o novo KEEP vê B.steps[0].id e aceita. No fbf são7checks/1falha causal, no pai e4f os MESMOS bytes são7/2falhas. Controle sequencial G_ERASE_RACE=control:7/7. O índice novo melhora a recuperação: um forgetStoreWorkflows posterior encontra/apaga o remanescente (o pai não o encontrava). Não alego órfão irrecuperável no fbf nem dado de pessoa/conta real; a falha é a promessa de remoção do fluxo/histórico retornar concluída e uma gravação antiga recriá-lo. Não é regressão de comportamento contra e4f; é fechamento incompleto da proteção nova contra gravação atrasada.

### LEVE — lib/flows.ts:537–538 (janela da exclusão completa)

O forgetStoreWorkflows apaga históricos/índice enquanto a definição ainda existe e só depois executa DEL da definição. Uma gravação que já concluiu o writeFlows e espera o LRANGE do histórico pode retomar nessa janela, passar KEEPv2 e recriar histórico/índice; a exclusão completa então cumpre o último DEL e retorna resolvida deixando o histórico. Confirma a janela que o R2 ciclo77 já apontou estaticamente; crédito preservado.

Prova tests/g1927-final-forget-window.proof.ts@25cc63812a55479614189f3b83d12857ab84e114: barreiras por promessa/evento (sem espera de relógio), saveFlow e forgetStoreWorkflows REAIS. Retoma o save apenas quando o forget vai executar seu batch final com DEL nl:mail:flows. Nenhuma resposta/registro/contador forjado. fbf5checks/1falha: definitions0/history1/index contém id; segunda exclusão encontra e remove. Pai e4f mesmos bytes5/2 (segunda exclusão não removia). Controle sequencial5/5. Classifico LEVE pela recuperação efetiva pelo índice; recorte é o helper de workflows, não afirmo que executei exclusão global de conta, PII real nem efeito jurídico.

## O que fechou

As duas provas originais do G copiadas no produto são BYTE-ID aos originais: blobs26bfd10c68ed0c6e2be2bc052aa153ca5591197a e3fa482cd4d267baa0eb7d14e1670e3472cd2c274; runner BYTE-ID também. Reexecutei no fbf: corrida original7/7, remoção não aplicada/retorno desconhecido5/5. Os controles saudáveis também7/7 e5/5. O caso simples sem outro fluxo não recria histórico e o índice acha o histórico após remoção desconhecida. Os REDs anteriores e4f/1743 permanecem na evidência da revisão5801070835, não substituídos por instrumentos que deixaram de atingir a fronteira.

Reconto financeiro: canônicos room-evidence2/2 e refused-third-push3/3; três entradas charged2384>=required2240 (inclui lugar no índice). flow-versions-evidence6/6 e flow-versions20/20. Nenhum subcusto atual inferido do antigo teste que falhava apenas por instrumentação. O R2 também apontou remoção desconhecida sem re-tentativa individual; não acrescento um terceiro achado novo sem prova adicional do fluxo de interface.

## Validação executada e limites

25 arquivos canônicos ligados:619 verificações customizadas+18 testes node, todos aprovados, sem skip;12 checks das duas provas congeladas separados (não contam como independência nova). Adversariais esperadamente vermelhos e controles explícitos acima não entram nessa contagem verde. tsc -p tsconfig.g1927-fbf.json:exit0, recorte estrito de produto/imports+canônicos+provas, não tsc global. eslint15 caminhos:exit0,0erros/5avisos de imports não usados (inclui cópias originais); git diff --check:0; produto rastreado intocado, só próprias provas/config não rastreadas na cópia destacada /tmp/g1927-return-fbf.

Comandos: node tests/g-proof-run.mjs <arquivo>; G_ERASE_RACE=control node tests/g-proof-run.mjs <prova>. Provas novas mesmos bytes no pai /tmp/g1927-review-e4f e no head. Config ef49e22478216bb1840942abd9c6f304b398bc26. Saídas integrais docs/reviews/g-1927-fbf-output.txt@025d9202e37816f5c0aedad46f159967428fc70c, mesmo ramo próprio codex/g-review-1927-history-retention.

Não rodei Redis/Lua nativos, Upstash, provedor, browser/DOM/AT, verify/CI global, build nem certifiquei margem geral. Uso de MemoryRedis explicitado, comportamento da condição Lua e seu modelo ambos lidos. Sem produto/reserva/ramo/ref/CI alheio/merge; C4 única coordenação, C1 desligado. Parecer adicional independente, sem substituir cruzado fixo CX72 sem ordem.
