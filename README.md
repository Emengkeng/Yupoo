# Yupoo → WooCommerce Importer

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

> **Disclaimer:** This tool is provided for personal use only. The author is not responsible for how you use it. You are solely responsible for ensuring your use complies with Yupoo's Terms of Service, applicable copyright law, and the intellectual property rights of any content you import. Do not use this tool to import counterfeit or infringing goods.

Scrape Yupoo albums and import them directly into WooCommerce as draft products — images re-hosted on your WordPress media library, descriptions auto-generated in English (with Chinese title translation), all running as a background queue so you can process hundreds of products overnight.

> 🤖 **Vibecoded** — built entirely through conversational prompting with Claude. No manual coding.

---

## Two modes

| Mode | Route | Best for |
|------|-------|----------|
| **Single importer** | `/` | One product at a time, full manual control over images, sizes, variations |
| **Batch importer** | `/batch` | Paste 400 URLs, walk away, come back to 400 WooCommerce drafts |

---

## How it works

### Single importer (`/`)
1. Paste a Yupoo album URL → Puppeteer scrapes it (handles lazy-loading + pagination)
2. Review scraped images, edit product name / description / category / sizes / variations
3. Click Import → images uploaded directly to WordPress media → WooCommerce draft created
4. Go to WordPress, set price, publish ✅

### Batch importer (`/batch`)
1. Paste URLs one per line (with optional name, category, price — see format below)
2. Click Queue → jobs enter a BullMQ queue backed by Redis
3. Scrape workers (10 concurrent) and import workers (15 concurrent) run in the background
4. Product names are translated from Chinese if needed, descriptions auto-generated via Grok
5. All products land in WooCommerce as drafts — bulk review and publish from WP admin

---

## Batch input format

Each line is a URL with optional fields separated by `|`:

```
# URL only — name scraped and translated, no category, no price
https://store.x.yupoo.com/albums/123456

# URL + name
https://store.x.yupoo.com/albums/789012 | Boots

# URL + name + category
https://store.x.yupoo.com/albums/345678 | Air Max 90 | Men/Sneakers/Nike

# URL + name + category + price
https://store.x.yupoo.com/albums/901234 | LV Bag | Women/Bags | 120.00

# URL + category + price, no name (leave name blank — gets translated from scraped title)
https://store.x.yupoo.com/albums/111111 |  | Men/Sneakers | 89.99
```

Category follows the same `Parent/Sub/Brand` hierarchy as WooCommerce. Missing categories are created automatically.

---

## Setup

### 1. WooCommerce API Keys
- In WordPress: **WooCommerce → Settings → Advanced → REST API → Add Key**
- Description: `Yupoo Importer`, User: admin, Permissions: **Read/Write**
- Copy **Consumer Key** and **Consumer Secret**

### 2. WordPress Application Password (for media uploads)
- In WordPress: **Users → your admin → Application Passwords**
- Name: `Yupoo Importer` → click **Add New**
- Copy the generated password (spaces included)

### 3. xAI API Key (for batch description generation)
- Go to [console.x.ai](https://console.x.ai) → API Keys → Create key
- Used for Chinese title translation and English description generation
- Only needed for the batch importer

### 4. Environment variables

```bash
cp .env.example .env
# Fill in all values
```

Key variables:

```env
# WooCommerce
WC_URL=https://yourstore.com
WC_CONSUMER_KEY=ck_...
WC_CONSUMER_SECRET=cs_...

# WordPress media uploads
WP_APP_USER=admin
WP_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx

# Redis (for batch queue)
REDIS_URL=redis://localhost:6379

# Database (for batch job state)
DATABASE_URL=postgresql://user:pass@localhost:5432/yupoo_importer

# xAI / Grok (for batch AI generation)
XAI_API_KEY=xai-...

# Tuning
MAX_IMAGES_PER_PRODUCT=4
SCRAPE_CONCURRENCY=10
IMPORT_CONCURRENCY=15
```

---

## Running locally (single importer only)

```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## Running with Docker (full stack, batch included)

Requires Docker and an existing Redis container.

```bash
# Copy and fill in env vars
cp .env.example .env

# Start Postgres + app + worker
docker compose up -d

# Run database migrations (first time only)
npm run migrate

# Open http://localhost:3000
# Batch importer at http://localhost:3000/batch
```

The `docker-compose.yml` spins up:
- **Postgres** — job state, scraped album data, import results
- **Next.js app** — the UI and API routes
- **Worker process** — scrape worker (Puppeteer) + import worker (WP uploads + WC creation)

Your existing Redis container is used as-is via `REDIS_URL`.

---

## Deploy to your VPS

```bash
# Clone and configure
git clone <your-repo>
cd yupoo-importer
cp .env.example .env
# Edit .env with your values

# Build and start
docker compose up -d --build

# Migrate
docker compose exec app npm run migrate
```

Point Nginx to port 3000. Ensure your VPS Redis is reachable from the Docker network (use the VPS LAN IP or `host.docker.internal` in `REDIS_URL`).

---

## Supported URL formats

| Format | Example |
|--------|---------|
| Subdomain | `https://storename.x.yupoo.com/albums/123456` |
| Subdomain + uid | `https://storename.x.yupoo.com/albums/123456?uid=1` |
| Path-based | `https://x.yupoo.com/photos/storename/albums/123456` |

---

## Edge cases handled

- ✅ Lazy-loaded images (Puppeteer scrolls to trigger them)
- ✅ Paginated albums (follows next page up to 20 pages)
- ✅ Both Yupoo URL formats
- ✅ Referer-blocked images (fetched server-side with correct headers)
- ✅ Failed image uploads (skipped with warning, rest continue)
- ✅ WooCommerce category creation (creates missing categories automatically)
- ✅ 3-level category hierarchy (Parent / Sub / Brand)
- ✅ Sneaker sizes (numeric range e.g. 36–46) and T-shirt sizes (XS–XXXL)
- ✅ Chinese product titles (auto-translated via Grok)
- ✅ Missing descriptions (auto-generated from product name + category)
- ✅ Image cap per product (default 4, configurable via `MAX_IMAGES_PER_PRODUCT`)
- ✅ Products created as drafts — set price and publish when ready
- ✅ Yupoo album metadata stored in WC product meta fields
- ✅ Failed batch jobs retryable from the UI
- ✅ Streaming progress log on single importer (every step visible in real time)

---

## Performance (batch mode, 8 vCPU / 32 GB RAM VPS)

| Step | Concurrency | Throughput |
|------|-------------|------------|
| Scraping | 10 parallel browsers | ~40 albums/min |
| Image upload | 5 per product, 15 products parallel | depends on WP server |
| AI enrichment | Per scrape job | ~1–2s per product |

400 products → roughly 10–15 minutes to fully scrape, then import runs in parallel as scrapes complete.

---

## Notes

- Images are uploaded directly to your WordPress media library — no third-party CDN dependency.
- All products import as **draft**. For variable products (colors, sizes), add variations manually in WooCommerce after import, or use the single importer which supports full variation setup.
- If Yupoo blocks scraping, the job retries automatically up to 3 times with exponential backoff.
- Batch job history persists in Postgres — you can restart the worker at any time and in-progress jobs resume.

---

## License

MIT © 2026 — see [LICENSE](./LICENSE) for full text.

This software is provided "as-is" with no warranty. The author accepts no liability for misuse.