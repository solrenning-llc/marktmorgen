# D10 — envio aceito antecipa o lead do Path

Autorização nominal C4, reserva de canal `ef0ccdd1666638325c5d5737012450859bdcb57d`. Prova independente somente; nenhuma implementação de produto. Base congelada `2bfa8ade8f59555b8d57aa03e554a99092a1285b`, tree `3298708dd28b4342286fa86241e367f7fbc8fdbf`. Fila blob `12c016ae20b80ed5dbe9344bb44a38f30a42983f`, lote blob `174fb192e648b00cefed2e9e545e7c2227eb2b17`.

## Reprodução causal

Executar da raiz: `node scripts/j-d10-confirmed-lead.mjs`.

Resultado preservado: exit 1, 25 checks, 22 aprovados e três falhas do contrato D10:

1. POST real de inscrição aceita um email sintético, mantém o contato ausente e seu token ainda válido; o leitor real do Path já mostra **1**, embora o esperado antes de confirmação seja **0**.
2. Segundo POST para o mesmo endereço aceita outro email e produz token distinto; nenhum token foi confirmado, mas o Path mostra **2**, esperado **0**.
3. A confirmação POST real grava o contato e consome o primeiro token; há um endereço confirmado, mas o Path continua em **2**, esperado **1**.

Controles aprovados: estado inicial zero; honeypot e email inválido sem envio/contagem; grant realmente persistido e endereço ausente; leitura simples do grant não confirma; token inválido recusado; confirmação válida; contato com acordo explícito; token consumido recusado; segundo token do mesmo endereço não aumenta a contagem já existente; envelope Redis `[]` no GET exato do token recusa confirmação, exercita a injeção e mantém endereço ausente e contagem anterior. Foram três POSTs de email interceptados e zero pedidos HTTP inesperados. Os números inflados anteriores permanecem visíveis: o controle unknown não afirma que o acumulado seja correto.

As duas rotas reais são `app/api/store/join/route.ts` e `app/api/store/join/confirm/route.ts`. O produtor real chama `countHit -> recordHit`; o consumidor real é `readPathFacts`. Não há HSET de `fs:*`, réplica do cálculo, substituição do escritor ou alteração do Path na prova.

Causa na base: signup chama a contagem ao receber `sent` (`app/api/store/join/route.ts:68–70`); `lib/stats.ts:169–175` escreve `fs:*`; `lib/path-facts.ts:152–161` soma esses campos. A confirmação já existe, mas não constitui a origem dessa contagem. A prova cobre a caixa de inscrição; não executa as jornadas de produto gratuito e lista de espera.

## Limites e proteção

O runner reutiliza `testAliases("store-join.test.ts")` e `testEnvironment` do main. Redis é o MemoryRedis canônico, dentro de um processo Node isolado; não certifica Redis nativo/Lua real. O transporte Resend mantém a fixture canônica com o guard/validador real e conta/revisão/ACK/HTTP sintéticos. Somente `next/server` recebe o adaptador existente de after; a prova executa os callbacks retidos para observar o escritor real. Não representa execução hospedada dentro de um servidor Next.

O fetch é interceptado: apenas POST sintético em `https://api.resend.com/emails` recebe resposta; qualquer outra requisição lança erro. O runner descarta configurações herdadas AWS/SES/Resend/Stripe antes do subprocesso e a prova usa uma credencial sintética já inventariada. Nenhuma conta, entrega real, pagamento, chave produtiva, servidor, navegador, flag, preço, limite ou gate foi alterado.

O objetivo deste ramo é manter RED reproduzível para decisão da C4. A correção exige combinar arquivos ocupados e tratar origem confirmada, repetição/concorrência, histórico e custo; este ramo não introduz novo contador nem aprova custo zero. O próprio desenvolvimento/CI permanece custo desconhecido, não zero. A primeira preparação do harness corrigiu três expectativas de redirect sem grant: pela rota real, esse caso vai a `/` sem query de status. As três asserções D10 acima permanecem intactas.

## Verificação

Primeira execução causal final: 25 checks, 22 aprovados, três falhas D10, exit 1. Tipos, lint, scanner, diff e dirigidos pendentes após preservação inicial da prova.
