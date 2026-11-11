# Estudo 41 [G3]: Google Business Profile e resposta a avaliações (11/11/2026)

Item 41 [G3] de docs/codex-queue.md ("Documentar Google Business Profile e preparar resposta a avaliações, desligada até aprovação"). Era da faixa do Claude 6; **assumido pelo Claude 3 (TODOS-112)**. Só documento. Nenhuma conta Google, projeto no Google Cloud, pedido de acesso, aceite de termos, pagamento ou contato foi feito. Nenhum código foi escrito, e nada foi ligado.

## 1. Pergunta

O Marktmorgen pode deixar o criador ler e responder, de dentro do estúdio, as avaliações do perfil da empresa dele no Google (Google Business Profile)? O que é preciso, quanto custa e o que é proibido?

## 2. Fontes oficiais lidas em 11/11/2026, por volta de 16h15 (Fortaleza)

Nenhuma das três páginas mostra data de atualização.

| Fonte | O que diz (trechos literais) |
| --- | --- |
| [Work with review data](https://developers.google.com/my-business/content/review-data) | Listar as avaliações de um local: `GET https://mybusiness.googleapis.com/v4/accounts/{accountId}/locations/{locationId}/reviews` (`accounts.locations.reviews.list`). Responder: `PUT …/reviews/{reviewId}/reply` (`accounts.locations.reviews.updateReply`). Apagar a resposta: `DELETE` no mesmo caminho. Vários locais de uma vez: `POST …/locations:batchGetReviews`. |
| [Prerequisites](https://developers.google.com/my-business/content/prereqs) | "Manage a Google Business Profile that is verified and active for 60+ days." "Have a website representing the business listed on the GBP." "Select 'Application for Basic API Access' from the drop-down menu." "If your quota is 0 QPM (Queries Per Minute), your project has not yet been approved." "If your quota is set to 300 QPM, your project is approved." |
| [Basic setup](https://developers.google.com/my-business/content/basic-setup) | Escopo OAuth: `https://www.googleapis.com/auth/business.manage`. A API é "only visible in the Google Cloud console to users who submit and receive approval". Sobre cobrança, só: "If prompted, enable billing." Nenhum preço publicado. |
| [Policies](https://developers.google.com/my-business/content/policies) | "If you respond to reviews on behalf of your end-client, you must receive their authorization first." Proíbe automatizar ou disparar respostas a avaliações sem o consentimento prévio, específico e expresso do usuário (seção "Automated use"; a frase vem quebrada na leitura, ver a seção 5). "You cannot pre-fetch, cache, index, or store any content provided through the Business Profile APIs." A exceção: guardar pouco conteúdo só para desempenho, "for no more than 30 calendar days", com segurança e sem "manipulated or aggregated in any way". |

## 3. O que isso significa para o Marktmorgen

1. **Aprovação é do dono e depende de fatos que hoje não existem.** O pedido de acesso exige um perfil da empresa verificado e ativo há mais de 60 dias, com site, feito por um e-mail dono ou gerente desse perfil. É o perfil da Solrenning LLC/Marktmorgen, não o do criador. Sem aprovação, a cota é 0 e nenhuma chamada funciona. Pela regra deste repositório, isso fica em "Depende do dono": nenhum agente pede acesso.
2. **Cada criador autoriza com a própria conta Google** (OAuth, escopo `business.manage`), e a resposta a cada avaliação precisa da autorização dele. Resposta automática ou gerada sozinha está fora: cada resposta sai só quando o criador aperta "Send", depois de ler. Rascunho por IA, se um dia existir, fica no limite já pago da IA do plano (lib/ai-rules.ts), rotulado "AI draft" (756 [STN3]) e nunca enviado sem o criador.
3. **Não guardar as avaliações.** O Marktmorgen lê a lista na hora em que o criador abre a tela e mostra; não copia para o banco, não indexa e não soma com as avaliações da loja (lib/reviews.ts). Se precisar de cache por desempenho, ele dura menos de 30 dias e fica sem nenhuma agregação. Isso também impede misturar avaliações do Google com o selo "Verified purchase" das avaliações da loja (567 [GD1] (e)).
4. **Custo:** a documentação não publica preço e só diz "If prompted, enable billing". Pela regra MR, **custo desconhecido reprova, nunca é zero**. Antes de qualquer código, é preciso uma fonte oficial datada do preço (ou da gratuidade) e um teto por loja e por mês no registro de custos. A cota aprovada de 300 consultas por minuto é do projeto inteiro, dividida entre todas as lojas. Por isso cada loja precisa de um limite próprio, reservado antes de cada leitura.
5. **Dados pessoais:** nome e foto de quem avaliou, e o texto da avaliação, são dados de terceiros. Mostrar sem guardar evita novas linhas em lib/person-data.ts. Guardar o token OAuth do criador já é uma família nova de dados, a registrar com apagamento.

## 4. Desenho proposto, desligado até aprovação (não construído)

- Uma constante `GOOGLE_REVIEWS_LIVE = false`, como `AUTODM_LIVE`. Enquanto for false, nenhuma tela, rota ou chamada aparece ao criador (regra VR 2: o que não funciona não aparece).
- Unidades, cada uma com RED primeiro e com reserva:
  1. regras puras do pedido de leitura e da resposta (tamanho, texto obrigatório, sem envio automático);
  2. conexão OAuth do criador, com token guardado cifrado e apagado com a loja e com a desconexão;
  3. tela de leitura e resposta, com uma ação por avaliação, desfazer (apagar a resposta) e o aviso de que a resposta é pública no Google.
- Pré-condições para ligar: aprovação do acesso básico ao projeto, preço oficial datado, teto por loja no registro de custos, revisão de dados pessoais e duas revisões independentes.

## 5. Lacunas

- Nenhuma das páginas tem data de atualização; a data acima é a da leitura.
- A frase sobre respostas automáticas veio quebrada na leitura da página de políticas ("you must not automate or trigger review replies" … "without the user's prior specific and express consent"). Antes de qualquer código, é preciso reler a seção "Automated use" inteira, de preferência no navegador.
- Preço e cobrança: não publicados nas páginas lidas.
- O escopo `business.manage` dá acesso a todo o perfil. É preciso conferir se existe escopo só de leitura e resposta.

## 6. Recomendação, em "Depende do dono"

Não pedir acesso agora. O pré-requisito de um perfil verificado há mais de 60 dias, com site, é da empresa, e o preço não está publicado. Retomar depois da abertura das vendas, se os criadores pedirem. Até lá, as avaliações da própria loja (lib/reviews.ts) continuam sendo o caminho.

VR: estudo; nada construído, publicado ou disponível ao cliente.
