import type { INodeProperties } from 'n8n-workflow';

export const mocaOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'execute',
		options: [
			{
				name: 'Execute Command',
				value: 'execute',
				description:
					'Run a MOCA syntax command on the MOCA server. Wrap native SQL in square brackets to use MOCA local syntax.',
				action: 'Execute a MOCA command',
			},
			{
				name: 'Test Connection',
				value: 'login',
				description: 'Log in to the MOCA server and return the session details',
				action: 'Test the MOCA connection',
			},
		],
	},
];

export const mocaFields: INodeProperties[] = [
	{
		displayName: 'Command',
		name: 'command',
		type: 'string',
		typeOptions: { rows: 8 },
		default: '',
		required: true,
		placeholder: "list warehouses where wh_id like 'W%'",
		description:
			'MOCA syntax command to run. Native SQL goes in square brackets, for example [select wh_id from wh]. Use the Arguments section to bind values safely rather than building the command with expressions.',
		displayOptions: { show: { operation: ['execute'] } },
	},
	{
		displayName: 'Arguments',
		name: 'publishData',
		placeholder: 'Add Argument',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		default: {},
		description:
			'Values published to the command with a "publish data" clause, so they are bound instead of being concatenated into the command text',
		displayOptions: { show: { operation: ['execute'] } },
		options: [
			{
				name: 'argument',
				displayName: 'Argument',
				values: [
					{
						displayName: 'Name',
						name: 'name',
						type: 'string',
						default: '',
						placeholder: 'wh_id',
						description:
							'Name the value is published under. Reference it with @name in the command.',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add option',
		default: {},
		displayOptions: { show: { operation: ['execute'] } },
		options: [
			{
				displayName: 'Autocommit',
				name: 'autocommit',
				type: 'boolean',
				default: true,
				description:
					'Whether the MOCA server commits the transaction when the command succeeds. Turning this off does not roll the transaction back, so a write can hold database locks until the session ends.',
			},
			{
				displayName: 'Convert Numeric Columns',
				name: 'convertNumeric',
				type: 'boolean',
				default: false,
				description:
					'Whether to convert columns the server reports as numeric into numbers. All values are returned as strings when disabled.',
			},
			{
				displayName: 'Simplify',
				name: 'simplify',
				type: 'boolean',
				default: true,
				description:
					'Whether to return one item per result row. When disabled, a single item with the status, message, column metadata and rows is returned.',
			},
			{
				displayName: 'Treat Empty Result as Error',
				name: 'errorOnNoRows',
				type: 'boolean',
				default: false,
				description:
					'Whether MOCA status 510 (no rows found) should fail the node instead of returning an empty result',
			},
		],
	},
];
