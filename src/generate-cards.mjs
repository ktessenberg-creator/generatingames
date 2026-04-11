import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  arcanaPalette,
  ensurePortraitReadme,
  escapeXml,
  factionIconDesigns,
  factionPalette,
  loadCards,
  slugify,
  writePromptArtifacts
} from "./lib/cards.mjs";

const CARD_WIDTH = 744;
const CARD_HEIGHT = 1039;
const SAFE_MARGIN = 42;
const ART_X = 42;
const ART_Y = 162;
const ART_WIDTH = CARD_WIDTH - ART_X * 2;
const ART_HEIGHT = 370;
const TEXT_X = 58;

async function main() {
  const rootDir = process.cwd();
  const outputDir = path.join(rootDir, "output", "cards");
  const portraitDir = path.join(rootDir, "assets", "portraits");
  const iconDir = path.join(rootDir, "assets", "factions");

  await mkdir(outputDir, { recursive: true });
  await mkdir(portraitDir, { recursive: true });
  await mkdir(iconDir, { recursive: true });

  const cards = await loadCards(rootDir, { resolvePortraits: true });

  for (const [faction, design] of Object.entries(factionIconDesigns)) {
    await writeFile(path.join(iconDir, `${slugify(faction)}.svg`), design.svg, "utf8");
  }

  for (const card of cards) {
    const svg = renderCardSvg(card);
    await writeFile(path.join(outputDir, `${slugify(card.name)}.svg`), svg, "utf8");
  }

  await writeFile(path.join(outputDir, "index.html"), renderGallery(cards), "utf8");
  await writePromptArtifacts(rootDir, cards);
  await ensurePortraitReadme(path.join(portraitDir, "README.md"));

  console.log(`Generated ${cards.length} cards in ${outputDir}`);
}

function renderCardSvg(card) {
  const titleSize = fitTitleSize(card.name);
  const wrappedText = wrapText(card.text, 38);
  const textLines = wrappedText
    .map((line, index) => {
      const y = 782 + index * 36;
      return `<text x="${TEXT_X}" y="${y}" class="rules">${escapeXml(line)}</text>`;
    })
    .join("\n");

  const factions = card.factions.length > 0 ? card.factions : ["Neutral"];
  const factionPills = factions
    .map((faction, index) => renderFactionPill(faction, 56 + index * 170, 110))
    .join("\n");

  const arcana = arcanaPalette[card.arcana] ?? arcanaPalette[""];
  const typeLabel = card.arcana ? `${card.arcana} ${card.cardType}` : card.cardType;
  const portraitHref = getPortraitHref(card);
  const artMarkup = portraitHref ? renderPortraitImage(card, portraitHref) : renderPortraitPlaceholder(card);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
  <defs>
    <linearGradient id="cardBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f9f2de" />
      <stop offset="100%" stop-color="#ddc89e" />
    </linearGradient>
    <linearGradient id="artBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#66573f" />
      <stop offset="100%" stop-color="#372a19" />
    </linearGradient>
    <pattern id="grain" width="12" height="12" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="3" r="1" fill="#ffffff" fill-opacity="0.08" />
      <circle cx="9" cy="6" r="1" fill="#000000" fill-opacity="0.06" />
      <circle cx="5" cy="10" r="1" fill="#ffffff" fill-opacity="0.08" />
    </pattern>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-opacity="0.18" />
    </filter>
    <clipPath id="artClip">
      <rect x="${ART_X}" y="${ART_Y}" width="${ART_WIDTH}" height="${ART_HEIGHT}" rx="28" />
    </clipPath>
  </defs>
  <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="36" fill="#3a2816" />
  <rect x="10" y="10" width="${CARD_WIDTH - 20}" height="${CARD_HEIGHT - 20}" rx="28" fill="url(#cardBg)" />
  <rect x="${SAFE_MARGIN}" y="${SAFE_MARGIN}" width="${CARD_WIDTH - SAFE_MARGIN * 2}" height="${CARD_HEIGHT - SAFE_MARGIN * 2}" rx="24" fill="#f7edd2" stroke="#8d7143" stroke-width="4" />
  <rect x="${SAFE_MARGIN}" y="${SAFE_MARGIN}" width="${CARD_WIDTH - SAFE_MARGIN * 2}" height="100" rx="24" fill="#4e351f" />
  ${factionPills}
  <circle cx="650" cy="94" r="48" fill="#fcf4de" stroke="#8d7143" stroke-width="6" />
  <text x="650" y="108" text-anchor="middle" class="powerValue">${card.power}</text>
  <text x="56" y="94" class="title" font-size="${titleSize}">${escapeXml(card.name)}</text>
  <rect x="${ART_X}" y="${ART_Y}" width="${ART_WIDTH}" height="${ART_HEIGHT}" rx="28" fill="url(#artBg)" filter="url(#shadow)" />
  ${artMarkup}
  <rect x="${ART_X + 18}" y="${ART_Y + 18}" width="${ART_WIDTH - 36}" height="${ART_HEIGHT - 36}" rx="22" fill="#8d6f46" fill-opacity="0.05" stroke="#cfb077" stroke-opacity="0.72" />
  ${renderFactionIcons(card)}
  <rect x="56" y="560" width="632" height="54" rx="18" fill="${arcana.bg}" />
  <text x="${CARD_WIDTH / 2}" y="596" text-anchor="middle" fill="${arcana.fg}" class="typeLine">${escapeXml(typeLabel)}</text>
  <rect x="56" y="638" width="632" height="306" rx="24" fill="#fff7e8" stroke="#c7ac77" stroke-width="3" />
  ${textLines}
  <text x="56" y="986" class="footer">Generated by GameGen v0.1</text>
  <style>
    .title { font-family: Georgia, 'Times New Roman', serif; font-weight: 700; fill: #f7edd2; letter-spacing: 0.6px; }
    .powerValue { font-family: Georgia, 'Times New Roman', serif; font-size: 52px; font-weight: 700; fill: #3d2b17; }
    .factionText { font-family: Arial, sans-serif; font-size: 22px; font-weight: 700; }
    .artPrompt { font-family: Arial, sans-serif; font-size: 28px; font-weight: 700; fill: #f8efe0; letter-spacing: 3px; opacity: 0.82; }
    .artName { font-family: Georgia, 'Times New Roman', serif; font-size: 58px; font-weight: 700; fill: #fff5dc; }
    .artHint { font-family: Arial, sans-serif; font-size: 24px; fill: #f2dfbe; opacity: 0.9; }
    .infoLabel { font-family: Arial, sans-serif; font-size: 18px; font-weight: 700; fill: #ffe5ae; letter-spacing: 2px; }
    .infoText { font-family: Georgia, 'Times New Roman', serif; font-size: 24px; fill: #fff4da; }
    .typeLine { font-family: Arial, sans-serif; font-size: 24px; font-weight: 700; letter-spacing: 1.5px; }
    .rules { font-family: Georgia, 'Times New Roman', serif; font-size: 31px; fill: #342515; }
    .footer { font-family: Arial, sans-serif; font-size: 19px; fill: #7b6342; }
  </style>
</svg>`;
}

function renderFactionPill(faction, x, y) {
  const palette = factionPalette[faction] ?? { bg: "#ebe4d1", fg: "#5c4d35" };
  const width = Math.max(112, 26 + faction.length * 11);
  return `<g transform="translate(${x}, ${y - 22})">
    <rect width="${width}" height="36" rx="18" fill="${palette.bg}" />
    <text x="${width / 2}" y="24" text-anchor="middle" class="factionText" fill="${palette.fg}">${escapeXml(faction)}</text>
  </g>`;
}

function renderFactionIcons(card) {
  const factions = card.factions.length > 0 ? card.factions : ["Neutral"];
  return factions
    .map((faction, index) => {
      const x = 78 + index * 74;
      return `<g transform="translate(${x}, 468)">
        <circle cx="24" cy="24" r="26" fill="rgba(255, 248, 235, 0.92)" stroke="#c9ab6d" stroke-width="3" />
        <image href="../../assets/factions/${slugify(faction)}.svg" x="0" y="0" width="48" height="48" />
      </g>`;
    })
    .join("\n");
}

function renderPortraitImage(card, href) {
  return `<image href="${href}" x="${ART_X}" y="${ART_Y}" width="${ART_WIDTH}" height="${ART_HEIGHT}" preserveAspectRatio="xMidYMid slice" clip-path="url(#artClip)" />
  <rect x="${ART_X}" y="${ART_Y}" width="${ART_WIDTH}" height="${ART_HEIGHT}" rx="28" fill="url(#grain)" opacity="0.2" />
  <rect x="${ART_X}" y="${ART_Y + ART_HEIGHT - 112}" width="${ART_WIDTH}" height="112" fill="#1d1206" fill-opacity="0.48" />
  <text x="${ART_X + 30}" y="${ART_Y + ART_HEIGHT - 72}" class="infoLabel">PORTRAIT</text>
  <text x="${ART_X + 30}" y="${ART_Y + ART_HEIGHT - 34}" class="infoText">${escapeXml(card.info || card.name)}</text>`;
}

function renderPortraitPlaceholder(card) {
  const lines = wrapText(card.info || renderArtHint(card), 34).slice(0, 3);
  const textLines = lines
    .map((line, index) => `<text x="${CARD_WIDTH / 2}" y="${ART_Y + 214 + index * 38}" text-anchor="middle" class="artHint">${escapeXml(line)}</text>`)
    .join("\n");

  return `<rect x="${ART_X + 18}" y="${ART_Y + 18}" width="${ART_WIDTH - 36}" height="${ART_HEIGHT - 36}" rx="22" fill="#8d6f46" fill-opacity="0.16" stroke="#cfb077" stroke-opacity="0.55" />
  <rect x="${ART_X}" y="${ART_Y}" width="${ART_WIDTH}" height="${ART_HEIGHT}" rx="28" fill="url(#grain)" />
  <circle cx="${CARD_WIDTH / 2}" cy="${ART_Y + 128}" r="56" fill="rgba(255,245,220,0.16)" />
  <path d="M280 ${ART_Y + 286} C308 ${ART_Y + 228}, 436 ${ART_Y + 228}, 464 ${ART_Y + 286} L464 ${ART_Y + 332} L280 ${ART_Y + 332} Z" fill="rgba(255,245,220,0.14)" />
  <text x="${CARD_WIDTH / 2}" y="${ART_Y + 146}" text-anchor="middle" class="artPrompt">${escapeXml(card.cardType.toUpperCase())}</text>
  <text x="${CARD_WIDTH / 2}" y="${ART_Y + 192}" text-anchor="middle" class="artName">${escapeXml(card.name)}</text>
  ${textLines}`;
}

function renderArtHint(card) {
  const factions = card.factions.join(" • ");
  return [factions, `Power ${card.power}`].filter(Boolean).join(" • ");
}

function fitTitleSize(name) {
  if (name.length <= 10) return 54;
  if (name.length <= 16) return 46;
  if (name.length <= 22) return 40;
  return 34;
}

function wrapText(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, 7);
}

function getPortraitHref(card) {
  return card.portraitFile ? `../../assets/portraits/${card.portraitFile}` : "";
}

function renderGallery(cards) {
  const cardLinks = cards
    .map((card) => {
      const filename = `${slugify(card.name)}.svg`;
      return `<a class="card" href="./${filename}" target="_blank" rel="noreferrer">
        <img src="./${filename}" alt="${escapeXml(card.name)}" />
        <span>${escapeXml(card.name)}</span>
      </a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GameGen Card Gallery</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f0e4c7;
        --ink: #382615;
        --panel: rgba(255, 248, 235, 0.78);
        --line: rgba(77, 54, 31, 0.2);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Arial, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.5), transparent 36%),
          linear-gradient(145deg, #d7be92, var(--bg) 45%, #ccb180);
      }
      main {
        width: min(1200px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }
      h1 {
        margin: 0 0 10px;
        font-family: Georgia, 'Times New Roman', serif;
        font-size: clamp(2rem, 4vw, 3.5rem);
      }
      p {
        margin: 0 0 24px;
        max-width: 760px;
        line-height: 1.5;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 20px;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
        text-decoration: none;
        color: inherit;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 20px;
        box-shadow: 0 16px 30px rgba(55, 35, 15, 0.12);
        backdrop-filter: blur(10px);
      }
      img {
        width: 100%;
        border-radius: 16px;
        aspect-ratio: 744 / 1039;
        object-fit: cover;
        background: #f9f2de;
      }
      span { font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>GameGen Card Gallery</h1>
      <p>Generated cards from CSV data with faction icons and portrait slots. Add portrait files under <code>assets/portraits</code> or use the portrait generator to populate them automatically.</p>
      <section class="grid">
        ${cardLinks}
      </section>
    </main>
  </body>
</html>`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
