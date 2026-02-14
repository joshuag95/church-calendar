import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.dailyoffice2019.com/api/v1/readings/";

const args = parseArgs(process.argv.slice(2));
const now = new Date();

const config = {
  startYear: numberArg(args["start-year"], process.env.START_YEAR, now.getUTCFullYear()),
  years: numberArg(args.years, process.env.YEARS, 20),
  siteUrl: stripTrailingSlash(args["site-url"] || process.env.SITE_URL || "https://example.com"),
  uidDomain: (args["uid-domain"] || process.env.UID_DOMAIN || "example.com").toLowerCase(),
  psalmCycle: String(args["psalm-cycle"] || process.env.PSALM_CYCLE || "30"),
  refresh: Boolean(args.refresh || process.env.REFRESH === "1"),
  concurrency: Math.max(1, numberArg(args.concurrency, process.env.CONCURRENCY, 6)),
};

const root = process.cwd();
const dataDir = path.join(root, "data");
const publicDir = path.join(root, "public");
const dayDir = path.join(publicDir, "day");
const calendarJsonPath = path.join(dataDir, "calendar.json");
const icsPath = path.join(publicDir, "acna-bcp2019.ics");
const buildDate = formatUtcStamp(new Date());

async function main() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(publicDir, { recursive: true });

  const dates = buildDateRange(config.startYear, config.years);
  console.log(`Building ${dates.length} days (${dates[0]} -> ${dates[dates.length - 1]})`);

  const existing = config.refresh ? new Map() : await loadExisting(calendarJsonPath);
  const missing = dates.filter((date) => !existing.has(date));

  if (missing.length > 0) {
    console.log(`Fetching ${missing.length} day(s) from Daily Office API with concurrency=${config.concurrency}...`);
    const fetched = await mapWithConcurrency(missing, config.concurrency, async (date, index) => {
      const day = await fetchAndNormalizeDay(date, config.psalmCycle);
      if ((index + 1) % 200 === 0 || index + 1 === missing.length) {
        console.log(`Fetched ${index + 1}/${missing.length}`);
      }
      return day;
    });
    for (const day of fetched) {
      existing.set(day.date, day);
    }
  } else {
    console.log("No API fetch needed, using local cache.");
  }

  const calendar = dates.map((date) => {
    const item = existing.get(date);
    if (!item) {
      throw new Error(`Missing normalized data for ${date}`);
    }
    return item;
  });

  await fs.writeFile(calendarJsonPath, `${JSON.stringify(calendar, null, 2)}\n`, "utf8");
  console.log(`Wrote ${calendarJsonPath}`);

  const ics = buildIcs(calendar, config.siteUrl, config.uidDomain, buildDate);
  await fs.writeFile(icsPath, ics, "utf8");
  console.log(`Wrote ${icsPath}`);

  await generateDayPages(dayDir, calendar, config.siteUrl);
  await generateLandingPage(path.join(publicDir, "index.html"), config.siteUrl, calendar);
  console.log("Build complete.");
}

async function fetchAndNormalizeDay(date, psalmCycle) {
  const url = `${API_BASE}${date}`;
  const payload = await fetchJsonWithRetry(url, 4);

  const services = payload?.services || {};
  const morning = selectOfficeService(services, "Morning Prayer");
  const evening = selectOfficeService(services, "Evening Prayer");

  if (!morning || !evening) {
    throw new Error(`Missing Morning/Evening Prayer service for ${date}`);
  }

  const calendarDate = payload?.calendarDate || {};

  return {
    date,
    liturgicalName: chooseLiturgicalName(calendarDate, morning),
    season: calendarDate?.season?.name || "",
    majorFeast: calendarDate?.major_feast || null,
    majorOrMinorFeast: calendarDate?.major_or_minor_feast || null,
    morningPrayer: extractOfficeReadings(morning, psalmCycle),
    eveningPrayer: extractOfficeReadings(evening, psalmCycle),
  };
}

function chooseLiturgicalName(calendarDate, morningService) {
  if (calendarDate?.major_or_minor_feast) {
    return cleanSpace(calendarDate.major_or_minor_feast);
  }
  if (calendarDate?.primary_feast) {
    return cleanSpace(calendarDate.primary_feast);
  }
  const commemorationName = calendarDate?.commemorations?.[0]?.name;
  if (commemorationName) {
    return cleanSpace(commemorationName);
  }
  const fromService = stripOfficePrefix(morningService?.name || "");
  if (fromService) {
    return cleanSpace(fromService);
  }
  return "Daily Office";
}

function stripOfficePrefix(serviceName) {
  const match = serviceName.match(/\((.*)\)/);
  if (match?.[1]) {
    return match[1];
  }
  return serviceName.replace(/^Morning Prayer\s*-?\s*/i, "").trim();
}

function selectOfficeService(services, prefix) {
  for (const item of Object.values(services)) {
    if (item?.name?.startsWith(prefix)) {
      return item;
    }
  }
  for (const item of Object.values(services)) {
    if (item?.name?.includes(prefix)) {
      return item;
    }
  }
  return null;
}

function extractOfficeReadings(service, psalmCycle) {
  const readings = Array.isArray(service?.readings) ? service.readings : [];

  const psalmByCycle = readings.find((r) => {
    const full = r?.full || {};
    return full?.name === "The Psalms" && String(full?.cycle || "") === String(psalmCycle);
  });

  const psalmFallback = readings.find((r) => (r?.full || {}).name === "The Psalms");
  const firstLesson = readings.find((r) => (r?.full || {}).name === "The First Lesson");
  const secondLesson = readings.find((r) => (r?.full || {}).name === "The Second Lesson");

  return {
    serviceName: service?.name || "",
    psalms: citationOf(psalmByCycle || psalmFallback),
    ot: citationOf(firstLesson),
    nt: citationOf(secondLesson),
  };
}

function citationOf(readingEntry) {
  const full = readingEntry?.full;
  const abbreviated = readingEntry?.abbreviated;
  const citation = full?.citation || abbreviated?.citation || "";
  return cleanSpace(citation);
}

async function fetchJsonWithRetry(url, retries) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "accept": "application/json" } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
      const delayMs = 250 * (attempt + 1) * (attempt + 1);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function buildIcs(calendar, siteUrl, uidDomain, dtStamp) {
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Anglo Calendar//ACNA BCP 2019 Daily Office//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:ACNA BCP 2019 Daily Office",
    "X-WR-TIMEZONE:UTC",
  ];

  for (const day of calendar) {
    const ymd = day.date.replaceAll("-", "");
    const nextYmd = toYmd(addDays(day.date, 1));
    const eventUrl = `${siteUrl}/day/${day.date}/`;

    const summary = `${day.liturgicalName} - Daily Office`;
    const description = [
      "Morning Prayer:",
      `Psalms: ${day.morningPrayer.psalms || "N/A"}`,
      `OT: ${day.morningPrayer.ot || "N/A"}`,
      `NT: ${day.morningPrayer.nt || "N/A"}`,
      "",
      "Evening Prayer:",
      `Psalms: ${day.eveningPrayer.psalms || "N/A"}`,
      `OT: ${day.eveningPrayer.ot || "N/A"}`,
      `NT: ${day.eveningPrayer.nt || "N/A"}`,
    ].join("\n");

    lines.push("BEGIN:VEVENT");
    lines.push(...foldIcsLine(`UID:acna-bcp2019-${ymd}@${uidDomain}`));
    lines.push(...foldIcsLine(`DTSTAMP:${dtStamp}`));
    lines.push(...foldIcsLine(`DTSTART;VALUE=DATE:${ymd}`));
    lines.push(...foldIcsLine(`DTEND;VALUE=DATE:${nextYmd}`));
    lines.push(...foldIcsLine(`SUMMARY:${escapeIcsText(summary)}`));
    lines.push(...foldIcsLine(`DESCRIPTION:${escapeIcsText(description)}`));
    lines.push(...foldIcsLine(`URL:${escapeIcsText(eventUrl)}`));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function foldIcsLine(line) {
  const max = 75;
  if (line.length <= max) {
    return [line];
  }

  const chunks = [];
  let remaining = line;
  while (remaining.length > max) {
    chunks.push(remaining.slice(0, max));
    remaining = remaining.slice(max);
  }
  chunks.push(remaining);

  return chunks.map((chunk, idx) => (idx === 0 ? chunk : ` ${chunk}`));
}

function escapeIcsText(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r\n|\r|\n/g, "\\n");
}

async function generateDayPages(baseDir, calendar, siteUrl) {
  await fs.rm(baseDir, { recursive: true, force: true });

  for (const day of calendar) {
    const dir = path.join(baseDir, day.date);
    await fs.mkdir(dir, { recursive: true });
    const html = renderDayPage(day, siteUrl);
    await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  }

  console.log(`Wrote ${calendar.length} day pages under ${baseDir}`);
}

async function generateLandingPage(filePath, siteUrl, calendar) {
  const first = calendar[0]?.date || "";
  const last = calendar[calendar.length - 1]?.date || "";
  const icsUrl = `${siteUrl}/acna-bcp2019.ics`;
  const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(icsUrl)}`;
  const exampleDayUrl = `${siteUrl}/day/${first}/`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ACNA BCP 2019 Daily Office Calendar</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --card: #ffffff;
      --ink: #1f2a21;
      --muted: #546356;
      --brand: #1f6d4b;
      --brand-dark: #165239;
      --line: #d7ddd6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Georgia", "Times New Roman", serif;
      color: var(--ink);
      background: radial-gradient(circle at top right, #ebefe8 0%, var(--bg) 45%);
      line-height: 1.55;
    }
    .wrap {
      max-width: 940px;
      margin: 0 auto;
      padding: 2rem 1rem 3rem;
    }
    .hero {
      background: linear-gradient(135deg, #20412f 0%, #1f6d4b 55%, #5f8f78 100%);
      color: #f2f8f3;
      border-radius: 14px;
      padding: 1.6rem;
      box-shadow: 0 12px 30px rgba(17, 32, 23, 0.16);
    }
    .hero h1 { margin: 0 0 0.55rem; font-size: 2rem; line-height: 1.2; }
    .hero p { margin: 0.3rem 0; color: #e8f3eb; }
    .hero .coverage { margin-top: 0.8rem; font-size: 0.98rem; color: #d8eadf; }
    .cta-row {
      margin-top: 1rem;
      display: flex;
      gap: 0.65rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .button {
      display: inline-block;
      background: #fff;
      color: var(--brand-dark);
      text-decoration: none;
      padding: 0.7rem 1rem;
      border-radius: 8px;
      font-weight: 700;
      border: 1px solid rgba(255, 255, 255, 0.75);
    }
    .button:hover { background: #f2faf5; }
    .button.secondary {
      background: transparent;
      color: #f2f8f3;
      border: 1px solid rgba(242, 248, 243, 0.7);
    }
    .grid {
      margin-top: 1rem;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 0.9rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 1rem;
    }
    h2 { margin: 0 0 0.55rem; font-size: 1.12rem; }
    p { margin: 0.35rem 0; }
    ul { margin: 0.45rem 0 0.2rem 1.05rem; padding: 0; }
    li { margin: 0.3rem 0; }
    code {
      display: block;
      margin-top: 0.45rem;
      background: #f2f5f1;
      border: 1px solid #dde5dd;
      border-radius: 7px;
      padding: 0.55rem;
      overflow-wrap: anywhere;
      font-family: Consolas, "Courier New", monospace;
      font-size: 0.9rem;
    }
    .muted { color: var(--muted); }
    .tips {
      margin-top: 0.9rem;
      background: #eef4ef;
      border-left: 4px solid var(--brand);
      border-radius: 8px;
      padding: 0.85rem;
    }
    .links {
      margin-top: 0.95rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.8rem;
      font-size: 0.95rem;
    }
    .links a {
      color: #0f5b3c;
      text-decoration-thickness: 1px;
      text-underline-offset: 2px;
    }
    @media (max-width: 600px) {
      .hero h1 { font-size: 1.7rem; }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <h1>ACNA BCP 2019 Daily Office Calendar</h1>
      <p>A subscribe-able calendar feed for the Anglican Church in North America's Book of Common Prayer 2019.</p>
      <p>Each day includes the liturgical day name plus Morning Prayer and Evening Prayer readings.</p>
      <p class="coverage">Coverage: <strong>${escapeHtml(first)}</strong> through <strong>${escapeHtml(last)}</strong></p>
      <div class="cta-row">
        <a class="button" href="${escapeHtml(googleUrl)}">Add to Google Calendar</a>
        <a class="button secondary" href="${escapeHtml(icsUrl)}">Open ICS Feed</a>
      </div>
    </section>

    <section class="grid">
      <article class="card">
        <h2>What This Calendar Is</h2>
        <p>One all-day event for every date in the generated range. Each event contains:</p>
        <ul>
          <li>Liturgical day name</li>
          <li>Morning Prayer Psalms, OT, NT</li>
          <li>Evening Prayer Psalms, OT, NT</li>
        </ul>
        <p class="muted">This is a read-only reference calendar designed for prayer planning and quick daily lookup.</p>
      </article>

      <article class="card">
        <h2>How To Subscribe</h2>
        <p><strong>Google Calendar:</strong> use the button above.</p>
        <p><strong>Apple Calendar / Outlook:</strong> subscribe by URL using:</p>
        <code>${escapeHtml(icsUrl)}</code>
        <p class="muted">Subscription means updates are delivered automatically when this site is rebuilt.</p>
      </article>

      <article class="card">
        <h2>How To Use It</h2>
        <ul>
          <li>Open today in your calendar app.</li>
          <li>Read the event description for Daily Office references.</li>
          <li>Tap the event URL to view a clean day page in browser.</li>
        </ul>
        <p class="muted">Example day page:</p>
        <p><a href="${escapeHtml(exampleDayUrl)}">${escapeHtml(exampleDayUrl)}</a></p>
      </article>

      <article class="card">
        <h2>About ACNA &amp; the BCP 2019</h2>
        <p>The readings and liturgical names are generated to support use of the ACNA Book of Common Prayer 2019 Daily Office tradition.</p>
        <div class="links">
          <a href="https://anglicanchurch.net/" target="_blank" rel="noopener">ACNA Official Website</a>
          <a href="https://bcp2019.anglicanchurch.net/" target="_blank" rel="noopener">BCP 2019 Online</a>
        </div>
      </article>
    </section>

    <section class="tips">
      <p><strong>Tip:</strong> this feed is read-only and updates when the site is rebuilt and redeployed.</p>
    </section>
  </main>
</body>
</html>
`;

  await fs.writeFile(filePath, html, "utf8");
  console.log(`Wrote ${filePath}`);
}

function renderDayPage(day, siteUrl) {
  const pageUrl = `${siteUrl}/day/${day.date}/`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(day.liturgicalName)} - ${escapeHtml(day.date)}</title>
  <style>
    body { font-family: Georgia, serif; margin: 2rem auto; max-width: 760px; padding: 0 1rem; line-height: 1.5; color: #1f2937; }
    h1 { margin-bottom: 0.5rem; }
    h2 { margin-top: 1.6rem; }
    .muted { color: #4b5563; }
    .block { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 1rem; margin-top: 1rem; }
  </style>
</head>
<body>
  <p><a href="/">Home</a></p>
  <h1>${escapeHtml(day.liturgicalName)}</h1>
  <p class="muted">${escapeHtml(day.date)}${day.season ? ` | ${escapeHtml(day.season)}` : ""}</p>

  <div class="block">
    <h2>Morning Prayer</h2>
    <p><strong>Psalms:</strong> ${escapeHtml(day.morningPrayer.psalms || "N/A")}</p>
    <p><strong>OT:</strong> ${escapeHtml(day.morningPrayer.ot || "N/A")}</p>
    <p><strong>NT:</strong> ${escapeHtml(day.morningPrayer.nt || "N/A")}</p>
  </div>

  <div class="block">
    <h2>Evening Prayer</h2>
    <p><strong>Psalms:</strong> ${escapeHtml(day.eveningPrayer.psalms || "N/A")}</p>
    <p><strong>OT:</strong> ${escapeHtml(day.eveningPrayer.ot || "N/A")}</p>
    <p><strong>NT:</strong> ${escapeHtml(day.eveningPrayer.nt || "N/A")}</p>
  </div>

  <p class="muted">Source URL: <a href="${escapeHtml(pageUrl)}">${escapeHtml(pageUrl)}</a></p>
</body>
</html>
`;
}

async function loadExisting(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const map = new Map();
    for (const item of parsed) {
      if (item?.date) {
        map.set(item.date, item);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function buildDateRange(startYear, years) {
  const dates = [];
  const start = new Date(Date.UTC(startYear, 0, 1));
  const end = new Date(Date.UTC(startYear + years, 0, 1));

  for (let d = start; d < end; d = addDays(d, 1, true)) {
    dates.push(toIsoDate(d));
  }

  return dates;
}

function addDays(input, days, inputIsDate = false) {
  const date = inputIsDate ? new Date(input.getTime()) : new Date(`${input}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function toIsoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function toYmd(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function formatUtcStamp(date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}${String(date.getUTCMinutes()).padStart(2, "0")}${String(date.getUTCSeconds()).padStart(2, "0")}Z`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => run());
  await Promise.all(workers);
  return results;
}

function parseArgs(argv) {
  const out = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const withoutPrefix = token.slice(2);
    const eq = withoutPrefix.indexOf("=");

    if (eq >= 0) {
      const key = withoutPrefix.slice(0, eq);
      const value = withoutPrefix.slice(eq + 1);
      out[key] = value;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[withoutPrefix] = true;
      continue;
    }

    out[withoutPrefix] = next;
    i += 1;
  }

  return out;
}

function numberArg(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error(`Expected numeric value, got: ${values.join(", ")}`);
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function cleanSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
