import { loadConfig, xvfbScreenArgs } from "../src/config";

const config = await loadConfig();
process.stdout.write(xvfbScreenArgs(config));
