import { loadConfig, xvfbScreenArgs } from "../src/config.js";

const config = await loadConfig();
process.stdout.write(xvfbScreenArgs(config));
