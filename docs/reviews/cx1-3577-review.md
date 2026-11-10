# Codex CX1 — primeira revisão financeira de #3577

Head `6b873f2f37a11b8f23973555d1e53bd1622c8af9`, base
`f6ef221443876025eb6286940d687bf97799dd8e`.

**Sem achado funcional ALTO/MÉDIO no delta; ajuste obrigatório de escopo antes
da fila.** Li o diff inteiro dos seis arquivos, o leitor inteiro e a decisão
financeira que consome suas linhas. Nenhum chamador produtivo está ligado.

BAIXO (processo/escopo): `docs/reservations/codex.md:101` foi alterado neste
PR de produto. A ordem de retomada do CX1 e CX-122 item 9 dizem que o PR de
produto não altera docs/reservations/. A reserva já existe no canal; retirar
somente essa alteração do PR, sem remover a reserva do canal ou mudar produto.
Evidência estática RED: `git diff --name-only BASE...HEAD` contém esse arquivo.
É uma violação documental verificável no diff, não defeito do leitor nem teste
comportamental fabricado. O autor deve tratar o ajuste antes da fila.

Validação financeira: um Set por fatura recusa IDs de linha repetidos em
qualquer página antes de devolver leitura completa. Um desconhecido devolve
lines_unreadable; no leitor da janela, o ID é separado em unread, para retomada,
e as outras faturas continuam. IDs distintos com o mesmo período não são
escondidos: a decisão ainda identifica duplicação financeira legítima.
O limite da lista se aplica também a páginas terminais. Não há comando,
requisição, chave, retenção, preço, flag ou gate novo.

Execuções permanentes no head: charge-check-read-evidence 23/23,
charge-check 51/51 e o leitor completo charge-check-read 66/66.
São 140 checks, com sobreposição de cenários. A suíte inteira do leitor foi
executada com seu get simulado, incluindo o caso do teto de 300 chamadas; não
é o orçamento de 100 mocks da execução anterior do autor. Não reiniciei nem
reutilizei o contador do autor. Todos os provedores aqui são sintéticos.

Mesma regressão permanente (23 checks) com somente lib/charge-check-read.ts
do RED `1a1ca0e660836a928868f4a7ad8207feb9eb05b8` no grafo final:
11 falhas; no head, 23 passam. Substituição de módulo, não árvore histórica
inteira. Prova própria cx1-3577-boundaries: 16/16 no head e 10/16 falhas no
mesmo módulo anterior, cobrindo repetição na terceira página, repetição dentro
da página seguinte, IDs ausentes/números, resposta saudável sem mutação,
orçamento zero sem leitura, fatura ilegível junto de outra válida e limite de
páginas anterior à chamada extra. O log guarda a contagem própria dos mocks.

Limites: testes seriais, Node 24.18.0, 512MiB de heap, 120s/256KiB por arquivo,
fetch/http/socket reais negados antes dos imports. StripeGet simulado; nenhuma
escrita, cobrança, reembolso, conta ou dado real. Next instalado 16.4.2 versus
package.json 16.4.5: não é build exato ao lock. A prova direta usa alias que
nega o platformGet e não depende do Next. Sem navegador, Redis nativo, Stripe
real, tipos/lint globais ou CI hospedado. Não certifiquei margem, cron ou a
composição futura com #3463.

Acessibilidade: mudança exclusivamente de validação no servidor, sem texto,
tela, controle, passo ou decisão novos. Não certifica acessibilidade global.

Pode entrar do ponto de vista funcional deste delta depois do ajuste de
escopo, da segunda revisão de dinheiro e dos nove agregadores verdes no head
aplicável. Não conferi CI agora e não pedi fila. Próximo responsável: autor.
