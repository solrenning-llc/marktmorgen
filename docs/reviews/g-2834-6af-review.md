# Revisão Codex G de #2834 — 6af9100ed56795f025d98c6f84c19246a4eecf97

De=Codex G. Pedido M/16h47; anúncio no canal ANTES de diff/testes em a1a5f39c974a7db5f331b13366529a5fa70777a3. C4 única; C1 desligado.

**Hidratação: sem novo achado focal. O PR permanece retido pelo problema de confirmação de salvamento publicado pelo M, agora reproduzido independentemente por G. Grau proposto por G para esse problema herdado: MÉDIO condicional de confirmação/VR.** Não é uma regressão introduzida por este diff.

## Hidratação conferida

Li os2arquivos do diff inteiro e todo o componente atual, além do consumidor components/product-editor.tsx:2588. O laço do editor continua passando o produto atual; nenhuma rota, preço, limite, flag, gate ou operação de provedor muda.

useSyncExternalStore tem assinatura estável, snapshot de servidor false e de cliente true. Os dois botões fechados conservam a ação no nome visível, acrescentam Loading… no SSR, são nativamente disabled e têm aria-disabled=true. Após hidratar, o MESMO botão fica disponível e a marca ARIA é retirada. O handler também confere ready. As perguntas salvas continuam legíveis, e o produto gratuito permanece sem esse editor.

### Provas efetivamente executadas

- RED fd4f37826017ffc4354a4e93490c6f791f8524f1 → head6af: teste original14 **MESMO blob437e4ab8d5c4ff06457b735effe9526c1603d844**, **14/6falhas antes →14/14 depois**. O pai do GREEN é o RED; nenhuma expectativa trocada.
- [Prova G Chromium imutável09c4c20a](https://github.com/solrenning-llc/marktmorgen/blob/09c4c20a543a6d10a8c008c7a69dabe651f8c2c0/tests/g2834-hydration-browser.proof.mjs), SHA256c44c763e93d3e3fa3588bbaf72f9e35fd870909d158fdc9a21dde20d8aa500b5: **MESMOS bytes no RED40checks/8falhas →head40/40**. As8falhas antigas são disponibilidade nativa, ARIA, frase Loading e foco por teclado, nos2ramos pagos. Os demais controles continuam passando.
- SSR real e hydrateRoot React19 em Chromium real, hidratação explicitamente atrasada e StrictMode. A fábrica completa de Product vem, sem reescrever, do arquivo canônico. Exercitei os2ramos pagos e o gratuito, clique nativo/Tab antes de hidratar, identidade do nó, Enter depois de hidratar, edição local, cancelamento sem POST, reabertura descartando somente a edição não salva e refresh de props com outro id/perguntas antes de abrir.
- Nenhum save foi disparado na prova G40; fetch é explicitamente recusado e registrado. Isso **não prova persistência/aceite do backend**. A rede de página só admite a origem local. Browser e servidor são fechados em finally.
- Ligados **32/32**: checkout-phone11 + checkout-faq17 + public-explanations4. Tipos estritos focal2raízes+imports exit0; lint4paths exit0; scanner4077rastreados/0, mais3arquivos próprios/emprestados sem achados; diff-check RED..head exit0. Não certifico browser Next assinado, WebKit, AT/AAA completa, build/CI global ou os9checks hospedados.

## Confirmação do problema do M — retenção do PR preservada

**Autoria/prova: Codex M,948d2c883d4914c9adfdd1058ebccfa436faed9b**, proofs/m/checkout-fields-save-ack.mjs, blob277e640cabca25f36939624e9891ddc7dde54aa4. Recebi a publicação no meio da revisão; NÃO criei outra frente nem outra prova de ACK. Copiei os MESMOS bytes para a cópia G e executei uma vez no componente cujo blob o próprio teste exige:48397330d47572bd875b1dcb716168152b314033.

**components/checkout-fields-editor.tsx:79–86:** o componente ignora response.ok e aceita data.ok truthy. Na prova do M, HTTP200 com {ok:"true"} e HTTP503 com {ok:true} fecham o formulário, fazem refresh1 e exibem “Checkout questions saved.”, quando deveriam manter o formulário/refresh0/toast0. Os4cenários usam o componente real, SSR+React+Chromium e no máximo1POST local de4KiB/resposta128B por cenário, admitidos antes. Resultado G igual ao M: **24checks/6falhas causais/18controles passando**; são2vetores do mesmo problema, não6defeitos. HTTP200 ok:true e a recusa explícita ok:false passam.

**Limite:** o backend está substituído pela resposta HTTP sintética; não alego perda já persistida, pagamento, chamada real de provedor ou que um backend saudável emite esses formatos. O defeito demonstrado é a UI certificar escrita diante de resposta HTTP/JSON que não a confirma, escondendo a edição local. O trecho já existia no RED e não pertence à alteração de readiness. A busca de irmãos forms-editor/page-editor feita pelo M continua só candidata estática; não testei nem atribuí novo defeito a eles.

A correção proposta pelo M — exigir response.ok e ok===true, preservando a prova24 — aguarda recorte/atribuição da C4 no MESMO PR. Este parecer NÃO levanta a retenção registrada em6694065009, nem edita o ramo/CI do autor. Novo head precisa de retorno focal da prova24 e de preservar a hidratação40/14 e os gates aplicáveis.

[Saídas integraisb62630b4](https://github.com/solrenning-llc/marktmorgen/blob/b62630b4a0ffb0183cbab6bf9603471ba1530501/docs/reviews/g-2834-6af-output.txt). [Prova M original](https://github.com/solrenning-llc/marktmorgen/blob/948d2c883d4914c9adfdd1058ebccfa436faed9b/proofs/m/checkout-fields-save-ack.mjs). Nenhuma modificação em produto, reservas, refs ou CI alheios; nenhum merge, conta, contato externo ou pagamento real.
