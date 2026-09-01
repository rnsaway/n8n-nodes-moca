import type {
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * `login user` as a MOCA XML request, built from the credential fields.
 *
 * Written as concatenated JavaScript so each fragment can be quoted with whichever
 * quote character it does not itself contain: XML attributes hold double quotes, MOCA
 * string literals hold single quotes. Single quotes inside a value are doubled, the
 * same escaping `quoteMocaLiteral` performs in the transport.
 */
const LOGIN_TEST_BODY =
	`={{ '<?xml version="1.0" encoding="UTF-8"?><moca-request autocommit="false">'` +
	` + '<environment><var name="USR_ID" value="' + $credentials.username + '"/></environment>'` +
	` + '<query>login user where usr_id = ' + "'" + $credentials.username.replace(/'/g, "''") + "'"` +
	` + ' and usr_pswd = ' + "'" + $credentials.password.replace(/'/g, "''") + "'"` +
	` + '</query></moca-request>' }}`;

export class MocaApi implements ICredentialType {
	name = 'mocaApi';

	displayName = 'MOCA API';

	icon: Icon = { light: 'file:../nodes/Moca/moca.svg', dark: 'file:../nodes/Moca/moca.dark.svg' };

	documentationUrl = 'https://docs.n8n.io/integrations/community-nodes/';

	properties: INodeProperties[] = [
		{
			displayName: 'Service URL',
			name: 'url',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://moca.example.com:4700/service',
			description:
				'Full URL of the MOCA server endpoint that accepts application/moca-xml requests',
		},
		{
			displayName: 'User ID',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			description: 'MOCA user ID (USR_ID) used to log in',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Password for the MOCA user',
		},
		{
			displayName: 'Warehouse ID',
			name: 'warehouse',
			type: 'string',
			default: '',
			placeholder: 'WMD1',
			description: 'Optional WH_ID environment variable sent with every command',
		},
		{
			displayName: 'Device',
			name: 'device',
			type: 'string',
			default: '',
			description: 'Optional DEVCOD environment variable sent with every command',
		},
		{
			displayName: 'Locale',
			name: 'locale',
			type: 'string',
			default: '',
			placeholder: 'US_ENGLISH',
			description:
				'Optional LOCALE_ID environment variable. Leave empty to use the locale returned at login.',
		},
		{
			displayName: 'Ignore SSL Issues',
			name: 'ignoreSslIssues',
			type: 'boolean',
			default: false,
			description:
				'Whether to connect even when SSL certificate validation fails, which is common for MOCA servers using self-signed certificates',
		},
		{
			displayName: 'Request Timeout (Ms)',
			name: 'timeout',
			type: 'number',
			default: 300000,
			typeOptions: { minValue: 1000 },
			description: 'How long to wait for the MOCA server before failing the request',
		},
		{
			displayName: 'Reuse Session',
			name: 'reuseSession',
			type: 'boolean',
			default: true,
			description:
				'Whether to reuse a MOCA session across executions instead of logging in every time. Sessions are held in memory only. An expired session is detected and replaced automatically, so turning this off only costs an extra login per execution.',
		},
		{
			displayName: 'Session Max Age (Minutes)',
			name: 'sessionMaxAgeMinutes',
			type: 'number',
			default: 30,
			typeOptions: { minValue: 0 },
			description:
				'How long a cached session may be reused before logging in again. Set to 0 to reuse it until the server rejects it.',
			displayOptions: { show: { reuseSession: [true] } },
		},
	];

	/**
	 * Declarative credential test: posts a real `login user` to the service URL.
	 *
	 * MOCA answers a rejected login with HTTP 200 and reports the failure inside the
	 * document (`<status>1000</status>`, "User login is invalid."), and a rule of type
	 * `responseSuccessBody` indexes into a parsed body, which an XML string is not. So
	 * this confirms the URL is reachable and speaks MOCA; it cannot by itself tell a
	 * wrong password from a right one.
	 *
	 * The authoritative check is the node's `mocaApiTest` handler, wired up through
	 * `testedBy` on the Moca node, which parses the status and surfaces MOCA's own
	 * message. n8n uses that one whenever the credential is tested from the node.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'POST',
			url: '={{$credentials.url}}',
			skipSslCertificateValidation: '={{$credentials.ignoreSslIssues}}',
			headers: {
				'Content-Type': 'application/moca-xml',
				Accept: 'application/moca-xml',
			},
			body: LOGIN_TEST_BODY,
		},
	};
}
