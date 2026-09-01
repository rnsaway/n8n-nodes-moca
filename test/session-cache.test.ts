import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MocaCredentials } from '../nodes/Moca/transport';
import {
	MocaConnection,
	cachedSessionCount,
	clearSessionCache,
} from '../nodes/Moca/transport';

const node = { id: '1', name: 'MOCA', type: 'moca', typeVersion: 1, position: [0, 0] } as never;

function loginResponse(sessionKey: string): string {
	return `<moca-response><status>0</status><moca-results>
	  <metadata>
	    <column name="usr_id" type="S"/>
	    <column name="locale_id" type="S"/>
	    <column name="session_key" type="S"/>
	  </metadata>
	  <data><row><field>SUPER</field><field>US_ENGLISH</field><field>${sessionKey}</field></row></data>
	 </moca-results></moca-response>`;
}

const OK = '<moca-response><status>0</status></moca-response>';
const EXPIRED = '<moca-response><status>523</status><message>expired</message></moca-response>';

const baseCredentials: MocaCredentials = {
	url: 'https://moca.test/service',
	username: 'SUPER',
	password: 'secret',
};

/** Records every request body and answers logins with an incrementing session key. */
function makeServer(options: { commandResponses?: string[] } = {}) {
	const bodies: string[] = [];
	let logins = 0;
	const queued = [...(options.commandResponses ?? [])];

	const request = async (requestOptions: { body?: unknown }) => {
		const body = String(requestOptions.body);
		bodies.push(body);
		if (body.includes('login user')) {
			logins += 1;
			return loginResponse(`SESSION-${logins}`);
		}
		return queued.shift() ?? OK;
	};

	return {
		request,
		bodies,
		get logins() {
			return logins;
		},
		get commands() {
			return bodies.filter((body) => !body.includes('login user'));
		},
	};
}

function connect(server: { request: never }, overrides: Partial<MocaCredentials> = {}) {
	return new MocaConnection(server.request, node, { ...baseCredentials, ...overrides });
}

describe('session cache', () => {
	beforeEach(() => {
		clearSessionCache();
		vi.useRealTimers();
	});

	it('logs in once and serves later connections from the cache', async () => {
		const server = makeServer();

		await connect(server as never).execute('list warehouses');
		await connect(server as never).execute('list warehouses');
		await connect(server as never).execute('list warehouses');

		expect(server.logins).toBe(1);
		expect(server.commands).toHaveLength(3);
		for (const command of server.commands) {
			expect(command).toContain('value="SESSION-1"');
		}
	});

	it('does not reuse a session across different credentials', async () => {
		const server = makeServer();

		await connect(server as never).execute('list warehouses');
		await connect(server as never, { username: 'OTHER' }).execute('list warehouses');
		await connect(server as never, { url: 'https://other.test/service' }).execute('list warehouses');

		expect(server.logins).toBe(3);
		expect(cachedSessionCount()).toBe(3);
	});

	it('invalidates the cache when the password changes', async () => {
		const server = makeServer();

		await connect(server as never).execute('list warehouses');
		expect(server.logins).toBe(1);

		await connect(server as never, { password: 'rotated' }).execute('list warehouses');
		expect(server.logins).toBe(2);
	});

	it('logs in again once the cached session passes its max age', async () => {
		vi.useFakeTimers();
		const server = makeServer();

		await connect(server as never, { sessionMaxAgeMinutes: 30 }).execute('list warehouses');
		expect(server.logins).toBe(1);

		vi.advanceTimersByTime(29 * 60 * 1000);
		await connect(server as never, { sessionMaxAgeMinutes: 30 }).execute('list warehouses');
		expect(server.logins).toBe(1);

		vi.advanceTimersByTime(2 * 60 * 1000);
		await connect(server as never, { sessionMaxAgeMinutes: 30 }).execute('list warehouses');
		expect(server.logins).toBe(2);
	});

	it('keeps a session indefinitely when max age is zero', async () => {
		vi.useFakeTimers();
		const server = makeServer();

		await connect(server as never, { sessionMaxAgeMinutes: 0 }).execute('list warehouses');
		vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
		await connect(server as never, { sessionMaxAgeMinutes: 0 }).execute('list warehouses');

		expect(server.logins).toBe(1);
	});

	it('replaces a rejected session and retries the command', async () => {
		// First command is answered 523; the retry must use a brand new session.
		const server = makeServer({ commandResponses: [EXPIRED, OK] });

		const response = await connect(server as never).execute('list warehouses');

		expect(response.status).toBe(0);
		expect(server.logins).toBe(2);
		expect(server.commands[0]).toContain('value="SESSION-1"');
		expect(server.commands[1]).toContain('value="SESSION-2"');
		expect(cachedSessionCount()).toBe(1);
	});

	it('collapses a concurrent cold start into a single login', async () => {
		const server = makeServer();

		await Promise.all([
			connect(server as never).execute('list warehouses'),
			connect(server as never).execute('list warehouses'),
			connect(server as never).execute('list warehouses'),
			connect(server as never).execute('list warehouses'),
			connect(server as never).execute('list warehouses'),
		]);

		expect(server.logins).toBe(1);
		expect(server.commands).toHaveLength(5);
	});

	it('lets every concurrent caller see a failed login', async () => {
		const request = async () =>
			'<moca-response><status>523</status><message>Invalid user</message></moca-response>';

		const results = await Promise.allSettled([
			new MocaConnection(request, node, baseCredentials).execute('list warehouses'),
			new MocaConnection(request, node, baseCredentials).execute('list warehouses'),
		]);

		for (const result of results) {
			expect(result.status).toBe('rejected');
		}
		expect(cachedSessionCount()).toBe(0);
	});

	it('recovers after a failed login rather than caching the failure', async () => {
		let failNext = true;
		const bodies: string[] = [];
		const request = async (options: { body?: unknown }) => {
			const body = String(options.body);
			bodies.push(body);
			if (body.includes('login user')) {
				if (failNext) {
					failNext = false;
					return '<moca-response><status>523</status><message>nope</message></moca-response>';
				}
				return loginResponse('SESSION-OK');
			}
			return OK;
		};

		await expect(
			new MocaConnection(request, node, baseCredentials).execute('list warehouses'),
		).rejects.toThrow(/MOCA login failed/);

		const response = await new MocaConnection(request, node, baseCredentials).execute(
			'list warehouses',
		);
		expect(response.status).toBe(0);
	});

	it('logs in every time when session reuse is switched off', async () => {
		const server = makeServer();

		await connect(server as never, { reuseSession: false }).execute('list warehouses');
		await connect(server as never, { reuseSession: false }).execute('list warehouses');

		expect(server.logins).toBe(2);
		expect(cachedSessionCount()).toBe(0);
	});

	it('always performs a real login for Test Connection and refreshes the cache', async () => {
		const server = makeServer();

		await connect(server as never).execute('list warehouses');
		expect(server.logins).toBe(1);

		// Test Connection must reach the server rather than report a cached success.
		const response = await connect(server as never).login();
		expect(response.status).toBe(0);
		expect(server.logins).toBe(2);

		await connect(server as never).execute('list warehouses');
		expect(server.logins).toBe(2);
		expect(server.commands[server.commands.length - 1]).toContain('value="SESSION-2"');
	});
});
