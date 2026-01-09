/**
 * Cloudflare Worker (Hono.js) — Pathgriho internal ads
 * - Config stored in public GitHub JSON (owners + ads)
 * - 2 positions: top + bottom
 * - Fairness: 50/50 share of TOP exposure per device (mobile/desktop), tracked in KV
 * - Bottom automatically gets the other owner
 * - Multiple ads per owner, weighted rotation
 * - Mobile/desktop creatives
 * - Click tracking + redirect via /c/:adId
 *
 * Deploy:
 * 1) `npm i hono`
 * 2) Wrangler bindings: KV + env vars (see bottom)
 */

import { Hono } from "hono";

type OwnerId = "cozy" | "fancy" | string;

type Owner = {
  id: OwnerId;
  name: string;
};

type Ad = {
  id: string;
  ownerId: OwnerId;
  title: string;
  targetUrl: string;
  image: { desktop: string; mobile: string };
  status: "active" | "inactive";
  weight?: number; // default 1
  tags?: string[]; // optional, match against blogger labels
};

type AdsConfig = {
  owners: Owner[];
  ads: Ad[];
};

type Env = {
  KV: KVNamespace;

  // Public raw GitHub URL to config.json (contains owners + ads)
  CONFIG_URL: string;

  // Only allow your Blogger origin (recommended): https://www.pathgriho.com
  ALLOWED_ORIGIN: string;

  // Random secret string for click tokens
  CLICK_TOKEN_SECRET: string;

  // KV cache TTL for config in seconds (e.g., 900)
  CONFIG_CACHE_TTL_SECONDS: string;

  // Counter key TTL in seconds (e.g., 60*60*24*40)
  COUNTER_TTL_SECONDS: string;

  // Use "Asia/Dhaka" for date bucketing (recommended)
  DATE_TIMEZONE: string; // "Asia/Dhaka"
};

const app = new Hono<{ Bindings: Env }>();

/* ----------------------------- Utilities ----------------------------- */

function setCorsHeaders(c: any) {
  const origin = c.env.ALLOWED_ORIGIN;
  c.res.headers.set("Access-Control-Allow-Origin", origin);
  c.res.headers.set("Vary", "Origin");
  c.res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
}

function isMobile(req: Request): boolean {
  const ch = req.headers.get("Sec-CH-UA-Mobile");
  if (ch) return ch.includes("?1");
  const ua = req.headers.get("User-Agent") || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function weightedRandom<T extends { weight?: number }>(items: T[]): T {
  const weights = items.map((x) => Math.max(1, x.weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function normalizeLabels(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Date bucket in Asia/Dhaka (or env timezone)
function dayBucket(tz: string): string {
  // Using Intl for timezone formatting
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

async function kvGetInt(kv: KVNamespace, key: string): Promise<number> {
  const v = await kv.get(key);
  return v ? parseInt(v, 10) || 0 : 0;
}

// Non-atomic increment (acceptable for your traffic)
async function kvIncr(
  kv: KVNamespace,
  key: string,
  by: number,
  ttlSeconds: number
): Promise<number> {
  const cur = await kvGetInt(kv, key);
  const next = cur + by;
  await kv.put(key, String(next), { expirationTtl: ttlSeconds });
  return next;
}

// Minimal HMAC token
async function signToken(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return b64;
}

async function verifyToken(secret: string, payload: string, token: string) {
  const expected = await signToken(secret, payload);
  return expected === token;
}

// Config caching in KV
async function getConfig(c: any): Promise<AdsConfig> {
  const cacheKey = "cfg:config";
  const ttl = parseInt(c.env.CONFIG_CACHE_TTL_SECONDS || "900", 10);

  const cached = await c.env.KV.get(cacheKey);
  if (cached) return JSON.parse(cached) as AdsConfig;

  const res = await fetch(c.env.CONFIG_URL, {
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Config fetch failed: ${c.env.CONFIG_URL}`);

  const text = await res.text();
  await c.env.KV.put(cacheKey, text, { expirationTtl: ttl });
  return JSON.parse(text) as AdsConfig;
}

// Simple tag match: if any ad tag matches any label
function filterByLabels(ads: Ad[], labels: string[]): Ad[] {
  if (!labels.length) return ads;
  const labelSet = new Set(labels);
  const matched = ads.filter((a) =>
    (a.tags || []).some((t) => labelSet.has(String(t).toLowerCase()))
  );
  return matched.length ? matched : ads; // fallback if no matches
}

/* ----------------------------- Middleware ----------------------------- */

app.use("*", async (c, next) => {
  setCorsHeaders(c);
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

/* ----------------------------- Routes ----------------------------- */

/**
 * GET /v1/ads?labels=home,decor
 * Returns BOTH top and bottom ads in one response (recommended).
 *
 * Fairness: decides who gets TOP based on KV counters (per day + device)
 * Bottom gets the other owner.
 */
app.get("/v1/ads", async (c) => {
  const device = isMobile(c.req.raw) ? "mobile" : "desktop";
  const labels = normalizeLabels(c.req.query("labels"));
  const tz = c.env.DATE_TIMEZONE || "Asia/Dhaka";
  const day = dayBucket(tz);

  const counterTtl = parseInt(c.env.COUNTER_TTL_SECONDS || "3456000", 10); // ~40 days
  const baseTopKey = `imp:${day}:top:${device}`; // + :ownerId

  const config = await getConfig(c);
  const owners = config.owners;
  if (owners.length < 2) return c.json({ error: "Need 2 owners in config" }, 500);

  // For your scenario: you and Rabiul. If more owners in future, you can expand logic.
  const ownerA = owners[0];
  const ownerB = owners[1];

  const topCountA = await kvGetInt(c.env.KV, `${baseTopKey}:${ownerA.id}`);
  const topCountB = await kvGetInt(c.env.KV, `${baseTopKey}:${ownerB.id}`);

  // Decide who gets TOP (who is behind/equal)
  const topOwner = topCountA <= topCountB ? ownerA : ownerB;
  const bottomOwner = topOwner.id === ownerA.id ? ownerB : ownerA;

  // Eligible ads per owner
  const activeAds = config.ads.filter((a) => a.status === "active");
  let topAds = activeAds.filter((a) => a.ownerId === topOwner.id);
  let bottomAds = activeAds.filter((a) => a.ownerId === bottomOwner.id);

  topAds = filterByLabels(topAds, labels);
  bottomAds = filterByLabels(bottomAds, labels);

  if (!topAds.length || !bottomAds.length) {
    return c.json(
      {
        error: "No eligible ads for one/both owners",
        details: {
          topOwner: topOwner.id,
          bottomOwner: bottomOwner.id,
          topAds: topAds.length,
          bottomAds: bottomAds.length,
        },
      },
      404
    );
  }

  // Select ads (weighted)
  const topAd = weightedRandom(topAds);
  const bottomAd = weightedRandom(bottomAds);

  const origin = new URL(c.req.url).origin;

  // Track TOP impression for fairness
  await kvIncr(c.env.KV, `${baseTopKey}:${topOwner.id}`, 1, counterTtl);

  // Optional: track per-ad impressions
  await kvIncr(c.env.KV, `imp:${day}:ad:${topAd.id}`, 1, counterTtl);
  await kvIncr(c.env.KV, `imp:${day}:ad:${bottomAd.id}`, 1, counterTtl);

  // Click token payload binds to day+device+adId+position
  const payloadTop = `${day}|${device}|top|${topAd.id}`;
  const payloadBottom = `${day}|${device}|bottom|${bottomAd.id}`;

  const tTop = await signToken(c.env.CLICK_TOKEN_SECRET, payloadTop);
  const tBottom = await signToken(c.env.CLICK_TOKEN_SECRET, payloadBottom);

  const topImage = device === "mobile" ? topAd.image.mobile : topAd.image.desktop;
  const bottomImage =
    device === "mobile" ? bottomAd.image.mobile : bottomAd.image.desktop;

  return c.json({
    meta: {
      day,
      device,
      topOwner: topOwner.id,
      bottomOwner: bottomOwner.id,
      topCounts: { [ownerA.id]: topCountA, [ownerB.id]: topCountB },
    },
    top: {
      id: topAd.id,
      ownerId: topAd.ownerId,
      title: topAd.title,
      imageUrl: topImage,
      clickUrl: `${origin}/c/${topAd.id}?t=${tTop}&pos=top&d=${day}&dev=${device}`,
    },
    bottom: {
      id: bottomAd.id,
      ownerId: bottomAd.ownerId,
      title: bottomAd.title,
      imageUrl: bottomImage,
      clickUrl: `${origin}/c/${bottomAd.id}?t=${tBottom}&pos=bottom&d=${day}&dev=${device}`,
    },
  });
});

/**
 * GET /c/:adId?t=...&pos=top|bottom&d=YYYY-MM-DD&dev=mobile|desktop
 * Tracks click + redirects to targetUrl with UTM params
 */
app.get("/c/:adId", async (c) => {
  const adId = c.req.param("adId");
  const t = c.req.query("t") || "";
  const pos = c.req.query("pos") || "unknown";
  const day = c.req.query("d") || "unknown";
  const dev = c.req.query("dev") || "unknown";

  const payload = `${day}|${dev}|${pos}|${adId}`;
  const ok = await verifyToken(c.env.CLICK_TOKEN_SECRET, payload, t);
  if (!ok) return c.text("Invalid token", 403);

  const config = await getConfig(c);
  const ad = config.ads.find((a) => a.id === adId && a.status === "active");
  if (!ad) return c.text("Ad not found", 404);

  const counterTtl = parseInt(c.env.COUNTER_TTL_SECONDS || "3456000", 10);

  // Track click
  await kvIncr(c.env.KV, `clk:${day}:ad:${adId}`, 1, counterTtl);
  await kvIncr(c.env.KV, `clk:${day}:${pos}:${dev}:${ad.ownerId}`, 1, counterTtl);

  const url = new URL(ad.targetUrl);
  url.searchParams.set("utm_source", "pathgriho");
  url.searchParams.set("utm_medium", "internal_ads");
  url.searchParams.set("utm_campaign", adId);
  url.searchParams.set("utm_content", `${pos}_${dev}`);

  return c.redirect(url.toString(), 302);
});

/**
 * Optional debug endpoint (remove in production or protect):
 * GET /v1/stats?day=YYYY-MM-DD
 */
app.get("/v1/stats", async (c) => {
  const day = c.req.query("day") || dayBucket(c.env.DATE_TIMEZONE || "Asia/Dhaka");
  const dev = c.req.query("dev") || "mobile";
  const owners = (await getConfig(c)).owners.slice(0, 2);

  const baseTopKey = `imp:${day}:top:${dev}`;
  const out: any = { day, dev, top: {} };
  for (const o of owners) {
    out.top[o.id] = await kvGetInt(c.env.KV, `${baseTopKey}:${o.id}`);
  }
  return c.json(out);
});

export default app;

/**
 * Wrangler env vars you need:
 * CONFIG_URL = "https://raw.githubusercontent.com/<you>/<repo>/main/config.json"
 * ALLOWED_ORIGIN = "https://www.pathgriho.com"
 * CLICK_TOKEN_SECRET = "<random-long-string>"
 * CONFIG_CACHE_TTL_SECONDS = "900"
 * COUNTER_TTL_SECONDS = "3456000"
 * DATE_TIMEZONE = "Asia/Dhaka"
 *
 * KV binding:
 * KV = <your_kv_namespace>
 */
