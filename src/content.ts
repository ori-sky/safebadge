import { BadgeManager } from './badge';
import { LocalEvidence } from './local-evidence';
import { RaidScanner } from './raid-scanner';
import { SafetyService } from './safety-service';
import {
	TwitchScanner,
	TWITCH_IDENTITY_ATTRIBUTES
} from './twitch-scanner';

const DASHBOARD_HOST = 'dashboard.twitch.tv';
const OBSERVED_ATTRIBUTES = [
	'alt',
	'title',
	'aria-label',
	...TWITCH_IDENTITY_ATTRIBUTES
];

class ContentScript {
	private readonly safety = new SafetyService(() => this.scheduleScan());
	private readonly badges = new BadgeManager(this.safety);
	private readonly scanner = window.location.hostname === DASHBOARD_HOST
		? new RaidScanner(this.badges)
		: new TwitchScanner(this.badges);
	private readonly observer = new MutationObserver(
		mutations => this.handleMutations(mutations)
	);
	private scanFrame: number | null = null;
	private stopped = false;

	start(): void {
		this.scheduleScan();
		this.observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: OBSERVED_ATTRIBUTES,
			characterData: true,
			childList: true,
			subtree: true
		});

		window.addEventListener('popstate', () => this.scheduleScan());
		window.addEventListener('hashchange', () => this.scheduleScan());
		window.addEventListener('pagehide', event => {
			if(!event.persisted) {
				this.stop();
			}
		});
	}

	private handleMutations(mutations: readonly MutationRecord[]): void {
		for(const mutation of mutations) {
			this.scanner.handleMutation(mutation);
		}

		this.scheduleScan();
	}

	private scanPage(): void {
		this.scanFrame = null;

		if(this.stopped) {
			return;
		}

		this.badges.setEvidence(LocalEvidence.from(document));

		this.scanner.scan();
	}

	private scheduleScan(): void {
		if(!this.stopped) {
			this.scanFrame ??= window.requestAnimationFrame(() => this.scanPage());
		}
	}

	private stop(): void {
		this.stopped = true;
		this.observer.disconnect();
		this.badges.stop();
		this.safety.stop();

		if(this.scanFrame !== null) {
			window.cancelAnimationFrame(this.scanFrame);
			this.scanFrame = null;
		}
	}
}

new ContentScript().start();
