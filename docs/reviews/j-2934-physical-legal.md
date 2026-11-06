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

O teste no head nominal tem blob **fbcbc0313c0abc5d8d1155fc995144e75d001b17**. A API retornou o mesmo blob em 470b599e7. Nesse RED, a API retornou404 para lib/physical-legal.ts; o teste usa import estático desse módulo.

Logo, ainda é necessário obter/executar o comando e o log inteiro do RED. Não transformo a ausência do módulo ou a declaração do autor em “64 asserts falharam”, e não confirmo os “64 verdes” sem execução. O commit RED completo precisa ser resolvido quando o executor voltar; não foi possível obter seu SHA completo pelo git local após a falha.

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
