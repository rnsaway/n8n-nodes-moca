import { beforeEach, describe, expect, it } from 'vitest';

import { MocaConnection, clearSessionCache } from '../nodes/Moca/transport';
import {
	MOCA_STATUS,
	buildMocaRequest,
	convertNumericColumns,
	parseMocaResponse,
	quoteMocaLiteral,
	withPublishedData,
} from '../nodes/Moca/transport/protocol';
import { parseXml } from '../nodes/Moca/transport/xml';

const node = { id: '1', name: 'MOCA', type: 'moca', typeVersion: 1, position: [0, 0] } as never;

const loginResponse = `<?xml version="1.0" encoding="UTF-8"?>
<moca-response>
  <status>0</status>
  <moca-results>
    <metadata>
      <column name="usr_id" type="S" length="30"/>
      <column name="locale_id" type="S" length="10"/>
      <column name="usr_nam" type="S" length="40"/>
      <column name="wh_id" type="S" length="10"/>
      <column name="session_key" type="S" length="64"/>
    </metadata>
    <data>
      <row>
        <field>SUPER</field>
        <field>US_ENGLISH</field>
        <field>Super User</field>
        <field>WMD1</field>
        <field>ABC123SESSION</field>
      </row>
    </data>
  </moca-results>
</moca-response>`;

describe('parseXml', () => {
	it('keeps attribute values that contain angle brackets', () => {
		const document = parseXml('<a b="1 &gt; 0" c=\'x&amp;y\'><child/></a>');
		const a = document.children[0];
		expect(a.attributes).toEqual({ b: '1 > 0', c: 'x&y' });
		expect(a.children[0].name).toBe('child');
	});

	it('reads CDATA without decoding entities twice', () => {
		const document = parseXml('<f><![CDATA[a & b <tag>]]></f>');
		expect(document.children[0].text).toBe('a & b <tag>');
	});

	it('distinguishes an empty element from one holding whitespace', () => {
		const document = parseXml('<row><field/><field></field><field> </field></row>');
		const [first, second, third] = document.children[0].children;
		expect(first.hasText).toBe(false);
		expect(second.hasText).toBe(false);
		expect(third.hasText).toBe(true);
	});
});

describe('buildMocaRequest', () => {
	it('writes the environment variables and escapes the query', () => {
		const xml = buildMocaRequest({
			query: "list warehouses where wh_id = 'A&B'",
			environment: { USR_ID: 'SUPER', SESSION_KEY: 'KEY', DEVCOD: undefined, WH_ID: '' },
			autocommit: false,
		});

		expect(xml).toContain('<moca-request autocommit="false">');
		expect(xml).toContain('<var name="USR_ID" value="SUPER"/>');
		expect(xml).toContain('<var name="SESSION_KEY" value="KEY"/>');
		expect(xml).not.toContain('DEVCOD');
		expect(xml).not.toContain('WH_ID');
		expect(xml).toContain('&amp;');
		expect(parseXml(xml).children[0].name).toBe('moca-request');
	});

	it('leaves quotes in MOCA string literals untouched and survives a round trip', () => {
		const query = "list warehouses where wh_id = 'O''Brien & <Sons>'";
		const xml = buildMocaRequest({ query, environment: { USR_ID: 'SUPER' } });

		expect(xml).not.toContain('&apos;');
		expect(xml).toContain('&amp;');
		expect(xml).toContain('&lt;Sons&gt;');

		const parsed = parseXml(xml).children[0];
		expect(parsed.children.find((child) => child.name === 'query')?.text).toBe(query);
	});

	it('escapes double quotes inside environment values', () => {
		const xml = buildMocaRequest({ query: 'noop', environment: { WH_ID: 'a"b' } });
		expect(xml).toContain('value="a&quot;b"');
		expect(parseXml(xml).children[0].children[0].children[0].attributes.value).toBe('a"b');
	});
});

describe('command helpers', () => {
	it('doubles single quotes in literals', () => {
		expect(quoteMocaLiteral("O'Brien")).toBe("'O''Brien'");
	});

	it('publishes arguments ahead of the command', () => {
		const command = withPublishedData('list warehouses where wh_id = @wh_id', { wh_id: "W'1" });
		expect(command).toContain("wh_id = 'W''1'");
		expect(command.trim().endsWith('list warehouses where wh_id = @wh_id')).toBe(true);
		expect(command).toContain('|');
	});

	it('leaves the command untouched when there are no arguments', () => {
		expect(withPublishedData('list warehouses', {})).toBe('list warehouses');
	});

});

describe('parseMocaResponse', () => {
	it('maps columns onto row fields', () => {
		const response = parseMocaResponse(loginResponse);
		expect(response.status).toBe(MOCA_STATUS.OK);
		expect(response.columns.map((column) => column.name)).toEqual([
			'usr_id',
			'locale_id',
			'usr_nam',
			'wh_id',
			'session_key',
		]);
		expect(response.rows[0].session_key).toBe('ABC123SESSION');
	});

	it('returns the error message for a failed command', () => {
		const response = parseMocaResponse(
			'<moca-response><status>523</status><message>Session expired</message></moca-response>',
		);
		expect(response.status).toBe(MOCA_STATUS.SESSION_EXPIRED);
		expect(response.message).toBe('Session expired');
		expect(response.rows).toEqual([]);
	});

	it('treats empty fields as null', () => {
		const response = parseMocaResponse(
			`<moca-response><status>0</status><moca-results>
			  <metadata><column name="a" type="S"/><column name="b" type="S"/></metadata>
			  <data><row><field>x</field><field/></row></data>
			 </moca-results></moca-response>`,
		);
		expect(response.rows[0]).toEqual({ a: 'x', b: null });
	});

	it('keeps every value when a column name repeats', () => {
		// `list warehouses` on a real MOCA server returns is_purged twice.
		const response = parseMocaResponse(
			`<moca-response><status>0</status><moca-results>
			  <metadata>
			    <column name="wh_id" type="S"/>
			    <column name="is_purged" type="I"/>
			    <column name="is_purged" type="I"/>
			  </metadata>
			  <data><row><field>WMD1</field><field>0</field><field>1</field></row></data>
			 </moca-results></moca-response>`,
		);
		expect(response.rows[0]).toEqual({ wh_id: 'WMD1', is_purged: '0', is_purged_2: '1' });
	});

	it('parses nested result sets', () => {
		const response = parseMocaResponse(
			`<moca-response><status>0</status><moca-results>
			  <metadata><column name="outer" type="S"/></metadata>
			  <data><row><field><moca-results>
			    <metadata><column name="inner" type="S"/></metadata>
			    <data><row><field>nested</field></row></data>
			  </moca-results></field></row></data>
			 </moca-results></moca-response>`,
		);
		expect(response.rows[0].outer).toEqual({
			columns: [{ name: 'inner', type: 'S' }],
			rows: [{ inner: 'nested' }],
		});
	});
});

describe('convertNumericColumns', () => {
	it('only converts columns the server reports as numeric', () => {
		const rows = convertNumericColumns({
			columns: [
				{ name: 'qty', type: 'I' },
				{ name: 'item', type: 'S' },
			],
			rows: [{ qty: '12', item: '0042' }],
		});
		expect(rows[0]).toEqual({ qty: 12, item: '0042' });
	});

	it('converts repeated numeric columns consistently', () => {
		// Both occurrences describe the same numeric column, so both must convert.
		const rows = convertNumericColumns({
			columns: [
				{ name: 'wh_id', type: 'S' },
				{ name: 'is_purged', type: 'I' },
				{ name: 'is_purged', type: 'I' },
			],
			rows: [{ wh_id: 'WMD1', is_purged: '0', is_purged_2: '1' }],
		});
		expect(rows[0]).toEqual({ wh_id: 'WMD1', is_purged: 0, is_purged_2: 1 });
	});
});

describe('MocaConnection', () => {
	beforeEach(() => clearSessionCache());

	it('logs in once and reuses the session key', async () => {
		const bodies: string[] = [];
		const request = async (options: { body?: unknown }) => {
			bodies.push(String(options.body));
			return bodies.length === 1
				? loginResponse
				: '<moca-response><status>0</status></moca-response>';
		};

		const connection = new MocaConnection(request, node, {
			url: 'https://moca.test/service',
			username: 'SUPER',
			password: 'secret',
		});

		await connection.execute('list warehouses');
		await connection.execute('list warehouses');

		expect(bodies).toHaveLength(3);
		expect(bodies[0]).toContain('login user');
		expect(bodies[1]).toContain('value="ABC123SESSION"');
		expect(bodies[2]).toContain('value="ABC123SESSION"');
	});

	it('re-authenticates and retries once on status 523', async () => {
		const bodies: string[] = [];
		const request = async (options: { body?: unknown }) => {
			const body = String(options.body);
			bodies.push(body);
			if (body.includes('login user')) return loginResponse;
			return bodies.filter((entry) => !entry.includes('login user')).length === 1
				? '<moca-response><status>523</status><message>expired</message></moca-response>'
				: '<moca-response><status>0</status></moca-response>';
		};

		const connection = new MocaConnection(request, node, {
			url: 'https://moca.test/service',
			username: 'SUPER',
			password: 'secret',
		});

		const response = await connection.execute('list warehouses');
		expect(response.status).toBe(MOCA_STATUS.OK);
		expect(bodies.filter((entry) => entry.includes('login user'))).toHaveLength(2);
	});

	it('fails with the server message when the login is rejected', async () => {
		const request = async () =>
			'<moca-response><status>523</status><message>Invalid user</message></moca-response>';
		const connection = new MocaConnection(request, node, {
			url: 'https://moca.test/service',
			username: 'SUPER',
			password: 'wrong',
		});

		await expect(connection.login()).rejects.toThrow(/MOCA login failed \(status 523\)/);
	});
});
