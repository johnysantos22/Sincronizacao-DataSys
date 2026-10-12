# Apresentação — Sincronização de vendas com a API DataSys

Roteiro editável para montar os slides no PowerPoint ou Canva. A apresentação foi planejada para aproximadamente 20 minutos. Os trechos de código são exemplos didáticos; não coloque um token real nos slides.

---

## Slide 1 — Causa raiz: resposta vazia não significa “zero vendas”

### Na tela

- A rotina consulta diariamente `BaixarVendas`.
- A API retorna vendas somente de caixas fechados.
- Uma loja com caixa ainda aberto pode não aparecer na resposta.
- Manual DataSys v12: `DataInicial` no máximo ontem; período limitado a 15 dias.
- **Falha de interpretação:** tratar uma resposta parcial como retrato completo do dia.

**Regra importante:** “não veio na resposta” não prova “não existe”.

### Notas para apresentar — ~4 minutos

Comece explicando o fluxo: o sistema consulta o DataSys e atualiza a base interna. A API só disponibiliza os dados de caixas fechados. Se uma loja ainda não fechou o caixa, suas vendas podem não ser retornadas naquele momento.

Portanto, uma lista vazia ou incompleta tem ambiguidade: pode significar caixa aberto, dia realmente sem vendas, consulta incompleta ou falha. O erro de desenho é assumir que a consulta diária sempre contém todos os dados de todas as lojas.

Deixe claro que a API não necessariamente apagou os dados locais. A perda acontece por causa da lógica local que usa a resposta como se fosse completa.

---

## Slide 2 — Fluxo defeituoso: apagar antes de confirmar

### Na tela

```js
// 1. Apaga os registros locais do dia
await vendas.deleteMany({ data_pedido: dataAlvo });

// 2. Consulta a API
const resposta = await baixarVendas(dataAlvo);

// 3. Se vier vazia, o loop não executa
for (const venda of resposta) {
  await vendas.insertOne(mapearVenda(venda));
}
```

**Sequência do problema:** `DELETE` → resposta parcial/vazia → nenhuma reinserção → dados locais perdidos.

### Notas para apresentar — ~5 minutos

Mostre que a operação destrutiva ocorre antes da chamada externa. Se o DataSys falhar, a rotina pode terminar depois de já ter apagado os registros. Se a resposta vier vazia porque uma loja não fechou o caixa, o `for` não executa e o banco fica sem as vendas que já tinha.

Se a resposta vier parcialmente preenchida, o sistema pode apagar vendas de todas as lojas e inserir apenas as vendas das lojas cujos caixas foram fechados. Nesse caso a perda é parcial e pode ser mais difícil de perceber.

O arquivo `src/Atual.js` usa o mesmo endpoint SOAP e os mesmos campos da solução, mas executa o `deleteMany` antes de consultar e grava depois com `insertOne`. Por segurança, ele usa um banco de demonstração separado e exige uma confirmação explícita no `.env`; não o aponte para a base real. Para mostrar a exclusão na demonstração, prepare documentos de teste nesse banco e execute `npm run demo:erro -- 2026-10-10` com um token válido e uma data permitida pelo manual.

---

## Slide 3 — Solução: preservar, validar e fazer upsert

### Na tela

```js
const tabela = resultadoSOAP?.BaixarVendasResult?.NewDataSet?.Table;
const vendas = tabela == null ? [] : Array.isArray(tabela) ? tabela : [tabela];

if (vendas.length === 0) {
  // Preserva o banco; consultar novamente depois.
  return;
}

for (const venda of vendas) {
  await colecaoVendas.updateOne(
    { id_venda: String(venda.id) },
    {
      $set: {
        numero_pedido: venda.Numero_x0020_Pedido,
        filial: venda.Filial,
        data_pedido: venda.Data_x0020_pedido,
        total_item: venda.Total_x0020_Item,
        cpf_vendedor: venda.CPF_x0020_Vendedor
      },
      $setOnInsert: { inserido_em: new Date() }
    },
    { upsert: true }
  );
}
```

- Não apagar registros pela ausência na resposta.
- O manual lista `id` como ID do pedido; validar unicidade antes de usá-lo como chave única.
- Respeitar os parâmetros `Token`, `DataInicial` e `DataFinal` (formato `aaaa-mm-dd`).
- Obedecer ao limite do manual: `DataInicial` no máximo ontem e período de até 15 dias.
- Reconsultar períodos pendentes após o fechamento do caixa.
- Registrar falhas; só marcar o período concluído com confirmação de completude.

### Notas para apresentar — ~7 minutos

Explique o `upsert`: se a venda ainda não existe, ela é inserida; se já existe, os campos recebidos são atualizados. Assim, reexecutar a sincronização não deve gerar outra cópia da mesma venda, desde que `id_venda` seja realmente único e estável no DataSys.

Quando a resposta vier vazia, o script não altera as vendas locais e registra um aviso. Para a produção, eu persistiria o estado pendente por loja/data e agendaria a nova tentativa com uma rotina de reconciliação.

Importante: proteger uma resposta vazia evita a exclusão indevida, mas não prova que uma resposta não vazia esteja completa. Também não permite distinguir “caixa fechado sem vendas” de “caixa ainda aberto” sem um indicador explícito da API. Isso precisa ser confirmado no contrato do DataSys.

No projeto, `src/Atual.js` reproduz o fluxo com erro na integração: apaga os documentos do período antes da chamada SOAP e tenta reinserir depois. A execução é protegida para usar um banco de demonstração separado. `src/Upsert.js` usa o endpoint e os parâmetros documentados, lê o token de configuração local, trata `Table` como objeto único ou lista e persiste por upsert. O manual descreve `id` como ID do pedido, mas a unicidade precisa ser confirmada no uso real.

O manual inclui campos de dados pessoais na resposta. O exemplo seleciona apenas alguns campos de venda para evitar persistir todos os dados retornados sem necessidade.

O endpoint indicado na página 1 do manual é `https://wsintegracaoclientes.datasys.online/clientes/ConsultasDatasys.asmx`. O exemplo usa a descrição WSDL desse serviço e envia `Token`, `DataInicial` e `DataFinal`.

---

## Slide 4 — Recuperação, garantias e conclusão

### Na tela

```text
Consulta falhou/incompleta? → manter dados → registrar erro → tentar novamente
Caixa não confirmado?       → manter dados → marcar pendente → reconsultar
Caixa fechado e completo?   → upsert das vendas → marcar sincronizado
```

### Garantias e validações

- Índice único no identificador de venda somente após validar duplicatas e confirmar a unicidade do `id`.
- Testes para resposta vazia, venda repetida, erro e fechamento tardio.
- Confirmar com o DataSys o significado da resposta vazia, a chave única e eventuais alterações retroativas.
- Respeitar o limite de 15 dias e não solicitar `DataInicial` posterior a ontem.
- Sem exclusões automáticas baseadas apenas em registros ausentes.

### Mensagem final

> Uma resposta vazia não deve apagar dados. Primeiro precisamos confirmar que o período está completo.

### Notas para apresentar — ~4 minutos

Feche resumindo o princípio: preservar os dados é o comportamento seguro diante de incerteza. As vendas são atualizadas por identificador, as falhas ficam visíveis e os períodos que ainda podem mudar são reprocessados.

Como próximos passos, confirmaria com o fornecedor se a API oferece status de fechamento, como sinaliza um dia fechado sem vendas, se existe paginação e se vendas podem sofrer correções. Também adicionaria estado de sincronização e alertas para períodos pendentes além do prazo esperado.

Encerre com a mensagem principal e destaque que a solução evita perda por resposta parcial sem inventar a confirmação que a API ainda não fornece.

---

## Referências do projeto

- `src/Atual.js`: fluxo defeituoso usando o contrato real do DataSys; exige confirmação e banco de demonstração.
- `src/Upsert.js`: integração de exemplo baseada no manual; precisa de token, MongoDB e dependências para executar.
- `README.md`: contexto, estratégia, testes e pontos a validar.
