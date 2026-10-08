import { chatJson, type ChatModel } from './mistral';
import type { Extraction, Fx, Geo, PolicyViolation, Sources } from './types';

const cached = () => ({ cf: { cacheEverything: true, cacheTtl: 86_400 }, signal: AbortSignal.timeout(4000) }) satisfies RequestInit;

/** Convert `amount` to the home currency using ECB rates for the receipt date (Frankfurter). */
export async function convert(amount: number, from: string, to: string, date: string | null, today: string): Promise<Fx | null> {
	if (from === to) return { from, to, rate: 1, date: date ?? today, amount };
	const day = date && date <= today ? date : 'latest';
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await fetch(`https://api.frankfurter.dev/v1/${day}?base=${from}&symbols=${to}`, cached());
			if (!res.ok) return null;
			const body = await res.json<{ date: string; rates: Record<string, number> }>();
			const rate = body.rates[to];
			if (!rate) return null;
			return { from, to, rate, date: body.date, amount: Math.round(amount * rate * 100) / 100 };
		} catch (err) {
			console.warn(JSON.stringify({ msg: 'fx failed', from, to, attempt, error: String(err) }));
		}
	}
	return null;
}

/** City-level geocoding via OpenStreetMap Nominatim. */
export async function geocode(city: string | null, countryCode: string | null): Promise<Geo | null> {
	if (!city) return null;
	const params = new URLSearchParams({ city, format: 'jsonv2', limit: '1' });
	if (countryCode) params.set('countrycodes', countryCode.toLowerCase());
	try {
		const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
			...cached(),
			headers: { 'User-Agent': 'mistral-ocr-expense-demo/1.0 (Cloudflare Workers)' },
		});
		if (!res.ok) return null;
		const [hit] = await res.json<{ lat: string; lon: string; display_name: string }[]>();
		return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), label: city } : null;
	} catch (err) {
		console.warn(JSON.stringify({ msg: 'geocode failed', city, error: String(err) }));
		return null;
	}
}

const POLICY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	properties: {
		violations: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				properties: {
					rule: { type: 'string', description: 'The policy rule that is broken, quoted briefly' },
					reason: { type: 'string', description: 'One short sentence explaining why, citing the item or amount' },
					line_item_index: { type: ['integer', 'null'], description: 'Index of the offending line item, or null if it is about the whole receipt' },
				},
				required: ['rule', 'reason', 'line_item_index'],
			},
		},
	},
	required: ['violations'],
};

export async function checkPolicy(
	apiKey: string,
	model: ChatModel,
	policy: string,
	ex: Extraction,
	sources: Sources,
	fx: Fx | null,
	today: string,
): Promise<PolicyViolation[]> {
	if (!policy.trim()) return [];
	const receipt = {
		merchant: ex.merchant,
		category: ex.category,
		date: ex.date,
		city: ex.city,
		country: ex.country_code,
		total: `${ex.total} ${ex.currency}`,
		total_in_home_currency: fx ? `${fx.amount} ${fx.to}` : null,
		tip: ex.tip,
		line_items: ex.line_items.map((it, index) => ({ index, item: it.description_en, printed_as: it.description, amount: it.amount })),
	};
	const { violations } = await chatJson<{ violations: Omit<PolicyViolation, 'blocks'>[] }>(
		apiKey,
		model,
		[
			{
				role: 'system',
				content:
					'You are a strict but fair corporate expense auditor. Check the receipt against the expense policy. ' +
					'Only report clear violations of the listed rules; do not invent rules. Return an empty list when the receipt is compliant. ' +
					'"rule" must quote the single rule that is broken, and each violation must be about one rule. ' +
					'Use both the printed text and the English name to identify items; if you cannot tell what an item is, do not flag it. ' +
					`Today is ${today}.`,
			},
			{ role: 'user', content: `Expense policy:\n${policy}\n\nReceipt:\n${JSON.stringify(receipt, null, 1)}` },
		],
		'policy_check',
		POLICY_SCHEMA,
		10_000,
	);
	return violations.map((v) => {
		const idx = v.line_item_index !== null && v.line_item_index >= 0 && v.line_item_index < ex.line_items.length ? v.line_item_index : null;
		return { ...v, line_item_index: idx, blocks: idx !== null ? (sources.items[idx] ?? []) : (sources.fields.total ?? []) };
	});
}
