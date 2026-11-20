# 9 [C-US] unidade 1 — Imposto sobre vendas nos estados americanos: regras por estado (20/11/2026)

Lido em 20/11/2026, nas páginas oficiais de cada estado. O dono aprovou, nesse mesmo dia, o acesso do ambiente aos 57 sites oficiais de fazenda. O coordenador Claude 5 passou a unidade (C5-20261121-0535-respostas, item 1). Os dados estão em `lib/us-sales-tax-rules.ts`, com o endereço da página e um trecho literal de cada resposta. A forma deles é conferida por `tests/us-sales-tax-rules.test.ts`.

| O que este registro é | O que não é |
| --- | --- |
| A regra de cada estado como a página oficial a escreve, lida e citada num dia | Uma opinião jurídica, um registro, uma cobrança ou uma permissão de vender |
| Uma tabela de dados que nada lê ainda | Contadores, trava, imposto calculado ou ligado em checkout |
| Desconhecido marcado como desconhecido | Desconhecido tratado como "sem imposto" ou "abaixo do limite" |

## Como foi feito

- Cinco pesquisadores leram as páginas pelo terminal, só em sites oficiais: endereços .gov, sites estaduais .us, a comissão de vendedores remotos do Alasca e a fazenda da Flórida. Cada um respondeu cinco perguntas por estado e anotou o endereço e um trecho literal. Nada foi tirado de memória nem de sites de terceiros.
- Cada trecho foi conferido de novo por um script: a página foi baixada outra vez e as palavras foram procuradas nela. Os poucos que o script não achou foram conferidos à mão; estavam lá, com quebra de linha de PDF ou caractere invisível. A exceção são três trechos de Nevada: a página citada agora redireciona, e esses campos viraram desconhecidos.
- Nenhuma recusa de acesso foi contornada.
  - Colorado, Massachusetts e New Hampshire responderam 403 a todas as tentativas.
  - Rhode Island pediu um desafio de navegador.
  - O conteúdo de Wyoming e de Maryland está em endereços que o ambiente não alcança.

  Esses seis estados ficaram todos como desconhecidos.

## Tabela

"Desconhecido" quer dizer: não confirmado numa página oficial lida nesse dia. Quem usar esta tabela depois trata o desconhecido pela leitura que protege a empresa (cobrar ou recusar a venda), nunca como zero.

| Estado | Imposto estadual sobre vendas | Plataforma recolhe pelos vendedores | Limite que dispara a obrigação | Produtos digitais | SaaS (planos) |
| --- | --- | --- | --- | --- | --- |
| AL | sim | sim | US$ 250.000 | desconhecido | desconhecido |
| AK | não | sim | US$ 100.000 | desconhecido | desconhecido |
| AZ | sim | sim | desconhecido | em parte | desconhecido |
| AR | sim | sim | US$ 100.000 ou 200 transações | em parte | desconhecido |
| CA | sim | sim | US$ 500.000 | em parte | sim |
| CO | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |
| CT | sim | sim | US$ 250.000 | sim | em parte |
| DE | não | não | não se aplica | não | não |
| DC | sim | sim | US$ 100.000 ou 200 transações | sim | em parte |
| FL | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| GA | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| HI | sim | sim | US$ 100.000 ou 200 transações | em parte | desconhecido |
| ID | sim | sim | US$ 100.000 | em parte | desconhecido |
| IL | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| IN | sim | sim | US$ 100.000 | em parte | não |
| IA | sim | sim | US$ 100.000 | sim | sim |
| KS | sim | sim | US$ 100.000 | não | não |
| KY | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| LA | sim | sim | US$ 100.000 ou 200 transações | sim | desconhecido |
| ME | sim | sim | US$ 100.000 | em parte | desconhecido |
| MD | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |
| MA | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |
| MI | sim | sim | US$ 100.000 ou 200 transações | desconhecido | desconhecido |
| MN | sim | sim | US$ 100.000 ou 200 transações | em parte | desconhecido |
| MS | sim | desconhecido | US$ 250.000 | sim | desconhecido |
| MO | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| MT | não | não | não se aplica | não | não |
| NE | sim | sim | US$ 100.000 ou 200 transações | desconhecido | desconhecido |
| NV | desconhecido | sim | US$ 100.000 ou 200 transações | desconhecido | desconhecido |
| NH | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |
| NJ | sim | sim | US$ 100.000 ou 200 transações | em parte | em parte |
| NM | sim | desconhecido | US$ 100.000 | desconhecido | desconhecido |
| NY | sim | sim | US$ 500.000 e 100 transações | desconhecido | sim |
| NC | sim | sim | US$ 100.000 | em parte | não |
| ND | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| OH | sim | sim | US$ 100.000 ou 200 transações | sim | desconhecido |
| OK | sim | sim | US$ 10.000 | desconhecido | desconhecido |
| OR | não | não | não se aplica | não | não |
| PA | sim | sim | US$ 100.000 | sim | sim |
| RI | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |
| SC | sim | sim | US$ 100.000 | desconhecido | sim |
| SD | sim | sim | US$ 100.000 | sim | desconhecido |
| TN | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| TX | sim | sim | US$ 500.000 | desconhecido | desconhecido |
| UT | sim | sim | US$ 100.000 | desconhecido | desconhecido |
| VT | sim | sim | US$ 100.000 ou 200 transações | em parte | sim |
| VA | sim | sim | US$ 100.000 ou 200 transações | desconhecido | desconhecido |
| WA | sim | sim | US$ 100.000 | sim | sim |
| WV | sim | sim | US$ 100.000 ou 200 transações | em parte | desconhecido |
| WI | sim | sim | US$ 100.000 | em parte | sim |
| WY | desconhecido | desconhecido | desconhecido | desconhecido | desconhecido |

O limite é o que o estado escreve para quem vende de fora ou para a plataforma, com o período em `lib/us-sales-tax-rules.ts`.

- **Oklahoma:** para a plataforma, o limite é de US$ 10.000 nos 12 meses anteriores. Para o vendedor remoto, é de US$ 100.000. A plataforma pode escolher entre recolher ou cumprir as regras de aviso e relatório.
- **Connecticut:** para a plataforma, o limite é de US$ 250.000 de vendas facilitadas, sem contagem de transações.
- **Kentucky:** a contagem de 200 transações foi revogada em 1º/08/2026, segundo a página.
- **Alasca:** não tem imposto estadual. Tem um regime local (ARSSTC), aplicado só nos municípios que aderiram, com limite de US$ 100.000 de vendas no estado.

## Limites desta leitura

- **Respostas apoiadas em texto geral ou antigo.** Algumas respostas se apoiam numa frase geral, num exemplo do manual ou numa decisão antiga, e a `note` e os `gaps` de cada estado dizem isso. Por exemplo:
  - na Carolina do Norte, o "não" para SaaS vem de uma decisão particular de 2018;
  - no Kansas, as respostas sobre digitais e SaaS vêm de um aviso de 2010;
  - na Carolina do Sul, o SaaS aparece como exemplo do manual.
- **Base do limite.** Vários estados escrevem o limite sobre bens físicos, ou sobre vendas tributáveis. Se as vendas digitais contam para o limite não foi confirmado em todos eles.
- **Califórnia.** A regra de 2027 (SB 122) inclui o SaaS e o software pré-pronto como "produto digital" tributável a partir de 01/01/2027, e exclui livros, áudio e vídeo digitais dessa definição. A regra anterior a 2027 não foi lida.
- **Isenções para empresas.** Algumas isenções podem alcançar os planos do Marktmorgen vendidos a criadores que usam o software no próprio negócio, como a de Iowa, Iowa Code § 423.3(104). Nenhuma foi aplicada aqui.
- **Tudo muda com o tempo.** Antes de usar qualquer linha para cobrar ou para deixar de cobrar, a página precisa ser lida de novo, com data.

## O que vem depois (outras unidades do 9 [C-US])

1. Contadores de vendas por estado, gravados, num único mecanismo com os do ponto 9 da TX (`lib/us-state-tax-threshold.ts`, Claude 2), combinado com ele.
2. A cobrança do imposto pela taxa da plataforma (789 [IV1], passo 11), acima de cada limite, com o imposto por fora do preço.
3. O imposto sobre os planos do Marktmorgen nos estados que tributam SaaS, acima do limite (789 [IV1], passo 12, e 331 [RC1]).
4. Os registros estaduais, que só o dono pode fazer, na abertura.

Estado VR: testado num PR. São dados documentais. Nada foi ligado, aberto ou certificado. `PLANS_ON_SALE` continua false.
