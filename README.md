# GameGen

Generate card assets from structured card data.

## Current workflow

1. Put card data in `data/cards.csv`.
2. Generate portrait prompts and card SVGs:
   - `npm run generate:cards`
3. Generate portraits into `assets/portraits`:
   - `npm run generate:portraits -- --dry-run`
   - `npm run generate:portraits`
4. Rebuild cards so the portraits appear inside the card frames:
   - `npm run generate:cards`

## Local portrait generation

The built-in portrait generator is designed for a local image server running on the same machine, which keeps costs near zero once the model is installed.

### Supported providers

- `automatic1111`
  Calls the Stable Diffusion WebUI API at `/sdapi/v1/txt2img`.
- `mock`
  Writes placeholder portrait files so you can test the pipeline without a model running.

### Environment variables

- `LOCAL_IMAGE_PROVIDER`
  Default: `automatic1111`
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
- Generate only a few cards:
  `npm run generate:portraits -- --names "Lance,Lana,Twist"`
- Dry run without calling a model:
  `npm run generate:portraits -- --dry-run`
- Force-regenerate even if files already exist:
  `npm run generate:portraits -- --force`

### Typical laptop setup

If the Lenovo is running Automatic1111 locally:

```bash
export LOCAL_IMAGE_PROVIDER=automatic1111
export LOCAL_IMAGE_BASE_URL=http://127.0.0.1:7860
npm run generate:portraits -- --limit 20
npm run generate:cards
```

If you just want to test the pipeline before the model is working:

```bash
export LOCAL_IMAGE_PROVIDER=mock
npm run generate:portraits -- --force
npm run generate:cards
```
