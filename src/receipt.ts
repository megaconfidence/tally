import type { Block, Extraction, FieldKey, LineItem, MathCheck, Sources, Word } from './types';

export const CATEGORIES = ['food_and_drink', 'groceries', 'transport', 'lodging', 'shopping', 'personal_care', 'entertainment', 'services', 'other'];

const nullable = (type: string, description: string) => ({ type: [type, 'null'], description });

export const RECEIPT_SCHEMA = {
	type: 'json_schema',
	json_schema: {
		name: 'receipt',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			properties: {
				merchant: {
					type: 'string',
					description: 'Business name as printed: the brand rather than the legal entity, and the restaurant or store rather than a delivery platform',
				},
				merchant_address: nullable('string', 'Merchant street address as printed'),
				city: nullable('string', 'City or town of the merchant, in its common English name'),
				country_code: nullable('string', 'ISO 3166-1 alpha-2 country code of the merchant'),
				date: nullable('string', 'Transaction date as YYYY-MM-DD'),
				time: nullable('string', 'Transaction time as HH:MM (24h)'),
				currency: { type: 'string', description: 'ISO 4217 code inferred from symbols, language and address, e.g. GBP, EUR, JPY' },
				language: { type: 'string', description: 'ISO 639-1 code of the main language of the receipt' },
				category: { type: 'string', enum: CATEGORIES },
				line_items: {
					type: 'array',
					description: 'Purchased products or services. Exclude totals, taxes, payments and zero-priced modifiers.',
					items: {
						type: 'object',
						additionalProperties: false,
						properties: {
							description: { type: 'string', description: 'Item name exactly as printed, without the price' },
							description_en: { type: 'string', description: 'Short, readable English name for the item (expand abbreviations)' },
							quantity: nullable('number', 'Quantity if printed'),
							amount: { type: 'number', description: 'Line amount as printed, before receipt-level discounts' },
						},
						required: ['description', 'description_en', 'quantity', 'amount'],
					},
				},
				subtotal: nullable('number', 'Subtotal as printed, before tip'),
				discount: nullable('number', 'Total of discounts, special offers or coupons as a positive number'),
				tax: nullable('number', 'Total tax / VAT amount as printed'),
				tax_included: { type: 'boolean', description: 'True when prices already include tax (typical VAT receipts)' },
				tip: nullable('number', 'Tip or gratuity, including handwritten tips'),
				tip_handwritten: { type: 'boolean', description: 'True when the tip or the final total is written by hand' },
				total: { type: 'number', description: 'Final amount paid, including a handwritten total when present' },
				payment_method: nullable('string', 'e.g. Visa, Mastercard, cash'),
				card_last4: nullable('string', 'Last 4 digits of a masked card number such as XXXX1234. Null when no masked card number is printed.'),
			},
			required: [
				'merchant',
				'merchant_address',
				'city',
				'country_code',
				'date',
				'time',
				'currency',
				'language',
				'category',
				'line_items',
				'subtotal',
				'discount',
				'tax',
				'tax_included',
				'tip',
				'tip_handwritten',
				'total',
				'payment_method',
				'card_last4',
			],
		},
	},
};

export function annotationPrompt(today: string): string {
	return [
		'Extract the expense from this receipt photo.',
		`Today is ${today}. If the year is not printed, use the most recent such date that is not in the future.`,
		'Use numbers with a dot as decimal separator. Never invent values: use null when a field is not on the receipt.',
	].join(' ');
}

// ---------------------------------------------------------------------------
// Blocks

interface RawBlock {
	type: string;
	content: string;
	top_left_x: number;
	top_left_y: number;
	bottom_right_x: number;
	bottom_right_y: number;
}

interface RawWord {
	text: string;
	confidence: number;
	start_index: number;
}

export interface RawPage {
	markdown: string;
	dimensions: { width: number; height: number };
	blocks: RawBlock[] | null;
	confidence_scores: { word_confidence_scores?: RawWord[]; average_page_confidence_score?: number; minimum_page_confidence_score?: number } | null;
}

const MARKUP_ONLY = /^[#*_|`>\-\s]*$/;

export function cleanText(content: string): string {
	return content
		.replace(/^#+\s*/gm, '')
		.replace(/\*\*|__/g, '')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.trim();
}

/** Turn a raw OCR page into blocks with normalized boxes and the words (with confidence) that belong to each block. */
export function buildBlocks(page: RawPage): Block[] {
	const { width, height } = page.dimensions;
	const md = page.markdown;
	const words = page.confidence_scores?.word_confidence_scores ?? [];
	let cursor = 0;
	let w = 0;
	return (page.blocks ?? []).map((raw, i) => {
		const start = md.indexOf(raw.content, cursor);
		const blockWords: Word[] = [];
		if (start >= 0 && raw.content.length > 0) {
			const end = start + raw.content.length;
			cursor = end;
			while (w < words.length && words[w].start_index < start) w++;
			while (w < words.length && words[w].start_index < end) {
				const t = words[w].text.trim();
				if (t && !MARKUP_ONLY.test(t)) blockWords.push({ t: t.replace(/\*\*/g, ''), c: words[w].confidence });
				w++;
			}
		}
		const confs = blockWords.map((x) => x.c);
		const text = raw.type === 'image' ? '' : cleanText(raw.content);
		return {
			i,
			type: raw.type,
			box: [raw.top_left_x / width, raw.top_left_y / height, raw.bottom_right_x / width, raw.bottom_right_y / height],
			text,
			words: blockWords.length ? blockWords : text.split(/\s+/).filter(Boolean).map((t) => ({ t, c: 1 })),
			minConf: confs.length ? Math.min(...confs) : null,
			avgConf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
		};
	});
}

// ---------------------------------------------------------------------------
// Sensitive data

const MASKED_PAN = /[X*•#]{4,}[\sX*•#-]*\d{4}/i;
const FULL_PAN = /(?<!\d)(?:\d[ -]?){14,18}\d(?!\d)/;

function luhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
	}
	return sum % 10 === 0;
}

export function markSensitive(blocks: Block[]): Block[] {
	for (const b of blocks) {
		if (MASKED_PAN.test(b.text)) {
			b.sensitive = 'Card number';
			continue;
		}
		const m = b.text.match(FULL_PAN);
		if (m) {
			const digits = m[0].replace(/\D/g, '');
			if ((digits.length === 15 || digits.length === 16) && /^[3-6]/.test(digits) && luhn(digits)) b.sensitive = 'Card number';
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Field -> block mapping

const KW: Record<string, RegExp> = {
	total: /total|paid|payer|pay[eé]|summe|betrag|gesamt|zahlen|importe|totale|合計|総額|amount|montant|due|balance|bar\b|card|visa|mastercard/i,
	subtotal: /sub\s?-?total|zwischensumme|sous[- ]?total|小計|subtotale|netto|hors taxe/i,
	tax: /tax|vat|tva|mwst|ust|iva|消費税|gst|hst/i,
	tip: /tip|gratuity|pourboire|trinkgeld|propina|mancia|service/i,
	discount: /discount|offer|remise|rabatt|reduc|promo|saving|coupon|angebot|^-/i,
	date: /dat|date|日付|fecha|le\b/i,
};

function parseNumber(token: string): number | null {
	const s = token.replace(/'/g, '');
	const lastSep = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
	if (lastSep < 0) return Number(s);
	const decimals = s.length - lastSep - 1;
	const value =
		decimals === 1 || decimals === 2 ? Number(`${s.slice(0, lastSep).replace(/[.,]/g, '')}.${s.slice(lastSep + 1)}`) : Number(s.replace(/[.,]/g, ''));
	return Number.isFinite(value) ? value : null;
}

export function amountsIn(text: string): number[] {
	return (text.match(/\d[\d.,']*\d|\d/g) ?? []).map(parseNumber).filter((n): n is number => n !== null);
}

const PRICE = /\d[.,]\d{2}(?!\d)/;

const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;

function amountBlocks(blocks: Block[], value: number | null, kw: RegExp, fallbackLast: boolean): number[] {
	if (value === null || value === 0) return [];
	const candidates = blocks.filter((b) => amountsIn(b.text).some((n) => near(n, value)));
	if (!candidates.length) return [];
	const labelled = candidates.filter((b) => kw.test(b.text));
	if (labelled.length) return [labelled[labelled.length - 1].i];
	for (const c of [...candidates].reverse()) {
		for (let back = 1; back <= 2; back++) {
			const prev = blocks[c.i - back];
			if (prev && kw.test(prev.text) && amountsIn(prev.text).length === 0) return [prev.i, c.i];
		}
	}
	return fallbackLast ? [candidates[candidates.length - 1].i] : [];
}

export function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^\p{L}\p{N}]/gu, '');
}

function tokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.split(/[^\p{L}\p{N}]+/u)
			.filter((t) => t.length >= 2 && !/^\d+$/.test(t)),
	);
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function dateVariants(iso: string): string[] {
	const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
	if (!m) return [];
	const [, yyyy, mm, dd] = m;
	const yy = yyyy.slice(2);
	const d = String(Number(dd));
	const mo = String(Number(mm));
	const month = MONTHS[Number(mm) - 1] ?? '';
	const out = [];
	for (const sep of ['/', '.', '-']) {
		out.push(`${dd}${sep}${mm}${sep}${yyyy}`, `${dd}${sep}${mm}${sep}${yy}`, `${mm}${sep}${dd}${sep}${yyyy}`, `${mm}${sep}${dd}${sep}${yy}`);
		out.push(`${yyyy}${sep}${mm}${sep}${dd}`, `${d}${sep}${mo}${sep}${yyyy}`, `${mo}${sep}${d}${sep}${yyyy}`);
	}
	out.push(`${yyyy}年${mo}月${d}日`, `${month} ${d}`, `${d} ${month}`, `${month.slice(0, 3)} ${d}`, `${d} ${month.slice(0, 3)}`);
	return out.filter((v) => v.trim().length > 4);
}

export function findSources(ex: Extraction, blocks: Block[]): Sources {
	const fields: Sources['fields'] = {};
	const set = (k: FieldKey, v: number[]) => {
		if (v.length) fields[k] = v;
	};

	const merchant = normalize(ex.merchant ?? '');
	if (merchant.length >= 2) {
		const hit = blocks.find((b) => {
			const n = normalize(b.text);
			return n.length >= 3 && (n.includes(merchant) || merchant.includes(n));
		});
		if (hit) set('merchant', [hit.i]);
	}

	if (ex.merchant_address) {
		const addr = tokens(ex.merchant_address);
		set(
			'address',
			blocks
				.filter((b) => {
					const have = tokens(b.text);
					const overlap = [...have].filter((t) => addr.has(t)).length;
					return b.i !== fields.merchant?.[0] && overlap >= 1 && overlap >= have.size / 2;
				})
				.map((b) => b.i)
				.slice(0, 3),
		);
	}

	if (ex.date) {
		const variants = dateVariants(ex.date);
		const hit = blocks.find((b) => {
			const t = b.text.toLowerCase();
			return variants.some((v) => t.includes(v));
		});
		if (hit) {
			const prev = blocks[hit.i - 1];
			set('date', prev && KW.date.test(prev.text) && amountsIn(prev.text).length === 0 ? [prev.i, hit.i] : [hit.i]);
		}
	}

	set('total', amountBlocks(blocks, ex.total, KW.total, true));
	set('subtotal', amountBlocks(blocks, ex.subtotal, KW.subtotal, false));
	set('tax', amountBlocks(blocks, ex.tax, KW.tax, false));
	set('tip', amountBlocks(blocks, ex.tip, KW.tip, false));
	set('discount', amountBlocks(blocks, ex.discount, KW.discount, false));
	set(
		'card',
		blocks.filter((b) => b.sensitive || (ex.card_last4 && MASKED_PAN.test(b.text) && b.text.includes(ex.card_last4))).map((b) => b.i),
	);

	const used = new Set<number>();
	const items = ex.line_items.map((item) => {
		const want = tokens(item.description);
		let best: { i: number; score: number } | null = null;
		for (const b of blocks) {
			if (b.type === 'image') continue;
			const have = tokens(b.text);
			if (!have.size || !want.size) continue;
			let score = [...want].filter((t) => have.has(t)).length / want.size;
			if (item.amount && amountsIn(b.text).some((n) => near(n, item.amount))) score += 0.3;
			if (used.has(b.i)) score -= 0.2;
			if (!best || score > best.score) best = { i: b.i, score };
		}
		if (!best || best.score < 0.5) return [];
		used.add(best.i);
		const next = blocks[best.i + 1];
		if (item.amount && !PRICE.test(blocks[best.i].text) && next && PRICE.test(next.text) && tokens(next.text).size <= 1) {
			return [best.i, next.i];
		}
		return [best.i];
	});

	return { fields, items };
}

// ---------------------------------------------------------------------------
// Normalisation and arithmetic

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : parseNumber(String(v).replace(/[^\d.,-]/g, ''));
	return n === null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
};

export function normalizeExtraction(raw: Record<string, unknown>): Extraction {
	const items = Array.isArray(raw.line_items) ? (raw.line_items as Record<string, unknown>[]) : [];
	const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
	const discount = num(raw.discount);
	return {
		merchant: String(raw.merchant ?? 'Unknown merchant').trim() || 'Unknown merchant',
		merchant_address: (raw.merchant_address as string) || null,
		city: (raw.city as string) || null,
		country_code: typeof raw.country_code === 'string' ? raw.country_code.toUpperCase().slice(0, 2) : null,
		date,
		time: (raw.time as string) || null,
		currency: String(raw.currency ?? 'EUR')
			.toUpperCase()
			.slice(0, 3),
		language: String(raw.language ?? 'en').toLowerCase(),
		category: CATEGORIES.includes(raw.category as string) ? (raw.category as string) : 'other',
		line_items: items.map(
			(it): LineItem => ({
				description: String(it.description ?? ''),
				description_en: String(it.description_en ?? it.description ?? ''),
				quantity: num(it.quantity),
				amount: num(it.amount) ?? 0,
			}),
		),
		subtotal: num(raw.subtotal),
		discount: discount === null ? null : Math.abs(discount),
		tax: num(raw.tax),
		tax_included: Boolean(raw.tax_included),
		tip: num(raw.tip),
		tip_handwritten: Boolean(raw.tip_handwritten),
		total: num(raw.total) ?? 0,
		payment_method: (raw.payment_method as string) || null,
		card_last4: typeof raw.card_last4 === 'string' && /^\d{4}$/.test(raw.card_last4) ? raw.card_last4 : null,
	};
}

/** Only trust card digits that appear in a masked card number on the receipt. */
export function verifyCard(ex: Extraction, blocks: Block[]): Extraction {
	const last4 = ex.card_last4;
	if (last4 && !blocks.some((b) => b.sensitive && b.text.includes(last4))) return { ...ex, card_last4: null };
	return ex;
}

const money = (n: number) => n.toFixed(2);

/** Check that the receipt reconciles: some sensible combination of items/subtotal, tax, discount and tip must equal the total. */
export function checkMath(ex: Extraction): MathCheck {
	const tol = 0.015;
	const itemsSum = Math.round(ex.line_items.reduce((a, b) => a + b.amount, 0) * 100) / 100;
	const total = ex.total;
	const bases: [string, number][] = [];
	if (ex.subtotal !== null) bases.push(['Subtotal', ex.subtotal]);
	if (ex.line_items.length) bases.push(['Items', itemsSum]);

	for (const [label, base] of bases) {
		const optional: [string, number, number][] = [];
		if (ex.tax) optional.push(['Tax', ex.tax, 1]);
		if (ex.discount) optional.push(['Discount', ex.discount, -1]);
		if (ex.tip) optional.push(['Tip', ex.tip, 1]);
		for (let mask = 0; mask < 1 << optional.length; mask++) {
			let value = base;
			let formula = `${label} ${money(base)}`;
			optional.forEach(([name, amount, sign], k) => {
				if (mask & (1 << k)) {
					value += sign * amount;
					formula += ` ${sign > 0 ? '+' : '-'} ${name} ${money(amount)}`;
				}
			});
			if (Math.abs(value - total) < tol) return { ok: true, itemsSum, total, formula: `${formula} = ${money(total)}`, difference: null };
		}
	}

	if (!bases.length) return { ok: true, itemsSum, total, formula: `Total ${money(total)}`, difference: null };
	const expected = (ex.subtotal ?? itemsSum) + (ex.tax_included ? 0 : (ex.tax ?? 0)) - (ex.discount ?? 0) + (ex.tip ?? 0);
	const difference = Math.round((total - expected) * 100) / 100;
	return {
		ok: false,
		itemsSum,
		total,
		formula: `Expected ${money(expected)} but the receipt says ${money(total)}`,
		difference,
	};
}
