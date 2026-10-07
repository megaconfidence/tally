import { api } from './api.js';
import { h, money } from './util.js';

const SUGGESTIONS = [
	'How much did I spend in total?',
	'Which receipts break the expense policy?',
	'Where did my money go on this trip?',
	'What was my biggest expense and why?',
];

let leaflet;
function loadLeaflet() {
	leaflet ??= new Promise((resolve, reject) => {
		document.head.append(h('link', { rel: 'stylesheet', href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' }));
		const script = h('script', { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' });
		script.onload = () => resolve(window.L);
		script.onerror = () => reject(new Error('Could not load map library'));
		document.head.append(script);
	});
	return leaflet;
}

/** Chat over the ledger. Answers cite receipts as [#id], which become buttons opening the source. */
export class Ask {
	constructor(root, { onCite, lookup }) {
		this.root = root;
		this.home = 'GBP';
		this.onCite = onCite;
		this.lookup = lookup;
		this.thread = root.querySelector('.a-thread');
		this.form = root.querySelector('form');
		this.input = this.form.querySelector('input');
		this.history = [];
		this.form.addEventListener('submit', (e) => {
			e.preventDefault();
			this.submit(this.input.value);
		});
		root.querySelector('.a-suggest').append(...SUGGESTIONS.map((s) => h('button', { type: 'button', class: 'suggestion', onclick: () => this.submit(s) }, s)));
	}

	cite(id) {
		const e = this.lookup(id);
		return h('button', { type: 'button', class: 'cite', title: e ? `Open ${e.merchant} (#${id})` : `Open expense #${id}`, onclick: () => this.onCite(id) }, `#${id}`);
	}

	renderAnswer(text) {
		const p = h('p', {});
		let last = 0;
		for (const m of text.matchAll(/\[(#?\d+(?:\s*,\s*#?\d+)*)\]/g)) {
			p.append(text.slice(last, m.index));
			m[1].split(',').forEach((part, i) => {
				if (i) p.append(' ');
				p.append(this.cite(Number(part.replace(/\D/g, ''))));
			});
			last = m.index + m[0].length;
		}
		p.append(text.slice(last));
		return p;
	}

	renderChart(chart) {
		const max = Math.max(...chart.bars.map((b) => b.value), 0.01);
		return h(
			'div',
			{ class: 'chart' },
			h('div', { class: 'chart-title' }, chart.title),
			chart.bars.map((b, i) =>
				h(
					'div',
					{ class: `bar${b.ids.length === 1 ? ' clickable' : ''}`, onclick: () => b.ids.length === 1 && this.onCite(b.ids[0]) },
					h('div', { class: 'bar-label' }, b.label),
					h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: `${(b.value / max) * 100}%`, animationDelay: `${i * 60}ms` } })),
					h('div', { class: 'bar-value' }, money(b.value, chart.currency)),
				),
			),
		);
	}

	async renderMap(points, host) {
		try {
			const L = await loadLeaflet();
			const map = L.map(host, { zoomControl: false, attributionControl: true, scrollWheelZoom: false });
			L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
				attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
				maxZoom: 18,
			}).addTo(map);
			const max = Math.max(...points.map((p) => p.amount), 1);
			for (const p of points) {
				L.circleMarker([p.lat, p.lon], { radius: 6 + 12 * Math.sqrt(p.amount / max), color: '#c2410c', fillColor: '#f0530f', fillOpacity: 0.35, weight: 1.5 })
					.addTo(map)
					.bindTooltip(`${p.label} · ${money(p.amount, this.home)}`, { direction: 'top' })
					.on('click', () => this.onCite(p.id));
			}
			if (points.length === 1) map.setView([points[0].lat, points[0].lon], 10);
			else map.fitBounds(points.map((p) => [p.lat, p.lon]), { padding: [30, 30], maxZoom: 10 });
		} catch (err) {
			host.textContent = err.message;
		}
	}

	async submit(raw) {
		const question = raw.trim();
		if (!question || this.pending) return;
		this.pending = true;
		this.input.value = '';
		this.root.classList.add('has-thread');
		this.thread.append(h('div', { class: 'msg user' }, question));
		const bubble = h('div', { class: 'msg bot thinking' }, h('span', { class: 'dots' }, h('i'), h('i'), h('i')));
		this.thread.append(bubble);
		bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
		try {
			const res = await api.ask(question, this.history);
			bubble.classList.remove('thinking');
			bubble.replaceChildren(this.renderAnswer(res.answer));
			if (res.chart) {
				this.home = res.chart.currency;
				bubble.append(this.renderChart(res.chart));
			}
			if (res.map) {
				const host = h('div', { class: 'map' });
				bubble.append(host);
				await this.renderMap(res.map, host);
			}
			this.history.push({ role: 'user', content: question }, { role: 'assistant', content: res.answer });
		} catch (err) {
			bubble.classList.remove('thinking');
			bubble.classList.add('error');
			bubble.textContent = err.message;
		} finally {
			this.pending = false;
			bubble.scrollIntoView({ behavior: 'smooth', block: 'end' });
		}
	}
}
