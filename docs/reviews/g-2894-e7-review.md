# Revisão Codex G de #2894 — sem achado demonstrado

Head exato **e7a0e382d9e0897a679030ba9eda18155073fb9d**, OPEN reconfirmado. Nominal urgente C4-2940; anúncio **97a4f0785482aaa769b85e566af62938eb4b2a55** anterior ao código/testes. Li o diff inteiro dos QUATRO arquivos: check.ts, run.mjs, check-exit.test.ts e check-exit.proof.ts. A descrição ainda fala do recorte inicial de três arquivos, mas o runner também está incluído e foi conferido.

## Execução independente

Node local **24.22.1**, não o24.22.2 do autor. MESMO driver de estresse final, sem mudar16 filhos/8 simultâneos/15s/300ms de alocação:
- check.ts do RED **050892b900b7a3a8a21b24fe0d53e7a21de5c5da**: **1 de16 filhos não terminou**, resultado1/falha;
- check.ts do head: **três rodadas de16, zero timeout em48**, todas as três provas terminaram0.

É reprodução local do sintoma e da melhora; não repeti gdb nem li logs hospedados, não certifico causa universal de todo verify travado ou ausência estatística absoluta de deadlock. O driver conta exit como “ended” sem validar o status de cada filho; os48 são terminações dentro do prazo, não certificação individual de48 asserts internos. Para complementar essa limitação executei controles explícitos de status abaixo.

O guard permanente final foi mantido BYTE-ID e rodado contra fontes check.ts+run.mjs da base1721109f: **MESMOS3 testes,3 falhas → head3/3**. Os dois arquivos antigos são lidos numa fixture local temporária; no estresse, somente o módulo check.ts vem do SHA indicado. Não alego checkout integral do RED.

**23 verificações próprias aprovadas**, usando check.ts real em filhos locais: sucesso→0, asserção falsa→1, intervalo aberto+sucesso→0 após cerca2s, intervalo aberto+falha→1 após cerca2s, exceção assíncrona posterior→1. Conferi status, ausência de sinal e linha de resultado. Extraí SEM modificar o bloco final real de run.mjs e confirmei suas duas saídas: failed0→0/Everything passing e failed1→1/failure. Não executei a suíte global através de run.mjs.

**Ligados382/382:** backup-run96, stream148 e vault138. Todos terminaram normalmente sob o novo done(). Uma tentativa inicial de backup-run parou por vercel.json ausente na cópia parcial; repeti somente esse grupo depois de materializar o vercel.json exato,96/96. Não foi falha de produto e nenhuma asserção foi alterada. Serviços e provedores desses testes são sintéticos pelos aliases/ambiente canônicos.

Tipos strict dirigidos aos3 arquivosTS do recorte:0 diagnósticos. ESLint7 caminhos (4 do PR+3 fontes próprias):0. Scanner oficial aplicado aos conteúdos desses7 caminhos:0; não scanner global. Diff-check base1721109f..head0. Inspeção de1088 ocorrências de done nos testes identificou11 usos antecipados explícitos nos grupos stream/vault, todos com return done(); esses dois grupos foram executados. Não certifico por isso todas as combinações da suíte inteira.

## Evidência durável e alcance

Próprio ramo **codex/g-review-2894-exit-code**. Fontes finais **edd3197425a5ffe463eee62ffb9e1a00c859824d**, incluindo review-2894-run.mjs (SHA256badecef9fc926e28e7206bc626971be6669f496f75c3fb5b68aa072b3f96779c), review-2894-controls.mjs (SHA256558dfe31c4bd5126d5fb4ca35d48ef535a5dddbe064cca421266ab964382996e) e proofs/g/review-2894-linked.mjs.

Comandos: node review-2894-run.mjs guard SHA40; node review-2894-run.mjs stress SHA40; node review-2894-controls.mjs; node proofs/g/review-2894-linked.mjs tests/backup-run.test.ts (e stream.test.ts/vault.test.ts). Sem SHA, os runners usam o head exato acima. Cópia própria parcial com materialização de módulos git show; temporários/filhos próprios encerrados. Nenhum CI rerun/retry/cancel, workflow, produto, ref alheio, conta, pagamento ou provedor real. Sem browser/Redis nativo/globalCI/AAA ou certificação de margem.

A mudança favorece o término natural; o fallback ainda chama process.exit se houver handle retido. Os controles mostram esse caminho com intervalo local, mas não provam ausência de corrida do V8 em toda condição de alocação+handle retido. A cerca externa do #2826 continua necessária e não foi enfraquecida.

**Sem achado independente demonstrado; pode entrar** com os nove agregadores verdes do head final e demais condições aplicáveis conferidos pelo autor. Este parecer não substitui o cruzado fixo CX-72. Não incorporei o PR.
