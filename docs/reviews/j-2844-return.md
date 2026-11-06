# Retorno financeiro #2844 — Codex J

Head nominal confirmado pela API antes do diff: **7b1baef666538d2a527afb22e3dca3ded947c3af**, aberto, quatro arquivos, base 2bfa8ade8f59555b8d57aa03e554a99092a1285b. Claims do root precederam a nova leitura e os ensaios. Após aviso de limite global da API, nenhuma chamada adicional à API foi feita nesta unidade. A publicação fica pendente de recuperação; os resultados pertencem somente ao head nominal testado.

**Parecer: não pode entrar.** O recorte do GRAVE original do Revisor 1 foi corrigido nos ensaios de barreira e concorrência, mas os dois MÉDIOS anteriores de payday/metadado continuam reproduzidos. Há ainda um MÉDIO novo no leitor do ledger legado: JSON ilegível no HGETALL é ignorado e permite contar duas vezes um pagamento real do fixture.

## Recorte do GRAVE original — corrigido nos casos exercitados

A descoberta original é do Revisor 1; J fez a confirmação independente no head anterior. Agora o ledger é gravado antes da marca, com id determinístico por item PayPal e HSETNX. Foram exercitadas respostas desconhecidas, aplicadas e não aplicadas, em cada uma das três novas barreiras relevantes: reserva needData, escrita HSETNX e marca SET NX. Os seis casos recusaram a primeira liquidação, preservaram a reserva pendente e, após retry saudável, deixaram exatamente **3000 cents, uma entrada no ledger e um único batch sintético**. Duas liquidações concorrentes reais também escreveram uma entrada e não enviaram outro batch.

O controle de migração chama addPayout real para produzir a entrada legada de id aleatório com referência PayPal; uma leitura saudável a reconhece sem duplicar. A prova também confirma a recuperação quando a marca é incerta depois da escrita do ledger. Isso fecha os vetores originais exercitados; não certifica toda falha de Redis ou todo comportamento do sistema.

Uma reserva cujo ACK se perde pode ficar contada além do uso: no caso needData aplicado, o slot terminou com **576** para uma entrada que pesa **288**; HSETNX não aplicado depois da reserva também deixou 576 no retry. É o comportamento conservador explícito do código, não redução de custo ou prova de restituição exata. Não criei contador/cota para forçar esse resultado.

## MÉDIO novo — ledger ilegível vira ausência de referência e duplica o livro

Local: lib/affiliates.ts, bookedPayouts, linhas1293–1303; bookPayPalPayout, linhas1321–1328; chamada em lib/paypal-payouts.ts:497.

bookedPayouts valida somente envelope, lista de strings e quantidade par. Insere o field em ids antes de parsePayout e ignora o caso parsePayout=null. Uma linha legada de id aleatório com payload ilegível deixa de fornecer sua referência; o livro é tratado como não contendo aquele item e ganha outra entrada determinística.

Reprodução causal: connectPayPal/payWithPayPal e addPayout reais criam um batch sintético e um lançamento legado de **3000 cents**. Somente a resposta de um HGETALL é alterada: preserva-se o field real e o valor JSON é devolvido como `{`. O lançamento durável original continua intacto. settlePayPal aceita o resultado e grava outra entrada: **paid=6000, entries=2, away=[]**. Controle saudável: **paid=3000, entries=1**. Um HGETALL com field determinístico real e payload ilegível também é aceito como booked em vez de unknown; o terceiro assert cobre esse mesmo leitor.

A extensão tem **31 verificações, três falhas esperadas**: duas do ledger legado ilegível e uma da aceitação do payload determinístico ilegível. Os demais28 checks de barreira, retry, concorrência e migração saudável passam. Não houve segundo pagamento real observado; o efeito demonstrado é duplicação contábil sintética, que pode reduzir indevidamente a dívida calculada para pagamentos futuros. Exigir validação de cada registro e coerência entre field/id/referência antes de usá-lo como prova, preservando unknown, precisa de correção do autor.

## Dois MÉDIOS anteriores continuam presentes

1. **Payday:** o claim mensal é consumido em lib/affiliate-payday.ts:187 antes de paysAutomatically. Um GET desconhecido do vínculo faz a passagem falhar com failed=1, mantendo claim="1"; a passagem saudável seguinte não tenta pagar nem envia aviso. Controle saudável despacha um batch sintético.
2. **Consentimento automático:** readLink continua validando apenas client/secret. `auto:"false"`, 1, objeto e lista viram true em paysAutomatically; null vira false conhecido. Com auto="false", sendPaydayEmails real despachou um batch sintético. Nenhuma disposição documental fecha esses resultados.

## Replay integral das provas e interpretação das expectativas antigas

Os dois arquivos originais e o runner permanecem integrais em a1e08f4bb630d6d3fa1e1a01aab5a84583b82c82. O novo runner lê seus bytes via git show, sem editar as fontes:

- settlement: blob **2ff3236a7218ead263b3f816e402521e3a1f5939**, 15 verificações / nove falhas;
- payday: blob **b883a3938fafccc6d9b0496378b613351e81d0ed**, cinco verificações / três falhas;
- runner antigo: blob **719dc147161b1231d0f7a1bb75e19ceb51f6bd8d**, preservado.

Total original: **20 verificações,12 falhas**, sem afrouxar assertivas. Quatro falhas não são defeitos do novo produto: as provas antigas pressupunham que não haveria lançamento antes da marca e interceptavam HSET; o produto agora grava primeiro e usa HSETNX, logo aquele interceptor não é alcançado. As oito restantes cobrem os dois MÉDIOS acima, incluindo os cinco valores malformados de auto, um despacho automático e duas falhas de recuperação do payday. A persistência desses20/12 não significa que o GRAVE original continue aberto.

## Permanente, ligados e verificações

O permanente do autor é byte a byte idêntico no RED 5d13eb011 e no head (blob **9c2beec97d4a79c5e8ca2a8de9263e3943738144**). O arquivo inteiro faz **151 verificações,17 falhas** no RED e **151/151** no head.

Seis ligados: paypal-payouts49, paypal-payouts-unknown45, paypal-payouts-reconcile43, pending-payouts33, affiliate-payouts22, affiliate-pending-payouts-render2: **194/194**. Com o permanente: **345/345**. A extensão e o replay original ficam separados desses verdes.

TypeScript strict/noEmit com tsconfig herdado e imports reais de affiliates, paypal-payouts, payday, página, permanente e prova: **zero diagnósticos**. ESLint dos arquivos de produto, permanente, prova e runner: **zero erros e zero avisos**. Scanner tracked: **4105 arquivos, zero ocorrências**. Scanner explícito dos quatro paths próprios: **zero ocorrências**; diff-check de produto e whitespace dos quatro paths: aprovados.

O novo HGETALL lê o ledger inteiro uma vez por liquidação com item pago. Não adiciona família de chave: usa o payout hash/slot aff:payouts existentes e needData antes de cada nova escrita. Não encontrei paginação, limite próprio ou admissão por tamanho na chamada bookedPayouts; bookSizes/bookSize existentes pertencem a outros leitores. O delta não altera o registry de custos, cuja linha integrations contém uma cobertura genérica de chamadas. **Não foi demonstrado nesta revisão um teto numérico novo de volume/tempo/custo por liquidação**, nem fiz ensaio no tamanho máximo do plano. Não trato isso como custo zero ou validação econômica aprovada; é lacuna a esclarecer, sem inventar um segundo efeito causal.

## Isolamento e limites

Antes de cada execução, um wrapper instala MockAgent.disableNetConnect no dispatcher da mesma undici do SDK, recusa fetch global, bloqueia sockets TCP/TLS/UDP e DNS. Os controles negativos verificam socket bloqueado e destino não registrado recusado localmente; falha em qualquer controle encerra o filho **antes de carregar o grafo do produto**. Os fixtures então substituem fetch apenas por respostas sintéticas PayPal/Stripe. Todos os controles passaram; nenhum fornecedor real foi chamado neste retorno.

A cópia privada estava clean antes do checkout nominal. Seu symlink antigo de dependências estava quebrado: o primeiro runner parou por esbuild ausente, antes do produto. Somente o symlink privado foi substituído pelo destino compartilhado já autorizado; os módulos compartilhados não foram editados.

Não rodei navegador, Redis nativo, fornecedor/conta real, pagamentos reais, publicação ou CI. Não alterei produto, ramo do autor, workflow, preço, limite, comissão, flag ou trava. A evidência não reutiliza o protótipo externo descartado da tarefa2807. Artefatos pertencem à branch própria existente; a publicação depende apenas da recuperação do limite da API.
