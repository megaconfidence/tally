import { chatJson, type ChatMessage, type ChatModel } from './mistral';
import type { AskRow } from './types';

const GROUPS = ['none', 'category', 'merchant', 'date', 'city', 'country', 'currency'] as const;
type Group = (typeof GROUPS)[number];

const ASK_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		answer: {
			type: 'string',
			description: 'Concise answer in 1-4 sentences. Cite every receipt you rely on inline as [#id]. Prefer home-currency amounts.',
		},
		expense_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids of the receipts the answer is about' },
		chart: {
			type: 'object',
			additionalProperties: false,
			description: 'A breakdown chart whenever the answer compares amounts across groups (category, merchant, city, country, currency or date), otherwise group_by "none"',
			properties: {
				title: { type: 'string' },
				group_by: { type: 'string', enum: GROUPS },
				expense_ids: { type: 'array', items: { type: 'integer' }, description: 'Receipts included in the chart' },
			},
			required: ['title', 'group_by', 'expense_ids'],
		},
		show_map: { type: 'boolean', description: 'True when the question mentions places, cities, countries, travel, trips, a map, or where money was spent' },
	},
	required: ['answer', 'expense_ids', 'chart', 'show_map'],
};

interface AskModelOutput {
	answer: string;
	expense_ids: number[];
	chart: { title: string; group_by: Group; expense_ids: number[] };
	show_map: boolean;
}

export interface AskResult {
	answer: string;
	expense_ids: number[];
	chart: { title: string; currency: string; bars: { label: string; value: number; ids: number[] }[] } | null;
	map: { id: number; lat: number; lon: number; label: string; amount: number }[] | null;
}

const LABELS: Record<Group, (r: AskRow) => string> = {
	none: () => '',
	category: (r) => String(r.category).replace(/_/g, ' '),
	merchant: (r) => String(r.merchant),
	date: (r) => String(r.date ?? 'Unknown date'),
	city: (r) => String(r.city ?? 'Unknown'),
	country: (r) => String(r.country ?? 'Unknown'),
	currency: (r) => String(r.currency),
};

function totals(rows: AskRow[], group: Group, home: string) {
	const out = new Map<string, { value: number; ids: number[] }>();
	for (const r of rows) {
		const key = LABELS[group](r);
		const entry = out.get(key) ?? { value: 0, ids: [] };
		entry.value += r.total_home ?? (r.currency === home ? r.total : 0);
		entry.ids.push(r.id);
		out.set(key, entry);
	}
	return [...out.entries()]
		.map(([label, v]) => ({ label, value: Math.round(v.value * 100) / 100, ids: v.ids }))
		.sort((a, b) => b.value - a.value);
}

export async function ask(
	apiKey: string,
	model: ChatModel,
	question: string,
	history: ChatMessage[],
	rows: AskRow[],
	home: string,
	today: string,
): Promise<AskResult> {
	const aggregates = {
		receipts: rows.length,
		total_home: Math.round(rows.reduce((a, r) => a + (r.total_home ?? 0), 0) * 100) / 100,
		by_category: totals(rows, 'category', home).map(({ label, value }) => ({ label, value })),
		by_city: totals(rows, 'city', home).map(({ label, value }) => ({ label, value })),
	};
	const system = [
		"You answer questions about the user's expenses, which were captured from receipt photos with Mistral OCR.",
		`Today is ${today}. The home currency is ${home}; "total_home" is each receipt converted to ${home}.`,
		'Use only the data below. Cite receipts inline as [#id]. Be precise with amounts and keep the tone friendly and brief.',
		'Precomputed aggregates are exact; prefer them over adding numbers yourself.',
		`Aggregates: ${JSON.stringify(aggregates)}`,
		`Receipts: ${JSON.stringify(rows.map(({ lat, lon, ...rest }) => rest))}`,
	].join('\n');

	const out = await chatJson<AskModelOutput>(
		apiKey,
		model,
		[{ role: 'system', content: system }, ...history.slice(-6), { role: 'user', content: question }],
		'expense_answer',
		ASK_SCHEMA,
	);

	const byId = new Map(rows.map((r) => [r.id, r]));
	const pick = (ids: number[]) => ids.map((id) => byId.get(id)).filter((r): r is AskRow => Boolean(r));

	let chart: AskResult['chart'] = null;
	if (out.chart.group_by !== 'none') {
		const chartRows = pick(out.chart.expense_ids.length ? out.chart.expense_ids : out.expense_ids);
		const bars = totals(chartRows.length ? chartRows : rows, out.chart.group_by, home).slice(0, 8);
		if (bars.length) chart = { title: out.chart.title, currency: home, bars };
	}

	let map: AskResult['map'] = null;
	if (out.show_map) {
		const mapRows = out.expense_ids.length ? pick(out.expense_ids) : rows;
		map = mapRows
			.flatMap((r) => (r.lat !== null && r.lon !== null ? [{ id: r.id, lat: r.lat, lon: r.lon, label: r.merchant, amount: r.total_home ?? r.total }] : []));
		if (!map.length) map = null;
	}

	return { answer: out.answer, expense_ids: out.expense_ids.filter((id) => byId.has(id)), chart, map };
}
