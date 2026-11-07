# Revisão G8 #2915 — janela explícita de desafio

Head nominal: **149a6fdf0c2808f525601cb5588674ebcf1a1abd**. PR aberto, não draft, dois paths. Claim do root6696212756 antecede leitura; a reserva/GO no canal f8b42d1da478277e37a6180bed8697c22e57b6f8 antecede diff, código e testes. Branch própria nova confirmada ausente por API404 antes da unidade.

**Sem GRAVE/MÉDIO funcional no classificador. Há um LEVE de compatibilidade do teste com o target real do projeto**, que impede relatar a checagem de tipos do recorte inteiro como verde nesse target. A unidade é inerte: não entrega desafio ao cliente, não cria política de dias, calendário/fuso, check-in, pontos ou persistência, e não muda UI, permissões, preços, limites, comissão ou gates.

## Escopo lido e comportamento conferido

Diff completo: lib/community-challenge-rules.ts novo,25 linhas; tests/community-challenge-rules.test.ts novo,126 linhas. A função aceita somente números primitivos inteiros no intervalo fechado de Date, ±8640000000000000 milissegundos. Janela vazia/invertida ou qualquer argumento inválido retorna invalid. Início inclusivo/fim exclusivo; a classificação usa somente now fornecido e compara instantes, sem somar duração ou consultar relógio externo.

Busca integral por challengeWindowState/community-challenge-rules em app/lib/components/tests/scripts encontrou somente o módulo e o permanente do autor (mais a prova manual desta revisão depois de criada). **Nenhum chamador produtivo**. Não há integração, efeito de rede/armazenamento, fluxo de privacidade ou promessa pública nova a certificar. Não rodei testes globais ou testes de features sem ligação com esse helper.

## RED inteiro e GREEN byte-idêntico

RED do autor: **04fa7ab06967c0637ca817abf73d7ef9e8bd61f6**. O permanente inteiro foi executado, sem selecionar casos: **91 testes, zero aprovados,91 falhas**, porque a nova exportação ainda estava ausente. O import computado tratou ERR_MODULE_NOT_FOUND e permitiu que os91 asserts falhassem de forma executável; não foi falha de bundler ou uma alegação de regressão de funcionalidade existente.

No head nominal: **91/91**. O permanente tem o mesmo blob nos dois commits: **554ed8d950dfb26278f1744201d5f0be87c2a706**. Os outputs completos estão no arquivo de saída. O checkout final voltou ao head nominal.

## Prova independente

Arquivo novo tests/j-2915-challenge-window.proof.ts: **18 verificações,18 aprovadas**.

- Matriz de1331 triplas incluindo os dois limites Date e seus milissegundos adjacentes, janelas antes/depois do epoch, vazias e invertidas. Oracle independente por comparação BigInt e pertinência ao intervalo, sem subtrair instantes nem somar duração ao relógio.
-75 vetores inválidos (25 valores em cada uma das três posições): NaN/infinidades, frações/subnormal, strings, booleanos, arrays, objetos, Date/Number boxed, bigint/symbol, números seguros fora do intervalo Date e extremos numéricos.
- Limites adjacentes explícitos, signed zero, proxies revogados e hooks de coerção que não podem ser consultados.
- now omitido nunca usa relógio ambiente; Date.now proibido não é consultado. Quinze vetores de translação mostram os mesmos estados em três epochs distantes. Uma janela de largura maior que MAX_SAFE_INTEGER mantém os estados sem aritmética de duração.

O estado active começa exatamente em startsAt e termina antes de endsAt. Nenhuma asserção exige política de calendário, limite de duração ou funcionalidade não solicitada.

## LEVE — literal bigint do permanente não compila com target ES2017

Local: **tests/community-challenge-rules.test.ts:82**: o caso bigint usa `1000n`. O tsconfig real tem target ES2017. Na checagem strict/noEmit do módulo, permanente e prova, com imports reais e typeRoots Node explícito, o diagnóstico restante é unicamente:

`TS2737: BigInt literals are not available when targeting lower than ES2020.`

O módulo isolado passa no target real. O recorte completo passa se o comando sobrescreve target para ES2022, mas isso altera a premissa de validação; não é verde sob a configuração do projeto. A correção sugerida ao autor é usar BigInt(1000), preservando exatamente o tipo e o caso de coerção, sem mudar target/gates. Nenhum arquivo do autor foi editado.

O NextConfig não declara ignoreBuildErrors e o script CI chama next build; **não executei build nem observei falha de CI**, portanto não afirmo esse efeito como ocorrido. O achado demonstrado é a falha do typecheck do recorte sob o target versionado. A primeira configuração temporária também produziu erros ambientais por procurar @types a partir de /dev/shm; corrigir typeRoots eliminou esses erros e isolou TS2737. A prova própria usa BigInt(0), compatível com o target, e foi reexecutada depois desse ajuste de entrada equivalente, antes de ser preservada.

## Demais conferências e limites

ESLint dos dois paths do autor, prova e runner: **zero erros/avisos**. Scanner tracked: **4133 arquivos, zero ocorrências**; scanner explícito dos quatro novos paths: **zero ocorrências**. Diff-check do PR e whitespace próprio: aprovados. O arquivo de saída normaliza apenas espaços finais para Git; os raw logs originais foram preservados. O arquivo permanente é descoberto pelo padrão .test.ts de tests/run.mjs; a prova .proof.ts é somente execução manual. O runner usa testAliases/testEnvironment canônicos; os tipos usam os imports reais, sem mocks.

Antes de cada filho, o wrapper bloqueia sockets TCP/TLS/UDP, DNS, fetch global e o dispatcher da mesma undici do SDK. Controles negativos de socket e destino não registrado precisam passar **antes de carregar o grafo**; falha interrompe o filho. Todos passaram. Este helper puro não tentou fornecedor/rede; não houve conta, pagamento, contato ou browser.

Não rodei navegador, suíte global, Redis nativo, fornecedor ou CI. Não mexi em produto, ramo do autor, workflows, provas antigas2844 ou seus logs/refs. A revisão diz apenas o que foi executado no head nominal, sem certificar integração futura ou disponibilização ao cliente. O formal e a decisão de incorporação ficam com o root.

## Independent return — exact source 32abdc784041d2982568d61467f8778c04aa46af

This English addendum records a **source-only return with execution blocked**. It does not replace the historical evidence above. The original source 149a6fdf0c2808f525601cb5588674ebcf1a1abd and evidence commit 2efd2fceb4f9dc9a2e364059b85f47f095cd2008 remain preserved. The old proof, runner and output are unchanged. Their previous results are historical results, not a rerun on this return.

Coordination: the combined claim/resumption was published through CAS 58b85bb9 before this return's source inspection, after the coordinator sent GO. GitHub metadata independently reported PR #2915 open, non-draft, and exact head **32abdc784041d2982568d61467f8778c04aa46af**, with two PR paths.

### Complete delta and preserved contract

The complete comparison from 149a6fdf0c2808f525601cb5588674ebcf1a1abd to 32abdc784041d2982568d61467f8778c04aa46af reports one added commit, one modified file, one added line and one removed line:

```diff
-    ["a bigint", 1000n],
+    ["a bigint", BigInt(1000)],
```

Full old/new file text was retrieved. Exact string comparison confirmed that replacing only this occurrence in the old text yields the complete new text. There is **no 0n replacement** in this author delta. Cases, labels, expected states, coercion checks and all other assertions remain identical. The original RED permanent is therefore intentionally not byte-identical to the return permanent, while the test value remains the bigint value 1000.

| Artifact | Original source blob | Exact return blob |
| --- | --- | --- |
| tests/community-challenge-rules.test.ts | 554ed8d950dfb26278f1744201d5f0be87c2a706 | 0d1dd74ac67a345cec9405e7ae21ab7294032371 |
| lib/community-challenge-rules.ts | 902dd245207dd391d275f60c888ecbe386c601a1 | 902dd245207dd391d275f60c888ecbe386c601a1 |
| tsconfig.json | f126992ca95c6da5359e547a2e58e92fccd3d02c | f126992ca95c6da5359e547a2e58e92fccd3d02c |
| tests/community-points.test.ts | 95a73fc8f3a8dac4cc209144a002fb9382a0bbe3 | 95a73fc8f3a8dac4cc209144a002fb9382a0bbe3 |
| tests/course-templates.test.ts | 8671e6822071235b87082fb2f12a9631643014ec | 8671e6822071235b87082fb2f12a9631643014ec |

The real config still targets ES2017 and includes esnext library declarations; it was not raised to conceal the old diagnostic. The source repair matches the earlier LOW recommendation: use the BigInt function rather than bigint literal syntax. This removes the offending source construct without changing the pure helper. **Independent actual-target typecheck success is still pending execution**, rather than inferred from the replacement or copied from the author's report.

The helper's entire source was reread. It remains an unwired, pure classifier of supplied integer millisecond instants, with an inclusive start and exclusive end, no ambient clock, and no storage, points, daily-calendar policy or public feature activation. The author delta adds no caller. No new functional finding was established.

### RED provenance and execution limitation

The whole original feature-RED test at 04fa7ab06967c0637ca817abf73d7ef9e8bd61f6 was retrieved again: blob 554ed8d950dfb26278f1744201d5f0be87c2a706, matching the original source and historical evidence. No RED replay was possible in this return. The PR body also names type-RED 96a043693216f7e7e3e5c66a73ef07330dc4e05a. A contents request for tests/community-challenge-rules.test.ts at that exact ref returned HTTP 404; this establishes only that this path/ref request was unavailable. It does not establish that the commit is absent or that the author's separately published compiler artifact is defective. That additional artifact was not independently certified.

After the coordinator reported executor recovery and authorized GO, the first and only local process request failed before the requested git status command could start:

```text
exec_command failed: CreateProcess {
  message: "Rejected(\"Failed to create unified exec process:
  exec-server rejected request (-32603):
  No such file or directory (os error 2)\")"
}
```

No product graph or test child loaded, and no provider or network call was made by a product process. The process failure is an environment/setup limitation, not a RED test result. No alternate shell, executor, sandbox, browser or provider was used, and there were no further process retries.

| Requested independent return check | Status on exact 32abdc784041d2982568d61467f8778c04aa46af |
| --- | --- |
| Whole feature RED and return permanent | NOT RUN — process creation unavailable |
| Existing independent 18-case proof | NOT RUN — historical proof preserved unchanged |
| Linked community-points and course-templates | NOT RUN — source blobs compared only |
| Actual ES2017 strict TypeScript with real imports | NOT RUN |
| Scoped ESLint | NOT RUN |
| Public-data scanner | NOT RUN |
| Local git diff/whitespace and discovery checks | NOT RUN |
| API complete delta and full source comparison | READ AND COMPARED — one fixture line only |

The author's claimed final 91/91, linked29/29+23/23, types, lint, scanner and diff results remain **author-reported**, not fresh independent execution results. No global suite, browser or CI was run or modified.

Factual disposition: the source of the previous LOW has been repaired in the exact author delta, with unchanged configuration, helper and remaining assertions. This return is **incomplete for executable confirmation** and does not certify an all-green exact-head review. A runnable same-environment replay of the listed focused checks is required to close that qualification. Only this existing review report is appended on the existing own evidence branch; author product files, author refs and CI remain untouched.


## Executed independent return after executor recovery — exact 32abdc784041d2982568d61467f8778c04aa46af

This addendum supersedes only the execution-blocked qualification above. The previous failures, old outputs, proof and runner remain history and are not rewritten. C4-3050/C4-3070 remain active: this evidence is **local only**, with no push, author-ref change, main integration, CI rerun/cancellation, or merge.

### Exact source and causal type RED

A private detached worktree was created from exact author commit 32abdc784041d2982568d61467f8778c04aa46af using the existing Git object store. Git confirmed that the entire author delta from 149a6fdf0c2808f525601cb5588674ebcf1a1abd remains the single fixture substitution from `1000n` to `BigInt(1000)`. The helper, real tsconfig and remaining permanent assertions are unchanged.

The original permanent test was extracted without modification from 149a6fdf0c2808f525601cb5588674ebcf1a1abd to an external temporary file. Git hash-object confirmed **554ed8d950dfb26278f1744201d5f0be87c2a706**, identical to the original whole permanent. With the real repository config inherited at target ES2017, the unchanged actual helper and correct Node declaration roots, the compiler returned exactly one diagnostic and exit 2:

```text
j-2915-original-permanent.test.ts(82,18): error TS2737: BigInt literals are not available when targeting lower than ES2020.
```

The final permanent and actual helper under the same config returned exit 0. A further directed program including the exact independent proof and its real imports also returned exit 0. The directed configuration changed only the root-file list, declaration-root resolution and nonpersistent tooling options (incremental false, plugins empty, no emit); target, strictness, module mode, resolution, libraries and JSX settings remained inherited. No target override, source shim, error suppression, provider or build was used.

The earlier unavailable ref/path was also resolved precisely. Commit 96a043693216f7e7e3e5c66a73ef07330dc4e05a exists in the recovered local Git store; it adds **docs/reviews/t-e2-e7-es2017-red.md** and **scripts/t-e2-e7-es2017-types.mjs**, not tests/community-challenge-rules.test.ts. The historical 404 for that test path therefore did not establish a missing commit. I read the complete evidence document, which explicitly distinguishes its original CompilerHost RED experiment from a packaged script not replayed then. This return independently reproduced the relevant E2 diagnostic as above; it did not execute the unrelated E7 unit or substitute the author's account for execution.

### Actual focused executions

The existing independent proof and runner were copied into the exact author worktree, and Git hash-object confirmed byte identity with the durable own evidence:

| Artifact | Blob |
| --- | --- |
| tests/j-2915-challenge-window.proof.ts | dd89ec2d5580ee425cf549133115c7ed4e90c517 |
| scripts/j-review-2915-challenge-window.mjs | 566224df5214d9bfe4a428efde7004c7f04e51dd |

The first copy operation briefly added a terminal blank line; that copy was corrected with no executable-content or assertion change before the hash confirmation. The completed execution used the same proof assertions; the normalized copies are byte-identical to the preserved evidence. No weakened expected value was introduced.

The existing runner used the canonical testAliases and testEnvironment. Its negative controls blocked TCP/TLS/UDP/DNS, global fetch and the same undici dispatcher before each product graph, and passed in all four children. The processes were bounded by a 120-second outer limit. The classifier is pure; no storage, provider or browser call was attempted.

| Check on exact author source | Observed result |
| --- | --- |
| Permanent community-challenge-rules.test.ts | 91/91 PASS |
| Unchanged independent proof | 18/18 PASS; 1,331 ordered triples, 75 invalid-position vectors, 15 translations |
| Linked community-points.test.ts | 29/29 PASS |
| Linked course-templates.test.ts | 23/23 PASS |
| Four groups together | 161 passing checks; no failed group |
| Actual ES2017 strict directed types, final helper/test/proof and real imports | Exit 0 |
| ESLint for helper/test/proof/runner | Exit 0; no errors or warnings |
| scripts/check_public_data.py on author tracked snapshot | 4,133 files; 0 corrections |
| Complete author-delta and local diff whitespace | Exit 0 |
| Canonical discovery | permanent remains a *.test.ts file; manual proof is not claimed as automatically discovered |

The ordinary whole feature RED at 04fa7ab06967c0637ca817abf73d7ef9e8bd61f6 was not rerun in this return: its historical 91 missing-export failures remain preserved. The new causal RED here is the exact old permanent's actual-target TS2737 diagnostic. No global suite, Next build, hosted CI, browser, accessibility conformance, or productive community feature is certified.

### Disposition

The previous ES2017 fixture LOW is **closed on exact 32abdc784041d2982568d61467f8778c04aa46af**. No new grave, medium or light finding was established in this focused return. This pure unwired helper is suitable for the author's normal merge only after the coordinator's MAIN VERDE order, all nine final successful checks of the exact final head, fresh raw/native clean merge state and the author's expected-head normal merge. Any future productive caller, daily calendar, points, storage or public promise requires its own review. The root owns the formal PR disposition.
