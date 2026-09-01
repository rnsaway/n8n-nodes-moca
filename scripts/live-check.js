#!/usr/bin/env node
/**
 * Validates this node's MOCA transport against a real MOCA server.
 *
 * It drives the exact compiled code the n8n node uses (dist/nodes/Moca/transport),
 * so a green run here means the node will behave the same inside n8n.
 *
 * Configure with moca.local.json (gitignored) in the project root:
 *
 *   {
 *     "url": "https://moca.example.com:4700/service",
 *     "username": "SUPER",
 *     "password": "...",
 *     "warehouse": "WMD1",
 *     "ignoreSslIssues": true
 *   }
 *
 * or with MOCA_URL / MOCA_USER / MOCA_PASSWORD / MOCA_WAREHOUSE / MOCA_IGNORE_SSL.
 *
 * Usage:
 *   node scripts/live-check.js                       run the standard checks
 *   node scripts/live-check.js -c "list warehouses"   run one command and print the rows
 *   node scripts/live-check.js --raw -c "..."         also print the raw request/response XML
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist/nodes/Moca/transport');

if (!fs.existsSync(dist)) {
	console.error('dist/ is missing. Run `npm run build` first.');
	process.exit(1);
}

const { MocaConnection } = require(path.join(dist, 'index.js'));
const { MOCA_STATUS } = require(path.join(dist, 'protocol.js'));

// ---------------------------------------------------------------- config ----

function loadCredentials() {
	const file = path.join(root, 'moca.local.json');
	const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};

	const credentials = {
		url: process.env.MOCA_URL || fromFile.url,
		username: process.env.MOCA_USER || fromFile.username,
		password: process.env.MOCA_PASSWORD || fromFile.password,
		warehouse: process.env.MOCA_WAREHOUSE || fromFile.warehouse,
		device: process.env.MOCA_DEVICE || fromFile.device,
		locale: process.env.MOCA_LOCALE || fromFile.locale,
		ignoreSslIssues:
			process.env.MOCA_IGNORE_SSL === 'true' || fromFile.ignoreSslIssues === true,
		timeout: Number(process.env.MOCA_TIMEOUT || fromFile.timeout || 60000),
	};

	const missing = ['url', 'username', 'password'].filter((key) => !credentials[key]);
	if (missing.length > 0) {
		console.error(
			`Missing ${missing.join(', ')}. Create moca.local.json in ${root} or set MOCA_URL / MOCA_USER / MOCA_PASSWORD.`,
		);
		process.exit(1);
	}
	return credentials;
}

// --------------------------------------------------------------- request ----

const traffic = [];

/**
 * Masks MOCA password literals before any XML is printed or logged, so a failing
 * login cannot leak the credential into terminal output.
 */
function redact(xml) {
	return String(xml).replace(
		/(usr_pswd\s*=\s*')(?:[^']|'')*(')/gi,
		'$1********$2',
	);
}

function makeRequester(showRaw) {
	return async function request(options) {
		const target = new URL(options.url);
		const client = target.protocol === 'https:' ? https : http;

		return await new Promise((resolve, reject) => {
			const req = client.request(
				{
					protocol: target.protocol,
					hostname: target.hostname,
					port: target.port,
					path: `${target.pathname}${target.search}`,
					method: options.method,
					headers: {
						...options.headers,
						'Content-Length': Buffer.byteLength(options.body),
					},
					rejectUnauthorized: options.skipSslCertificateValidation !== true,
					timeout: options.timeout,
				},
				(res) => {
					const chunks = [];
					res.on('data', (chunk) => chunks.push(chunk));
					res.on('end', () => {
						const text = Buffer.concat(chunks).toString('utf8');
						traffic.push({ status: res.statusCode, request: options.body, response: text });
						if (showRaw) {
							console.log('\n--- request ---\n' + redact(options.body));
							console.log(`--- response (HTTP ${res.statusCode}) ---\n` + redact(text));
						}
						resolve(text);
					});
				},
			);
			req.on('timeout', () => req.destroy(new Error('request timed out')));
			req.on('error', reject);
			req.end(options.body);
		});
	};
}

// ----------------------------------------------------------------- output ----

function printResult(label, response) {
	const statusLabel =
		response.status === MOCA_STATUS.OK
			? 'OK'
			: response.status === MOCA_STATUS.NO_ROWS
				? 'no rows'
				: 'error';
	console.log(`\n${label}`);
	console.log(`  status ${response.status} (${statusLabel})`);
	if (response.message) console.log(`  message: ${response.message}`);
	if (response.columns.length > 0) {
		console.log(
			`  columns: ${response.columns.map((c) => `${c.name}${c.type ? ':' + c.type : ''}`).join(', ')}`,
		);
	}
	console.log(`  rows: ${response.rows.length}`);
	for (const row of response.rows.slice(0, 5)) {
		// A session key is a live credential - never print it.
		const safe = {};
		for (const [key, value] of Object.entries(row)) {
			safe[key] = key.toLowerCase().includes('session') ? '********' : value;
		}
		console.log('    ' + JSON.stringify(safe));
	}
	if (response.rows.length > 5) console.log(`    ... ${response.rows.length - 5} more`);
}

// ------------------------------------------------------------------- main ----

async function main() {
	const argv = process.argv.slice(2);
	const showRaw = argv.includes('--raw');
	const commandIndex = Math.max(argv.indexOf('-c'), argv.indexOf('--command'));
	const oneOff = commandIndex === -1 ? null : argv[commandIndex + 1];

	const credentials = loadCredentials();
	const node = { id: '1', name: 'MOCA', type: 'moca', typeVersion: 1, position: [0, 0] };
	const connection = new MocaConnection(makeRequester(showRaw), node, credentials);

	console.log(`MOCA live check -> ${credentials.url} as ${credentials.username}`);
	if (credentials.warehouse) console.log(`warehouse: ${credentials.warehouse}`);

	// 1. login
	const login = await connection.login();
	printResult('1. login user', login);
	const loginColumns = login.columns.map((c) => c.name.toLowerCase());
	if (!loginColumns.includes('session_key')) {
		console.log(
			'  NOTE: no session_key column by name; the node fell back to the positional field 5.',
		);
	}
	console.log('  session key captured:', connection.isLoggedIn);

	if (oneOff !== null) {
		printResult(`2. ${oneOff}`, await connection.execute(oneOff));
		console.log('\nDone.');
		return;
	}

	// 2. a read-only MOCA command
	printResult('2. list warehouses', await connection.execute('list warehouses'));

	// 3. local syntax passthrough
	printResult(
		'3. local syntax [select ... from wh]',
		await connection.execute('[select wh_id from wh]'),
	);

	// 4. a command that should return no rows -> status 510, not an error
	printResult(
		'4. no-rows path',
		await connection.execute("[select wh_id from wh where wh_id = 'ZZ_NO_SUCH_WAREHOUSE']"),
	);

	// 5. an unknown command -> the node must surface the server message
	printResult(
		'5. unknown command (expected to fail)',
		await connection.execute('this_command_does_not_exist'),
	);

	// 6. published argument binding
	printResult(
		'6. published argument',
		await connection.execute(
			"publish data\n where wh_id = 'A''B'\n|\n[select @wh_id as echoed from dual]",
		),
	);

	// 7. credential values reaching the command as MOCA environment globals.
	// An unset variable resolves to null rather than failing, so a misspelt name is
	// silently empty - which is exactly why this is worth asserting against a server.
	printResult(
		'7. environment globals (@@)',
		await connection.execute(
			'publish data where env_usr = @@usr_id and env_wh = @@wh_id and env_locale = @@locale_id',
		),
	);

	console.log('\nDone. Re-run with --raw to see the request/response XML.');
}

main().catch((error) => {
	console.error('\nLIVE CHECK FAILED:', error.message);
	const last = traffic[traffic.length - 1];
	if (last) {
		console.error('\nlast request:\n' + redact(last.request));
		console.error(`\nlast response (HTTP ${last.status}):\n` + redact(last.response).slice(0, 4000));
	}
	process.exit(1);
});
