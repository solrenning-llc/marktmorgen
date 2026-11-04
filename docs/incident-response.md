# Plano de resposta a incidentes — Marktmorgen

Escrito pela Claude 2 em 1/11/2026 a partir do código do main (508 [SG4], parte 3; serve também a 568 [GD2] (k), que pede o mesmo plano, sem duplicar). Linguagem simples, para o dono. Os modelos de aviso que vão a criadores e compradores estão em inglês americano, como tudo o que o cliente lê.

**O que este documento é e não é.** É o retrato do que o código faz hoje e um roteiro de passos. Não é parecer jurídico, não certifica conformidade com lei nenhuma e não prova que alguma proteção funcionou num incidente real (nenhum foi ensaiado com dados reais). Cada afirmação sobre o código traz o arquivo onde conferir. Onde o código não tem uma proteção, está escrito "não existe", nunca suposto.

## 1. O que as proteções já fazem sozinhas

| Proteção | O que faz, sem ninguém agir | Onde |
| --- | --- | --- |
| Entrada sem senha | Não há senha guardada para ser roubada; cada link de entrada vale uma vez, por 15 minutos | `lib/auth.ts` |
| Limite de pedidos de entrada | 5 e-mails de entrada por hora por IP e 8 por hora por endereço | `lib/auth.ts` |
| Verificação em duas etapas | 5 códigos errados encerram a tentativa; 10 códigos por hora por conta; sessão sem a segunda etapa não faz ações sensíveis | `lib/two-step.ts` |
| Passkeys | Até 10 por conta | `lib/passkeys.ts` |
| Sair de todos os aparelhos | O criador encerra todas as suas sessões de uma vez ("Log out of all devices", no estúdio) | `endAllSessions` em `lib/auth.ts`, `app/api/auth/signout-all` |
| Chaves da API e do MCP | Guardadas só como hash (SHA-256); o criador revoga uma por vez no estúdio, e vale na hora; todas são revogadas sozinhas quando a loja é apagada ou fechada | `lib/api-keys.ts`, `app/api/store/api-keys/route.ts` |
| Limite da API | 120 pedidos por minuto por chave | `lib/api-guard.ts` |
| Pausa automática de e-mails de uma loja | Em 7 dias, com pelo menos 25 devoluções e 2% devolvidos, ou pelo menos 5 queixas de spam e 0,08% de queixas, a lista daquela loja para por 7 dias e depois volta aos poucos, a partir de 100 destinatários | `lib/mail-health-rules.ts`, `lib/mail-health.ts` |
| Avisos recebidos de provedores | Resend: assinatura HMAC conferida em tempo constante, recusada com mais de 5 minutos. Amazon SES (via SNS): tópico conferido, mensagem com menos de uma hora, assinatura RSA conferida no certificado do SNS. Zoom: HMAC, janela de 5 minutos | `lib/inbound-mail.ts`, `lib/sns.ts`, `lib/meet-providers.ts` |
| Stripe | Não há webhook de entrada nem segredo de webhook do Stripe: os eventos são lidos por uma rotina a cada 5 minutos. Os pagamentos ficam na conta Stripe do próprio criador; o Marktmorgen não guarda dados de cartão | `lib/webhooks.ts` |
| Segredos guardados de criadores | Selados (cifrados) com chave derivada; cada valor leva a impressão da chave que o selou, então, depois de uma troca de chave, o estúdio diz claramente "cole a chave de novo" em vez de falhar em silêncio | `lib/secret-box.ts` |
| Suspensão de loja | Uma loja suspensa pelo processo de denúncia fecha a entrada de novos contatos na lista | `lib/store.ts` (`suspended`), `lib/store-join.ts` |
| Registro da equipe | Cada loja guarda as últimas 500 ações da equipe | `lib/team.ts` |
| HSTS | O site obriga HTTPS no navegador | `next.config.ts` |
| Canal de segurança | `/.well-known/security.txt` (RFC 9116) e a pergunta "How do I report a security problem?" na página `/platform/security` | 508 [SG4] parte 2 (PR #1554, ainda não incorporado) |
| Análise de código | CodeQL em todo PR, no main e uma vez por dia; Dependabot para atualizações de segurança | 508 [SG4] parte 1 (PR #1551, ainda não incorporado) |

## 2. O que NÃO existe hoje (lacunas reais)

Cada lacuna abaixo é um fato do código de 1/11/2026, não uma recomendação já feita.

1. **Troca de chave sem interrupção.** Nenhuma chave de fornecedor nem segredo do ambiente aceita um valor anterior durante a troca (não há `*_PREVIOUS`, lista ou identificador de chave): trocar é corte seco. A única exceção é o cofre de segredos (`lib/secret-box.ts`): depois de definida `NIMBUS_DATA_KEY`, o que foi selado antes ainda abre com a chave derivada de `STRIPE_SECRET_KEY`, enquanto ela não mudar. Os webhooks dos criadores ganham troca sem interrupção em 378 [TB4] (PR aberto).
2. **Raiz dos segredos selados.** Se `NIMBUS_DATA_KEY` não estiver definida, a chave que sela os segredos dos criadores é derivada de `STRIPE_SECRET_KEY`. Nesse caso, trocar a chave do Stripe depois de um vazamento torna ilegível tudo o que deriva da raiz: os segredos selados (os criadores colam de novo as chaves deles e os telefones religam as notificações), os códigos do app de verificação em duas etapas (os códigos de recuperação e as passkeys continuam entrando, `lib/two-step.ts`) e links e passes derivados da raiz (por exemplo `lib/review-requests.ts`, `lib/chat-pass.ts`, `lib/numbers-links.ts`). Definir `NIMBUS_DATA_KEY` hoje não protege na hora: o que já foi selado continua dependendo da chave do Stripe até ser salvo de novo. O agente não pode ler se `NIMBUS_DATA_KEY` está definida em produção (não lê valores de ambiente).
3. **Encerrar as sessões de todos.** Existe "sair de todos os aparelhos" para uma conta, mas não um comando que encerre de uma vez as sessões de todos os criadores. As sessões são números aleatórios guardados no Redis, sem assinatura por segredo: trocar um segredo não as encerra.
4. **Parar todos os envios da plataforma.** Existe a pausa automática por loja, mas não um interruptor que pare de vez os e-mails de lista de todas as lojas. O mais próximo é `MARKETING_DAILY_CAP` (`lib/mail.ts`): com valor 1, a empresa inteira manda no máximo um e-mail de lista por dia, e os links de entrada e recibos continuam (0 quer dizer sem teto, não zero). Parar tudo de verdade exige tirar as credenciais de envio do ambiente, o que para também os links de entrada.
5. **Retomar uma loja pausada antes do prazo.** A pausa automática termina sozinha em 7 dias; não há retomada manual.
6. **Cópias de segurança.** A rotina diária existe, mas está desligada (`BACKUP_COST_REVIEW` é `null` em `lib/backup-run.ts`, sem agendamento). Num incidente que apague ou corrompa dados, hoje não há cópia para restaurar.
7. **Registro de auditoria da plataforma.** Há o registro da equipe por loja, mas não um registro de todas as ações administrativas da plataforma.
8. **PayPal e Discord.** Não recebem avisos assinados: o código não tem rota de avisos deles, só retornos de conexão; o retorno do PayPal é conferido perguntando ao próprio PayPal (`app/api/store/paypal/onboarded/route.ts`). Não é lacuna de assinatura; fica registrado para quem procurar.

As lacunas 2, 3 e 4 viram itens de código em "Depende do dono" (ver seção 6); nenhuma é construída por este documento.

## 3. Passo a passo: uma chave vazou

Regra geral: **troque primeiro, investigue depois.** Trocar uma chave é reversível (gera-se outra); deixar uma chave vazada ativa não é.

1. **Descubra qual chave.** A lista completa, só com os nomes (nunca os valores), está na tabela abaixo.
2. **Gere a nova chave no provedor** e **revogue a antiga** no mesmo provedor. Isso é ação do dono na conta do provedor; nenhum agente cria, troca ou revoga chave em conta real.
3. **Ponha a nova no ambiente de produção** (Vercel, variável com o mesmo nome) e publique de novo, para que a nova versão leia o valor novo.
4. **Confira o efeito colateral** da tabela e avise quem for afetado (seção 5).
5. **Registre** data, hora (Fortaleza), qual chave, como vazou e o que foi trocado, neste arquivo, na seção 7.

| Chave (nome no ambiente) | Onde é lida | Efeito de trocar |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | `lib/billing.ts`, `lib/stripe-connect.ts`, `lib/stripe-account.ts`, `lib/payment-methods.ts`, `lib/secret-box.ts` | Assinaturas e leitura das contas conectadas voltam com a nova. **Se `NIMBUS_DATA_KEY` não estiver definida, todo segredo selado fica ilegível** (lacuna 2) |
| `NIMBUS_DATA_KEY` | `lib/secret-box.ts` | Tudo o que deriva dela fica ilegível ou inválido: segredos selados (os criadores colam as chaves de novo; telefones religam notificações), códigos do app de duas etapas (recuperação e passkeys continuam entrando) e links e passes derivados |
| `STRIPE_DEMO_SECRET_KEY` | `lib/demo-account.ts` | Só a loja de demonstração |
| `RESEND_API_KEY`, `RESEND_CREATORS_API_KEY`, `RESEND_INBOUND_API_KEY`, `RESEND_WEBHOOK_SECRET` | `lib/email.ts`, `lib/inbound-mail.ts` | Envio e recebimento pelo Resend voltam com a nova; avisos assinados com a antiga são recusados |
| `AWS_SES_ROLE_ARN` (papel, sem segredo guardado; usa `VERCEL_OIDC_TOKEN`) | `lib/ses.ts` | Num vazamento, revogar as sessões do papel na AWS |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | `lib/redis.ts` | Todo o site depende do Redis: trocar e publicar logo, senão o site para |
| `CRON_SECRET` | `lib/request-guard.ts` | As rotinas agendadas voltam na próxima publicação |
| `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`, `PICTURE_R2_*`, `BACKUP_R2_*` | `lib/vault.ts`, `lib/picture-r2.ts`, `lib/backup-store.ts` | Arquivos, imagens e cópias voltam com a nova |
| `BACKUP_ENCRYPTION_KEY`, `BACKUP_RESTORE_REDIS_REST_TOKEN` | `lib/backup-run.ts`, `lib/backup-restore-target.ts` | Ver `docs/backup.md` (troca da chave das cópias) |
| `ANTHROPIC_API_KEY` | `lib/ai.ts` | Recursos de IA voltam com a nova; o teto de gasto continua o mesmo |
| `BUNNY_STREAM_API_KEY`, `BUNNY_STREAM_TOKEN_KEY`, `BUNNY_STREAM_READ_KEY` | `lib/stream.ts` | Links de vídeo assinados com a chave antiga deixam de abrir |
| `PAYPAL_PARTNER_SECRET` | `lib/paypal-sales.ts` | Vendas por PayPal (hoje desligadas) |
| `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `META_APP_SECRET`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET_TOKEN`, `VERCEL_API_TOKEN` | `lib/discord.ts`, `lib/meta-ads.ts`, `lib/meet-providers.ts`, `lib/search-console.ts`, `lib/domains.ts` | A integração correspondente volta com a nova; conexões de criadores podem precisar ser refeitas |
| Chave da API de um criador | `lib/api-keys.ts` | O próprio criador revoga no estúdio; vale na hora |
| Segredo de webhook de saída de um criador (`whsec_`) | `lib/webhooks.ts` | O criador gera outro no estúdio |

## 4. Passo a passo: e-mails precisam parar

- **Uma loja só:** a pausa automática já age pelas devoluções e queixas (seção 1). Uma loja com abuso comprovado é suspensa pelo processo de denúncia, o que fecha a entrada de contatos.
- **Todas as lojas, quase parado:** o dono define `MARKETING_DAILY_CAP=1` no ambiente de produção e publica de novo: no máximo um e-mail de lista por dia em toda a empresa, com links de entrada e recibos funcionando (lacuna 4).
- **Tudo parado:** retirar as credenciais de envio do ambiente e publicar de novo. Isso **também para os links de entrada**, então ninguém entra até elas voltarem. Use só em vazamento grave das credenciais de envio.

## 5. Passo a passo: avisar os criadores (e, por eles, os compradores)

1. Escreva o que aconteceu, em fatos: o quê, quando, quais dados, o que já foi feito e o que a pessoa deve fazer. Nunca prometa o que não está confirmado.
2. Envie aos criadores afetados pelo e-mail de serviço da plataforma. Quem avisa os compradores de cada loja, e como, depende do papel de cada um perante a lei aplicável, que não foi conferido (seção 6); até lá, entregue ao criador o modelo abaixo.
3. Guarde a cópia do aviso enviado, com data e hora, na seção 7.

Modelo para criadores (inglês americano):

> **Subject: A security problem at Marktmorgen, and what it means for your store**
>
> On [date], we found [what happened, in one sentence]. It affected [which data: for example, the email addresses of the people on your list] between [start] and [end]. It did not affect [what was not touched, only if confirmed].
>
> What we have done: [for example, we replaced the leaked key at [time] and closed every open session].
>
> What you should do: [for example, sign in again; paste your Stripe key again in Settings].
>
> If you have questions, reply to this email and a person answers. We will write again when we know more.

Modelo de linha para o criador repassar aos compradores, se quiser:

> On [date], a security problem at the platform that runs our store exposed [which data]. Your card details were not affected: card payments are handled by Stripe, and the store's platform never stores card details. [What the buyer should do, if anything.]

(A frase sobre cartões só vale enquanto for verdade no código: pagamentos com cartão na conta Stripe do próprio criador, sem dado de cartão guardado. Se as vendas por PayPal, hoje desligadas, estiverem ligadas, acrescente que pagamentos por PayPal são feitos no próprio PayPal.)

## 6. Prazos legais e decisões do dono

**Prazos legais: não conferidos.** O item pede os prazos conferidos em fontes oficiais e datadas. Em 1/11/2026, a política de rede desta sessão recusou EUR-Lex, Planalto, ANPD, ICO e o Procurador-Geral da Califórnia (código 000). Nenhum prazo é afirmado aqui. Para conferir, com a data da leitura, quando houver acesso:

| Onde | O que conferir | Estado |
| --- | --- | --- |
| União Europeia | RGPD, arts. 33 e 34 (aviso à autoridade e às pessoas) | não conferido |
| Reino Unido | UK GDPR, arts. 33 e 34, e a orientação do ICO | não conferido |
| Brasil | LGPD, art. 48, e o regulamento de comunicação de incidentes da ANPD | não conferido |
| Estados Unidos | leis de aviso de vazamento de cada estado (por exemplo, Califórnia, Cal. Civ. Code §1798.82) | não conferido |

**Depende do dono (decisões e configurações que o agente não faz):**

1. Confirmar se `NIMBUS_DATA_KEY` está definida em produção, sem mostrar o valor; se não estiver, defini-la, para que trocar a chave do Stripe deixe de apagar o que for selado dali em diante (o que já está selado só migra quando for salvo de novo, lacuna 2).
2. Autorizar, como itens de código: um interruptor único para parar os e-mails de lista de todas as lojas sem parar os links de entrada (lacuna 4); um comando que encerre as sessões de todos os criadores (lacuna 3); e a troca de chave com dois valores aceitos durante a troca (lacuna 1). Cada um com teste sintético, sem custo novo de fornecedor.
3. As cópias de segurança continuam desligadas até a revisão de custo de 273 [BK1] (lacuna 6).

## 7. Registro de incidentes

Nenhum incidente registrado até 1/11/2026.

| Data e hora (Fortaleza) | O que aconteceu | O que foi trocado ou parado | Quem foi avisado, e quando |
| --- | --- | --- | --- |
| — | — | — | — |
