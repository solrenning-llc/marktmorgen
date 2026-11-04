# Entrar com o Google — 276 [H3-1]

Registro de 01/11/2026 (Fortaleza). Estado (VR): **desligado pelas travas**, construído e testado num PR; não está disponível ao cliente. `GOOGLE_SIGNIN_APPROVED` é `false` em `lib/google-signin.ts`. Nada foi feito no Google Cloud, nenhuma conta, termo ou configuração foi tocada.

## O que foi construído

- **Na página de login (/signin):** o botão "Continue with Google", abaixo do link por e-mail e da passkey, aparece só quando o recurso está ligado. O botão é um formulário simples, que funciona sem JavaScript.
- **O que se pede ao Google:** somente os escopos `openid email`. Não pede refresh token, outros escopos nem acesso a e-mail, contatos, agenda ou qualquer outro dado da conta. Nada do que o Google manda é guardado: nem token, nem número da conta Google.
- **Que conta é aberta:** a conta Marktmorgen do e-mail que o Google confirmou, exatamente como se a pessoa tivesse aberto o link enviado a esse endereço. Se ainda não houver conta, é o mesmo cadastro que o link faz.
- **Quando abre sessão:** somente quando as duas condições valem.
  1. `email_verified` é `true` (verdadeiro booleano; ausente, `false` ou o texto `"true"` reprovam).
  2. O Google responde por aquela caixa de e-mail: um endereço dos domínios gmail.com ou googlemail.com, ou um endereço do domínio do Google Workspace que o próprio token nomeia (`hd`) e que é o mesmo domínio do e-mail.

  Uma conta Google criada com um e-mail de outro provedor (por exemplo, do domínio yahoo.com) não abre sessão. A pessoa recebe a orientação de usar o link por e-mail. O motivo é que o Google não é dono dessa caixa, e a conta Google pode continuar existindo depois que a pessoa perde o acesso àquele e-mail.

  Essa é a leitura mais segura. A página oficial do Google sobre OpenID Connect (developers.google.com) **não pôde ser lida nesta sessão**, porque o domínio está fora da rede permitida. O que se sabe dela vem só de um resumo de busca, que não serve como fonte. Por isso a regra não se apoia em nenhuma frase do Google: ela recusa tudo o que não seja comprovadamente do Google.
- **Segurança do fluxo:**
  - OAuth 2.0 com PKCE (S256) e nonce do OpenID;
  - estado aleatório, guardado 10 minutos no Redis e gasto uma única vez;
  - o mesmo estado num cookie `nl_gsi` só deste navegador (HttpOnly, SameSite=Lax, caminho `/api/integrations/google`, 10 minutos). Assim, um login começado por outra pessoa não termina neste navegador;
  - o token de identidade é lido pelo próprio servidor no endpoint de tokens do Google, com o segredo do cliente, e emissor, audiência, validade, `sub` e nonce são conferidos.
- **Mesma sessão das outras formas de entrar:**
  - o login em duas etapas segura a sessão até o código, como no link;
  - "Log out of all devices" encerra a sessão;
  - o e-mail de "novo navegador" diz "with Google";
  - o acesso pela recuperação é fechado, como no link.

  Tudo isso está num lugar só, `lib/signin-finish.ts`, usado também pelo link.
- **Limite de tentativas:** 20 por máquina a cada 10 minutos, somando início e volta. O endereço da loja digitado na página inicial vai junto, só no cookie, como o link faz.
- **Endereço de volta:** o que já está cadastrado no Google para o Google Calendar e o Search Console, `https://marktmorgen.com/api/integrations/google/callback`. O estado `gsi.` separa o login dos outros dois fluxos.
- **Política de privacidade:** um parágrafo `#google-signin`, a linha do Google entre os fornecedores e o cookie `nl_gsi`, todos exibidos **somente enquanto o recurso estiver ligado**. Enquanto estiver desligado, a política não descreve algo que o cliente não pode usar (regra VR, item 2).
- **Testes:** `tests/google-signin.test.ts`, com um Google simulado e sem nenhuma chamada real.

## Lacunas conhecidas

- **Pontos no Gmail:** a conta é ligada ao endereço exatamente como o Google o devolve. Quem se cadastrou pelo link com o nome `johndoe` no Gmail e tem a conta Google com o nome `john.doe` abriria, pelo Google, outra conta, vazia (o Gmail entrega nos dois, mas aqui são endereços diferentes). Também os domínios googlemail.com e gmail.com ficam separados. Um aviso ou a junção dos dois casos pede um desenho próprio e não está feito.
- **Domínios secundários do Google Workspace:** o `hd` traz só o domínio principal. Um endereço válido num domínio secundário da mesma organização é recusado e mandado para o link. É o lado seguro: o erro possível é recusar, nunca abrir.
- **O cookie `nl_gsi` não usa o prefixo `__Host-`,** como os outros cookies do site. Um subdomínio irmão que rodasse script poderia plantá-lo, risco que já existe para os demais cookies. Fica como defesa adicional futura.

## Custos

- **Custos nossos (por login):** duas operações no Redis para o estado, a contagem de tentativas e uma chamada ao endpoint de tokens do Google. Estão classificados como guarda de conta, como a passkey (`tests/plan-cost-registry.ts`, `"google-signin": ACCOUNT`).
- **Preço do Google para o login com OAuth:** **não conferido em fonte oficial nesta sessão**, porque a rede recusa developers.google.com e cloud.google.com. Custo desconhecido não é zero. Conferir antes de ligar, no passo 1 abaixo.

## O que o dono precisa fazer no Google Cloud (projeto nimbus-labs-509912, conta 072)

Nada disto foi feito por agente. Os nomes dos menus mudam com o tempo. Como a documentação do Google não pôde ser lida hoje, confira cada nome na própria tela no dia.

1. **Conferir o preço.** Na documentação oficial do Google Identity, confira se o login com OAuth/OpenID Connect tem custo, e registre a data e a fonte nesta página. Se houver custo, ele entra nos custos da LLC antes de ligar.
2. **Abrir o projeto.** Em console.cloud.google.com, entrando com a conta 072, escolha o projeto **nimbus-labs-509912**, o mesmo das chaves `GOOGLE_OAUTH_CLIENT_ID` e `GOOGLE_OAUTH_CLIENT_SECRET` que já estão na Vercel para o Google Calendar e o Search Console.
3. **Identidade do app** ("Google Auth Platform" → "Branding", antes chamado "OAuth consent screen"):
   - nome **Marktmorgen**;
   - e-mail de suporte support@marktmorgen.com;
   - página inicial https://marktmorgen.com;
   - política de privacidade https://marktmorgen.com/privacy;
   - termos https://marktmorgen.com/terms;
   - domínio autorizado marktmorgen.com.

   O nome aparece para a pessoa na página do Google.
4. **Escopos** ("Data access"): confira se `openid` e `.../auth/userinfo.email` estão na lista. Os escopos do Calendar e do Search Console já existentes ficam como estão.
5. **Público** ("Audience"): confira se o app está **"In production"**. Em "Testing", só os usuários de teste conseguem entrar. Veja também o estado da verificação: os escopos do Calendar são sensíveis e podem exigir verificação do app. Registre aqui o que a tela disser sobre o login só com `openid email`.
6. **Cliente** ("Clients"): no cliente Web cujo ID é o `GOOGLE_OAUTH_CLIENT_ID` da Vercel, confira se `https://marktmorgen.com/api/integrations/google/callback` está em "Authorized redirect URIs". Já deve estar, porque o Calendar usa esse endereço. Não é preciso acrescentar nenhum outro.
7. **Marca do botão:** confira, nas diretrizes de marca do Google para o login, se o botão de texto "Continue with Google" sem o logotipo é aceito. Se o logotipo for exigido, ele deve entrar como imagem com texto alternativo, nunca como imagem de texto (AX274, 1.4.9).
8. **Ligar:**
   - para um teste com o seu próprio Gmail, defina `GOOGLE_SIGNIN_LIVE=1` na Vercel e abra https://marktmorgen.com/signin?google=test. Com essa variável, o botão aparece **somente** nesse endereço de teste, nunca na página normal de login, e a política de privacidade não muda. Assim nenhum criador encontra um botão que o Google ainda pode recusar;
   - o teste só funciona em marktmorgen.com, porque o endereço de volta é fixo. Em www.marktmorgen.com ou num endereço de pré-visualização da Vercel, o botão não aparece, e um início vindo de lá é mandado para marktmorgen.com/signin;
   - só depois de o passo 5 mostrar "In production", peça a troca de `GOOGLE_SIGNIN_APPROVED` para `true` num PR revisado. É essa troca que mostra o botão a todos e acrescenta os trechos da política de privacidade.
9. **Conferir de ponta a ponta:**
   - entrar com um Gmail abre o estúdio;
   - entrar com uma conta Google de e-mail de outro provedor mostra "Use the emailed link for that address";
   - com o login em duas etapas ligado, o código é pedido;
   - "Log out of all devices" encerra a sessão.

## Entrar com a Apple — somente estudo

Não construído, por decisão do pedido.

- **Requisito:** o login com a Apple exige o Apple Developer Program. O preço de US$ 99 por ano é informação do dono, **não conferida em fonte oficial nesta sessão** (a rede não alcança developer.apple.com). É custo fixo da LLC, entra nos custos fixos de FX275 e depende de aprovação do dono.
- **O que mudaria em relação ao Google:**
  - a Apple pode entregar um endereço de retransmissão no lugar do e-mail real (o "Hide My Email", em `privaterelay.appleid.com`). Para que os nossos e-mails cheguem a esse endereço, o domínio de envio precisa ser registrado na Apple. Isso afeta a faixa de e-mail (SES/Resend, de outra faixa);
  - a conta Marktmorgen ficaria ligada a esse endereço de retransmissão, e não ao e-mail que a pessoa conhece, o que pede um desenho próprio de vínculo e de recuperação;
  - a Apple envia o nome só no primeiro login, e a regra de "e-mail confirmado" precisa ser relida nos documentos da Apple.
- **Recomendação:** não fazer agora. A decisão fica em "Depende do dono", junto com o custo anual conferido.

## Acessibilidade

- O botão é um `<button>` de verdade dentro de um formulário, com o nome visível "Continue with Google" e as classes dos outros botões da página (alvo de 44 px, foco visível).
- Cada resultado (cancelado, endereço não confirmado, endereço de outro provedor, tentativas demais, erro, tempo esgotado) aparece no aviso já existente da página (`role="status"`), dizendo o que aconteceu, que nada mudou e o que fazer, sempre com o link por e-mail como alternativa.
- Não há teste com leitor de tela nem teste com pessoas. A página do Google não está sob o controle do Marktmorgen.
