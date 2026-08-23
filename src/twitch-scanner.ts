import { Account, AccountSet } from './account';
import { BadgeManager, BadgeTarget } from './badge';
import { Group } from './group';
import { TwitchStreamScanner } from './twitch-stream-scanner';

const SHARED_CHAT_FLYOUT_SELECTOR = [
	'.side-nav-guest-star-tooltip__body',
	'[role=\'dialog\'] .guest-list'
].join(',');
const LIVE_INDICATOR_SELECTOR = '.tw-channel-status-indicator';
const CHAT_USER_CARD_SELECTOR = '#VIEWER_CARD_ID';
const CHAT_USER_CARD_NAME_SELECTOR = '[data-a-target=\'viewer-card-display-name\']';
const SEARCH_RESULT_NAME_SELECTOR = [
	'[data-test-selector=\'search-result-live-channel__name\']',
	'[data-test-selector=\'search-result-offline-channel__name\']'
].join(',');
const SEARCH_TRAY_ITEM_SELECTOR = '[data-a-target=\'nav-search-tray\'] [data-a-target=\'nav-search-item\']';
const SEARCH_TRAY_LINK_SELECTOR = 'a[data-tray-item=\'true\'][href]';

export const TWITCH_IDENTITY_ATTRIBUTES = [
	'data-a-target',
	'data-test-selector',
	'data-tray-item',
	'id',
	'href'
];

export class TwitchScanner {
	private readonly streamScanner: TwitchStreamScanner;

	constructor(private readonly badges: BadgeManager) {
		this.streamScanner = new TwitchStreamScanner(badges);
	}

	scan(): void {
		this.streamScanner.scan();
		this.scanSharedChatFlyouts();
		this.scanChatUserCards();
		this.scanSearchTray();
		this.scanSearchResults();
	}

	handleMutation(mutation: MutationRecord): void {
		if(
			mutation.type !== 'attributes' ||
			!(mutation.target instanceof HTMLElement)
		) {
			return;
		}

		if(TWITCH_IDENTITY_ATTRIBUTES.includes(mutation.attributeName ?? '')) {
			this.badges.clear(
				mutation.target.closest<HTMLElement>(
					SEARCH_RESULT_NAME_SELECTOR
				) ?? mutation.target
			);
		}
	}

	private scanSharedChatFlyouts(): void {
		for(const flyout of document.querySelectorAll<HTMLElement>(
			SHARED_CHAT_FLYOUT_SELECTOR
		)) {
			for(const liveIndicator of flyout.querySelectorAll<HTMLElement>(
				LIVE_INDICATOR_SELECTOR
			)) {
				const statusMount = liveIndicator.parentElement;

				if(!(statusMount instanceof HTMLElement)) {
					continue;
				}

				let owner = statusMount.parentElement;
				let found = false;

				while(owner && owner !== flyout) {
					const liveIndicatorCount = owner.querySelectorAll(
						LIVE_INDICATOR_SELECTOR
					).length;
					const accounts = this.accountsFromOwner(owner);
					const account = [...accounts][0];

					if(
						liveIndicatorCount === 1 &&
						accounts.size === 1 &&
						account
					) {
						found = true;
						void this.badges.update(
							Group.from(account),
							BadgeTarget.live(statusMount, owner)
						);
						break;
					}

					if(liveIndicatorCount === 1 && accounts.size > 1) {
						break;
					}

					owner = owner.parentElement;
				}

				if(!found) {
					this.badges.clear(statusMount);
				}
			}
		}
	}

	private scanChatUserCards(): void {
		for(const card of document.querySelectorAll<HTMLElement>(
			CHAT_USER_CARD_SELECTOR
		)) {
			const name = card.querySelector<HTMLElement>(
				CHAT_USER_CARD_NAME_SELECTOR
			);
			const link = name?.closest<HTMLAnchorElement>('a[href]');
			const account = link ? Account.fromProfileUrl(link.href) : null;
			const target = name ? BadgeTarget.compact(name, card) : null;

			this.updateAccountBadge(card, account, target);
		}
	}

	private scanSearchTray(): void {
		for(const item of document.querySelectorAll<HTMLElement>(
			SEARCH_TRAY_ITEM_SELECTOR
		)) {
			const link = item.closest<HTMLAnchorElement>(SEARCH_TRAY_LINK_SELECTOR);
			const image = item.querySelector<HTMLImageElement>('img[alt]');
			const account = link ? Account.fromProfileUrl(link.href) : null;
			const imageAccount = image ? Account.from(image.alt) : null;
			const matchingAccount = account?.login === imageAccount?.login
				? account
				: null;

			this.updateAccountBadge(item, matchingAccount, BadgeTarget.compact(item));
		}
	}

	private scanSearchResults(): void {
		for(const name of document.querySelectorAll<HTMLElement>(
			SEARCH_RESULT_NAME_SELECTOR
		)) {
			const link = name.querySelector<HTMLAnchorElement>('a[href]');
			const account = link ? Account.fromProfileUrl(link.href) : null;

			this.updateAccountBadge(name, account, BadgeTarget.compact(name));
		}
	}

	private updateAccountBadge(
		owner: HTMLElement,
		account: Account | null,
		target: BadgeTarget | null
	): void {
		if(!account || !target) {
			this.badges.clear(owner);
			return;
		}

		void this.badges.update(Group.from(account), target);
	}

	private accountsFromOwner(owner: HTMLElement): AccountSet {
		const accounts = Array.from(
			owner.querySelectorAll<HTMLImageElement>('img[alt]'),
			img => Account.from(img.alt)
		);
		const linkAccount = owner instanceof HTMLAnchorElement
			? Account.fromProfileUrl(owner.href)
			: null;
		if(linkAccount) {
			accounts.push(linkAccount);
		}

		return new AccountSet(accounts.filter(account => account !== null));
	}
}
