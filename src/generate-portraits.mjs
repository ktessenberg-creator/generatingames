import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPortraitPrompt,
  ensurePortraitReadme,
  loadCards,
  slugify,
  writePromptArtifacts
} from "./lib/cards.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const rootDir = process.cwd();
  const portraitDir = path.join(rootDir, "assets", "portraits");
  const manifestDir = path.join(rootDir, "output", "portraits");

  await mkdir(portraitDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  await ensurePortraitReadme(path.join(portraitDir, "README.md"));

  const cards = await loadCards(rootDir);
  const selectedCards = filterCards(cards, options);

  if (selectedCards.length === 0) {
    throw new Error("No cards matched the current portrait generation filters.");
  }

  await writePromptArtifacts(rootDir, cards);

  const provider = createProvider(options);
  const manifest = [];

  for (const card of selectedCards) {
    const outputExtension = provider.outputExtension || "png";
    const outputFile = `${slugify(card.name)}.${outputExtension}`;
    const prompt = buildPortraitPrompt(card);
    const outputPath = path.join(portraitDir, outputFile);
    const summary = {
      name: card.name,
      prompt,
      outputFile,
      provider: provider.name
    };

    if (options.dryRun) {
      manifest.push({ ...summary, status: "planned" });
      continue;
    }

    const image = await provider.generate({ card, prompt });
    await writeFile(outputPath, image);
    manifest.push({ ...summary, status: "generated" });
    console.log(`Generated portrait for ${card.name} -> ${outputPath}`);
  }

  await writeFile(
    path.join(manifestDir, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        provider: provider.name,
        dryRun: options.dryRun,
        count: manifest.length,
        entries: manifest
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(
    options.dryRun
      ? `Planned ${manifest.length} portraits. See output/portraits/manifest.json`
      : `Generated ${manifest.length} portraits. Re-run npm run generate:cards to embed them.`
  );
}

function parseArgs(argv) {
  const options = {
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    names: [],
    limit: Number.POSITIVE_INFINITY,
    provider: process.env.LOCAL_IMAGE_PROVIDER || "automatic1111",
    baseUrl: process.env.LOCAL_IMAGE_BASE_URL || "http://127.0.0.1:7860",
    negativePrompt:
      process.env.LOCAL_IMAGE_NEGATIVE_PROMPT ||
      "text, watermark, logo, frame, border, duplicate person, extra limbs, extra fingers, blurry face, cropped head, low detail, deformed hands, collage",
    steps: readNumberEnv("LOCAL_IMAGE_STEPS", 28),
    width: readNumberEnv("LOCAL_IMAGE_WIDTH", 896),
    height: readNumberEnv("LOCAL_IMAGE_HEIGHT", 1344),
    cfgScale: readNumberEnv("LOCAL_IMAGE_CFG_SCALE", 7),
    sampler: process.env.LOCAL_IMAGE_SAMPLER || "DPM++ 2M Karras",
    modelHint: process.env.LOCAL_IMAGE_MODEL_HINT || ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--names") {
      options.names = (argv[index + 1] || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      index += 1;
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(argv[index + 1], 10) || options.limit;
      index += 1;
    } else if (arg === "--provider") {
      options.provider = argv[index + 1] || options.provider;
      index += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = argv[index + 1] || options.baseUrl;
      index += 1;
    }
  }

  return options;
}

function filterCards(cards, options) {
  let filtered = cards;

  if (options.names.length > 0) {
    const requested = new Set(options.names.map((name) => name.toLowerCase()));
    filtered = filtered.filter((card) => requested.has(card.name.toLowerCase()) || requested.has(slugify(card.name)));
  }

  if (!options.force) {
    filtered = filtered.filter((card) => !card.portraitFile);
  }

  return filtered.slice(0, options.limit);
}

function createProvider(options) {
  if (options.provider === "automatic1111") {
    return {
      name: "automatic1111",
      outputExtension: "png",
      async generate({ prompt }) {
        const response = await fetch(`${options.baseUrl}/sdapi/v1/txt2img`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompt,
            negative_prompt: options.negativePrompt,
            steps: options.steps,
            width: options.width,
            height: options.height,
            cfg_scale: options.cfgScale,
            sampler_name: options.sampler
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Automatic1111 request failed (${response.status}): ${errorText}`);
        }

        const payload = await response.json();
        const image = payload.images?.[0];
        if (!image) {
          throw new Error("Automatic1111 response did not include an image.");
        }
        return Buffer.from(image, "base64");
      }
    };
  }

  if (options.provider === "mock") {
    return {
      name: "mock",
      outputExtension: "svg",
      async generate({ card, prompt }) {
        const svg = renderMockPortraitSvg(card.name, prompt, options.modelHint);
        return Buffer.from(svg, "utf8");
      }
    };
  }

  throw new Error(`Unsupported provider "${options.provider}". Supported providers: automatic1111, mock`);
}

function renderMockPortraitSvg(name, prompt, modelHint) {
  const lines = prompt
    .replaceAll("\n", " ")
    .match(/.{1,70}(\s|$)/g)
    ?.slice(0, 8)
    .map((line) => line.trim()) ?? [];

  const textLines = lines
    .map((line, index) => `<text x="60" y="${430 + index * 34}" font-family="Arial, sans-serif" font-size="24" fill="#f6e7c6">${escape(line)}</text>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="896" height="1344" viewBox="0 0 896 1344">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#533826" />
      <stop offset="100%" stop-color="#1c1210" />
    </linearGradient>
  </defs>
  <rect width="896" height="1344" fill="url(#bg)" />
  <circle cx="448" cy="300" r="130" fill="#e5c48f" fill-opacity="0.16" />
  <path d="M260 600 C320 450, 576 450, 636 600 L636 760 L260 760 Z" fill="#e5c48f" fill-opacity="0.12" />
  <text x="60" y="90" font-family="Georgia, serif" font-size="64" fill="#fff4d9">${escape(name)}</text>
  <text x="60" y="145" font-family="Arial, sans-serif" font-size="26" fill="#d7c3a3">Mock portrait output${modelHint ? ` • ${escape(modelHint)}` : ""}</text>
  ${textLines}
</svg>`;
}

function readNumberEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function escape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
