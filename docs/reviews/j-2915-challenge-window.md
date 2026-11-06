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
