import { Hono } from "hono";

type Owner = { id: string; name: string };
type Ad = {
  id: string;
  ownerId: string;
  targetUrl: string;
  image: { desktop: string; mobile: string };
  status: "active" | "inactive";
  weight?: number;
};
type Config = { owners: Owner[]; ads: Ad[] };

type Env = {
  CONFIG_URL: string;
  ALLOWED_ORIGIN: string;
};

const app = new Hono<{ Bindings: Env }>();

/* ---------------- CORS ---------------- */
app.use("*", async (c, next) => {
  c.res.headers.set("Access-Control-Allow-Origin", c.env.ALLOWED_ORIGIN);
  c.res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  c.res.headers.set("Vary", "Origin");

  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

/* ---------------- Helpers ---------------- */

function isMobile(req: Request): boolean {
  const ch = req.headers.get("Sec-CH-UA-Mobile");
  if (ch) return ch.includes("?1");
  const ua = req.headers.get("User-Agent") || "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

function weightedRandom<T extends { weight?: number }>(items: T[]): T {
  const weights = items.map((i) => Math.max(1, i.weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

async function loadConfig(url: string): Promise<Config> {
  const res = await fetch(url, {
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!res.ok) throw new Error("Failed to fetch config.json");
  return res.json();
}

/* ---------------- Routes ---------------- */

app.get("/v1/ads", async (c) => {
  const config = await loadConfig(c.env.CONFIG_URL);

  if (!config.owners || config.owners.length !== 2) {
    return c.json({ error: "Config must contain exactly 2 owners" }, 500);
  }

  const device = isMobile(c.req.raw) ? "mobile" : "desktop";
  const [ownerA, ownerB] = config.owners;

  // Truly random 50-50 split
  const topOwner = Math.random() < 0.5 ? ownerA : ownerB;
  const bottomOwner = topOwner.id === ownerA.id ? ownerB : ownerA;

  const activeAds = config.ads.filter((a) => a.status === "active");

  const topPool = activeAds.filter((a) => a.ownerId === topOwner.id);
  const bottomPool = activeAds.filter((a) => a.ownerId === bottomOwner.id);

  if (!topPool.length || !bottomPool.length) {
    return c.json(
      {
        error: "Missing active ads for one or both owners",
        details: {
          topOwner: topOwner.id,
          bottomOwner: bottomOwner.id,
          topPool: topPool.length,
          bottomPool: bottomPool.length,
        },
      },
      500
    );
  }

  const topAd = weightedRandom(topPool);
  const bottomAd = weightedRandom(bottomPool);

  c.res.headers.set("Cache-Control", "no-store");

  return c.json({
    top: {
      imageUrl: device === "mobile" ? topAd.image.mobile : topAd.image.desktop,
      clickUrl: topAd.targetUrl,
    },
    bottom: {
      imageUrl: device === "mobile" ? bottomAd.image.mobile : bottomAd.image.desktop,
      clickUrl: bottomAd.targetUrl,
    },
  });
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Force refresh config (for testing)
app.post("/v1/config/refresh", async (c) => {
  try {
    const url = `${c.env.CONFIG_URL}?_=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) {
      return c.json({ error: "Failed to fetch config" }, 500);
    }
    const config: Config = await res.json();
    return c.json({
      success: true,
      owners: config.owners.map((o) => o.id),
      activeAds: config.ads.filter((a) => a.status === "active").length,
    });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

export default app;