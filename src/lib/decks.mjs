import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCards, slugify } from "./cards.mjs";

export async function buildFactionDecks(rootDir) {
  const cards = await loadCards(rootDir, { resolvePortraits: true });
  const decks = new Map();

  for (const card of cards) {
    for (const faction of card.factions) {
      if (!decks.has(faction)) {
        decks.set(faction, {
          id: slugify(faction),
          name: faction,
          faction,
          cards: []
        });
      }

      const deck = decks.get(faction);
      for (let copy = 0; copy < 2; copy += 1) {
        deck.cards.push(createDeckCard(card, faction, copy));
      }
    }
  }

  return [...decks.values()]
    .map((deck) => ({
      ...deck,
      cardCount: deck.cards.length,
      uniqueCards: Math.floor(deck.cards.length / 2)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeFactionDecks(rootDir, decks) {
  const outputDir = path.join(rootDir, "output", "decks");
  await mkdir(outputDir, { recursive: true });
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

function createDeckCard(card, faction, copy) {
  return {
    instanceId: `${slugify(faction)}:${card.portraitBase}:${copy + 1}`,
    cardId: card.portraitBase,
    name: card.name,
    faction,
    factions: card.factions,
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
