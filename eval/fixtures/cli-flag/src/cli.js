import { parseArgs } from "./args.js";

const options = parseArgs(process.argv.slice(2));
console.log(`hello, ${options.name}`);
