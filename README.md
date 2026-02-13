# Anglo Calendar

Static ACNA Book of Common Prayer 2019 Daily Office calendar generator.

## What this builds

- `data/calendar.json`: precomputed local cache of daily liturgical data and readings
- `public/acna-bcp2019.ics`: subscribe-able ICS feed (RFC 5545)
- `public/day/YYYY-MM-DD/index.html`: static day pages
- `public/index.html`: landing page with Google subscribe link and raw ICS URL

## Requirements

- Node.js 18+ (tested on Node 22)

## Build

```bash
npm run build-calendar
```

## Configuration

Environment variables or CLI flags:

- `START_YEAR` / `--start-year` (default: current UTC year)
- `YEARS` / `--years` (default: `20`)
- `SITE_URL` / `--site-url` (default: `https://example.com`)
- `UID_DOMAIN` / `--uid-domain` (default: `example.com`)
- `PSALM_CYCLE` / `--psalm-cycle` (`30` or `60`, default: `30`)
- `CONCURRENCY` / `--concurrency` (default: `6`)
- `REFRESH=1` / `--refresh` forces refetch for all days

Examples:

```bash
START_YEAR=2026 YEARS=20 SITE_URL=https://anglocalendar.example npm run build-calendar
```

```bash
npm run build-calendar -- --start-year 2026 --years 20 --site-url https://anglocalendar.example
```

## Deploy

Deploy the `public/` folder to Netlify, Cloudflare Pages, or GitHub Pages.

Important: set `SITE_URL` during build to your final public domain so calendar event URLs and Google subscribe links are correct.
