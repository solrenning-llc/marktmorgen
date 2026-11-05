# Codex G — #2681, head 1e3c6bfb3f03b15543f2961f4f9fd2bd57aad4e7
Parecer independente, primeira revisão financeira. H2 controla a segunda. Retorno sobre a2fa6d00; todo o delta de 10 caminhos foi lido, incluindo integrações de main dos contadores AI/outreach. Nenhum produto, ramo, CI ou reserva do autor foi alterado.

## Resultado
Os achados graves/médios anteriores nos vetores executados continuam fechados. O envelope mensal extra e o getter/posição herdada também estão fechados: mesma prova de envelope 4/4; teste final do autor, blob 605d9f0db7d6a7ac46c8e4d8d63fd75e9f796ed5, RED b81558ee 40/4 falhas -> head 40/40.

LEVE residual, latente: lib/paypal-payouts.ts:329–335, payoutUnknownMonth aceita um Proxy de array tanto externo quanto interno e executa traps de leitura/reflexão. Prova opt-in g-2681-month-proxy.proof.ts: 5 verificações, 4 falhas; controle normal verde; Proxy externo retorna {unknown:1,settled:2,manual:3} e dispara 2 traps; interno, o mesmo resultado e 4 traps. Esperado desconhecido/null e zero reflexão. A leitura .then da assimilação da Promise é excluída do contador. Pesquisa em app/components/lib encontra só a declaração, sem chamador de produto. Não é prova de exploração por JSON remoto nem de saída de dinheiro; não atribuo impacto financeiro atual. Para fechar a fronteira, recusar Proxy antes de Array.isArray/leitura/descritor, preservando controles próprios válidos.

HMAC: prova adicional independente 7/7: assinatura exata sob deriveKey('paypal-payout-receiver/v1'), distinta de SHA256 simples; endereço não persistido; mesmo destinatário/segredo recupera um único pagamento. O segredo sintético é removido durante o token, antes de guardar o lote: não grava r nem substitui por endereço/hash simples; com segredo restaurado a recuperação vira manual sem novo POST e mantém os dois afiliados excluídos. Nada saiu para provedor.

## Execução no head exato
- g-2681-month-envelope:4/4; blank-refusal:51/51; recipient-manual:22/22; recipient-legacy:43/43; reconcile-refunds:24/24; reconcile-promotion:26/26; sales-recovery:13/13; meta-cost:26/26; author reconcile:40/40; HMAC:7/7.
- Novo residual Proxy:5 verificações/4 falhas (esperadas como achado aberto).
- Nove ligados: pending-payouts33, affiliate-payouts22, paypal-payouts49, paypal-sales66, meta-ads105, plan-cost-registry24, plan-margin39, affiliate-reversals18, store-data-registry7:363 verdes.
- Integrações adicionais de main: ai-counter-admission14 e outreach-counter-admission25, ambas verdes.
- ESLint do módulo/teste corrigido/duas provas novas/runner: zero; git diff --check:zero; scanner público:3806 arquivos rastreados/zero.
- Launcher mkdtemp próprio por execução; provas só na cópia detached. Sem Redis nativo, navegador, provedor real, CI ou tsc global. Erros de provedor sintético esperados nos testes negativos não são pedidos reais.

Comandos: node tests/g-2681-run.mjs <arquivo(s)>; python scripts/check_public_data.py; node_modules/.bin/eslint lib/paypal-payouts.ts tests/paypal-payouts-reconcile.test.ts tests/g-2681-month-proxy.proof.ts tests/g-2681-hmac.proof.ts tests/g-2681-run.mjs. O parecer não libera outro head, não substitui H2 nem os gates de integração.
