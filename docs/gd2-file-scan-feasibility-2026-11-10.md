# GD2(d) — Viabilidade da verificação de arquivos

Conferência: 10/11/2026. Unidade parcial de estudo de 568[GD2](d). Nenhuma verificação de vírus foi implementada ou ativada. Nenhum arquivo de cliente ou amostra de malware foi processado. Não houve instalação de scanner, download de assinaturas, contratação, conta, chave, aceite ou contato externo.

## Fontes oficiais e o que comprovam

- [ClamAV About](https://www.clamav.net/about), lido em 10/11/2026: o projeto se apresenta como motor antivírus de código aberto sob GPL. A aplicação da licença à arquitetura e à distribuição concreta ainda precisa ser conferida; este estudo não concede licença nem escolhe uma versão.
- [Scanning](https://docs.clamav.net/manual/Usage/Scanning.html), lido em 10/11/2026: documenta `clamd`, `clamdscan` e `clamscan`; este último carrega um motor a cada execução. A página informa que arquivos maiores que `--max-filesize` são pulados e considerados limpos. Também alerta que o TCP de `clamd` não autentica o cliente. **Arquivo pulado não é arquivo verificado.** Nenhum desses comandos foi executado.
- [Docker, Memory Requirements](https://docs.clamav.net/manual/Installing/Docker.html), lido em 10/11/2026: recomendação expressamente datada de **20/09/2020**, com 3 GiB mínimos e 4 GiB preferidos. A página descreve memória adicional na recarga das assinaturas e no FreshClam. Essa recomendação **não é teto de memória**, benchmark atual ou prova de adequação aos arquivos do Marktmorgen.
- [Configuração de exemplo do projeto](https://github.com/Cisco-Talos/clamav/blob/main/etc/clamd.conf.sample), consultada em 10/11/2026: descreve limites de stream, arquivo, varredura e alertas de limite. É exemplo em `main`, sem versão selecionada ou configuração aplicada. No trecho `MaxFileSize`, a configuração de exemplo registra a limitação técnica de 2 GB e diz que arquivos maiores não podem ser verificados nessa versão. Isso impede usar esse exemplo como prova de cobertura dos arquivos de até 5 GiB permitidos aqui.

## Direitos existentes a dimensionar integralmente

Fontes locais lidas: `lib/product-file.ts` (`MAX_FILE_BYTES`), `lib/storage-rules.ts` (`PAID_STORAGE_BYTES`), `lib/upload-budget-policy.ts` (`PAID_UPLOAD_OPENS` e `AUTOMATIC_UPLOAD_CAPS`), `lib/upload-budget.ts`, `lib/allowance-window.ts` e `lib/sold-file-upload.ts`. O teste confere as linhas abaixo contra os valores reais exportados, sem alterar os módulos.

| Plano interno | Inícios por janela | Bytes novos autorizados por janela | Máximo por arquivo em bytes | Custo mensal adicional de scanner | Custo anual adicional de scanner |
| --- | ---: | ---: | ---: | --- | --- |
| creator | 50 | 5368709120 | 5368709120 | desconhecido | desconhecido |
| pro | 300 | 42949672960 | 5368709120 | desconhecido | desconhecido |
| scale | 600 | 85899345920 | 5368709120 | desconhecido | desconhecido |

Os limites de bytes e inícios valem conjuntamente: **não multiplicar o armazenamento por cada início de upload**. Cada início ainda pode gerar trabalho fixo, mesmo com pouco conteúdo; o custo não pode depender de um tamanho médio presumido. O código registra capacidade de upload, não um orçamento de antivírus. Retries, trocas de arquivo, conteúdo comprimido, recargas e tarefas que não concluem precisam de teto próprio antes de executar.

No anual, `allowance-window.ts` divide o período em **12 janelas mensais**. Cada janela mantém os direitos da tabela, no seu tamanho real de calendário. Não contar uma única cota para o ano nem confundir o maior mês com doze meses de 31 dias. O cálculo anual precisa somar as doze janelas e os custos aplicáveis ao período inteiro. Nenhum limite de arquivo ou plano foi reduzido.

## Por que o custo permanece desconhecido

Para cada plano, a quantidade de entrada da tabela é conhecida; o **tempo máximo de CPU ainda não medido**, a expansão de arquivos compostos, o pico de memória, a duração das instâncias, a concorrência segura e a oferta faturável não são conhecidos. Também faltam limites e preço de leituras, transferência, espaço temporário, atualizações de base, resultados, retries e eventual retenção de arquivos pendentes. Não foi contratada nem cotada infraestrutura.

Uma conta futura deve relacionar o total autorizado de bytes e inícios a limites medidos de CPU, memória e duração, acrescentando I/O, armazenamento, atualizações, reprocessamento e a parcela integral dos custos compartilhados. **100% dos custos fixos pertencem ao Marktmorgen** (FX275). Uma cota grátis não é custo zero; software de código aberto não torna processamento ou operação gratuitos. Não há número finito revisado de custo ou margem neste estudo, e desconhecido não foi substituído por zero.

## Requisitos propostos antes de implementar

Erro, timeout, limite excedido ou base vencida é desconhecido, nunca recibo de arquivo limpo. Uma resposta sem detecção só poderia autorizar a entrega depois de comprovar conclusão, identidade e integridade do arquivo, versão da configuração e base dentro de prazo revisado. Cobertura integral dos arquivos de até 5368709120 bytes, inclusive contêineres suportados, ainda não foi demonstrada. A restrição de 2 GB foi encontrada no exemplo de configuração consultado, não na página geral de uso. Ela não deve ser universalizada para versões não conferidas nem contornada dividindo arquivos sem prova de cobertura: a arquitetura concreta precisa preservar a verificação do arquivo completo e todos os direitos existentes.

O desenho precisa de **teto e reserva antes do gasto**, com concorrência e tentativas dentro do mesmo financiamento, além de tratamento de falha sem apagar conteúdo, abrir acesso indevido ou retirar direitos já pagos. Arquivos e resultados de verificação seriam dados da loja: qualquer fila, chave, cache ou retenção nova exige registro de custo, controle de acesso, exclusão e exportação no mesmo PR de implementação. Não alterar nem contornar a preservação restrita de segurança já existente. Nenhum scanner, upload ou socket do dono foi configurado.

## Depende do dono

O pedido permanece sem ativação por viabilidade técnica e financiamento **não comprovados**, não por uma conclusão de que o custo já foi demonstrado incompatível. Faltam: arquitetura/versionamento e licença aplicável; prova de cobertura e limites de execução; medição sintética controlada e uma oferta revisada; cálculo completo dos três planos a 100% no pior mês e nos termos mensal/anual; reserva, dados e retenção; revisão independente. A coleta dessas provas não exige criar conta, aceitar termo, pagar ou contatar fornecedor nesta unidade. Não há tarefa manual de painel a ser feita pelo dono agora.

PLANS_ON_SALE e OPENING_REQUESTED permanecem false. Preços, limites, comissão, tax gate, art. 9a e demais travas não mudam. Acessibilidade: 0 → 0 passos ou decisões de interface, sem certificação humana/AAA. Teste documental sintético; verifica o vínculo dos direitos e a preservação das ressalvas, não a segurança de arquivos, custos de fornecedor ou conclusão do GD2(d).
