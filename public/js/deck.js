import { h, reducedMotion, toast } from './util.js';

const SWIPE_PX = 50;

/**
 * A fanned deck of sample receipts. The front card scans when tapped; side cards come to the
 * front when tapped; swiping (or arrow keys) cycles the deck.
 */
export class SampleDeck {
	constructor(root, samples, { onPick }) {
		this.root = root;
		this.samples = samples;
		this.onPick = onPick;
		this.order = samples.map((_, i) => i);
		this.stage = root.querySelector('.deck');
		this.caption = root.querySelector('.deck-caption');
		this.dots = root.querySelector('.deck-dots');
		this.blobs = new Map();
		this.busy = false;

		this.cards = samples.map((s, i) =>
			h(
				'button',
				{ type: 'button', class: 'deck-card', dataset: { i }, 'aria-label': `${s.merchant} sample receipt`, onclick: () => this.activate(i) },
				h('span', { class: 'deck-paper' }, h('img', { src: s.thumb, alt: '', draggable: 'false' })),
				h(
					'span',
					{ class: 'deck-label' },
					h('strong', {}, s.merchant),
					h('small', {}, s.place),
					h(
						'span',
						{ class: 'deck-tags' },
						s.tags.map((t) => h('span', {}, t)),
					),
				),
			),
		);
		this.stage.append(...this.cards);
		this.dots.append(...samples.map((_, i) => h('button', { type: 'button', 'aria-label': `Show sample ${i + 1}`, onclick: () => this.bringToFront(i) })));

		this.bindGestures();
		this.stage.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowRight') this.rotate(-1);
			if (e.key === 'ArrowLeft') this.rotate(1);
		});
		new ResizeObserver(() => this.layout()).observe(this.stage);
		this.layout();
		this.deal();
		(window.requestIdleCallback ?? setTimeout)(() => samples.forEach((s) => this.load(s).catch(() => undefined)));
	}

	/** Fan position for depth p (0 = front): alternate left and right, each step further back. */
	slot(p) {
		if (p === 0) return { x: 0, y: 0, r: 0, s: 1 };
		const side = p % 2 === 1 ? -1 : 1;
		const depth = Math.ceil(p / 2);
		return { x: side * depth * 0.56, y: depth * 16, r: side * depth * 7, s: 1 - depth * 0.08 };
	}

	layout() {
		const w = this.cards[0].offsetWidth || 170;
		const n = this.cards.length;
		this.order.forEach((idx, p) => {
			const card = this.cards[idx];
			const s = this.slot(p);
			card.style.setProperty('--x', `${s.x * w}px`);
			card.style.setProperty('--y', `${s.y}px`);
			card.style.setProperty('--r', `${s.r}deg`);
			card.style.setProperty('--s', s.s);
			card.style.zIndex = String(n - p);
			card.classList.toggle('front', p === 0);
			card.tabIndex = p === 0 ? 0 : -1;
		});
		const front = this.samples[this.order[0]];
		this.caption.textContent = `${front.merchant} · tap to scan`;
		[...this.dots.children].forEach((d, i) => d.classList.toggle('active', i === this.order[0]));
	}

	/** dir 1 brings the left card forward, -1 the right card. */
	rotate(dir) {
		if (this.busy) return;
		if (dir > 0) this.order.push(this.order.shift());
		else this.order.unshift(this.order.pop());
		this.layout();
	}

	bringToFront(idx) {
		const p = this.order.indexOf(idx);
		if (p <= 0) return;
		this.rotate(p % 2 === 1 ? 1 : -1);
		if (this.order[0] !== idx) this.bringToFront(idx);
	}

	activate(idx) {
		if (this.suppressClick) {
			this.suppressClick = false;
			return;
		}
		if (this.order[0] === idx) this.pick(idx);
		else this.bringToFront(idx);
	}

	/** Cards slide up from below into the fan. */
	deal() {
		if (reducedMotion()) return;
		this.stage.classList.add('dealing');
		this.cards.forEach((c, i) => {
			c.style.transitionDelay = `${(this.cards.length - 1 - this.order.indexOf(i)) * 80}ms`;
		});
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				this.stage.classList.remove('dealing');
				setTimeout(() => this.cards.forEach((c) => (c.style.transitionDelay = '')), 900);
			}),
		);
	}

	bindGestures() {
		let start = null;
		this.stage.addEventListener('pointerdown', (e) => {
			if (this.busy || e.button !== 0) return;
			start = { x: e.clientX, y: e.clientY, id: e.pointerId, moved: false };
		});
		this.stage.addEventListener('pointermove', (e) => {
			if (!start || e.pointerId !== start.id) return;
			const dx = e.clientX - start.x;
			if (!start.moved && Math.abs(dx) < 8) return;
			if (!start.moved && Math.abs(e.clientY - start.y) > Math.abs(dx)) {
				start = null;
				return;
			}
			if (!start.moved) {
				start.moved = true;
				this.stage.setPointerCapture(e.pointerId);
			}
			const front = this.cards[this.order[0]];
			front.classList.add('dragging');
			front.style.setProperty('--dx', `${dx}px`);
			front.style.setProperty('--dr', `${dx / 14}deg`);
		});
		const end = (e) => {
			if (!start || e.pointerId !== start.id) return;
			const dx = e.clientX - start.x;
			const front = this.cards[this.order[0]];
			front.classList.remove('dragging');
			front.style.removeProperty('--dx');
			front.style.removeProperty('--dr');
			if (start.moved) {
				this.suppressClick = true;
				setTimeout(() => (this.suppressClick = false), 0);
				if (Math.abs(dx) > SWIPE_PX) this.rotate(dx < 0 ? -1 : 1);
			}
			start = null;
		};
		this.stage.addEventListener('pointerup', end);
		this.stage.addEventListener('pointercancel', end);
	}

	load(sample) {
		if (!this.blobs.has(sample.id)) {
			this.blobs.set(
				sample.id,
				fetch(sample.src).then((r) => {
					if (!r.ok) throw new Error(`Couldn't load sample (${r.status})`);
					return r.blob();
				}),
			);
		}
		return this.blobs.get(sample.id).catch((err) => {
			this.blobs.delete(sample.id);
			throw err;
		});
	}

	/**
	 * Hand the front card to `onPick` along with its image. The card's paper becomes the shared element
	 * of the screen transition, so it expands into the extraction screen's receipt in one motion.
	 */
	async pick(idx) {
		if (this.busy) return;
		this.busy = true;
		const sample = this.samples[idx];
		const card = this.cards[idx];
		card.classList.add('loading');
		try {
			const blob = await this.load(sample);
			await this.onPick(sample, blob, card.querySelector('.deck-paper'));
		} catch (err) {
			toast(err.message, 'error');
		} finally {
			card.classList.remove('loading');
			this.busy = false;
		}
	}
}
