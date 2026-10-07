import { icon } from './icons.js';
import { h, label, money, prettyDate } from './util.js';

const kindOf = (key) => (key.startsWith('item') ? 'item' : key);
const LANGUAGES = { fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', ja: 'Japanese', nl: 'Dutch', pt: 'Portuguese', zh: 'Chinese', ko: 'Korean' };

/**
 * Render the extracted fields of a receipt. Hovering a row highlights its source blocks on `view`.
 * Returns the element and the rows (in reveal order) so callers can animate values in.
 */
export function renderFields(data, view, { pending = false } = {}) {
	const { extraction: ex, sources } = data;
	const cur = ex.currency;
	const rows = [];
	const f = sources.fields ?? {};

	const row = (key, name, value, src, { cls = '', extra = null } = {}) => {
		const valueEl = h('div', { class: 'f-value' }, value);
		const el = h(
			'div',
			{
				class: `f-row ${cls}${pending ? ' pending' : ''}`,
				dataset: { key },
				onmouseenter: () => view?.highlight(src, kindOf(key)),
				onmouseleave: () => view?.clearHighlight(),
				onclick: () => {
					if (!src?.length || !view) return;
					view.highlight(src, kindOf(key));
					const r = view.el.getBoundingClientRect();
					if (r.top > innerHeight || r.bottom < 0) view.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				},
			},
			h('div', { class: 'f-name' }, name),
			valueEl,
			extra,
		);
		rows.push({ key, el, valueEl, sources: src ?? [], text: valueEl.textContent || (typeof name === 'string' ? name : name.textContent) });
		return el;
	};

	const head = h(
		'div',
		{ class: 'f-head' },
		row('merchant', 'Merchant', ex.merchant, f.merchant, { cls: 'f-merchant' }),
		ex.merchant_address ? row('address', 'Address', ex.merchant_address, f.address, { cls: 'f-address' }) : null,
	);

	const details = h(
		'div',
		{},
		h('div', { class: 'f-section' }, 'Details'),
		h(
			'div',
			{ class: 'f-list' },
			row('date', 'Date', `${prettyDate(ex.date)}${ex.time ? `, ${ex.time}` : ''}`, f.date),
			row('category', 'Category', label(ex.category).replace(/^\w/, (c) => c.toUpperCase()), []),
			ex.city ? row('location', 'Location', `${ex.city}${ex.country_code ? `, ${ex.country_code}` : ''}`, f.address) : null,
			ex.payment_method || ex.card_last4
				? row('card', 'Payment', `${ex.payment_method ?? 'Card'}${ex.card_last4 ? ` ending ${ex.card_last4}` : ''}`, f.card)
				: null,
		),
	);

	const language = ex.language && ex.language !== 'en' ? (LANGUAGES[ex.language] ?? ex.language.toUpperCase()) : null;
	const items = h(
		'div',
		{},
		h('div', { class: 'f-section' }, `Items (${ex.line_items.length})`, language ? h('span', { class: 'lang' }, `Translated from ${language}`) : null),
		h(
			'div',
			{ class: 'f-list' },
			ex.line_items.map((it, i) =>
				row(
					`item${i}`,
					h(
						'span',
						{},
						it.quantity && it.quantity !== 1 && !/^\d/.test(it.description_en) ? h('span', { class: 'qty' }, `${it.quantity} ×`) : null,
						it.description_en,
					),
					money(it.amount, cur),
					sources.items?.[i],
					{
						cls: 'f-item',
						extra: it.description_en.toLowerCase() !== it.description.toLowerCase() ? h('div', { class: 'f-orig' }, it.description) : null,
					},
				),
			),
		),
	);

	const totals = h(
		'div',
		{ class: 'f-list f-totals' },
		ex.subtotal !== null ? row('subtotal', 'Subtotal', money(ex.subtotal, cur), f.subtotal) : null,
		ex.discount ? row('discount', 'Discount', `−${money(ex.discount, cur)}`, f.discount) : null,
		ex.tax !== null ? row('tax', ex.tax_included ? 'Tax (included)' : 'Tax', money(ex.tax, cur), f.tax) : null,
		ex.tip !== null
			? row('tip', 'Tip', money(ex.tip, cur), f.tip, { extra: ex.tip_handwritten ? h('span', { class: 'hand' }, icon('pen', 12), 'Handwritten') : null })
			: null,
		row('total', 'Total', money(ex.total, cur), f.total, { cls: 'f-total' }),
	);

	const el = h('div', { class: 'fields' }, head, h('div', { class: 'checks' }), details, items, h('div', {}, totals, h('div', { class: 'f-fx' })));
	return { el, rows };
}

/** Render currency conversion and review notes (math, duplicate, policy) under the fields. */
export function renderChecks(fieldsEl, data, view, { onCompare } = {}) {
	const { extraction: ex, sources, checks } = data;
	const fx = fieldsEl.querySelector('.f-fx');
	if (checks.fx && checks.fx.from !== checks.fx.to) {
		fx.replaceChildren(
			`≈ ${money(checks.fx.amount, checks.fx.to)}`,
			h('span', { class: 'fx-rate' }, `1 ${checks.fx.from} = ${checks.fx.rate} ${checks.fx.to}, ECB rate on ${prettyDate(checks.fx.date)}`),
		);
		fx.classList.add('in');
	}

	const list = fieldsEl.querySelector('.checks');
	list.replaceChildren();
	const note = (kind, iconName, title, detail, src, extra) =>
		h(
			'div',
			{
				class: `check c-${kind}`,
				onmouseenter: () => view?.highlight(src, kind === 'bad' ? 'math' : kind === 'policy' ? 'policy' : 'total'),
				onmouseleave: () => view?.clearHighlight(),
			},
			icon(iconName, 16),
			h('div', { class: 'check-title' }, title),
			detail ? h('div', { class: 'check-detail' }, detail) : null,
			extra,
		);

	const notes = [];
	for (const v of checks.policy) notes.push(note('policy', 'alertCircle', 'Outside expense policy', `${v.reason} (${v.rule.replace(/^\d+\.\s*/, '')})`, v.blocks));
	if (!checks.math.ok) notes.push(note('bad', 'alertCircle', "Totals don't add up", checks.math.formula, sources.fields.total));
	if (checks.duplicate) {
		const d = checks.duplicate;
		notes.push(
			note(
				'warn',
				'copy',
				'Possible duplicate',
				`Matches #${d.id}, ${d.merchant} on ${prettyDate(d.date)} for ${money(d.total, d.currency)}.`,
				[...(sources.fields.merchant ?? []), ...(sources.fields.date ?? []), ...(sources.fields.total ?? [])],
				onCompare ? h('button', { class: 'btn small', onclick: () => onCompare(d.id) }, 'Compare receipts') : null,
			),
		);
	}
	if (checks.math.ok) notes.push(note('ok', 'checkCircle', 'Totals add up', checks.math.formula, sources.fields.total));
	if (!checks.policy.length) notes.push(note('ok', 'checkCircle', 'Within expense policy', null, []));
	if (ex.tip_handwritten) notes.push(note('info', 'pen', 'Handwriting read', 'The tip or total was written by hand.', sources.fields.tip ?? sources.fields.total));
	if (data.ocr?.blocks.some((b) => b.sensitive)) {
		notes.push(note('info', 'shield', 'Card number hidden', 'Covered on the stored image.', sources.fields.card));
	}
	notes.forEach((el, i) => {
		el.style.animationDelay = `${i * 70}ms`;
		list.append(el);
	});
}

/** Draw persistent marks on the receipt for failing checks. */
export function markChecks(view, data) {
	const { checks, sources } = data;
	if (!checks.math.ok) view.mark(sources.fields.total, 'math', `Off by ${Math.abs(checks.math.difference ?? 0).toFixed(2)}`);
	for (const v of checks.policy) view.mark(v.blocks, 'policy', v.rule.replace(/^\d+\.\s*/, ''));
}
