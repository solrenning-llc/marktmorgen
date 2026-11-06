# A4 — prova do stop público do Outreach

Base congelada: `2bfa8ade8f59555b8d57aa03e554a99092a1285b`. Evidência somente: ramo próprio `codex/j-a4-read-evidence`. RED permanente: `9719483be975a1bf4cfc1d8c57d17f3e4c90cc63`.

**MÉDIO de veracidade pública, confirmado nesta base:** um pedido de stop cuja escrita não foi aplicada e cuja resposta é desconhecida recebe sucesso no endpoint anônimo; a página afirma que a loja não pode mais preparar um e-mail; uma nova chamada ao escritor real prepara outro rascunho e consulta o modelo sintético novamente.

A unidade focal já havia sido anunciada por J antes desta prova. Claude 4 reservou depois `lib/outreach.ts` em `claude4/r24-outreach-clicks`; esta entrega é evidência para a coordenação, sem correção de produto e sem parecer sobre eventual head novo desse ramo.

## Cadeia causal

- `lib/outreach.ts:483–495`: stopFromLink lê o token/pitch, envia SADD e eventual HSET, ignora a resposta do pipeline e retorna true.
- `app/api/outreach/stop/route.ts:33–41`: POST transforma esse true em redirect HTTP 303 com `?done=1`.
- `app/outreach/stop/[token]/page.tsx:44–55`: `query.done === "1"` basta para afirmar que o criador não pode escrever novamente, mesmo com readStopLink confirmando stopped=false e everyone=false.
- `lib/outreach.ts:237–386`: startPitch consulta os stops reais. Sem escrita aplicada, prossegue e substitui o rascunho anterior por outro, depois de uma nova consulta sintética ao modelo.

Não é só divergência visual: a mesma sequência passa do endpoint anônimo para a renderização SSR real e chega a um segundo rascunho pelo escritor real.

## Prova preservada

Arquivo: `tests/j-a4-outreach-stop.proof.ts`; execução: `TMPDIR=/dev/shm node scripts/j-a4-outreach-stop.mjs`.

Quatro cenários, sete asserções cada: **28 verificações, seis falhas esperadas**. Asserções preservadas desde o commit RED acima.

Cada cenário cria uma loja por claimHandle/ensureStatsId/setSubscription com paidPeriod real; saveSender e startPitch reais criam o primeiro rascunho e seu token. O POST público recebe Request/FormData real, sem autenticação. A página real é renderizada com react-dom/server. Em seguida, startPitch real tenta preparar outro rascunho para a mesma empresa.

A única injeção nos cenários desconhecidos intercepta exatamente o pipeline que contém SADD da lista de stop e devolve `[]`, sem executar o pipeline. Todas as demais leituras/escritas seguem no MemoryRedis real. Nos controles saudáveis, o mesmo interceptor apenas observa e executa o pipeline real, conferindo recibos exatos de SADD.

| Cenário | Recibos SADD | readStopLink | POST | SSR afirma stop | Nova tentativa |
| --- | --- | --- | --- | --- | --- |
| Somente loja, saudável | `[1]` | stopped=true, everyone=false | 303, done=1 | Sim, coerente | stopped; zero novas chamadas ao modelo |
| Todas as lojas, saudável | `[1,1]` | stopped=true, everyone=true | 303, done=1 | Sim, coerente | stopped; zero novas chamadas ao modelo |
| Somente loja, resposta desconhecida sem aplicação | `[]`, uma injeção | stopped=false, everyone=false | 303, done=1 | Sim, falso | novo draft; uma nova chamada ao modelo |
| Todas as lojas, resposta desconhecida sem aplicação | `[]`, uma injeção | stopped=false, everyone=false | 303, done=1 | Sim, falso | novo draft; uma nova chamada ao modelo |

Em cada cenário desconhecido falham três proteções: endpoint não pode anunciar sucesso desconhecido; SSR não pode afirmar stop não salvo; quando a URL anuncia sucesso, o próximo escritor não pode criar draft nem consultar o modelo. Os controles de estado false e de injeção única passam: não exigimos que uma escrita deliberadamente não aplicada apareça como salva. Uma resposta honesta 303/done=0 ou HTTP 503 é aceita pela prova; nessa condição ela não exige que um stop ausente impeça um novo draft.

## Verificações

- Ligados existentes: outreach.test.ts **145/145**; sg2-l1-outreach.test.ts **42/42**; sg2-l1-outreach-snapshot.test.ts **13/13**. Total **200/200**.
- TypeScript strict/noEmit/incremental false, tsconfig herdado do projeto, incluindo prova e fontes reais do escritor, endpoint e página, com imports reais sem aliases de teste: zero diagnósticos.
- ESLint da prova e runner: zero erros e zero avisos.
- Scanner scripts/check_public_data.py: **4104 arquivos tracked, zero ocorrências**; findings aplicado explicitamente aos **três arquivos próprios, zero ocorrências**.
- git diff --check da base: aprovado; diff --no-index --check de cada arquivo próprio: zero diagnósticos de whitespace (exit 1 de arquivo novo com diferenças, esperado pelo modo no-index).

O runner usa testAliases/testEnvironment canônicos, como os testes existentes. A página da empresa é substituída por um PageReader sintético; fetch responde localmente apenas ao transporte Anthropic sintético, e a prova verifica zero tentativas de outros hosts. O domínio `brand.example.com` é reservado e sintético: o primeiro ensaio com `brand.example` foi recusado pelo checkUrl real antes de alcançar a hipótese; o fixture também passou a fornecer as notas exigidas pelo escritor real. Nenhuma asserção foi afrouxada nessas correções de entrada, feitas antes do RED durável.

## Limites

Somente a base congelada foi exercitada. Não certifica o estado atual de ramos alheios. Não houve navegador real, Redis nativo, modelo/fornecedor real, publicação ou envio de e-mail. Outreach prepara rascunhos para envio manual; esta prova não demonstra contato produtivo ou violação real de privacidade. O caso global foi exercitado pelo pedido global, pelo recibo das duas listas e pelo leitor real; o segundo escritor usa a mesma loja, sem afirmar um ensaio independente de outra loja.

Nenhuma alteração em produto, helpers corretivos, fonte/CI/ref do autor, preços, limites, comissão, flags ou travas. Somente os três novos paths próprios deste ramo foram produzidos.
