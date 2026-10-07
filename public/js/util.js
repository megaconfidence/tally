export const UNSURE = 0.9;

export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') el.className = v;
		else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
		else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
		else if (k === 'dataset') Object.assign(el.dataset, v);
		else el.setAttribute(k, v === true ? '' : v);
	}
	for (const c of children.flat()) {
		if (c === null || c === undefined || c === false) continue;
		el.append(c instanceof Node ? c : document.createTextNode(String(c)));
	}
	return el;
}

export function money(amount, currency) {
	if (amount === null || amount === undefined) return '';
	try {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
	} catch {
		return `${amount.toFixed(2)} ${currency}`;
	}
}

export function prettyDate(iso) {
	if (!iso) return 'No date';
	const d = new Date(`${iso}T12:00:00`);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const label = (s) => (s ?? '').replace(/_/g, ' ');

export function flag(cc) {
	if (!cc || cc.length !== 2) return '';
	return cc.toUpperCase();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Motion tokens shared with styles.css (--ease-out, --dur-*).
export const EASE_OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
export const DUR = { fast: 120, base: 200, page: 320, morph: 480 };
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Run a DOM update as a screen transition. `kind` (forward, back, up, down, morph) selects the
 * animation in styles.css. Uses the View Transitions API when available, otherwise animates the
 * entering screen. `update` receives { viewTransition } so callers can tidy up overlays.
 */
export async function transition(kind, update, enteringEl) {
	const animate = kind && kind !== 'none' && !reducedMotion();
	if (!animate || !document.startViewTransition) {
		await update({ viewTransition: false });
		const el = typeof enteringEl === 'function' ? enteringEl() : enteringEl;
		if (animate && el) {
			el.classList.add(`enter-${kind}`);
			el.addEventListener('animationend', () => el.classList.remove(`enter-${kind}`), { once: true });
		}
		return;
	}
	document.documentElement.dataset.nav = kind;
	const vt = document.startViewTransition(() => update({ viewTransition: true }));
	// An interrupted transition rejects `ready`; the update still applies, so that is not an error.
	vt.ready.catch(() => undefined);
	try {
		await vt.finished;
	} catch {
		// A skipped transition still applies the update.
	} finally {
		delete document.documentElement.dataset.nav;
	}
}

/** Dialogs animate out before closing; Escape and backdrop clicks use the same path. */
export function closeDialog(dialog) {
	if (!dialog.open || dialog.classList.contains('closing')) return Promise.resolve();
	if (reducedMotion()) {
		dialog.close();
		return Promise.resolve();
	}
	dialog.classList.add('closing');
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			dialog.classList.remove('closing');
			dialog.close();
			resolve();
		};
		dialog.addEventListener('animationend', finish, { once: true });
		setTimeout(finish, DUR.base + 80);
	});
}

export function wireDialog(dialog) {
	dialog.addEventListener('cancel', (e) => {
		e.preventDefault();
		closeDialog(dialog);
	});
	dialog.addEventListener('click', (e) => {
		if (e.target === dialog) closeDialog(dialog);
	});
}

/** Animate a ghost element from one screen rect to a target element. */
export function fly(fromRect, toEl, content, className = '') {
	if (!fromRect || !toEl) return Promise.resolve();
	const to = toEl.getBoundingClientRect();
	if (!to.width && !to.height) return Promise.resolve();
	const ghost = h('div', { class: `fly ${className}` }, content);
	Object.assign(ghost.style, {
		left: `${fromRect.left}px`,
		top: `${fromRect.top}px`,
		minWidth: `${Math.min(fromRect.width, 260)}px`,
		minHeight: `${Math.min(fromRect.height, 34)}px`,
	});
	document.body.append(ghost);
	const dx = to.left - fromRect.left;
	const dy = to.top - fromRect.top;
	const anim = ghost.animate(
		[
			{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
			{ transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) scale(1.08)`, opacity: 1, offset: 0.5 },
			{ transform: `translate(${dx}px, ${dy}px) scale(0.9)`, opacity: 0.2 },
		],
		{ duration: reducedMotion() ? 1 : 600, easing: EASE_OUT },
	);
	return anim.finished.then(() => ghost.remove());
}

export function toast(message, kind = 'info') {
	const root = document.getElementById('toasts');
	const el = h('div', { class: `toast ${kind}` }, message);
	root.append(el);
	setTimeout(() => el.classList.add('out'), 4200);
	setTimeout(() => el.remove(), 4800);
}

export function loadImage(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

/** Downscale an image source to a JPEG blob whose long side is at most `max` px. */
export async function toJpeg(source, sw, sh, max = 2000, crop = null) {
	const c = crop ?? { x: 0, y: 0, w: sw, h: sh };
	const scale = Math.min(1, max / Math.max(c.w, c.h));
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(c.w * scale);
	canvas.height = Math.round(c.h * scale);
	canvas.getContext('2d').drawImage(source, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
	const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
	return { blob, width: canvas.width, height: canvas.height };
}
