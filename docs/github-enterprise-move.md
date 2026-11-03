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
4. Orçamentos de produtos pagos em US$ 0 com bloqueio. Repositório público não paga minutos de Actions.
5. Não ligar SAML, lista de IPs permitidos nem políticas que restrinjam ações ou aplicativos.

## No dia da transferência (o Claude 1 conduz)

1. Mensagem na caixa pedindo que Claude 2, Claude 3 e Codex parem de enviar commits e PRs até a liberação.
2. Escolher um momento com a fila do CI baixa. Ainda não verificado: o que acontece com execuções na fila no momento da transferência; rodar de novo o que for cancelado.
3. O dono transfere `viniciussucupira/marktmorgen` para `solrenning-llc` e faz o "Confirm access".
4. Conferir que o número continua 1334793724 e que o endereço antigo redireciona.
5. Vercel, projeto `marktmorgen`: Settings → Git. Se a ligação caiu, "Reconnect" e escolher `solrenning-llc/marktmorgen`. Conferir com uma publicação de teste (prévia de um PR de documentação). O site no ar não cai durante isso.
6. Agentes: cada sessão do Claude acrescenta `solrenning-llc/marktmorgen`; o ambiente do Codex passa a apontar para o endereço novo. Conferir um envio de cada um.
7. No PC do dono: atualizar o endereço em `espelho-github.bat` e nas cópias do GitHub Desktop (o redirecionamento cobre até lá).
8. Confirmar mais de 40 tarefas rodando ao mesmo tempo.
9. Mensagem na caixa liberando os agentes.

## Volta atrás

O repositório pode ser transferido de volta para `viniciussucupira` (o redirecionamento passa a valer no outro sentido) e o Enterprise pode ser cancelado. Os guardas do CI aceitam os dois endereços.
