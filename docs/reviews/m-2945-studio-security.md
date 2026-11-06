# Revisão independente M — PR #2945

Estado em 06/11/2026: leitura e prova causal concluídas. Os dois ajustes nominais foram confirmados; a prova própria tem dois REDs condicionais de interface já presentes no controle da página-base. Não foi demonstrada nova regressão deste diff, bypass, perda ou alteração dos registros de segurança. Este documento não é aprovação formal do PR.

Reserva anterior à unidade: recibo de canal `d1aa610b02ced0d866748b1d6bf167dade71848b`, 22h43 UTC. Head examinado `23f66687f471f7aeea3194edaf2fb7db02affbac`; base `8ade3ca13e658c63c578e768f40d547d81a3d8b8`, de #2913. Publicação é exclusiva do root.

## Escopo e fontes

O diff integral tem três caminhos: `app/studio/page.tsx`, `tests/studio-security-unread.test.ts` e `tests/passkey-app-code-invite.test.ts`. A alteração produtiva acrescenta o guard de conhecimento da recuperação no passo inicial e o guard `twoStepRead !== null` no convite do autenticador. O helper do convite permanece igual. Não há alteração de gate/autorização no diff.

As páginas foram recuperadas por SHA, sem usar checkout vivo: blob head `94af2f8e0e0b6558ae82df0d3ea0ea3ccb9ca76a`, 215.773 bytes; blob base `0b923767e9621e6be8a81a79899dfd5f2a49c9f5`, 215.663 bytes. As 16 fontes recebidas foram conferidas pelo Git SHA-1 do conteúdo, somando 672.821 bytes. O recebimento completo está em registro de trabalho local; esses helpers não integram os três caminhos de publicação reservados.

Foram lidos os leitores de passkeys, recuperação e two-step, o gate, `studio-route`, `team`, os dois managers, `StudioStart`, o componente/helper do convite e a configuração canônica de testes. Os 12 blobs dessas dependências são iguais aos do frozen `1721109f1d2d3930cde6c54f6fe71412648043e3`. Isso não prova igualdade da árvore inteira: a comparação primária 172→head lista 21 caminhos diferentes, inclusive `lib/data-families.ts`, importado transitivamente por `closed-store-data` e `data-recount`. Também mudaram `lib/verify-mail.ts` e `components/site-footer.tsx`; o fechamento real de imports deve decidir quais são necessários.

O root autorizou cinco GET adicionais, exclusivamente para GitData commit/tree e os três blobs atuais citados. Orçamento final fechado: 25/25 GET e 4.731.137/6.291.456 bytes. Os primeiros 21 recebimentos conservam a contabilização conservadora; os quatro restantes usam o tamanho UTF-8 do resultado serializado completo, incluindo campos duplicados. Nenhuma mutação GitHub/canal/ref/CI.

O TREE recursivo primário tem `truncated:false`, 4.704 entradas e 572 árvores. Recalculei os objetos tree a partir dos nomes, modos e SHAs; todas as 572 árvores conferem, inclusive a raiz `eb53e01730e4bb007d9ed6dda70094104ff16acf`. Reconstituí os bytes do commit assinado usando `verification.payload` e `verification.signature`: o hash Git do commit de 1.099 bytes confere exatamente `23f66687f471f7aeea3194edaf2fb7db02affbac`. Não criei um HEAD simulado.

Os blobs adicionais conferem com o manifesto: `lib/data-families.ts` → `60a8873c20a10a5f035969c158e94be66b818ebb`; `lib/verify-mail.ts` → `01ccc4b86d1f4521b2f55453be0db4b2a9182c30`; `components/site-footer.tsx` → `b61c38df9292133bfd014ad44895e8a1c805bce1`. A vista própria contém 735 arquivos, 10.487.959 bytes: cada arquivo foi materializado e conferido pelo blob SHA do manifesto atual. O object store172 forneceu somente blobs com esse SHA exato, não decisões baseadas em semelhança de checkout. Zero blobs dessa vista ficaram ausentes. A pasta própria inteira somava 12.444.328 bytes após a preparação, abaixo de16MiB.

Essa vista cobre o fechamento anterior da página real e dos seus gates/fixtures; um import adicional encontrado na compilação futura deverá ser resolvido contra o mesmo manifesto e fará a execução parar caso o blob exato esteja indisponível. A comparação com8ade usará a página base exata como RED controlado, mantendo o restante da vista head: somente Page é produto no diff2945, os outros dois caminhos são testes. Não foi recuperada nem certificada a árvore8ade completa.

## RED do autor: evidência e limite

O commit primário RED foi alcançado: `04523ff33135b79c3519552f4d5c7d98f7b93dd4`. Ele acrescenta dois checks de texto/regex no teste `studio-security-unread.test.ts`: a expressão do spread do passo recovery e a presença literal do guard do convite. Executei o arquivo exato atual com a página-base controlada: 9 checks, 2 falhas esperadas, exit1; com a página-head exata: 9 checks, zero falhas, exit0. Isso confirma o RED/fix de fonte; não é execução do checkout inteiro do commit RED. Os outros 64 testes mencionados no corpo continuam alegação do autor, sem repetição nesta unidade.

O teste de convite alterado apenas atualiza a string esperada e seu rótulo. Esses testes podem fixar a forma do código, mas não demonstram que o leitor real falha, que a página real mantém as mensagens corretas, nem que um link visível tem seu destino montado.

## Leitura independente e resultados

| Ponto | Evidência de fonte | Situação nesta fase |
| --- | --- | --- |
| Unknown de recuperação, sem passkeys conhecidas | Página:1164–1169 transforma exceção em null; :1198 omite o passo | Caso real: base passa recovery TODO; head omite. Objetivo nominal confirmado nas props reais de StudioStart |
| Unknown de two-step com passkey conhecida | Página:1162 recebe null; :1269 impede o convite | Caso real: convite base1→head0. Objetivo nominal confirmado na árvore React |
| Recovery ilegível, app conhecido OFF e passkey válida | `securityUnread` em :1167 esconde ambos os managers em :3310 e :3406, mas :1269 consulta apenas o conhecimento do app. `AppCodeInvite` aponta `#two-step`; esse id pertence a `TwoStepManager`:145 | RED próprio: convite montado1 e manager/destino0 em base e head. Residual condicional LOW, não regressão2945; apresentação efetiva do convite depende da hidratação/sessionStorage não executados |
| Passkeys ilegíveis, endereço conhecido vazio | Página:1156 captura falha de `listPasskeys` como []; :1198 aceita `recoveryRead !== null`, e :1199 passa `done:false`. O leitor real `listPasskeys`:193–211 lança para resposta desconhecida | RED próprio: recovery TODO nas props de StudioStart em base e head, embora a credencial armazenada permaneça intacta. Residual condicional LOW; não prova passo atualmente visível nem perda/bypass/regressão |
| Reset banner quando two-step é desconhecido | Página:1168 ainda usa fallback reset0; ramo do banner em :1255 | Residual explicitamente reservado ao Claude6/#2900 pelo autor; não duplicar como achado novo desta unidade |

As recusas dos gates devem ser preservadas. A prova anterior CX118 sobre convite em sessão por link e o controle saudável que refutou deadend geral de set_up continuam históricos, não serão executados novamente nem classificados como regressão2945.

## Prova executada e caps

Foram seis casos, sem repetição automática. Cap de 3.000 comandos internos do MemoryRedis por caso, acumulando setup, página-base, página-head e verificações; 18.000 no agregado, com admissão antes de cada invocação, inclusive chamadas recursivas internas. Limites de 120s por execução, log128KiB, fonte16MiB, objetos128MiB e zero rede externa. Sessão, store, credencial armazenada, leitores, gate e componentes são reais. A falha foi injetada no GET exato do MemoryRedis; não substituí `StudioPage`, `mayAddSecondStep`, `studioView`, `team` ou a decisão de conhecimento.

1. Nenhum fator e recuperação conhecida vazia: controle saudável de passo pendente e managers disponíveis.
2. Passkey válida, app OFF conhecido e recuperação vazia: controle saudável de recuperação concluída, convite e destino presentes.
3. Sem passkey, recuperação lança: omissão do passo desconhecido no head, comparada com a base.
4. Passkey válida, two-step lança: convite omitido no head, comparado com a base.
5. Passkey válida, app OFF conhecido, recuperação lança: conferir convite, ausência/presença do manager e destino `#two-step`, discriminando residual anterior.
6. Credencial válida previamente armazenada, inventário de passkeys lança, recuperação vazia conhecida: conferir se o passo representa unknown como pendente; conservar e conferir a credencial depois da injeção.

| Caso real | Base controlada → head | Comandos acumulados |
| --- | --- | --- |
| Nenhum fator, recuperação vazia conhecida | recovery TODO, managers presentes, gate permite o primeiro fator → igual | 786 |
| Passkey válida, app OFF conhecido, recuperação vazia | recovery DONE, convite1, manager/destino presente, gate permite → igual | 780 |
| Sem passkey, recuperação lança | recovery TODO → omitido; managers ausentes com notice nos dois | 786 |
| Passkey válida, two-step lança | convite1 →0; recovery DONE e notice nos dois | 778 |
| Passkey válida, app OFF, recuperação lança | convite1 com manager/destino ausente → igual; gate permite, portanto não é recusa de segurança | 780 |
| Credencial válida armazenada, inventário de passkeys lança, recuperação vazia | recovery TODO, needsStep true, gate lança erro → igual; credencial permanece intacta | 780 |

Resultado próprio: **18 checks, 16 PASS e 2 RED**, exit1; zero falhas nos 12 checks de controles/observação/integridade. O gate no último caso lança o erro de leitura injetado, não responde que há zero fatores; a página conserva a recusa por `needsStep:true`. O runner registra esse erro como `Error` sem transformar unknown em autorização.

Comandos totais: **4.690/18.000**; maior caso786/3.000. Zero envios, zero tentativas de rede e zero comandos de escrita dirigidos às quatro chaves de segurança protegidas durante a injeção; snapshots antes/depois iguais. Isso não alega ausência de todas as escritas incidentais da página: o contador de segurança cobre especificamente lista/claim de passkey, recuperação e registro two-step, não caches e locks de outras famílias.

Execução externa: **26,978s**, heap512MiB. O preflight leu9.229.496.320 bytes de `/proc/meminfo:MemAvailable`, isto é, folga do **host**, não do cgroup. Não foram capturados `memory.max`/`memory.current` no instante anterior à execução; portanto a condição de GO de pelo menos1,5GiB livres no cgroup **não está demonstrada**. O runner consultou apenas host para essa admissão; não se alega que essa verificação cumpriu o requisito do cgroup. O resultado causal18/2 e o log original permanecem preservados, sem rerun para reconstruir ou esconder a lacuna de metadata.

Leitura posterior, somente atual, em **2026-11-06T23:08:13.667085Z**: `/proc/meminfo:MemAvailable`6.829.813.760 bytes; `/sys/fs/cgroup/memory.max`8.589.934.592; `/sys/fs/cgroup/memory.current`5.347.708.928; diferença atual3.242.225.664 bytes. Esses valores não são histórico do runtime e não provam retroativamente sua admissão. O registro completo está em `validation/resource-headroom-note.json`, helper local sem publicação. Antes de reutilizar o driver com essa exigência, o preflight deve medir também o cgroup; essa correção futura não foi aplicada nem executada nesta entrega.

Log6.572 bytes, SHA256 `e2ece34bdf6a1e2ee0b9ff910f74af0da20738e16857437c33b9dda8be2286c2`; resultado JSON78 bytes, SHA256 `1eaad720c09ecaa8640711eaa208c2e78d450c405f789e6a6734506f60e3abab`. O grafo compilado carregou708 entradas,10.425.722 bytes incluindo o controle-base. O ODB próprio somava34.993.823 bytes no preflight. Nenhuma asserção, fonte ou guard foi alterado depois desse resultado para obter verde.

Comando local: `M2945_OBJECT_ROOT=/workspace/scratch/d1ece80b1417/m-review-2945/objects.git node --max-old-space-size=512 proofs/m/review-2945-studio-security.mjs`, sob launcher externo120s/log128KiB. Em um clone normal com os objetos head/base, `M2945_OBJECT_ROOT` pode apontar para o repositório que os contém; o driver recusa partial/promisor, alternates e includes antes de ler árvores/blobs, ignora configuração global/sistema, usa `/usr/bin/git` nativo e proíbe protocolos externos. A flag de heap do comando integra o limite; não há descoberta automática de objetos pela rede.

## Limites da prova e recorte seguro

A medição principal é da árvore React devolvida pela página real. Só o `TwoStepManager` selecionado foi renderizado com `renderToStaticMarkup` para conferir seu destino. Não houve DOM, browser, hidratação, teste humano, AAA ou login WebAuthn assinado; o controle usa credencial COSE real armazenada pelo fixture canônico e sessão aberta pelo método real com a marca passkey.

O recovery TODO do sexto caso é uma prop real, não prova de visibilidade do passo nessa fixture: `startList` prioriza oferta/publicação/share e só depois mostra recovery. A leitura de `StudioStart`/`studio-start-rules` sustenta a consequência condicional quando o passo chega à fase posterior, mas esse percurso visível não foi executado. Da mesma forma, presença de AppCodeInvite na árvore não prova que seu aviso já apareceu no browser; o componente depende de useEffect e sessionStorage. A classificação proposta é LOW condicional de interface, sem grau MED inventado.

O world virtual substitui somente Next headers/cookies pelo fixture canônico, `after` por descarte, redirects/notFound por throw e hooks de navegação por valores fixos sem efeito. O banner bloqueia fetch/http/https/net/tls antes do grafo; o único fetch admissível seria POST sintético para o endpoint exato Resend, até6, sem chamada ao original. O transporte canônico sintético também tem admissão de até6 tentativas. Nenhum SDK foi usado para contactar fornecedor. Redis/AI-spend/transport aliases canônicos continuam limites de harness, não prova de Redis real, Lua real ou transporte real. O wrapper MemoryRedis de medição/falha é test-only e instalado antes do redis-stub, preservando os leitores de negócio.

Próximo recorte documental ao dono da página: alinhar a condição do convite à existência do manager/destino; manter o conhecimento do inventário de passkeys distinto de lista vazia ao calcular o recovery tick. Ambos podem reutilizar as leituras existentes, sem novo IO; não enfraquecer gates, esperas ou permissões. Coordenação com Claude6/C4 antes de qualquer produto, preservando o residual de reset já atribuído ao C6 e a prova CX118 anterior.

## Bloqueios e próxima ação

Na preparação, a janela de memória foi reservada ao G2/G3 pelo root; nenhuma compilação começou antes do GO posterior. O transporte de exec local apresentou uma desconexão transitória e voltou em probe posterior; nenhum resultado veio da chamada malsucedida. A tentativa de transportar todas as fontes como um único argumento excedeu ARG_MAX; a conferência posterior usou somente os hashes e confirmou os bytes recuperados, sem novo GET. `node --check` do runner passou antes da única execução. TypeScript próprio ainda não foi executado; não há alegação de types PASS.

O bloqueio de pin transitivo foi resolvido pela extensão autorizada de leitura e pelo fechamento descrito acima. A comparação da base permanece RED controlado da página, sem alegação de certificação da árvore-base completa. Os seis casos terminaram; não é necessário repeti-los para tornar o RED verde. Nenhum produto, gate, conta, flag, fornecedor ou CI foi alterado nesta revisão.

## Verificação dos próprios artefatos

- Sintaxe: `node --check proofs/m/review-2945-studio-security.mjs` → exit0, sem saída, antes da execução causal.
- ESLint: configuração canônica do head, blob `05e726d1b4201bc8c7716d2b058279676582e8c0`, aplicada aos dois arquivos de código próprios → exit0, 0 erros e 0 warnings no JSON, 3,204s. O stderr contém diagnóstico de contexto Next: a pasta pages não existe na raiz da vista mínima. Não houve desativação de regra e não se alega log0. Markdown não recebe lint de código nessa configuração.
- Scanner público canônico do head, blob `a9823fcbc9fec88703f4df39c8f3822c673edbea`, função `findings` aplicada estritamente aos três caminhos próprios → 3 examinados, 0 ocorrências. Não é scan de todo o repositório.
- `git diff --no-index --check /dev/null <path>` nos três arquivos novos → nenhuma mensagem de whitespace; exit1 esperado pela existência de conteúdo novo, sem stdout/stderr. Não foi modificado o índice nem qualquer ref.
- TypeScript próprio não foi executado nesta unidade; não há types PASS nem equivalência de árvore publicada. Não houve suíte completa, browser, CI ou mutação remota.

Os logs e os recibos de fonte permanecem apenas na pasta própria de trabalho. Os únicos arquivos de publicação são este relatório, `tests/m-2945-studio-security.proof.tsx` e `proofs/m/review-2945-studio-security.mjs`. O root decide a publicação e a coordenação com o dono da página.


## Complemento posterior — tipos scoped e preflight futuro

Os17.008 bytes iniciais deste relatório preservam exatamente o blob10346fa5fd6cc83d20dbedc00c0b6297ab59f88d. A frase histórica de TypeScript não executado foi sucedida pelo check scoped abaixo; o runtime18/2 não foi repetido. A prova07cd e o runner5a18 permanecem os bytes históricos executados. O root publicará primeiro esses originais e, somente depois, decidirá a substituição V2 de JS+MD nos mesmos caminhos; nenhum helper ou caminho V2 novo é proposto para publicação.

Complemento de validação da mesma revisão M2945 — 06/11/2026

Os três originais e a prova causal foram preservados. A cópia original do relatório tinha blob10346fa5fd6cc83d20dbedc00c0b6297ab59f88d, a prova07cd84ae4a8e13eb302115104596c018fc67990b e o runner5a181d4f1c97f8d64ea6bea209e4414db85d9fe3. O log18/2 mantém SHA256e2ece34bdf6a1e2ee0b9ff910f74af0da20738e16857437c33b9dda8be2286c2. Nenhum caso, cookie, gate, asserção ou produto foi mudado; não houve repetição do runtime18/2, nem execução da V2.

Correção futura separada

A cópia proofs-v2/m/review-2945-studio-security.mjs tem blob2d5b7d403f235e1c2a2769ec30ea3c0fd69b7740,11.778 bytes. Seu diff altera somente admissão/metadata do preflight: exige /sys/fs/cgroup/memory.max e memory.current finitos, inteiros seguros e consistentes, rejeita "max"/malformado/atual acima do teto e recusa folga menor que1.610.612.736 bytes. /proc/meminfo:MemAvailable passa a ser explicitamente metadata do host, sem servir como folga do cgroup. O registro inclui caminhos e data da leitura. Os guards de transporte, source pins e6casos/18asserções ficam iguais.

Node --check V2 passou, exit0. ESLint somente do JS V2: exit0,0erros/0warnings no JSON,3,037s; stderr preserva o diagnóstico de contexto Next sobre pasta pages ausente na vista mínima. Não é log0. Não se fez TSC de JS, nem se chamou o preflightV2 inteiro, pois isso executaria os casos. A sintaxe/lint não são alegados como validação runtime desse guard. Os originais não receberam novo lint.

O limite histórico permanece honesto: o runtime18/2 capturou somente host MemAvailable9.229.496.320; não capturou cgroup naquele instante. A leitura atual23:11:34UTC registrou memory.max8.589.934.592, current4.073.508.864 e folga4.516.425.728, sem reconstruir passado. A leitura anterior23:08 também é apenas atual. Nada disso demonstra retroativamente a admissão do runtime18/2.

TypeScript estrito real, escopo autorizado

Uma única compilação Node768MiB, timeout externo120s, log128KiB. Admissão imediatamente anterior em2026-11-06T23:14:52.560247Z: /sys/fs/cgroup/memory.max8.589.934.592; /sys/fs/cgroup/memory.current4.007.342.080; folga4.582.592.512>=1.610.612.736. Registro strict-admission.json, SHA2560a6d769ec210bbc9ff0f25853a351d536d21d2a998fa9f7c2c5a6c8aadaaf259.

Quatro roots: Page do head23f66687, tests/studio-security-unread.test.ts, tests/passkey-app-code-invite.test.ts e a prova própria original. A Page-base é import transitivo controlado exato, não uma árvore-base completa. O manifesto usado é TREEeb53e01730e4bb007d9ed6dda70094104ff16acf. Configuração canônica do head: strict/noEmit, mesmos JSX/module/lib/skipLibCheck, incremental desligado; só @/* aponta para a fonte própria verificada. Não há aliases de runtime para Redis/AI/Next/gates, stand-ins de negócio ou declarações vazias/fabricadas. checkJs:false limita explicitamente o alcance: não valida tipos do runnerJS.

Foram usados dois ambients oficiais, sem modificar bytes ou gerar rotas fictícias: node_modules/next/types/global.d.ts, SHA2568e10ae5cb4548fe3ee1d33b0b0a215de662f4ea8e0e267f7aa22fa7637394286; e next/image-types/global.d.ts, SHA256b789bf89eb19c777ed1e956dbad0925ca795701552d22e68fd130a032008b9f9.

Resultado: exit0, ZERO DIAGNÓSTICOS TOTAIS, TypeScript5.9.3,60,649s externos/59,996s no compiler. 1.488 sourceFiles,725 arquivos head conferidos por blob. Somente dois arquivos reais adicionais precisaram materialização: lib/redis.ts, blob3a6aaa809fc78bfe1202e44a6c5fdd8abb02bac6,2.896 bytes; lib/ai-spend.ts, blob9513d4c53c7af9892fa82a18efbf5ee95d00b092,8.746 bytes. Ambos estavam no ODB local, confirmados contra o manifesto; zero TYPE blobs ausentes e zero novos GET. Fonte própria passou a10.499.601 bytes, abaixo de16MiB.

strict-real.log:1.344 bytes, SHA256a7bab497a93179487b54c5293a278153a424de1c2ec661b642dc84c265b61696. strict-real.result.json:1.559 bytes, SHA256636e55b43d0874d238539d5780eff32c199461ab628ed5da07181e4993e79099. O resultado0 é do conjunto completo autorizado e seus imports, não apenas de linhas próprias; ainda é um check scoped, não TypeScript do projeto inteiro nem aprovação global. Não elimina os dois REDs condicionais preexistentes nem os limites React/SSRselecionado do relatório original.

Sem API adicional, CI, ref, publicação, browser, fornecedor, conta, flag, gate ou produto. Root publica/coordena; os helpers da pasta validation-v2 continuam locais.


## Histórico de quota e confirmação posterior da TREE-base

A nota a seguir preserva o estado histórico após a consulta403 de23:22:38UTC. Seu rótulo de candidata não comparada foi sucedido pela confirmação canônica posterior registrada depois dela; não representa o estado final da identidade de metadados.

M2945 — reconstrução estática da candidata à árvore-base

Estado: CANDIDATA DE METADADOS, NÃO COMPARADA COM A TREE CANÔNICA8ade. A qualificação atual de Page-base controlada permanece. Nenhum runtime, TypeScript, browser, CI, ref ou produto foi executado/alterado nesta etapa.

A única consulta autorizada foi raw GitData commit8ade3ca13e658c63c578e768f40d547d81a3d8b8. Ela falhou403 por quota GitHub em06/11/2026 23:22:38UTC, requestID E3D3:1058CE:384302:5F130B:6AEE612B. Resposta1.819 bytes<16KiB. Orçamento fechado26GET/4.732.956 bytes<6MiB; zero retries ou consultas posteriores. Sem tree canônica recebida, não se alega igualdade da árvore-base inteira nem commit-base assinado reconstruído.

Partida: TREEhead assinada/verificada eb53e01730e4bb007d9ed6dda70094104ff16acf. Usei índice próprio validation-base/reverse-own.index, sem mudar HEAD/ref/checkout alheio. O patch integral já recebido possui exatamente três caminhos, todos existentes nesse PR. `git apply --cached --reverse --check` e a aplicação reversa passaram sem erro. Nenhum teste foi deletado: o teste unread foi adicionado entre172 e o ramo mais novo, mas já existia na base específica deste PR.

Resultado nativo `/usr/bin/git write-tree --missing-ok`:
16269479e5fa4877c96e7cbce6296d6de7b47acb

O catálogo contém4.133 arquivos. Só estas três entradas diferem do manifesto-head; modo100644 preservado em todas:
- Page:94af2f8e0e0b6558ae82df0d3ea0ea3ccb9ca76a →0b923767e9621e6be8a81a79899dfd5f2a49c9f5.
- tests/passkey-app-code-invite.test.ts:d06a6613ad39d31fc82a39cb68ee2ac5125f2a12 →736d2aa9d6d854f2c58c94aaaa0f7ecf70a5abeb.
- tests/studio-security-unread.test.ts:0d47bc30aaeef92f21ab57eff53ebc5c2f88b54e →71df07413c244b24b15b7f5974961a37e94952c2.

Os dois testes antigos foram efetivamente reconstruídos pelo patch Git; seus conteúdos e hashes foram lidos novamente do ODB e guardados em reconstructed-base/. A Page reconstituída confere com o blob-base0b923 já obtido e usado no controle. Todas as demais entradas path/mode/SHA continuam exatamente as da TREEhead verificada.

`--missing-ok` calcula a árvore do catálogo de paths/modos/SHAs já conhecidos; não inventa conteúdo de blob. O write-tree padrão havia parado por um blob off-graph não materializado e inalterado no diff deste PR: tests/mail-check-route-world.ts,f7388bdac0761d3ec0e567eefdc43f932b74c52c. A opção foi usada sob instrução explícita do root para calcular metadados. Não é afirmação de que todos os blobs off-graph estejam disponíveis. Uma checagem auxiliar inicial de contagem foi corrigida:4.704 entradas do manifesto incluem571 diretórios sem contar a raiz, portanto4.133 arquivos e572 árvores incluindo a raiz; não4.132 arquivos. Isso não alterou patch, índice nem produto.

Recibo detalhado: reconstructed-base-tree.result.json.
Root proof ID: sha256:6c60ff13c19cfcb1af38c0bc0bdb64868b696c4c75115695e6bac25ffbf02aca.
Esse ID é SHA256 do registro de prova em JSON com chaves ordenadas/separadores compactos antes de adicionar o próprio campo rootProofId. A conclusão é candidata até comparação com a tree canônica da base, ainda inacessível por quota.

Preservados sem mudanças nesta etapa: relatório final01aebe6a0ed8c37381faac7633a9f0aa75f46e52 com prefixo10346, prova07cd84ae4a8e13eb302115104596c018fc67990b, runner original5a181d4f1c97f8d64ea6bea209e4414db85d9fe3, V2local2d5b7d403f235e1c2a2769ec30ea3c0fd69b7740 e log18/2e2ece34bdf6a1e2ee0b9ff910f74af0da20738e16857437c33b9dda8be2286c2. A publicação continua exclusiva do root; nenhum helper novo é proposto para publicação.


Confirmação posterior alcançada pelo root, sem nova consulta deste subagente: o GitData canônico do commit8ade3ca13e658c63c578e768f40d547d81a3d8b8 retornou tree.sha16269479e5fa4877c96e7cbce6296d6de7b47acb, exatamente igual à reconstrução nativa pela reversão dos três deltas. O root informou verification.verified=true/signature valid na resposta primária. A resposta-base completa não foi recebida/materializada por este subagente e não foi reconstituído aqui um commit-base assinado.

Portanto, a identidade dos metadados da TREE-base canônica está confirmada pela consulta primária do root; os path/mode/blobSHAs fora das três mudanças são iguais aos do head. O before Page e os demais imports reais usados na prova correspondem ao source closure produtivo da base real. O teste autoral novo foi intencionalmente executado na versão head sobre a Page-base, para observar seu RED; isso não é execução da suíte inteira ou dos testes originais da base.

Essa confirmação não afirma que todos os conteúdos off-graph estejam fisicamente presentes. O uso de write-tree --missing-ok continua somente cálculo de catálogo por path/mode/SHA. O403 anterior e a falta histórica de admissão cgroup não são apagados. O root contabilizou a consulta canônica posterior como27ª consulta do recorte, ainda abaixo de6MiB; não foi feita outra consulta por este subagente nem novo runtime/TypeScript.
