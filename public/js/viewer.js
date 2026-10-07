import { api } from './api.js';
import { markChecks, renderChecks, renderFields } from './fields.js';
import { ReceiptView } from './receipt-view.js';
import { closeDialog, h, money, prettyDate, sleep, toast, wireDialog } from './util.js';

/** Summary / detail page for a stored expense, with every value linked to its source on the receipt. */
export class ExpenseDetail {
	constructor(root, { onCompare, onDeleted }) {
		this.root = root;
		this.onCompare = onCompare;
		this.onDeleted = onDeleted;
		this.body = root.querySelector('.detail-body');
		this.title = root.querySelector('.detail-title');
		this.seg = root.querySelector('#detail-viewmode');
		this.banner = root.querySelector('.saved-banner');
		this.actions = root.querySelector('.detail-actions');
		this.view = new ReceiptView();
		root.querySelector('.detail-media').append(this.view.el);
		this.id = null;
		this.cache = new Map();
		for (const btn of this.seg.querySelectorAll('button')) btn.addEventListener('click', () => this.setMode(btn.dataset.mode));
		root.querySelector('.detail-delete').addEventListener('click', () => this.delete());
		window.addEventListener('keydown', (e) => {
			if (this.root.hidden || e.target.closest?.('input, textarea, dialog[open]') || e.metaKey || e.ctrlKey) return;
			if (e.key.toLowerCase() === 't' && !this.seg.hidden) this.setMode(this.view.isClean ? 'photo' : 'clean');
		});
	}

	setMode(mode) {
		this.view.morph(mode === 'clean');
		for (const btn of this.seg.querySelectorAll('button')) btn.classList.toggle('active', btn.dataset.mode === mode);
	}

	/**
	 * Start loading an expense and its receipt image (on hover or touch, before the tap completes).
	 * Entries live for a minute so a tap right after a hover reuses the request.
	 */
	prefetch(id) {
		const hit = this.cache.get(id);
		if (hit && Date.now() - hit.at < 60_000) return hit;
		const data = api.get(id);
		const image = data
			.then((d) => {
				if (!d.has_image) return;
				const img = new Image();
				img.src = api.imageUrl(id);
				return img.decode();
			})
			.catch(() => undefined);
		const entry = { at: Date.now(), data, image };
		data.catch(() => this.cache.delete(id));
		this.cache.set(id, entry);
		return entry;
	}

	invalidate(id) {
		if (id === undefined) this.cache.clear();
		else this.cache.delete(id);
	}

	/**
	 * Fetch an expense, giving its image up to `imageWait` ms to arrive so the screen transition shows
	 * a complete page. Returns null (after telling the user) if it can't be loaded.
	 */
	async load(id, { imageWait = 200 } = {}) {
		try {
			const entry = this.prefetch(id);
			const detail = await entry.data;
			await Promise.race([entry.image, sleep(imageWait)]);
			return detail;
		} catch (err) {
			toast(err.message, 'error');
			return null;
		}
	}

	/**
	 * Render a loaded expense. `isNew` shows the saved confirmation; `imageUrl` overrides the stored image
	 * (the summary uses the copy already in memory). Resolves when the image is ready, or after a short cap.
	 */
	render(detail, { isNew = false, imageUrl = null } = {}) {
		this.id = detail.id;
		this.detail = detail;
		this.title.textContent = isNew ? 'Summary' : detail.merchant;
		this.banner.hidden = !isNew;
		this.actions.hidden = !isNew;
		if (isNew) {
			const issues = detail.policy_count + (detail.math_ok ? 0 : 1) + (detail.duplicate_of ? 1 : 0);
			this.banner.classList.toggle('warn', issues > 0);
			this.banner.querySelector('.saved-time').textContent = issues ? `${issues} thing${issues > 1 ? 's' : ''} to review below` : 'Everything looks good';
		}
		const image = imageUrl ?? (detail.has_image ? api.imageUrl(detail.id) : null);
		this.view.reset();
		this.view.setImage(image, detail.ocr.width, detail.ocr.height);
		this.view.setOcr(detail.ocr, { revealed: true });
		markChecks(this.view, detail);
		const { el } = renderFields(detail, this.view);
		renderChecks(el, detail, this.view, { onCompare: (otherId) => this.onCompare({ detail }, otherId) });
		this.body.replaceChildren(el);
		this.seg.hidden = !image;
		this.setMode(image ? 'photo' : 'clean');
		return this.view.ready(120);
	}

	/** Highlight a field (e.g. "total") and its source on the receipt. */
	focus(key) {
		const detail = this.detail;
		if (!detail || !key) return;
		const ids = key.startsWith('item') ? detail.sources.items[Number(key.slice(4))] : detail.sources.fields[key];
		this.view.highlight(ids, key.startsWith('item') ? 'item' : key);
		this.body.querySelector(`[data-key="${key}"]`)?.classList.add('flash');
	}

	async delete() {
		if (this.id === null || !confirm('Delete this expense and its receipt image?')) return;
		try {
			await api.remove(this.id);
			const id = this.id;
			this.id = null;
			this.onDeleted?.(id);
		} catch (err) {
			toast(err.message, 'error');
		}
	}
}

/** Side-by-side comparison for duplicate detection. */
export class CompareDialog {
	constructor(dialog) {
		this.dialog = dialog;
		this.body = dialog.querySelector('.c-body');
		this.views = [];
		wireDialog(dialog);
		dialog.querySelector('.c-close').addEventListener('click', () => closeDialog(dialog));
		dialog.addEventListener('close', () => {
			for (const v of this.views) v.resizeObserver.disconnect();
			this.views = [];
			this.body.replaceChildren();
		});
	}

	/** `left` is { detail } for a stored expense, or an in-progress scan ({ data, url }). */
	async open(left, rightId) {
		let right;
		try {
			right = await api.get(rightId);
		} catch (err) {
			toast(err.message, 'error');
			return;
		}
		const leftDetail = left.detail ?? { ...left.data, has_image: true, id: null };
		const leftImage = left.detail ? (left.detail.has_image ? api.imageUrl(left.detail.id) : null) : left.url;

		const col = (detail, imageUrl, caption) => {
			const view = new ReceiptView();
			view.setImage(imageUrl, detail.ocr.width, detail.ocr.height);
			view.setOcr(detail.ocr, { revealed: true });
			this.views.push(view);
			const ids = ['merchant', 'date', 'total'].flatMap((k) => detail.sources.fields[k] ?? []);
			requestAnimationFrame(() => view.highlight(ids, 'focus'));
			const ex = detail.extraction;
			return h(
				'div',
				{ class: 'c-col' },
				h('div', { class: 'c-caption' }, caption, h('span', {}, `${ex.merchant} · ${prettyDate(ex.date)} · ${money(ex.total, ex.currency)}`)),
				h('div', { class: 'c-media' }, view.el),
			);
		};
		this.body.replaceChildren(
			col(leftDetail, leftImage, leftDetail.id ? `Expense #${leftDetail.id}` : 'This scan'),
			col(right, right.has_image ? api.imageUrl(right.id) : null, `Expense #${right.id}, scanned ${new Date(right.created_at).toLocaleString()}`),
		);
		if (!this.dialog.open) this.dialog.showModal();
	}
}
