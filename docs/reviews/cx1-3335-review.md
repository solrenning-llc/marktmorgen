# Codex CX1 — revisão financeira independente completa de #3335

Head `85f6833757a1a1bf5a2513fc3e8daecca796eb60`, base
`f8c8e0d69201461ed4541d0053dc6a120803c8f6`.

**Sem novo ALTO/MÉDIO no diff inteiro dos seis arquivos; pode entrar com as
ressalvas existentes.** Crédito ao parecer completo Claude2/6737299908 e ao
parecer parcial H2/5822092775. Este parecer completa uma revisão financeira
independente, sem transformar o parecer parcial anterior em aprovação global.

O HDEL de ? confirma só 0/1; um resultado desconhecido impede dizer que nada
será enviado. A linha fica reservada, e a rota/email/tela explicam pending.
O campo s liga o lote nomeado ao pedido original, sem criar outra chave ou
reter dados pessoais novos. O leitor de exposição valida s antes de usá-lo.
Um ? já associado ao lote nomeado não é enviado de novo; enquanto a remoção
não for confirmada, o lote conhecido também fica esperando, contado uma vez.
A releitura sob trava cobre uma promoção concorrente depois do snapshot.

Li a rota, componentes e mensagens novas, pending-payouts inteiro, os ramos
modificados de payWithPayPal/settlePayPal/settleUnknown, os registros de dados
e os caminhos de remoção dos lotes. Nenhuma permissão, segredo, destinatário,
preço, limite, comissão, flag ou gate é alterado pelo delta. Sem promessa de
conformidade AAA ou de idempotência global do restante do repositório.

Permanentes no head: writes-exact66, payouts49, reconcile43, unknown45,
settle-unknown9, pending-payouts33, plan-cost-registry26, store-data-registry7:
278 checks, com sobreposição. Mesmos 66 checks com só paypal-payouts,
pending-payouts e affiliate-payday da base no grafo final:25 falhas; não é
execução da árvore histórica inteira. O check estático do componente nessa
reprodução ainda lê o componente do head.

Provas próprias: sender14/14 (campo opcional legado, valores válidos e limite
127, recusa dos oito valores inválidos e texto pending); corrida4/4 pelo
writer/settle reais com Redis/fetch simulados. Na corrida, o primeiro snapshot
tem somente ?; antes da releitura sob trava outro processo promove o MESMO
pedido para o lote PayPal, deixando o ?. O head não faz outro POST e a rodada
seguinte liquida ambos os destinatários. Mesmo teste com só paypal-payouts
de a1079aa00724dd0afe282728f897d90c26e486f8:4 checks/2 falhas, pois o POST é
repetido. A prova está durável em tests/cx1-3335-promote-race.proof.ts; os testes
de produto não foram alterados. Isto cobre de forma própria a lacuna de teste
apontada no LEVE1 do Claude2, sem declará-la adicionada à suíte de produto.

Uma primeira versão da própria sonda supôs incorretamente reason unknown na
aceitação confirmada pelo PayPal, quando apenas promoteBatch não foi
confirmado. Fonte477–479 mostra retorno ok true com o lote já nomeado. A
justificativa foi publicada no canal ANTES da correção da premissa, como
exige a regra23. Logs iniciais race/race-red preservados e não contados como
defeito do produto; finais race-final/race-final-red são os contados acima.

Ressalvas existentes de Claude2 mantidas: redação pending não descreve todas
as combinações de estado/retomada; recusa PayPal pode terminar em conferência
manual sem comunicar o motivo; HSET antigo aplicado depois do HDEL e a
escrita de needsManualCheck a partir de snapshot antigo continuam limites
herdados, sem prova nova ou falsa certificação nesta revisão. Não aprovei a
composição financeira com #3272, que recebeu ALTO condicional próprio CX1.

Custo: sem comando novo no caminho normal; a limpeza acrescenta HDEL de ?
retido na rodada de liquidação, dentro da exposição dos lotes abertos. O
registro existente nl:pp:open prevê512bytes por linha/afiliado. Os registros
de custo/dados passam; não certifica a fatura nem a margem global. A linha
s fica nos mesmos registros já removidos com a loja. Não houve provedor real.

Acessibilidade: mensagem pending na região existente de erro e email de
texto simples; não há controle ou mudança de foco novo,0→0 passos/decisões.
Sem navegador, leitor de tela, humano ou conformidade global certificados.

Ambiente: Node24.18.0, Next instalado16.4.2 versus package.json16.4.5; sem
build exato ao lock. Testes seriais com rede real http/socket negada antes
dos imports,512MiB/120s/256KiB por arquivo. Redis em memória e fetch simulado,
sem PayPal/Stripe reais, Redis nativo ou tipos/lint globais.

CI consultado pelo SHA: nove runs pull_request, nove jobs All checks distintos,
todos completed/success. Recibo exato da consulta e run ids em ci-receipt.json.
Main local f6ef221443876025eb6286940d687bf97799dd8e compõe sem conflito via
git merge-tree; árvore3e1657eba34ceb5a8e3f9c7806e011ce259ecd1e. Não executei
testes nessa união virtual. Não confundir fila futura com incorporação ou
publicação. Próximo responsável após o pedido: coordenador/vigia da fila.
