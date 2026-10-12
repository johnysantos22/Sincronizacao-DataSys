# Sincronização de Vendas com a API DataSys

Material de apoio para apresentar uma estratégia segura de sincronização das vendas retornadas pela API do DataSys.

## Contexto

Uma rotina consulta diariamente o método `BaixarVendas` da API DataSys e atualiza a base interna. Esse método retorna somente vendas de caixas que já foram fechados.

Se uma loja não fechar o caixa dentro do prazo, a consulta daquele dia pode não trazer vendas. Quando a rotina interpreta essa resposta como uma lista completa e substitui ou apaga os dados locais, registros válidos podem ser perdidos.

## Contrato DataSys conforme o manual recebido

O projeto usa como referência o documento **Integração via Webservices - DataSys v12.0**:

- **WSDL/serviço:** `https://wsintegracaoclientes.datasys.online/clientes/ConsultasDatasys.asmx` (o exemplo Node usa `?WSDL` para obter a descrição do serviço SOAP).
- **Método:** `BaixarVendas`.
- **Autenticação:** parâmetro obrigatório `Token`, solicitado à CSJ Sistemas.
- **Parâmetros obrigatórios:** `DataInicial` e `DataFinal`, no formato `aaaa-mm-dd`.
- **Limites do método:** conforme a página 8, `DataInicial` deve ser no máximo o dia anterior à consulta e o período solicitado não pode ultrapassar 15 dias.
- **Formato de retorno:** resposta SOAP em `BaixarVendasResult > NewDataSet > Table`; a tabela contém registros de venda.
- **Campos de retorno usados neste exemplo:** `id` (ID do pedido), `Numero_x0020_Pedido`, `Filial`, `Data_x0020_pedido`, `Tipo_x0020_Pedido`, `Total_x0020_Item` e `CPF_x0020_Vendedor`.

O mapeamento persistido pelo exemplo é:

| Campo XML do DataSys | Campo no MongoDB | Descrição do manual |
|---|---|---|
| `id` | `id_venda` | ID do pedido de venda |
| `Numero_x0020_Pedido` | `numero_pedido` | Número do pedido |
| `Filial` | `filial` | Nome fantasia da filial |
| `Data_x0020_pedido` | `data_pedido` | Data do pedido |
| `Tipo_x0020_Pedido` | `tipo_pedido` | Devolução ou venda |
| `Total_x0020_Item` | `total_item` | Valor total do item |
| `CPF_x0020_Vendedor` | `cpf_vendedor` | CPF do vendedor |

O documento informa que `BaixarVendas` retorna vendas registradas que constam em **caixa fechado**. Isso explica por que a resposta pode não representar vendas de caixas que ainda não foram fechados. A proteção para resposta vazia decorre também do cenário do case; o manual não documenta uma distinção explícita entre “caixa aberto” e “caixa fechado sem vendas”.

Os nomes XML codificados com `_x0020_` correspondem a espaços no nome original. O cliente SOAP pode retornar `Table` como um único objeto quando há uma venda ou como uma lista quando há várias; `src/Upsert.js` normaliza os dois casos. Apesar de o manual descrever `id` como ID do pedido de venda, confirme sua unicidade/estabilidade na integração real antes de criar um índice único no MongoDB.

O retorno do manual contém outros campos, inclusive dados pessoais e de clientes. O exemplo persiste somente os campos necessários para demonstrar a sincronização; evite armazenar informações adicionais sem necessidade e autorização.

## Problema e causa raiz

O erro central é tratar **ausência de dados na resposta** como **confirmação de que não existem vendas**.

Uma resposta sem vendas pode ter significados diferentes:

- o caixa ainda não foi fechado;
- o caixa foi fechado e não houve vendas;
- a consulta falhou ou retornou dados incompletos;
- o período ainda não foi processado pela origem.

Como `BaixarVendas` retorna apenas caixas fechados, uma resposta vazia não é, por si só, suficiente para decidir que os dados locais devem ser removidos. A rotina está assumindo que a resposta é um retrato completo e definitivo, embora a API possa fornecer apenas uma visão parcial enquanto houver caixas pendentes.

## Objetivos da solução

- Preservar os dados locais diante de respostas vazias, falhas ou incompletas.
- Atualizar uma venda existente sem criar duplicidade.
- Identificar períodos cujo caixa ainda não foi fechado.
- Reprocessar esses períodos para buscar fechamentos tardios.
- Executar gravações de forma atômica, para evitar atualizações parciais.
- Só considerar um período sincronizado quando houver confirmação de que os dados estão completos.

## Estratégia proposta

### 1. Separar consulta de confirmação

Para cada loja e data, consultar as vendas e verificar o estado do processamento. A resposta deve ser considerada completa apenas quando a API fornecer um sinal confiável de que o caixa foi fechado e que todos os dados do período foram retornados.

Se a API não disponibilizar esse estado diretamente, a integração deve manter o período como **pendente** e reconsultá-lo, em vez de inferir que um resultado vazio representa zero vendas.

### 2. Não substituir o período com uma lista vazia

Não apagar nem substituir as vendas locais só porque uma consulta retornou uma lista vazia. Uma resposta vazia deve preservar os dados atuais até que a origem confirme que o período está fechado e completo.

### 3. Usar upsert idempotente

Gravar cada venda por uma chave estável fornecida pela origem, como o identificador da venda. Se o identificador for composto, definir e documentar uma chave única apropriada — por exemplo, loja, número da venda e data, desde que esses campos sejam realmente únicos no DataSys.

Com isso, repetir a mesma sincronização atualiza o registro existente em vez de duplicá-lo.

### 4. Gravar em transação

Persistir os dados e atualizar o estado de sincronização na mesma transação. Se qualquer gravação falhar, reverter a transação e manter o período pendente para nova tentativa.

### 5. Reprocessar períodos pendentes

Além da consulta diária, executar uma reconciliação periódica de um intervalo recente de datas. O intervalo deve levar em conta o prazo operacional observado para fechamento dos caixas e pode ser configurável.

Períodos já confirmados podem ser consultados novamente se a API permitir correções retroativas. O upsert torna essa repetição segura.

## Fluxo proposto

```text
para cada loja e data:
    resposta = consultar BaixarVendas(loja, data)

    se a consulta falhou ou os dados estão incompletos:
        registrar a falha
        manter os dados locais
        manter o período pendente
        tentar novamente depois
        continuar

    se o fechamento do caixa não foi confirmado:
        manter os dados locais
        manter o período pendente
        continuar

    iniciar transação
        para cada venda recebida:
            inserir ou atualizar pela chave única da venda
        marcar loja/data como sincronizada
    confirmar transação
```

O estado do período deve ser marcado como sincronizado **na mesma transação** que grava as vendas. Assim, o sistema não registra como concluída uma sincronização cujos dados não foram persistidos.

## Exemplo de estados por loja e data

| Estado | Significado | Ação |
|---|---|---|
| Pendente | O caixa ainda não foi confirmado como fechado | Preservar os dados locais e reconsultar |
| Em processamento | Uma tentativa de sincronização está em andamento | Evitar processamento concorrente do mesmo período |
| Sincronizado | A origem confirmou que o período está completo e os dados foram gravados | Permitir nova reconciliação conforme a política definida |
| Erro | A consulta ou a gravação falhou | Registrar o erro e agendar nova tentativa |

Um período fechado sem vendas deve ser distinguido de um período ainda aberto. Se a API não informar essa distinção, a integração não deve apagar dados nem declarar o período sincronizado com base somente em uma resposta vazia.

## Dados de controle recomendados

Além da tabela de vendas, manter o estado de sincronização por loja e data. Campos possíveis:

- identificador da loja;
- data de referência;
- estado da sincronização;
- horário da última tentativa;
- horário da última sincronização confirmada;
- quantidade de vendas recebidas;
- mensagem ou código do último erro.

Uma restrição única para loja e data evita a criação de vários controles para o mesmo período. A tabela de vendas também deve ter uma restrição única baseada na chave de negócio da venda.

## Tratamento de falhas e observabilidade

- Registrar loja, data, duração, resultado e identificador de correlação de cada tentativa.
- Distinguir falha de comunicação, resposta incompleta e período ainda não fechado.
- Aplicar retentativas com intervalo crescente e limite configurado.
- Alertar quando um período permanecer pendente por mais tempo que o esperado.
- Não interpretar falhas como resposta vazia válida.
- Não excluir vendas por ausência na resposta. Exclusões ou cancelamentos devem depender de um evento ou indicação explícita da origem.

## Testes importantes

1. **Caixa ainda aberto:** resposta vazia sem confirmação; preservar as vendas locais e manter o período pendente.
2. **Caixa fechado sem vendas:** só considerar o período completo se a API confirmar explicitamente o fechamento.
3. **Venda nova:** inserir a venda recebida.
4. **Venda repetida:** atualizar o registro existente, sem duplicá-lo.
5. **Falha durante a gravação:** reverter a transação e não marcar o período como sincronizado.
6. **Fechamento tardio:** uma reconciliação posterior deve buscar e gravar as vendas.
7. **Resposta incompleta:** não finalizar o período nem remover dados locais. O manual recebido não especifica paginação.
8. **Duas tentativas concorrentes:** impedir que processamento simultâneo crie duplicidades ou estados inconsistentes.

## Benefícios esperados

- Evita perda de vendas por fechamento tardio.
- Permite reexecutar consultas sem duplicar registros.
- Mantém um histórico claro de períodos pendentes e sincronizados.
- Torna erros de integração observáveis e recuperáveis.
- Separa os dados recebidos da confirmação de que eles representam o período inteiro.

## Pontos a validar com o fornecedor do DataSys

Antes da implementação, confirmar:

- Como a API informa que o caixa de uma loja foi fechado.
- Se existe uma resposta distinta para “caixa fechado sem vendas”.
- Se podem ocorrer respostas limitadas/incompletas ou paginação; esse comportamento não está especificado no manual recebido.
- Qual identificador é estável e único para cada venda.
- Se vendas já sincronizadas podem ser alteradas ou canceladas posteriormente.
- Qual é o prazo operacional típico para o fechamento tardio dos caixas.

Essas informações definem quando um período pode ser considerado completo e qual deve ser a chave de idempotência.

## Roteiro sugerido para a apresentação — 20 minutos

1. **Contexto e impacto (2 min):** explicar a rotina diária e o risco de perda de dados.
2. **Causa raiz (4 min):** mostrar por que “resposta vazia” não significa “zero vendas”.
3. **Estratégia (8 min):** apresentar confirmação de fechamento, upsert, transação e períodos pendentes.
4. **Falhas e recuperação (3 min):** explicar retentativas, reconciliação e observabilidade.
5. **Conclusão (3 min):** reforçar a regra de segurança e os pontos a validar com o DataSys.

### Mensagem principal

> Uma resposta vazia não deve apagar dados. Primeiro é preciso saber se a origem confirmou que o caixa foi fechado e que a resposta está completa.

## Exemplos de código do projeto

O arquivo [src/Atual.js](./src/Atual.js) usa o mesmo contrato SOAP e mapeamento de campos do exemplo corrigido, mas reproduz o erro: apaga primeiro os documentos do período no MongoDB e só depois consulta o DataSys; se a resposta vier vazia ou a chamada falhar, os dados apagados não são restaurados. Em seguida, tenta gravar com `insertOne`, sem upsert.

**Cuidado:** este script é destrutivo de propósito. Por segurança, usa o banco `facell_vendas_db_demo` por padrão e recusa a execução sem uma confirmação explícita no `.env`. Nunca aponte a demonstração para o banco real. Para demonstrar a exclusão, prepare documentos de teste na coleção `vendas` do banco de demonstração e configure as variáveis do exemplo:

```dotenv
DATASYS_TOKEN=seu-token-de-teste
MONGODB_URI=mongodb://localhost:27017
MONGODB_DEMO_DB_NAME=facell_vendas_db_demo
DEMO_ALLOW_DESTRUCTIVE_SYNC=I_UNDERSTAND
```

Execute apenas com uma data permitida pelo manual (no máximo ontem e em um intervalo de até 15 dias):

```powershell
npm run demo:erro -- 2026-10-10
```

O arquivo [src/Upsert.js](./src/Upsert.js) apresenta a versão corrigida, alinhada aos parâmetros e nomes de campos descritos no manual. Ele não apaga registros diante de resposta vazia e usa upsert para inserir ou atualizar vendas. No caso vazio, o script registra um aviso; o agendamento de nova tentativa e o controle persistente de estado ainda são responsabilidades a implementar em uma execução de produção.

Instale as dependências:

```powershell
npm install
```

Copie `.env.example` para `.env` e configure o token fornecido pela CSJ. Não compartilhe nem envie `.env` ao Git. Exemplo de consulta diária (ajuste a data para o dia desejado; `DataInicial` precisa ser no máximo ontem na data da consulta):

```powershell
npm start -- 2026-10-10
```

Para consultar um intervalo:

```powershell
npm start -- 2026-10-01 2026-10-10
```

As datas precisam ser válidas, `DataFinal` não pode preceder `DataInicial`, e o período inclusivo não pode ultrapassar 15 dias. O token real, a disponibilidade do MongoDB e a chave única adequada devem ser confirmados antes de executar com dados reais.
