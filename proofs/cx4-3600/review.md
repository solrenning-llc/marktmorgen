# Revisão independente CX4 do #3600

Head do autor: 9cb50bbbecbce57d3fd90e890614103af6a6e0bb. Reserva/anúncio anterior à fonte e ao runtime: canal f3f469446bc719711e0833014f9f4f31ff1f4c5e, 10/11/2026 17h56 Fortaleza. Cópia própria no ramo codex/cx4-review-3600; nenhum arquivo, ramo, CI ou configuração do autor foi alterado.

## Veredito: pedir mudança — um LEVE herdado

Os consertos pedidos de contador desconhecido e remoção explícita passam. Não foi demonstrado ALTO/MÉDIO novo nesse recorte. Há um LEVE de validação da entrada no caminho lido: com configuração selada existente, um POST autorizado com url ausente, null,0,false,[] ou{} responde200/{ok:true,result:"removed"} e executa DEL. Um campo inválido não é um pedido explícito para parar.

Prova: own.proof.ts primeiro grava uma configuração válida pelo POST real, confirma que existe, depois envia cada formato inválido. Nos seis casos a configuração some e o POST retorna sucesso. São seis variantes de um único achado, não seis achados. Os quatro controles da mesma prova passam: remoção de espaços continua admitida apesar de limite excedido, remoção sem autorização não toca configuração, contador desconhecido mantém a configuração, URL de fornecedor não permitido mantém a configuração.

Causa: app/api/store/chat-summary/route.ts:28 reconhece remoção apenas de texto vazio, mas o caminho seguinte ainda passa body.url sem validar o tipo a setChatAddress (:40). lib/chat-summary.ts:88 converte qualquer valor não textual em texto vazio e :89–94 executa DEL. O guardStoreWrite real só exige um objeto JSON no nível superior, sem validar o campo url. A coerção já existia; não é regressão introduzida por este delta. Só um usuário autorizado com entrada malformada dispara a prova; não foi demonstrado fluxo normal de navegador ou acesso de outra loja, daí o grau LEVE.

Correção sugerida: na própria rota, depois da autorização e do caminho de sales, exigir que url seja texto antes do contador e antes de chamar o helper; resposta400/invalid para ausente ou não textual, mantendo a configuração, o limite de salvamento e a remoção por texto vazio/espaços. Não precisa editar o helper reservado de outra pessoa, acrescentar I/O ou mudar qualquer teto. Manter as seis expectativas e os quatro controles.

## Fonte e execução

Lido o diff inteiro dos18 arquivos, a rota inteira, helper chat-summary, autorização real, leitura de fornecedor e funções de contador. Os blobs Git dos18 caminhos foram lidos e conferidos por SHA1 do objeto Git; a cópia Windows só normaliza CRLF para essa comparação. subject-hashes.json registra SHA1 e SHA256. Metadados e fontes históricas não foram tomados como execução nova. O log histórico base64 foi decodificado:3.154 bytes e SHA256 d5de209f8523ada6992ab4c1fc821a94591de0ffaf8def895c8b04dbaa203816 conferem; ele preserva o RED intermediário3/3.

- RED original: SOMENTE a rota de012b860aa3635e189d76825a1627d05439088eff no grafo final, com a mesma prova6 do autor:2 PASS / 4 FAIL. Não é checkout antigo inteiro.
- Head: prova autoral6/6, permanente31/31 e request-guard-shape34/34.
- Própria:10 casos,4 PASS / 6 FAIL do achado acima. Total final75 verificações passantes, com sobreposição entre conjuntos, mais6 falhas causais de um LEVE. Não somar o RED ao GREEN.
- Nenhuma asserção ou prazo foi alterado. O teste de configuração Redis ausente é contrato de rota sob guard sintético; o guard real já devolve503 antes. Não é outra falha produtiva demonstrada.
- A autenticação/loja e o transporte Redis são as fronteiras sintéticas declaradas do autor. Rota, contador, helper, selagem e construção do POST são fonte real. A interpretação da autorização real foi conferida por leitura, não por login real.

## Limites e qualidade

Guardas antes dos imports/despachos: rede real negada, destino mock único e método POST,120s/512MiB/256KiB por filho. Limites agregados da revisão20.000 admissões de Redis / 100 HTTP simulados / 100.000 bytes de corpo. Consumo total, incluindo RED,71 verificações autorais e a própria prova:474 admissões de Redis conservadoras,50 HTTP simulados,5.650 bytes,zero conexões de rede. A contagem é conservadora e inclui instrumentação tanto do fixture quanto do MemoryRedis.run; não é cobrança real do Redis. O ledger não foi reiniciado entre os cinco filhos. Nenhum teto foi atingido. Sem subagentes ou fornecedor real.

Node/Next: a dependência solicitada e instalada é Next16.4.5. Isso não certifica build ou comportamento do framework. TypeScript dirigido3 raízes atingiu120s: INCONCLUSIVO, sem repetição ou aumento de prazo. Lint de sete caminhos aprovado; scanner oficial de 21 caminhos sem achados; diff-check aprovado. Recibo em quality.json, com TypeScript explicitamente inconclusivo.

Não executados: navegador, leitor de tela/AT, Redis/Lua nativo, serviço, build completo, CI hospedada, margem global ou fluxo real de conta. Esta revisão não retira HOLD de custeio e não pede fila. O autor age em seguida corrigindo o LEVE e pedindo retorno focal, sem terceira revisão global.

Busca da mesma classe:7 correspondências literais em lib/. autodm-rules e inbox recusam o resultado vazio; chat-kind retorna null; discount-schedule recusa formato. free-course-video-rules:40 (não textual vira0) e shipment-record:24–25 (não textual vira vazio) ficam só como candidatos estáticos de contrato/entrada para o coordenador, não achados reproduzidos nem atribuições de autoria. Nenhum desses arquivos foi editado.

## Acessibilidade

Sem alteração de tela ou texto de produto.0→0passos/decisões; a reprodução é da API. Navegador, pessoas e conformidadeAAA não foram certificados.

## Reprodução

Na cópia do head indicado com dependências exatas: node proofs/cx4-3600/runner.mjs. Foi executado uma única vez nesta revisão; preservar results.json/ledger antes de qualquer focal ou ensaio adicional, sem reiniciar o teto. Os bundles são descartáveis e não são publicados; bundle-hashes.json guarda seus SHA256. Fonte, metadados, logs integrais e resultado estão junto deste relato. O stdout bruto do RED e o diff estão em envelopes JSON/base64 com SHA256, preservando inclusive espaços finais; os outros logs publicados usam LF; artifact-manifest.json registra os hashes brutos e os publicados, sem mudar conteúdo ou oráculo.
