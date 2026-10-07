import { api } from './api.js';
import { renderChecks, renderFields } from './fields.js';
import { ReceiptView } from './receipt-view.js';
import { DUR, fly, h, sleep, toast } from './util.js';

const STEPS = ['ocr', 'extraction', 'checks', 'saved'];
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Extraction screen: shows the receipt while Mistral OCR reads it (block reveal, redaction, text view),
 * fills in the fields as they arrive, then hands the saved expense to `onDone`.
 */
export class ProcessScreen {
	constructor(root, { onDone, onSaved, onCompare }) {
		this.root = root;
		this.onDone = onDone;
		this.onSaved = onSaved;
		this.onCompare = onCompare;
		this.title = root.querySelector('.process-title');
		this.timeline = root.querySelector('.timeline');
		this.body = root.querySelector('.extract-body');
		this.view = new ReceiptView();
		root.querySelector('.result').append(this.view.el);
		this.busy = false;
		this.current = null;
	}

	/** The redacted image just uploaded for `id`, so the summary can show it without downloading it again. */
	imageFor(id) {
		return this.savedImage?.id === id ? this.savedImage.url : null;
	}

	step(name, status, detail = '') {
		const li = this.timeline.querySelector(`[data-step="${name}"]`);
		li.dataset.status = status;
		li.querySelector('.t-detail').textContent = detail;
	}

	fail(message) {
		const active = this.timeline.querySelector('[data-status="active"]');
		if (active) this.step(active.dataset.step, 'failed', 'Failed');
		this.title.textContent = "Couldn't read receipt";
		this.view.scanning(false);
		this.body.replaceChildren(
			h(
				'div',
				{ class: 'fields-error' },
				h('strong', {}, 'Something went wrong'),
				h('p', {}, message),
				h('div', { class: 'error-actions' }, h('a', { class: 'btn', href: '#/scan' }, 'Try again'), h('a', { class: 'btn', href: '#/' }, 'Back to expenses')),
			),
		);
	}

	/**
	 * Set up the screen for a new scan and start it in the background. Resolves as soon as the
	 * receipt photo is ready to be shown, so the screen transition captures a finished frame.
	 */
	start(shot) {
		if (this.busy) return Promise.resolve();
		this.busy = true;
		if (this.current?.url) URL.revokeObjectURL(this.current.url);
		const url = URL.createObjectURL(shot.blob);
		const data = { ocr: null, extraction: null, sources: null, checks: null };
		this.current = { url, shot, data };

		this.title.textContent = 'Reading receipt';
		this.view.reset();
		this.view.setImage(url, shot.width, shot.height);
		// The scan effect starts once the screen transition has settled, not halfway through it.
		setTimeout(() => {
			if (this.current?.data === data && !data.ocr) this.view.scanning(true);
		}, DUR.morph);
		for (const s of STEPS) this.step(s, 'pending');
		this.step('ocr', 'active');
		this.body.replaceChildren();

		this.run(shot, data);
		return this.view.ready();
	}

	async run(shot, data) {
		const t0 = performance.now();
		let fieldsEl = null;
		let saved = null;
		let queue = Promise.resolve();

		const handle = async (e) => {
			if (e.type === 'error') throw new Error(e.message);
			if (e.type === 'ocr') {
				data.ocr = e.ocr;
				this.step('ocr', 'done', `${e.ocr.blocks.length} blocks · ${secs(e.ocr.ms)}`);
				this.step('extraction', 'active');
				this.view.setOcr(e.ocr);
				await this.view.reveal();
				await this.view.redact();
				await sleep(500);
				this.view.morph(true);
				await sleep(700);
			}
			if (e.type === 'extraction') {
				data.extraction = e.extraction;
				data.sources = e.sources;
				this.title.textContent = e.extraction.merchant;
				this.step('extraction', 'done', secs(e.ms));
				this.step('checks', 'active');
				const { el, rows } = renderFields(data, this.view, { pending: true });
				fieldsEl = el;
				this.body.replaceChildren(el);
				const landings = [];
				for (const row of rows) {
					const rect = this.view.rectOf(row.sources);
					const target = row.valueEl.getBoundingClientRect();
					const visible = target.top < innerHeight && target.bottom > 0;
					if (rect && visible) {
						this.view.highlight(row.sources, row.key.startsWith('item') ? 'item' : row.key);
						landings.push(fly(rect, row.valueEl, row.text).then(() => row.el.classList.remove('pending')));
						await sleep(140);
					} else {
						if (rect) this.view.highlight(row.sources, row.key.startsWith('item') ? 'item' : row.key);
						row.el.classList.remove('pending');
						await sleep(rect ? 120 : 40);
					}
				}
				await Promise.all(landings);
				this.view.clearHighlight();
			}
			if (e.type === 'checks') {
				data.checks = e.checks;
				renderChecks(fieldsEl, data, this.view, { onCompare: (id) => this.onCompare?.(this.current, id) });
				const issues = e.checks.policy.length + (e.checks.math.ok ? 0 : 1) + (e.checks.duplicate ? 1 : 0);
				this.step('checks', 'done', issues ? `${issues} to review` : 'No issues');
				this.step('saved', 'active');
			}
			if (e.type === 'saved') {
				saved = e.expense;
				try {
					const blob = await this.view.redactedBlob(this.view.photo);
					await api.uploadImage(saved.id, blob);
					saved.has_image = true;
					if (this.savedImage) URL.revokeObjectURL(this.savedImage.url);
					this.savedImage = { id: saved.id, url: URL.createObjectURL(blob) };
				} catch (err) {
					toast(`Couldn't store the receipt image: ${err.message}`, 'error');
				}
				this.onSaved?.(saved);
				this.step('saved', 'done', `${secs(performance.now() - t0)} total`);
			}
		};

		try {
			await api.scan(shot.blob, (e) => {
				queue = queue.then(() => handle(e));
			});
			await queue;
			if (!saved) throw new Error('The scan ended before the expense was saved');
			await sleep(700);
			this.onDone?.(saved);
		} catch (err) {
			this.fail(err.message);
		} finally {
			this.busy = false;
		}
	}
}
