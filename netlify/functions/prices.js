const YQ = "https://query1.finance.yahoo.com/v8/finance/chart/";

async function yfetch(symbol) {
  const url = YQ + encodeURIComponent(symbol) + "?range=1mo&interval=15m&includePrePost=true";
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("yahoo " + r.status);
  const j = await r.json();
  const res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error("no data");
  const meta = res.meta;
  const ts = res.timestamp || [];
  const closeArr = ((res.indicators.quote[0] || {}).close) || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    if (closeArr[i] != null) pts.push([ts[i], closeArr[i]]);
  }
  if (!pts.length && meta.regularMarketPrice == null) throw new Error("no data");
  const lastT = pts.length ? pts[pts.length - 1][0] : Math.floor(Date.now() / 1000);
  const lastClose = pts.length ? pts[pts.length - 1][1] : meta.regularMarketPrice;
  // prix le plus frais : prix live si dispo, sinon dernier échange (pré/post-marché inclus)
  const last = meta.regularMarketPrice != null ? meta.regularMarketPrice : lastClose;
  function closeAt(secondsAgo) {
    const target = lastT - secondsAgo;
    let best = null;
    for (const [t, c] of pts) { if (t <= target) best = c; else break; }
    return best != null ? best : (pts.length ? pts[0][1] : last);
  }
  const prev = closeAt(24 * 3600);
  const wk = closeAt(7 * 24 * 3600);
  return {
    price: last,
    currency: meta.currency || "USD",
    ch24: prev ? (last - prev) / prev * 100 : null,
    ch7: wk ? (last - wk) / wk * 100 : null,
  };
}

async function fxToEur(currencies) {
  const rates = { EUR: 1 };
  await Promise.all([...currencies].filter(c => c !== "EUR").map(async c => {
    try { rates[c] = (await yfetch("EUR" + c + "=X")).price; } catch (e) { rates[c] = null; }
  }));
  return rates;
}

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  try {
    const symbols = ((event.queryStringParameters || {}).symbols || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (!symbols.length) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "no symbols" }) };

    const raw = {};
    await Promise.all(symbols.map(async s => {
      try { raw[s] = await yfetch(s); } catch (e) { raw[s] = { error: String(e.message || e) }; }
    }));

    const currencies = new Set(Object.values(raw).filter(v => v && v.currency).map(v => v.currency));
    const fx = await fxToEur(currencies);

    const out = {};
    for (const s of symbols) {
      const v = raw[s];
      if (!v || v.error) { out[s] = { error: (v && v.error) || "no data" }; continue; }
      const rate = fx[v.currency];
      out[s] = {
        priceEur: v.currency === "EUR" ? v.price : (rate ? v.price / rate : null),
        currency: v.currency, ch24: v.ch24, ch7: v.ch7,
      };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, prices: out, at: new Date().toISOString() }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};
