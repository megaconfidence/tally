import { h, sleep, UNSURE } from './util.js';

const pct = (n) => `${(n * 100).toFixed(3)}%`;
const KINDS = ['merchant', 'address', 'date', 'subtotal', 'discount', 'tax', 'tip', 'total', 'card', 'item', 'policy', 'math', 'focus'];

const PRICE = /\d[.,]\d{2}(?!\d)/;

function wordSpans(words) {
	const wrap = h('span', {});
	words.forEach((w, i) => {
		if (i) wrap.append(' ');
		wrap.append(h('span', { class: wordClass(w.c), title: `${Math.round(w.c * 100)}% confidence` }, w.t));
	});
	return wrap;
}

function wordClass(c) {
	if (c < 0.7) return 'w low';
	if (c < UNSURE) return 'w unsure';
	return 'w';
}

/**
 * Renders a receipt photo with OCR block overlays, and a "clean copy" rebuilt from the same blocks.
 * Coordinates are fractions of the page so everything scales with the element.
 */
export class ReceiptView {
	constructor() {
		this.photo = h('img', { class: 'rv-photo', alt: 'Receipt photo', draggable: 'false' });
		this.photo.addEventListener('load', () => this.photo.classList.add('loaded'));
		this.paper = h('div', { class: 'rv-paper' });
		this.boxes = h('div', { class: 'rv-boxes' });
		this.el = h('div', { class: 'rv' }, this.photo, this.paper, this.boxes, h('div', { class: 'rv-scanline' }));
		this.blocks = [];
		this.boxEls = [];
		this.lineEls = [];
		this.resizeObserver = new ResizeObserver(() => this.layoutPaper());
		this.resizeObserver.observe(this.el);
	}

	setImage(src, width, height) {
		this.el.style.setProperty('--ar', width / height);
		this.el.classList.toggle('no-photo', !src);
		if (src === this.photo.getAttribute('src')) return;
		this.photo.classList.remove('loaded');
		if (src) this.photo.src = src;
		else this.photo.removeAttribute('src');
	}

	/** Resolves once the photo is decoded (or after `timeout`), so transitions capture a finished frame. */
	ready(timeout = 1500) {
		if (!this.photo.getAttribute('src')) return Promise.resolve();
		return Promise.race([
			this.photo
				.decode()
				.then(() => this.photo.classList.add('loaded'))
				.catch(() => undefined),
			sleep(timeout),
		]);
	}

	scanning(on) {
		this.el.classList.toggle('is-scanning', on);
	}

	reset() {
		this.el.className = 'rv';
		this.boxes.replaceChildren();
		this.paper.replaceChildren();
		this.blocks = [];
		this.boxEls = [];
		this.lineEls = [];
	}

	/** Build overlays for an OCR page. With `revealed`, everything is shown immediately (no animation). */
	setOcr(ocr, { revealed = false } = {}) {
		this.blocks = ocr.blocks;
		this.boxes.replaceChildren();
		this.paper.replaceChildren();
		this.el.style.setProperty('--ar', ocr.width / ocr.height);

		this.boxEls = this.blocks.map((b, k) => {
			const [x0, y0, x1, y1] = b.box;
			const conf = b.minConf === null ? '' : `${Math.round(b.minConf * 100)}%`;
			const el = h(
				'div',
				{
					class: `box t-${b.type}`,
					style: { left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0) },
					title: `${b.type}${conf ? ` · min confidence ${conf}` : ''}\n${b.text}`,
				},
				h('span', { class: 'box-tag' }, b.type),
			);
			if ((b.minConf ?? 1) < UNSURE) el.classList.add('unsure');
			if (b.sensitive) el.classList.add('sensitive');
			el.style.setProperty('--k', k);
			return el;
		});
		this.boxes.append(...this.boxEls);

		this.lineEls = this.blocks.map((b, k) => {
			const [x0, y0, x1, y1] = b.box;
			const line = h('div', { class: `line t-${b.type}`, style: { left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0) } });
			line.style.setProperty('--k', k);
			if (b.type === 'image') line.append(h('span', { class: 'ph' }, 'Image'));
			else if (b.sensitive) line.append(h('span', { class: 'redacted-bar' }, 'Card number hidden'));
			else {
				const last = b.words[b.words.length - 1];
				const split = b.words.length >= 2 && PRICE.test(last.t) && !b.text.includes('\n');
				const inner = h('span', { class: `line-text${split ? ' split' : ''}` });
				if (split) inner.append(wordSpans(b.words.slice(0, -1)), wordSpans([last]));
				else inner.append(...wordSpans(b.words).childNodes);
				line.append(inner);
			}
			return line;
		});
		this.paper.append(...this.lineEls);

		if (revealed) this.el.classList.add('revealed', 'show-unsure', 'show-redact');
		requestAnimationFrame(() => this.layoutPaper());
	}

	/**
	 * Size each clean-copy line to fill its block: font size from height, horizontal scale from width.
	 * Only runs while the text view is visible, and batches writes and reads to avoid layout thrashing.
	 */
	layoutPaper() {
		const H = this.el.clientHeight;
		if (!H || !this.lineEls.length) return;
		if (!this.el.classList.contains('clean') && !this.el.classList.contains('no-photo')) return;
		const lines = this.lineEls.map((line, k) => {
			const b = this.blocks[k];
			const rows = Math.max(1, b.text.split('\n').length);
			line.style.fontSize = `${Math.max(5, Math.min(56, (((b.box[3] - b.box[1]) * H) / rows) * 0.74))}px`;
			const inner = line.querySelector('.line-text');
			if (inner) {
				inner.classList.toggle('multi', rows > 1);
				inner.style.transform = '';
			}
			return { line, inner, rows };
		});
		const sizes = lines.map(({ line, inner, rows }) => (inner && rows === 1 ? [inner.scrollWidth, line.clientWidth] : null));
		lines.forEach(({ inner }, k) => {
			const [need, avail] = sizes[k] ?? [];
			if (!need || !avail) return;
			const fit = inner.classList.contains('split') ? Math.min(1, avail / need) : Math.min(1.3, Math.max(0.35, avail / need));
			inner.style.transform = `scaleX(${fit})`;
		});
	}

	/** Boxes appear in reading order. Resolves when the sequence has finished. */
	async reveal() {
		this.scanning(false);
		const n = this.boxEls.length;
		const step = Math.max(14, Math.min(60, 1400 / Math.max(1, n)));
		this.el.style.setProperty('--step', `${step}ms`);
		this.el.classList.add('revealing');
		await sleep(n * step + 450);
		this.el.classList.add('revealed');
		await sleep(150);
		this.el.classList.add('show-unsure');
	}

	/** Blur sensitive blocks (card numbers). Returns how many were redacted. */
	async redact() {
		const n = this.blocks.filter((b) => b.sensitive).length;
		if (n) {
			this.el.classList.add('show-redact');
			await sleep(700);
		}
		return n;
	}

	morph(clean) {
		this.el.classList.toggle('clean', clean);
		if (clean) this.layoutPaper();
	}

	get isClean() {
		return this.el.classList.contains('clean');
	}

	highlight(ids, kind = 'focus') {
		this.clearHighlight();
		for (const i of ids ?? []) {
			this.boxEls[i]?.classList.add('hl', `hl-${kind}`);
			this.lineEls[i]?.classList.add('hl', `hl-${kind}`);
		}
	}

	clearHighlight() {
		for (const el of [...this.boxEls, ...this.lineEls]) {
			if (!el.classList.contains('hl')) continue;
			el.classList.remove('hl', ...KINDS.map((k) => `hl-${k}`));
		}
	}

	/** Persistent annotation (policy violation, math error) with a callout label. */
	mark(ids, kind, text) {
		const valid = (ids ?? []).filter((i) => this.boxEls[i]);
		if (!valid.length) return;
		for (const i of valid) this.boxEls[i].classList.add('mark', `mark-${kind}`);
		const last = this.blocks[valid[valid.length - 1]];
		const first = this.blocks[valid[0]];
		const callout = h('div', { class: `callout c-${kind}`, style: { left: pct(first.box[0]), top: pct(last.box[3]) } }, text);
		this.boxes.append(callout);
	}

	rectOf(ids) {
		const rects = (ids ?? []).map((i) => this.boxEls[i]?.getBoundingClientRect()).filter(Boolean);
		if (!rects.length) return null;
		const left = Math.min(...rects.map((r) => r.left));
		const top = Math.min(...rects.map((r) => r.top));
		return new DOMRect(left, top, Math.max(...rects.map((r) => r.right)) - left, Math.max(...rects.map((r) => r.bottom)) - top);
	}

	/** Produce a copy of the photo with sensitive blocks painted over, for storage. */
	async redactedBlob(img) {
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d');
		ctx.drawImage(img, 0, 0);
		ctx.fillStyle = '#1d1c1a';
		for (const b of this.blocks.filter((x) => x.sensitive)) {
			const [x0, y0, x1, y1] = b.box;
			const pad = 0.01;
			ctx.fillRect((x0 - pad) * canvas.width, (y0 - pad) * canvas.height, (x1 - x0 + 2 * pad) * canvas.width, (y1 - y0 + 2 * pad) * canvas.height);
		}
		return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
	}
}
