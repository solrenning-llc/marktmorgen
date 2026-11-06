# Revisão independente M — #2900

Estado em 06/11/2026: prova causal executada nas fontes anteriores; retorno focal na fonte corrigida ainda pendente. Este registro não declara que o head atual conserva o defeito anterior.

## Identidade, escopo e crédito

Claim anterior à primeira leitura: canal `376cf9c54003bc1b86c6ceffeb0a93541d547cce`, comentário do PR `6695636295`. O claim foi renovado antes de ler/executar `9cd398af42ff02697e9cd8649f259b3f6c953f85`, no canal `d7b50b602ad1b84b1603ae7a5ede8c5de0294163`. Antes da correção a329, claim `39fcc06549e713553c39e2a47c09309e56293a6e`.

O autor é Claude 6. M leu a diferença inteira de dois arquivos em `88de983833c0de44ff67c067a923614a761f7412`, base A4 `a4b34673bb8415a49ab77a633adad531449eac51`. A diferença posterior até `9cd398af42ff02697e9cd8649f259b3f6c953f85` contém o reparo de remoção do #2835: 17 linhas do preâmbulo da página e teste focal; foi lida integralmente antes da nova execução. G3 também conferiu estaticamente a ordem das quatorze IIFEs. O caminhador da árvore assíncrona é creditado ao método de Claude 6, não inventado como contribuição de M.

`serverWrite.done` é atribuído sincronicamente antes da IIFE da assistente; a dependência setAdsServer → syncAssistant foi preservada. Foram inventariados os transitivos que também podem gravar: migração de loja, cache/refresh Google e BuyerPaths NX/after. Não foi demonstrado outro writer novo fora do caso de cache abaixo.

## Prova real e grau

A prova executa a página e todos os componentes assíncronos de servidor alcançados, com os getters reais de cards e o MemoryRedis canônico. Os estados sintéticos públicos são preparados pelas estruturas reais. O fetch é bloqueado; não há fornecedor ou Redis nativo. `readCards` pode reparar o cache derivado por HSET.

Com até cinquenta produtos, studioShelf não aquece esse cache antes dos quatro consumidores: ShortLinks/readTitles, ProductEditor/publishedChoices, Cards e WelcomeOffer. Com mais de cinquenta, o readTitles antecipado constitui outro controle. A prova apaga o hash derivado ou grava uma string JSON legada na estrutura real; não fabrica resposta de Redis ou redefine o getter de negócio.

| Fonte e mesmos 13 checks | Resultado | Cache frio/legado |
| --- | --- | --- |
| A4 `a4b34673bb8415a49ab77a633adad531449eac51` | 13 PASS / 0 FAIL | HGETALL 4; HSET 1; leituras antes da primeira gravação 1 |
| Primeira fonte #2900 `88de983833c0de44ff67c067a923614a761f7412` | 11 PASS / 2 FAIL | HGETALL 4; HSET 4; leituras antes da primeira gravação 4 |
| Fonte renovada `9cd398af42ff02697e9cd8649f259b3f6c953f85` | 11 PASS / 2 FAIL | Mesmo efeito: HSET 4 em vez de 1 |

Os dois checks falhos correspondem aos estados frio e legado. Os totais medidos desses casos passaram de 92 para 95 comandos. Cache aquecido: zero HSET e 91 comandos nas duas versões. Listing GET permaneceu 2 nos cenários comparados: não há prova de fanout novo desse GET.

Grau sustentado: **LEVE (LOW), condicional, de custo** — três gravações derivadas repetidas por reparo de cache. Os produtos finais e o cache final permaneceram corretos; não se demonstrou corrupção, vazamento, bypass, perda, indisponibilidade permanente ou uma fatura real. Custo monetário continua desconhecido, não zero.

## Correção do autor e limite atual

Claude 6 informou RED `52056014` e correção `a329b83e34133b2efa8a3e606435bfe41900a23b`, compartilhando uma leitura lazy de cards por requisição. O ID anterior 9a6f foi retificado pelo próprio autor; não é a identidade final do RED. A página corrigida tem blob `452d48d657620456eeec6778614e899e9aeb76b7`.

Último metadado disponível: head `342f72ce9a78afd25789ad7beebceef8f0430683`, sobre a atualização de base DA do #2835. Não executei os mesmos treze checks em a329 ou342, nem conferi ainda a diferença final342 após a reinicialização do ambiente. Portanto a observação anterior não é apresentada como achado aberto confirmado no head atual. O retorno focal independente continua pendente.

## Artefatos e orçamento contado antes

| Arquivo | SHA-1 Git do conteúdo recuperado |
| --- | --- |
| `tests/m-2900-write-order.proof.ts` | `e3fedc53038f3f3450430105f33cf5e74ff5bcd1` |
| `proofs/m/review-2900-write-order.mjs` | `ef083a8da605eb314cbebfbba5f8720064da55aa` |

A instrumentação mantém os treze checks. O runner original era blob `70b0b16977fcb913e4386463f4594b43855db9f9`; a alteração final tornou sourceHead/sourceBlob diagnósticos e o pin A4 completos. A execução9cd imprimiu o head real e o blob da página `3f2f47119e41ca2f72caacea510a7a1c5cb6a95b`, evitando atribuir resultados à fonte errada.

Antes de executar: teto de3000 comandos por caso,9000 por conjunto,20000 para a revisão,120s e128KiB de log por runner; atraso uniforme de5ms para observar concorrência. Fontes e aliases canônicos congelados; zero fetch permitido. A primeira comparação usou1392 comandos explícitos; a renovação9cd usou699: total observado2091, dentro do teto global. Não foram medidos preços nem autorizado gasto real. Os bundles próprios foram eliminados ao concluir cada execução.

## Recuperação e verificações que não ocorreram

Os arquivos foram recuperados em `/workspace/scratch/d1ece80b1417/m-review-2900` depois do desaparecimento do antigo executor e das dependências. Ambos coincidem byte a byte com os hashes anteriores, inclusive a variação de formatação do patch final do runner. Não houve novo teste, compilação, instalação ou API nessa restauração. O relatório foi reconstituído do registro da execução; tem conteúdo novo e não finge identidade com um relatório perdido.

Nenhum resultado de strict types, lint, suíte inteira, CI ou browser do head342 é certificado por este registro. As dependências exatas precisam ser restauradas antes de nova execução. Não se troca React/Next/TypeScript por versões do runtime para simular verde. O GitHub passou a devolver403 de quota também às ferramentas tipadas às22:09UTC; publicação e conferência de heads permanecem pendentes enquanto esse erro persistir.

Nenhuma referência do autor, CI alheio ou produto foi alterado. Este é um artefato de revisão no ramo próprio de M, não um sexto PR de produto.
