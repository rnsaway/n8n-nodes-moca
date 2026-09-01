import type { XmlNode } from './xml';
import {
	escapeXmlAttribute,
	escapeXmlText,
	findChild,
	findChildren,
	findDescendant,
	parseXml,
} from './xml';

/** MOCA status codes that this node treats specially. */
export const MOCA_STATUS = {
	/** Command completed successfully. */
	OK: 0,
	/** Command completed but matched no rows - not an error in MOCA. */
	NO_ROWS: 510,
	/** The session key is no longer valid and the client has to log in again. */
	SESSION_EXPIRED: 523,
} as const;

export interface MocaColumn {
	name: string;
	type?: string;
	length?: number;
}

export type MocaValue = string | number | null | MocaResultSet;

export interface MocaResultSet {
	columns: MocaColumn[];
	rows: Array<Record<string, MocaValue>>;
}

export interface MocaResponse extends MocaResultSet {
	status: number;
	message: string | null;
}

export interface MocaEnvironment {
	[name: string]: string | undefined;
}

export interface BuildRequestOptions {
	query: string;
	environment?: MocaEnvironment;
	autocommit?: boolean;
}

/**
 * Builds a `<moca-request>` document.
 *
 * Environment variables become `<var name="..." value="..."/>` entries, which is how
 * MOCA receives USR_ID, SESSION_KEY, DEVCOD, WH_ID and LOCALE_ID.
 */
export function buildMocaRequest(options: BuildRequestOptions): string {
	const { query, environment = {}, autocommit = true } = options;

	const vars = Object.entries(environment)
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(
			([name, value]) =>
				`    <var name="${escapeXmlAttribute(name)}" value="${escapeXmlAttribute(String(value))}"/>`,
		);

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<moca-request autocommit="${autocommit ? 'true' : 'false'}">`,
		'  <environment>',
		...vars,
		'  </environment>',
		`  <query>${escapeXmlText(query)}</query>`,
		'</moca-request>',
		'',
	].join('\n');
}

/**
 * Escapes a value for use inside a single quoted MOCA/SQL string literal.
 * MOCA follows SQL: a literal single quote is written twice.
 */
export function quoteMocaLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Prefixes a command with a `publish data` clause so that user supplied values are
 * bound as MOCA arguments instead of being concatenated into the command text.
 */
export function withPublishedData(command: string, data: Record<string, string>): string {
	const entries = Object.entries(data).filter(([name]) => name.trim() !== '');
	if (entries.length === 0) return command;

	const assignments = entries
		.map(([name, value]) => `${name.trim()} = ${quoteMocaLiteral(value ?? '')}`)
		.join('\n     and ');

	return `publish data\n where ${assignments}\n|\n${command}`;
}

function parseColumns(metadata: XmlNode | undefined): MocaColumn[] {
	if (metadata === undefined) return [];
	return findChildren(metadata, 'column').map((column) => {
		const length = Number.parseInt(column.attributes.length ?? '', 10);
		const parsed: MocaColumn = { name: column.attributes.name ?? '' };
		if (column.attributes.type !== undefined) parsed.type = column.attributes.type;
		if (!Number.isNaN(length)) parsed.length = length;
		return parsed;
	});
}

function isNullField(field: XmlNode): boolean {
	const flag = (field.attributes.null ?? field.attributes.nil ?? '').toLowerCase();
	if (flag === 'true' || flag === '1' || flag === 'yes') return true;
	return !field.hasText && field.children.length === 0;
}

function parseResults(results: XmlNode | undefined): MocaResultSet {
	if (results === undefined) return { columns: [], rows: [] };

	const columns = parseColumns(findChild(results, 'metadata'));
	const data = findChild(results, 'data');
	const rowNodes = data === undefined ? [] : findChildren(data, 'row');

	const rows = rowNodes.map((rowNode) => {
		const row: Record<string, MocaValue> = {};
		// MOCA joins can return the same column name more than once (`list warehouses`
		// returns is_purged twice). Suffix the repeats so no value is lost.
		const timesSeen = new Map<string, number>();

		findChildren(rowNode, 'field').forEach((field, position) => {
			const name = columns[position]?.name ?? field.attributes.name ?? `field_${position + 1}`;
			const occurrence = (timesSeen.get(name) ?? 0) + 1;
			timesSeen.set(name, occurrence);
			const key = occurrence === 1 ? name : `${name}_${occurrence}`;
			const nested = findChild(field, 'moca-results');
			if (nested !== undefined) {
				row[key] = parseResults(nested);
			} else {
				row[key] = isNullField(field) ? null : field.text;
			}
		});
		return row;
	});

	return { columns, rows };
}

/** Parses a raw `<moca-response>` document. */
export function parseMocaResponse(xml: string): MocaResponse {
	const document = parseXml(xml);
	const response = findChild(document, 'moca-response') ?? document.children[0] ?? document;

	const statusNode = findChild(response, 'status');
	const status = Number.parseInt(statusNode?.text.trim() ?? '', 10);
	const messageNode = findChild(response, 'message');
	const results = findChild(response, 'moca-results') ?? findDescendant(response, 'moca-results');

	return {
		status: Number.isNaN(status) ? -1 : status,
		message: messageNode === undefined ? null : messageNode.text.trim(),
		...parseResults(results),
	};
}

const NUMERIC_TYPES = new Set(['I', 'F', 'N', 'L', 'J', 'INTEGER', 'FLOAT', 'NUMBER', 'LONG']);

/**
 * Row keys for a column list, applying the same suffixing that `parseResults` uses for
 * repeated column names so both refer to the same fields.
 */
function rowKeys(columns: MocaColumn[]): string[] {
	const timesSeen = new Map<string, number>();
	return columns.map((column) => {
		const occurrence = (timesSeen.get(column.name) ?? 0) + 1;
		timesSeen.set(column.name, occurrence);
		return occurrence === 1 ? column.name : `${column.name}_${occurrence}`;
	});
}

/** Best effort numeric conversion driven by the `type` attribute in the response metadata. */
export function convertNumericColumns(resultSet: MocaResultSet): Array<Record<string, MocaValue>> {
	const keys = rowKeys(resultSet.columns);
	const numericColumns = new Set(
		keys.filter((_, index) =>
			NUMERIC_TYPES.has((resultSet.columns[index].type ?? '').toUpperCase()),
		),
	);
	if (numericColumns.size === 0) return resultSet.rows;

	return resultSet.rows.map((row) => {
		const converted: Record<string, MocaValue> = {};
		for (const [key, value] of Object.entries(row)) {
			if (numericColumns.has(key) && typeof value === 'string' && value.trim() !== '') {
				const asNumber = Number(value);
				converted[key] = Number.isNaN(asNumber) ? value : asNumber;
			} else {
				converted[key] = value;
			}
		}
		return converted;
	});
}
