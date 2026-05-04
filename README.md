# Yupoo → WooCommerce Importer

Scrape any Yupoo album, review and edit product details, then import directly into WooCommerce as a draft product — with all images re-hosted on UploadThing CDN so they never break.

## How it works

1. Paste a Yupoo album URL → Puppeteer scrapes it (handles lazy-loading + pagination)
2. Review scraped images, edit product name / description / category / sizes
3. Click Import → images are uploaded to UploadThing CDN → WooCommerce draft created
4. Go to WordPress, set price, publish ✅

---

## Setup (5 minutes)

### 1. UploadThing
- Go to [uploadthing.com](https://uploadthing.com) → create a free account → New App
- Copy your **Token** from API Keys tab

### 2. WooCommerce API Keys
- In WordPress: **WooCommerce → Settings → Advanced → REST API → Add Key**
- Description: `Yupoo Importer`
- User: your admin user
- Permissions: **Read/Write**
- Click **Generate API Key** → copy **Consumer Key** and **Consumer Secret**

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in:

```bash
cp .env.example .env.local
```

```env
UPLOADTHING_TOKEN=your_token
WC_URL=https://yourstore.com
WC_CONSUMER_KEY=ck_...
WC_CONSUMER_SECRET=cs_...
```

---

## Running locally

```bash
npm install
npm run dev
# Open http://localhost:3000
```

---

## Deploy to Render (free tier)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service → Connect repo
3. Render auto-detects the `Dockerfile`
4. Add environment variables in Render dashboard (Settings → Environment)
5. Deploy

> ⚠️ Render free tier spins down after inactivity. First request after sleep may take ~30s.

---

## Deploy to your VPS

```bash
# Build image
docker build -t yupoo-importer .

# Run with env vars
docker run -d \
  -p 3000:3000 \
  -e UPLOADTHING_TOKEN=... \
  -e WC_URL=https://yourstore.com \
  -e WC_CONSUMER_KEY=ck_... \
  -e WC_CONSUMER_SECRET=cs_... \
  --name yupoo-importer \
  yupoo-importer
```

Then point Nginx to port 3000.

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
- ✅ Referer-blocked images (UploadThing fetches server-side with correct headers)
- ✅ Failed image uploads (skipped with warning, rest continue)
- ✅ WooCommerce category creation (creates missing categories automatically)
- ✅ 3-level category hierarchy
- ✅ Sneaker sizes (numeric range e.g. 36-46) and T-shirt sizes (XS-XXXL)
- ✅ Product created as draft so you set price before publishing
- ✅ Yupoo album metadata stored in product meta fields
- ✅ Image upload batching to avoid timeouts
- ✅ Streaming progress log so you see every step in real time

---

## Notes

- Products import as **Simple** type (draft). Add variations manually in WooCommerce after import.
- UploadThing free tier: 2GB storage. Plenty for testing.
- If Yupoo blocks scraping, wait 1-2 minutes and retry (they rate-limit by IP/session).
