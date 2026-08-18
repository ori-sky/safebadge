import { Account, AccountSet } from './account';

export class Group {
	readonly expectedSize: number;

	constructor(
		readonly accounts: AccountSet,
		expectedSize: number
	) {
		if(accounts.size === 0) {
			throw new Error('A group must contain at least one account');
		}

		this.expectedSize = Number.isFinite(expectedSize)
			? Math.max(1, Math.trunc(expectedSize))
			: 1;
	}

	static from(account: Account, expectedSize = 1): Group {
		return new Group(new AccountSet([account]), expectedSize);
	}

	tryHash(): string | null {
		return this.accounts.size === this.expectedSize
			? this.accounts.hash()
			: null;
	}
}
