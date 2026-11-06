# #2910 — revisão M de leituras do comprador

Estado atual: par autoral controlado executado — RED30/20falhas e head30/30. Prova própria final: seis grupos, setup1/1 e four-fixes42/42 no head; nove checks herdados permanecem falhando e separados. Duas expectativas inválidas de fixture e a falha JSX original estão preservadas. Strict dirigido dos5roots e lint dos2artefatos próprios também passaram. Não é parecer limpo. O histórico estático abaixo é preservado e os resultados estão na última seção. Codex M, 06/11/2026. Claim confirmado no canal pelo coordenador: `dfcead2eb6f9db0cc2f301e79da84ab1ead66e01`, anterior ao diff/fonte/testes. Root centraliza publicação e parecer.

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

Casos: (1) card loja throw/ausência/metadado; (2) card produto fora do head throw/ausência e SSR de sete idiomas; (3) coming-soon throw versus0/1 e envelope curto herdado; (4) join throw/ausência/form; (5) library SUNION inválido/vazio, loja throw/null e mistura legível/ilegível; (6) POST library unknown→303/error versus vazio→303/sent. Fixture pública de26produtos somente para forçar fora do head; um produto basta para o wrapper/idioma. Funções reais e regras reais; nenhuma lógica de negócio reimplementada. Na etapa estática, RED autor30checks/20falhas e GREEN30/30 eram somente relato do PR; a reprodução posterior está registrada abaixo.

## Interrupção ambiental e ponto de continuidade

O workspace próprio e dois anteriores desapareceram entre comandos, antes da primeira execução. Também sumiram o object store autorizado `/dev/shm/codex-m-resume.c5DCg7` e `/workspace/scratch/369886b90de6/marktmorgen/node_modules`. Observado memory.current cair de cerca de8,59GB para2,29GB junto do desaparecimento. Não apaguei cache/fonte alheia nem iniciei compilador. Root foi avisado imediatamente; o motivo do reset não foi confirmado.

Antes do desaparecimento haviam sido escritos apenas os três caminhos reservados: este relatório, tests/m-2910-store-readings.proof.ts e proofs/m/review-2910-store-readings.mjs. A prova própria havia SHA256 `dfd6364f092c6c964640ecb17e70ccadd6c26baa32d465e24352c5f7623022b8`; o runner ainda tinha uma linha vazia final a corrigir. Não são arquivos executados nem prova de testes verdes. Este relatório foi reconstruído a partir das leituras preservadas na orquestração; os 14 blobs head e seus SHAs permanecem no estado da sessão para reconstrução do loader. É necessário restabelecer o object store172/árvore8be e dependências antes de executar.

Nenhum parecer “pode entrar” global. Naquela etapa não havia teste executado; os resultados direcionados posteriores estão abaixo. Tipo, lint, navegador e CI não foram executados nesta frente. Sem mudança de fonte, preço, limite, comissão, flag, gate, conta, pagamento, termo, credencial, fornecedor, PR, referência Git ou canal.

## Recuperação em scratch, registro anterior à execução

Os três arquivos reservados foram reconstruídos em `/workspace/scratch/d1ece80b1417/m-review-2910`, com os mesmos dados sintéticos e seis grupos de casos/caps; não são byte-identificados ao texto perdido e não foram executados. O runner agora recebe `--git-cwd` e `--deps`, para não presumir que os caminhos desaparecidos voltaram. Seu modo padrão reproduz RED/GREEN do teste autoral sem mudar asserções; `--own` usa a prova focal. Ele carrega árvore8be mais os14overlays preservados, confere SHA Git de cada blob, aplica aliases/ambiente canônicos, bloqueia fetch antes do módulo e registra tentativas/comandos. Limites: heap512MiB, compilação serial, folga>=768MiB imediatamente antes de build,16MiB de fontes,3000comandos/caso/18000total,120s e128KiB de saída agregada do par. O build fica silencioso e erros são resumidos. Nenhum comando de execução foi autorizado pelo novo GO ainda.

O arquivo `/workspace/scratch/d1ece80b1417/m-2910-elements.json` foi exportado com somente14elementos GitData (path,mode100644,typeblob,sha), sem nova API ou SHA inferido. SHA256: `2f4d51e0a9dabb73abf13821b84772be06b312eeb1de333fb20b1ff40ef1a06f`.

Artefatos reconstruídos naquela etapa, antes da execução e da correção de launcher:

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

## Incremento após GO: identidade, falha de harness e execução dirigida

Em06/11/2026, root confirmou remotamente a árvore a1df contra a1cf: compare a1cf→órfão940b9fdd6e841b0a559fe84249b4a369fe6cde54 retornou files vazio, ahead1/behind0. O head antigo passou a ter árvore equivalente verificada, sem commit inventado localmente. O root publicou a etapa estática original em `f02a233d65ea2d4dbba86ff9d9b111573928d40c` antes desta execução.

Após novo claim `31fb7ab2c7c98db0d681ffa734c51ab99b60d60a`, foram gastos somente2GET tipados/7.492caracteres serializados para a1cf→`f09a47fff80aa9eeb93732a34f2a9b0e91881258` e seu único blob alterado. Compare: ahead1/behind0/merge-basea1cf; único arquivo `tests/library-known-stores-unknown.proof.ts`,+1/−1. A linha64 troca somente o literal sintético passado a setStripeAccount. Blob novo `8b819d2827ab14041d004a1ef9ac5090b5611f74`,tamanho conferido de **5.826bytes**; SHA Git conferido no snapshot próprio separado. Nenhuma fonte de produto, helper, alias, teste autoral30 ou prova própria mudou. Os resultados abaixo carregam para esse código por identidade de bytes; não alegam execução de uma árvore f09 reconstruída. A prova storesKnownFor continua C6→R2 e não foi executada por M.

O patch tipado RED `0739a72945a7150221856924de7aabfabd8ad899` já preservado foi reaplicado em memória: teste autoral e test-config coincidem byte a byte com os blobs head `aef90472bb43a4661ae32a134cf23ca4e7988303` e `e4a4462d191ef10edeb4529564f90a13f8872d61`. O objeto do commit assinado0739 não existe no store local. Portanto o braço anterior é descrito como **RED controlado: produto172/árvore8be com teste/config0739 byte-identificados**, sem declarar equivalência da árvore inteira0739. Head: produtoa1cf/árvorea1df verificada pelo root.

### Falha original do launcher, preservada

O driver original SHA256 `37fabbed759f3bd6bd7a77e779e8da850d05994a3dd79da36b67754062be3b11` passou em syntax check, mas o primeiro par falhou durante importação de `components/icons.tsx`: `ReferenceError: React is not defined` em ambos os braços. Nenhum check chegou a rodar; comandos0/fetchAttempts0/cappedfalse em ambos. Log original2.579bytes;7,100s. Isso foi erro de wiring JSX, não RED de produto. Driver e log originais estão preservados em `m-2910-runtime/original-driver-37fabbed.mjs` e `original.log`, além da publicação f02.

Auditoria frozen: `tests/run.mjs:31–38` e `tests/g-proof-run.mjs:12` usam arquivos físicos e o tsconfig real; `tsconfig.json` blob `f126992ca95c6da5359e547a2e58e92fccd3d02c` declara `jsx=react-jsx`, `jsxImportSource=@/lib/content-jsx`. O namespace virtual não herdou essa configuração. Após GO específico, a única mudança de launcher foi acrescentar `tsconfigRaw:source('tsconfig.json',before)` ao build. Nenhum globalReact, fonte, assertion, fixture ou alias foi alterado. Driver corrigido SHA256 `c1f3f36c1e0351c820405539173720962b96c94c69caf1add7a3c17393356f9d`; novo syntax check único exit0/0,061504s/heap20MiB/RSS observado24.576KiB, saída vazia. Não houve lint/TypeScript/fullsuite/browser.

### Primeiro par próprio, preservado como histórico antes da correção do controle

| Execução | RED controlado anterior | Head a1cf | Leitura do resultado |
| --- | --- | --- | --- |
| Autor30, assertions originais | 30checks,20falhas,exit1 | 30checks,0falhas,exit0 | Reprodução dirigida válida dos30checks; exit1 do par inclui o RED esperado. |
| Própria: four-fixes | 42checks,19falhas | 42checks,1falha | A única falha head é um controle próprio com expectativa inválida de formulário; não declarar42/42. |
| Própria: declaração lang | 7checks,7falhas | 7checks,7falhas | Mesmo wrapper sem lang antes/head; herança, não regressão nova. Ausência explícita de en-US não prova idioma incorreto quando o ancestral já é en-US; os6idiomas diferentes continuam candidato LOW. |
| Própria: soon-shape | 1check,0falhas | 1check,0falhas | Negativo sem formulário não é probatório: o controle saudável já não oferece esse formulário. Não declarar shape corrigido. |
| Própria: store-shape | 1check,1falha | 1check,1falha | Envelope curto ainda vira lista vazia na página real; getter herdado, independente dos catches novos. Sem atribuição automática de novo MED. |

A falha de controle é `known ordinary product still offers checkout` (`tests/m-2910-store-readings.proof.ts:99`): exige form `/api/store/checkout` num card público/digital sem embed-open/siteallow. O próprio produto `app/embed/[handle]/[product]/page.tsx:196–217` converte a compra em link à página/caixa de compra nesse contexto. O saudável já possui esse comportamento antes/head. A fixture não autorizava esperar form; mantive a assertion e o resultado sem rerun. Pelo mesmo motivo, `:97`, que aceita envelope soon curto por ausência de form, não fecha o vetor soonOne. Os outros controles, inclusive ausência legítima, metadado, sete frases localizadas, join e POST library, foram registrados nas51comparações reais.

### Contagem real e tetos

Todos os comandos abaixo são dispatches MemoryRedis contados antes da execução, inclusive injeções de falha, sem traduzir IO sintético em custo/fatura. Nenhum teto foi atingido. Ambos os recibos de cada par registraram fetchAttempts0/cappedfalse; afterTasks não foi drenado.

| Caso | Anterior | Incremento head | Acumulado do par |
| --- | ---: | ---: | ---: |
| Autor30, bucket1 (todos7headers) | 1257 | 1255 | 2512 |
| Própria1: card/fixture | 1219 | 1219 | 2438 |
| Própria2: produto/idiomas | 260 | 260 | 520 |
| Própria3: soon | 20 | 20 | 40 |
| Própria4: join | 2 | 2 | 4 |
| Própria5: library | 29 | 29 | 58 |
| Própria6: POST | 10 | 10 | 20 |
| Própria total | 1540 | 1540 | 3080 |

Par autoral corrigido:8,421s, log6.251bytes, cache de fontes13.739.912bytes. Par próprio:6,679s, log10.650bytes, cache de fontes13.719.432bytes. Ambos ficaram abaixo de120s externos KILL/128KiB/16MiB e heap512MiB; folga observada imediatamente antes de cada par foi maior que768MiB e o launcher conferiu novamente antes de cada build. Compilações seriais; env limpo, Git nativo sem promisor/rede e K2read-only. Nenhuma tentativa de fetch foi registrada; não houve fornecedor, conta ou pagamento real. Custos não medidos continuam desconhecidos.

Dados iniciais preservados: `m-2910-runtime/targeted-results-initial.json` SHA256 `9c0e2db8c9270d1adc0d61d289c33c3a39432f6012cd461f2566096d23861ec0`, `own-original.log`, respectivos exit files e `original-author-attempt.json`. Root centraliza publicação/comentário. Este incremento não fecha storesKnownFor, outOfKeys ou todos os getters e não constitui parecer limpo/CI global.

## Resultado final após correção causal da fixture de compra

O histórico acima não foi apagado. Primeiro, a prova original `07eb196daf64b4a96daf8b5d49b6f75d6af1bd94552ed84c5f85e0502bc8ce70` exigia indevidamente um formulário. Depois, a tentativa `3076129ad049c97ef24df2a409bb71bc08a988336d8f9e9f92f6478333061c36` exigiu o destino da caixa de compra sem suas tags: parou no saudável do caso1 em ambos os braços,11,765s/log5.109bytes,1216comandos por braço/2432acumulados,fetch0/cappedfalse. O SSR capturado mostrou query `utm_source=website&utm_medium=buy-button` antes de `#buy`. Essa segunda tentativa também é falha de fixture, não falha do produto. Os dois textos e seus logs permanecem em `original-own-proof-07eb.ts`/`own-original.log` e `own-proof-first-contract-307612.ts`/`own-first-contract-attempt.log`.

Após novo GO, a composição passou a usar os helpers reais `tagged(productPath(...),placeFrom(undefined))+'#buy'`, conforme card:151,195,204 e embed-rules:78–85. Antes da primeira página, uma asserção pura exige o literal controlado `/@m2910shop/p/m-guide-1-${present}?utm_source=website&utm_medium=buy-button#buy`, com primeiro produto/título da fixture. Esse é setup do controle de compra, não teste/certificação do tagger. Só depois o SSR saudável deve confirmar href inteiro, rótulo exato `Buy for $40` e classes de action anchor; os negativos recusam esse mesmo destino+rótulo e conservam a verificação de ausência de form. Nenhum link genérico serve como positivo.

Prova final SHA256 `6dfbe2c60a461951bc3f18f8d2039595b77133b8e77395e575acfc542af98ca4`:51checks anteriores conservados/corrigidos mais1check puro de setup,52no total em6grupos. Fonte de produto, aliases, autor30 e driver corrigido c1f3 permaneceram intactos. Executada uma única vez sob o último GO; o autor30 não foi repetido.

| Scope final | Anterior | Head a1cf | Conclusão limitada |
| --- | --- | --- | --- |
| fixture-contract | 1/1 | 1/1 | Href literal estabelecido antes do SSR; saudável confirma o mesmo destino. |
| four-fixes | 42checks/19falhas | 42/42 | Correções focais reproduzidas com controles válidos. |
| inherited-lang | 7checks/7falhas | 7checks/7falhas | Ausência de atributo explícito herdada; en é benigno sob root en-US;6idiomas diferentes continuam candidato LOW. |
| inherited-soon-shape | 1check/1falha | 1check/1falha | Agora negativo probatório: envelope curto oferece o mesmo destino de compra do saudável. Residual herdado, sem novo M+ automático. |
| inherited-store-shape | 1check/1falha | 1check/1falha | Página real ainda responde vazio para envelope curto do getter herdado. Sem novo M+ automático. |

Os positivos de ausência legítima e os demais controles foram mantidos. O exit1 final é preservado: nove checks herdados falham no head, apesar de42/42 no scope focal. Não há parecer clean global, fechamento de getters/soonOne ou duplicação da prova C6→R2 storesKnownFor.

O par final consumiu8,955s/log16.175bytes/fontes13.719.432bytes. Comandos por caso anterior e incremento head foram os mesmos:1219,260,20,2,29,10; acumulados2438,520,40,4,58,20, total3080. FetchAttempts0/cappedfalse em ambos. Nenhum teto atingido; heap512MiB,120s externos KILL/128KiB/16MiB mantidos. A composição conservadora incluindo a prova atual nas duas versões soma16.509.288bytes, abaixo de16MiB.

Resultados finais: `targeted-results.json` SHA256 `2b19e51d2171548dd6da073361e2f37ab9b1d7ee4f42db0a2f15b3fa8d2f6429`; `author.log` SHA256 `0b1902ed8f4b3f5acdaa1dd05801012408691fd99216470ec845dc75a759d39d`; `own.log` SHA256 `d0fca0350f39ad2c5f10f85e46de106889a676420ddb8cbe08e219a799a8e939`. Somente execução dirigida, sem fullsuite/browser/CI global; tipos/lint dirigidos foram feitos na etapa abaixo. O resultado carrega de a1cf para o código de produto/helper/autor idêntico em f09; não declara execução de uma árvore f09 reconstruída.

## Tipos e lint dirigidos, após novo GO

Sem repetir autor30 ou própria52, strict TypeScript5.9.3 passou com exit0/log0bytes. Os5roots reais foram a prova própria byte-ID6dfbe2, as3páginas alteradas e lib/buyer-library.ts. O fechamento estático incluindo imports multiline/type-only teve450arquivos com SHA conferido contra a árvore a1df;8blobs adicionais foram materializados do store local, sem API. Para tipos, redis/ai-spend são as fontes reais, sem os aliases de runtime da suíte. Nenhum stub/noCheck/noResolve ou declaração falsa foi introduzido.

A configuração auxiliar própria, dentro da view, estende o tsconfig real blobf126992 e mantém strict, paths, JSX e skipLibCheck originais. Só fixa os5roots, include vazio, noEmit e incrementalfalse. As únicas entradas ambientais adicionais são os arquivos oficiais instalados `next/types/global.d.ts` e `next/image-types/global.d.ts`, com hashes registrados; não foi criada next-env falsa. O resultado cobre os roots e imports resolvidos normalmente; skipLibCheck preservado não certifica as declarações de terceiros nem equivale a Next build/tipos de todo o projeto.

ESLint passou com exit0/log0bytes nos2artefatos próprios, copiados com identidade de bytes para seus caminhos de repo na view. Usou `eslint.config.mjs` real blob05e726d1b4201bc8c7716d2b058279676582e8c0, contexto de projeto real e max-warnings0, sem reduzir regras. Prova6dfbe2 e driverc1f3 não mudaram.

Ambos foram seriais, heap768MiB/timeout externo120s/log128KiB. Folga observada antes dos comandos:5.689.995.264bytes strict e5.630.631.936bytes lint, maior que1,5GiB. Fontes continuaram abaixo de16MiB; nenhuma API, fornecedor, fullsuite, browser ou CI foi acionado. Evidência própria: `m-2910-runtime/strict-lint-results.json` SHA256 `2774a004dc251b0f63e354b397dcf9044c293797fc56e35e27c865b26c8e1576`, `strict.log` e `lint.log` vazios, respectivos exit0 e configurações/manifestos. Esses dois passes dirigidos não eliminam os9checks herdados nem tornam o parecer global limpo.

## V2 de portabilidade do launcher, separada e ainda sem pares de produto

O driver usado nos resultados30/52 acima continua c1f3, sem alteração, com backup `original-driver-c1f3.mjs`. Aqueles comandos fixaram PATH nativo e ambiente Git externamente em commands-native; isso não provava que o c1f3 era internamente independente do PATH. A V2 é hardening futuro e não cria uma nova medição histórica de rede.

Candidata separada: `proofs/m/review-2910-store-readings.v2.mjs`, SHA256 `629b181513724c04232a5433512f524fe4c778df84ba7d7fb6f0e4535d172421`. Ela usa `/usr/bin/git` fixo e ambiente Git construído do zero, sem callerGIT_*/HOME/PATH, desliga config de sistema/global, nega todos os protocolos com GIT_ALLOW_PROTOCOL vazio mais protocol.allow=never, lazy-fetch, interação e hooks. O preflight usa parsing nativo `git config --no-includes --file` isolado, antes das leituras de objetos do repo, e recusa includes, promisor em configuração/packs, alternates/http-alternates, common-dir e symlinks de controle.

O object root futuro é `m-source-recovery`, agora autônomo, sem alternate. O preflight conferiu árvore8be,4127caminhos/4126blobs únicos presentes via headers nativos, e os14overlays/SHAs já fixados. Não materializou a fonte inteira nem precisa de arquivos auxiliares externos de validator. `--preflight-only` termina antes de importar test-config, módulos de produto ou esbuild. Em modo normal, também fixa PATH nativo no ambiente do processo de prova. Os limites e os corpos de source loader/plugin/bootstrap, as14strings de snapshots e a prova52 foram conferidos idênticos ao c1f3, exceto pelo hardening Git e seu preflight.

| Verificação leve V2 | Resultado |
| --- | --- |
| node --check, heap20MiB/10s | exit0,0,048159s, saída vazia; pico RSS observado25.216KiB. |
| Positivo com store autônomo e PATH/GIT_CONFIG/GIT_DIR/alternates env do chamador adulterados | exit0,14overlays conferidos, nenhuma importação de produto; wrapper Git falso não foi invocado. |
| Negativo promisor, config+pack próprios | exit2 esperado com ambos os motivos; nenhuma importação de produto. |
| Negativo include+alternate próprios | exit2 esperado com ambos os motivos; sentinel de include com sintaxe inválida não foi seguido. |
| Lint somente da V2JS, config real/max-warnings0/heap256MiB | exit0/log0bytes, sem reduzir regras. |

Os3casos usam o mesmo validator da CLI V2, não uma cópia de sua lógica ou modelo do produto; logs somam746bytes, guardas heap64MiB/10scada. Só fixtures de filesystem próprias foram criadas. Nenhum GET, alteração no object root alheio, referência, conta, fornecedor, CI ou execução dos pares30/52 ocorreu nesta fase. Prova6df e driverc1f3 permanecem byte-identificados. Evidência `m-2910-runtime/v2-portability-results.json` SHA256 `b7f2949a4e033ac084f274a8e7a4dabaddd934d179c8ac2d98817c5d0cbedebf`.

Ainda falta novo GO e execução dirigida antes de atribuir os resultados de produto à V2. Root poderá publicar seu conteúdo no caminho canônico do runner entre os mesmos3artefatos, preservando o histórico; a V2 não exige commands-native para configurar Git. Comando explícito preparado, ainda não executado como produto: `node --max-old-space-size=512 proofs/m/review-2910-store-readings.v2.mjs --git-cwd /workspace/scratch/d1ece80b1417/m-source-recovery --deps /workspace/scratch/d1ece80b1417/m-2910-runtime/view`, com `--own` apenas no par próprio e tetos externos120s/128KiB mantidos.
