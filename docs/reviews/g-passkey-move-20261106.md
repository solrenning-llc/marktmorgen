# Codex G — auditoria focal de passkeys, 06/11/2026

Snapshot auditado: `f6359ae3df649b690d8dbb5cc8ffdca48172179d`.
Comparação histórica: `4bb50dcf835a4ccd66df605ed3e6f420f562ba1b` (#2244).
#2244 já foi incorporado (head final `4be841a2f999dc56ac4c315fcf4b515d0ad23dec`, 05/11/2026 02:04:01 UTC).
Esta é uma auditoria do vetor, não revisão integral do PR ou liberação global do main.

## Disposição antiga: fechado no snapshot auditado

A mesma prova `tests/g-passkey-move.proof.ts`, blob `c066a2765eefd2952dca544e1d24f3a9c5b58489`, executada sem modificar produto:
- histórico 4bb50dcf: **62 checks / 16 falhas**;
- main f6359ae3: **62/62**.

Um e dois credenciais; falha antes de escrever; EVAL efetivamente aplicado com exceção, [] ou [null]/[false] depois. A injeção confirma o comando real de fenced-set, id alvo e endereço destino e executa o MemoryRedis antes de perder a resposta. Cada caso confere recusa, listas, todos os índices e signInWith real usando P-256 gerado no teste e SimpleWebAuthn real. Controle sem falha transfere lista e login.

Causa corrigida: movePasskeys registra tried.push antes de fencedSet, e o rollback restaura todos os índices tentados. O histórico local identifica b12fe3829 como correção, e b3f220c3a acrescenta a separação confirmed/tried. Não atribuo a correção a código que não li.

## MÉDIO distinto: leitura desconhecida vira lista vazia e o move apaga/sobrescreve passkeys

**lib/passkeys.ts:136–142, 160–163; consumo em 819–820, 836–838, 847–860.**

listPasskeys desestrutura GET sem conferir cardinalidade; parseList retorna [] para undefined, booleano ou texto JSON fora do esquema. movePasskeys usa isso como prova de ausência.

Reprodução:
1. Manter uma passkey válida em source; destino sem passkeys.
2. Somente o GET da lista de source, dentro de movePasskeys, retorna **[]**, **[false]** ou **['{}']**, uma vez.
3. movePasskeys resolve como moved, apaga a lista verdadeira de source e não mantém lista em destino. Restaurada a leitura íntegra, signInWith com assinatura válida retorna null.
4. Variante: source e destination têm passkeys próprias; somente GET da lista destino retorna a mesma resposta desconhecida. A guarda holdsPasskeys libera, a lista destino é sobrescrita pela lista source e a passkey original do destino deixa de entrar. Não demonstrei obtenção indevida de sessão, nem alego bypass de autorização.

A mesma prova em modo desconhecido, **G_PASSKEY_UNKNOWN=1**, resulta **41 checks / 24 falhas causais / 17 controles verdes**, tanto no histórico 4bb50dcf quanto no snapshot atual. É defeito preexistente distinto, não regressão atribuída ao corretivo do índice.
Controles: destino comprovadamente ocupado recusa sem modificar listas; leitura que lança recusa e conserva source. A injeção desconhecida atinge exatamente uma leitura. [] é transportável pelo redisPipeline atual: resposta HTTP JSON [] é mapeada para []; [{result:false}] vira [false]. Só inspecionei esse mapeamento, sem HTTP/Redis nativo.

Recomendação: leitor exato para decisões destrutivas de passkeys; exatamente um slot, null conhecido é ausência, texto só após schema completo, desconhecido lança antes de mover, apagar ou sobrescrever. Não reduzir um item ilegível a uma lista parcial. Não alterar preço/limite/trava/política. O revisor não implementou correção nem reservou produto.

## Validação executada

- second-step-gate: **201/201** (inclui C3-117 e login posterior).
- passkey-signin-response48, passkey-app-code-invite64, two-step46, recovery-address44, move-members41: **243/243**.
- lock-acknowledgment: **7/7 node:test**.
- Total ligados: **444 checks + 7 node:test = 451 aprovados**, zero falhas/skip.
- Prova original adicional:62/62, total verde incluindo prova513.
- Prova desconhecido:41/24 falhas como descrito; nenhuma asserção relaxada.
- TypeScript strict do recorte/imports/prova:0; ESLint prova/launcher:0; git diff --check:0.
- Sem build/verify/CI global, scanner global, navegador, Redis nativo, conta/provedor/pagamento real. MemoryRedis substitui somente Redis; global fetch lança. Não afirmo teste de rota HTTP integral nem revisão de todo o main.

Reproduzir na cópia do snapshot com dependências:
```sh
node tests/g-passkey-run.mjs g-passkey-move.proof.ts
G_PASSKEY_UNKNOWN=1 node tests/g-passkey-run.mjs g-passkey-move.proof.ts
node tests/g-passkey-run.mjs second-step-gate.test.ts passkey-signin-response.test.ts passkey-app-code-invite.test.ts two-step.test.ts recovery-address.test.ts lock-acknowledgment.test.ts move-members.test.ts
```

Ramo próprio `codex/g-audit-passkey-move-20261106`; somente provas/launcher/relatório. A prova mantém o mesmo blob ao copiar para o histórico. Evidência RED não entra automaticamente em *.test.ts. CX-72 preservada; nenhum produto, reserva, ramo/CI alheio ou merge.
