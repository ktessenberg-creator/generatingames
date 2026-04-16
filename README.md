# GameGen

Generate card assets from structured card data.

## Local game prototype

This repo now includes a lightweight local browser prototype for deck selection and a basic shared board state.

### What it does

- Builds one deck per faction from the playtest dataset
- Each deck contains 2 copies of every card in that faction
- Lets two players join the same game
- Each player chooses a faction deck
- Each player draws 5 cards when the game starts
- You can see:
  - your own hand
  - your own board
  - your opponent's board
  - only the number of cards in your opponent's hand
- You can play cards from your hand onto your board

### Run it

```bash
npm run generate:cards
npm run generate:decks
npm run start
```

Then open [http://localhost:3000](http://localhost:3000).

Create a game in one tab, then use the invite link in another tab or browser for player two.

## Current workflow

1. Put card data in a CSV.
   By default, GameGen now prefers `data/Playtestrr with precons - Cards Dataset.csv` when it exists, and falls back to `data/cards.csv`.
   You can override the input path with `GAMEGEN_CARDS_CSV`.
2. Generate portrait prompts and card SVGs:
   - `npm run generate:cards`
3. Import portraits into `assets/portraits`:
   - `npm run generate:portraits -- --dry-run`
   - `npm run generate:portraits`
4. Rebuild cards so the portraits appear inside the card frames:
   - `npm run generate:cards`

## Local portrait generation

The portrait pipeline now supports importing images directly from the active dataset, or generating them from a local image server.

### Supported providers

- `automatic1111`
  Calls the Stable Diffusion WebUI API at `/sdapi/v1/txt2img`.
- `dataset`
  Downloads the image URL already present in the active CSV row and saves it into `assets/portraits`.
- `mock`
  Writes placeholder portrait files so you can test the pipeline without a model running.

### Environment variables

- `LOCAL_IMAGE_PROVIDER`
  Default: `dataset`
- `LOCAL_IMAGE_BASE_URL`
  Default: `http://127.0.0.1:7860`
- `LOCAL_IMAGE_WIDTH`
  Default: `896`
- `LOCAL_IMAGE_HEIGHT`
  Default: `1344`
- `LOCAL_IMAGE_STEPS`
  Default: `28`
- `LOCAL_IMAGE_CFG_SCALE`
  Default: `7`
- `LOCAL_IMAGE_SAMPLER`
  Default: `DPM++ 2M Karras`
- `LOCAL_IMAGE_NEGATIVE_PROMPT`
  Optional override for the default negative prompt.

### Useful commands

- Generate all missing portraits:
  `npm run generate:portraits`
- Generate faction decklists:
  `npm run generate:decks`
- Generate only a few cards:
  `npm run generate:portraits -- --names "Lance,Lana,Twist"`
- Dry run without calling a model:
  `npm run generate:portraits -- --dry-run`
- Force-regenerate even if files already exist:
  `npm run generate:portraits -- --force`

### Typical laptop setup

If the active dataset already includes image URLs:

```bash
npm run generate:portraits -- --force
npm run generate:cards
```

If the Lenovo is running Automatic1111 locally:

```bash
export LOCAL_IMAGE_PROVIDER=automatic1111
export LOCAL_IMAGE_BASE_URL=http://127.0.0.1:7860
npm run generate:portraits -- --limit 20
npm run generate:cards
```

### Dataset files

To use a different dataset file:

```bash
export GAMEGEN_CARDS_CSV="data/Playtestrr with precons - Cards Dataset.csv"
npm run generate:cards
```

If the dataset includes image URLs, `npm run generate:portraits` downloads them locally and removes older sibling portrait files for the same card.

If you just want to test the pipeline before the model is working:

```bash
export LOCAL_IMAGE_PROVIDER=mock
npm run generate:portraits -- --force
npm run generate:cards
```
