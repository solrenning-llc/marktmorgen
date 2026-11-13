# 240 [CF3] — Começar pelo e-mail na página inicial, e o boletim do Marktmorgen: desenho (unidade 0)

Estado: **desenho, testado num PR**. Nada no site muda por este documento.
Escrito em 11/11/2026 pela Claude 4 (nuvem B), sobre o main desse dia.

## 1. O que já existe (conferido no código)

- **A home tem um campo, mas é o do endereço da loja** (VS1, `components/home-claim.tsx`). Ele faz um GET para `/signin?handle=...`. A página `/signin` confere o endereço (`lib/handle-prefill.ts`) e o mostra de volta. O e-mail é digitado depois, em `/signin`.
- **O link de acesso é pedido por um POST** de `components/signin-form.tsx` para `app/api/auth/request`:
  - leva a proteção contra robôs que já existe (BotID, o `fetch` envolvido em `lib/browser-check-client.ts`);
  - a resposta nunca diz se o endereço já tem conta;
  - tem limites por conexão e por endereço (`rateLimitAnswer`, `addressLimitAnswer`).
- **Não há** lembrete de cadastro não concluído, boletim do Marktmorgen nem caixa de consentimento para eles.
- **O endereço postal da empresa está vazio:** `COMPANY_POSTAL_ADDRESS = ""` em `lib/company-postal.ts`, salvo se a implantação o definir.

## 2. Decisões de desenho

1. **O e-mail nunca vai na URL.** Levar o e-mail da home para `/signin` por `?email=` o deixaria:
   - nos registros de acesso da hospedagem;
   - no histórico do navegador;
   - no cabeçalho `Referer` das páginas seguintes.

   Isso é dado pessoal fora de qualquer prazo de retenção. Por isso, o campo da home **é o próprio `SignInForm`**, com o mesmo POST, o mesmo BotID e os mesmos limites. Não existe um caminho novo nem uma segunda rota de envio.
2. **Um único campo na primeira tela.** O desenho do herói é decisão do dono (VS1, HT1), e o teste e2e `tests/e2e/home-hero.mjs` o fixa. Por isso, há duas opções, e **o dono escolhe**:
   - **(a)** trocar o campo do endereço da loja pelo do e-mail. O endereço passa a ser escolhido depois do link, como já acontece hoje (`components/handle-form.tsx`).
   - **(b)** manter o campo do endereço e acrescentar o do e-mail logo abaixo, no mesmo formulário.

   Recomendação: **(a)**. É uma ação só na primeira tela (VR, item 4), e o passo do endereço já existe depois do link.
3. **O lembrete só existe com o pedido da pessoa.**
   - A caixa vem **desmarcada**: "Email me one reminder if I don't finish signing up".
   - Sem a caixa marcada, nada é enviado além do link pedido.
   - Com a caixa marcada, o lembrete é **no máximo um**, e sai 24 horas depois do pedido, se o cadastro não tiver sido concluído.
   - Guardam-se a frase exata da caixa, a versão dela (como `ASSIST_REMIND_VERSION`) e a hora do "sim", pelo tempo do lembrete. Depois, só o fato de que ele saiu, sem o endereço.
   - O lembrete nunca sai quando:
     - o cadastro foi concluído;
     - o endereço foi devolvido, reclamou ou está na lista de supressão;
     - a pessoa pediu para parar;
     - não há o endereço postal da empresa.
4. **O boletim é outra caixa, também desmarcada**: "Send me Marktmorgen's newsletter for creators".
   - É independente do lembrete e do cadastro: marcar uma caixa não marca a outra.
   - O conteúdo vem da academia (221 [HL2]): só o que for verificável e o que a plataforma realmente faz, sem promessa de ganho.
   - Cada envio leva o descadastro em um clique (List-Unsubscribe e List-Unsubscribe-Post), atendido na hora.
   - Cada envio leva também o endereço postal da empresa.
   - **Enquanto `COMPANY_POSTAL_ADDRESS` estiver vazio, a caixa do boletim não aparece e nada do boletim é enviado.** É uma decisão do dono: o endereço comercial ainda depende do SR5, porque caixa postal não serve.
5. **A medição é agregada, sem dado pessoal.** São contagens por dia de:
   - formulários enviados a partir da home;
   - links pedidos;
   - cadastros concluídos.

   Medem-se antes e depois da troca, sem rastrear a abertura do e-mail e sem identificador de pessoa (VR, item 3). Só se compara o "depois" com o "antes" com pelo menos 30 dias de cada lado. Nenhuma página cita o resultado sem essa medição registrada (251 [ST4]).

## 3. Custo e teto (regra MR; custo fixo da empresa, FX275)

| Linha | Pior caso | Teto automático proposto |
| --- | --- | --- |
| Lembrete de cadastro | 1 e-mail por pedido de link com a caixa marcada | no máximo `SIGNUP_REMINDERS_DAILY` = 1.000 por dia; acima disso, nenhum lembrete é enviado naquele dia |
| Boletim | 1 e-mail por inscrito por edição | no máximo `NEWSLETTER_SENDS_MONTHLY` = 20.000 por mês; acima disso, a edição não sai |
| Contagens da medição | 3 contadores por dia | 3 comandos por evento, já dentro do pedido de link |

Pelo preço por e-mail que o código usa hoje (`PER_EMAIL` = US$ 0,0009, em `tests/plan-cost-registry.ts`):
- o lembrete custa no máximo 30 × 1.000 × 0,0009 = **US$ 27,00 por mês**;
- o boletim custa no máximo 20.000 × 0,0009 = **US$ 18,00 por mês**.

Pelo preço avulso da Amazon SES da conta do dono (regra LC, US$ 0,10 por mil), seriam US$ 3,00 e US$ 2,00. Esse preço só vale no cálculo quando as proteções do EM1 estiverem no main.

O Redis das contagens e do consentimento guardado não está medido. Fica **desconhecido, nunca zero**, até a unidade que o construir o calcular.

Os tetos de 1.000 por dia e 20.000 por mês são **proposta para o dono**. Um teto mais alto custa mais, e um mais baixo pode deixar uma edição sem sair.

## 4. Leis a conferir antes de construir

O pedido cita a CAN-SPAM (Estados Unidos), o GDPR, a CASL (Canadá) e as regras do Reino Unido (PECR). **Nenhuma fonte oficial foi lida hoje**: os sites oficiais não estavam ao alcance desta sessão. As exigências abaixo são as que o desenho já cumpre pelo lado mais rigoroso. Cada uma precisa da fonte oficial datada na unidade que construir o envio:

- consentimento expresso, separado por finalidade, em caixa desmarcada, com a frase e a hora guardadas;
- descadastro em um clique, atendido na hora;
- endereço postal em cada envio;
- remetente identificado e assunto honesto;
- nenhum envio a quem não pediu.

## 5. Unidades seguintes

1. As regras puras, desligadas (`HOME_EMAIL_START_ON` = false): a frase e a versão das caixas, quando o lembrete pode sair e os tetos. RED antes.
2. O campo da home pela opção que o dono escolher, com o `SignInForm`, as duas caixas e a medição. O teste e2e do herói é atualizado junto.
3. O envio do lembrete, pela fila de e-mail que já existe, com o teto e a prova de envio.
4. O boletim, só depois do endereço postal da empresa e da academia (221 [HL2]).

## Depende do dono

- A opção (a) ou (b) do campo na primeira tela.
- Os dois tetos propostos.
- O endereço postal da empresa, sem o qual o boletim não existe.

## Acessibilidade

- O desenho mantém:
  - um rótulo visível em cada campo e em cada caixa;
  - alvos de 44 px;
  - mensagens em região viva (`role="status"`, como no `SignInForm` de hoje);
  - nenhum limite de tempo;
  - inglês americano simples.
- Nada foi construído, então nenhum critério foi conferido na tela. A unidade 2 confere e registra.
- Passos e decisões da tarefa principal (pedir o link a partir da home):
  - hoje, são 2 telas e 2 campos (endereço na home, e-mail em `/signin`);
  - pela opção (a), seriam 1 tela e 1 campo;
  - pela opção (b), seriam 1 tela e 2 campos.
