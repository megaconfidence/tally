import { Camera } from './camera.js';

const AUTO_KEY = 'tally:auto-capture';

/** Full-screen camera. Hands a captured JPEG to `onShot`; the camera is released whenever the screen closes. */
export class CaptureScreen {
	constructor(root, { onShot, onPickFile }) {
		this.root = root;
		this.hint = root.querySelector('.guide-hint');
		this.guide = root.querySelector('.guide');
		this.camera = new Camera(root.querySelector('video'), this.guide, {
			onProgress: (p) => this.progress(p),
			onCapture: async (shot) => {
				await this.freeze(shot);
				onShot(shot);
			},
		});

		const auto = root.querySelector('#auto');
		auto.checked = localStorage.getItem(AUTO_KEY) !== 'off';
		this.camera.auto = auto.checked;
		auto.addEventListener('change', () => {
			this.camera.auto = auto.checked;
			localStorage.setItem(AUTO_KEY, auto.checked ? 'on' : 'off');
			this.progress(0);
		});
		root.querySelector('#shutter').addEventListener('click', () => this.camera.capture());
		root.querySelector('#cam-upload').addEventListener('click', () => onPickFile());
		root.querySelector('#enable-camera').addEventListener('click', () => this.open());
		window.addEventListener('keydown', (e) => {
			if (this.root.hidden || e.target.closest?.('input, textarea, dialog[open]')) return;
			if (e.code === 'Space') {
				e.preventDefault();
				this.camera.capture();
			}
		});
	}

	/** Hold the captured frame inside the guide (it morphs into the extraction screen) with a shutter flash. */
	async freeze(shot) {
		this.clearFreeze();
		this.freezeUrl = URL.createObjectURL(shot.blob);
		const img = document.createElement('img');
		img.className = 'freeze';
		img.alt = '';
		img.src = this.freezeUrl;
		this.guide.append(img);
		this.root.classList.remove('flash');
		void this.root.offsetWidth;
		this.root.classList.add('flash');
		await img.decode().catch(() => undefined);
		await new Promise((r) => setTimeout(r, 120));
	}

	/** The frozen frame shown after a capture; it morphs into the extraction screen's receipt. */
	get freezeEl() {
		return this.guide.querySelector('.freeze');
	}

	clearFreeze() {
		this.guide.querySelector('.freeze')?.remove();
		this.root.classList.remove('flash');
		if (this.freezeUrl) URL.revokeObjectURL(this.freezeUrl);
		this.freezeUrl = null;
	}

	progress(p) {
		this.root.style.setProperty('--p', p);
		this.hint.textContent = !this.camera.auto ? 'Tap the button to take a photo' : p > 0 ? 'Hold still…' : 'Fit the receipt inside the frame';
	}

	async open() {
		this.clearFreeze();
		this.progress(0);
		try {
			await this.camera.start();
			this.root.classList.add('cam-on');
		} catch (err) {
			this.root.classList.remove('cam-on');
			this.root.querySelector('.cam-off-sub').textContent = `${err.message}. You can choose a photo instead.`;
		}
	}

	close() {
		this.camera.stop();
		this.root.classList.remove('cam-on');
	}
}
