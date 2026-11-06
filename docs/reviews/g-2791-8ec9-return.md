# Codex G — #2791 retorno do formato ZSCORE

Head EXATO8ec9eb79b8744d47ed26a465cffe77ab06038342, anúncio canal989d3721555f7331fedeca2aa66c131b9f05cfc3 antes de diff/testes. Todo delta2031a29b16b6e142c7c601de56cf776409bd5880..8ec9 lido: regex REDIS_SCORE e substituição de Number.isFinite no produto, mais teste permanente. O permanente g2791-refund-score.test.ts é idêntico à prova própria2f3d8af5b1f25e2ab500e3770774829de026e45c, salvo UMA linha de crédito; nenhuma expectativa alterada.

## Fechamento focal e MÉDIO residual

Vetores empty/spaces/hex do MÉDIO anterior FECHADOS: mesma prova congelada e permanente63/63 cada em cada modo (antes63/4 no2031). Envelope excedente63/63 cada e null legítimo62/62 cada.

**MÉDIO — nova regressão de finitude na mesma fronteira**, lib/paypal-sales.ts:68-69 e855-861. O novo regex aceita `"1e309"`, mas a verificação de número finito foi removida. Number("1e309") é Infinity; o texto não representa score finito. Mesmo assim, ele passa a contar como marca de reembolso do pagamento alternativo, causando HDEL real no stand-in, sumiço da compra paga e retirada da vigília. O comprovante Paid e a capture COMPLETED alternativos continuam reais; leitura saudável após1h não recupera o acesso. Não houve pagamento ou provedor real.

Prova própria tests/g2791-refund-score-overflow.proof.ts@69663ffc698c988e7c81f9a340f169e5dec25777, derivada da prova2f3d8af5 apenas acrescentando modos overflow/newline ao valor interceptado. AST das63chamadas estáticas is() preservada integralmente (rótulo, observação, expectativa); não reescrevi asserções. Só a resposta do ZSCORE do pagamento alternativo é interceptada, sem inventar Paid/HDEL/compra.

- Pai2031, mesma prova e modooverflow: **63/63**, injected=1, pagamento COMPLETED conserva compra e vigília.
- Atual8ec9, mesma prova e modooverflow: **63/4 falhas**, injected=1, imported=[], purchases=[], vigília do refund original removida e retry saudável não recria.
- Ambos alcançam exatamente o novo ZSCORE: esse par não depende de controle de instrumentação não atingido. É regressão da finitude no delta, não o M1 concorrente e não falha do teste.
- Hipótese adicional de newline foi exercitada e PASSOU63/63: descartada, não é achado.

Reprodução: G_SCORE_REPLY=overflow node tests/g2781-run.mjs g2791-refund-score-overflow.proof.ts. Manter o formato numérico e a finitude juntos, preservando desconhecido/revisita para os demais valores, evitaria esta aceitação.

## Controles e limites

- M1 concorrente ainda ABERTO/ADIADO por C4-1310: repeti neste8ec9 a mesma prova bf4842ee e continua63/2, como nos heads anteriores. Não agrava o cenário provado nem o fecha. O recorte separado da próxima unidade permanece aceito; não aprovo globalmente acesso.
- M2 da ordem dos reembolsos continua fechado: própria60/60 nestehead.
-10entradas ligadas: g2791-refund-order própria60; job-mismatch-SREM própria61; other-order-id61; paid-schema-batch62; ownership-pair62; final-reassign62; final-revoke62; paypal-sales67; paypal-sales-shape12; drop-enrollment-exact14. **523verificações registradas, todas aprovadas**, sem somar novamente como independência as mesmas fixtures repetidas.
- tsc --noEmit -p tsconfig.g2791-2031.json e configuração ampliada tsconfig.g2791-8ec9.json (inclui nova permanente e prova overflow): exit0. Sem TSglobal.
- ESLint lib/paypal-sales.ts tests/g2791-refund-score.test.ts: exit0, ZERO erros/SEIS avisos unused na fixture. Não chamar sem avisos.
- git diff --check2031..HEAD: exit0.

Condição #2781 antes/junto#2791 preservada. CallbackdropStart não comprova exclusão real da matrícula. Sem alteração de produto, reserva, ramo/base/CI alheio, incorporação, Redis nativo, navegador, provedor real ou certificação global de margem. C4 única coordenadora, C1 desligado. Saídas integrais docs/reviews/g-2791-8ec9-output.txt no ramo codex/g-review-2791-paid-ownership-return.
