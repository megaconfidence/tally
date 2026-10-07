import { DurableObject } from 'cloudflare:workers';
import { normalize } from './receipt';
import type { AskRow, Checks, DuplicateMatch, ExpenseDetail, ExpenseSummary, Extraction, Fx, NewExpense, Settings } from './types';

export const DEFAULT_POLICY = [
	'1. No alcoholic drinks.',
	'2. Meals and food delivery must be under £50 per receipt.',
	'3. Personal care products and cosmetics are not reimbursable.',
	'4. Receipts older than 90 days cannot be claimed.',
].join('\n');

const DEFAULT_SETTINGS: Settings = { home_currency: 'GBP', policy: DEFAULT_POLICY };

const SUMMARY_COLUMNS = `id, created_at, merchant, date, category, currency, total, home_currency, total_home, city, country_code, lat, lon,
	math_ok, policy_count, duplicate_of, has_image`;

type Row = Record<string, SqlStorageValue>;

function toSummary(r: Row): ExpenseSummary {
	return {
		id: r.id as number,
		created_at: r.created_at as string,
		merchant: r.merchant as string,
		date: r.date as string | null,
		category: r.category as string,
		currency: r.currency as string,
		total: r.total as number,
		home_currency: r.home_currency as string,
		total_home: r.total_home as number | null,
		city: r.city as string | null,
		country_code: r.country_code as string | null,
		lat: r.lat as number | null,
		lon: r.lon as number | null,
		math_ok: Boolean(r.math_ok),
		policy_count: r.policy_count as number,
		duplicate_of: r.duplicate_of as number | null,
		has_image: Boolean(r.has_image),
	};
}

/** One ledger of expenses (one per user / demo session). */
export class Ledger extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS expenses (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				created_at TEXT NOT NULL,
				merchant TEXT NOT NULL,
				date TEXT,
				category TEXT NOT NULL,
				currency TEXT NOT NULL,
				total REAL NOT NULL,
				home_currency TEXT NOT NULL,
				total_home REAL,
				city TEXT,
				country_code TEXT,
				lat REAL,
				lon REAL,
				math_ok INTEGER NOT NULL,
				policy_count INTEGER NOT NULL,
				duplicate_of INTEGER,
				has_image INTEGER NOT NULL DEFAULT 0,
				extraction TEXT NOT NULL,
				sources TEXT NOT NULL,
				ocr TEXT NOT NULL,
				checks TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		`);
	}

	getSettings(): Settings {
		const rows = this.sql.exec<{ key: string; value: string }>('SELECT key, value FROM settings').toArray();
		const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
		return { ...DEFAULT_SETTINGS, ...stored };
	}

	updateSettings(patch: Partial<Settings>): Settings {
		for (const [key, value] of Object.entries(patch)) {
			if (key in DEFAULT_SETTINGS && typeof value === 'string') {
				this.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
			}
		}
		return this.getSettings();
	}

	/** Same currency, total and date, plus a matching merchant, time or set of line items. */
	findDuplicate(ex: Extraction): DuplicateMatch | null {
		const rows = this.sql
			.exec<Row>(
				'SELECT id, merchant, date, total, currency, created_at, extraction FROM expenses WHERE currency = ? AND abs(total - ?) < 0.005 AND date IS ? ORDER BY id',
				ex.currency,
				ex.total,
				ex.date,
			)
			.toArray();
		const merchant = normalize(ex.merchant);
		const items = new Set(ex.line_items.map((it) => normalize(it.description)));
		const hit = rows.find((r) => {
			const other = JSON.parse(r.extraction as string) as Extraction;
			const name = normalize(other.merchant);
			if (name === merchant || name.includes(merchant) || merchant.includes(name)) return true;
			if (ex.time && other.time === ex.time) return true;
			const shared = other.line_items.filter((it) => items.has(normalize(it.description))).length;
			return items.size > 0 && shared >= Math.ceil(items.size / 2);
		});
		return hit
			? {
					id: hit.id as number,
					merchant: hit.merchant as string,
					date: hit.date as string | null,
					total: hit.total as number,
					currency: hit.currency as string,
					created_at: hit.created_at as string,
				}
			: null;
	}

	addExpense(e: NewExpense): ExpenseSummary {
		const { extraction: ex, checks } = e;
		const row = this.sql
			.exec<Row>(
				`INSERT INTO expenses (created_at, merchant, date, category, currency, total, home_currency, total_home, city, country_code, lat, lon,
					math_ok, policy_count, duplicate_of, extraction, sources, ocr, checks)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				RETURNING ${SUMMARY_COLUMNS}`,
				new Date().toISOString(),
				ex.merchant,
				ex.date,
				ex.category,
				ex.currency,
				ex.total,
				e.home_currency,
				checks.fx?.amount ?? null,
				ex.city,
				ex.country_code,
				checks.geo?.lat ?? null,
				checks.geo?.lon ?? null,
				checks.math.ok ? 1 : 0,
				checks.policy.length,
				checks.duplicate?.id ?? null,
				JSON.stringify(ex),
				JSON.stringify(e.sources),
				JSON.stringify(e.ocr),
				JSON.stringify(checks),
			)
			.one();
		return toSummary(row);
	}

	list(): ExpenseSummary[] {
		return this.sql.exec<Row>(`SELECT ${SUMMARY_COLUMNS} FROM expenses ORDER BY id DESC`).toArray().map(toSummary);
	}

	get(id: number): ExpenseDetail | null {
		const row = this.sql.exec<Row>(`SELECT ${SUMMARY_COLUMNS}, extraction, sources, ocr, checks FROM expenses WHERE id = ?`, id).toArray()[0];
		if (!row) return null;
		return {
			...toSummary(row),
			extraction: JSON.parse(row.extraction as string),
			sources: JSON.parse(row.sources as string),
			ocr: JSON.parse(row.ocr as string),
			checks: JSON.parse(row.checks as string),
		};
	}

	/** Compact rows used as context for "ask your expenses". */
	askContext(): AskRow[] {
		return this.sql
			.exec<Row>(`SELECT ${SUMMARY_COLUMNS}, extraction, checks FROM expenses ORDER BY date, id`)
			.toArray()
			.map((r) => {
				const s = toSummary(r);
				const ex = JSON.parse(r.extraction as string) as Extraction;
				const checks = JSON.parse(r.checks as string) as Checks;
				return {
					id: s.id,
					merchant: s.merchant,
					date: s.date,
					time: ex.time,
					category: s.category,
					city: s.city,
					country: s.country_code,
					total: s.total,
					currency: s.currency,
					total_home: s.total_home,
					tip: ex.tip,
					tax: ex.tax,
					payment: ex.payment_method,
					items: ex.line_items.map((it) => `${it.description_en} (${it.amount})`),
					policy_violations: checks.policy.map((p) => p.reason),
					math_ok: s.math_ok,
					duplicate_of: s.duplicate_of,
					lat: s.lat,
					lon: s.lon,
				};
			});
	}

	setImage(id: number, hasImage: boolean): boolean {
		return this.sql.exec('UPDATE expenses SET has_image = ? WHERE id = ?', hasImage ? 1 : 0, id).rowsWritten > 0;
	}

	setHomeAmount(id: number, home: string, fx: Fx | null): void {
		const row = this.sql.exec<{ checks: string }>('SELECT checks FROM expenses WHERE id = ?', id).toArray()[0];
		if (!row) return;
		const checks = JSON.parse(row.checks) as Checks;
		checks.fx = fx;
		this.sql.exec(
			'UPDATE expenses SET home_currency = ?, total_home = ?, checks = ? WHERE id = ?',
			home,
			fx?.amount ?? null,
			JSON.stringify(checks),
			id,
		);
	}

	remove(id: number): boolean {
		this.sql.exec('UPDATE expenses SET duplicate_of = NULL WHERE duplicate_of = ?', id);
		return this.sql.exec('DELETE FROM expenses WHERE id = ?', id).rowsWritten > 0;
	}

	reset(): number[] {
		const ids = this.sql
			.exec<{ id: number }>('SELECT id FROM expenses')
			.toArray()
			.map((r) => r.id);
		this.sql.exec('DELETE FROM expenses');
		return ids;
	}
}
