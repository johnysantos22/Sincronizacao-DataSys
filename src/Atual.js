import { MongoClient } from 'mongodb';
import soap from 'soap';

const WSDL_URL = 'https://wsintegracaoclientes.datasys.online/clientes/ConsultasDatasys.asmx?WSDL';
const MONGO_URL = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DEMO_DB_NAME || 'facell_vendas_db_demo';
const TOKEN_SEGURANCA = process.env.DATASYS_TOKEN;
const PERMITIR_EXCLUSAO = process.env.DEMO_ALLOW_DESTRUCTIVE_SYNC === 'I_UNDERSTAND';
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

function proximoDia(data) {
    const proximaData = new Date(`${data}T00:00:00.000Z`);
    proximaData.setUTCDate(proximaData.getUTCDate() + 1);
    return proximaData.toISOString().slice(0, 10);
}

async function sincronizarVendasComErro(dataInicial, dataFinal) {
    validarPeriodo(dataInicial, dataFinal);

    if (!TOKEN_SEGURANCA) {
        throw new Error('Configure DATASYS_TOKEN no arquivo .env ou nas variáveis de ambiente.');
    }

    if (!PERMITIR_EXCLUSAO) {
        throw new Error(
            'Este exemplo apaga vendas antes da consulta. Para executá-lo, configure ' +
            'DEMO_ALLOW_DESTRUCTIVE_SYNC=I_UNDERSTAND e use somente o banco de demonstração.'
        );
    }

    const mongoClient = new MongoClient(MONGO_URL);

    try {
        await mongoClient.connect();
        const colecaoVendas = mongoClient.db(DB_NAME).collection('vendas');

        console.warn(
            `[DEMONSTRAÇÃO DO BUG] Apagando vendas de ${dataInicial} até ${dataFinal} ` +
            `no banco "${DB_NAME}" antes de consultar o DataSys.`
        );

        // BUG: apaga os dados antes de saber se a API retornará uma resposta completa.
        await colecaoVendas.deleteMany({
            data_pedido: {
                $gte: dataInicial,
                $lt: proximoDia(dataFinal)
            }
        });

        const soapClient = await soap.createClientAsync(WSDL_URL);
        const [resultadoSOAP] = await soapClient.BaixarVendasAsync({
            Token: TOKEN_SEGURANCA,
            DataInicial: dataInicial,
            DataFinal: dataFinal
        });

        const tabela = resultadoSOAP?.BaixarVendasResult?.NewDataSet?.Table;
        const vendas = tabela == null ? [] : Array.isArray(tabela) ? tabela : [tabela];

        console.log(`[DataSys] ${vendas.length} venda(s) retornada(s).`);

        // BUG: resposta vazia não repõe os documentos apagados; insertOne também não atualiza existentes.
        for (const venda of vendas) {
            await colecaoVendas.insertOne({
                id_venda: String(venda.id),
                numero_pedido: venda.Numero_x0020_Pedido,
                filial: venda.Filial,
                data_pedido: venda.Data_x0020_pedido,
                tipo_pedido: venda.Tipo_x0020_Pedido,
                total_item: venda.Total_x0020_Item,
                cpf_vendedor: venda.CPF_x0020_Vendedor,
                inserido_em: new Date()
            });
        }

        console.log(`[Fim] Demonstração concluída para ${dataInicial} até ${dataFinal}.`);
    } finally {
        await mongoClient.close();
    }
}

const [dataInicial, dataFinal = dataInicial] = process.argv.slice(2);

if (!dataInicial) {
    console.error('Uso: npm run demo:erro -- YYYY-MM-DD [YYYY-MM-DD]');
    process.exitCode = 1;
} else {
    try {
        await sincronizarVendasComErro(dataInicial, dataFinal);
    } catch (error) {
        console.error('[Erro] A demonstração não foi concluída:', error);
        process.exitCode = 1;
    }
}
