async function request(path, init = {}) {
	const res = await fetch(path, init);
	const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
	if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
	return body;
}

const jsonInit = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export const api = {
	list: () => request('/api/expenses'),
	get: (id) => request(`/api/expenses/${id}`),
	remove: (id) => request(`/api/expenses/${id}`, { method: 'DELETE' }),
	reset: () => request('/api/expenses', { method: 'DELETE' }),
	settings: () => request('/api/settings'),
	saveSettings: (patch) => request('/api/settings', jsonInit('PUT', patch)),
	ask: (question, history) => request('/api/ask', jsonInit('POST', { question, history })),
	uploadImage: (id, blob) => request(`/api/expenses/${id}/image`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob }),
	imageUrl: (id) => `/api/expenses/${id}/image`,

	/** POST an image to /api/scan and invoke onEvent for each NDJSON event as it streams in. */
	async scan(blob, onEvent) {
		const res = await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob });
		if (!res.ok || !res.body) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error ?? `Scan failed (${res.status})`);
		}
		const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		for (;;) {
			const { value, done } = await reader.read();
			if (value) buffer += value;
			let nl;
			while ((nl = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (line) onEvent(JSON.parse(line));
			}
			if (done) break;
		}
		if (buffer.trim()) onEvent(JSON.parse(buffer));
	},
};
