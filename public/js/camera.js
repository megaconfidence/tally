import { toJpeg } from './util.js';

const SAMPLE_W = 24;
const SAMPLE_H = 32;
const TICK_MS = 100;
/** Hand shake is mostly small translation, so frames are compared after the best shift within ±SEARCH samples. */
const SEARCH = 3;
/** Residual difference after shift compensation, relative to frame contrast: below STILL is steady, above MOVING resets. */
const STILL = 0.45;
const MOVING = 0.75;
/** Net displacement (in samples, about 4% of the frame each). Shake cancels out over time; a pan accumulates. */
const MAX_DRIFT = 3;
const MIN_CONTRAST = 16;
const REARM_DIFF = 14;
const HOLD_MS = 800;

/**
 * Camera preview with a receipt guide. Auto-capture fires once the guide area has been roughly
 * steady for HOLD_MS (small hand shake is tolerated) and looks like a document, and re-arms only
 * after the scene changes.
 */
export class Camera {
	constructor(video, guide, { onProgress, onCapture }) {
		this.video = video;
		this.guide = guide;
		this.onProgress = onProgress;
		this.onCapture = onCapture;
		this.auto = true;
		this.armed = true;
		this.paused = true;
		this.sample = document.createElement('canvas');
		this.sample.width = SAMPLE_W;
		this.sample.height = SAMPLE_H;
		this.sctx = this.sample.getContext('2d', { willReadFrequently: true });
		this.prev = null;
		this.motion = 0;
		this.drift = { x: 0, y: 0 };
		this.progress = 0;
		this.lastTick = 0;
		this.lastCaptured = null;
	}

	async start() {
		if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera needs a secure connection (https or localhost)');
		if (!this.stream) {
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
			});
			this.video.srcObject = this.stream;
		}
		await this.video.play();
		this.armed = true;
		this.resume();
	}

	/** Release the camera so the indicator light turns off. */
	stop() {
		this.pause();
		clearInterval(this.timer);
		this.timer = null;
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.video.srcObject = null;
	}

	get active() {
		return Boolean(this.stream);
	}

	pause() {
		this.paused = true;
		this.setProgress(0);
	}

	resume() {
		if (!this.active) return;
		this.paused = false;
		this.prev = null;
		this.motion = 0;
		this.drift = { x: 0, y: 0 };
		this.setProgress(0);
		this.lastTick = performance.now();
		if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
	}

	setProgress(p) {
		this.progress = p;
		this.onProgress?.(p);
	}

	/** Crop rectangle of the guide in video pixel coordinates (video uses object-fit: cover). */
	cropRect() {
		const vw = this.video.videoWidth;
		const vh = this.video.videoHeight;
		const box = this.video.getBoundingClientRect();
		const g = this.guide.getBoundingClientRect();
		const scale = Math.max(box.width / vw, box.height / vh);
		const ox = (box.width - vw * scale) / 2;
		const oy = (box.height - vh * scale) / 2;
		const x = Math.max(0, (g.left - box.left - ox) / scale);
		const y = Math.max(0, (g.top - box.top - oy) / scale);
		return { x, y, w: Math.min(vw - x, g.width / scale), h: Math.min(vh - y, g.height / scale) };
	}

	signature() {
		const c = this.cropRect();
		this.sctx.drawImage(this.video, c.x, c.y, c.w, c.h, 0, 0, SAMPLE_W, SAMPLE_H);
		const { data } = this.sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
		const lum = new Float32Array(SAMPLE_W * SAMPLE_H);
		let sum = 0;
		for (let i = 0; i < lum.length; i++) {
			lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
			sum += lum[i];
		}
		const mean = sum / lum.length;
		let variance = 0;
		for (const v of lum) variance += (v - mean) ** 2;
		return { lum, contrast: Math.sqrt(variance / lum.length) };
	}

	static diff(a, b) {
		let d = 0;
		for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
		return d / a.length;
	}

	/** Smallest mean difference between two frames over shifts of up to ±SEARCH samples, and the shift that achieves it. */
	static shiftedDiff(a, b) {
		let best = { residual: Infinity, dx: 0, dy: 0 };
		for (let dy = -SEARCH; dy <= SEARCH; dy++) {
			for (let dx = -SEARCH; dx <= SEARCH; dx++) {
				let d = 0;
				let n = 0;
				for (let y = SEARCH; y < SAMPLE_H - SEARCH; y++) {
					const row = y * SAMPLE_W;
					const shifted = (y + dy) * SAMPLE_W + dx;
					for (let x = SEARCH; x < SAMPLE_W - SEARCH; x++) {
						d += Math.abs(a[row + x] - b[shifted + x]);
						n++;
					}
				}
				const residual = d / n;
				if (residual < best.residual) best = { residual, dx, dy };
			}
		}
		return best;
	}

	tick() {
		const now = performance.now();
		const dt = now - this.lastTick;
		this.lastTick = now;
		if (this.paused || !this.auto || this.video.readyState < 2 || !this.video.videoWidth) return;

		const sig = this.signature();
		if (!this.armed && this.lastCaptured && Camera.diff(sig.lum, this.lastCaptured) > REARM_DIFF) this.armed = true;
		const prev = this.prev;
		this.prev = sig.lum;
		if (!prev) return;
		const { residual, dx, dy } = Camera.shiftedDiff(sig.lum, prev);
		this.drift = { x: this.drift.x * 0.8 + dx, y: this.drift.y * 0.8 + dy };
		const relative = residual / Math.max(sig.contrast, 8);
		this.motion = this.motion * 0.5 + relative * 0.5;
		const moving = this.motion >= MOVING || Math.hypot(this.drift.x, this.drift.y) > MAX_DRIFT;

		if (!this.armed || sig.contrast < MIN_CONTRAST || moving) {
			if (this.progress) this.setProgress(0);
			return;
		}
		const next = this.motion < STILL ? this.progress + dt / HOLD_MS : Math.max(0, this.progress - dt / (HOLD_MS * 2));
		this.setProgress(Math.min(1, next));
		if (this.progress >= 1) this.capture();
	}

	async capture() {
		if (!this.active || this.video.readyState < 2) return;
		this.pause();
		this.lastCaptured = this.signature().lum;
		this.armed = false;
		const shot = await toJpeg(this.video, this.video.videoWidth, this.video.videoHeight, 2000, this.cropRect());
		this.onCapture?.(shot);
	}
}
