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
6. **Cópias de segurança.** A rotina diária existe, mas está desligada (`BACKUP_COST_REVIEW` é `null` em `lib/backup-run.ts`, sem agendamento). Num incidente que apague ou corrompa dados, hoje não há cópia para restaurar. O roteiro de restauração, para quando ela estiver ligada, está na seção 8.
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

## 8. Passo a passo: dados apagados ou corrompidos (restaurar uma cópia de segurança)

Escrito pela Claude 4 em 8/11/2026 (273 [BK1], mensagens C1-20261108-1530-C4-34 a C1-20261108-2021-C4-37 da caixa). **Hoje a cópia de segurança está desligada** (lacuna 6): este roteiro vale para quando o dono aprovar o custo e ela for ligada. Várias peças citadas aqui ainda **não existem no main** e estão com o agente que escreve o código do backup: a rota agendada, o alarme externo, o identificador da chave nas cópias, o motivo `room_locked`, o registro de exclusões e a ferramenta de restauração independente. O Worker de arquivos e vídeos e o registro de exclusões já estão escritos e testados localmente (ramos `claude4/bk1-files-worker` e `claude4/bk1-files-pages`, ainda sem PR) e a rota de listagem está no PR #3313; nada disso está no main, e tudo segue desligado. Antes de seguir um passo, confira no main se a peça já existe; o que não existe não pode ser usado. Este roteiro não diz onde ficam chaves, códigos ou cópias em papel.

**Regras que valem em todos os passos:**

- Nunca restaurar por cima do banco vivo. O próprio aviso oficial da Upstash diz: "All existing data in the target database will be deleted before the restore operation begins" (https://upstash.com/docs/redis/features/backup, lido em 8/11/2026). Portanto o botão "Restore" do console da Upstash nunca é usado apontando para o banco de produção.
- Restaurar sempre num banco **novo** e só depois trocar as variáveis do site para ele.
- O banco é compartilhado com o projeto hazelsong, segundo o próprio registro do dono (AGENTS.md, Hazelsong guardada, 24/10/2026; a Vercel mostra o banco ligado a dois projetos). A cópia do Marktmorgen leva só as chaves `nl:`. Uma restauração do banco inteiro pelo console voltaria os dois produtos ao mesmo momento; restaurar o Marktmorgen num banco novo e trocar só as variáveis do Marktmorgen deixa a Hazelsong como está. Nada da Hazelsong é apagado (HZ1).
- Agentes não entram nas contas da Upstash, da Cloudflare, da Vercel nem do bunny, não leem nem imprimem segredos. Cada passo "na conta" é do dono.

### 8.1 Primeira hora

1. **Desligar o agendamento do backup.** É sempre o primeiro passo: uma execução durante o incidente pode copiar dados já corrompidos e, depois, apagar cópias antigas boas pela retenção. Como fazer depende de como a rota for construída (por exemplo, tirar a entrada do backup de `vercel.json` e publicar de novo); o passo exato entra aqui quando a rota existir no main. A trava do bucket (7 dias, C4-35 e C4-37) protege as cópias mais recentes mesmo assim. O mesmo vale para o Worker de arquivos e vídeos: o dono pausa o agendamento dele na conta de backup da Cloudflare, para que nenhuma exclusão vencida seja aplicada durante o incidente.
2. **Exportar o banco vivo antes de mexer em qualquer coisa**, como está, mesmo corrompido: é a prova do que aconteceu e o ponto de volta se a restauração der errado. O dono faz pelo console da Upstash (Backups, "Backup & Export"); o arquivo fica fora das contas da LLC.
3. **Decidir de qual cópia restaurar**: a última boa antes do problema. O relatório do backup mostra a hora da última cópia verificada (`nl:backup:last-ok`). Cópias diárias do banco ficam 30 dias; as mensais são a primeira cópia verificada de cada um dos 3 meses mais recentes, e cada uma pode ter **até 120 dias** (`BACKUP_MAX_COPY_DAYS`); a do próprio provedor, 1 ou 3 dias, se o dono tiver ligado (ver docs/backup-costs-2026-11-08.md, seção 4). As mensais só existem se a regra de ciclo de vida do bucket em `backups/` for de **120 dias** (`backupLifecycleDays`, #3293), no lugar da regra de 30 dias criada em 4/11/2026 (`delete-backups-after-30-days`) e dos 60 dias que o pré-requisito 2 de docs/backup.md ainda diz no main: com 30 ou 60 dias, a regra apaga as mensais.

### 8.2 Restaurar o banco (fora da produção, num banco novo)

1. O dono cria um **banco novo e vazio** na Upstash, separado do vivo. A restauração recusa um destino que seja o banco vivo e só escreve num banco com `DBSIZE` 0 (`lib/backup-restore-target.ts`).
2. Abrir a cópia escolhida com a chave das cópias. Se a cópia foi selada com a chave anterior (uma mensal pode ter até 120 dias, então isso vale até 120 dias depois de uma troca, item 8.5), usar a anterior, guardada offline; conferir a impressão digital da chave (8 primeiros caracteres hexadecimais de HMAC-SHA256(chave, "mm-backup-kid"), mostrada no relatório) antes de usar. Sem o GitHub, usar a ferramenta de restauração independente guardada junto da exportação offline (C4-36, item 7), quando existir.
3. Restaurar no banco novo e conferir o manifesto, as somas e as contagens antes de qualquer troca.
4. **Reaplicar as exclusões de dados pessoais** feitas depois da data da cópia, a partir do registro de exclusões (só o identificador com hash e sal e a data, sem dado pessoal), **antes** de o site voltar a usar o banco. Para sobreviver à perda do banco vivo, o registro tem de ficar também **na conta de backup** (proposta, docs/backup-costs-2026-11-08.md, seção 7a, item 6, a construir); enquanto ficar só no banco vivo, perder esse banco perde o registro, e a frase da política de privacidade sobre reaplicar exclusões não pode ser publicada.
5. **Trocar as variáveis na Vercel** (projeto marktmorgen, ambiente Production): `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` (ou `KV_REST_API_URL` e `KV_REST_API_TOKEN`, as que o projeto usar; `lib/redis.ts` lê primeiro as `UPSTASH_*`) passam a apontar para o banco novo; depois **publicar de novo**, porque a versão em produção só lê o valor novo numa nova publicação. Não mexer nas variáveis do projeto hazelsong.
6. Conferir o site com uma loja de teste e registrar tudo na seção 7.
7. Religar o agendamento do backup só depois de o site estar estável no banco novo e de as variáveis `BACKUP_*` estarem certas.

### 8.3 Arquivos e vídeos

A cópia de arquivos e vídeos é feita por um Worker na conta separada da Cloudflare, pelo desenho da mensagem C1-20261108-2031-C4-38 (docs/backup-costs-2026-11-08.md, seção 5.1). **Nenhuma credencial da produção fica na conta de backup**: o Worker só chama uma rota do site, protegida por um segredo próprio, que lista os objetos e devolve endereços de leitura de curta duração (R2 pré-assinado, endereço do bunny assinado com a chave de token da zona, Blob privado assinado só para leitura); o Worker baixa direto da origem, e os bytes não passam por função da Vercel. O texto anterior (C4-37), em que o Worker lia a origem com chaves da produção, foi substituído e não deve ser construído. A rota, o segredo e o Worker ainda **não existem no main**.

**Restaurar um arquivo ou vídeo** (passo do dono; nada disso existe ainda):

1. Antes de tudo, conferir no registro de exclusões se o arquivo foi apagado pelo criador ou por pedido de privacidade: **nunca restaurar um arquivo cuja exclusão foi pedida**.
2. **Criar a permissão de gravação da origem só na hora**, para essa restauração, e nada além do necessário:
   - R2 da produção: um token **Object Read & Write** limitado ao bucket de origem, com data de expiração no mesmo dia (a página de tokens do R2, lida em 8/11/2026, diz que um token vale até ser revogado ou até a expiração definida).
   - Vercel Blob: endereços de gravação assinados (`issueSignedToken` com `operations: ['put']`, um caminho por vez, `validUntil` de no máximo 1 hora), emitidos por uma rota de restauração ligada só durante a restauração; nenhum `BLOB_READ_WRITE_TOKEN` sai da Vercel. A página de endereços assinados (lida em 8/11/2026) não diz se uma delegação pode ser revogada antes de `validUntil`, por isso a validade é curta.
   - Bunny Stream: o vídeo volta pela porta de envio assinada que o próprio site já faz (`lib/stream.ts`, válida por pouco tempo); a chave da biblioteca não sai da Vercel.
   - Para ler a cópia: um token **Object Read only** do bucket de cópia, criado na hora, na conta de backup.
3. Copiar do bucket de cópia para a origem, com a versão escolhida (cada versão anterior de um arquivo alterado fica 30 dias na cópia).
4. **Ao terminar, apagar o que foi criado no passo 2**: revogar os tokens do R2 (o de gravação da produção e o de leitura da cópia) e desligar a rota de restauração do Blob. Registrar na seção 7 o que foi criado e quando foi apagado.

**Se o segredo da rota de listagem vazar:** quem o tiver consegue listar nomes e ler arquivos (incidente de confidencialidade), mas não grava nem apaga nada. Trocar o segredo na Vercel e no Worker ao mesmo tempo, como na seção 3, e conferir no relatório da rota quantas chamadas houve fora do horário do Worker.

**Proteções que valem durante um incidente (a construir):** o Worker nunca deduz exclusão da ausência de um item na lista; exclusões só a partir de registro explícito, aplicadas 30 dias depois. Se a lista vier vazia, falhar, vier incompleta ou encolher mais de 20% em relação à anterior, ou à de 7 ou de 30 dias antes, ou se os registros de um dia ou dos últimos 30 dias somarem mais de 20% de uma origem, as exclusões daquela origem ficam **retidas** e o alarme dispara todo dia, com a data em que serão aplicadas. Uma exclusão retida é aplicada mesmo assim quando o registro faz 90 dias (fim automático, para cumprir o prazo de privacidade); entre o início da retenção e esse dia há pelo menos 60 dias. **Se o alarme mostrar que o site foi comprometido, a única ação do dono é pausar o agendamento do Worker (8.1, passo 1)**, que para todas as exclusões, inclusive as do fim automático. Um arquivo alterado vira objeto novo na cópia, e a versão anterior fica 30 dias (até 90 se retida), então uma origem sobrescrita com lixo não destrói a cópia boa nesse prazo. A cópia de cada loja não passa de 5 vezes o espaço do plano: acima disso o Worker para de copiar e avisa, nunca apaga para abrir espaço. Ninguém desliga essas proteções para "acelerar" uma restauração.

### 8.4 Teste mensal de restauração

- Roda **fora da produção**, com credenciais só do teste, revogadas depois. `BACKUP_RESTORE_*` nunca entra no ambiente Production.
- **Com dados reais, só leitura**: ler o conjunto verificado, abrir e conferir manifesto, somas e contagens em memória, sem gravar em lugar nenhum (somente testes sintéticos com escrita, C4-35).
- **Restauração com escrita, só com dados sintéticos**, num banco de teste que é esvaziado depois de cada teste.
- Registrar a data e o resultado de cada teste na seção 7 (ou no registro que o código vier a ter).

### 8.5 Troca da chave das cópias

- Cada cópia leva no cabeçalho do arquivo `.mmbk` o identificador da chave que a selou (C4-36, item 3, a construir).
- Depois de uma troca comum (sem vazamento), a execução diária continua lendo com a chave anterior por **120 dias** (`BACKUP_KEY_PREVIOUS_DAYS`, que é o próprio `BACKUP_MAX_COPY_DAYS`, nunca um número à parte); cópias novas usam só a nova. Passados os 120 dias, a execução deixa de ler com a anterior. Decidido em 9/11/2026 (C1-20261109-0025-C4-47, item 1; #3293); antes eram 60 dias, e com a regra do bucket em 120 dias uma cópia diária de 60 a 120 dias selada com a chave anterior fazia a execução parar em `room_unverified` quando a última boa cópia sumia (sonda A da Claude 2, hoje teste no #3293).
- **O dono guarda a chave anterior offline por pelo menos 120 dias depois da troca** (`BACKUP_MAX_COPY_DAYS`): uma cópia mensal pode ter até 120 dias, e restaurar uma mensal selada antes da troca precisa da chave anterior.
- Uma cópia que não abre só por estar com a chave diferente **nunca** é apagada como perdida (`last_good_copy_lost`).
- O dono confere a cópia da chave guardada em papel e a do gerenciador de senhas pela impressão digital, com o script local (C4-36, item 2), nunca imprimindo a chave.
- **Se a chave das cópias vazou (ou pode ter vazado): trocar como na seção 3 e tirar a chave anterior da Vercel na hora.** Apagar `BACKUP_ENCRYPTION_KEY_PREVIOUS` (e `BACKUP_ENCRYPTION_KEY_ROTATED_AT`) na mesma mudança que grava a chave nova, sem esperar os 120 dias. A consequência, dita sem rodeio: **a partir daí a execução não lê mais nenhuma cópia selada com a chave vazada**, nem as mensais, nem as diárias, nem a última boa. Essas cópias ficam no bucket até a regra levá-las aos 120 dias, só podem ser restauradas com a cópia offline da chave antiga e são tratadas como expostas. Se a última boa cópia sumir e restar uma diária antiga que não abre, a execução para em `room_unverified` (nada é apagado, o alarme toca) até a regra levar essa cópia; a primeira cópia verificada com a chave nova é a primeira boa.

### 8.6 Trava do bucket e resposta 409

Com a trava ligada, apagar um objeto mais novo que ela é recusado pela Cloudflare com **409**. O código deve tratar esse 409 como "objeto travado", nunca como erro genérico: não insistir, não apagar outra coisa no lugar e, se não couber a cópia do dia sem apagar objeto travado, registrar o motivo `room_locked` no relatório e no alarme (C4-35 e C4-36, a construir). Ninguém desliga a trava para "abrir espaço" durante um incidente: ela existe para proteger as cópias justamente nessa hora. (O 409 de `DeleteObject` foi conferido nas páginas oficiais da Cloudflare em 8/11/2026: docs/backup-costs-2026-11-08.md, seção 4a. O que o Worker recebe pela ligação de Workers num objeto travado ainda não foi lido: tratar qualquer erro como não feito.)

### 8.7 O alarme de silêncio (dead-man switch)

- Há **dois sinais de vida**, os dois para o mesmo monitor **fora da Vercel e fora da conta de backup**: o da cópia do banco (rota da Vercel) e o do **Worker** de arquivos e vídeos (mensagem C4-38, item 5). Cada um só é mandado **em sucesso**: o do banco depois de cada execução bem-sucedida e verificada; o do Worker depois de um ciclo diário completo (listas lidas, cada cópia pendente verificada, exclusões vencidas aplicadas). O alarme dispara pelo **silêncio** de qualquer um deles: aviso com 26 horas sem sinal e crítico com 48 horas (o mesmo prazo de `STALE_MS` em `lib/backup-run.ts`).
- Também disparam o alarme: os motivos `prune_*`, `room_*` e `last_good_copy_lost` da cópia do banco (C4-36, item 4); e, no Worker, lista vazia, falha, incompleta ou encolhida mais de 20% (em relação à anterior, à de 7 dias ou à de 30 dias antes), exclusões retidas (com a data do fim automático), registros de um dia ou de 30 dias acima de 20% de uma origem, mais de 20% dos objetos de uma loja com etag novo num dia ou em 30 dias, o teto de espaço de uma loja (`files_room`), arquivo recusado por tamanho, itens ausentes sem registro de exclusão (no dia em que aparecem e de novo no fim dos 90 dias, não nos dias entre os dois; um item ausente cujo registro de exclusão ainda está no prazo de 30 dias, ou antes do fim de 90 dias se retido, é esperado: não dispara alarme e não segura o sinal de vida), cópia atrasada em relação ao próprio teto e recusa da rota de listagem.
- Alarme de silêncio quer dizer: a cópia do dia **não** foi feita ou não foi verificada, por qualquer motivo, inclusive a Vercel ou a Cloudflare fora do ar. Abrir o relatório do backup e o motivo da última falha (`nl:backup:last-fail`, para o banco; o registro do Worker, para arquivos e vídeos); se um provedor estiver fora, esperar a volta e conferir que a próxima execução mandou o sinal.
- O monitor externo é do dono, ainda não foi escolhido e ainda não existe; o preço dele é desconhecido, não zero (docs/backup-costs-2026-11-08.md, seção 5c). Até lá, não há alarme fora da Vercel nem fora da Cloudflare.
