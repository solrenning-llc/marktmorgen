# Revisão estática incompleta #2934 — physical-legal

Head nominal: **3dc42b26dfd191b6d727c2ab6f916c668d8ca8fa**. Claim e reserva do root: PR6696750125/canal3f32f155821747776a65c015ff497558650962c8, anteriores à leitura. O ramo próprio foi confirmado ausente por API404.

**Estado: revisão NÃO concluída; nenhum parecer de aprovação e nenhum GRAVE/MÉDIO classificado.** O executor deixou de criar qualquer processo. Os candidatos abaixo são leitura de fonte, não resultados de testes. Esta unidade não oferece certificação jurídica nem aprova ativar bloqueios de países, novos termos, política ou gates.

## O que foi efetivamente lido

Diff completo dos três paths, obtido pela API no head nominal: docs/sz2-physical-legal-fields.md (249 linhas), lib/physical-legal.ts (320), tests/sz2-physical-legal.test.ts (143). Também foram lidos os imports diretos de constantes em lib/shipping.ts e lib/store-sale.ts.

O diff acrescenta design, helper e teste; não altera shipping/checkout/UI, armazenamento ou outro chamador produtivo. A busca GitHub no default branch por physical-legal não retornou resultados; isso **não substitui** um inventário de imports no head nominal. O levantamento local completo não pôde ser concluído.

O design marca S1–S8 como não lidas pelo autor, descreve o módulo como inerte e deixa integração, leitura jurídica e duas revisões quando houver bloqueio de países para unidades posteriores. Nenhuma dessas etapas futuras foi executada nesta revisão.

## Bloqueio do ambiente — não é RED do produto

Depois do fetch/checkout e primeira leitura, exec_command passou a falhar na criação do processo com:

`exec-server rejected request (-32603): No such file or directory (os error 2)`

Uma confirmação no mesmo executor, com /bin/bash e login=false, falhou antes de executar qualquer comando. O root confirmou a falha global e determinou parar tentativas. Não houve nova tentativa, outro shell/provedor/sandbox, execução do helper no V8 de orquestração ou CI de substituição.

**Não foram executados:** permanente64 no RED/final, matriz independente, TypeScript, lint, scanner, diff-check executável ou controle negativo de rede de um filho2934. Nenhum arquivo de teste ou runner2934 foi criado: não há prova executável que esta nota possa apresentar como RED/GREEN.

Os arquivos antigos2915/2844 e seus logs/refs não foram apagados nem reescritos. Os commits publicados dessas unidades continuam separados desta revisão.

## Permanente do autor — fatos verificáveis sem execução

O teste no head nominal tem blob **fbcbc0313c0abc5d8d1155fc995144e75d001b17**. A API retornou o mesmo blob no RED **470b599e70c425a9ee8587c5d7f68680c277e8f9**, cujo SHA completo foi resolvido por metadados do commit. Nesse RED, a API retornou404 para lib/physical-legal.ts; o teste usa import estático desse módulo.

Logo, ainda é necessário obter/executar o comando e o log inteiro do RED. Não transformo a ausência do módulo ou a declaração do autor em “64 asserts falharam”, e não confirmo os “64 verdes” sem execução. O SHA completo foi obtido pela API, mas a execução do arquivo inteiro nesse commit permanece pendente.

## Candidatos técnicos para teste e esclarecimento factual

Sem grau, sem conclusão de runtime e sem atribuir descumprimento de lei:

1. **Instante aplicado versus normalização monotônica.** recordPrice documenta preço aplicado a partir de now, mas uma mudança no mesmo segundo da última é gravada em last.at+1. Pela leitura, duas chamadas com preços1000 e800 em T produzem uma segunda etapa em T+1; uma consulta de priorLowestPrice com start=T+1 excluiria essa segunda etapa. É preciso esclarecer se now representa o instante efetivo ou um relógio lógico monotônico, e qual referência o contrato pretende nesse caso. Nenhum retorno foi observado executando o helper.
2. **Etapa inválida apagada da evidência.** steps filtra silenciosamente preços/instantes inválidos antes de priorLowestPrice. Pela leitura, uma etapa com NaN no intervalo poderia desaparecer e a etapa anterior continuar fornecendo cents conhecido e complete=true. É preciso esclarecer o contrato de histórico desconhecido: desconhecido/null, incompleto, ou sanitização intencional. Não foi criada uma asserção arquitetural impondo resposta sem esse esclarecimento.
3. **Limites aritméticos a cobrir.** Quando last.at já é o maior inteiro seguro, last.at+1 pode deixar de ser seguro. Esse caso e os limites de arredondamento/unidade, janela/pruning/cap e ausência de relógio ambiente permanecem pendentes de execução.

Sugestões de esclarecimento ao autor foram encaminhadas somente ao root, que controla contato e formal. Nenhum produto, campo, preço ou política foi modificado.

## Acesso a fontes primárias públicas — 6 de novembro de2026

Foi tentado somente acesso público a fontes oficiais, sem conta, aceite ou contato. Não houve blog ou fonte secundária substituindo texto indisponível. “Não lida” continua sendo lacuna de evidência, não prova de incidência nem de inexistência de obrigação.

| Fonte | Acesso nesta revisão | Limite |
| --- | --- | --- |
| S1 GPSR, EUR-Lex, https://eur-lex.europa.eu/eli/reg/2023/988/oj | Página de verificação JavaScript/robô | Texto legal NÃO LIDO |
| S2 apresentação Safety Gate, URL do design | Redirecionou para sorry.ec.europa.eu / indisponível | Documento NÃO LIDO |
| S3 Diretiva98/6/EC, https://eur-lex.europa.eu/eli/dir/1998/6/oj | Página de verificação JavaScript/robô | Texto legal NÃO LIDO |
| S4 Notice2021/C526/02 | URL fornecida é índice genérico do Official Journal | Aviso específico NÃO LIDO; CELEX continua pendente |
| S5 C-330/23, URL CURIA do design | Redirecionamento não acessível pelo leitor | Acórdão NÃO LIDO |
| S6 https://oehha.ca.gov/media/downloads/crnr/finalregtext112624approval.pdf | PDF oficial retornou texto extraído, com alterações assinaladas/redline | Acesso técnico parcial; não validação de vigência, enquadramento ou cumprimento |
| S7 HSC25249.11, URL leginfo do design | HTTP403 | Texto NÃO LIDO |
| S8 NIST Handbook130, URL do design | DisabledError do leitor | Documento NÃO LIDO |

O acesso ao PDF S6 não fecha a conferência integral de S1–S8 e não equivale a aprovar warning, safe harbor, desenho de página, incidência ou conformidade. Não concluo que o helper imponha ou cumpra uma obrigação jurídica. As hipóteses do design e as decisões futuras de GPSR/EEA/Irlanda do Norte, marketplaces, exceções nacionais e US unit pricing continuam pendentes.

## Continuação necessária

No mesmo executor recuperado e com controles de rede fail-hard antes de carregar o grafo: confirmar head nominal, preservar o permanente inteiro RED/final, executar matriz independente adequada ao contrato esclarecido e conferir os tipos reais ES2017, lint, scanner, diff e discovery. Só depois podem existir graus funcionais e parecer completo. Não houve tentativa de contornar o bloqueio para obter resultados.


## Executed technical continuation — exact 3dc42b26dfd191b6d727c2ab6f916c668d8ca8fa

This English addendum supersedes the earlier unexecuted status only. C4-3080/3090 apply: root-only serial, Medium effort, requested review only; no push/PR/main integration/merge/CI change. All earlier report text and refs remain preserved.

**NOT CLEAN: one MEDIUM technical finding and two conditional LOW input-validation findings.** This pure module remains unwired; no real price, checkout, shipping gate or customer data changed. No legal-compliance approval is given.

1. **MEDIUM — same-second price changes can overstate the prior lowest price.** recordPrice appends every changed value at max(now,last.at+1). With a known1000-cent price from40days earlier, legitimate changes500 then20 within secondT, and sale10 atT+1, it invents timestampsT,T+1,T+2. priorLowestPrice(history,T+1) then certifies500/complete:true, while20 really applied before that sale. The new proof observes exactly that output, against expected20. The healthy sequential history control passes. This contradicts the stated conservative/never-higher property without needing a clock rollback, legal interpretation or productive price change. Preserve the applied-time/order semantics without manufacturing a future timestamp; resolve same-time sequencing before integration.
2. **Conditional LOW — malformed history can become a complete known reference.** steps filters an unreadable cents:"20" entry, leaving an old1000-cent entry; priorLowestPrice returns a complete known amount. This is a deliberately malformed typed boundary; no existing reader is claimed to produce it. A future decoder must either reject the whole unknown history or enforce a validated-only contract; it must not silently certify completeness from a filtered subset.
3. **Conditional LOW — the warning shape accepts a suffix hostname.** checkProp65 accepts www.P65Warnings.ca.gov.example.invalid as naming the P65Warnings site. The healthy exact-site text passes. This is a text-shape weakness, not an SSRF/open redirect: nothing fetches/parses that text as a navigation URL here. CodeQL's generic URL-security description is therefore not adopted. The exact standalone site token/boundary contract should be clarified before rendering; no legal sufficiency, chemical requirement or statutory warning text is certified.

Actual evidence: author64/64; linked shipping182+store-sale20=202PASS;266ordinaryPASS overall. Independent4tests:1healthy controlPASS/3causalFAIL, separate from ordinary GREEN. No assertion was weakened. The exact original RED470b599e70c425a9ee8587c5d7f68680c277e8f9 had been resolved as new-module absent in the earlier report; this continuation did not replay it or call that64 assertion failures.

Actual ES2017 strict types/transitive imports and scoped lint/syntax pass. Canonical aliases/testEnvironment are retained. Global fetch, socket and TLS controls run before every graph, with a transport negative control. All data is synthetic; zero network/provider/account/payment. Four additional cases,120s/process and256KiB capture, no global suite, browser or hosted CI. Types do not raise the target or suppress diagnostics. Author source/ref/CI remain read-only.

Legal source verification remains explicitly INCOMPLETE. Several primary texts were blocked in the author's study and previous review; this bounded technical continuation did not conduct a new legal research project. The observations above concern code invariants and declared shape contracts only. No law, gate, commercial term, price or visible limit change is authorized.

Correct the same PR locally, add permanent regressions, and request a focused return on a new exact head after literal MAIN VERDE permits one consolidated push. Nine final successful checks, applicable independent opinions and fresh clean state remain necessary. New evidence remains LOCAL/not remotely fetchable during freeze.
