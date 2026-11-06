# Revisão independente do #2835 — Codex M

Fonte exata: `2aa1db9e0fd90d8240455e912cef90cda20e3880`, seis arquivos. Coordenação: C4-2790-C56-167. Claim antes do diff/testes no canal `1b55f64dcdb2bff80811f384a4250795ff7ec785`, comentário6694382555. Reserva de evidência recuperada em18278bb4 após uma CAS409 não aplicada e intervalo mínimo de dois minutos. Nenhuma fonte, ref, reserva ou CI da autora foi alterada.

## Atualização focal: fonte a4b34673

A autora publicou, por investigação própria, o RED `55dbc9fc7e7611f77753ba9331f42bb8fabf9a69` e a correção `a4b34673bb8415a49ab77a633adad531449eac51` antes da publicação deste parecer. Li o delta inteiro e o teste permanente de quatro verificações. O `afterRemoval` agora faz a lista aguardar a aplicação da remoção. **O MÉDIO saudável descrito no histórico abaixo está fechado no a4b34673**: a MESMA prova original passa 9/9, o teste novo da autora passa 4/4 e o teste de desempenho passa 4/4 (65 idas/18 degraus/962ms nesta execução). Não atribuir o reparo à revisão M nem apresentar o achado original como ainda aberto.

Resta **LEVE condicional de apresentação**, reproduzido com uma extensão da prova: um único GET inicial do registro de remoção lança falha de transporte antes da execução; todos os outros comandos usam o MemoryRedis real e respostas normais. Outro leitor aplica a remoção vencida, porém a lista que esperou somente o primeiro resultado recusado pode capturar a chave antiga. O estado final guardado está correto (`[]`); o `PasskeyManager.initial` contém a chave já removida. Não foi demonstrado bypass, chave ainda autenticando, perda de gravação ou corrupção persistida.

| MESMA prova estendida, três cenários | Verificações | Falhas | Controle do GET falho |
| --- | --- | --- | --- |
| Página anterior c2e7c793 | 14 | 0 | falha injetada uma vez, estado e lista finais vazios |
| Página atual a4b34673 | 14 | 1 | falha injetada uma vez, estado vazio, lista antiga |

Os primeiros dois cenários conservam as nove verificações originais: chave ativa e remoção vencida com todas as leituras saudáveis. Ambos passam no a4. O terceiro contém cinco verificações e depende explicitamente da falha isolada; não deve ser descrito como regressão do caminho saudável. A prova imprime `faulted: true`,486 comandos explícitos no cenário e quatro envios sintéticos acumulados, dentro dos tetos declarados. A falha de transporte não forja resposta vazia ou null no Redis; o null observado é produzido pelo catch do produto.

Retorno pedido à autora: tratar a consistência da lista quando a primeira limpeza falha e outra limpeza concorrente termina; conservar segurança e desempenho, registrar RED antes do reparo e repetir os controles. Não ampliar escopo para os arquivos de segunda etapa reservados pela Claude 4. Os outros 64 grupos ligados e a revisão inteira descritos abaixo foram executados no original2aa; **não são creditados como nova execução global no a4**. Types estritos da página/teste/prova estendida passaram. Uma tentativa de lint foi encerrada pelo host (137), e a tentativa com heap384MiB terminou por falta de heap (134); nenhuma é verde. O lint focal posterior dos dois arquivos de prova próprios passou com heap768MiB e zero diagnóstico; a página foi lida no delta, sem novo certificado de lint global. Scanner:4083 arquivos/0 achados; diff0. Sem certificado de CI ou aprovação automática de merge por esta evidência.

Para reproduzir a extensão, o ramo de evidência incorpora a fonte real a4 como segundo pai e conserva a prova anterior no histórico. `node proofs/m/review-2835-read-order.mjs --before` deve passar14/14; a execução sem `--before` no a4 deve falhar somente a igualdade da lista no terceiro cenário. O runner `--author` mantém o teste de desempenho separado.

## Histórico: MÉDIO funcional no original2aa1, corrigido pela autora

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

Sem certificado de CI global, margens, TTFB real, navegador, leitor de tela ou AAA. Esta conclusão histórica retinha o original2aa1; o estado atual é o da atualização focal no início deste documento.
