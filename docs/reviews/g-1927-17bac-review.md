# Revisão Codex G de #1927 — retorno dos recibos de exclusão

**Head exato: 17bacb0f8d9eae9b8f0e966276661cf5a4987160. Sem achado no retorno focal.** Fechados o MÉDIO condicional de contagem impossível e o LEVE de valor herdado, classificados pela Claude 4 na C4-20261106-2050-TODOS-121. A diferença de grau entre G/R2 foi decidida pela coordenação; não atribuo ao R2 a classificação MÉDIO. O LEVE 2 de remoção individual history_unconfirmed, aceito na C4-1805, permanece aceito, sem reabertura.

Anunciei o head antes de ler/testar no canal, commit e616aaaa0c5cddf879e87b85e69c74883be74b12. Li inteiro o delta 579850dc..17bac: cinco arquivos, 301 adições/3 remoções. O único delta de produto é lib/flows.ts. É continuação da revisão integral anterior, não nova alegação de auditoria de todo o main herdado. Os sete arquivos de prova foram comparados byte a byte com minha cópia anterior: idênticos. Os dois novos testes descobertos são exatamente as provas respectivas após a linha de crédito.

## Resultado causal

- Prova congelada **9d5e99b9**, DEL de exatamente uma chave, não aplicado e com recibo 2: pai 579850dc **6 checks/1 falha**, head **6/6**. A guarda executável c.length===2 impede confundir isso com DEL legítimo de várias chaves.
- Prova congelada **734dfb5a**, slot acessor com Object.prototype.value=0 colocado apenas localmente e restaurado em finally: pai **7 checks/1 falha**, head **7/7**, getterCalls=0. Não demonstrei poluição remota nem accessor vindo de JSON legítimo.
- Reexecutei ambos no pai nesta rodada, sem mudar seus bytes. O pai dizia completed=true com uma definição e histórico remanescentes; o head lança, conserva a possibilidade de repetição e a repetição saudável limpa tudo.
- Prova original de recibo null **267d3243** continua **6/6**. As quatro provas anteriores (gravação após remoção, exclusão desconhecida, colisão de ID aninhado e janela final do forget) continuam **7+5+7+5**, todas verdes. Total dos sete arquivos congelados: **43 checks aprovados**.
- Controles: exclusão saudável **6+6+7**, accessor com protótipo limpo **7**, quatro corridas desligadas por G_ERASE_RACE=control **24**; todos verdes.

A implementação lê o value PRÓPRIO do descritor e exige inteiro seguro entre zero e o número de chaves do DEL ou de membros do ZREM. Recibo ausente, desconhecido ou acima dessa aridade não confirma exclusão.

## Caso adicional independente

[tests/g1927-erase-arity.proof.ts](https://github.com/solrenning-llc/marktmorgen/blob/33c8a14b77d5ccfb42fe2855392b7cec08a440d2/tests/g1927-erase-arity.proof.ts) usa saveFlow, openRuns, readRun e forgetWorkflowPerson reais com MemoryRedis; nenhum registro, contador ou índice é forjado. O escritor real cria o registro e o primeiro evento. O DEL real de duas chaves efetivamente remove ambas e responde 2, que é aceito. Somente um ZREM de exatamente um membro deixa de ser aplicado e responde 2.

Mesma prova: pai579 **6 checks/1 falha**, head **6/6**; controle saudável no head **6/6**. No pai o retorno dizia concluído com o membro ainda no índice; no head recusa confirmação, e uma repetição saudável remove o remanescente. Não imponho teto 1 a todo comando nem acuso Redis legítimo de produzir contagem impossível.

## Verificações executadas

**36 arquivos canônicos ligados: 817 checks customizados + 21 node aprovados, zero falhas/skip.** Manifesto exato em docs/reviews/g-1927-17bac-manifest.json@8c2bf85eab6df9a72ec2f3a803c23deafa3aa7af; inclui as duas regressões descobertas novas, erasure-request-full, escopo, tempo e evidência de apagamento, workflows, locked-deletes e registro de famílias. Não são os mesmos 36 arquivos da rodada anterior: o manifesto desta rodada é a referência, sem somar ou inventar cobertura.

tsc -p tsconfig.g1927-17bac.json: **27 raízes/imports, exit 0**, recorte estrito. Lint de cinco arquivos do delta mais a prova própria: zero erros, oito avisos de imports não usados nas cópias anteriores. git diff --check: exit 0. Produto rastreado intocado; só prova/config/manifesto próprios não rastreados na cópia /tmp/g1927-return-17bac. Pai /tmp/g1927-return-579.

Saídas completas: docs/reviews/g-1927-17bac-output.txt@f37aec1458d2ead31ac71153dfbd8b6fa44f1196. Config c2d4ef220a22c06d948e1eba77aa4890a721921c. O log de controles de corrida válido é race-controls-final (G_ERASE_RACE=control); a tentativa anterior com variável sem efeito não é contada como controle.

Nenhum Redis/Lua nativo, provedor, conta, pagamento real, DOM/AT, CI global/build ou certificação geral de margem. Nenhuma alteração de produto, preço, limite, flag, trava, reserva, ref/CI alheio ou merge pelo G. Coordenação somente Claude 4; Claude 1 desligado. Parecer independente de retorno, sem substituir cruzado fixo CX-72 por inferência.
