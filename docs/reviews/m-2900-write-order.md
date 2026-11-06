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

## Adendo G8 — retorno independente no head 342 (6 de novembro de 2026)

O conteúdo anterior permanece integral como histórico. Este adendo atualiza o estado focal: **o LOW condicional de gravações repetidas no reparo do cache está fechado em `342f72ce9a78afd25789ad7beebceef8f0430683`**. A correção é do autor Claude 6. Claim do retorno confirmado antes das novas leituras: `31fb7ab2c7c98db0d681ffa734c51ab99b60d60a`. Não se atribui nova execução a A4,9cd ou a329.

### Diferenças completas entre endpoints e reparo

A API de comparação entre 9cd/a329 e 342 calcula diferenças desde o merge-base B92, pois os históricos divergem. Ela não foi tratada como diferença direta entre os dois endpoints. Para fechar essa lacuna, os conteúdos completos da página e dos dois testes foram lidos nos três SHAs, e árvores candidatas foram reconstruídas nativamente em índices próprios, revertendo somente esses paths na árvore 342. Cada árvore resultante coincidiu com a árvore canônica do respectivo commit obtida pela API GitData:

| Endpoint | Árvore canônica e nativa coincidente | Diferença direta inteira até 342 |
| --- | --- | --- |
|9cd `9cd398af42ff02697e9cd8649f259b3f6c953f85` | `fdb9fd58237f8c0f7198d81fdd9445d123e3f9d8` | `app/studio/page.tsx` e `tests/studio-today-trips.test.ts` |
|a329 `a329b83e34133b2efa8a3e606435bfe41900a23b` | `655bef313de47d2917da6e0aacda596028056571` | somente `tests/studio-today-trips.test.ts` |
|342 `342f72ce9a78afd25789ad7beebceef8f0430683` | `3fa9c551021692ccaee88fef357210ae143be123` | fonte executada |

A igualdade de árvores confere todos os paths e modos; não se limita aos três arquivos inspecionados inicialmente. Os arquivos que mudam conservam modo 100644. A página a329/342 é idêntica, blob `452d48d657620456eeec6778614e899e9aeb76b7`. O teste de remoção é idêntico nos três endpoints, blob `35ae8e5fc70802e275245fcdb08e72fa42b8e2b8`.

O delta 9cd→342 troca quatro chamadas independentes aos cards pela mesma promessa lazy por requisição: `cardsOnce`/`storeCards`, consumida por ShortLinks, publishedChoices/ProductEditor, Cards e WelcomeOffer. O primeiro consumidor inicia `readCards`; os seguintes recebem a mesma leitura e o mesmo reparo de cache. O delta inclui um teste permanente da autora para uma reparação após remover o cache. O delta a329→342 contém exclusivamente comentário e retirada de `MAX_MS = 800` e da asserção de duração. Mantém o carregamento da árvore real, `MAX_STEPS = 12`, `MAX_TRIPS = 66`, o atraso de 40ms e a asserção `repairs === 1`. Não executei novamente esse teste de desempenho, portanto não alego resultado dele em 342. A retirada deixa de garantir 800ms por esse teste; as cotas de operações e a verificação do reparo permanecem efetivas.

### Fonte exata e montagem limitada

A comparação congelada 2bfa→342 apontou merge-base real `738a7124c3fd75cdbcf1b3fed4e544cf7d5a8575`, árvore `b370d3d2f660c8ab7d39f5f2928a26886c690f08`, e sete overlays: página, demo-store, adaptadores navigation/next-server, teste de remoção, teste de desempenho e test-config. O snapshot2bfa local não continha 738; não foi considerado uma base equivalente. O cache T indicado também não estava acessível pelo caminho informado.

Foi obtida a árvore completa canônica 342 com `truncated:false`, 4647 entradas e 568 subárvores. Todas as subárvores foram reconstruídas por `git mktree --missing` e conferidas por SHA, chegando à raiz 3fa9. O commit assinado real 342 foi reconstruído exclusivamente de verification.payload/signature canônicos; só foi importado depois de o hash nativo coincidir exatamente com 342. Nenhum campo autoral foi inventado e nenhuma ref do autor foi alterada.

Um inventário lexical conservador dos imports locais, incluindo declarações multilinha, imports de tipos, runtime JSX e aliases canônicos do teste, identificou 728 arquivos/10395068 bytes, sem blobs faltantes no grafo. Treze blobs pertinentes foram recuperados por SHA exato após a contagem prévia; não foram baixados todos os 39 blobs ausentes do repositório; os 26 restantes ficam fora do grafo. Foram materializados somente o grafo, os sete overlays e as duas evidências: 731 arquivos de fonte mais prova/runner, 10443315 bytes, abaixo de 16MiB. É um checkout intencionalmente parcial de uma árvore integralmente identificada, não uma afirmação de que todos os arquivos do repositório estão presentes. A resolução do bundle real completou na execução abaixo. Dependências K2 somente leitura; nenhum pacote foi instalado ou substituído.

Antes da execução, `git rev-parse HEAD` retornou 342 real, `git write-tree` retornou 3fa9 e `git hash-object app/studio/page.tsx` retornou 452d48. O runner usou PATH=/usr/bin:/bin para chamar Git nativo. A primeira montagem de árvore antiga sem --missing-ok recusou blobs fora do grafo; a opção foi aplicada à montagem de metadados, preservando os mesmos SHAs canônicos. Isso não foi falha de produto ou runtime.

### MESMA prova de 13 executada no head 342

Após GO expresso, foi executada somente a MESMA prova `e3fedc53038f3f3450430105f33cf5e74ff5bcd1`, pelo MESMO runner `ef083a8da605eb314cbebfbba5f8720064da55aa`, sem alterar as 13 asserções. O diagnóstico impresso foi sourceHead=342/sourceBlob=452d48/page=current.

| Cenário | Checks | Comandos medidos | Idas | HGETALL do cache | HSET do cache | Listing GET | Cache/produtos finais |
| --- | --- | --- | --- | --- | --- | --- | --- |
|Frio |4/4 |89 |66 |1 |1 |2 |corretos |
|Aquecido |5/5 |88 |65 |1 |0 |2 |corretos |
|Legado |4/4 |89 |66 |1 |1 |2 |corretos |

**13/13, saída 0, 3,307s.** Fetch attempts=0 em todos os cenários. As contagens incluindo preparação foram 501/89/91 por caso, 681 por conjunto. O conjunto novo, somado aos 2091 comandos explícitos anteriores registrados, resulta em 2772 observados na revisão, abaixo do teto de 20000; não inclui uma nova execução das fontes antigas.

Tetos declarados antes: 3000 comandos explícitos por caso, 9000 por conjunto, 20000 na revisão; heap768MiB, 120s, 128KiB de log, pelo menos 1,5GiB livre. O processo iniciou com 5560012800 bytes livres, mínimo observado 5113126912, log de 1618 bytes. Não houve OOM, timeout, estouro de log, retry, fetch ou chamada a provedor. O runner eliminou seu bundle temporário e conferiu a página em finally; os hashes da página e das duas evidências foram reconferidos depois. Os limites de comandos permanecem na prova e são verificados antes da pipeline real.

### Validação, orçamento e conclusão limitada

Esta etapa usou 36 GET autorizados cumulativamente, incluindo uma consulta inicial com prefixo a329 que retornou 404 e foi corrigida para SHA completo. O conteúdo principal de fontes/árvores permaneceu abaixo de 3,6MiB, além de metadados pequenos, dentro do teto de 6MiB. Os objetos nativos próprios permaneceram abaixo de 1MiB, dentro de 128MiB; o grafo materializado ficou abaixo de 16MiB. Custo monetário de recursos não foi estimado como zero.

O adendo preserva byte a byte o relatório anterior de blob `2a68022c0a0ef21207598df497c303707ee55b14`; prova e runner publicados continuam idênticos. Scanner público e diff-check dos dois textos finais são conferidos separadamente para publicação. A execução causal M13 acima não incluiu strict TypeScript ou lint global; o complemento focal de tipos e lint está registrado separadamente abaixo. Não houve suíte completa, repetição dos ligados, teste de desempenho da autora, navegador, Redis nativo, CI ou produção. Este retorno fecha somente o LOW de reparo duplicado de cache; não declara aprovação formal nem nove checks verdes.

## Ressalva C4-2980 — banner de reset fora da M13

O fechamento acima se limita ao cache de cards. O achado LEVE informado em C4-2980 para o banner de reset quando `twoStepRead === null`, atribuído a C6, continua fora do escopo da M13 de cache. A prova de treze asserções não demonstra esse banner nem fecha o achado de outra revisão. Este retorno não representa aprovação global; o estado desse achado deve permanecer explícito na coordenação com o autor.

## Complemento focal — strict real e lint dos originais

Após GO separado, sem repetir M13 ou o teste de desempenho, **strict semântico TypeScript das quatro raízes passou: saída 0, zero diagnósticos, 56,720s**. Raízes: página 342/blob452d48, prova M13/e3fed, teste de desempenho/d170bb e teste de remoção/35ae. A configuração scratch estende o tsconfig canônico 342/f12699, mantém opções e paths reais (inclusive skipLibCheck canônico), strict/noEmit verdadeiros e incremental falso. Não usa noResolve, noCheck, stub de tipo ou aliases de runtime do esbuild. Os imports transitivos de tipos foram inventariados sem esses aliases; `lib/redis.ts` e `lib/ai-spend.ts` reais entraram na montagem.

Nenhuma fonte materializada usa os globais PageProps, LayoutProps ou RouteContext. Foram usados em files os dois ambients OFICIAIS existentes nas dependências Next16.4.2: `next/types/global.d.ts` e `next/image-types/global.d.ts`, além dos quatro roots. Não foi criado next-env.d.ts vazio, gerado tipo de rota fictício ou executado Next typegen na view parcial. O grafo lexical de tipos fechou 728 fontes/10393922 bytes sem blob ausente; isso não reduz o grafo efetivamente resolvido pelo compilador. A união dos fontes usados continuou abaixo de 16MiB.

**ESLint canônico dos dois artefatos originais passou: saída 0, zero diagnósticos, 2,821s.** Config real 342/blob05e726; alvos prova e3fed e runner ef083, sem alterar código, reduzir regras ou aplicar fix. A tipagem semântica acima é dos quatro roots TypeScript e seus imports; **não é strict semântico do runner JavaScript**: checkJs continua false. O runner tem o lint e a execução M13 já registrados.

Ambos os processos foram seriais, heap768MiB, 120s/128KiB, mínimo admitido 1,5GiB livre, sem retry. Strict iniciou com 5405020160 bytes livres, mínimo 4332220416, log 0; lint iniciou com 5551136768, mínimo 5268590592, log 0. Sem OOM, timeout ou violação de limites. Config canônico, página 452d48 e evidências e3fed/ef083 foram reconferidos depois. Nenhuma API nova foi usada: esta etapa continua 36/36 GET. Nenhum resultado focal fecha o LOW C4-2980 do banner de reset ou constitui aprovação dos nove checks/CI global.
