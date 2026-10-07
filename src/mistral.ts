import type { RawPage } from './receipt';

const API = 'https://api.mistral.ai/v1';

export class MistralError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function post<T>(apiKey: string, path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(`${API}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) return res.json<T>();
		const detail = (await res.text()).slice(0, 500);
		if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
			await new Promise((r) => setTimeout(r, 800));
			continue;
		}
		throw new MistralError(`Mistral ${path} failed (${res.status}): ${detail}`, res.status);
	}
}

export interface OcrResponse {
	model: string;
	pages: RawPage[];
	document_annotation: string | null;
}

export interface OcrOptions {
	model: string;
	imageDataUrl: string;
	annotationFormat?: unknown;
	annotationPrompt?: string;
}

export function ocr(apiKey: string, opts: OcrOptions): Promise<OcrResponse> {
	return post<OcrResponse>(apiKey, '/ocr', {
		model: opts.model,
		document: { type: 'image_url', image_url: opts.imageDataUrl },
		include_blocks: true,
		confidence_scores_granularity: 'word',
		...(opts.annotationFormat ? { document_annotation_format: opts.annotationFormat } : {}),
		...(opts.annotationPrompt ? { document_annotation_prompt: opts.annotationPrompt } : {}),
	});
}

interface ChatResponse {
	choices: { message: { content: string } }[];
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

/** Chat completion constrained to a JSON schema; returns the parsed object. */
export async function chatJson<T>(
	apiKey: string,
	model: string,
	messages: ChatMessage[],
	name: string,
	schema: object,
	timeoutMs = 60_000,
): Promise<T> {
	const res = await post<ChatResponse>(
		apiKey,
		'/chat/completions',
		{
			model,
			messages,
			temperature: 0.1,
			response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
		},
		timeoutMs,
	);
	return JSON.parse(res.choices[0].message.content) as T;
}

export function toDataUrl(bytes: ArrayBuffer, mime: string): string {
	const u8 = new Uint8Array(bytes);
	let binary = '';
	for (let i = 0; i < u8.length; i += 0x8000) binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
	return `data:${mime};base64,${btoa(binary)}`;
}
