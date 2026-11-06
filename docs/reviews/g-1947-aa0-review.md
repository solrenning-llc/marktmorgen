# Revisão Codex G de #1947 — fechamento dos retornos

**Head EXATO aa0f45907ef439571cf75e55985ab9f6bac47f86: sem novo achado no retorno nominal. MÉDIO5804026916 e LEVE de consistência de IDs FECHADOS.** Não é certificação global do main ou autorização para ignorar os gates do autor.

Claim do102 antes de código: c872c918; na checagem pré-parecer o autor publicou aa0. Preservei o resultado histórico102 ([e8da3ada](https://github.com/solrenning-llc/marktmorgen/blob/e8da3ada7d4556b511120f7a2c5fa7d004554f18/docs/reviews/g-1947-102-review.md)), anunciei aa0 ANTES de ler/testar em a8c25e76fe8b618b29a337136cbe18a242032a06 e rodei a cópia própria exata /tmp/g1947-return-aa0. Não transferi o verde102 por suposição.

## Diff e contrato conferidos

Li TODO7f1..102:4arquivos154+/3-; TODO102..aa0:2arquivos48+/1-. O segundo inclui o novo teste completo35linhas e a classe/guarda de escrita/leitura do helper. O diff de produto anterior foi integralmente lido na mesma cadeia, sem reauditar todos os commits herdados de main. Os quatro documentos de instruções do main ec5f3d5e continuam byte-idênticos aos integralmente lidos.

O caminho de repetição da rota exige produto de6–40caracteres a-z0-9. O helper aceita IDs de1–48 em a-z0-9/hífen. changeLandings, entrada comum de saveLanding e removeLanding, agora lança LandingIdInvalid ANTES de leitura/gravação para ID recusado; leitura/cleanup desses IDs não tocam outra chave. Conferi que os IDs reais de lib/store.ts:2991–3001 e siteKey/SITE_PAGE_ID de site-page-rules.ts:56/176 estão dentro desses domínios. Padrão mais amplo do helper preserva os IDs sintéticos curtos/hifenizados e os site-<id>.

## MESMAS provas, antes/depois

**MÉDIO marcador:** prova congelada2f250bb3, SHA2561fea731c1efd5386bd33f9442623f7c39f2a227413de2e22e2d8bc4e085904f5, BYTE-ID na cópia do autor e no teste descoberto após1linha de crédito.
- 7f1:9checks/4falhas (execução anterior preservada).
- 102 e aa0 REAL: **9/9**; controle sem segundo pedido **9/9** em ambos.
- POST real com id acrescido de ":gone" responde404/unknown, marcador fica1, save antigo já admitido retorna LandingsGone; campanha/slot não revivem.

**LEVE consistência** já observado por R2ciclos120/121: [prova final2a13ba3c](https://github.com/solrenning-llc/marktmorgen/blob/2a13ba3c5ef3c6f43c501a3ac0b5ae91c6341f7e/tests/g1947-id-consistency.proof.ts), SHA256 **c952865edac05e473cb360cbdc8e25f09ec6d65ad503ff92a76bfb956fae6580**, BYTE-ID nos3fontes.
- 7f1: **12/12**.
- 102: **12checks/6falhas**: save aceita bad:child/49letras, dropLandings termina sem apagar, dropPage[] e finish"none" com registro retido/slot224.
- aa0: **12/12**; inválidos agora são recusados na gravação, sem registro/slot, e normal-id continua4/4.
Esse RED é funcional e inalterado; não uso a ausência da exportação LandingIdInvalid no pai como se fosse reprodução causal. O teste novo do autor passa13/13, mas sozinho não compilava no pai. Minha prova não exige uma arquitetura específica: basta recusar a escrita ou não confirmar limpeza/ausência de conteúdo aceito ainda retido.

**Limite do LEVE:** chamadas diretas de funções com IDs que os geradores reais não produzem; não demonstrei criação desses IDs por rota real. Não reclassifico como invasão remota/financeira nem alego legado de produção sob esses nomes. O ponto de uso atual foi fechado sem exigir migração de registros hipotéticos.

**MÉDIO mais antigo de cleanupPending** permanece fechado: prova15763ba2 SHA25655f3e73cffa28ebc76e5aa2a1a6c1a1e8481396ed59f6035ad25a4a0e25b6ca4 BYTE-ID, **8/8 cada em unapplied/healthy/lost** no aa0, executados. Prova originalG2ad5734a5 **5/5**. Créditos G2 e R2 preservados.

As provas usam escritores/sessão/rota real sintéticos para o marcador e funções reais para IDs; nenhum registro/contador/marcador forjado, resposta Redis falsa na prova do marcador, sleep ou avanço de relógio. Os testes de perda de resposta identificam seus próprios modos, não são confundidos com o transporte saudável.

## Verificação do aa0 REAL

**19canônicos =454checks customizados+76testesNode PASS,0falha/skip**, todos19status0; manifesto2e790d20d81ebc3d29ef0214a34f8c6829bc09a7. Inclui as três suítes que falharam no intermediário194a; não repeti nem tratei aquele head como atual. Os12/9/9/24 checks de provas são execuções adicionais sobrepostas aos canônicos quando indicado, não somo como testes únicos.

tsc -p tsconfig.g1947-aa0.json: **20raízes/imports,exit0**; configa95177c30c5731900d7ded30b5a8834301adfc6e. Lint6paths0erros/avisos; diff-check0. A inferência da MINHA prova foi corrigida antes dos runs finais (discriminante literal), sem mudar assertivas/produto. Rastreados da cópia própria limpos; só prova/config/manifesto próprios untracked.

[Saídasab56a05f](https://github.com/solrenning-llc/marktmorgen/blob/ab56a05f02fa45b28d0e90c32e24bc3f8463a84a/docs/reviews/g-1947-aa0-output.txt). A base0861 do ramo remoto de evidências NÃO é o fonte testado; os runs vieram do checkout exato aa0.

Sem Redis/Lua nativo, browser/AT, fornecedor/conta/pagamento real, build/CI completo ou certificação geral de margem. Nenhum produto/preço/limite/flag/trava/reserva/ref ou CI alheio/merge alterado. C4 única/C1OFF. Retorno independente adicional; não substitui cruzado fixo por inferência. Pode seguir aos gates normais de revisão/CI do head aplicável sob controle do autor/coordenação.
