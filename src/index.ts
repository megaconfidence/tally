import { ask } from './ask';
import { checkPolicy, convert, geocode } from './enrich';
import { Ledger } from './ledger';
import { ocr, toDataUrl, type ChatMessage } from './mistral';
import { annotationPrompt, buildBlocks, checkMath, findSources, markSensitive, normalizeExtraction, RECEIPT_SCHEMA, verifyCard } from './receipt';
import type { Checks, OcrPage, ScanEvent, Settings } from './types';

export { Ledger };

/** Single demo ledger. Swap for a per-user name once auth exists. */
const LEDGER_NAME = 'default';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|avif)$/;

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const fail = (status: number, error: string) => json({ error }, status);
const today = () => new Date().toISOString().slice(0, 10);
const imageKey = (id: number) => `receipts/${LEDGER_NAME}/${id}.jpg`;

async function readImage(request: Request): Promise<{ bytes: ArrayBuffer; mime: string } | Response> {
	const mime = (request.headers.get('content-type') ?? '').split(';')[0].trim();
	if (!IMAGE_TYPES.test(mime)) return fail(415, 'Send the image as image/jpeg, image/png, image/webp or image/avif');
	if (Number(request.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return fail(413, 'Image is larger than 10 MB');
	const bytes = await request.arrayBuffer();
	if (!bytes.byteLength) return fail(400, 'Empty image');
	if (bytes.byteLength > MAX_IMAGE_BYTES) return fail(413, 'Image is larger than 10 MB');
	return { bytes, mime };
}

function scan(bytes: ArrayBuffer, mime: string, env: Env, ctx: ExecutionContext): Response {
	const ledger = env.LEDGER.getByName(LEDGER_NAME);
	const imageDataUrl = toDataUrl(bytes, mime);
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const send = (event: ScanEvent) => writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
	const date = today();

	const timings: Record<string, number> = {};
	const timed = async <T>(name: string, p: Promise<T>): Promise<T> => {
		const start = Date.now();
		try {
			return await p;
		} finally {
			timings[name] = Date.now() - start;
		}
	};

	const run = async () => {
		const t0 = Date.now();
		const settingsP = ledger.getSettings();
		// Two calls in parallel: plain OCR returns blocks fast for the reveal, the annotated call returns structured fields.
		const fastP = timed('ocr', ocr(env.MISTRAL_API_KEY, { model: env.OCR_MODEL, imageDataUrl }));
		const annotatedP = timed(
			'annotation',
			ocr(env.MISTRAL_API_KEY, { model: env.OCR_MODEL, imageDataUrl, annotationFormat: RECEIPT_SCHEMA, annotationPrompt: annotationPrompt(date) }),
		);
		annotatedP.catch(() => undefined);

		const fast = await fastP;
		const page = fast.pages[0];
		const blocks = markSensitive(buildBlocks(page));
		if (!blocks.some((b) => b.text)) throw new Error('No text found. Is there a receipt in the frame?');
		const ocrPage: OcrPage = {
			model: fast.model,
			ms: Date.now() - t0,
			width: page.dimensions.width,
			height: page.dimensions.height,
			blocks,
			avgConf: page.confidence_scores?.average_page_confidence_score ?? null,
			minConf: page.confidence_scores?.minimum_page_confidence_score ?? null,
		};
		await send({ type: 'ocr', ocr: ocrPage });

		const annotated = await annotatedP;
		if (!annotated.document_annotation) throw new Error('The model returned no structured data for this receipt');
		const extraction = verifyCard(normalizeExtraction(JSON.parse(annotated.document_annotation)), blocks);
		const sources = findSources(extraction, blocks);
		await send({ type: 'extraction', ms: Date.now() - t0, extraction, sources });

		const settings = await settingsP;
		const geoP = timed('geo', geocode(extraction.city, extraction.country_code));
		const [fx, duplicate] = await Promise.all([
			timed('fx', convert(extraction.total, extraction.currency, settings.home_currency, extraction.date, date)),
			ledger.findDuplicate(extraction),
		]);
		const policy = await timed('policy', checkPolicy(env.MISTRAL_API_KEY, env.POLICY_MODEL, settings.policy, extraction, sources, fx, date)).catch(
			(err) => {
				console.error(JSON.stringify({ msg: 'policy check failed', error: String(err) }));
				return [];
			},
		);
		const checks: Checks = { math: checkMath(extraction), policy, duplicate, fx, geo: await geoP };
		await send({ type: 'checks', checks });

		const expense = await ledger.addExpense({ extraction, sources, ocr: ocrPage, checks, home_currency: settings.home_currency });
		await send({ type: 'saved', expense });
		console.log(
			JSON.stringify({ msg: 'scan complete', id: expense.id, ms: Date.now() - t0, timings, blocks: blocks.length, merchant: extraction.merchant }),
		);
	};

	ctx.waitUntil(
		run()
			.catch(async (err) => {
				console.error(JSON.stringify({ msg: 'scan failed', error: String(err) }));
				await send({ type: 'error', message: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
			})
			.finally(() => writer.close().catch(() => undefined)),
	);

	return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function updateSettings(request: Request, env: Env): Promise<Response> {
	const ledger = env.LEDGER.getByName(LEDGER_NAME);
	const body = await request.json<Partial<Settings>>().catch(() => null);
	if (!body) return fail(400, 'Expected a JSON body');
	const patch: Partial<Settings> = {};
	if (body.home_currency !== undefined) {
		if (!/^[A-Z]{3}$/.test(body.home_currency)) return fail(400, 'home_currency must be an ISO 4217 code');
		patch.home_currency = body.home_currency;
	}
	if (body.policy !== undefined) patch.policy = String(body.policy).slice(0, 4000);

	const before = await ledger.getSettings();
	const settings = await ledger.updateSettings(patch);
	if (settings.home_currency !== before.home_currency) {
		const expenses = await ledger.list();
		await Promise.all(
			expenses.map(async (e) => ledger.setHomeAmount(e.id, settings.home_currency, await convert(e.total, e.currency, settings.home_currency, e.date, today()))),
		);
	}
	return json(settings);
}

async function askRoute(request: Request, env: Env): Promise<Response> {
	const body = await request.json<{ question?: string; history?: ChatMessage[] }>().catch(() => null);
	const question = body?.question?.trim();
	if (!question) return fail(400, 'Ask a question');
	const history = (Array.isArray(body?.history) ? body.history : [])
		.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
		.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
	const ledger = env.LEDGER.getByName(LEDGER_NAME);
	const [rows, settings] = await Promise.all([ledger.askContext(), ledger.getSettings()]);
	if (!rows.length) return json({ answer: 'There are no expenses yet. Scan a receipt first.', expense_ids: [], chart: null, map: null });
	const result = await ask(
		env.MISTRAL_API_KEY,
		env.ASK_MODEL,
		question.slice(0, 1000),
		history,
		rows,
		settings.home_currency,
		today(),
	);
	return json(result);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const { pathname } = url;
	const method = request.method;
	const ledger = env.LEDGER.getByName(LEDGER_NAME);

	if (pathname === '/api/scan' && method === 'POST') {
		const image = await readImage(request);
		return image instanceof Response ? image : scan(image.bytes, image.mime, env, ctx);
	}
	if (pathname === '/api/expenses' && method === 'GET') return json(await ledger.list());
	if (pathname === '/api/expenses' && method === 'DELETE') {
		const ids = await ledger.reset();
		if (ids.length) await env.RECEIPTS.delete(ids.map(imageKey));
		return json({ deleted: ids.length });
	}
	if (pathname === '/api/settings' && method === 'GET') return json(await ledger.getSettings());
	if (pathname === '/api/settings' && method === 'PUT') return updateSettings(request, env);
	if (pathname === '/api/ask' && method === 'POST') return askRoute(request, env);

	const match = pathname.match(/^\/api\/expenses\/(\d+)(\/image)?$/);
	if (match) {
		const id = Number(match[1]);
		if (!match[2] && method === 'GET') {
			const expense = await ledger.get(id);
			return expense ? json(expense) : fail(404, 'Expense not found');
		}
		if (!match[2] && method === 'DELETE') {
			const removed = await ledger.remove(id);
			if (removed) await env.RECEIPTS.delete(imageKey(id));
			return removed ? json({ deleted: id }) : fail(404, 'Expense not found');
		}
		if (match[2] && method === 'PUT') {
			const image = await readImage(request);
			if (image instanceof Response) return image;
			if (!(await ledger.get(id))) return fail(404, 'Expense not found');
			await env.RECEIPTS.put(imageKey(id), image.bytes, { httpMetadata: { contentType: image.mime } });
			await ledger.setImage(id, true);
			return json({ ok: true });
		}
		if (match[2] && method === 'GET') {
			const object = await env.RECEIPTS.get(imageKey(id));
			if (!object) return fail(404, 'Image not found');
			return new Response(object.body, {
				headers: { 'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg', ETag: object.httpEtag, 'Cache-Control': 'private, max-age=300' },
			});
		}
	}
	return fail(404, 'Not found');
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		try {
			return await route(request, env, ctx);
		} catch (err) {
			console.error(JSON.stringify({ msg: 'request failed', path: new URL(request.url).pathname, error: String(err) }));
			return fail(500, err instanceof Error ? err.message : 'Internal error');
		}
	},
} satisfies ExportedHandler<Env>;
