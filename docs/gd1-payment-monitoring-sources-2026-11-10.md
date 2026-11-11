# GD1(b): métricas de monitoramento de pagamentos

Conferência documental em **10/11/2026**. Estudo parcial; não certifica limites contratuais aplicáveis a uma conta nem conclui GD1(b). Nenhuma pausa ou liberação foi implementada. Sem conta, aceite, pagamento ou integração; sem contato externo.

## Fontes do prestador

Leitura de [Stripe, Dispute and fraud card monitoring programs](https://docs.stripe.com/disputes/monitoring-programs), seções de calendário, discrepâncias, VAMP e ECP, em 10/11/2026; página sem data de revisão declarada no conteúdo lido. A própria página se apresenta como guia geral, não referência completa das bandeiras.

| Programa | Recorte publicado pelo Stripe, não parâmetro liberado |
| --- | --- |
| Visa VAMP, excessivo | Contagem TC15 + TC40; uma transação presente nos dois relatórios pode contar duas vezes. Fora de CEMEA: 1.500 eventos e 1,5%; CEMEA: 150, 2,2% e US$ 75.000. A tabela também apresenta categoria não conforme de 5 eventos/0,5%, distinta da excessiva. |
| Mastercard ECP | ECM: 100–299 contestações e 1,5–2,99%; HECM: 300+ e 3%. Numerador do mês corrente, pagamentos capturados do mês anterior. Não implementar um teto único sem resolver o enquadramento. |

O calendário é mensal; Visa usa pagamentos do mesmo mês. A data de recebimento do evento difere da compra. Há disputas ocultas que entram no monitoramento embora ausentes do Dashboard/API. Ganhar uma contestação não a remove da contagem. EFM é programa separado. Fonte: página Stripe acima.

## Divergências que impedem copiar números para o código

A [FAQ oficial do Stripe](https://support.stripe.com/questions/monitoring-program-faq), lida em 10/11/2026 e também sem data de revisão declarada, diz `exceeds` nos critérios VAMP; a tabela do guia não resolve sozinha igualdade versus ultrapassagem. A FAQ data a redução para 1,5% em 01/04/2026, preservando 2,2% em CEMEA. Descreve exclusões para resolução prévia/Compelling Evidence 3.0 e agregação por descritor/adquirente. Isso não prova quais eventos a conta Standard conectada disponibiliza ao Marktmorgen. Não presumir deduplicação de TC15/TC40, exclusão de reembolso ou acesso a dados completos.

Há outra divergência pendente: a FAQ, na seção sobre cálculo do ECP da Mastercard, indica pelo menos 100 contestações e taxa de 1%; o guia, na seção ECM, apresenta 100–299 e 1,5–2,99% (início em 1,5%). As duas fontes foram relidas em 10/11/2026. A divergência exige conferência nas regras vigentes da própria Mastercard e do enquadramento da conta; não escolhemos uma taxa, não tratamos ECP e ECM como categorias idênticas e nenhum desses números está liberado para o código.

Faltam fontes das próprias bandeiras conferidas integralmente e vigentes, inclusive condições regionais/adquirente e fronteiras exatas. Referências a PDFs e trechos de busca não foram tratados como leitura integral. Não houve contato com Stripe, Visa ou Mastercard.

## Aplicação futura e custo

Inferência de engenharia: taxas por data da compra em **30/90 dias** podem informar o painel, mas não substituem as métricas mensais acima. Antes de automatizar, provar cobertura/paginação, conta/descritor, calendário, numerador, denominador, exclusões e limiares. Resposta ausente ou parcial permanece desconhecida; não pausa nem libera às cegas. Testar igualdade, meses diferentes, denominador desconhecido e eventos ocultos.

Estudo sem IO produtivo novo. Leituras, cache, e-mails e reservas de uma implementação continuam sujeitos a teto anterior ao gasto; custo desconhecido nunca é zero. Tempo de CI/empresa pertence a FX275 e não foi convertido em custo zero. Próximo responsável: CX3 pela conferência das fontes e cobertura, seguido de implementação com custeio; nenhuma consulta tributária ou ação do dono é criada aqui.
