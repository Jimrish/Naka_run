const { redis, sign, json } = require("./_lib");
const KEY = "naka:forest:leaderboard";

// POST /api/forest-score { handle, score, dist, t, token } -> { ok, rank, top } (score = shnakas collected)
module.exports = async (req, res) => {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  let b = req.body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch (e) {
      b = null;
    }
  }
  if (!b || typeof b !== "object")
    return json(res, 400, { error: "Bad request" });

  const handle = String(b.handle || "").replace(/^@/, "");
  const score = Math.floor(+b.score),
    dist = Math.floor(+b.dist),
    t = +b.t;
  const [ts, nonce, sig] = String(b.token || "").split(".");

  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle))
    return json(res, 400, { error: "Invalid X handle" });
  if (
    !(score >= 0 && score <= 2e5) ||
    !(dist >= 0 && dist <= 50000) ||
    !(t >= 0 && t <= 7200)
  )
    return json(res, 400, { error: "Invalid numbers" });
  if (!ts || !nonce || !sig || sign(ts + "." + nonce) !== sig)
    return json(res, 403, { error: "Invalid token" });

  const age = (Date.now() - +ts) / 1000; // real seconds since the run started
  if (!(age >= 0 && age <= 7200) || t > age + 3)
    return json(res, 403, { error: "Timing check failed" });
  // The runner tops out near 22 m/s, and shnakas appear at most about 15 per second (golden ones count 5).
  if (dist > t * 24 + 30 || score > t * 35 + 80)
    return json(res, 400, { error: "Score not plausible" });

  try {
    const ip =
      (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
    const rl = "naka:forest:rate:" + ip;
    const n = await redis(["INCR", rl]);
    if (n === 1) await redis(["EXPIRE", rl, 600]);
    if (n > 30)
      return json(res, 429, { error: "Too many submissions, try again later" });

    const fresh = await redis([
      "SET",
      "naka:forest:used:" + nonce,
      "1",
      "NX",
      "EX",
      7200,
    ]); // each token works once
    if (fresh !== "OK") return json(res, 403, { error: "Token already used" });

    const member = handle.toLowerCase();
    await redis(["ZADD", KEY, "GT", score, member]); // keep each runner's best
    const rank = await redis(["ZREVRANK", KEY, member]);
    const r = await redis(["ZREVRANGE", KEY, 0, 9, "WITHSCORES"]);
    const top = [];
    for (let i = 0; i < r.length; i += 2)
      top.push({ handle: r[i], score: Math.round(+r[i + 1]) });
    json(res, 200, { ok: true, rank: rank + 1, top });
  } catch (e) {
    json(res, 503, {
      error: "Leaderboard unavailable",
      reason: String(e.message || e).slice(0, 160),
    });
  }
};
