# 335 [FR1](a) — Fontes e registros para 5472/1120 pro forma

Conferido em 10/11/2026. Preparo documental parcial; não produz nem transmite uma declaração, não estabelece imposto devido e não encerra o item 335.

| Fronteira | Estado |
| --- | --- |
| Dados reais da LLC: não lidos | Nenhuma conta, extrato, identificador fiscal ou documento pessoal foi acessado |
| Prazo concreto: pendente | Faltam confirmação do período fiscal, formação, eleição e eventual prorrogação |
| Coletor anual e geração dos formulários | Não implementados por esta unidade |
| Valores, custeio e incidência | Desconhecidos; não substituir por zero |

## Fontes oficiais conferidas

**F1 — Classificação.** A página do IRS sobre [single-member LLCs](https://www.irs.gov/businesses/small-businesses-self-employed/single-member-limited-liability-companies), tópicos de classificação e titular, distingue a regra padrão de transparência fiscal da eleição de tratamento como corporação. Essa orientação geral não comprova a classificação efetivamente adotada pela LLC do dono nem resolve todas as obrigações de um titular não residente.

**F2 — Instruções específicas.** As [instruções do Form 5472, revisão 12/2024](https://www.irs.gov/instructions/i5472), lidas em 10/11/2026, relacionam:

- “Definitions”, “Who Must File” e exceção 1: a entidade americana desconsiderada integralmente detida por estrangeiro recebe tratamento separado para o §6038A; a obrigação depende de transações reportáveis. A exceção exige ausência das operações pertinentes nas partes IV, V e VI, não apenas ausência de vendas.
- “Part V”: operações não incluídas na parte IV abrangem formação, dissolução, aquisição/disposição, aportes e distribuições; há demonstrativo anexo.
- “When and Where To File”: quando exigido, o 5472 acompanha o 1120 pro forma; neste, são pedidos nome/endereço, itens B e E e a identificação “Foreign-owned U.S. DE”. O período acompanha o do titular para fins americanos ou, na ausência dele, o ano civil.
- “Extension of time to file” e “Electronic Filing”: o prazo segue o do 1120, com prorrogação condicionada ao 7004 tempestivo; o tratamento descrito para essa entidade não permite envio eletrônico do 5472.

**F3 — Revisão corrente.** A página [About Form 5472](https://www.irs.gov/forms-pubs/about-form-5472) aponta para essas instruções e não apresentava desenvolvimento recente listado na leitura. A versão deve ser reconferida no ano efetivo da declaração. Não foi feita nesta unidade revisão integral dos regulamentos citados pelas instruções; sua leitura continua necessária antes de implementar o enquadramento e o preenchimento finais.

## Diferença entre o código existente e os registros necessários

Conferência estática no main `f6ef221443876025eb6286940d687bf97799dd8e`:

| Fonte existente | O que realmente contém | O que não prova para FR1(a) |
| --- | --- | --- |
| [lib/tax-summary.ts](../lib/tax-summary.ts) | Resumo dos tributos das vendas na conta do criador | Movimentações entre a LLC e seu titular; receitas da própria LLC |
| [lib/company-owner-report.ts](../lib/company-owner-report.ts) | Apresentação privada de snapshots mensais operacionais, com seções explícitas e desconhecido preservado | Escrituração anual, documentos das transações ou dados para preencher o 5472 |
| [lib/llc-fixed-costs.ts](../lib/llc-fixed-costs.ts) | Categorias de revisão de custo, inclusive `us-form-5472` e `us-pro-forma-1120` | Despesas efetivamente pagas, obrigação confirmada, extrato ou formulário preparado |

A ausência de coletor no repositório não significa ausência de transações na LLC. Tampouco um relatório de vendas dos criadores pode ser usado como extrato do patrimônio ou dos aportes do dono.

## Proposta técnica para a próxima unidade

Isto é um desenho de rastreabilidade, não uma lista de campos legais já homologada:

1. Confirmar o período e a classificação com evidência específica; falta de documento mantém o enquadramento pendente.
2. Vincular cada operação a uma fonte identificável, data, contraparte relacionada, natureza, sentido do movimento, moeda original e documento de suporte. Eventual conversão precisa de regra e fonte próprias; nenhuma taxa de câmbio é criada aqui.
3. Manter aportes, distribuições, empréstimos, serviços e demais naturezas separados até sua classificação ser validada. O mesmo registro não entra duas vezes; um total sem operações rastreáveis não fecha a evidência.
4. Diferenciar fonte completa, fonte parcial, fonte ilegível e inexistência comprovada de operação. Uma página vazia, um erro ou uma lista parcial nunca geram declaração “sem transações”.
5. Só depois definir armazenamento privado, acesso, exclusão/retenção legal, limites e custo do coletor e dos avisos. A revisão do dono e o envio por ele permanecem etapas distintas; não criar submissão automática.

## Dependências e limite operacional

Dependem de fatos/documentos do dono: constituição e classificação da entidade, período fiscal efetivo, operações relacionadas e eventual prorrogação já obtida. Não pedir credenciais ou copiar dados pessoais para o repositório. O prazo exato e os campos finais precisam também da conferência normativa restante; não são resolvidos somente pela entrega de um documento pelo dono.

Sem consulta tributária preparada ou enviada, registro, aceite, pagamento ou contato externo. Nenhum parâmetro tributário, preço, limite, comissão, flag ou trava foi alterado. Não há nova leitura/escrita de produção, chave, fornecedor, e-mail ou retenção por este texto. Custo de implementação, trabalho e CI continua desconhecido, nunca zero.

Benefício: impedir que um número agregado de vendas ou uma categoria de custo vire uma declaração fiscal aparentemente completa. Acessibilidade: nenhuma interface alterada, passos e decisões 0→0; sem teste humano ou certificação AAA. Os testes documentais guardam essas fronteiras, não certificam interpretação jurídica ou correção de uma declaração real.
