# 753 [IR1], unidade 3a — Onde o criador pode precisar se registrar

Claude 2 (nuvem L), 15/11/2026. Unidade da parte (3) do 753 [IR1], "Monitor de limites de registro, somente leitura, no mundo inteiro". O item pede para conferir, antes de construir, se o próprio Stripe Tax já monitora esses limites na conta do criador e, se monitorar, mostrar esse resultado em vez de recalcular.

## Fontes oficiais lidas em 15/11/2026

- [Stripe, "Monitor your obligations"](https://docs.stripe.com/tax/monitoring): o Stripe Tax soma as vendas processadas pelo Stripe na conta, menos os reembolsos, por local do cliente. Compara essas vendas com o limite de registro de cada local, na janela de cada local (ano anterior ou corrente, ano anterior, quatro trimestres móveis ou 12 meses móveis). Lista os locais na aba "Needs attention" da página Tax, Locations. Avisa o dono da conta por e-mail e no painel quando um limite é ultrapassado, desde que a conta tenha tido 10.000 USD de receita no ano anterior. Restrições declaradas na página: só modo live; não monitora o país nem o estado americano de origem; só vendas processadas pelo Stripe ou importadas; considera toda venda tributável no destino; não distingue venda de marketplace e de não marketplace. Em Connect, por padrão, as transações das contas conectadas contam para os limites delas, e não para os da plataforma.
- [Stripe, "Model Context Protocol (MCP)"](https://docs.stripe.com/mcp): a lista de métodos traz "Retrieve tax threshold monitoring results" como private preview. Não há endpoint público documentado para ler esse resultado pela API.

## O que foi construído

Toda venda das lojas é cobrança direta na conta Stripe do próprio criador, então o Stripe Tax já monitora os limites dele. O Marktmorgen não refaz a conta nem mostra um número próprio.

- `lib/where-to-register.ts`: a frase fixa pedida pelo item ("This is information from your sales, not tax advice.") e o link para a aba Needs attention da mesma página Locations que o 655 [WG15] já abre, em modo de teste ou live. Qualquer outro endereço vira null.
- `app/studio/tax/page.tsx`: seção "Where you may need to register", depois de "Your active registrations", mostrada só quando a loja tem conta Stripe. Ela diz o que o Stripe conta e o que fica de fora (vendas pagas com PayPal, quando a loja vende assim), abre a página do Stripe numa nova aba e repete que o Marktmorgen nunca registra nem declara pelo criador.

Nada é lido, gravado, enviado ou cobrado. Nenhuma chamada nova ao Stripe e nenhum custo novo de fornecedor. Preços, limites, comissão, travas e flags ficam inalterados.

## O que ainda falta na parte (3)

- Ler o resultado do Stripe e mostrar no estúdio, quando o método sair do private preview. Até lá, só o link.
- Locais que o Stripe não monitora (país e estado de origem, locais fora da lista de suportados, vendas por PayPal): cada limite precisa de fonte oficial datada. Neste ambiente, os sites das secretarias estaduais americanas estão bloqueados pela rede (registro de 13/11/2026 no canal); a decisão de liberar é do dono.
- Aviso por e-mail do próprio Marktmorgen em 70% e 90%: depende de contar as vendas por local, o que hoje só o Stripe faz na conta do criador.

## Acessibilidade e VR

Seção com título h2 e região nomeada; lista com marcadores; o link diz para onde leva pelo próprio texto (2.4.9) e avisa que abre em nova aba; texto em inglês americano simples. Passos e decisões da tarefa principal ("saber onde posso precisar me registrar"): antes, nenhum caminho no estúdio; depois, um clique a partir de /studio/tax. Teste com pessoas reais não feito (lacuna, item 202). Estado VR: em andamento, num ramo sem PR.
