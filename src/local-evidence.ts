import { Account, AccountSet } from './account';

const CURRENT_STREAM_TITLE_SELECTOR = '[data-a-target=\'stream-title\']';
const CURRENT_STREAM_LIVE_SELECTOR = '[data-a-target=\'animated-channel-viewers-count\']';
const PREVIEW_LINK_SELECTOR = 'a[data-a-target=\'preview-card-channel-link\']';
const SEARCH_RESULT_SELECTOR = '[data-a-target=\'search-result-live-channel\']';
const SEARCH_RESULT_NAME_SELECTOR = '[data-test-selector=\'search-result-live-channel__name\']';
const SEARCH_RESULT_TITLE_SELECTOR = '[data-test-selector=\'search-result-live-channel__title\']';
const SEARCH_RESULT_TAGS_SELECTOR = '[data-test-selector=\'search-result-live-channel__tags\']';
const SAFETY_TAGS = new Set([
	'aioptedout',
	'aioptout',
	'genaiisoff',
	'genaioff',
	'genaioptedout',
	'genaioptout',
	'genaitrainingoff',
	'noai',
	'noaitraining',
	'nogenai',
	'nogenerativeai',
	'nogenerativeaitraining',
	'nogenaitraining',
	'optedoutofgenaitraining'
]);

export function isSafetyTag(value: string): boolean {
	return SAFETY_TAGS.has(value.trim().toLowerCase());
}

export function titleHasLocalSafetyHashtag(title: string): boolean {
	const hashtagPattern =
		/(^|[^\p{L}\p{N}_])#([a-z0-9_]+)(?![\p{L}\p{N}_])/giu;

	for(const match of title.matchAll(hashtagPattern)) {
		const hashtag = match[2];
		if(hashtag && isSafetyTag(hashtag)) {
			return true;
		}
	}

	return false;
}

function tagFromElement(element: HTMLElement): string | null {
	const ariaLabel = element.getAttribute('aria-label')?.trim() ?? '';
	const ariaTag = /^tag,\s*(.+)$/i.exec(ariaLabel)?.[1];

	if(ariaTag) {
		return ariaTag;
	}

	if(!(element instanceof HTMLAnchorElement)) {
		return null;
	}

	try {
		const segments = new URL(element.href).pathname.split('/').filter(Boolean);
		return segments.at(-2) === 'tags'
			? decodeURIComponent(segments.at(-1) ?? '')
			: null;
	} catch {
		return null;
	}
}

function containsLocalSafetyTag(root: HTMLElement): boolean {
	return Array.from(root.querySelectorAll<HTMLElement>(
		'[aria-label^=\'Tag,\'], a[href*=\'/tags/\']'
	)).some(element => {
		const tag = tagFromElement(element);
		return tag !== null && isSafetyTag(tag);
	});
}

function titleText(element: HTMLElement): string {
	return element.getAttribute('title') ?? element.textContent ?? '';
}

export class LocalEvidence {
	private constructor(readonly accounts: AccountSet) {}

	static from(document: Document): LocalEvidence {
		const accounts: Account[] = [];
		const currentAccount = Account.fromUrl(document.location.href);
		const main = document.querySelector<HTMLElement>('main');
		const currentTitle = main?.querySelector<HTMLElement>(
			CURRENT_STREAM_TITLE_SELECTOR
		);
		const currentStreamIsLive = Boolean(main?.querySelector(CURRENT_STREAM_LIVE_SELECTOR));
		const metadata = currentTitle?.parentElement?.nextElementSibling;

		if(
			currentAccount &&
			currentTitle &&
			currentStreamIsLive &&
			(titleHasLocalSafetyHashtag(titleText(currentTitle)) ||
				(metadata instanceof HTMLElement && containsLocalSafetyTag(metadata)))
		) {
			accounts.push(currentAccount);
		}

		for(const link of document.querySelectorAll<HTMLAnchorElement>(
			PREVIEW_LINK_SELECTOR
		)) {
			const account = Account.fromUrl(link.href);
			const title = link.querySelector<HTMLElement>('h4[title]');

			if(account && title && titleHasLocalSafetyHashtag(titleText(title))) {
				accounts.push(account);
			}
		}

		for(const card of document.querySelectorAll<HTMLElement>(
			SEARCH_RESULT_SELECTOR
		)) {
			const name = card.querySelector<HTMLElement>(SEARCH_RESULT_NAME_SELECTOR);
			const link = name?.querySelector<HTMLAnchorElement>('a[href]');
			const account = link ? Account.fromProfileUrl(link.href) : null;
			const title = card.querySelector<HTMLElement>(
				SEARCH_RESULT_TITLE_SELECTOR
			);
			const tags = card.querySelector<HTMLElement>(SEARCH_RESULT_TAGS_SELECTOR);

			if(
				account &&
				((title !== null && titleHasLocalSafetyHashtag(titleText(title))) ||
					(tags !== null && containsLocalSafetyTag(tags)))
			) {
				accounts.push(account);
			}
		}

		return new LocalEvidence(new AccountSet(accounts));
	}
}
