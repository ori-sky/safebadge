import { Account } from './account';
import { BadgeManager, BadgeTarget } from './badge';
import { Group } from './group';

const RAID_CARD_SELECTOR = '.creator-collaboration-channel-list-card, .creator-collaboration-channel-grid-card';
const RAID_PREVIEW_SELECTOR = '.creator-collaboration-channel-preview';

export class RaidScanner {
	constructor(private readonly badges: BadgeManager) {}

	scan(): void {
		for(const card of document.querySelectorAll<HTMLElement>(
			RAID_CARD_SELECTOR
		)) {
			let found = false;

			for(const owner of card.querySelectorAll<HTMLDivElement>('div[aria-label]')) {
				const account = this.raidAccount(owner);

				if(!account) {
					continue;
				}

				const hasMatchingImage = Array.from(
					owner.querySelectorAll<HTMLImageElement>('img[alt]')
				).some(image => Account.from(image.alt)?.login === account.login);
				const [name, duplicateName] = Array.from(
					owner.querySelectorAll<HTMLParagraphElement>('p')
				).filter(name => this.accountFromDirectText(name)?.login === account.login);

				if(!hasMatchingImage || !name || duplicateName) {
					continue;
				}

				found = true;
				void this.badges.update(
					Group.from(account),
					BadgeTarget.compact(name, owner)
				);
				break;
			}

			if(!found) {
				this.badges.clear(card);
			}
		}

		for(const preview of document.querySelectorAll<HTMLElement>(
			RAID_PREVIEW_SELECTOR
		)) {
			let found = false;

			for(const link of preview.querySelectorAll<HTMLAnchorElement>('a[href]')) {
				const account = Account.fromProfileUrl(link.href);

				if(!account) {
					continue;
				}

				const [name, duplicateName] = Array.from(
					link.querySelectorAll<HTMLParagraphElement>(':scope > p')
				).filter(name => this.accountFromDirectText(name)?.login === account.login);

				if(!name || duplicateName) {
					continue;
				}

				found = true;
				void this.badges.update(
					Group.from(account),
					BadgeTarget.full(name)
				);
				break;
			}

			if(!found) {
				this.badges.clear(preview);
			}
		}
	}

	handleMutation(mutation: MutationRecord): void {
		const target = mutation.target instanceof HTMLElement
			? mutation.target
			: mutation.target.parentElement;

		if(!target) {
			return;
		}

		const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
		const identityChanged = (
			mutation.type === 'attributes' &&
			['alt', 'aria-label', 'href'].includes(mutation.attributeName ?? '')
		) || (
			mutation.type === 'characterData' &&
			target instanceof HTMLParagraphElement
		) || changedNodes.some(
			node =>
				(target instanceof HTMLParagraphElement && node instanceof Text) ||
				(node instanceof HTMLElement && (
					node.matches('a, img, p') ||
					node.querySelector('a[href], img[alt], p') !== null
				))
		);

		if(!identityChanged) {
			return;
		}

		const raid = target.closest<HTMLElement>(
			`${RAID_CARD_SELECTOR}, ${RAID_PREVIEW_SELECTOR}`
		);

		if(raid) {
			this.badges.clear(raid);
		}
	}

	private raidAccount(owner: HTMLDivElement): Account | null {
		const login = owner.getAttribute('aria-label')?.trim().split(/\s+/, 1)[0];
		return Account.from(login ?? '');
	}

	private accountFromDirectText(element: HTMLParagraphElement): Account | null {
		const text = Array.from(element.childNodes)
			.filter(node => node instanceof Text)
			.map(node => node.data)
			.join(' ');
		return Account.from(text);
	}
}
