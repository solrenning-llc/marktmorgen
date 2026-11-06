# #2910 — revisão M de leituras do comprador

Estado: leitura estática concluída; nenhuma execução de produto ou teste realizada nesta frente. Codex M, 06/11/2026. Claim confirmado no canal pelo coordenador: `dfcead2eb6f9db0cc2f301e79da84ab1ead66e01`, anterior ao diff/fonte/testes. Root centraliza publicação e parecer.

## Identidade e snapshot

Fonte: `a1cf01b076d072cdfc95264b5dc6a3a4642180ee`, ramo `claude6/embed-library-sweep`. Base atual do PR: main `5c07315505e1d53ee6401021601cd688fa98ecda`. Compare tipado 5c→a1cf retornou diverged, ahead 3/behind 17, merge-base `1721109f1d2d3930cde6c54f6fe71412648043e3`. Compare explícito 172→a1cf confirmou ahead 3/behind 0/merge-base 172 e os mesmos 14 caminhos.

A árvore do commit real 172, observada no object store próprio antes do desaparecimento do executor, era `8be849cb6185cc3eb7c30f31d3c0bca9a4873ad6`. A árvore main 5c informada pelo root é `f4a0fab311a3bb3675b03e990aa4ff5d646cab27`; ela NÃO pode receber somente os 14 overlays e ser chamada de head a1cf. Loader correto: árvore 8be + todos os 14 blobs head, com SHA Git conferido antes do uso. Nenhum commit/SHA foi fabricado.

## Escopo e método

Lista completa e diferença integral dos 14 arquivos lidas após claim, por ferramentas GitHub tipadas. Fontes/chamadores consultados por fetch_file no head fixado; RED autor `0739a72945a7150221856924de7aabfabd8ad899` confirmado como commit de teste+alias. Até esta etapa: 39 leituras tipadas (incluindo inventário), 878.085 caracteres serializados, abaixo de 40 leituras/5 MiB. Um único 404 de app/embed/layout.tsx, sem repetição. Nenhum GitData genérico 403 foi repetido.

Foram lidos: três páginas alteradas, buyer-library, sete traduções, dois testes/provas e test-config; e os caminhos storeForPage/storeForId/readListing/soonOne/SSR, canSell/canRecover/ordersLinkFor, embed-open, visitor e POST library. Instruções AGENTS/CLAUDE já lidas no own frozen main90eca.

## Quatro correções lidas

| Recorte | Comportamento efetivo no head | Limite |
| --- | --- | --- |
| Card: loja/produto | `app/embed/[handle]/[product]/page.tsx:70–101,155–174`: exceção vira unread e aviso; null, suspensão e draft conservam ausência; metadado distingue indisponibilidade. | Só captura exceção; getter permissivo pode devolver null para shape ilegível. |
| Card: coming soon | `:179–194`: exceção de soonOne vira ação none com frase localizada; título/link permanecem; calendar exige action link e não abre nesse ramo. | O helper herdado soonOne ainda transforma envelope curto em soon=false. |
| Join | `app/embed/[handle]/join/page.tsx:27–44,88–95`: erro de loja vira frase de indisponibilidade, antes do formulário/contador; falta legítima mantém lista fechada. | Inglês é intencional quando a própria loja não foi lida; marca lang=en nesse fallback. |
| Library | `buyer-library.ts:97–103` valida envelope SUNION com repliesFor/stringList; `app/library/page.tsx:43–55,80–85,121–122` distingue lista/loja que lançou e evita aviso de vazio junto do erro. | Não prova shape exato dos getters de loja nem validade de todo SID; string SID inválida ainda é filtrada. |

Chamadores de storesBoughtFrom: página Library e requestLibraryLink (`buyer-library.ts:111–147`). O POST real `app/api/library/route.ts:25–31` captura erro da lista e redireciona303/error. Ausência de compras conserva sent não enumerável. `requestLibraryLink:122` ainda captura falha de storeForId como null, condição herdada.

Sete traduções adicionam cardUnread/cardBuyUnread. O teste autor verifica existência de strings, mas não SSR e marcação de todos os idiomas. Registro pt-PT do comprador permanece o existente; conversa/relatório continuam PT-BR.

## Resíduos e crédito, sem grau aumentado por leitura estática

- storesKnownFor (`buyer-library.ts:65–68`) e sua prova autoral continuam candidato C6→R2, não fix. Não reexecutei nem dupliquei essa varredura.
- stockLeft/outOfKeys (`card:182–183`) conservam os catches permissivos conhecidos; não declaro o MÉDIO global fechado por regex ou pelo teste dos quatro LEVEs.
- Getters herdados: storeForHandle `store.ts:1194–1202`, parseStore `:924–928`, storeForId `:1228–1233` e readListing/readListings `catalog.ts:682–705` podem devolver null/omitir dado para envelope ilegível. soonOne `preorders.ts:71–74` não valida envelope e compara member com1/"1". Logo o novo catch não demonstra que todo unknown passou a aviso. Exige reprodução focal; nenhum M+ novo atribuído por estático.
- Candidato LOW de apresentação/idioma herdado: card unread com loja conhecida retorna div/p sem lang (`:155–174`) e escreve frase localizada (`:162`). Saudável marca idioma (`:431,442`), layout global `app/layout.tsx:109–110` usa en-US. Wrapper antigo de noLongerOnSale já omitia lang. SSR anterior/head ainda necessário; não é MEDIUM nem regressão de todo idioma da loja.

## Prova preparada e limite de execução

Plano aceito: seis casos reais com MemoryRedis canônico, máximo3000 comandos por caso/18000 no conjunto,120s total/log128KiB, sem esbuild/tsc/browser antes da janela explícita e folga>=768MiB, heap512MiB, compilação serial. Fetch bloqueado antes do módulo e tentativas registradas. Não drenar afterTasks: o alias canônico apenas as guarda; tarefa enfileirada não é efeito concluído.

Casos: (1) card loja throw/ausência/metadado; (2) card produto fora do head throw/ausência e SSR de sete idiomas; (3) coming-soon throw versus0/1 e envelope curto herdado; (4) join throw/ausência/form; (5) library SUNION inválido/vazio, loja throw/null e mistura legível/ilegível; (6) POST library unknown→303/error versus vazio→303/sent. Fixture pública de26produtos somente para forçar fora do head; um produto basta para o wrapper/idioma. Funções reais e regras reais; nenhuma lógica de negócio reimplementada. RED autor30checks/20falhas e GREEN30/30 são relato do PR, não execução M.

## Interrupção ambiental e ponto de continuidade

O workspace próprio e dois anteriores desapareceram entre comandos, antes da primeira execução. Também sumiram o object store autorizado `/dev/shm/codex-m-resume.c5DCg7` e `/workspace/scratch/369886b90de6/marktmorgen/node_modules`. Observado memory.current cair de cerca de8,59GB para2,29GB junto do desaparecimento. Não apaguei cache/fonte alheia nem iniciei compilador. Root foi avisado imediatamente; o motivo do reset não foi confirmado.

Antes do desaparecimento haviam sido escritos apenas os três caminhos reservados: este relatório, tests/m-2910-store-readings.proof.ts e proofs/m/review-2910-store-readings.mjs. A prova própria havia SHA256 `dfd6364f092c6c964640ecb17e70ccadd6c26baa32d465e24352c5f7623022b8`; o runner ainda tinha uma linha vazia final a corrigir. Não são arquivos executados nem prova de testes verdes. Este relatório foi reconstruído a partir das leituras preservadas na orquestração; os 14 blobs head e seus SHAs permanecem no estado da sessão para reconstrução do loader. É necessário restabelecer o object store172/árvore8be e dependências antes de executar.

Nenhum parecer “pode entrar” nesta etapa. Nenhum resultado de teste, tipo, lint, navegador, CI ou publicação é certificado por M. Sem mudança de fonte, preço, limite, comissão, flag, gate, conta, pagamento, termo, credencial, fornecedor, PR, referência Git ou canal.

## Recuperação em scratch, sem execução

Os três arquivos reservados foram reconstruídos em `/workspace/scratch/d1ece80b1417/m-review-2910`, com os mesmos dados sintéticos e seis grupos de casos/caps; não são byte-identificados ao texto perdido e não foram executados. O runner agora recebe `--git-cwd` e `--deps`, para não presumir que os caminhos desaparecidos voltaram. Seu modo padrão reproduz RED/GREEN do teste autoral sem mudar asserções; `--own` usa a prova focal. Ele carrega árvore8be mais os14overlays preservados, confere SHA Git de cada blob, aplica aliases/ambiente canônicos, bloqueia fetch antes do módulo e registra tentativas/comandos. Limites: heap512MiB, compilação serial, folga>=768MiB imediatamente antes de build,16MiB de fontes,3000comandos/caso/18000total,120s e128KiB de saída agregada do par. O build fica silencioso e erros são resumidos. Nenhum comando de execução foi autorizado pelo novo GO ainda.

O arquivo `/workspace/scratch/d1ece80b1417/m-2910-elements.json` foi exportado com somente14elementos GitData (path,mode100644,typeblob,sha), sem nova API ou SHA inferido. SHA256: `2f4d51e0a9dabb73abf13821b84772be06b312eeb1de333fb20b1ff40ef1a06f`.

Artefatos reconstruídos, ainda não executados:

| Caminho relativo | SHA256 |
| --- | --- |
| `tests/m-2910-store-readings.proof.ts` | `07eb196daf64b4a96daf8b5d49b6f75d6af1bd94552ed84c5f85e0502bc8ce70` |
| `proofs/m/review-2910-store-readings.mjs` | `37fabbed759f3bd6bd7a77e779e8da850d05994a3dd79da36b67754062be3b11` |

Diff-check desses dois arquivos: sem erro. Isso verifica somente whitespace, não sintaxe, bundling, tipos ou execução. Publicação dos arquivos e validação remota da árvore candidata ficam com o root.

## Conferência estática dos artefatos recuperados

Removido o marcador solto antes da seção de recuperação. O scanner canônico `m-review-2858/.m2858-check_public_data.py`, função `findings`, retornou zero achados nos três caminhos reservados e em `review-body.txt`. Isso é uma verificação dos textos, sem execução de produto. A ocorrência anterior de provider-account estava exclusivamente no snapshot de `tests/library-known-stores-unknown.proof.ts`: literal de fixture sintética do autor C6, não conta obtida de ambiente, rede ou credencial. Somente esse conteúdo foi representado em base64, com SHA Git original preservado; os outros 13 continuam UTF-8. Nenhuma asserção ou fonte de produto foi alterada.

Python decodificou os conteúdos e conferiu SHA-1 Git de 14/14 blobs. O manifest ordenado de pares caminho/SHA foi conferido como `724e8c702c00403c6aa8c5ba2f5f94fbc10fc888e09d5a63c5934f644f399428`. O runner exige quantidade 14 e esse manifest (`proofs/m/review-2910-store-readings.mjs:20–28`); o carregador usa os conteúdos decodificados. Esta conferência não substitui a validação remota da árvore pelo root.

| Controle preparado | Local e garantia lida | Limite da conferência |
| --- | --- | --- |
| Comandos por caso | Runner `:60–69`: contador antes de dispatch, máximo3000/caso e18000total; acesso controlado a pipeline mantém contagem mesmo com injeção da prova. `part(1)` a `part(6)` da prova foram conferidos. | Contam comandos MemoryRedis tentados, inclusive os que a fixture faz falhar; não preço ou fatura real. |
| Acumulado anterior/head | Runner `:61–62,93,98–105`: carrega contadores anteriores, exige recibo único, IDs únicos1–6, inteiros dentro do teto, soma exata e nenhuma contagem anterior perdida. Estado capped persistente impede verde quando o produto captura a exceção de limite. | O modo autoral usa o caso1; não ganha3000novos ao trocar de versão. Ainda não executado. |
| Saída agregada | Runner `:13–15,94–97,109–113`: mede bytes UTF-8 antes de escrever, captura stdout/stderr do filho, limita mensagem de aborto ao saldo e retorna erro se o teto impedir o fechamento. Build silencioso; erro de build resumido. | Conferência do fluxo de saída controlado pelo runner, sem prometer contenção de falha nativa do processo/erro de inicialização anterior ao try. |
| Rede | Runner `:70–72,101`: instala bloqueio de fetch antes do módulo-alvo e exige zero tentativas no recibo. | Zero tentativas é expectativa de aceitação, não medição já obtida; nenhum fornecedor chamado nesta revisão. |
| Tempo e memória | Runner `:18–19,79–94`: verifica folga768MiB imediatamente antes de build, heap512MiB no filho, compilação serial e timeout do filho com saldo dos120s. | `await build` não tem prazo externo próprio. O futuro comando precisa de timeout externo120s para cumprir o teto de parede integral; ainda não executado nem certificado. |

Conferência conceitual por aritmética, sem interpretar JS: 131071+1 bytes cabe e131072+1 é bloqueado;2999+1comandos cabe e3000+1 é bloqueado;17999+1total cabe e18000+1 é bloqueado;1800antes+1201head do mesmo caso excede3000. Os sete resultados coincidiram com as comparações lidas no runner. Isso não é teste do runner, de sintaxe, de integração ou de produto.

`review-body.txt` está preparado com qualificação explícita de LEITURA ESTÁTICA/NÃO PARECER LIMPO. Mantém crédito C6→R2 de storesKnownFor e separa os resíduos herdados. Nenhuma execução ou API adicional foi feita nesta recuperação. A publicação continua com o root.
