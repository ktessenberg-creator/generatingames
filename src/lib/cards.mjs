import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const factionPalette = {
  Adventurer: { bg: "#ecd9b0", fg: "#47311d" },
  "Outer Col": { bg: "#d9ddf8", fg: "#2a356d" },
  Park: { bg: "#d8f0d1", fg: "#1f5b24" },
  Thieves: { bg: "#e0d7f8", fg: "#43206b" },
  Septarchy: { bg: "#f8e0c8", fg: "#7b4512" },
  Abaddon: { bg: "#2f1f2b", fg: "#f8dbe9" }
};

export const arcanaPalette = {
  Major: { bg: "#261b37", fg: "#f7d67c" },
  Minor: { bg: "#29414f", fg: "#d7eff7" },
  "": { bg: "#f0f0f0", fg: "#646464" }
};

export const factionIconDesigns = {
  Adventurer: {
    accent: "#c2782d",
    svg: iconSvg("Adventurer", "#c2782d", "#fff7ea", "M60 20 L84 44 L60 68 L36 44 Z", "M60 36 L72 48 L60 60 L48 48 Z")
  },
  "Outer Col": {
    accent: "#5367c3",
    svg: iconSvg("Outer Col", "#5367c3", "#eef2ff", "M28 72 C40 26, 80 26, 92 72 Z", "M42 56 L60 26 L78 56 Z")
  },
  Park: {
    accent: "#4f8f49",
    svg: iconSvg("Park", "#4f8f49", "#eef8eb", "M60 20 C72 36, 74 56, 60 82 C46 56, 48 36, 60 20 Z", "M57 58 L63 58 L63 92 L57 92 Z")
  },
  Thieves: {
    accent: "#663c9e",
    svg: iconSvg("Thieves", "#663c9e", "#f2eaff", "M24 74 L60 22 L96 74 L60 54 Z", "M60 34 L72 52 L60 44 L48 52 Z")
  },
  Septarchy: {
    accent: "#b86d2c",
    svg: iconSvg("Septarchy", "#b86d2c", "#fff2e4", "M60 18 L70 36 L90 40 L76 56 L80 78 L60 68 L40 78 L44 56 L30 40 L50 36 Z", "M60 34 A8 8 0 1 1 59.9 34 Z")
  },
  Abaddon: {
    accent: "#5a243f",
    svg: iconSvg("Abaddon", "#5a243f", "#fbeaf1", "M36 84 C36 50, 44 28, 60 20 C76 28, 84 50, 84 84 Z", "M48 58 C52 48, 56 44, 60 42 C64 44, 68 48, 72 58")
  },
  Neutral: {
    accent: "#7f715e",
    svg: iconSvg("Neutral", "#7f715e", "#f4f0ea", "M60 22 L94 44 L94 76 L60 98 L26 76 L26 44 Z", "M60 34 L80 46 L80 72 L60 84 L40 72 L40 46 Z")
  }
};

export async function loadCards(rootDir, { resolvePortraits = false } = {}) {
  const inputPath = await resolveInputPath(rootDir);
  const portraitDir = path.join(rootDir, "assets", "portraits");
  const csv = await readFile(inputPath, "utf8");
  const rows = parseCsv(csv);
  return Promise.all(rows.map((row) => normalizeCard(row, resolvePortraits ? portraitDir : null)));
}

export async function writePromptArtifacts(rootDir, cards) {
  const promptDir = path.join(rootDir, "output", "prompts");
  await mkdir(promptDir, { recursive: true });

  for (const card of cards) {
    const promptText = buildPortraitPrompt(card);
    await writeFile(path.join(promptDir, `${slugify(card.name)}.txt`), `${promptText}\n`, "utf8");
  }

  await writeFile(path.join(promptDir, "portrait-prompts.csv"), renderPromptCsv(cards), "utf8");
}

export async function ensurePortraitReadme(readmePath) {
  const content = [
    "# Portrait Assets",
    "",
    "Drop generated portrait images here using the card slug as the filename.",
    "",
    "Examples:",
    "- lance.png",
    "- lana.png",
    "- dronan.png",
    "",
    "Recommended format: PNG, portrait orientation, at least 900x1200."
  ].join("\n");
  await writeFile(readmePath, content, "utf8");
}

export function parseCsv(source) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      row.push(value);
      value = "";
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      continue;
    }

    value += char;
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  const [header, ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]))
  );
}

export async function normalizeCard(row, portraitDir) {
  const sourceType = detectRowType(row);
  const name = String(row.Name ?? "").trim();
  const factions = sourceType === "playtest" ? getPlaytestFactions(row) : [row["Faction 1"], row["Faction 2"], row["Faction 3"]].filter(Boolean);
  const portraitBase = slugify(name);
  const portraitFile = portraitDir ? await findPortraitFile(portraitDir, portraitBase) : "";
  const portraitDataUri = portraitDir && portraitFile ? await buildPortraitDataUri(path.join(portraitDir, portraitFile)) : "";
  const imageUrl = getSourceImageUrl(row);
  const isMajor = sourceType === "playtest" ? truthyFlag(row.is_Major) || String(row.Keywords ?? "").includes("Major") : false;
  const isChaff = sourceType === "playtest" ? truthyFlag(row.is_Chaff) || String(row.Keywords ?? "").includes("Chaff") : false;
  const arcana = sourceType === "playtest" ? deriveArcana(row, isMajor, isChaff) : String(row.Arcana ?? "").trim();
  const info = sourceType === "playtest"
    ? cleanField(row["Flavour text"])
    : (row.info ?? row[" info"] ?? "").trim();

  return {
    name,
    factions,
    cardType: String(row["Card Type"] ?? "").trim(),
    arcana,
    power: Number.parseInt(row.Power, 10) || 0,
    text: cleanField(row.Text),
    info,
    flavourText: cleanField(row["Flavour text"]),
    primaryFaction: factions[0] ?? "Neutral",
    portraitFile,
    portraitDataUri,
    portraitBase,
    portraitUrl: imageUrl,
    copies: Number.parseInt(row["Total copies"] ?? row["Number copies"] ?? "0", 10) || 0,
    sourceType
  };
}

export async function findPortraitFile(portraitDir, base) {
  for (const ext of ["png", "jpg", "jpeg", "webp", "svg"]) {
    const filename = `${base}.${ext}`;
    try {
      await access(path.join(portraitDir, filename));
      return filename;
    } catch {
      continue;
    }
  }
  return "";
}

export function buildPortraitPrompt(card) {
  const factions = (card.factions.length > 0 ? card.factions : ["Neutral"]).join(", ");
  const subject = card.info || `${card.cardType} aligned with ${factions}`;
  const backdrop = card.flavourText
    ? `subtle environment hint inspired by: ${card.flavourText}`
    : `subtle environment hint matching ${factions}, but keep the character as the focus`;
  return [
    "Use case: illustration-story",
    "Asset type: portrait illustration for a trading card game character",
    `Primary request: create a fantasy portrait of ${card.name}`,
    "Style/medium: painted fantasy illustration, high detail, card-art quality, readable at small size",
    "Composition/framing: vertical portrait, chest-up or waist-up, centered subject, strong silhouette, leave room near edges for card frame crop",
    "Lighting/mood: dramatic but clean key light, rich contrast, heroic tabletop-card presentation",
    "Color palette: faction-driven fantasy palette with clear subject separation from background",
    `Subject: ${subject}`,
    `Scene/backdrop: ${backdrop}`,
    "Constraints: one main subject only, no text, no watermark, no UI, no extra hands, no duplicate faces, no busy background",
    "Avoid: logo marks, borders, captions, collage layout, photoreal uncanny details"
  ].join("\n");
}

export function renderPromptCsv(cards) {
  const header = ["name", "portrait_file", "prompt"];
  const rows = cards.map((card) => [
    card.name,
    `${slugify(card.name)}.png`,
    buildPortraitPrompt(card).replaceAll("\n", " | ")
  ]);
  return [header, ...rows].map((cells) => cells.map(csvEscape).join(",")).join("\n") + "\n";
}

export function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function iconSvg(name, accent, paper, outerPath, innerPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <circle cx="60" cy="60" r="56" fill="${paper}" />
  <circle cx="60" cy="60" r="54" fill="none" stroke="${accent}" stroke-width="4" />
  <path d="${outerPath}" fill="${accent}" />
  <path d="${innerPath}" fill="none" stroke="${paper}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" />
  <title>${escapeXml(name)}</title>
</svg>`;
}

async function resolveInputPath(rootDir) {
  const explicit = process.env.GAMEGEN_CARDS_CSV;
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(rootDir, explicit);
  }

  const preferred = path.join(rootDir, "data", "Playtestrr with precons - Cards Dataset.csv");
  try {
    await access(preferred);
    return preferred;
  } catch {
    return path.join(rootDir, "data", "cards.csv");
  }
}

function detectRowType(row) {
  return Object.hasOwn(row, "PnC") ? "playtest" : "simple";
}

function getPlaytestFactions(row) {
  const factionColumns = [
    "PnC",
    "Thieves",
    "Septarchy",
    "Medicarium",
    "Adams team",
    "Meatfists",
    "Abaddon",
    "Goblins!",
    "Team Dragon"
  ];

  return factionColumns
    .filter((key) => truthyFlag(row[key]))
    .map((key) => normalizeFactionName(key));
}

function normalizeFactionName(name) {
  const map = {
    PnC: "Adventurer",
    "Goblins!": "Goblins",
    "Adams team": "Adams Team"
  };
  return map[name] ?? name;
}

function truthyFlag(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "show" || normalized === "true" || normalized === "yes" || normalized === "1";
}

function deriveArcana(row, isMajor, isChaff) {
  if (isMajor) return "Major";
  if (isChaff) return "Chaff";
  return cleanField(row.Keywords);
}

function getSourceImageUrl(row) {
  const candidateKeys = Object.keys(row).filter((key) => key.trim().toUpperCase() === "NEW IMAGE LINKS");
  for (const key of candidateKeys) {
    const value = cleanField(row[key]);
    if (value) return value;
  }
  return "";
}

function cleanField(value) {
  return String(value ?? "")
    .trim()
    .replaceAll('""', '"');
}

async function buildPortraitDataUri(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml"
  }[extension];

  if (!mimeType) {
    return "";
  }

  const file = await readFile(filePath);
  return `data:${mimeType};base64,${file.toString("base64")}`;
}
