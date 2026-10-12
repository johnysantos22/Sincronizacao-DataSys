import { MongoClient } from 'mongodb';
import soap from 'soap';

const WSDL_URL = 'https://wsintegracaoclientes.datasys.online/clientes/ConsultasDatasys.asmx?WSDL';
const MONGO_URL = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB_NAME || 'facell_vendas_db';
const TOKEN_SEGURANCA = process.env.DATASYS_TOKEN;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
const MAX_DIAS_CONSULTA = 15;

function converterData(data, nomeParametro) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        throw new Error(`${nomeParametro} deve estar no formato YYYY-MM-DD.`);
    }

    const dataUTC = new Date(`${data}T00:00:00.000Z`);
    if (Number.isNaN(dataUTC.getTime()) || dataUTC.toISOString().slice(0, 10) !== data) {
        throw new Error(`${nomeParametro} não é uma data válida.`);
    }

    return dataUTC;
}

function validarPeriodo(dataInicial, dataFinal) {
    const inicio = converterData(dataInicial, 'DataInicial');
    const fim = converterData(dataFinal, 'DataFinal');
    const hojeLocal = new Date();
    const ontem = new Date(Date.UTC(
        hojeLocal.getFullYear(),
        hojeLocal.getMonth(),
        hojeLocal.getDate() - 1
    ));

    if (inicio > ontem) {
        throw new Error('Pelo manual DataInicial deve ser, no máximo, o dia anterior.');
    }

    if (fim < inicio) {
        throw new Error('DataFinal não pode ser anterior a DataInicial.');
    }

    const diasNoPeriodo = Math.floor((fim - inicio) / UM_DIA_MS) + 1;
    if (diasNoPeriodo > MAX_DIAS_CONSULTA) {
        throw new Error('O período solicitado não pode ultrapassar 15 dias.');
    }
}

async function sincronizarVendas(dataInicial, dataFinal) {
    validarPeriodo(dataInicial, dataFinal);

    if (!TOKEN_SEGURANCA) {
        throw new Error('Configure DATASYS_TOKEN no arquivo .env ou nas variáveis de ambiente.');
    }

    console.log(`[DataSys] Consultando vendas de ${dataInicial} até ${dataFinal}...`);
    const soapClient = await soap.createClientAsync(WSDL_URL);
    const [resultadoSOAP] = await soapClient.BaixarVendasAsync({
        Token: TOKEN_SEGURANCA,
        DataInicial: dataInicial,
        DataFinal: dataFinal
    });

    const tabela = resultadoSOAP?.BaixarVendasResult?.NewDataSet?.Table;
    const vendas = tabela == null ? [] : Array.isArray(tabela) ? tabela : [tabela];

    if (vendas.length === 0) {
        console.warn(
            `[Pendente] O DataSys não retornou vendas no período ${dataInicial} a ${dataFinal}. ` +
            'Os dados locais foram preservados; consulte o período novamente.'
        );
        return;
    }

    const mongoClient = new MongoClient(MONGO_URL);

    try {
        await mongoClient.connect();
        const colecaoVendas = mongoClient.db(DB_NAME).collection('vendas');

        for (const venda of vendas) {
            if (venda.id == null || venda.id === '') {
                throw new Error('O DataSys retornou uma venda sem o campo id.');
            }

            await colecaoVendas.updateOne(
                { id_venda: String(venda.id) },
                {
                    $set: {
                        numero_pedido: venda.Numero_x0020_Pedido,
                        filial: venda.Filial,
                        data_pedido: venda.Data_x0020_pedido,
                        tipo_pedido: venda.Tipo_x0020_Pedido,
                        total_item: venda.Total_x0020_Item,
                        cpf_vendedor: venda.CPF_x0020_Vendedor,
                        atualizado_em: new Date()
                    },
                    $setOnInsert: {
                        inserido_em: new Date()
                    }
                },
                { upsert: true }
            );
        }

        console.log(`[Sucesso] ${vendas.length} venda(s) inserida(s) ou atualizada(s).`);
    } finally {
        await mongoClient.close();
    }
}

const [dataInicial, dataFinal = dataInicial] = process.argv.slice(2);

if (!dataInicial) {
    console.error('Uso: npm start -- YYYY-MM-DD [YYYY-MM-DD]');
    process.exitCode = 1;
} else {
    try {
        await sincronizarVendas(dataInicial, dataFinal);
    } catch (error) {
        console.error('[Erro] A sincronização não foi concluída:', error);
        process.exitCode = 1;
    }
}
