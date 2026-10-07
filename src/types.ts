export interface Word {
	t: string;
	c: number;
}

export interface Block {
	i: number;
	type: string;
	/** x0, y0, x1, y1 as fractions of the page size */
	box: [number, number, number, number];
	text: string;
	words: Word[];
	minConf: number | null;
	avgConf: number | null;
	/** Reason the block must be redacted before the image is stored */
	sensitive?: string;
}

export interface OcrPage {
	model: string;
	ms: number;
	width: number;
	height: number;
	blocks: Block[];
	avgConf: number | null;
	minConf: number | null;
}

export interface LineItem {
	description: string;
	description_en: string;
	quantity: number | null;
	amount: number;
}

export interface Extraction {
	merchant: string;
	merchant_address: string | null;
	city: string | null;
	country_code: string | null;
	date: string | null;
	time: string | null;
	currency: string;
	language: string;
	category: string;
	line_items: LineItem[];
	subtotal: number | null;
	discount: number | null;
	tax: number | null;
	tax_included: boolean;
	tip: number | null;
	tip_handwritten: boolean;
	total: number;
	payment_method: string | null;
	card_last4: string | null;
}

export type FieldKey = 'merchant' | 'address' | 'date' | 'subtotal' | 'discount' | 'tax' | 'tip' | 'total' | 'card';

export interface Sources {
	fields: Partial<Record<FieldKey, number[]>>;
	items: number[][];
}

export interface MathCheck {
	ok: boolean;
	itemsSum: number;
	total: number;
	formula: string;
	difference: number | null;
}

export interface PolicyViolation {
	rule: string;
	reason: string;
	line_item_index: number | null;
	blocks: number[];
}

export interface DuplicateMatch {
	id: number;
	merchant: string;
	date: string | null;
	total: number;
	currency: string;
	created_at: string;
}

export interface Fx {
	from: string;
	to: string;
	rate: number;
	date: string;
	amount: number;
}

export interface Geo {
	lat: number;
	lon: number;
	label: string;
}

export interface Checks {
	math: MathCheck;
	policy: PolicyViolation[];
	duplicate: DuplicateMatch | null;
	fx: Fx | null;
	geo: Geo | null;
}

export interface ExpenseSummary {
	id: number;
	created_at: string;
	merchant: string;
	date: string | null;
	category: string;
	currency: string;
	total: number;
	home_currency: string;
	total_home: number | null;
	city: string | null;
	country_code: string | null;
	lat: number | null;
	lon: number | null;
	math_ok: boolean;
	policy_count: number;
	duplicate_of: number | null;
	has_image: boolean;
}

export interface ExpenseDetail extends ExpenseSummary {
	extraction: Extraction;
	sources: Sources;
	ocr: OcrPage;
	checks: Checks;
}

export interface NewExpense {
	extraction: Extraction;
	sources: Sources;
	ocr: OcrPage;
	checks: Checks;
	home_currency: string;
}

export interface AskRow {
	id: number;
	merchant: string;
	date: string | null;
	time: string | null;
	category: string;
	city: string | null;
	country: string | null;
	total: number;
	currency: string;
	total_home: number | null;
	tip: number | null;
	tax: number | null;
	payment: string | null;
	items: string[];
	policy_violations: string[];
	math_ok: boolean;
	duplicate_of: number | null;
	lat: number | null;
	lon: number | null;
}

export interface Settings {
	home_currency: string;
	policy: string;
}

export type ScanEvent =
	| { type: 'ocr'; ocr: OcrPage }
	| { type: 'extraction'; ms: number; extraction: Extraction; sources: Sources }
	| { type: 'checks'; checks: Checks }
	| { type: 'saved'; expense: ExpenseSummary }
	| { type: 'error'; message: string };
