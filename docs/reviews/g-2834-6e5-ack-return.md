# Codex G — retorno nominal #2834 / 6e5f8a0c

**LEVE condicional de confirmação/VR FECHADO; sem novo achado focal.** Head exato `6e5f8a0cac5543c32ff2f942fffa36d9bb4ed916`, pedido M6695147502. Anúncio prévio no canal `2bd6f1e791ccf5a2bbf03b7a127ba31ab4dfd515`. Li o diff inteiro final de três arquivos e o delta desde o head6af já revisado: a única mudança de produto é `response.ok && data.ok === true`, components/checkout-fields-editor.tsx:80. O fonte é blob `c4cc0722623ddc00c451cc611df3988531558225`.

A autoria da prova de ACK continua M948d2c883. O grau vigente continua LEVE retificado em G5806241564; não é o MÉDIO inicialmente proposto em5806188719. Nenhuma perda real de escrita de backend foi demonstrada.

## Reprodução e controles

A prova permanente M é o MESMO blob `b71e98a4e6ed66b8ca2a02b13ee9be8c8b49cece` no RED `b33e4e37d37fc957b1812bb715a4a5ac41bab039` e no head6e5. Confirmei ainda que **todos os bytes desde const cases até o fim (casos, checks, transporte e cleanup) são idênticos à prova M948d original**, blob277e640c. A única parametrização nova é o pin explícito do blob, validado como SHA40 e comparado ao hash real antes de executar.

Executei a MESMA24: **RED24/6falhas/18controles → head24/24**. HTTP200 com ok string e HTTP503 com ok booleano deixam de fechar o formulário, fazer refresh e anunciar sucesso; sucesso conhecido e recusa explícita continuam corretos. Quatro POSTs locais pré-admitidos por execução, corpo até4KiB/resposta até128B; zero pedido externo.

Nova extensão G, derivada do mesmo driver com crédito e sem alterar a prova M: `codex/g-review-2834-return-6e5@254ca15d0ca20734cba6f4a5b483938de8a2e97c`, proofs/g/g2834-ack-edges.mjs, SHA256 `579c60208e3baae2c4a174632c3203ca88f20a41cc4a1caaaa52b41e672ec41c`.
**MESMAS48: RED6falhas/42controles → head48/48**, oito envelopes explícitos: ok ausente, número1, null no ok, JSONnull, lista, JSONfalse, HTTP401 com oktrue e sucesso201 com oktrue. Os dois vetores RED são número truthy e HTTP401 (três asserções cada). Os outros controles passam nos dois snapshots. O status201 é deliberadamente sucesso conhecido, preservado; não exigi status200 quando o contrato é HTTP bem-sucedido. O teste registra no máximo8 POSTs locais antes da execução; mesma cota de corpo/resposta, sem rota real ou provedor.

Comandos na cópia própria de cada snapshot:
```sh
node proofs/m/checkout-fields-save-ack.mjs --expected-blob=48397330d47572bd875b1dcb716168152b314033
node proofs/m/checkout-fields-save-ack.mjs --expected-blob=c4cc0722623ddc00c451cc611df3988531558225
node proofs/g/g2834-ack-edges.mjs --expected-blob=48397330d47572bd875b1dcb716168152b314033
node proofs/g/g2834-ack-edges.mjs --expected-blob=c4cc0722623ddc00c451cc611df3988531558225
```
Os pins483 e c4cc correspondem respectivamente ao RED e ao head; não se roda o pin antigo contra o novo componente.

Repeti no head:
- SSR autor14/14, blob437e4ab8 BYTE-ID com a revisão anterior;
- MESMA prova G40/40 de hidratação real/StrictMode/teclado/DOM preservado/props atuais, SHA256 c44c763e93d3e3fa3588bbaf72f9e35fd870909d158fdc9a21dde20d8aa500b5, fonte original09c4c20a preservada; zero salvamentos nessa prova;
- ligados32/32: checkout-phone11, checkout-faq17 e public-explanations4;
- TypeScript strict dirigido:2raízes/398arquivos/imports/0 diagnósticos; ESLint4caminhos/0; scanner4078rastreados/0; diff-check0.

## Alcance

Componente React/SSR/hidratação e Chromium REAIS, respostas locais sintéticas e finitas. Browser e servidor encerrados nos finally. Não é Next autenticado, backend persistente, Redis nativo, Firefox/WebKit, leitor de tela, AAA global, provedor, pagamento ou produção. A prova M está durável como driver manual; não alego que o npm test a descubra automaticamente. Não atribuo a este retorno nova execução global de client-bundles ou dos nove workflows hospedados.

A condição de confirmação que motivou a retenção M6694065009 está resolvida nos casos demonstrados; não há achado G restante no recorte. Autor mantém a decisão de incorporar somente com os nove agregadores verdes do head final e demais condições aplicáveis. Não alterei produto, reserva, ramo/ref/CI alheio nem fiz merge. Este parecer não substitui o cruzado fixo CX-72.
