import { Account } from './account';
import { BadgeManager, BadgeTarget } from './badge';
import { Group } from './group';
import { participantCountFromElements, StreamCard } from './stream-card';

const COLLAPSED_SIDEBAR_SELECTOR          = '[data-a-target=\'side-nav-bar-collapsed\']';
const SIDEBAR_CARD_SELECTOR = [
	'a[data-test-selector=\'followed-channel\'][href]',
	'a[data-test-selector=\'recommended-channel\'][href]',
	`${COLLAPSED_SIDEBAR_SELECTOR} a[aria-haspopup='dialog'][href]`
].join(',');
const SIDEBAR_METADATA_SELECTOR           = '[data-a-target=\'side-nav-card-metadata\']';
const SIDEBAR_LIVE_STATUS_SELECTOR        = '[data-a-target=\'side-nav-live-status\']';
const SIDEBAR_NAME_SELECTOR               = '[data-a-target=\'side-nav-title\']';
const LIVE_INDICATOR_SELECTOR             = '.tw-channel-status-indicator';
const PREVIEW_CARD_SELECTOR               = 'a[data-a-target=\'preview-card-channel-link\']';
const PREVIEW_CARD_CHANNEL_SELECTOR       = 'p[data-a-target=\'preview-card-channel-link\']';
const CHANNEL_HEADER_PARTICIPANT_SELECTOR = 'button[aria-haspopup=\'dialog\']';
const CHANNEL_HEADER_SELECTOR             = 'main h1';
const FEATURED_ITEM_SELECTOR              = '[data-a-target=\'front-page-carousel\'] [data-a-target=\'featured-item\']';
const CAROUSEL_NAME_SELECTOR              = '[data-a-target=\'carousel-display-name\']';

export class TwitchStreamScanner {
	constructor(private readonly badges: BadgeManager) {}

	scan(): void {
		const sidebarGroups = this.scanSidebar();
		this.scanPreviews();
		this.scanCarousel();
		this.scanChannelHeader(sidebarGroups);
	}

	private scanSidebar(): ReadonlySet<Group> {
		return new Set(this.scanStreamCards(
			SIDEBAR_CARD_SELECTOR,
			link => this.sidebarTarget(link)
		));
	}

	private scanPreviews(): void {
		this.scanStreamCards(
			PREVIEW_CARD_SELECTOR,
			link => {
				const mount = link.querySelector<HTMLElement>(
					PREVIEW_CARD_CHANNEL_SELECTOR
				)?.parentElement;
				return mount ? BadgeTarget.compact(mount, link) : null;
			}
		);
	}

	private scanCarousel(): void {
		for(const item of document.querySelectorAll<HTMLElement>(FEATURED_ITEM_SELECTOR)) {
			const name = item.querySelector<HTMLElement>(CAROUSEL_NAME_SELECTOR);
			const link = name?.closest<HTMLAnchorElement>('a[href]') ?? null;

			const linkAccount = link && item.contains(link)
				? Account.fromProfileUrl(link.href)
				: null;
			const nameAccount = name
				? Account.from(name.textContent ?? '')
				: null;

			if(!link || !linkAccount || linkAccount.login !== nameAccount?.login) {
				this.badges.clear(item);
				continue;
			}

			void this.badges.update(
				Group.from(linkAccount),
				BadgeTarget.compact(link, item)
			);
		}
	}

	private scanChannelHeader(sidebarGroups: ReadonlySet<Group>): void {
		const headers = document.querySelectorAll<HTMLElement>(
			CHANNEL_HEADER_SELECTOR
		);
		const currentAccount = Account.fromUrl(window.location.href);

		if(!currentAccount) {
			for(const header of headers) {
				this.badges.clear(header);
			}
			return;
		}

		for(const header of headers) {
			const link = header.closest<HTMLAnchorElement>('a[href]');
			const headerAccount = link
				? Account.fromProfileUrl(link.href)
				: null;

			if(!link || headerAccount?.login !== currentAccount.login) {
				this.badges.clear(header);
				continue;
			}

			this.scanChannelHeaderParticipants(link);

			void this.badges.update(
				this.groupForHeader(header, currentAccount, sidebarGroups),
				BadgeTarget.full(header)
			);
		}
	}

	private scanChannelHeaderParticipants(headerLink: HTMLAnchorElement): void {
		const row = headerLink.parentElement;
		if(!row) {
			return;
		}

		for(const button of row.querySelectorAll<HTMLButtonElement>(CHANNEL_HEADER_PARTICIPANT_SELECTOR)) {
			const mount = button.parentElement;
			if(!mount) {
				continue;
			}

			const account = Account.from(button.textContent ?? '');
			if(!account) {
				this.badges.clear(mount);
				continue;
			}

			void this.badges.update(
				Group.from(account),
				BadgeTarget.compact(mount)
			);
		}
	}

	private sidebarTarget(link: HTMLAnchorElement): BadgeTarget | null {
		if(link.closest(COLLAPSED_SIDEBAR_SELECTOR)) {
			return BadgeTarget.collapsed(link);
		}

		const metadata = link.querySelector<HTMLElement>(
			SIDEBAR_METADATA_SELECTOR
		);

		const liveStatus = link.querySelector<HTMLElement>(
			SIDEBAR_LIVE_STATUS_SELECTOR
		);
		const liveIndicator = liveStatus?.querySelector<HTMLElement>(
			LIVE_INDICATOR_SELECTOR
		);

		if(liveIndicator?.parentElement instanceof HTMLElement) {
			return BadgeTarget.live(liveIndicator.parentElement, link);
		}

		const offlineTarget = liveStatus
			? BadgeTarget.offline(liveStatus, link)
			: null;

		if(offlineTarget) {
			return offlineTarget;
		}

		const name = metadata?.querySelector<HTMLElement>(SIDEBAR_NAME_SELECTOR);
		return name ? BadgeTarget.compact(name, link) : null;
	}

	private scanStreamCards(
		selector: string,
		targetFor: (link: HTMLAnchorElement) => BadgeTarget | null
	): Iterable<Group> {
		const cards: StreamCard[] = [];

		for(const link of document.querySelectorAll<HTMLAnchorElement>(selector)) {
			const target = targetFor(link);
			const card = target ? StreamCard.from(link, target) : null;

			if(card) {
				cards.push(card);
			} else {
				this.badges.clear(link);
			}
		}

		const resolvedGroups = StreamCard.resolveGroups(cards);

		for(const [card, group] of resolvedGroups) {
			void this.badges.update(group, card.target);
		}

		return resolvedGroups.values();
	}

	private groupForHeader(
		header: HTMLElement,
		account: Account,
		groups: ReadonlySet<Group>
	): Group {
		const expectedSize = this.participantCountNearHeader(header);
		const group = [...groups].find(group =>
			group.accounts.has(account) &&
			(expectedSize === null
				? group.expectedSize > 1
				: group.expectedSize === expectedSize)
		);

		return group ?? Group.from(account, expectedSize ?? 1);
	}

	private participantCountNearHeader(header: HTMLElement): number | null {
		let container = header.parentElement;

		for(let depth = 0; container && depth < 4; depth += 1) {
			const count = participantCountFromElements(
				container.querySelectorAll('button')
			);

			if(count !== null) {
				return count;
			}

			container = container.parentElement;
		}

		return null;
	}
}
