import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { mocaFields, mocaOperations } from './MocaDescription';
import type { MocaCredentials } from './transport';
import { MOCA_CONTENT_TYPE, MocaConnection, buildLoginQuery, createConnection } from './transport';
import type { MocaResponse, MocaValue } from './transport/protocol';
import {
	MOCA_STATUS,
	buildMocaRequest,
	convertNumericColumns,
	parseMocaResponse,
	withPublishedData,
} from './transport/protocol';

interface ArgumentEntry {
	name?: string;
	value?: string;
}

function collectArguments(raw: IDataObject): Record<string, string> {
	const entries = (raw.argument as ArgumentEntry[] | undefined) ?? [];
	const collected: Record<string, string> = {};
	for (const entry of entries) {
		if (entry?.name === undefined || entry.name.trim() === '') continue;
		collected[entry.name] = entry.value ?? '';
	}
	return collected;
}

function toItems(
	response: MocaResponse,
	command: string,
	options: IDataObject,
	itemIndex: number,
): INodeExecutionData[] {
	const rows: Array<Record<string, MocaValue>> =
		options.convertNumeric === true ? convertNumericColumns(response) : response.rows;

	if (options.simplify === false) {
		return [
			{
				json: {
					status: response.status,
					message: response.message,
					command,
					rowCount: rows.length,
					columns: response.columns as unknown as IDataObject[],
					rows: rows as unknown as IDataObject[],
				},
				pairedItem: { item: itemIndex },
			},
		];
	}

	if (rows.length === 0) {
		return [
			{
				json: {
					status: response.status,
					message: response.message,
					command,
					rowCount: 0,
				},
				pairedItem: { item: itemIndex },
			},
		];
	}

	return rows.map((row) => ({
		json: row as unknown as IDataObject,
		pairedItem: { item: itemIndex },
	}));
}

export class Moca implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'MOCA',
		name: 'moca',
		icon: { light: 'file:moca.svg', dark: 'file:moca.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Run MOCA syntax commands against a MOCA server (Blue Yonder / RedPrairie WMS)',
		defaults: {
			name: 'MOCA',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'mocaApi',
				required: true,
				testedBy: 'mocaApiTest',
			},
		],
		properties: [...mocaOperations, ...mocaFields],
	};

	methods = {
		credentialTest: {
			async mocaApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const credentials = credential.data as unknown as MocaCredentials | undefined;

				if (credentials?.url === undefined || credentials.url.trim() === '') {
					return { status: 'Error', message: 'No MOCA service URL is configured' };
				}

				const body = buildMocaRequest({
					query: buildLoginQuery(credentials.username, credentials.password),
					environment: { USR_ID: credentials.username },
					autocommit: false,
				});

				try {
					// `request` is the only HTTP helper exposed on ICredentialTestFunctions.
					// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
					const raw = await this.helpers.request({
						method: 'POST',
						uri: credentials.url,
						headers: { 'Content-Type': MOCA_CONTENT_TYPE, Accept: MOCA_CONTENT_TYPE },
						body,
						json: false,
						rejectUnauthorized: credentials.ignoreSslIssues !== true,
						timeout: credentials.timeout ?? 300000,
					});

					const response = parseMocaResponse(String(raw ?? ''));
					if (response.status === MOCA_STATUS.OK) {
						return { status: 'OK', message: 'Connection successful' };
					}

					return {
						status: 'Error',
						message:
							response.message ?? `MOCA rejected the login with status ${response.status}`,
					};
				} catch (error) {
					return { status: 'Error', message: (error as Error).message };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = (await this.getCredentials('mocaApi')) as unknown as MocaCredentials;
		let connection: MocaConnection | undefined;

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				if (connection === undefined) connection = createConnection(this, credentials);

				if (operation === 'login') {
					const response = await connection.login();
					const row = response.rows[0] ?? {};
					const safeRow: IDataObject = {};
					for (const [key, value] of Object.entries(row)) {
						// The session key is an active credential, so it never leaves the node.
						if (key.toLowerCase().includes('session')) continue;
						safeRow[key] = value as unknown as IDataObject[keyof IDataObject];
					}

					returnData.push({
						json: {
							connected: true,
							status: response.status,
							message: response.message,
							url: credentials.url,
							user: credentials.username,
							...safeRow,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation !== 'execute') {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported`,
						{ itemIndex },
					);
				}

				const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
				const command = (this.getNodeParameter('command', itemIndex) as string).trim();

				const publishData = collectArguments(
					this.getNodeParameter('publishData', itemIndex, {}) as IDataObject,
				);

				const response = await connection.execute(withPublishedData(command, publishData), {
					autocommit: options.autocommit !== false,
				});

				const emptyResultIsFine =
					response.status === MOCA_STATUS.NO_ROWS && options.errorOnNoRows !== true;

				if (response.status !== MOCA_STATUS.OK && !emptyResultIsFine) {
					throw new NodeOperationError(
						this.getNode(),
						`MOCA command failed with status ${response.status}`,
						{
							description: response.message ?? undefined,
							itemIndex,
						},
					);
				}

				returnData.push(...toItems(response, command, options, itemIndex));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						error: error as NodeOperationError,
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex,
					description: (error as NodeOperationError).description ?? undefined,
				});
			}
		}

		return [returnData];
	}
}
