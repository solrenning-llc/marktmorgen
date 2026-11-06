# Codex G — #2806 retorno final do descritor

Head bc9d2ade34b44505714a23af4050759af68a0366. Anúncio no canal 98cfd97d36ab42f976a278ae22d160f08c1c5839, após retentativa legítima do 409 não aplicado. Todo delta adee9d1baea65ad341f5faf5b831dc4cdcb9a52d..bc9 lido: lib/redis-reply.ts exige Object.hasOwn(slot, "value") e teste permanente cobre o protótipo previamente poluído; duas paths, nenhum outro produto.

Sem achado no retorno nominal. O LEVE condicionado a Object.prototype.value está FECHADO. Mesma prova própria a586f20dadc43ad641926b7b501158dc0237b3a9, bytes e expectativas preservados: adee 6 verificações/4 falhas (executado e salvo em 8d8bee6c); bc9 6/6. Array accessor com protótipo poluído retorna null e não confirma hold/write/delete; getter não executa e dono legítimo/registro intactos. Pré-condição de poluição global era explícita; não alego exploração remota.

Reexecutados nesta cópia própria detached /tmp/g2806-return-bc9:

- Prova original de recibos 2804bb83: 18/18.
- Limites getter/Proxy/snapshot d2d70491: 18/18.
- Canônicas lock-receipt-exact:39/39 e lock-release-atomic:31/31.
- backup-run96/96, claim-mark5/5, tb14-claim-marks21/21.
- lease-confirmation2/2 node e lock-acknowledgment7/7 node; sem fail/skip.
- Total desse comando: 234 verificações customizadas +9 testes node, todos processos exit0, incluindo as três provas próprias. Não somar novamente como verificações independentes.
- tsc --noEmit -p tsconfig.g2806-adee.json (mesma config b782d00040dcdf30c665e05cd778fb43e9494897): exit0.
- ESLint lib/redis-reply.ts tests/lock-receipt-exact.test.ts: exit0, sem diagnóstico.
- git diff --check adee..HEAD: exit0.

Comando: node tests/g-proof-run.mjs g2806-script-envelope.proof.ts g2806-descriptor-prototype.proof.ts g2806-parser-boundaries.proof.ts lock-receipt-exact.test.ts lock-release-atomic.test.ts backup-run.test.ts lease-confirmation.test.ts lock-acknowledgment.test.ts claim-mark.test.ts tb14-claim-marks.test.ts.

MÉDIO EVAL anterior permanece fechado pelas mesmas provas; relação #2806 antes/junto #2721 preservada. A união de rotas #2721+helpers 93/93 foi executada no retorno4304 anterior, não reexecutada neste delta; não alego GREEN da prova original no main isolado sem #2721. O grupo ampliado dos consumidores do parser foi executado no adee e não repetido inteiro no bc9. Não certifico CI global, build, Redis nativo, provedor real, margem global ou todas as jornadas.

Nenhum achado G restante no #2806 após este retorno. Sem edição de produto, reserva, ref/base/CI alheio ou merge pelo G. C4 única coordenadora, C1 desligado. Saída completa docs/reviews/g-2806-bc9-output.txt no mesmo ramo codex/g-review-2806-lock-receipts.
