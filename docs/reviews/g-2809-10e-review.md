# Revisão Codex G de #2809 — resolução com o main

Head EXATO10e7435d01a0dc861bf474d6a08ce3e4d68049da; base3361b84627e2a3e3010e2a83817c67ea5472f598. Retorno nominal C4-2030-G-120, lida integralmente. Anúncio no canal d1b30db4daedfcf5daf8c75dcd317e677197dd23 ANTES do código/testes; metadados exatos sem dois limpos no início, R1/12h51 creditado.

Li a resolução inteira de c472..10e em order-data e redis-reply e recompus a leitura do diff PRÓPRIO atual:9arquivos1619+/7-. Os4arquivos de produto foram lidos; os5testes são versões integrais já lidas, comparadas BYTE-ID à revisão anterior ou à prova própria completa após só a linha de crédito (inclui getter novo389linhas). Não afirmo ter auditado todo o main herdado nessa junção.

## Parecer: sem achado no retorno focal; ressalva herdada do #2806 FECHADA no head real

O helper lib/redis-reply.ts é AGORA blob**46519ad14e82a3e0f446a6a17fb236a2f552b686** do #2806/main: lê descritor de dados próprio e devolve cópia. Repeti no head REAL, pelo runner normal, **sem alias de união/snapshot substituto**:

- Mesma6419d32f (outer-getter): **68/68**, antes c47268/3. Getter de resposta desconhecida não roda; a ordem de reembolso permanece para nova tentativa, a matrícula é restaurada, a compra preservada continua abrindo o curso. Canônico copiado BYTE-ID após crédito também68/68.
- Externa dc41d0d767/67; interna cd3eee2167/67; controles saudável e aplicado/ACK perdido das3provas:68/68+67/67+67/67 em cada modo.
- Curso REAL65a22480:64/64. Preserva fechamento do M1 principal, sem chamar a antiga prova de HDEL com fronteira extinta de GREEN.

A condição de integração expressa no meu parecer5802735185/ee45264b6 está satisfeita por ESTE head. Não resta achado G no recorte #2809 nem necessidade de implementação duplicada do helper. Isto não é certificação global do main, ativação, CI ou incorporação feita pelo G.

## Resolução do conflito conferida

Do main permaneceram o envelope externo exato e **charged por countOf**, inteiro nativo>=0. Deste ramo permaneceram a assinatura readScript(reply, commands), o número de respostas por chunk e a checagem HSETNX exatamente0ou1. O envelope desconhecido dá undefined e readScript lança; não vira custo0 nem confirmação.

Ampliação identificada tests/g2809-charged-receipt.proof.ts@**a4dc6e1d920907496543d2322976c65042e937e6**: mesmas67asserções do fluxo real de restauração, só muda o campo charged da resposta não aplicada para null, texto“0” ou fração0.5, com recibos internos de domínio plausível. **67/67 em cada um dos3casos** no10e: desconhecido mantém a ordem e uma retomada saudável recupera. MESMOS bytes no pai c472, caso null: **67checks/2falhas**, pois a coerção antiga aceitava Number(null)=0. Não alego RED dos2outros modos no pai, que não executei ali. A prova cobre o consumidor real da resolução, não só um parser isolado.

## Validação executada

Manifesto atual de57consumidores diretos de learn/order-data/paypal-delivery/paypal-sales, acrescido de3custo/memória: **60arquivos/2598checks customizados+94node PASS**,1teste Redis7SKIPPED. O skip nativo não foi contado como execução. As repetições focais e provas próprias ficam separadas desse total, sem multiplicar independência. O manifesto foi refeito no head atual; não usei a lista anterior44/45como se cobrisse o main integrado.

tsc -p tsconfig.g2809-10e.json:exit0,13raízes/imports recorte estrito, não global. eslint4paths:exit0,0erros/12avisos de imports não usados nas cópias da fixture. git diff --check0. Produto rastreado intocado na cópia destacada /tmp/g2809-return-10e, apenas provas/config próprios não rastreados. Nenhum timeout/asserção afrouxados ou retry de CI.

Custo próprio do script (EVAL+SMEMBERS+HGET+HDEL, até4comandos por take-back) e a contagem correta do R1 permanecem. A validação da resolução não acrescenta chamada de provedor, novo preço/limite/flag/trava. plan-cost-registry foi executado; não certifico lucro geral no pior mês nem cobrança real e não trato custo desconhecido como zero.

Ramo próprio codex/g-review-2809-concurrent-payment; prova a4dc6e1d, config033d7ff4bf0abfab9ee8b5701b9aeef9fd0f273a. Saídas docs/reviews/g-2809-10e-output.txt@8f1ed01c3fda88717e3012c8ba4f7aa735cd23b7; manifesto docs/reviews/g-2809-10e-writer-manifest.json@b69ef6a3fb66a9d9019da9829c94c023a0ed22cc. As provas antigas e os REDs anteriores continuam legíveis no mesmo ramo e nos relatórios anteriores.

Sem Redis/Lua nativo G, Upstash, provedor/conta/pagamento real, browser/AT, build/CI global ou merge. A ordem C4-2030 (#2791 entra após liberação V, depois #2809 com base main) permanece responsabilidade da autoria/coordenação; não movi base, head, reserva ou CI de ninguém. C4 única coordenação/C1 desligado; revisão independente adicional preserva CX72.
