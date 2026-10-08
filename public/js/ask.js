import { api } from './api.js';
import { h, money } from './util.js';

const SUGGESTIONS = [
	'How much did I spend in total?',
	'Which receipts break the expense policy?',
	'Where did my money go on this trip?',
	'What was my biggest expense and why?',
];

const MAPLIBRE = 'https://unpkg.com/maplibre-gl@5.24.0/dist';
/** Light basemap from OpenFreeMap: free, no API key, no sign-up. */
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

let maplibre;
function loadMapLibre() {
	maplibre ??= new Promise((resolve, reject) => {
		document.head.append(h('link', { rel: 'stylesheet', href: `${MAPLIBRE}/maplibre-gl.css` }));
		const script = h('script', { src: `${MAPLIBRE}/maplibre-gl.js` });
		script.onload = () => resolve(window.maplibregl);
		script.onerror = () => {
			maplibre = null;
			reject(new Error("Couldn't load the map"));
		};
		document.head.append(script);
	});
	return maplibre;
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
			const ml = await loadMapLibre();
			const max = Math.max(...points.map((p) => p.amount), 1);
			const bounds = new ml.LngLatBounds();
			for (const p of points) bounds.extend([p.lon, p.lat]);
			const map = new ml.Map({
				container: host,
				style: MAP_STYLE,
				bounds,
				fitBoundsOptions: { padding: 40, maxZoom: 10 },
				attributionControl: { compact: true },
				scrollZoom: false,
				dragRotate: false,
				pitchWithRotate: false,
			});
			map.touchZoomRotate.disableRotation();
			const popup = new ml.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
			map.on('load', () => {
				map.addSource('receipts', {
					type: 'geojson',
					data: {
						type: 'FeatureCollection',
						features: points.map((p) => ({
							type: 'Feature',
							geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
							properties: { id: p.id, label: `${p.label} · ${money(p.amount, this.home)}`, r: 6 + 12 * Math.sqrt(p.amount / max) },
						})),
					},
				});
				map.addLayer({
					id: 'receipts',
					type: 'circle',
					source: 'receipts',
					paint: {
						'circle-radius': ['get', 'r'],
						'circle-color': '#f0530f',
						'circle-opacity': 0.35,
						'circle-stroke-color': '#c2410c',
						'circle-stroke-width': 1.5,
					},
				});
			});
			// mousemove, not mouseenter: moving straight from one marker to another must update the label.
			map.on('mousemove', 'receipts', (e) => {
				map.getCanvas().style.cursor = 'pointer';
				const f = e.features[0];
				popup.setLngLat(f.geometry.coordinates).setText(f.properties.label).addTo(map);
			});
			map.on('mouseleave', 'receipts', () => {
				map.getCanvas().style.cursor = '';
				popup.remove();
			});
			map.on('click', 'receipts', (e) => this.onCite(e.features[0].properties.id));
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
