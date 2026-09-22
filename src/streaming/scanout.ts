/**
 * GPU scanout capture: the page is already a display plane, and the encoder
 * reads that plane. This is the path OBS uses when the browser surface lives
 * on the same GPU that encodes. Xvfb has no plane, so callers keep WebM capture.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/** DRM card ffmpeg can grab, after this process owns the display on it. */
export type GpuScanout = {
	device: string;
};

/** Encoders that can import a DRM plane without copying the frame through RAM. */
function frameFilter(videoCodec: string, width: number, height: number): string | null {
	if (videoCodec.endsWith("_nvenc")) {
		return `hwmap=derive_device=cuda,scale_cuda=w=${width}:h=${height}:format=nv12`;
	}
	if (videoCodec.endsWith("_vaapi")) {
		return `hwmap=derive_device=vaapi,scale_vaapi=w=${width}:h=${height}:format=nv12`;
	}
	if (videoCodec.endsWith("_qsv")) {
		return `hwmap=derive_device=qsv,scale_qsv=w=${width}:h=${height}:format=nv12`;
	}
	return null;
}

/** True when this encoder can consume frames from `driver` directly. */
function driverMatches(videoCodec: string, driver: string): boolean {
	if (videoCodec.endsWith("_nvenc")) {
		return driver === "nvidia";
	}
	if (videoCodec.endsWith("_vaapi")) {
		return driver === "i915" || driver === "amdgpu" || driver === "radeon";
	}
	if (videoCodec.endsWith("_qsv")) {
		return driver === "i915";
	}
	return false;
}

/** Video filter for a confirmed scanout, or null when this encoder cannot take GPU frames. */
export function scanoutVideoFilter(videoCodec: string, width: number, height: number): string | null {
	return frameFilter(videoCodec, width, height);
}

/** DRM cards currently exposed on this machine. */
async function listCards(): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir("/dev/dri");
	} catch {
		return [];
	}
	return names.filter((name) => /^card\d+$/.test(name)).sort();
}

/** Kernel driver bound to one DRM card, from the device uevent. */
async function readDriver(card: string): Promise<string | null> {
	try {
		const uevent = await readFile(`/sys/class/drm/${card}/device/uevent`, "utf-8");
		const match = uevent.match(/^DRIVER=(.+)$/m);
		return match?.[1] ?? null;
	} catch {
		return null;
	}
}

/** Connector sysfs directories for one card (`card1-HDMI-A-1` and the rest). */
async function connectorDirs(card: string): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir("/sys/class/drm");
	} catch {
		return [];
	}
	const prefix = `${card}-`;
	return names.filter((name) => name.startsWith(prefix));
}

/** True when the card has a physical connector we could modeset for the browser. */
async function hasConnector(card: string): Promise<boolean> {
	const dirs = await connectorDirs(card);
	for (const dir of dirs) {
		try {
			await readFile(`/sys/class/drm/${dir}/status`, "utf-8");
			return true;
		} catch {
			// Not a connector directory.
		}
	}
	return false;
}

/**
 * True when another display server is already scanning out on this card.
 * Grabbing that plane would capture their desktop, not the browser in this process.
 */
async function isBusy(card: string): Promise<boolean> {
	const dirs = await connectorDirs(card);
	for (const dir of dirs) {
		try {
			const enabled = (await readFile(`/sys/class/drm/${dir}/enabled`, "utf-8")).trim();
			if (enabled === "enabled") {
				return true;
			}
		} catch {
			// Connector without an enabled file.
		}
	}
	return false;
}

/**
 * Idle GPU whose scanout this encoder can import.
 * The card must have a connector and must not already be driving a display.
 */
export async function findIdleGpu(videoCodec: string): Promise<string | null> {
	if (!frameFilter(videoCodec, 1, 1)) {
		return null;
	}
	for (const card of await listCards()) {
		const driver = await readDriver(card);
		if (!driver || !driverMatches(videoCodec, driver)) {
			continue;
		}
		if (!(await hasConnector(card)) || (await isBusy(card))) {
			continue;
		}
		return `/dev/dri/${card}`;
	}
	return null;
}

/** True when kmsgrab can read one frame from this DRM device. */
export async function scanoutProducesFrames(device: string): Promise<boolean> {
	if (!device.startsWith("/dev/dri/card")) {
		return false;
	}
	return await new Promise<boolean>((resolve) => {
		const process = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"kmsgrab",
				"-device",
				device,
				"-framerate",
				"30",
				"-i",
				"-",
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ stdio: "ignore" },
		);
		const timer = setTimeout(() => {
			process.kill("SIGKILL");
		}, 4_000);
		process.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		process.once("close", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}
