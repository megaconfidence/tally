import { api } from './api.js';
import { Ask } from './ask.js';
import { CaptureScreen } from './capture.js';
import { SampleDeck } from './deck.js';
import { icon } from './icons.js';
import { Ledger } from './ledger.js';
import { ProcessScreen } from './process.js';
import { SAMPLES } from './samples.js';
import { closeDialog, loadImage, toast, toJpeg, transition, wireDialog } from './util.js';
import { CompareDialog, ExpenseDetail } from './viewer.js';

const $ = (s) => document.querySelector(s);

for (const el of document.querySelectorAll('i[data-icon]')) el.replaceWith(icon(el.dataset.icon, el.closest('.action-icon, .cam-btn') ? 22 : 18));

const screens = {
	home: $('#screen-home'),
	capture: $('#screen-capture'),
	process: $('#screen-process'),
	expense: $('#screen-expense'),
	ask: $('#screen-ask'),
};

let pendingShot = null;
/** Overrides the inferred transition for the next navigation (e.g. 'morph' when a receipt image carries over). */
let nextKind = null;
/** Element whose image carries over into the next screen (sample card or camera freeze frame). */
let pendingShared = null;
const fileInput = $('#file');
const wide = matchMedia('(min-width: 861px)');

const compare = new CompareDialog($('#compare'));
const ledger = new Ledger(screens.home, {
	onOpen: (id) => (location.hash = `#/expense/${id}`),
	onIntent: (id) => detail.prefetch(id),
});
const detail = new ExpenseDetail(screens.expense, {
	onCompare: (left, id) => compare.open(left, id),
	onDeleted: (id) => {
		detail.invalidate(id);
		ledger.remove(id);
		location.replace('#/');
		toast('Expense deleted');
	},
});
const ask = new Ask(screens.ask, {
	onCite: (id) => (location.hash = `#/expense/${id}?focus=total`),
	lookup: (id) => ledger.byId(id),
});
const capture = new CaptureScreen(screens.capture, {
	onShot: (shot) => {
		nextKind = 'morph';
		pendingShared = capture.freezeEl;
		startProcessing(shot);
	},
	onPickFile: () => fileInput.click(),
});
const processing = new ProcessScreen(screens.process, {
	onSaved: (expense) => detail.prefetch(expense.id),
	onCompare: (current, id) => compare.open(current, id),
	onDone: (expense) => {
		ledger.add(expense);
		if (currentPath() === '/process') location.replace(`#/expense/${expense.id}?new`);
	},
});

const deck = new SampleDeck($('#samples'), SAMPLES, {
	// Samples are already JPEGs of known size, so they skip the decode and re-encode of uploads.
	onPick: (sample, blob, paper) => {
		nextKind = 'morph';
		pendingShared = paper;
		startProcessing({ blob, width: sample.width, height: sample.height });
	},
});

/** Camera, file picker and sample deck all end here. From the camera, the extraction screen replaces it in history. */
function startProcessing(shot) {
	pendingShot = shot;
	if (currentPath() === '/scan') location.replace('#/process');
	else location.hash = '#/process';
}

async function processFile(file) {
	if (!file?.type.startsWith('image/')) return;
	const url = URL.createObjectURL(file);
	try {
		const img = await loadImage(url);
		startProcessing(await toJpeg(img, img.naturalWidth, img.naturalHeight, 2000));
	} catch (err) {
		nextKind = null;
		toast(`Couldn't open that image: ${err.message ?? err}`, 'error');
	} finally {
		URL.revokeObjectURL(url);
	}
}

$('#upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
	if (fileInput.files?.[0]) processFile(fileInput.files[0]);
	fileInput.value = '';
});
window.addEventListener('paste', (e) => processFile([...(e.clipboardData?.files ?? [])][0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
	e.preventDefault();
	processFile([...(e.dataTransfer?.files ?? [])][0]);
});
// Links that leave a flow (back, done, close) replace the current entry so the back button never re-enters it.
document.addEventListener('click', (e) => {
	const link = e.target.closest('a[data-replace]');
	if (!link || e.metaKey || e.ctrlKey) return;
	e.preventDefault();
	location.replace(link.getAttribute('href'));
});
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && !document.querySelector('dialog[open]') && currentPath() !== '/') location.replace('#/');
});

// ---------------------------------------------------------------------------
// Routing: #/  #/scan  #/process  #/expense/:id[?new|?focus=field]  #/ask

function currentPath() {
	return (location.hash.replace(/^#/, '') || '/').split('?')[0];
}

function show(name) {
	for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
	if (name !== 'capture') capture.close();
	window.scrollTo(0, 0);
}

/** Logical screens (summary is the expense screen right after a scan) and how deep each sits. */
const DEPTH = { home: 0, ask: 1, capture: 1, expense: 2, process: 2, summary: 3 };
let current = { screen: null };

function kindFor(from, to) {
	if (nextKind) {
		const kind = nextKind;
		nextKind = null;
		return kind;
	}
	if (!from) return 'none';
	if (to === 'capture') return 'up';
	if (from === 'capture') return 'down';
	// On narrow screens the summary's receipt sits below the fold, so the page slides instead of morphing.
	if (from === 'process' && to === 'summary') return wide.matches ? 'morph' : 'forward';
	if (DEPTH[to] > DEPTH[from]) return 'forward';
	if (DEPTH[to] < DEPTH[from]) return 'back';
	return 'morph';
}

const inViewport = (el) => {
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
};

async function route() {
	const [path, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
	const params = new URLSearchParams(query);
	const from = current;
	let to;
	let update;
	let shared = null;
	let after = () => undefined;

	const expenseMatch = path.match(/^\/expense\/(\d+)$/);
	if (path === '/scan') {
		to = 'capture';
		update = () => {
			show('capture');
			capture.open();
		};
	} else if (path === '/process') {
		if (!pendingShot && !processing.busy) return location.replace('#/');
		to = 'process';
		shared = { from: pendingShared, to: () => processing.view.el };
		pendingShared = null;
		update = async () => {
			show('process');
			if (pendingShot) {
				const shot = pendingShot;
				pendingShot = null;
				await processing.start(shot);
			}
		};
	} else if (expenseMatch) {
		const id = Number(expenseMatch[1]);
		const isNew = params.has('new');
		const imageUrl = isNew ? processing.imageFor(id) : null;
		const data = await detail.load(id, { imageWait: imageUrl ? 0 : 200 });
		if (!data) return location.replace('#/');
		to = isNew ? 'summary' : 'expense';
		if (from.screen === 'process') shared = { from: processing.view.el, to: () => detail.view.el };
		// Build the page while its screen is still hidden, so the transition itself only has to reveal it.
		await detail.render(data, { isNew, imageUrl });
		update = () => show('expense');
		after = () => detail.focus(params.get('focus'));
	} else if (path === '/ask') {
		to = 'ask';
		update = () => show('ask');
		after = () => screens.ask.querySelector('input').focus({ preventScroll: true });
	} else {
		to = 'home';
		update = () => show('home');
		after = () => ledger.revealArrived();
	}

	const kind = kindFor(from.screen, to);
	current = { screen: to };

	// A receipt image shared by both screens morphs between them; it is only named when visible on both sides.
	const morphing = kind === 'morph' && shared?.from && inViewport(shared.from);
	if (morphing) shared.from.style.viewTransitionName = 'receipt';
	await transition(
		kind,
		async (opts) => {
			await update(opts);
			const target = morphing ? shared.to() : null;
			if (target && inViewport(target)) target.style.viewTransitionName = 'receipt';
		},
		() => document.querySelector('.screen:not([hidden])'),
	);
	if (shared) for (const el of [shared.from, shared.to?.()]) if (el) el.style.viewTransitionName = '';
	after();
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Settings

const settingsDialog = $('#settings');
const settingsForm = settingsDialog.querySelector('form');
wireDialog(settingsDialog);
$('#open-settings').addEventListener('click', async () => {
	try {
		const s = await api.settings();
		settingsForm.home_currency.value = s.home_currency;
		settingsForm.policy.value = s.policy;
		settingsDialog.showModal();
	} catch (err) {
		toast(err.message, 'error');
	}
});
settingsDialog.querySelector('.cancel').addEventListener('click', () => closeDialog(settingsDialog));
settingsForm.addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		const s = await api.saveSettings({ home_currency: settingsForm.home_currency.value, policy: settingsForm.policy.value });
		ledger.setHome(s.home_currency);
		ask.home = s.home_currency;
		detail.invalidate();
		await ledger.load();
		await closeDialog(settingsDialog);
		toast('Settings saved');
	} catch (err) {
		toast(err.message, 'error');
	}
});
settingsDialog.querySelector('.reset').addEventListener('click', async () => {
	if (!confirm('Delete every expense and stored receipt image? This cannot be undone.')) return;
	try {
		const { deleted } = await api.reset();
		detail.invalidate();
		await ledger.load();
		await closeDialog(settingsDialog);
		toast(`Deleted ${deleted} expense${deleted === 1 ? '' : 's'}`);
	} catch (err) {
		toast(err.message, 'error');
	}
});

async function init() {
	try {
		const settings = await api.settings();
		ledger.setHome(settings.home_currency);
		ask.home = settings.home_currency;
		await ledger.load();
	} catch (err) {
		toast(`Couldn't load your expenses: ${err.message}`, 'error');
	}
	await route();
}

init();
