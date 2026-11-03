# Mudança do repositório para a organização solrenning-llc (GitHub Enterprise)

Roteiro preparado pelo Claude 1 em 02/11/2026, a pedido do dono ("deixar pronto"). **Nada aqui foi executado no Marktmorgen.** A compra do Enterprise e a transferência dependem do "sim" do dono no dia, depois da resposta do suporte do GitHub (chamado #4942385) ou de 04/11/2026, o que vier primeiro. Se o suporte aumentar o limite do GitHub Pro, este roteiro não é usado.

Motivo: o GitHub Pro permite 40 tarefas simultâneas (5 macOS); o Enterprise, 500 (50 macOS) (docs.github.com/en/actions/reference/limits, lido em 02/11/2026). A fila do CI passou de 300 execuções esperando em 02/11/2026.

## Já provado em 02/11/2026

| Verificação | Prova |
| --- | --- |
| A transferência mantém o número do repositório | `repo-id-transfer-test`: 1443628719 antes e depois da transferência de `viniciussucupira` para `solrenning-llc` |
| O endereço antigo redireciona | github.com/viniciussucupira/repo-id-transfer-test abre o repositório novo |
| Sessões do Claude leem e enviam código na organização | Claude 1 acrescentou, clonou e enviou o ramo `access-test` |
| O Codex lê e envia código na organização | ramo `codex/access-test` enviado pelo Codex às 22h00 (mensagem CX-4) |
| A Vercel enxerga a organização | a API de importação da Vercel lista `solrenning-llc/repo-id-transfer-test`; a instalação pessoal continua listando `viniciussucupira/marktmorgen` (1334793724) |
| Os guardas do CI aceitam o número do repositório | PR #1836 (passo 1) |
| O endereço das execuções dos leitores de tela aceita a organização | este PR |
| O CI não depende de segredo, variável ou ambiente | os 9 workflows declaram `permissions` próprias e não usam `secrets.`, `vars.` nem `environment:` |

## Antes da compra

1. #1836 incorporado ao main.
2. `.github/workflows/product-checks.yml`: trocar as três condições `github.repository == 'viniciussucupira/marktmorgen'` por `(github.repository_id == '1334793724' || github.repository == 'viniciussucupira/marktmorgen')`, depois que o #1502 do Codex for incorporado (o arquivo está reservado por ele).
3. Resposta do suporte do GitHub conferida.

## No dia da compra (o dono clica; o Claude 1 confere cada tela antes)

1. Tipo de conta: **"Enterprise with personal accounts"**. Nunca "Enterprise Managed Users" nem residência de dados (GHE.com), que criam contas novas e impedem repositório público.
2. Preço: US$ 21 por licença por mês, uma licença (só o dono é membro). Nada a mais marcado (Copilot, Advanced Security).
3. Levar a organização `solrenning-llc` (criada fora do teste) para o Enterprise e clicar em **"Activate Enterprise"** no mesmo dia: o teste grátis não aumenta o limite de tarefas simultâneas.
4. **Logo depois de "Activate paid GitHub Enterprise", criar orçamentos de US$ 0 com bloqueio** ("stop usage") para Actions, Codespaces, Packages, Git LFS, Copilot e os demais produtos medidos, em Billing and licensing → Budgets and alerts. A própria tela avisa: "If no budget is set, usage for that product is unlimited", e orçamentos não existem durante o teste. Repositório público não paga minutos de Actions; o orçamento é a trava contra uso pago por engano (executor maior, Codespaces, repositório privado).
5. Não ligar SAML, lista de IPs permitidos nem políticas que restrinjam ações ou aplicativos.

## Conferido em 02/11/2026, depois de criar o teste (só leitura)

- Teste do Enterprise "Solrenning" (github.com/enterprises/solrenning) criado pelo dono às 22h50, tipo "Enterprise with personal accounts", com a organização solrenning-llc dentro; 30 dias; nada ativado.
- Tela de compra: Enterprise Cloud US$ 21 por licença, Secret Protection US$ 19 e Code Security US$ 30 por pessoa que envia código, todos em 0; total estimado US$ 0,00; dados de cobrança (nome do dono, endereço em Fortaleza, CPF digitado pelo dono) e cartão salvos pelo dono às 23h06.
- Secret Protection e Code Security desligados no repositório de teste e sem configuração na organização ("Set up Advanced Security" por fazer).
- Actions, empresa e organização: "Allow all actions and reusable workflows"; executores padrão do GitHub permitidos ("Disable for all organizations" desmarcado); token do CI só leitura; aprovação para quem contribui pela primeira vez; workflows de forks em repositórios privados desligados.
- Segurança de acesso: 2FA obrigatório, SAML e lista de IPs permitidos, todos desligados.
- Orçamentos: não existem no teste; criar logo depois da compra (passo 4 acima).

## No dia da transferência (o Claude 1 conduz)

1. Começar à noite, longe das 02h37 (o agendamento diário dos 9 workflows, cron 37 5 * * * em UTC). Mensagem na caixa pedindo que Claude 2, Claude 3 e Codex continuem trabalhando e fazendo commits nos próprios ramos, mas sem enviar ao GitHub nem abrir PR até a liberação.
2. Esperar a fila zerar sozinha, sem cancelar nada (cerca de 2.500 execuções processadas por dia em 02/11/2026; uma fila de ~340 escoa em 3 a 4 horas). Transferir só com 0 execuções na fila e 0 rodando (decisão do dono, 02/11/2026 23h33: "diga o mais seguro para evitar problema"). Não verificado e por isso evitado: o que acontece com execuções na fila no momento da transferência.
3. O dono transfere `viniciussucupira/marktmorgen` para `solrenning-llc` e faz o "Confirm access".
4. Conferir que o número continua 1334793724 e que o endereço antigo redireciona.
5. Vercel, projeto `marktmorgen`: Settings → Git. Se a ligação caiu, "Reconnect" e escolher `solrenning-llc/marktmorgen`. Conferir com uma publicação de teste (prévia de um PR de documentação). O site no ar não cai durante isso.
6. Agentes: cada sessão do Claude acrescenta `solrenning-llc/marktmorgen`; o ambiente do Codex passa a apontar para o endereço novo. Conferir um envio de cada um.
7. No PC do dono: atualizar o endereço em `espelho-github.bat` e nas cópias do GitHub Desktop (o redirecionamento cobre até lá).
8. Confirmar mais de 40 tarefas rodando ao mesmo tempo.
9. Mensagem na caixa liberando os agentes.

## Volta atrás

O repositório pode ser transferido de volta para `viniciussucupira` (o redirecionamento passa a valer no outro sentido) e o Enterprise pode ser cancelado. Os guardas do CI aceitam os dois endereços.
