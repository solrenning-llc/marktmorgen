# Codex G — #2806: retorno dos recibos

Head: adee9d1baea65ad341f5faf5b831dc4cdcb9a52d. Delta 4304ea78b2b788e61d9562fd8a4e60a29e70cae1..adee integralmente lido: 3 arquivos, 110 adições/9 remoções (redis-lock, redis-reply, novo teste canônico). Nenhuma edição de produto pelo G.

## Resultado

MÉDIO original dos recibos EVAL fechado: prova própria congelada 2804bb8379fdfd51dc4d8859e76fbd99ed6c839b, sem alterar bytes nem expectativas, repetida no pai 4304 (18 verificações/10 falhas) e no atual (18/18). Getters deixaram de executar; excedente, accessor e índice herdado não confirmam hold/write/delete. Canônica nova lock-receipt-exact.test.ts: 35/35, incluindo buraco e aquisição malformada; lock-release-atomic: 31/31.

LEVE adicional, condicionado a poluição prévia de Object.prototype: lib/redis-reply.ts:33-34 verifica `"value" in slot`, aceitando propriedade herdada do descritor. Com Object.prototype.value=1 e reply[0] sendo accessor próprio, Object.getOwnPropertyDescriptor retorna descritor sem value próprio, mas o teste passa e slot.value herda 1. A mesma resposta passa a [1]; holdLock, setIfHeld e deleteIfHeldOnly retornam true sem EVAL aplicado. Prova tests/g2806-descriptor-prototype.proof.ts@a586f20dadc43ad641926b7b501158dc0237b3a9: atual 6 verificações/4 falhas; pai 4304, mesma prova, 6/5 (também chamava o getter). O dono legítimo e o registro real continuam intactos. É uma fragilidade herdada sob a condição de protótipo já poluído, não nova regressão nem prova de exploração remota: não demonstrei caminho do produto que polua Object.prototype, alteração efetiva de produto, vazamento ou dinheiro. Comparar propriedade própria do descritor evitaria essa aceitação. Sem alegação de correção pelo G.

## Outros limites adversariais e testes

- Prova própria g2806-parser-boundaries.proof.ts@d2d704917c10c182d0a18cb0fbe0a41dce95aea8: 18/18. Cópia não muda quando a origem muda, getter que lança não executa; Proxy revogado e Proxy cujo descritor lança não confirmam hold/write/delete; release não lança e não há comando separado de fallback. Não afirmo que repliesFor sozinho nunca lance em Proxy, nem que rejeite todo Proxy.
- 12 entradas ligadas backup-run, lease-confirmation, lock-acknowledgment, claim-mark, tb14-claim-marks, order-data, l6-checkout-sweep-exact, l6-payment-recovery-exact, picture-door-ack, segments, group-buy, payment-recovery: todos processos exit 0; 297 verificações customizadas +9 testes node, nenhum fail/skip.
- 13 entradas adicionais gifts, preorders, outreach, outreach-counter-admission, team-roles, team-two-step, team-two-step-session, erasure-list-evidence, erasure-grant-shape, erasure-store-read-evidence, delivery-watch, delivery-check-rules, auth-mail-unavailable: todos processos exit 0; 373 verificações customizadas +29 testes node registrados, nenhum fail/skip. As contagens são das saídas efetivas, não uma contagem de todas as asserções por arquivo.
- tsc --noEmit -p tsconfig.g2806-adee.json (config b782d00040dcdf30c665e05cd778fb43e9494897), ESLint nos 7 arquivos de produto/testes envolvidos e git diff --check 4304..HEAD: exit 0.
- Mapeei as referências ao parser em 22 módulos consumidores além de seu próprio arquivo; os testes acima cobrem parte desses consumidores. Não alego auditoria completa dos 22 módulos.

A corrida antiga GET+DEL permanece fechada condicionalmente à incorporação do #2806 antes/junto do #2721. A união própria #2721+helpers no parecer anterior passou 93/93; não repeti a união neste retorno, porque este delta é de parser/recibos e o retorno não reabre fallback. Não substituo o resultado da prova original de rotas no main isolado por GREEN. Sem Redis nativo, provedor real, navegador, CI global ou build; sem certificação global de margem/segurança. C4 única coordenadora, C1 desligado.

Comando de reprodução em cópia própria com runner g-proof-run.mjs previamente preservado: node tests/g-proof-run.mjs g2806-descriptor-prototype.proof.ts. O teste altera Object.prototype somente no processo isolado e restaura no finally. Saídas completas em docs/reviews/g-2806-adee-output.txt no mesmo ramo. Provas não corrigem produto.
