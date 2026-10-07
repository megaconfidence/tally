import { api } from './api.js';
import { CATEGORY_ICON, icon } from './icons.js';
import { h, label, money } from './util.js';

const needsReview = (e) => e.policy_count > 0 || !e.math_ok || Boolean(e.duplicate_of);

function reviewReasons(e) {
	const out = [];
	if (e.policy_count) out.push('outside policy');
	if (!e.math_ok) out.push("totals don't add up");
	if (e.duplicate_of) out.push(`possible duplicate of #${e.duplicate_of}`);
	return out.join(', ');
}

function groupLabel(iso) {
	if (!iso) return 'No date';
	const d = new Date(`${iso}T12:00:00`);
	const today = new Date();
	const days = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86_400_000);
	if (days === 0) return 'Today';
	if (days === 1) return 'Yesterday';
	return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** Sidebar list of expenses, grouped by receipt date. */
export class Ledger {
	constructor(root, { onOpen, onIntent }) {
		this.root = root;
		this.onOpen = onOpen;
		this.onIntent = onIntent;
		this.list = root.querySelector('.l-list');
		this.totalEl = root.querySelector('.l-total');
		this.countEl = root.querySelector('.l-count');
		this.expenses = [];
		this.home = 'GBP';
		this.arrived = null;
		this.loaded = false;
	}

	byId(id) {
		return this.expenses.find((e) => e.id === id);
	}

	async load() {
		const first = !this.loaded;
		this.expenses = await api.list();
		this.loaded = true;
		this.render();
		if (first) this.stagger();
	}

	/** Rows ease in one after another; used once, when the list first appears. */
	stagger() {
		[...this.list.children].forEach((el, i) => el.style.setProperty('--i', Math.min(i, 12)));
		this.list.classList.add('stagger');
		setTimeout(() => this.list.classList.remove('stagger'), 900);
	}

	setHome(currency) {
		this.home = currency;
		this.renderTotals();
	}

	remove(id) {
		this.expenses = this.expenses.filter((e) => e.id !== id);
		this.render();
	}

	renderTotals() {
		const total = this.expenses.reduce((a, e) => a + (e.total_home ?? 0), 0);
		const n = this.expenses.length;
		const review = this.expenses.filter(needsReview).length;
		this.totalEl.textContent = money(total, this.home);
		this.countEl.replaceChildren(
			n ? `${n} receipt${n === 1 ? '' : 's'}` : 'No receipts yet',
			review ? h('span', { class: 'review' }, ` · ${review} to review`) : '',
		);
	}

	row(e) {
		const foreign = e.currency !== e.home_currency;
		const sub = needsReview(e) ? (e.city ?? label(e.category)) : [e.city, label(e.category)].filter(Boolean).join(' · ');
		return h(
			'div',
			{
				class: 'lrow',
				role: 'listitem',
				tabindex: '0',
				dataset: { id: e.id },
				onclick: () => this.onOpen(e.id),
				// Start loading as soon as the user shows intent, so the page is ready when the tap lands.
				onpointerenter: () => this.onIntent?.(e.id),
				onpointerdown: () => this.onIntent?.(e.id),
				onfocus: () => this.onIntent?.(e.id),
				onkeydown: (ev) => {
					if (ev.key === 'Enter') this.onOpen(e.id);
				},
			},
			h('div', { class: `cat cat-${e.category}`, title: label(e.category) }, icon(CATEGORY_ICON[e.category] ?? 'receipt', 16)),
			h(
				'div',
				{},
				h('div', { class: 'l-merchant' }, e.merchant),
				h('div', { class: 'l-sub' }, needsReview(e) ? h('span', { class: 'l-flag', title: reviewReasons(e) }, 'Review') : null, sub),
			),
			h(
				'div',
				{ class: 'l-amt' },
				h('div', {}, e.total_home !== null ? money(e.total_home, e.home_currency) : money(e.total, e.currency)),
				foreign && e.total_home !== null ? h('div', { class: 'l-orig' }, money(e.total, e.currency)) : null,
			),
		);
	}

	render() {
		this.renderTotals();
		if (!this.expenses.length) {
			this.list.replaceChildren(h('div', { class: 'l-empty' }, 'Scan a receipt or try a sample to get started.'));
			return;
		}
		const sorted = [...this.expenses].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id);
		const nodes = [];
		let current;
		for (const e of sorted) {
			const g = groupLabel(e.date);
			if (g !== current) {
				nodes.push(h('div', { class: 'l-group' }, g));
				current = g;
			}
			nodes.push(this.row(e));
		}
		this.list.replaceChildren(...nodes);
	}

	/** Add a newly saved expense; it is highlighted the next time the list is shown. */
	add(expense) {
		this.expenses = [expense, ...this.expenses.filter((e) => e.id !== expense.id)];
		this.arrived = expense.id;
		this.render();
	}

	/** Called when the list becomes visible: flash the most recently added row once. */
	revealArrived() {
		if (this.arrived === null || this.arrived === undefined) return;
		const el = this.list.querySelector(`[data-id="${this.arrived}"]`);
		this.arrived = null;
		if (!el) return;
		el.scrollIntoView({ block: 'nearest' });
		el.classList.add('arrived');
		setTimeout(() => el.classList.remove('arrived'), 1900);
	}
}
