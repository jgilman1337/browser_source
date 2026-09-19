import { loadConfig, xvfbScreenArgs } from "../src/config/index";

const config = await loadConfig();
process.stdout.write(xvfbScreenArgs(config));
