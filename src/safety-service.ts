import { Account, AccountSet } from './account';
import { isSafetyTag } from './local-evidence';

const API_URL = 'https://safebadge.ori.mx/v1/status:batch';
const TWITCH_GQL_URL = 'https://gql.twitch.tv/gql';
const TWITCH_TAG_QUERY = 'query UserTags($login: String!) { user(login: $login) { login freeformTags { name } } }';
const TWITCH_CLIENT_ID_PATTERN = /\bclientId\s*[:=]\s*['"]([a-z0-9]{20,64})['"]/i;
const MAX_BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MILLISECONDS = 8_000;

interface BatchResponse {
	results: Record<string, unknown>;
	cacheForSeconds: number;
}

interface CacheEntry {
	isSafe: boolean;
	expiresAt: number;
}

interface TwitchTagResponse {
	data?: {
		user?: {
			login?: unknown;
			freeformTags?: readonly ({ name?: unknown } | null)[] | null;
		} | null;
	};
}

async function twitchClientId(): Promise<string | null> {
	let clientScriptUrl: string | null = null;

	for(const script of document.scripts) {
		const clientId = TWITCH_CLIENT_ID_PATTERN.exec(script.textContent ?? '')?.[1];

		if(clientId) {
			return clientId;
		}

		if(script.src.startsWith('https://assets.twitch.tv/assets/21956-')) {
			clientScriptUrl = script.src;
		}
	}

	if(!clientScriptUrl) {
		return null;
	}

	try {
		const response = await fetch(clientScriptUrl, {
			credentials: 'omit',
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
		});

		if(!response.ok) {
			return null;
		}

		return TWITCH_CLIENT_ID_PATTERN.exec(await response.text())?.[1] ?? null;
	} catch {
		return null;
	}
}

export class SafetyService {
	private readonly resultCache = new Map<string, CacheEntry>();
	private readonly pendingResults =
		new Map<string, PromiseWithResolvers<boolean>>();
	private readonly queuedAccounts: Account[] = [];
	private expirationTimer: number | null = null;
	private cacheRevision = 0;
	private stopped = false;

	constructor(private readonly resultsExpired: () => void) {}

	get revision(): number {
		return this.cacheRevision;
	}

	async areSafe(accounts: AccountSet): Promise<boolean> {
		if(accounts.size === 0) {
			return false;
		}

		const results = await Promise.all(
			Array.from(accounts, account => this.isSafe(account))
		);
		return results.every(isSafe => isSafe);
	}

	stop(): void {
		this.stopped = true;

		if(this.expirationTimer !== null) {
			window.clearTimeout(this.expirationTimer);
			this.expirationTimer = null;
		}
	}

	private async isSafe(account: Account): Promise<boolean> {
		const cachedResult = this.resultCache.get(account.login);

		if(cachedResult && cachedResult.expiresAt > Date.now()) {
			return cachedResult.isSafe;
		}

		if(cachedResult) {
			this.resultCache.delete(account.login);
			this.cacheRevision += 1;
			this.resultsExpired();
		}

		return this.queue(account);
	}

	private queue(account: Account): Promise<boolean> {
		const existing = this.pendingResults.get(account.login);

		if(existing) {
			return existing.promise;
		}

		const pending = Promise.withResolvers<boolean>();
		this.pendingResults.set(account.login, pending);
		this.queuedAccounts.push(account);

		if(this.queuedAccounts.length === 1) {
			window.queueMicrotask(() => this.flushQueued());
		}

		return pending.promise;
	}

	private flushQueued(): void {
		const accounts = this.queuedAccounts.splice(0);

		for(let start = 0; start < accounts.length; start += MAX_BATCH_SIZE) {
			void this.resolveBatch(accounts.slice(start, start + MAX_BATCH_SIZE));
		}
	}

	private async resolveBatch(accounts: readonly Account[]): Promise<void> {
		try {
			const [response, taggedAccounts] = await Promise.all([
				this.requestBatch(accounts),
				this.requestTaggedAccounts(accounts)
			]);
			const expiresAt = Date.now() + response.cacheForSeconds * 1_000;

			for(const account of accounts) {
				const serverResult = response.results[account.login];
				const pending = this.pendingResults.get(account.login);

				if(typeof serverResult !== 'boolean' || !pending) {
					throw new Error('Safety API returned invalid results');
				}

				const isSafe = serverResult || taggedAccounts.has(account);
				this.resultCache.set(account.login, { isSafe, expiresAt });
				this.pendingResults.delete(account.login);
				pending.resolve(isSafe);
			}

			this.scheduleExpiration();
		} catch(error: unknown) {
			for(const account of accounts) {
				const pending = this.pendingResults.get(account.login);
				this.pendingResults.delete(account.login);
				pending?.reject(error);
			}
		}
	}

	private async requestBatch(
		accounts: readonly Account[]
	): Promise<BatchResponse> {
		const logins = accounts.map(account => account.login);
		const response = await fetch(API_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ logins }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
		});

		if(!response.ok) {
			throw new Error(`Safety API returned ${response.status}`);
		}

		return response.json() as Promise<BatchResponse>;
	}

	private async requestTaggedAccounts(
		accounts: readonly Account[]
	): Promise<AccountSet> {
		const taggedAccounts: Account[] = [];
		const clientId = await twitchClientId();

		if(!clientId) {
			return new AccountSet(taggedAccounts);
		}

		try {
			const response = await fetch(TWITCH_GQL_URL, {
				method: 'POST',
				headers: {
					'Client-ID': clientId,
					'content-type': 'application/json'
				},
				body: JSON.stringify(accounts.map(account => ({
					operationName: 'UserTags',
					query: TWITCH_TAG_QUERY,
					variables: { login: account.login }
				}))),
				credentials: 'omit',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS)
			});

			if(!response.ok) {
				return new AccountSet(taggedAccounts);
			}

			const body: unknown = await response.json();

			if(!Array.isArray(body)) {
				return new AccountSet(taggedAccounts);
			}

			const results = body as readonly TwitchTagResponse[];

			for(const [index, account] of accounts.entries()) {
				const user = results[index]?.data?.user;
				const tags = user?.freeformTags;

				if(
					user?.login === account.login &&
					Array.isArray(tags) &&
					tags.some(tag =>
						typeof tag?.name === 'string' && isSafetyTag(tag.name)
					)
				) {
					taggedAccounts.push(account);
				}
			}
		} catch {
			return new AccountSet([]);
		}

		return new AccountSet(taggedAccounts);
	}

	private scheduleExpiration(): void {
		if(this.expirationTimer !== null) {
			window.clearTimeout(this.expirationTimer);
			this.expirationTimer = null;
		}

		if(this.stopped) {
			return;
		}

		let nextExpiration: number | null = null;

		for(const { expiresAt } of this.resultCache.values()) {
			if(nextExpiration === null || expiresAt < nextExpiration) {
				nextExpiration = expiresAt;
			}
		}

		if(nextExpiration !== null) {
			this.expirationTimer = window.setTimeout(
				() => this.expireResults(),
				Math.max(0, nextExpiration - Date.now())
			);
		}
	}

	private expireResults(): void {
		this.expirationTimer = null;
		const now = Date.now();
		let expiredResult = false;

		for(const [login, cachedResult] of this.resultCache) {
			if(cachedResult.expiresAt <= now) {
				this.resultCache.delete(login);
				expiredResult = true;
			}
		}

		this.scheduleExpiration();

		if(expiredResult) {
			this.cacheRevision += 1;
			this.resultsExpired();
		}
	}
}
