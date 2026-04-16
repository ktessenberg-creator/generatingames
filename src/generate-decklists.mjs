import { buildFactionDecks, writeFactionDecks } from "./lib/decks.mjs";

async function main() {
  const rootDir = process.cwd();
  const decks = await buildFactionDecks(rootDir);
  await writeFactionDecks(rootDir, decks);
  console.log(`Generated ${decks.length} faction decks in ${rootDir}/output/decks`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
