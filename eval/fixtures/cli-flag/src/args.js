export function parseArgs(argv) {
  const options = { name: "world" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") {
      options.name = argv[++i];
    }
  }
  return options;
}
