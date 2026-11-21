# Estudo 659 [WG19]: caixas de e-mail no domínio do criador (06/11/2026)

Pedido: C4-20261106-0035-C5-10 (Claude 4), item 659 [WG19] de docs/codex-queue.md (registrado no #2686). Só documento. Nenhuma conta, termo, contrato, pagamento ou contato com terceiro foi feito. Nada foi construído, publicado ou oferecido ao cliente por este estudo (regra VR: estado "estudo").

## 1. Pergunta

O criador pode ter um endereço como `hello@lojadele.com`, no domínio próprio, dado pelo Marktmorgen? Quanto custaria por caixa no pior caso, que riscos traz e o que o criador já consegue fazer sozinho?

## 2. Como as fontes foram lidas (limite deste estudo)

- A rede desta sessão bloqueia a leitura direta das páginas dos provedores: workspace.google.com, support.google.com, www.zoho.com, www.fastmail.com, proton.me, aws.amazon.com, www.migadu.com, purelymail.com, developers.cloudflare.com, improvmx.com, forwardemail.net, resend.com, www.mailgun.com e docs.whop.com, todos com `ENOTFOUND`. www.microsoft.com respondeu 503.
- Os números abaixo vieram de uma busca na web feita em 06/11/2026, que devolve trechos indexados das páginas. Cada linha diz de onde veio:
  - "trecho oficial": trecho indexado da página do próprio provedor, sem a página aberta por mim;
  - "terceiros": só sites de revenda, blogs ou comparadores.
- Nenhum número aqui é fonte oficial conferida na página. Antes de construir qualquer coisa, cada preço precisa ser lido e citado na página oficial, com data. Até lá, pela regra MR, o custo conta como **desconhecido**, nunca como zero.

## 3. O que o Marktmorgen já tem (código no main, 06/11/2026)

- **`lib/domains.ts`:** liga o domínio do criador só ao site (por exemplo `shop.nomedele.com`), no plano Studio, pela Vercel. O criador adiciona os registros DNS no próprio provedor. O arquivo não toca o DNS dele nem cria registro MX.
- **`lib/mail-from.ts`:** o criador envia aos seus contatos de um endereço próprio num subdomínio do Marktmorgen (`MARKETING_FROM_DOMAIN`, por exemplo `harborkitchen@mail.marktmorgen.com`), com o Reply-To no e-mail do criador. Ele não envia do domínio do criador.
- **`lib/inbound-mail.ts`:** recebe só nos endereços do próprio site (support@, hello@, orders@ do Marktmorgen), pelo Resend, e passa para uma caixa interna (`SUPPORT_FORWARD_TO`). Não recebe para domínios de criadores.
- **`lib/inbox.ts`:** caixa de conversas da loja (chat e mensagens), com retenção e teto de bytes. Não é e-mail.
- **`lib/ses.ts`:** o envio pela Amazon SES custa US$ 0,10 por mil e-mails. O registro LC de AGENTS.md diz "o avulso de US$ 0,10 por mil, escolhido em 30/10/2026".

Conclusão: **nada no código recebe e-mail no domínio do criador nem cria caixa para ele.** Construir isso seria um recurso novo.

## 4. O que a Whop faz (referência do pedido)

`POST /email_addresses`, na referência beta da API da Whop (docs.whop.com/api-reference/beta/email-addresses/create-email-address; trecho oficial da busca, página não aberta, a versão de exemplo é `2026-10-15-1`).
- Cria um **endereço com caixa completa** no domínio do negócio. A resposta traz a senha para app de e-mail (IMAP/SMTP).
- Apagar o endereço guarda as mensagens; recriá-lo devolve a caixa.

A Whop, portanto, hospeda caixas de verdade, não só encaminhamento. Isso supõe um serviço de e-mail próprio ou contratado, cujo custo a página não mostra.

## 5. Caminhos possíveis e custo por caixa

| Caminho | O que o criador ganha | Preço encontrado (USD) | Origem do número | O que exige |
| --- | --- | --- | --- | --- |
| **A. Caixa completa revendida** (Google Workspace, Microsoft 365, Zoho) | Caixa com app, agenda etc. no domínio dele | Google Workspace Business Starter: **US$ 7 por usuário/mês** no plano anual e **US$ 8,40** no Flexible Plan | trecho oficial (knowledge.workspace.google.com, "Flexible Plan" e "compare flexible and annual fixed term payment plans") | Programa de revenda ou parceria (contrato = contato com terceiro, decisão do dono). Requisitos do programa não lidos: **lacuna** |
| | | Microsoft Exchange Online Plan 1: cerca de US$ 4 anual e US$ 4,80 mensal | **terceiros** (revendedores), página da Microsoft não lida: **lacuna** | Programa CSP (contrato) |
| | | Zoho Mail Lite 5 GB: cerca de US$ 1 por usuário/mês, anual | **terceiros**; o PDF oficial de preços aparece na busca sem o valor: **lacuna** | Programa de revenda ou parceria |
| **B. Caixa hospedada pelo Marktmorgen** (como a Whop) | Caixa completa | desconhecido (servidor de e-mail, armazenamento, antispam e suporte) | nenhuma fonte | Infraestrutura nova, segurança de senhas e de caixas, antispam: o mais caro e arriscado |
| **C. Encaminhamento pela SES** (`hello@lojadele.com` → e-mail do criador) | Recebe no endereço do domínio e lê na caixa que já usa | Recebimento: **US$ 0,10 por mil e-mails + US$ 0,09 por mil blocos de 256 KB**; reenvio pela SES: US$ 0,10 por mil | trecho oficial (aws.amazon.com/ses/pricing). O nível gratuito de recebimento tem fontes em conflito, então não contei nenhum: **lacuna** | O criador aponta o MX do domínio para a SES; o Marktmorgen recebe e reenvia. Reescrita do remetente (SRS) para não quebrar o SPF; teto por loja |
| **D. Orientação na ajuda, sem o Marktmorgen no meio** | O criador liga o próprio encaminhamento ou caixa no provedor do domínio | Cloudflare Email Routing: limites oficiais de **200 regras por domínio**, 200 destinos por conta e **mensagem até 25 MiB**. Gratuidade não confirmada na página | trecho oficial (developers.cloudflare.com/email-routing/limits) | Nada do Marktmorgen: só um texto de ajuda verdadeiro |

### Pior caso do caminho C, por loja e por mês (fórmula; preço a conferir)

Sem teto, o custo cresce com o spam recebido e não tem limite. Isso fere a regra MR, que pede teto antes de cada gasto. Com um teto exemplo de **100 mensagens recebidas por dia** e **10 MB por mensagem** (40 blocos), num mês de 31 dias:

- recebidas: 100 × 31 = 3.100, então 3,1 × US$ 0,10 = **US$ 0,31**;
- blocos: 3.100 × 40 = 124.000, então 124 × US$ 0,09 = **US$ 11,16**;
- reenviadas: 3.100, então 3,1 × US$ 0,10 = **US$ 0,31**;
- **total de US$ 11,78 por loja e por mês**, mais a transferência de dados dos anexos reenviados, que não foi lida: **desconhecida, nunca zero**.

Com 25 MiB por mensagem (o limite da Cloudflare), os blocos sobem para 100 por mensagem e o pior caso passa de US$ 28. O teto de tamanho decide o custo mais do que o de quantidade.

### Encaixe na regra de margem (MR)

- **Caminho A:** entre US$ 7 e 8,40 por caixa e por mês (Google, trecho oficial). Esse valor entraria no pior caso de cada plano, com o número de caixas como limite visível. Um preço novo ou um complemento pago só com decisão do dono; preços e limites não mudam por este estudo.
- **Caminho C:** o pior caso calculado acima por loja, mais a transferência desconhecida. Até ler a página e ter o teto implementado, a regra MR reprova.
- **Caminho D:** custo zero para o Marktmorgen, porque não há gasto dele.

Este estudo não calcula lucro nem certifica margem. O cálculo por plano pertence ao código de margem do repositório.

## 6. Riscos

- **Entregabilidade:**
  - Encaminhar quebra o SPF do remetente original, sem reescrita SRS, e pode mandar as mensagens para o spam do criador.
  - Para quem envia em massa, o Google exige SPF e DKIM e, a partir de 5.000 mensagens por dia para contas pessoais, DMARC (FAQ oficial support.google.com/a/answer/14229414, trecho da busca; detalhes conferidos só em terceiros).
  - As orientações do Google para remetentes (support.google.com/a/answer/81126) já foram lidas em 07/10/2026, como registra lib/mail-from.ts.
- **Abuso:**
  - Uma caixa ou encaminhamento aberto recebe spam e golpes em nome da loja.
  - Hospedar caixas (caminho B) atrai roubo de senha e envio de spam pela plataforma, o que põe em risco a reputação dos endereços de login e de recibos do Marktmorgen.
- **Privacidade:**
  - O conteúdo dos e-mails é dado pessoal de terceiros.
  - Exigiria texto novo na política de privacidade, retenção e exclusão (lib/person-data.ts) e apagamento junto com a loja.
- **Suporte:** problemas de DNS e MX costumam virar pedido de ajuda. O dono não quer trabalho manual nem painel para acompanhar.
- **Dependência:**
  - O caminho A prende o criador ao provedor escolhido pelo Marktmorgen.
  - A saída do criador (levar a caixa embora) exige migração.

## 7. O que o criador já faz sozinho, sem o Marktmorgen

Quem comprou o domínio pode:
- ligar o encaminhamento gratuito que muitos registradores oferecem;
- usar o Cloudflare Email Routing, se o DNS estiver na Cloudflare (limites oficiais acima);
- contratar a própria caixa (Google Workspace, Microsoft 365, Zoho e outros).

O domínio da loja costuma ser um subdomínio (`shop.nomedele.com`). O MX do domínio principal não interfere nele, então as duas coisas convivem.

## 8. Depende do dono: recomendação única

**Não construir caixas de e-mail nem encaminhamento agora.** Fazer, como item pequeno separado, só uma página de ajuda (caminho D):
- explicar, em inglês americano simples, como ter um endereço no próprio domínio pelo provedor do domínio;
- dizer que o domínio da loja continua funcionando;
- não prometer nada que o Marktmorgen faça.

Motivos:
- **Caminho A:** exige contrato de revenda (contato com terceiro) e soma US$ 7 a 8,40 por caixa e por mês ao pior caso de cada plano.
- **Caminho B:** é infraestrutura nova, de alto risco e custo desconhecido.
- **Caminho C:** tem custo sem teto até ser construído e depende de preços ainda não lidos na página oficial.
- **Caminho D:** entrega o mesmo resultado prático ao criador, com custo zero e sem risco para a reputação de envio do Marktmorgen.

Reavaliar o caminho C depois da abertura, se houver pedido real de criadores, com:
- a página de preços da SES lida e citada;
- teto por loja de quantidade e de tamanho;
- SRS;
- texto de privacidade.

Decisão pedida ao dono:
- aceitar ou recusar esta recomendação;
- se aceitar, a página de ajuda entra na fila como item novo.

## 9. Lacunas registradas

1. Nenhuma página oficial de provedor foi aberta (rede bloqueada; hosts no item 2). Os números são trechos indexados ou de terceiros.
2. Microsoft 365 e Zoho: sem preço oficial.
3. Requisitos e preços dos programas de revenda (Google, Microsoft CSP, Zoho): não lidos.
4. Nível gratuito de recebimento da SES: fontes em conflito; nenhum foi contado.
5. Custo de transferência de dados dos anexos reenviados (caminho C): não lido.
6. Gratuidade e limites de envio do Cloudflare Email Routing: não confirmados na página.
7. Fastmail, Proton, Amazon WorkMail, Migadu, Purelymail, ImprovMX, Forward Email, Resend inbound e Mailgun: não lidos (rede bloqueada).

Para fechar as lacunas, é preciso liberar esses hosts nas configurações de rede da sessão e ler cada página. Isso só é necessário se o dono quiser seguir com A ou C.
