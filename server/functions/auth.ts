import {
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	TransactWriteCommand,
	type TransactWriteCommandInput
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type {
	APIGatewayProxyEventV2,
	APIGatewayProxyStructuredResultV2
} from 'aws-lambda';
import {
	createHash,
	randomBytes,
	timingSafeEqual
} from 'node:crypto';

const TWITCH_AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const TWITCH_REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';

const OAUTH_COOKIE = '__Host-safetwitch_oauth';
const OAUTH_LIFETIME_SECONDS = 10 * 60;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const TWITCH_USER_ID = /^\d+$/;
const TWITCH_LOGIN = /^[a-z0-9_]{1,25}$/;

const tableName = requiredEnvironment('TABLE_NAME');
const callbackUrl = requiredEnvironment('CALLBACK_URL');
const siteUrl = new URL(callbackUrl).origin;
const clientIdParameter = requiredEnvironment('TWITCH_CLIENT_ID_PARAMETER');
const clientSecretParameter = requiredEnvironment('TWITCH_CLIENT_SECRET_PARAMETER');

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});

interface TwitchCredentials {
	clientId: string;
	clientSecret: string;
}

interface TokenResponse {
	access_token: string;
}

interface ValidationResponse {
	client_id: string;
	login: string;
	scopes: string[] | null;
	user_id: string;
	expires_in: number;
}

let cachedCredentials: TwitchCredentials | undefined;

export async function handler(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
	try {
		if(event.routeKey === 'GET /auth/twitch/start') {
			return await startAuthorization();
		}

		if(event.routeKey === 'GET /auth/twitch/callback') {
			return await finishAuthorization(event);
		}

		return {
			statusCode: 404,
			headers: noStoreHeaders(),
			body: 'Not found'
		};
	} catch(error) {
		console.error('OAuth request failed', safeError(error));
		return redirect(`${siteUrl}/error.html`);
	}
}

async function startAuthorization(): Promise<APIGatewayProxyStructuredResultV2> {
	const credentials = await getTwitchCredentials();
	const state = randomBytes(32).toString('base64url');
	const now = Math.floor(Date.now() / 1_000);

	await documentClient.send(new PutCommand({
		TableName: tableName,
		Item: {
			pk: oauthKey(state),
			kind: 'OAUTH_ATTEMPT',
			ttl: now + OAUTH_LIFETIME_SECONDS
		},
		ConditionExpression: 'attribute_not_exists(pk)'
	}));

	const authorizeUrl = new URL(TWITCH_AUTHORIZE_URL);
	authorizeUrl.search = new URLSearchParams({
		response_type: 'code',
		client_id: credentials.clientId,
		redirect_uri: callbackUrl,
		state,
	}).toString();

	return {
		statusCode: 302,
		headers: {
			...noStoreHeaders(),
			location: authorizeUrl.toString()
		},
		cookies: [oauthCookie(state, OAUTH_LIFETIME_SECONDS)]
	};
}

async function finishAuthorization(
	event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> {
	const query = new URLSearchParams(event.rawQueryString);
	const state = singleQueryValue(query, 'state');
	const cookieState = singleCookieValue(event, OAUTH_COOKIE);

	if(
		!state
		|| !cookieState
		|| !BASE64URL_32_BYTES.test(state)
		|| !BASE64URL_32_BYTES.test(cookieState)
		|| !constantTimeEqual(state, cookieState)
	) {
		throw new Error('Invalid OAuth state');
	}

	await consumeOAuthAttempt(state);

	const oauthError = singleQueryValue(query, 'error');
	if(oauthError) {
		return redirect(`${siteUrl}/error.html`);
	}

	const code = singleQueryValue(query, 'code');
	if(!code || code.length > 512) {
		throw new Error('Missing authorization code');
	}

	const credentials = await getTwitchCredentials();
	const tokens = await exchangeAuthorizationCode(code, credentials);
	const identity = await validateAccessToken(tokens.access_token);

	if(
		identity.client_id !== credentials.clientId
		|| identity.expires_in <= 0
		|| (identity.scopes !== null && identity.scopes.length === 0)
		|| !TWITCH_USER_ID.test(identity.user_id)
		|| !TWITCH_LOGIN.test(identity.login)
	) {
		throw new Error('Twitch identity validation failed');
	}

	await revokeAccessToken(tokens.access_token, credentials.clientId);
	await saveAttestation(identity.user_id, identity.login);

	return redirect(`${siteUrl}/success.html`);
}

async function consumeOAuthAttempt(state: string): Promise<void> {
	const now = Math.floor(Date.now() / 1_000);
	await documentClient.send(new DeleteCommand({
		TableName: tableName,
		Key: { pk: oauthKey(state) },
		ConditionExpression: 'attribute_exists(pk) AND #ttl >= :now',
		ExpressionAttributeNames: { '#ttl': 'ttl' },
		ExpressionAttributeValues: { ':now': now }
	}));
}

async function exchangeAuthorizationCode(
	code: string,
	credentials: TwitchCredentials
): Promise<TokenResponse> {
	const response = await fetch(TWITCH_TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			code,
			grant_type: 'authorization_code',
			redirect_uri: callbackUrl
		}),
		signal: AbortSignal.timeout(5_000)
	});

	if(!response.ok) {
		throw new Error('Twitch token exchange failed');
	}

	const body = await response.json() as Partial<TokenResponse>;
	if(
		typeof body.access_token !== 'string'
		|| body.access_token.length > 4_096
	) {
		throw new Error('Twitch returned an invalid token response');
	}

	return body as TokenResponse;
}
async function validateAccessToken(accessToken: string): Promise<ValidationResponse> {
	const response = await fetch(TWITCH_VALIDATE_URL, {
		headers: { authorization: `OAuth ${accessToken}` },
		signal: AbortSignal.timeout(5_000)
	});

	if(!response.ok) {
		throw new Error('Twitch access token validation failed');
	}

	const body = await response.json() as Partial<ValidationResponse>;
	if(
		typeof body.client_id !== 'string'
		|| typeof body.login !== 'string'
		|| !(
			body.scopes === null
			|| (
				Array.isArray(body.scopes)
				&& body.scopes.every(scope => typeof scope === 'string')
			)
		)
		|| typeof body.user_id !== 'string'
		|| typeof body.expires_in !== 'number'
	) {
		throw new Error('Twitch returned an invalid validation response');
	}

	return body as ValidationResponse;
}

async function revokeAccessToken(accessToken: string, clientId: string): Promise<void> {
	const response = await fetch(TWITCH_REVOKE_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: clientId, token: accessToken }),
		signal: AbortSignal.timeout(5_000)
	});

	if(!response.ok) {
		throw new Error('Twitch access token revocation failed');
	}
}

async function saveAttestation(twitchUserId: string, login: string): Promise<void> {
	const userKey = `USER#${twitchUserId}`;
	const current = await documentClient.send(new GetCommand({
		TableName: tableName,
		Key: { pk: userKey },
		ConsistentRead: true
	}));
	const oldLogin = typeof current.Item?.['login'] === 'string'
		? current.Item['login']
		: undefined;
	const attestedAt = new Date().toISOString();

	const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [];

	if(oldLogin && oldLogin !== login && TWITCH_LOGIN.test(oldLogin)) {
		transactItems.push({
			Delete: {
				TableName: tableName,
				Key: { pk: `LOGIN#${oldLogin}` },
				ConditionExpression: 'attribute_not_exists(pk) OR twitchUserId = :userId',
				ExpressionAttributeValues: { ':userId': twitchUserId }
			}
		});
	}

	transactItems.push(
		{
			Put: {
				TableName: tableName,
				Item: {
					pk: userKey,
					kind: 'USER_ATTESTATION',
					twitchUserId,
					login,
					safe: true,
					attestedAt,
					policyVersion: 1
				}
			}
		},
		{
			Put: {
				TableName: tableName,
				Item: {
					pk: `LOGIN#${login}`,
					kind: 'LOGIN_ATTESTATION',
					twitchUserId,
					safe: true,
					attestedAt,
					policyVersion: 1
				}
			}
		}
	);

	await documentClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
}

async function getTwitchCredentials(): Promise<TwitchCredentials> {
	if(cachedCredentials) return cachedCredentials;

	const response = await ssmClient.send(new GetParametersCommand({
		Names: [clientIdParameter, clientSecretParameter],
		WithDecryption: true
	}));
	const values = new Map(
		response.Parameters?.map(parameter => [parameter.Name, parameter.Value]) ?? []
	);
	const clientId = values.get(clientIdParameter);
	const clientSecret = values.get(clientSecretParameter);

	if(!clientId || !clientSecret) {
		throw new Error('Twitch OAuth is not configured');
	}

	cachedCredentials = { clientId, clientSecret };
	return cachedCredentials;
}

function oauthKey(state: string): string {
	return `OAUTH#${createHash('sha256').update(state).digest('base64url')}`;
}

function singleQueryValue(query: URLSearchParams, name: string): string | undefined {
	const values = query.getAll(name);
	return values.length === 1 ? values[0] : undefined;
}

function singleCookieValue(
	event: APIGatewayProxyEventV2,
	name: string
): string | undefined {
	const cookieHeader = event.headers['cookie'];
	const cookieHeaders = event.cookies ?? (cookieHeader ? [cookieHeader] : []);
	const values: string[] = [];

	for(const header of cookieHeaders) {
		for(const cookie of header.split(';')) {
			const separator = cookie.indexOf('=');
			if(separator < 0) continue;
			if(cookie.slice(0, separator).trim() === name) {
				values.push(cookie.slice(separator + 1).trim());
			}
		}
	}

	return values.length === 1 ? values[0] : undefined;
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length
		&& timingSafeEqual(leftBuffer, rightBuffer);
}

function oauthCookie(value: string, maxAge: number): string {
	return `${OAUTH_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(location: string): APIGatewayProxyStructuredResultV2 {
	return {
		statusCode: 303,
		headers: {
			...noStoreHeaders(),
			location
		},
		cookies: [oauthCookie('', 0)]
	};
}

function noStoreHeaders(): Record<string, string> {
	return {
		'cache-control': 'no-store',
		'referrer-policy': 'no-referrer'
	};
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if(!value) throw new Error(`Missing environment variable: ${name}`);
	return value;
}

function safeError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: 'UnknownError', message: 'Unknown error' };
}
