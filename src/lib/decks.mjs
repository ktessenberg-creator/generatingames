import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { csvEscape, loadCards, parseCsv, slugify } from "./cards.mjs";

const DECK_DIR = ["data", "decks"];

export async function buildFactionDecks(rootDir) {
  const cards = await loadCards(rootDir, { resolvePortraits: true });
  const deckDir = path.join(rootDir, ...DECK_DIR);
  const defaultDecks = buildDefaultFactionDeckSpecs(cards);

  await ensureDeckCsvs(deckDir, defaultDecks);

  const files = (await readdir(deckDir))
    .filter((file) => file.toLowerCase().endsWith(".csv"))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No deck CSV files found in ${deckDir}`);
  }

  const cardsByName = new Map(cards.map((card) => [normalizeCardName(card.name), card]));
  const factionNames = defaultDecks.map((deck) => deck.name);

  return Promise.all(
    files.map(async (file) => {
      const csv = await readFile(path.join(deckDir, file), "utf8");
      const rows = parseCsv(csv);
      const deckName = resolveDeckNameFromFile(file, factionNames);
      const cardsForDeck = [];
      let totalCopies = 0;

      for (const row of rows) {
        const name = String(row.name ?? row["card name"] ?? row.card ?? "").trim();
        const copies = Number.parseInt(row.copies ?? row.n ?? row.count ?? "0", 10) || 0;
        if (!name || copies <= 0) {
          continue;
        }

        const card = cardsByName.get(normalizeCardName(name));
        if (!card) {
          throw new Error(`Deck "${deckName}" references unknown card "${name}" in ${file}`);
        }

        for (let copy = 0; copy < copies; copy += 1) {
          cardsForDeck.push(createDeckCard(card, deckName, copy));
        }
        totalCopies += copies;
      }

      return {
        id: slugify(deckName),
        name: deckName,
        faction: deckName,
        cards: cardsForDeck,
        cardCount: totalCopies,
        uniqueCards: rows.filter((row) => Number.parseInt(row.copies ?? row.n ?? row.count ?? "0", 10) > 0).length,
        sourceFile: path.join(...DECK_DIR, file)
      };
    })
  );
}

export async function writeFactionDecks(rootDir, decks) {
  const deckDir = path.join(rootDir, ...DECK_DIR);
  const outputDir = path.join(rootDir, "output", "decks");
  await mkdir(deckDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  for (const deck of decks) {
    const byName = new Map();
    for (const card of deck.cards) {
      byName.set(card.name, (byName.get(card.name) ?? 0) + 1);
    }

    const csv = [
      ["name", "copies"],
      ...[...byName.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, copies]) => [name, String(copies)])
    ]
      .map((cells) => cells.map(csvEscape).join(","))
      .join("\n");

    await writeFile(path.join(deckDir, `${slugify(deck.name)}.csv`), `${csv}\n`, "utf8");
  }

  await writeFile(path.join(outputDir, "faction-decks.json"), `${JSON.stringify(decks, null, 2)}\n`, "utf8");
}

export function summarizeDeck(deck) {
  return {
    id: deck.id,
    name: deck.name,
    faction: deck.faction,
    cardCount: deck.cardCount,
    uniqueCards: deck.uniqueCards
  };
}

function buildDefaultFactionDeckSpecs(cards) {
  const decks = new Map();

  for (const card of cards) {
    for (const faction of card.factions) {
      if (!decks.has(faction)) {
        decks.set(faction, {
          id: slugify(faction),
          name: faction,
          rows: []
        });
      }

      decks.get(faction).rows.push({
        name: card.name,
        copies: 2
      });
    }
  }

  return [...decks.values()]
    .map((deck) => ({
      ...deck,
      rows: deck.rows.sort((a, b) => a.name.localeCompare(b.name))
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function ensureDeckCsvs(deckDir, defaultDecks) {
  await mkdir(deckDir, { recursive: true });
  const existing = (await readdir(deckDir)).filter((file) => file.toLowerCase().endsWith(".csv"));
  if (existing.length > 0) {
    return;
  }

  for (const deck of defaultDecks) {
    const csv = [
      ["name", "copies"],
      ...deck.rows.map((row) => [row.name, String(row.copies)])
    ]
      .map((cells) => cells.map(csvEscape).join(","))
      .join("\n");

    await writeFile(path.join(deckDir, `${deck.id}.csv`), `${csv}\n`, "utf8");
  }
}

function resolveDeckNameFromFile(file, factionNames) {
  const stem = file.replace(/\.csv$/i, "");
  const matchedFaction = factionNames.find((name) => slugify(name) === stem);
  if (matchedFaction) {
    return matchedFaction;
  }

  return stem
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCardName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function createDeckCard(card, faction, copy) {
  return {
    instanceId: `${slugify(faction)}:${card.portraitBase}:${copy + 1}`,
    cardId: card.portraitBase,
    name: card.name,
    faction,
    factions: card.factions,
    factionIconPaths: (card.factions || []).map((entry) => `/assets/factions/${slugify(entry)}.svg`),
    cardType: card.cardType,
    arcana: card.arcana,
    basePower: card.power,
    power: card.power,
    text: card.text,
    flavourText: card.flavourText,
    portraitPath: card.portraitFile ? `/assets/portraits/${card.portraitFile}` : "",
    cardAssetPath: `/output/cards/${card.portraitBase}.svg`
  };
}
