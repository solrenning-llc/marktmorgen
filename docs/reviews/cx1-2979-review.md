# Codex CX1 — revisão financeira independente de #2979

Head: `3add2bdc4f53da7c0f748a041b3acba44985efa4`.
Base comparada: `1c2bd01e22064c9fe46bcd3d49ba269e0098079b`.

**Pedir mudança: um MÉDIO herdado, sem atribuí-lo à regressão do diff.**

`lib/member-discount.ts:183-184` descarta o retorno de `onAccount(POST)` e
retorna `{ok:true}` apenas pelo transporte ter respondido 200. O transporte
devolve o JSON sem conferir o objeto. Com `{}`, `[]`, `null` ou o ID de outra
assinatura, o helper continua dizendo sucesso; a rota confirma `{ok:true}`
e o componente mostra “Discount put on the membership” e marca a assinatura
como descontada. Não existe prova de que o desconto escolhido foi aplicado.
Pela regra 24, um recibo desconhecido deve permanecer desconhecido, sem dizer
que nada mudou nem repetir automaticamente uma operação de resultado incerto.
Conferir identidade e evidência da alteração da assinatura antes do sucesso.

Prova executável: `tests/cx1-2979-discount-write.proof.ts`.
No head: 11 checks, 4 falhas, uma por recibo desconhecido; controles de recibo
saudável e desconto desconhecido antes do POST passam. No mesmo grafo, com
somente member-discount.ts do RED `423e84d39bb28edf48b782f2caa21273abe1c03f`:
11 checks, 6 falhas. As mesmas quatro falhas de recibo permanecem; as outras
duas são o desconhecido anterior à escrita que este PR conserta.
Portanto o problema de confirmação já existia no código anterior.

Li o diff inteiro dos dez arquivos e os leitores, escritor, rotas e componente.
O diff de leitura fecha os vetores originais. Mesma suíte do autor no head:
58/58; no grafo final com os quatro módulos anteriores substituídos pelo RED:
58 checks, 52 falhas. É uma reprodução por substituição dos módulos, não a
execução da árvore histórica inteira. Ligados: member-discount 14/14,
member-free-days 42/42, member-free-days-paid 32/32 e email-field-keyboards 4/4.
Total final: 150 checks permanentes passando, com sobreposição de cenários.

Preservados os dois LEVES de Claude 2/6759030511: limite de clientes descrito
como resposta ilegível e POST com erro de transporte descrito como nada mudou.
Não reclassifiquei esses vetores como achados novos. O MÉDIO acima é recibo
200 inválido confirmado como sucesso, não o erro 500 daquele parecer.

Busca do padrão: o outro escritor diretamente ligado, member-free-days.ts,
confere id, trial_end, status e marcas antes do sucesso. Não fiz auditoria
global de todos os escritores de onAccount.

Sem mudança em produto, preço, limite, comissão, flag, gate, conta ou dado real.
As leituras do novo paginador continuam finitas (20 clientes e cinco páginas
de 100 assinaturas por cliente). Não certifiquei o custeio global, a base #2912,
nem o ALTO concorrente já relatado nela por Codex V/6751485510.

Acessibilidade: li a mensagem inline e a retirada do botão quando discounted
é null; passos e decisões saudáveis iguais. Sem navegador, leitor de tela ou
conformidade AAA certificada.

Execução local: Node 24.18.0, esbuild existente. O Next instalado é 16.4.2,
enquanto package.json pede 16.4.5: limitação explícita dos testes ligados.
A prova de retorno do escritor não depende de comportamento do Next.
Somente fetch simulado e Redis em memória; sockets/http reais negados antes
dos imports, 512 MiB de heap, 120 segundos e 256 KiB de saída por arquivo.
Não rodaram Stripe real, Redis nativo, tipos/lint globais ou CI hospedado.
Não conferi os nove agregadores agora e não pedi fila.

Reprodução: `node docs/reviews/cx1-2979/run.mjs <checkout> probe cx1-2979-discount-write.proof.ts`.
Para a substituição anterior, configurar CX1_OLD_REF e CX1_OLD_FILES conforme
o runner; stdout/stderr completos e resumos estão na pasta deste relatório.
