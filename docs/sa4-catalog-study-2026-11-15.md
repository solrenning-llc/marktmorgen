# 772 [SA4], unidade 1: o que lê o catálogo inteiro e quanto custa por produto (15/11/2026)

Estudo de documento, sem código. Feito por Claude 2 (continuando Claude 1 cloud S), a partir do main `e4dbb5e9b` e do ramo do PR #4580. Nada aqui muda `MAX_PRODUCTS` (2.000, `lib/catalog-rules.ts:3`), `MAX_STORE_LINKS`, `MAX_LINKS`, preço, limite visível, comissão, trava ou flag. É uma conta feita a partir do código, não uma medição em produção. Custo que não foi calculado aqui fica "desconhecido", e desconhecido reprova.

## Como os custos foram calculados

Os valores usam as tarifas do próprio repositório (`lib/spend-cost-table.ts`), pelo `readShapeCost` de `tests/plan-cost-registry.ts`:

- Upstash: US$2 por milhão de comandos, US$0,03 por GB trafegado e US$0,25 por GB guardado por mês.
- Vercel: memória de 2 GB, CPU e chamada, nas tarifas de `lib/spend-cost-table.ts`.
- Uma leitura de produto (listing) vale, no pior caso, `LISTING_READ_BYTES = 16.384` bytes (`lib/read-ceilings.ts:56`), que é o teto de revisão já usado no registro.
- A primeira página da loja (`STORE_PAGE_SIZE = 24`, `lib/catalog.ts:83`) vem dentro do registro da loja (`catalog.head`). Só os produtos fora dela são lidos um a um, em lotes de 400 por pipeline (`getMany`, `lib/catalog.ts:655-658`).

Conta de uma leitura do catálogo visível inteiro, feita com o código do registro (script local, não commitado):

| Produtos na loja | Leituras de produto | Custo de uma leitura inteira (US$) |
| --- | --- | --- |
| 2.000 (teto atual) | 1.976 | 0,005025 |
| 10.000 | 9.976 | 0,025030 |
| 100.000 | 99.976 | 0,250086 |

Em média, cerca de US$0,0000025 por produto lido, contando comandos, bytes e CPU. Para comparação, uma página pública a mais (`laterPageCost`, `tests/traffic-cost.ts`) custa US$0,000063.

## Limite estrutural: o índice do catálogo mora no registro da loja

O registro da loja tem no máximo `MAX_STORE_BYTES = 1.000.000` bytes (`lib/store.ts:295`) e é lido inteiro em toda visita (`GETRANGE`, `lib/store.ts:1193`). O índice do catálogo vai dentro dele (`catalogRecord`, `lib/catalog.ts`): por produto, `[id, tipo, ...ids das opções]`.

- O id do produto tem 10 caracteres (`lib/store.ts:3292`). A entrada de um produto no índice tem no máximo 33 bytes.
- As opções de preço têm teto **por loja**, não por produto: `MAX_STORE_OPTIONS = 4.000` (`lib/product-option.ts:65`), com ids de até 24 caracteres (`OPTION_ID`, `:108`). `MAX_OPTIONS = 50` (`:53`) é o teto de um produto.
- `tests/catalog-ceiling.test.ts` já faz essa conta a partir do código e falha se ela mudar. O pior índice com 2.000 produtos e 4.000 opções tem cerca de 175 KB e cabe no registro de 1 MB. O formato comporta cerca de 5.400 produtos no pior caso e cerca de 37.000 no tamanho de um produto real.
- Uma gravação que faria o registro passar de 1 MB é recusada com `StoreFullError` (`lib/store.ts:1669`), salvo quando ela diminui o registro, para que remover, encurtar e reordenar continuem possíveis.

(Correção de 15/11/2026: a primeira versão deste estudo contava as opções por produto, chegava a 1,4 KB por produto e dizia que 2.000 produtos poderiam não caber. Errado: o teto é da loja, e o teste acima prova que cabem.)

Conclusão: o teto atual cabe com folga, mas um catálogo sem teto fixo, ou um teto acima de uns 5.400 produtos (o pior caso que o formato comporta), exige tirar o índice do registro da loja (unidade 2). Sem isso, cada visita a uma loja grande ficaria mais cara e mais lenta, e uma loja chegaria ao limite do registro antes do limite de produtos.

## Inventário dos caminhos que leem o catálogo inteiro

O inventário foi feito por busca no código e conferido nos pontos principais. A frequência é a do código; nenhuma foi medida em produção.

### Caminhos públicos ou de cada visita

| Caminho | O que lê | Quando roda | Custo por chamada no teto atual |
| --- | --- | --- | --- |
| Busca da loja: `searchStore`, `lib/catalog.ts:1009`, chamada em `app/[handle]/page.tsx:224` | todos os produtos visíveis fora da primeira página | a cada busca de visitante, quando a loja tem mais de 24 produtos; ritmo de 30 buscas a cada 10 minutos por endereço e loja, e uma requisição pública (`withinStore`, `lib/metered-limits.ts:22`) | US$0,005, contra US$0,000063 da requisição cobrada. **Já registrado:** issue #4144 e PR #4172 |
| Mapa do site da loja: `storeSitemap`, `lib/store-sitemap.ts:83` e `:91` | todos os produtos visíveis fora da primeira página | a cada pedido do mapa (robôs de busca) | o mesmo da busca; não conferi se há cache ou ritmo — **ponto a conferir** |
| Página da loja, página do produto, checkout e carrinho (`visibleCount`, `offersCart` em `lib/cart-checkout.ts:66`, `productIdFromAddress`) | só o índice que já vem no registro | toda visita | nenhum comando a mais; CPU proporcional ao número de produtos e o registro inteiro trafegado |

### Caminhos do estúdio

| Caminho | O que lê | Quando roda |
| --- | --- | --- |
| Listas de escolha de produto (`readCards`, `readTitles`, `lib/catalog.ts:1040` e `:1119`) | um `HGETALL` do hash de títulos; se faltar, lê os produtos que faltam e corrige o hash uma vez | várias telas do estúdio |
| Produtos de um tipo (`readKind`, `idsOfKind` + `readListings`): chamadas, cursos, pacotes (`app/studio/page.tsx:873` e `:2236`, `app/studio/students/page.tsx:44`, `app/studio/bundles/page.tsx:52`, `lib/learn.ts:240` e `:397`) | todos os produtos daquele tipo | telas do estúdio e algumas rotas de curso e vídeo; frequência não medida |
| Salvar um produto (`app/api/store/product/route.ts:88`, `readAllListings`) | o catálogo inteiro, mais os produtos de funis | a cada produto salvo |
| Estoque de produto avulso (`soldWithOthers`, `lib/store.ts:2724`) | o catálogo inteiro | quando o criador define um estoque |
| `lib/auto-marks.ts:61` (`readListings` sem filtro) | o catálogo inteiro | quem chama não foi rastreado — **ponto a conferir** |

### Tarefas ocasionais e em segundo plano

| Caminho | O que lê | Quando roda |
| --- | --- | --- |
| Calendário de reservas (`app/api/store/calendar/[token]/route.ts:51`, `readKind(store, "call")`) | todas as chamadas da loja | já tem preço no pior caso: `CALENDAR_BUILD_SHAPE` usa `MAX_PRODUCTS` (`lib/read-ceilings.ts:119-126`), com teto de construções por dia |
| Importações (`membersStep`, `lib/imports.ts:1383`) | o catálogo inteiro | a cada importação |
| Exportação da loja (`lib/store-export.ts:94` e `:198`) | o catálogo inteiro, duas vezes, mais os textos das aulas | a cada exportação; já é precificada por medição antes |
| Fechamento e limpeza (`lib/closed-store-data.ts:154`, `lib/plan-closing.ts:650`) | o catálogo inteiro | uma vez por loja, em tarefa diária |
| Recontagem (`lib/data-recount.ts:155`) | o catálogo inteiro, serializado | por loja, com cursor entre lojas |
| Cópia de loja (`lib/store-copy.ts:145` e `:155`) | todos os produtos | ocasional |

Caminhos já limitados, que não leem o catálogo inteiro:

- guia: `app/api/store/guide/route.ts:48`;
- assistente: `lib/store-assistant.ts:218`;
- próxima oferta: `lib/next-offer.ts:375`;
- IA de sequências: `app/api/store/ai/route.ts:313`;
- API pública paginada e precificada antes: `lib/api-read.ts:92`;
- estatísticas: `lib/stats.ts:2366`;
- escolhas de pacote: `lib/bundle-choices.ts:121`.

## O que isso significa para "produtos ilimitados"

1. **Com o teto atual**, o único caminho público de catálogo inteiro sem preço próprio é a busca, e ele já está tratado pelo #4144 e pelo #4172. O mapa do site fica como ponto a conferir.
2. **Com 10 mil ou 100 mil produtos**, todo caminho da tabela cresce 5 ou 50 vezes. Uma busca passaria a custar cerca de US$0,025 ou US$0,25, um salvar produto o mesmo, e cada visita trafegaria um registro maior. Sem a unidade 2, nenhum teto mais alto cabe na regra MR. Quanto ao limite de 1 MB do registro: com 10 mil produtos, o índice cabe só no tamanho de um produto real, não no pior caso; com 100 mil, não cabe em caso nenhum.

## Próximas unidades (ainda na fila, nada feito aqui)

- **Unidade 2, desenho:**
  - tirar o índice do catálogo do registro da loja, com um índice próprio paginado;
  - busca por índice de palavras, em vez de ler todos os produtos;
  - mapa do site paginado;
  - salvar produto e estoque lendo só os produtos afetados, por índice reverso de funis, pacotes e ofertas;
  - tarefas em lotes com cursor.
- **Unidade 3, propostas ao dono:**
  - (A) teto de produtos ativos e arquivo ilimitado;
  - (B) teto alto por plano.

  Cada uma só vai ao dono com o custo do pior mês por plano, mensal e anual, pela regra LC. Até lá, custo desconhecido.
- **Unidade 4:** testes sintéticos de carga com 10 mil e 100 mil produtos.
- **Unidade 5:** construção só do que não muda limite nenhum.

Nenhum preço, limite, comissão, trava ou flag foi alterado.

---

# Unidade 2, primeiro esboço: o desenho que tira as leituras do catálogo inteiro

Também só documento; nada construído. Cada peça reaproveita o que o catálogo já tem: `nl:catalog:<id>:l:<produto>` (cada produto), `:t` (o hash dos títulos), `:x:<produto>` (os extras) e `:moved` (`lib/catalog.ts:313`, `:334`, `:357`, `:1329`). Os comandos abaixo são contados por desenho e precisam ser confirmados nos testes de carga da unidade 4. Até lá, cada número é uma estimativa, não um teto provado.

| Peça | O que muda | Custo por operação depois, sem crescer com o catálogo |
| --- | --- | --- |
| 1. Índice fora do registro da loja | a ordem dos produtos sai de `store.catalog.items` para um conjunto ordenado `nl:catalog:<id>:o` (ZSET, posição como score), mais um conjunto por tipo (`:k:<tipo>`: chamadas, cursos, pacotes, ocultos). O registro da loja guarda só a contagem, a primeira página (`head`) e o id do catálogo | uma página: 1 `ZRANGE` de 24 ids e 24 `GET` dos produtos. O registro da loja deixa de crescer com o catálogo |
| 2. Busca por índice de palavras | cada produto salvo grava as palavras do título e da descrição curta em `nl:catalog:<id>:w:<palavra>` (conjunto de ids), com teto de palavras por produto. A busca cruza os conjuntos das palavras pedidas e lê só a página de resultados | `SINTER` ou `SUNION` de até `searchWords` conjuntos, mais 24 `GET`; substitui a leitura de todos os produtos (#4144/#4172 tratam do preço até lá) |
| 3. Mapa do site paginado | um índice de mapas por página de N produtos, lido por `ZRANGE` | um `ZRANGE` e N `GET` por página do mapa, nunca o catálogo inteiro |
| 4. Índices reversos para salvar e estoque | `nl:catalog:<id>:r:<produto>` guarda quem oferece ou contém esse produto (funis, pacotes, ofertas no checkout, alvos de `bumpTargets`) e é mantido em cada salvamento | salvar um produto e definir estoque (`app/api/store/product/route.ts:88`, `lib/store.ts:2724`) leem só os produtos citados no índice reverso, não o catálogo |
| 5. Telas do estúdio por tipo | `readKind` passa a ler o conjunto do tipo, paginado, com busca pelo índice de palavras | uma página por vez |
| 6. Tarefas em lote com cursor | importação, exportação, fechamento, recontagem e cópia (`lib/imports.ts:1383`, `lib/store-export.ts:94`, `lib/plan-closing.ts:650`, `lib/data-recount.ts:155`, `lib/store-copy.ts:145`) percorrem o `ZSET` por páginas, guardando o cursor entre execuções, sob prazo (`withCutoff`) | cada execução tem teto de páginas, e o custo total é proporcional ao catálogo, mas dividido entre execuções e pago pelo que a tarefa já precifica |

Riscos que o desenho ainda precisa resolver antes de virar código:

- **Migração:** as lojas atuais têm o índice no registro e precisam ser copiadas para o `ZSET` sem perder ordem nem produto. Durante a cópia, valem as duas leituras, e a cópia é verificada antes de apagar o índice antigo.
- **Consistência:** o salvamento do produto, do `ZSET`, dos conjuntos por tipo, das palavras e do índice reverso precisa ser atômico (um `EVAL`) ou reparável por uma recontagem com cursor.
- **Apagamento:** cada família nova (`:o`, `:k:`, `:w:`, `:r:`) entra em `lib/data-families.ts` e no fechamento da loja. O índice de palavras guarda só texto do próprio criador, nunca dado de comprador.
- **Custo de memória:** o índice de palavras ocupa espaço guardado (US$0,25 por GB por mês). Ele precisa de um teto de palavras por produto e de um preço por produto no registro de custos antes de existir.

As duas propostas ao dono (unidade 3) dependem destes números confirmados. Até lá, custo desconhecido, que reprova.

---

# Unidade 4, linha de base: medição do código atual (15/11/2026)

`tests/catalog-whole-read-load.test.ts` monta lojas sintéticas de 2.000, 10.000 e 100.000 produtos visíveis no banco em memória, a partir de uma listing real gravada por `addProduct`, e mede a busca da loja (`searchStore`) e a leitura do catálogo inteiro (`readAllListings`). O teste fixa o crescimento exato de hoje, uma leitura por produto fora da primeira página, para o desenho da unidade 2 ter uma base medida a superar. Nada muda no código do produto.

| Produtos | Busca da loja | Leitura do catálogo inteiro |
| --- | --- | --- |
| 2.000 | 1.976 GET, 1.048.204 bytes, 42 ms | 1.976 GET, 1.048.204 bytes, 13 ms |
| 10.000 | 9.976 GET, 5.296.204 bytes, 256 ms | 9.976 GET, 5.296.204 bytes, 49 ms |
| 100.000 | 99.976 GET, 53.176.204 bytes, 17.555 ms | 99.976 GET, 53.176.204 bytes, 598 ms |

Os bytes são os da listing sintética, de cerca de 530 bytes. O pior caso usa o teto de revisão de 16.384 bytes por listing, e o teste confirma que nenhuma leitura passa dele. Os tempos são do banco em memória numa máquina só; servem para comparar o crescimento, não como tempo de produção.

**Achado da medição:**
- **Onde:** `wanted` (`lib/catalog.ts:691-699`) tira os ids repetidos com `!out.includes(id)`, ou seja, procura cada id na lista inteira.
- **O que causa:** com ids informados, como faz a busca, o trabalho cresce com o quadrado do catálogo. Vai de 10 mil para 100 mil produtos e o tempo da busca sobe 68 vezes, enquanto a leitura sem ids sobe 12 vezes.
- **Peso hoje:** com o teto de 2.000, é cerca de 30 ms de CPU por busca, dentro do que o pior caso já conta.
- **Peso acima do teto:** passa a ser o maior custo de CPU da busca.
- **Conserto:** um `Set` em vez de `includes`, sem mudar limite nenhum. Entra na unidade 5 (construção do que não muda limite), com um teste que fixa que a busca com 100 mil produtos fica perto do tempo da leitura sem ids.
