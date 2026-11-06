# Revisão Codex G — retorno #2517
Head EXATO69d41c18f35b9ddad84ea0a14cece629f1747cd6; corretivo do pedidoX6653725666. Anúncio canal54e9a932 antes da revisão.
Resultado: o MÉDIO anterior do GET por ID está FECHADO. Há UM MÉDIO herdado adicional, agora comprovado no caminho expandido; NÃO libero o PR inteiro.

## O que foi conferido
Li TODO diff próprio de cinco caminhos contra o main integradoe12cacabea5f870e920c3777df246ee016c0a3e5 (112inserções/1exclusão): lib/membership-access, provaG preservada, evidência17, stubRedis e alias de runner. O corretivo de produção69d41c18 tem exatamente3linhas. bba739cf é merge de e8a231a1 com e12cacabe, mais a prova preservada; os320caminhos herdados desse merge não são320mudanças próprias certificadas por G. O diff próprio acima e os chamadores ligados foram lidos/testados.
Minha prova ORIGINAL395b96a5, blob3bdb1f584e10f34d160be48836a652bea243c4e3, permanece BYTE-IDÊNTICA: anterior imediato bba739cf8verificações/2falhas -> head8/8. Resposta GET semid ou comid diferente agora não autoriza/não grava cache. Controle identidade válida/cache sem segundoGET e canceled/503 preservados. Autor membership-status-evidence17/17 no head. O RED17/10 da construção já está no parecer anterior; não o apresento como rerodado nesta rodada.

## MÉDIO herdado adicional — objeto expandido sem identidade ainda autoriza acesso
lib/membership-access.ts:87; chamador REAL lib/store-checkout.ts:1067–1070.
A primeira linha de membershipStatus retorna memberState para qualquer objeto, antes da validação nova. readOrder pede expand[]=subscription e usa esse retorno para live/ended.
Reprodução com loja e produto de assinatura criados pelos escritores REAIS; GET sintético único do checkout completo/pago entrega subscription={status:"active",pause_collection:null}, semid. readOrder REAL devolve state:"paid", membership:"live". O mesmo com id:null, id:"" ou id:"not-a-subscription". Não há segundo lookup que confira a identidade. As quatro respostas desconhecidas foram serializadas como JSON pelo transporte, sem Proxy/getter/injeção de protótipo.
Controles no MESMO caminho: id válido+active -> live; id válido+past_due -> live (graça preservada); id válido+canceled -> ended. Todos os sete casos fazem exatamenteumGET do checkout e nenhum POST. Produto/conta/e-mail/provedor só sintéticos. Não alego download completo, exploração externa ou entrega real.
Prova FINAL opt-in tests/g-2517-expanded-order.proof.ts, blobb552403766ba5331eb6a0782c1ff50937aaca0b2: MESMO14checks/4falhas no anterior imediato bba739cf e no head69d41c18;10controles verdes. São quatro vetores de UM achado herdado, não regressão introduzida pelas3linhas. A triagem de objeto expandido citada no parecer anterior tornou-se esta prova de chamador real; não era achado comprovado antes.
A confirmação do caminho buscado por ID não pode ser usada como confirmação do expandido: exigir identidade própria válida e forma confirmada antes do live no caminho expandido. Não precisa afrouxar preço/limite/flag nem transformar falha em envio/pagamento. Os outros isLiveSub em learn/community continuam fronteiras para triagem, sem novo achado declarado neles por esta prova.

## Validação e limites
-11arquivos relacionados verdes: nove grupos check/227verificações + registries node:test24+7. Incluem membership-pause22, tiers45, yearly-switch35, yearly-fallback35, leave-flow20, buyer-help8, identidadeG8, cache17, lost-dispute-access37.
-Strict do recorte membership-access/store-checkout/duas provas/evidência e imports:exit0.
-ESLint final0; scanner3715rastreados/0; diffcheck0. Minha prova perdeu apenas um import redis não usado após o primeiro lint(1warning); TODAS as assertivas/cenários ficaram iguais, arquivoFINAL repetido nos dois códigos.
-Nenhum comandoRedis/provedor adicional introduzido pelo corretivo. Não houve Redis nativo, browser/download E2E, buildglobal, hostedCI, mudança comercial ou certificação integral de margem. Não consultei/repeti CI nem toquei produto/reserva/ramo do X/merge.
-Executar runner e copiar a prova opt-in num checkout próprio do head desejado; o ramo de provas conserva os bytes antigos e não é produto corrigido. Runners usam mkdtemp individual e removem o temporário.

X/Claude1: o bloqueio exato do GET foi atendido; peço corrigir/retornar somente este caminho expandido com novo head e preservar os REDs. A política de graça dos controles não mudou. Exigir as revisões/checks aplicáveis do head final antes da condução normal.
