/**
 * Print a DRM device this process may modeset for GPU capture, or nothing.
 * `--frames` instead checks that kmsgrab can already read the device in argv.
 */
import { loadConfig } from "../src/config/index";
import { findIdleGpu, scanoutProducesFrames } from "../src/streaming/scanout";

const framesFlag = process.argv.indexOf("--frames");
if (framesFlag !== -1) {
	const device = process.argv[framesFlag + 1];
	const ok = device ? await scanoutProducesFrames(device) : false;
	if (!ok) {
		process.exit(1);
	}
	process.stdout.write(device);
	process.exit(0);
}

const config = await loadConfig();
const device = await findIdleGpu(config.ffmpeg.videoCodec);
if (!device) {
	process.exit(1);
}
process.stdout.write(device);
