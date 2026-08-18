import { Account, AccountSet } from './account';
import { BadgeTarget } from './badge';
import { Group } from './group';

export function participantCountFromElements(
	elements: Iterable<Element>
): number | null {
	const text = Array.from(elements, element => element.textContent?.trim() ?? '')
		.find(value => /^\+\d+$/.test(value));

	if(!text) {
		return null;
	}

	const total = Number.parseInt(text.slice(1), 10) + 1;
	return Number.isSafeInteger(total) ? total : null;
}

export class StreamCard {
	readonly observed: AccountSet;

	private constructor(
		primary: Account,
		observed: Iterable<Account>,
		readonly expectedSize: number,
		readonly target: BadgeTarget
	) {
		this.observed = new AccountSet([primary, ...observed]);
	}

	static from(
		link: HTMLAnchorElement,
		target: BadgeTarget
	): StreamCard | null {
		if(target.owner !== link) {
			return null;
		}

		const primary = Account.fromUrl(link.href);

		if(!primary) {
			return null;
		}

		const expectedSize = participantCountFromElements(
			link.querySelectorAll('p')
		) ?? 1;
		const observed = expectedSize === 1 ? [] : StreamCard.participants(link);

		return new StreamCard(primary, observed, expectedSize, target);
	}

	static resolveGroups(
		cards: readonly StreamCard[]
	): ReadonlyMap<StreamCard, Group> {
		const visited = new Set<StreamCard>();
		const groups = new Map<StreamCard, Group>();

		for(const card of cards) {
			if(visited.has(card)) {
				continue;
			}

			const component = [card];
			visited.add(card);

			for(const current of component) {
				if(current.expectedSize === 1) {
					continue;
				}

				for(const candidate of cards) {
					if(
						!visited.has(candidate) &&
						candidate.expectedSize === current.expectedSize &&
						[...current.observed].some(account => candidate.observed.has(account))
					) {
						component.push(candidate);
						visited.add(candidate);
					}
				}
			}

			const accounts = new AccountSet(
				component.flatMap(item => [...item.observed])
			);
			const group = new Group(accounts, card.expectedSize);

			for(const member of component) {
				groups.set(member, group);
			}
		}

		return groups;
	}

	private static participants(root: HTMLAnchorElement): Account[] {
		return Array.from(root.querySelectorAll<HTMLImageElement>('img[alt]'))
			.flatMap(image => image.alt.split(/\s+and\s+/i))
			.map(name => Account.from(name))
			.filter(account => account !== null);
	}
}
