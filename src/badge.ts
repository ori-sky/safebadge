import { Group } from './group';
import { LocalEvidence } from './local-evidence';
import { SafetyService } from './safety-service';

const BADGE_CLASS = 'safebadge-safe-badge';
const BADGE_PLACEHOLDER_CLASS = 'safebadge-safe-badge-placeholder';
const BADGE_EVIDENCE_ATTRIBUTE = 'data-safebadge-badge-evidence';
const REQUEST_ATTRIBUTE = 'data-safebadge-request';
const LIVE_INDICATOR_SELECTOR = '.tw-channel-status-indicator';
const COLLAPSED_SIDEBAR_SELECTOR = '[data-a-target=\'side-nav-bar-collapsed\']';
const BADGE_ELEMENT_SELECTOR = `.${BADGE_CLASS}, .${BADGE_PLACEHOLDER_CLASS}`;

function directChildMatching(
	mount: HTMLElement,
	selector: string
): HTMLElement | null {
	return mount.querySelector<HTMLElement>(`:scope > :is(${selector})`);
}

enum BadgeMode {
	Full,
	Compact,
	Live,
	Offline,
	Collapsed
}

export class BadgeTarget {
	private constructor(
		readonly mount: HTMLElement,
		readonly owner: HTMLElement,
		readonly mode: BadgeMode
	) {}

	static full(mount: HTMLElement): BadgeTarget {
		return new BadgeTarget(mount, mount, BadgeMode.Full);
	}

	static compact(
		mount: HTMLElement,
		owner: HTMLElement = mount
	): BadgeTarget {
		return new BadgeTarget(mount, owner, BadgeMode.Compact);
	}

	static live(mount: HTMLElement, owner: HTMLElement): BadgeTarget {
		return new BadgeTarget(mount, owner, BadgeMode.Live);
	}

	static offline(
		mount: HTMLElement,
		owner: HTMLElement
	): BadgeTarget | null {
		const target = new BadgeTarget(mount, owner, BadgeMode.Offline);
		return target.isValid ? target : null;
	}

	static collapsed(mount: HTMLElement): BadgeTarget {
		return new BadgeTarget(mount, mount, BadgeMode.Collapsed);
	}

	get isValid(): boolean {
		if(this.mode === BadgeMode.Live) {
			return directChildMatching(this.mount, LIVE_INDICATOR_SELECTOR) !== null;
		}

		if(this.mode === BadgeMode.Offline) {
			const text = Array.from(this.mount.childNodes)
				.filter(node => !(
					node instanceof HTMLElement &&
					node.matches(BADGE_ELEMENT_SELECTOR)
				))
				.map(node => node.textContent ?? '')
				.join(' ')
				.trim()
				.toLowerCase();
			return text === 'offline';
		}

		if(this.mode === BadgeMode.Collapsed) {
			return this.mount.closest(COLLAPSED_SIDEBAR_SELECTOR) !== null;
		}

		return true;
	}
}

export class BadgeManager {
	private evidence: LocalEvidence | null = null;
	private stopped = false;

	constructor(private readonly safety: SafetyService) {}

	setEvidence(evidence: LocalEvidence): void {
		this.evidence = evidence;
	}

	async update(group: Group, target: BadgeTarget): Promise<void> {
		if(this.stopped) {
			return;
		}

		this.clearOwner(target.owner, target.mount);

		const groupHash = group.tryHash();
		const evidence = this.evidence;

		if(!groupHash || !evidence) {
			this.directBadge(target.mount)?.remove();
			target.mount.removeAttribute(REQUEST_ATTRIBUTE);
			this.reserveSpace(target);
			return;
		}

		const remoteAccounts = group.accounts.difference(evidence.accounts);
		const evidenceKey = `${this.safety.revision}|${groupHash}|remote:${remoteAccounts.hash()}`;
		const existingBadge = this.directBadge(target.mount);

		if(
			existingBadge &&
			existingBadge.getAttribute(BADGE_EVIDENCE_ATTRIBUTE) === evidenceKey &&
			this.position(existingBadge, target)
		) {
			return;
		}

		existingBadge?.remove();
		this.reserveSpace(target);

		if(target.mount.getAttribute(REQUEST_ATTRIBUTE) === evidenceKey) {
			return;
		}

		target.mount.setAttribute(REQUEST_ATTRIBUTE, evidenceKey);

		try {
			const isSafe =
				remoteAccounts.size === 0 || await this.safety.areSafe(remoteAccounts);

			if(
				this.stopped ||
				!target.mount.isConnected ||
				target.mount.getAttribute(REQUEST_ATTRIBUTE) !== evidenceKey
			) {
				return;
			}

			if(isSafe && !this.directBadge(target.mount)) {
				this.position(
					this.makeBadge(group, evidenceKey),
					target
				);
			} else if(!isSafe) {
				this.reserveSpace(target);
			}
		} catch(error: unknown) {
			console.warn('[SafeBadge] Could not check streamer safety', error);

			if(
				!this.stopped &&
				target.mount.isConnected &&
				target.mount.getAttribute(REQUEST_ATTRIBUTE) === evidenceKey
			) {
				this.reserveSpace(target);
			}
		} finally {
			if(target.mount.getAttribute(REQUEST_ATTRIBUTE) === evidenceKey) {
				target.mount.removeAttribute(REQUEST_ATTRIBUTE);
			}
		}
	}

	clear(owner: HTMLElement): void {
		this.clearOwner(owner);
	}

	stop(): void {
		this.stopped = true;
	}

	private directBadge(mount: HTMLElement): HTMLElement | null {
		return directChildMatching(mount, `.${BADGE_CLASS}`);
	}

	private directPlaceholder(mount: HTMLElement): HTMLElement | null {
		return directChildMatching(mount, `.${BADGE_PLACEHOLDER_CLASS}`);
	}

	private clearOwner(
		owner: HTMLElement,
		retainedMount: HTMLElement | null = null
	): void {
		for(const element of owner.querySelectorAll<HTMLElement>(
			BADGE_ELEMENT_SELECTOR
		)) {
			if(element.parentElement !== retainedMount) {
				element.remove();
			}
		}

		for(const element of [
			owner,
			...owner.querySelectorAll<HTMLElement>(`[${REQUEST_ATTRIBUTE}]`)
		]) {
			if(element !== retainedMount) {
				element.removeAttribute(REQUEST_ATTRIBUTE);
			}
		}
	}

	private makeBadge(
		group: Group,
		evidenceKey: string
	): HTMLSpanElement {
		const badge = document.createElement('span');
		const isGroup = group.accounts.size > 1;

		badge.className = BADGE_CLASS;
		badge.setAttribute(BADGE_EVIDENCE_ATTRIBUTE, evidenceKey);
		badge.setAttribute('role', 'img');
		badge.setAttribute(
			'aria-label',
			isGroup
				? 'Every streamer in this shared stream has generative AI disabled'
				: 'This streamer has generative AI disabled'
		);
		badge.title = isGroup
			? 'Generative AI is disabled for all shared-stream participants'
			: 'Generative AI disabled';

		const symbol = document.createElement('span');
		symbol.className = `${BADGE_CLASS}__symbol`;
		symbol.setAttribute('aria-hidden', 'true');
		symbol.textContent = '⊘';

		const label = document.createElement('span');
		label.className = `${BADGE_CLASS}__label`;
		label.setAttribute('aria-hidden', 'true');
		label.textContent = 'GEN AI DISABLED';

		badge.append(symbol, label);
		return badge;
	}

	private position(badge: HTMLElement, target: BadgeTarget): boolean {
		if(!target.isValid) {
			return false;
		}

		this.directPlaceholder(target.mount)?.remove();
		badge.classList.toggle(
			`${BADGE_CLASS}--compact`,
			target.mode !== BadgeMode.Full
		);
		badge.classList.toggle(
			`${BADGE_CLASS}--live-status`,
			target.mode === BadgeMode.Live || target.mode === BadgeMode.Offline
		);
		badge.classList.toggle(
			`${BADGE_CLASS}--collapsed-sidebar`,
			target.mode === BadgeMode.Collapsed
		);

		if(target.mount.lastElementChild !== badge) {
			target.mount.append(badge);
		}

		return true;
	}

	private reserveSpace(target: BadgeTarget): void {
		const existing = this.directPlaceholder(target.mount);

		if(
			target.mode === BadgeMode.Full ||
			target.mode === BadgeMode.Compact ||
			this.directBadge(target.mount) ||
			!target.isValid
		) {
			existing?.remove();
			return;
		}

		const placeholder = existing ?? document.createElement('span');
		placeholder.className = BADGE_PLACEHOLDER_CLASS;
		placeholder.classList.toggle(
			`${BADGE_PLACEHOLDER_CLASS}--collapsed-sidebar`,
			target.mode === BadgeMode.Collapsed
		);
		placeholder.setAttribute('aria-hidden', 'true');

		if(target.mount.lastElementChild !== placeholder) {
			target.mount.append(placeholder);
		}
	}
}
