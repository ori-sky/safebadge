const NON_CHANNEL_ROUTES = new Set([
	'about',
	'bits',
	'creatorcamp',
	'directory',
	'downloads',
	'drops',
	'friends',
	'inventory',
	'jobs',
	'p',
	'payments',
	'prime',
	'products',
	'search',
	'settings',
	'store',
	'subscriptions',
	'turbo',
	'videos',
	'wallet'
]);

export class Account {
	private constructor(readonly login: string) {}

	static from(login: string): Account | null {
		const normalized = login.trim().toLowerCase();
		return /^[a-z0-9_]{1,25}$/.test(normalized)
			? new Account(normalized)
			: null;
	}

	static fromUrl(rawUrl: string): Account | null {
		return Account.fromTwitchUrl(rawUrl, false);
	}

	static fromProfileUrl(rawUrl: string): Account | null {
		return Account.fromTwitchUrl(rawUrl, true);
	}

	private static fromTwitchUrl(
		rawUrl: string,
		profileOnly: boolean
	): Account | null {
		try {
			const url = new URL(rawUrl);
			const path = url.pathname.split('/');

			if(
				url.origin !== 'https://www.twitch.tv' ||
				(profileOnly && path.filter(Boolean).length !== 1)
			) {
				return null;
			}

			const segment = decodeURIComponent(path[1] ?? '');
			const account = Account.from(segment);

			return account && !NON_CHANNEL_ROUTES.has(account.login)
				? account
				: null;
		} catch {
			return null;
		}
	}
}

export class AccountSet implements Iterable<Account> {
	private readonly items: ReadonlyMap<string, Account>;

	constructor(accounts: Iterable<Account>) {
		const items = new Map<string, Account>();

		for(const account of accounts) {
			if(!items.has(account.login)) {
				items.set(account.login, account);
			}
		}

		this.items = items;
	}

	has(account: Account): boolean {
		return this.items.has(account.login);
	}

	get size(): number {
		return this.items.size;
	}

	difference(other: AccountSet): AccountSet {
		return new AccountSet([...this].filter(account => !other.has(account)));
	}

	hash(): string {
		return JSON.stringify([...this.items.keys()].sort());
	}

	[Symbol.iterator](): IterableIterator<Account> {
		return this.items.values();
	}
}
