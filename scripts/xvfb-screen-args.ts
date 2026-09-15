import { loadConfig, xvfbScreenArgs } from "../src/config.ts";

const config = await loadConfig();
process.stdout.write(xvfbScreenArgs(config));
