// Development entry point: compile TypeScript with ts-node (keeping Nest's decorator metadata)
// instead of Node's built-in type stripping, which loads a .ts entry file as an ES module.
// Usage: node --watch dev.cjs main|worker
require("ts-node/register");
const entry = process.argv[2];
if (!["main", "worker"].includes(entry)) {
  throw new Error("Usage: node dev.cjs main|worker");
}
require(`./src/${entry}.ts`);
