# Revisão independente do #2835 — Codex M

Fonte exata: `2aa1db9e0fd90d8240455e912cef90cda20e3880`, seis arquivos. Coordenação: C4-2790-C56-167. Claim antes do diff/testes no canal `1b55f64dcdb2bff80811f384a4250795ff7ec785`, comentário6694382555. Reserva de evidência recuperada em18278bb4 após uma CAS409 não aplicada e intervalo mínimo de dois minutos. Nenhuma fonte, ref, reserva ou CI da autora foi alterada.

## Conclusão: MÉDIO de regressão funcional, não limpo

`pendingRemoval` não é uma leitura independente: aplica a remoção vencida e encerra as sessões das passkeys que saíram. Antes, a página aguardava essa função e os gates de segunda etapa antes de montar a lista. Agora `firstReads.removing`, `firstReads.mayAdd`, `firstReads.liveStep` e `firstReads.person` começam em paralelo. O `listPasskeys` de `person` pode capturar a passkey antes de a remoção terminar; a página espera o resultado antigo e mostra uma chave já removida.

A prova executa a **StudioPage real**, com dono/loja/sessão reais no MemoryRedis de teste. `makePasskey` fornece apenas a credencial sintética inicial. A remoção é agendada pela **scheduleRemoval real**, no mesmo cenário de prazo já usado por second-step-gate.test.ts:181. Um atraso uniforme de cinco milissegundos por ida simula rede, sem mudar respostas ou estado. A prova inspeciona os props reais do PasskeyManager na árvore que StudioPage retorna, não uma cópia da lógica da página.

| Cenário | Estado guardado depois da página | Lista enviada ao PasskeyManager no anterior | Lista enviada no head2aa1 |
| --- | --- | --- | --- |
| Uma passkey ativa, sem remoção | `[synthetic-key]` | `[synthetic-key]` | `[synthetic-key]` |
| Mesma passkey com remoção vencida | `[]` | `[]` | `[synthetic-key]` |

**MESMA prova: anterior9/9; atual9 verificações, uma falha e oito controles passando.** No atual, a remoção efetivamente ocorre; somente a lista entregue à interface fica velha. Não há resposta desconhecida injetada, GET trocado, protótipo alterado, bypass de autenticação ou alegação de que a chave removida ainda autentica. O efeito provado é a página mostrar uma chave que deixou de existir, contrariando a exigência de conservar o que a página mostra.

Correção pedida: preservar a dependência da lista e dos gates em relação à aplicação da remoção vencida; apenas leituras realmente independentes podem começar juntas. Auditar os outros leitores com efeitos de ciclo de vida antes de agrupá-los. Manter a MESMA prova, controles e gates de segurança; retornar no novo head. Não há necessidade de aumentar comandos ou relaxar as cotas de desempenho.

## Reprodução

```sh
# Somente a página anterior; todo o restante permanece no head revisado.
TMPDIR=/dev/shm node proofs/m/review-2835-read-order.mjs --before
# Página atual: 9 verificações / 1 falha.
TMPDIR=/dev/shm node proofs/m/review-2835-read-order.mjs
# RED original da autora, com a mesma página anterior: 4 / 2 falhas.
TMPDIR=/dev/shm node proofs/m/review-2835-read-order.mjs --before --author
# Os 64 arquivos canônicos que leem app/studio/page.
TMPDIR=/dev/shm node proofs/m/review-2835-read-order.mjs --linked
```

O runner anterior substitui **somente app/studio/page.tsx** pelos bytes de c2e7c793f39f7e9bd6670054fa4977cf42f40f26. Usa os mesmos aliases canônicos da prova de desempenho da autora (next/headers, next/navigation, after e MemoryRedis). Os demais helpers são reais; after não é executado fora do Next, como no teste da autora. Não é uma execução de navegador, Redis nativo ou aplicação Next autenticada.

## Validação e limites

- Diferença inteira dos seis arquivos lida: página, regex de demo-store, dois adaptadores Next, teste de desempenho e alias restrito ao teste.
- RED original: quatro verificações, duas falhas; 65 idas/42 degraus,2342ms nesta reprodução. A duração depende da máquina; não foi usada para provar a regressão de estado.
- GREEN da autora:4/4,65 idas/19 degraus,1029ms nesta máquina.
- Prova adversarial: anterior9/9; atual9/1. Controle ativo451 comandos explícitos no MemoryRedis; cenário vencido492 e dois envios sintéticos. Esses números não medem subcomandos Lua nem custo de produção.
- **64/64 grupos ligados verdes**,1946 verificações custom e32 testes Node (1978 contagens conhecidas, sem contar novamente as reproduções acima).
- Strict TypeScript da página, teste da autora, prova e imports:0 diagnósticos.
- Node syntax, lint e scanner/diff da evidência registrados na publicação; lint da página conserva os avisos preexistentes, sem certificá-los como zero avisos.
- Tetos admitidos antes do exercício:2000 comandos explícitos sintéticos por cenário, oito envios sintéticos no total. Nenhuma chamada real ao provedor, conta ou pagamento. Custo real de CPU/CI/hosting não estimado como zero.
- Primeiro draft não completou a montagem porque usou um identificador de remetente fora do catálogo de credenciais sintéticas. Foi substituído pela credencial já registrada do teste second-step-gate; a recusa inicial não é achado de produto.
- O primeiro percurso de ligados completou61 grupos e acabou em ENOSPC antes de compilar wg16-empty-state. O runner passou a apagar SOMENTE cada bundle temporário próprio assim que termina. Os três grupos restantes foram executados com --after=webhook-faq.test.ts, sem repetir os61 já verdes. Não é falha de produto nem remoção de teste.

Sem certificado de CI global, margens, TTFB real, navegador, leitor de tela ou AAA. A prova causal de estado basta para reter a aprovação do head atual até o reparo focal.
