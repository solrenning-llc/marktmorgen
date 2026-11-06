# Revisão M — #2926, nominal 2e070

**Revisão parcial, sem aprovação.** Foi observado RED controlado dos testes autorais de helpers/texto: as mesmas 39 asserções passaram no head e tiveram34 falhas sobre os fontes capturados da base. O39/39 do head é **CARRY de uma rodada anterior**, não nova medição. Nesta última janela foram medidos somente HEAD 46/46, BASE 46/46 e BASE 39 com34 falhas. Os 46 incluem SSR real de ErrorNotice; nenhum desses resultados mede DOM, teclado ou foco no navegador. O candidato Pictures/upload pendente continua sem confirmação runtime.

Head congelado: `2e070b21ddd995c669d7cf0f8a07846475ca43df`. Base: `98c47cbccd75e0d97f748983842c164f3352c6a0`. Claim anterior às leituras: `31fb7ab2c7c98db0d681ffa734c51ab99b60d60a`. O coordenador centraliza publicação, comentários e parecer no GitHub; M não alterou produto, refs, canal, CI ou fonte do autor.

## Fontes e conformidade

Diff integral atual lido: app/globals.css, components/page-editor.tsx, lib/block-insert.ts, tests/page-editor-undo-clear-a11y.test.ts e tests/quote-paste-integrity.test.ts. Também foram lidos os deltas diretos locais de editor/CSS a804→2e. O compare entre os commits diverge com merge-base 28cb; suas estatísticas não foram confundidas com diff direto entre árvores.

| Conteúdo do recorte | SHA Git completo |
| --- | --- |
| Editor head | `81da81a65c5b9abaf7e6121809afcb8d5c94f631` |
| Editor base | `cdf89c856fcaa25b0597f7a6ce64140a47b5734f` |
| CSS head | `c88c415d325304acd10cd8dc38f05a9b4d1af0b1` |
| CSS base | `6674a5dc8485afd1c6a2347fb582a4e6c3e2b720` |
| block-insert head | `2e24b866c55f1108592855a8e4dfc76c9c8cd9c9` |
| block-insert base, reconstituído | `c2f8cb88ceaa756366ab14be6d7a6d0d0b1a5f1f` |
| focus-when-drawn | `925d0751b9eb2d2eceb3405f57a27fc88552ef09` |
| page-style-picker | `19751d3a0a37ec1d433432339a7b56e5662bd950` |
| saved-sections | `efb52463e74e42ce140aa1a423ff602136b03dd4` |

Editor/CSS head/base e helper head foram obtidos no ref exato. O helper da base foi reconstituído revertendo somente seu patch atual contra o helper head verificado; o resultado coincide com o SHA completo conhecido. A proveniência está no manifesto incorporado. Os outros três módulos preservam seus conteúdos exatos; os compares completos não indicaram mudança nesses caminhos.

A vista própria de runtime contém146 arquivos / 2.149.422 bytes; a de inputs de tipos contém243 arquivos / 3.224.089 bytes. Elas foram materializadas de objetos locais e overlays verificados. **Atestação do coordenador, às 2026-11-06 23:19:00 UTC**, não um GET de M: o GitData tree real do commit2e é `cf02aba2da8c7838d0c78e446ec884308d0ba5cd`, recursive, truncated=false, 4694 entradas. O coordenador comparou todos os 243 inputs strict e 146 inputs runtime com essa árvore: **zero diferenças de caminho/SHA**. Redis real da vista também coincide. Isso verifica os inputs declarados do head; **não equivale a reconstrução ou verificação da árvore inteira da base 98**.

O mesmo tree já obtido pelo coordenador confirmou, sem GET adicional, estes quatro blobs 100644:

| Teste/helper real atual | SHA | Bytes |
| --- | --- | --- |
| tests/page-editor-undo-clear-a11y.test.ts | `8e68efd5a0ecbabce5c4a607b7f2d5b173c514e6` | 10161 |
| tests/page-editor-block-actions-a11y.test.ts | `0ac2188c69adbec43fe7e73f158615dc15df6b49` | 14456 |
| tests/check.ts | `37a70d6bd5b5d8b2d6cb97bb8d5d95ce10454699` | 1286 |
| tests/test-config.mjs | `46ddad8f5d5225f6b0e9b22d63310255ba652090` | 19865 |

A cópia física de test-config na recuperação tinha uma linha alheia diferente; M usou os bytes nativos por SHA, depois corroborados pelo tree atual. Não presumiu que aquela cópia física era o nominal. Fontes/instruções a804 anteriores foram preservadas como histórico, sem serem apresentadas como o novo head.

## O que foi executado

Os testes head foram mantidos byte a byte sobre os dois conjuntos de PageEditor/helper/CSS. Nenhum checkout/ref/base assinado foi fabricado. O46 usa renderToStaticMarkup do ErrorNotice público real; não foi extraído/reimplementado PicturesEditor ou outro negócio privado. O check e a tabela de aliases são os do autor.

| Evidência | Resultado observado | Proveniência |
| --- | --- | --- |
| HEAD 39 undo-clear | 39/39, exit0, rede0, stubs0 | **CARRY**: primeira rodada, runner `85aff36bdb032b7137a199292caf5be2b9434d46`, log `9876fef56bb05f419fdae72d2c792c7123088781`. Não repetido. |
| Primeira tentativa HEAD 46 | HARNESS antes das asserções | Alias canônico redis-stub.ts ausente, vindo de product-about.ts:18/store-data.ts:28. A rodada parou; nenhuma base foi executada nela. |
| HEAD 46 block-actions/SSR | 46/46, exit0 | Nova janela, alias ao Redis real. |
| BASE 98 mesmo46 | 46/46, exit0 | Nova janela, controle parte 1. |
| BASE 98 mesmo39 | 39 checks,34 falhas, exit1 | Nova janela: RED controlado qualificado da parte 2,5 passando. |

Na correção do harness, somente o alias Redis foi ligado ao módulo real já verificado: lib/redis.ts `3a6aaa809fc78bfe1202e44a6c5fdd8abb02bac6`, que importa fetch-timeout `f64429555ba43472ac4e77c9ad66ecaec47ab2df`. Não foi criado stub ou retorno fictício. O módulo não faz IO no import. A guard de rede foi pré-carregada antes do grafo, com ambiente mínimo sem credenciais; cobertura V8 e bytesInOutput verificaram a execução. **Redis real foi removido por tree shaking nos três bundles**: redisRetained=false, chamadas Redis0, marcadores de rede0 e business stubs importados0. Isso não prova comportamento do Redis em produção.

A rodada nova mediu **três casos e 131 checks**, com o 39/39 anterior carregado separadamente. Terminou em 3.692 ms, log 15.552 bytes, exit0 do orquestrador. Maior input por caso: 1.738.610 bytes, abaixo de16 MiB. Heap 768 MiB, um compilador serial; folga antes de iniciar 4.471.365.632 bytes, acima de 1,5 GiB. Deadline efetivo 115 s, dentro dos 120 s totais admitidos; log 128 KiB. Não houve browser ou instalação.

Runner medido: `bffde6628e48fb9451b9170250eb944a215f4ceb`. Log dos três casos: `fa599184d72f00798bf2415c0834df3a6d3511d8`. O RED **não é replay do commit RED original do autor**; é o teste head atual aplicado aos fontes capturados da base. Os nomes das asserções falam de foco, mas a medição é de helpers/texto/SSR, sem foco real.

## Tipos, lint e scanner

TypeScript 5.9.3 strict real passou: exit0, 13,593 s, log0, com a prova TSX, fixture, PageEditor original e imports reais. A configuração manteve strict/noEmit e o jsxImportSource do projeto; referências Next apontam às declarações instaladas reais, sem declare/module/props/locale inventados ou typegen de rota. Não certifica o projeto inteiro ou novas rotas.

A prova TSX não foi alterada depois desse PASS: **`04e220f575eab95426f2d00f99a527f3d06f04ed`**. Usa o PageEditor público real e contexto real do roteador Next. O fixture deriva DEFAULT_LOOK e EMPTY_PAGE dos exports públicos, tem um bloco pictures e uma imagem sintética no formato válido; StoreLook não foi inventado.

ESLint dirigido dos dois artefatos passou depois de corrigir somente settings de contexto: React 19.2.8 real e rootDir do app recuperado; nenhuma regra desativada. A primeira tentativa havia emitido 416 bytes de avisos de detecção. Depois de empacotar os snapshots, o lint do JS passou em 2,794 s/log0. Após incorporar a reprodução autoral, o lint do launcher e do módulo incorporado passou **exit0, 3,193 s, log0**. Node --check de ambos passou. Não houve novo TSC nem nova rodada de testes depois do empacotamento.

O scanner canônico findings, SHA `a9823fcbc9fec88703f4df39c8f3822c673edbea`, é usado com allowlist explícita dos três caminhos reservados, sem chamar seu main/Git de PATH e sem acrescentar regex de detecção. Além dos três arquivos, o carrier é decodificado e os conteúdos verificados separadamente para não ocultar dados sob codificação. A aplicação final encontrou **zero ocorrências** nos três arquivos, nove snapshots causais, oito itens de evidência incorporados e quatro fontes autorais/helpers decodificados. O manifesto local registra seus hashes; o escopo não é todo o repositório.

## Candidato Pictures/upload pendente — ainda sem DOM

| Etapa | Confirmado por leitura do fonte head | Verificação que falta |
| --- | --- | --- |
| Superfície real | PageEditor público; encaixe pictures em :1640–1653. PicturesEditor é privado, :3925. | Montar o PageEditor e alcançar esse bloco com evento real. |
| Upload pendente | busy em :3962; choose guarda busy e inicia envio em :3989–3994; endpoint local em :4012–4015. | Manter envio real local pendente e observar o estado. |
| Remoção do único item | Remove em :4087–4099 não tem disabled/guarda busy; filtra items e chama o foco. | Pressionar Remove e aguardar renderização real. |
| Destino | Helper em :3473–3476 escolhe Add quando não sobra item; Add está disabled enquanto busy em :4104. | activeElement, :focus-visible e visibilidade no controle ocioso e pendente. |
| Encerramento | focus-when-drawn :28–33 chama focus ao achar o alvo e retorna sem confirmar aquisição. | Observar o efeito no navegador; não afirmar que terminou em body ou outro elemento. |

Na base atual, Remove está em :4028 sem o novo envio de foco. A recomposição onChange([...items,...added]) existe tanto na base :3966 como no head :4025: não é atribuída como regressão do PR. O teste DOM preparado observará a lista e o foco **antes** de concluir/recusar o envio, isolando essa causa preexistente. Falha também na base precisa ser tratada como cobertura incompleta, não automaticamente regressão introduzida.

A prova DOM preserva o componente real: controle ocioso e upload local pendente, teclado, lista final, activeElement/:focus-visible/visibilidade. Apenas a fronteira de upload fica pendente e depois recebe503 local; não há token/URL de fornecedor/sucesso fabricado. O handler POST real foi conferido, blob `3f6738de46163d36558c586a0b3d4698d4917e80`, e não é executado pelo harness. O PNG sintético anterior tinha CRC IDAT inválido; o literal do JS foi corrigido e seus CRCs/zlib conferidos, **sem decode por browser**. Isso era dado de harness, não defeito do produto.

Clear, undo/redo, repetição de status e movimentos de borda têm controles helpers/textuais atuais passando no head; o DOM e o anúncio por leitor de tela continuam sem execução. Não houve teste humano, AAA ou publicação inspecionada. Nenhum grau runtime foi atribuído ao candidato Pictures.

## Três artefatos reproduzíveis e limites

Somente estes caminhos são entregáveis de repositório:

- docs/reviews/m-2926-page-editor.md;
- tests/m-2926-page-editor.proof.tsx;
- proofs/m/review-2926-page-editor.mjs.

O launcher incorpora o manifesto causal exato `3145902603cc2e94570fd8f7ca2a3dc29ac48946`, nove snapshots / 731.970 bytes com SHA completo, e fixture default `af58fca012778653cdc408ab2ce7cf31bd167c07`. Não exige ROOT/snapshots ou JSON de fixture não publicado. Conteúdos são decodificados/verificados em memória e materializados somente no temporário próprio .m-2926-bundle-*.

O modo opcional **--author-tests** incorpora um módulo de reprodução e oito itens de evidência com seus SHAs. Preserva os runners/logs originais 85aff/9876 e bffde/fa599, inclusive a primeira falha de harness e a observação negativa de cleanup. O módulo incorporado é `a2885dd132db1014c5a5e577af42b832e5acbe84`: deriva do runner medido, alterando só ligação ao carrier incorporado/IPC/prefixo de temporário e pós-condição de limpeza. As asserções e fontes do autor permanecem byte a byte. **Esse módulo empacotado não foi reexecutado**; passou em sintaxe/lint. Ele mede os três casos e identifica o39 anterior como CARRY, sem anunciar quatro casos novos.

Entradas explícitas continuam necessárias: --project-sources para fontes verificadas, --git-object-root para repositório de objetos autônomo e dependências exatas preexistentes. --dependencies permite indicar a pasta; o padrão é a K2 somente leitura já verificada. Versões: React/react-dom 19.2.8, Next 16.4.2, esbuild 0.28.2, TypeScript 5.9.3 e playwright-core 1.56.1. Sem instalação, conta ou fetch automático. Git usa /usr/bin/git absoluto, cwd do object root, sem GIT_* herdados/globais/protocolos/lazy fetch; includes/promisor/alternates/shared config são recusados. Inputs comuns são checados individualmente, não por equivalência presumida de todo main172.

Exemplo de forma, sem autorizar nova execução:

    node --max-old-space-size=768 proofs/m/review-2926-page-editor.mjs --authorized-window --author-tests --project-sources FONTE_VERIFICADA --git-object-root REPOSITORIO_AUTONOMO --dependencies DEPS_EXATAS

Para DOM, omite-se --author-tests e executa-se --before e depois head em série, somente com nova janela. Um build serial e um browser por run, dois contextos; no máximo dois browsers no conjunto base/head, 120 s/128 KiB por run, heap768. O launcher incorpora CSS fonte, mas ainda não o transforma/carrega: sua observação preparada é de geometria/foco nativo, **não certifica aparência ou contraste do anel da aplicação**.

**Cleanup teve observação negativa.** Após a rodada nova apareceu um temporário próprio HEAD-only, sem PID com cwd ativo. Sua causa não foi estabelecida; não se alega finally perfeito. Foram registrados hashes de 11 arquivos, removido apenas esse diretório próprio e confirmado inventário vazio. Evidência original e registro de limpeza manual ficam incorporados. O pacote acrescenta pós-condições que falham caso o temporário permaneça, mas essa mudança de cleanup não foi validada por nova rodada. As pastas compartilhadas m-source-recovery/K2 não foram apagadas ou alteradas.

Chromium físico segue não localizado: é o bloqueio mecânico conhecido para iniciar DOM neste ambiente. Bundle/materialização/cleanup do modo DOM e os eventos ainda podem revelar erro de harness; não foram convertidos em sucesso por inferência. Não há parecer clean, APPROVE ou autorização de incorporação.

## Histórico e orçamento

A etapa a804/base 28 anterior e seus snapshots foram preservados. Depois da nova reserva, foram lidos/repinados2e/base 98, recuperadas as dependências exatas, executados strict/lint e empacotados snapshots. A tentativa autoral inicial concluiu HEAD 39 e parou antes de SSR46; nova janela corrigiu só o alias ao Redis real e mediu os três pendentes. Nenhum head posterior foi perseguido automaticamente e o RED original do autor não foi refeito.

Orçamento cumulativo compartilhado desta revisão: **35/40 leituras e 2.943.228 bytes/5 MiB**. Inclui as duas leituras autorais de M e um GET do coordenador para o tree cf02, 1.148.960 bytes de JSON HTTP canônico, informado por ele; não é GET de M e não foi contado duas vezes. Histórico de cache anterior permanece separado: 85/128 e 6.710.106 bytes/16 MiB. Zero GET novo no empacotamento/validações finais. Sem custo financeiro estimado: ausência de tráfego externo medido nestes casos não significa custo zero de CPU/tempo/CI.
