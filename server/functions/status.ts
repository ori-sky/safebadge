import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	BatchGetCommand,
	DynamoDBDocumentClient
} from '@aws-sdk/lib-dynamodb';
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyStructuredResultV2
} from 'aws-lambda';

const MAX_BODY_BYTES = 16 * 1_024;
const MAX_LOGINS = 100;
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;
const configuredTableName = process.env['TABLE_NAME'];
if(!configuredTableName) throw new Error('Missing environment variable: TABLE_NAME');
const tableName = configuredTableName;

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
	try {
		const logins = parseLogins(event);
		const safeLogins = await getSafeLogins(logins);
		const results = Object.fromEntries(
			logins.map(login => [login, safeLogins.has(login)])
		);

		return jsonResponse(200, {
			results,
			cacheForSeconds: 300
		});
	} catch(error) {
		if(error instanceof RequestError) {
			return jsonResponse(400, { error: error.message });
		}

		console.error('Status lookup failed', safeError(error));
		return jsonResponse(500, { error: 'Unable to check streamer status' });
	}
}

function parseLogins(event: APIGatewayProxyEventV2): string[] {
	if(!event.body) throw new RequestError('Request body is required');

	const rawBody = event.isBase64Encoded
		? Buffer.from(event.body, 'base64').toString('utf8')
		: event.body;

	if(Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
		throw new RequestError('Request body is too large');
	}

	let logins: unknown;
	try {
		logins = (JSON.parse(rawBody) as { logins?: unknown } | null)?.logins;
	} catch {
		throw new RequestError('Request body must be valid JSON');
	}

	if(!Array.isArray(logins)) {
		throw new RequestError('logins must be an array');
	}

	if(logins.length > MAX_LOGINS) {
		throw new RequestError(`No more than ${MAX_LOGINS} logins may be checked at once`);
	}

	const normalized = logins.map(value => {
		if(typeof value !== 'string') {
			throw new RequestError('Every login must be a string');
		}
		const login = value.trim().toLowerCase();
		if(!TWITCH_LOGIN.test(login)) {
			throw new RequestError('One or more Twitch logins are invalid');
		}
		return login;
	});

	return [...new Set(normalized)];
}

async function getSafeLogins(logins: string[]): Promise<Set<string>> {
	if(logins.length === 0) return new Set();

	const response = await documentClient.send(new BatchGetCommand({
		RequestItems: {
			[tableName]: {
				Keys: logins.map(login => ({ pk: `LOGIN#${login}` })),
				ProjectionExpression: 'pk, safe, twitchUserId'
			}
		}
	}));

	if((response.UnprocessedKeys?.[tableName]?.Keys?.length ?? 0) > 0) {
		throw new Error('DynamoDB did not process every requested login');
	}

	const safeLogins = new Set<string>();
	for(const item of response.Responses?.[tableName] ?? []) {
		const { safe, twitchUserId, pk } = item;
		if(
			safe === true
			&& typeof twitchUserId === 'string'
			&& typeof pk === 'string'
			&& pk.startsWith('LOGIN#')
		) {
			safeLogins.add(pk.slice('LOGIN#'.length));
		}
	}
	return safeLogins;
}

function jsonResponse(
	statusCode: number,
	body: unknown
): APIGatewayProxyStructuredResultV2 {
	return {
		statusCode,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		},
		body: JSON.stringify(body)
	};
}

function safeError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: 'UnknownError', message: 'Unknown error' };
}

class RequestError extends Error {}
