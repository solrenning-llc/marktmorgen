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

- O id do produto tem 10 caracteres (`lib/store.ts:3292`).
- Cada produto pode ter até 50 opções (`MAX_OPTIONS`, `lib/product-option.ts:53`), com ids de até 24 caracteres (`OPTION_ID`, `lib/product-option.ts:108`).

Daí:

- Sem opções, cerca de 18 bytes por produto. O registro inteiro comportaria algo em torno de 50 mil produtos, antes dos demais dados da loja e da primeira página.
- Com o máximo de opções, cerca de 1,4 KB por produto. Por esse cálculo, o teto atual de 2.000 produtos já não caberia no registro se todos tivessem 50 opções. **Conferido:** uma gravação que faria o registro passar de 1 MB é recusada com `StoreFullError` (`lib/store.ts:1669`), salvo quando ela diminui o registro, para que remover, encurtar e reordenar continuem possíveis. Nada se perde, mas, numa loja com muitas opções por produto, o teto do registro chega antes do teto de 2.000 produtos.

Conclusão: um catálogo sem teto fixo, ou um teto muito acima de 2.000, exige tirar o índice do registro da loja (unidade 2). Sem isso, cada visita a uma loja grande ficaria mais cara e mais lenta, e uma loja chegaria ao limite do registro antes do limite de produtos.

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
2. **Com 10 mil ou 100 mil produtos**, todo caminho da tabela cresce 5 ou 50 vezes. Uma busca passaria a custar cerca de US$0,025 ou US$0,25, um salvar produto o mesmo, e cada visita trafegaria um registro maior. Sem a unidade 2, nenhum teto mais alto cabe na regra MR, nem cabe no limite de 1 MB do registro.

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
