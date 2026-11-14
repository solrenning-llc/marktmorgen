# GD1(c): fontes para provas de contestação

Conferência em **10/11/2026**, parcial e documental. Sem envio de provas, coleta nova, conta, aceite, pagamento ou contato externo. Não conclui GD1(c) nem oferece botão novo ao cliente.

## Fontes oficiais lidas

- [Atualizar uma contestação](https://docs.stripe.com/api/disputes/update), incluindo a versão Markdown com `?query=` para expandir os campos. A tentativa pelo leitor web não abriu a expansão; o mesmo endereço oficial em Markdown foi lido diretamente. Página sem data editorial informada. Não alteramos a versão da API do projeto.
- [Responder pela API](https://docs.stripe.com/disputes/api), [boas práticas de provas](https://docs.stripe.com/disputes/best-practices) e [responder a contestações](https://docs.stripe.com/disputes/responding), lidas na mesma data, sem data editorial informada.
- [Chamadas para contas conectadas](https://docs.stripe.com/connect/authentication), lida na mesma data. Documentação geral não prova autorização efetiva da plataforma para uma conta Standard específica.

## Campos e operação

Segundo a referência de atualização, os nomes abaixo pertencem a `evidence`. Esta correspondência é proposta de engenharia; não prova que o Marktmorgen tenha cada registro histórico:

| Registro existente a conferir | Destino candidato |
| --- | --- |
| Descrição comprada | `product_description` |
| Recibo | `receipt` — arquivo |
| Acessos registrados | `access_activity_log` — texto |
| Prestação do serviço | `service_date`; `service_documentation` — arquivo |
| Política e como foi apresentada | `refund_policy` — arquivo; `refund_policy_disclosure` — texto |
| Comunicação relevante | `customer_communication` — arquivo |
| Contexto sem campo próprio | `uncategorized_text` |

A API de atualização informa limite combinado de 150.000 caracteres; campos como `access_activity_log`, `product_description` e `refund_policy_disclosure` também têm teto individual de 20.000. `submit=false` prepara provas; `submit=true` as envia ao banco e é o padrão quando omitido. Não inferir envio seguro da presença de `has_evidence`. Fonte: referência de atualização acima.

O guia da API distingue campos de texto de campos que recebem identificador de arquivo, com upload de propósito `dispute_evidence`. Um pagamento pode ter várias contestações: responder pelo identificador de cada contestação, sem assumir relação um a um. Fonte: guia da API acima.

As boas práticas pedem informação legível, relevante e organizada; não substituem provas por links externos. O erro `dispute_evidence_page_limit_exceeded` pode ocorrer preparando ou enviando provas. Não há teto universal de páginas estabelecido por este estudo: conferir o limite aplicável e não cortar o conteúdo silenciosamente. Fonte: boas práticas acima.

O prazo deve vir da contestação real; uma janela típica do guia de resposta não é prazo fixo para o código. A decisão final cabe ao banco, sem garantia de vitória. Fonte: guia de resposta acima.

Chamadas de servidor para contas conectadas usam `Stripe-Account`. A integração futura deve provar também a permissão, a conta, a loja, a contestação e o pedido correspondentes, antes de mostrar ou enviar qualquer dado. Fonte do mecanismo: autenticação Connect acima; as exigências de isolamento são aplicação de engenharia do repositório.

## Histórico, privacidade e próximo recorte

Em `lib/dispute-purchase-review.ts`, a leitura existente é explicitamente privada e somente de leitura; retorna `submitted: false` e avisa que termos, política aceita e provas históricas de entrega ainda não foram carregados. Esse aviso deve permanecer até a implementação provar o contrário. Metadata atual não prova aceite da política vigente na compra.

O consentimento do item 91, a versão/hora da política, os downloads, aulas e e-mails exigem prova histórica própria. Evento de acesso não prova consumo integral; e-mail preparado não prova envio. Campo ausente fica desconhecido, nunca vira declaração de entrega ou de consentimento. Nenhum IP, assinatura ou outro dado pessoal novo é autorizado para completar campos opcionais da API. Manter exclusão/exportação, retenção e isolamento entre lojas.

Antes de implementar: revisão pelo criador do conteúdo exato; preparação separada do envio; prazo e resposta do provedor validados; submissão de resultado desconhecido reconciliada antes de repetir; testes de conta errada, histórico ausente, prazo desconhecido e perda de confirmação. Nenhuma dessas proteções novas é afirmada como implementada aqui.

Leituras, arquivos, armazenamento, reserva e submissão exigem custeio e teto anterior ao gasto; custo desconhecido nunca é zero. Este documento não calcula margem nem base mínima; CI e tempo da empresa pertencem integralmente a FX275. Próximo responsável: CX3 confere as fontes históricas disponíveis e o custeio em recorte próprio, sem tomar arquivos reservados.

Acessibilidade: títulos e tabela textual; nenhuma tela, passo ou decisão do cliente muda (0→0). Sem prova humana, navegador ou conformidade AAA. O teste verifica presença das fronteiras documentadas, não a correção jurídica, o envio real ou a autorização de uma conta.
