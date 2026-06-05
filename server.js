// ============================================================
//  KALSHI BOT — AI Prediction Engine
//  Motor real: busca noticias, analiza datos macro,
//  calcula probabilidades con Claude y detecta edge vs Kalshi
// ============================================================

const http  = require('http');
const https = require('https');
const url   = require('url');

const PORT = process.env.PORT || 3001;

// ── HTTP helpers ─────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    const c = [];
    req.on('data', d => c.push(d));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}

function httpsGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET',
      headers: { 'User-Agent': 'KalshiBot/1.0', ...headers }
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
    }, res => {
      const c = [];
      res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key,');
}

// ── Proxy genérico ───────────────────────────────────────────

async function proxyTo(hostname, targetPath, req, res) {
  const body = await readBody(req);
  const fwd = { ...req.headers };
  delete fwd['host'];
  fwd['content-length'] = body.length.toString();
  if (hostname === 'api.groq.com' && !fwd[''])
    fwd[''] = '2023-06-01';

  return new Promise((resolve, reject) => {
    const preq = https.request({ hostname, path: targetPath, method: req.method, headers: { ...fwd, host: hostname } }, pres => {
      const c = [];
      pres.on('data', d => c.push(d));
      pres.on('end', () => {
        res.writeHead(pres.statusCode, { 'Content-Type': pres.headers['content-type'] || 'application/json' });
        res.end(Buffer.concat(c));
        resolve();
      });
    });
    preq.on('error', err => { res.writeHead(502); res.end(JSON.stringify({ error: err.message })); resolve(); });
    if (body.length) preq.write(body);
    preq.end();
  });
}

// ════════════════════════════════════════════════════════════
//  AI PREDICTION ENGINE
//  Para cada mercado de Kalshi:
//  1. Busca noticias recientes (NewsData.io — gratis)
//  2. Obtiene datos macro relevantes (FRED API — gratis)
//  3. Llama a Claude con todo el contexto
//  4. Claude devuelve probabilidad propia + razonamiento
//  5. Compara con precio de Kalshi → calcula edge real
// ════════════════════════════════════════════════════════════

// Cache para no re-analizar el mismo mercado en < 10 minutos
const predictionCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// ── 1. Buscar noticias relevantes ────────────────────────────

async function fetchNews(query) {
  try {
    // NewsData.io — free tier: 200 req/día
    // Si no hay NEWSDATA_KEY usa RSS de Google News (sin key)
    if (process.env.NEWSDATA_KEY) {
      const q = encodeURIComponent(query);
      const r = await httpsGet('newsdata.io',
        `/api/1/news?apikey=${process.env.NEWSDATA_KEY}&q=${q}&language=en&size=5`);
      const d = JSON.parse(r.body);
      if (d.results) {
        return d.results.slice(0, 5).map(a =>
          `• ${a.title} (${a.source_id}, ${a.pubDate})`
        ).join('\n');
      }
    }
    // Fallback: búsqueda en DuckDuckGo Instant Answer (sin key)
    const q = encodeURIComponent(query + ' 2026');
    const r = await httpsGet('api.duckduckgo.com', `/?q=${q}&format=json&no_html=1&skip_disambig=1`);
    const d = JSON.parse(r.body);
    const snippets = [];
    if (d.AbstractText) snippets.push(d.AbstractText.slice(0, 300));
    if (d.RelatedTopics) {
      d.RelatedTopics.slice(0, 4).forEach(t => {
        if (t.Text) snippets.push('• ' + t.Text.slice(0, 150));
      });
    }
    return snippets.join('\n') || 'Sin noticias recientes disponibles.';
  } catch (e) {
    return 'Error buscando noticias: ' + e.message;
  }
}

// ── 2. Datos macro de FRED (Federal Reserve) — gratis ────────

async function fetchMacroData(indicator) {
  // FRED no requiere key para series públicas básicas
  const seriesMap = {
    'inflation'  : 'CPIAUCSL',   // CPI
    'fed_rate'   : 'FEDFUNDS',   // Fed Funds Rate
    'unemployment': 'UNRATE',    // Unemployment
    'sp500'      : 'SP500',      // S&P 500
    'gdp'        : 'GDP',        // GDP
    'bitcoin'    : null,         // se busca en CoinGecko
  };

  const series = seriesMap[indicator];
  if (!series) return null;

  try {
    const apiKey = process.env.FRED_KEY || 'demo'; // FRED tiene acceso público limitado
    const r = await httpsGet('api.stlouisfed.org',
      `/fred/series/observations?series_id=${series}&api_key=${apiKey}&file_type=json&limit=3&sort_order=desc`);
    const d = JSON.parse(r.body);
    if (d.observations) {
      return d.observations.map(o => `${o.date}: ${o.value}`).join(', ');
    }
  } catch (e) { /* silencioso */ }
  return null;
}

// Precio de Bitcoin desde CoinGecko (sin key)
async function fetchBTCPrice() {
  try {
    const r = await httpsGet('api.coingecko.com',
      '/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true');
    const d = JSON.parse(r.body);
    return `BTC: $${d.bitcoin.usd.toLocaleString()} (24h: ${d.bitcoin.usd_24h_change?.toFixed(2)}%)`;
  } catch (e) { return null; }
}

// ── 3. Llamar a Claude con todo el contexto ──────────────────

async function analyzeWithClaude(market, news, macroData, anthropicKey) {
  const systemPrompt = `Eres un analista cuantitativo experto en mercados de predicción (Kalshi, Polymarket).
Tu trabajo es estimar la probabilidad real de que un evento ocurra, basándote en datos actuales.

REGLAS:
- Responde SOLO con JSON válido, sin texto adicional ni markdown
- Sé calibrado: 50% = genuinamente incierto, no uses extremos sin evidencia fuerte
- Considera base rates históricos, no solo noticias recientes
- El formato exacto requerido es:
{
  "probability": <número entre 0 y 100>,
  "confidence": <"low"|"medium"|"high">,
  "reasoning": "<2-3 oraciones concisas explicando la estimación>",
  "key_factors": ["factor1", "factor2", "factor3"],
  "edge": <probability - market_price, número con signo>
}`;

  const userPrompt = `MERCADO KALSHI:
Pregunta: "${market.question}"
Precio actual en Kalshi (YES): ${market.marketPrice}¢ (implica ${market.marketPrice}% de probabilidad)
Categoría: ${market.category}
Expira: ${market.expiry}

NOTICIAS RECIENTES RELEVANTES:
${news}

DATOS MACRO ACTUALES:
${macroData || 'No disponibles'}

Estima la probabilidad real de que este evento ocurra (YES).
Compara con el precio de mercado de ${market.marketPrice}% para identificar si hay edge.`;

  try {
    const r = await httpsPost('api.groq.com', '/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }, {
      'Authorization': 'Bearer ' + anthropicKey,
    });

    const d = JSON.parse(r.body);
    const text = d.choices?.[0]?.message?.content || '{}';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { probability: market.marketPrice, confidence: 'low', reasoning: 'Error en análisis IA: ' + e.message, key_factors: [], edge: 0 };
  }
}

// ── 4. Obtener mercados reales de Kalshi ─────────────────────

async function fetchKalshiMarkets(kalshiKey) {
  if (kalshiKey) {
    try {
      // Kalshi v2 API — try both auth formats
      const headers = {
        'Authorization': 'Bearer ' + kalshiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };
      const r = await httpsGet('trading-api.kalshi.com',
        '/trade-api/v2/markets?limit=20&status=open', headers);
      console.log('[KALSHI] status:', r.status, r.body.slice(0,200));
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        if (d.markets && d.markets.length > 0) {
          console.log('[KALSHI] got', d.markets.length, 'markets');
          return d.markets.map(m => ({
            id         : m.ticker,
            question   : m.title,
            marketPrice: Math.round((m.yes_ask || m.yes_bid || m.last_price || 50)),
            category   : m.category || 'general',
            expiry     : m.close_time ? new Date(m.close_time).toLocaleDateString() : 'N/A',
            volume     : m.volume || 0,
          }));
        }
      } else {
        console.log('[KALSHI] auth failed, status', r.status, '— using demo markets');
      }
    } catch (e) {
      console.log('[KALSHI] error:', e.message, '— using demo markets');
    }
  } else {
    console.log('[KALSHI] no key provided — using demo markets');
  }

  // Mercados demo si no hay key o falla la API
  return [
    { id:'FED_JULY',   question:'¿Bajará la Fed los tipos en julio 2026?',              marketPrice:71, category:'economics', expiry:'Jul 2026', volume:480000 },
    { id:'CPI_MAY',    question:'¿Caerá el IPC de mayo por debajo del 3%?',             marketPrice:67, category:'economics', expiry:'Jun 2026', volume:290000 },
    { id:'BTC_120K',   question:'¿Superará Bitcoin los $120,000 antes de agosto 2026?', marketPrice:44, category:'crypto',    expiry:'Ago 2026', volume:360000 },
    { id:'SPX_5800',   question:'¿Cerrará el S&P 500 por encima de 5,800 esta semana?', marketPrice:48, category:'finance',   expiry:'Vie',      volume:120000 },
    { id:'UNEMP_Q3',   question:'¿Subirá el desempleo de EEUU sobre 4.5% en Q3 2026?', marketPrice:54, category:'economics', expiry:'Sep 2026', volume:170000 },
    { id:'TRUMP_APPR', question:'¿Tendrá Trump >50% de aprobación en julio 2026?',      marketPrice:38, category:'politics',  expiry:'Jul 2026', volume:210000 },
  ];
}

// ── 5. Motor principal: analiza todos los mercados ───────────

async function runPredictionEngine(kalshiKey, anthropicKey) {
  if (!anthropicKey) {
    return { error: 'Se necesita Anthropic API key para el motor de predicción' };
  }

  const markets = await fetchKalshiMarkets(kalshiKey);
  const results = [];

  for (const market of markets.slice(0, 6)) { // máx 6 para no agotar tokens
    const cacheKey = market.id;
    const cached = predictionCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      results.push({ ...market, ...cached.prediction, fromCache: true });
      continue;
    }

    // Buscar noticias y datos macro según categoría
    const newsQuery = market.question.replace(/[¿?]/g, '');
    const news = await fetchNews(newsQuery);

    let macroData = '';
    if (market.category === 'economics' || market.id.includes('FED') || market.id.includes('CPI')) {
      const [cpi, fed, unemp] = await Promise.all([
        fetchMacroData('inflation'),
        fetchMacroData('fed_rate'),
        fetchMacroData('unemployment'),
      ]);
      if (cpi)    macroData += `CPI reciente: ${cpi}\n`;
      if (fed)    macroData += `Fed Funds Rate: ${fed}\n`;
      if (unemp)  macroData += `Desempleo: ${unemp}\n`;
    }
    if (market.category === 'crypto' || market.id.includes('BTC')) {
      const btc = await fetchBTCPrice();
      if (btc) macroData += btc;
    }
    if (market.category === 'finance' || market.id.includes('SPX')) {
      const sp = await fetchMacroData('sp500');
      if (sp) macroData += `S&P 500 reciente: ${sp}`;
    }

    const prediction = await analyzeWithClaude(market, news, macroData, anthropicKey);

    predictionCache.set(cacheKey, { ts: Date.now(), prediction });

    results.push({
      ...market,
      aiProbability : prediction.probability,
      confidence    : prediction.confidence,
      reasoning     : prediction.reasoning,
      keyFactors    : prediction.key_factors || [],
      edge          : prediction.probability - market.marketPrice,
      ev            : ((prediction.probability / 100) * (1 - market.marketPrice / 100) -
                       ((1 - prediction.probability / 100) * (market.marketPrice / 100))).toFixed(3),
      news          : news.slice(0, 300),
      macroData     : macroData.slice(0, 200),
      fromCache     : false,
    });

    // Pausa entre llamadas para no saturar la API
    await new Promise(r => setTimeout(r, 500));
  }

  // Ordenar por edge absoluto descendente
  results.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
  return { markets: results, analyzedAt: new Date().toISOString() };
}

// ════════════════════════════════════════════════════════════
//  SERVIDOR HTTP
// ════════════════════════════════════════════════════════════

// HTML del bot (embebido)
const BOT_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Kalshi Bot">
<meta name="theme-color" content="#0d1117">
<title>Kalshi Bot ⚡ AI</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@2.44.0/tabler-icons.min.css">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#080b0f;--s1:#0d1117;--s2:#161b22;--s3:#1e2530;--border:#21282f;--border2:#2d3748;--green:#00ff88;--red:#ef4444;--amber:#f59e0b;--blue:#0ea5e9;--purple:#a855f7;--text:#e6edf3;--muted:#8b949e;--dim:#484f58}
html,body{height:100%;background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;overflow-x:hidden}
.mono{font-family:'IBM Plex Mono',monospace}

/* TOPBAR */
.topbar{background:var(--s1);border-bottom:1px solid var(--border);padding:10px 14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;position:sticky;top:0;z-index:50}
.logo{display:flex;align-items:center;gap:8px;font-family:'IBM Plex Mono',monospace;font-weight:600;font-size:13px}
.logo-icon{width:28px;height:28px;background:var(--green);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:14px;color:#000}
.topbar-right{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.api-row{display:flex;gap:6px;flex-wrap:wrap}
.api-input{background:var(--s2);border:1px solid var(--border);border-radius:5px;padding:6px 10px;color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:11px;width:200px;outline:none}
.api-input:focus{border-color:var(--blue)}
.api-input::placeholder{color:var(--dim)}
.btn{font-family:'IBM Plex Mono',monospace;font-size:11px;padding:6px 12px;border-radius:5px;border:1px solid var(--border);background:var(--s2);color:var(--muted);cursor:pointer;transition:all .15s;white-space:nowrap}
.btn:hover{color:var(--text);border-color:var(--border2)}
.btn-green{background:var(--green);color:#000;border-color:var(--green)}
.btn-green:hover{background:#00cc6a}
.btn-blue{border-color:var(--blue);color:var(--blue);background:rgba(14,165,233,.1)}
.btn-red{border-color:var(--red);color:var(--red);background:rgba(239,68,68,.1)}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px}
.dot-green{background:var(--green);box-shadow:0 0 6px var(--green);animation:pulse 2s infinite}
.dot-amber{background:var(--amber);animation:pulse 1s infinite}
.dot-red{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

/* STATS */
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border)}
.stat-cell{background:var(--s1);padding:10px 14px}
.stat-lbl{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1px;color:var(--dim);margin-bottom:3px}
.stat-val{font-family:'IBM Plex Mono',monospace;font-size:17px;font-weight:600}

/* TABS */
.tabs{display:flex;border-bottom:1px solid var(--border);background:var(--s1);overflow-x:auto;padding:0 12px;gap:2px}
.tabs::-webkit-scrollbar{display:none}
.tab{font-family:'IBM Plex Mono',monospace;font-size:11px;padding:10px 12px;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;white-space:nowrap}
.tab.active{color:var(--green);border-bottom-color:var(--green)}
.tab:hover:not(.active){color:var(--text)}

/* PANELS */
.panel{display:none;padding:14px}
.panel.active{display:block}
.section-label{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:2px;color:var(--dim);margin-bottom:10px}

/* MARKET CARDS */
.mkt-card{background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:10px;transition:border-color .2s;cursor:pointer}
.mkt-card:hover{border-color:rgba(0,255,136,.3)}
.mkt-card.selected{border-color:var(--green)}
.mkt-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px}
.mkt-question{font-size:13px;font-weight:600;flex:1;line-height:1.4}
.mkt-probs{text-align:right;flex-shrink:0}
.mkt-ai-prob{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:700}
.mkt-mkt-prob{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted);margin-top:1px}
.mkt-bar-wrap{height:3px;background:rgba(255,255,255,.06);border-radius:2px;margin-bottom:8px;position:relative}
.mkt-bar-mkt{position:absolute;height:3px;background:var(--muted);border-radius:2px;opacity:.4}
.mkt-bar-ai{position:absolute;height:3px;border-radius:2px}
.mkt-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--muted)}
.edge-chip{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:2px 7px;border-radius:3px;font-weight:700}
.edge-pos{background:rgba(0,255,136,.15);color:var(--green)}
.edge-neg{background:rgba(239,68,68,.15);color:var(--red)}
.edge-neu{background:rgba(139,148,158,.1);color:var(--muted)}
.conf-chip{font-family:'IBM Plex Mono',monospace;font-size:9px;padding:2px 6px;border-radius:3px}
.conf-high{background:rgba(0,255,136,.1);color:var(--green)}
.conf-medium{background:rgba(245,158,11,.1);color:var(--amber)}
.conf-low{background:rgba(139,148,158,.1);color:var(--muted)}

/* REASONING BOX */
.reasoning-box{background:rgba(14,165,233,.06);border:1px solid rgba(14,165,233,.2);border-radius:7px;padding:10px 12px;margin-top:8px;font-size:12px;color:var(--muted);line-height:1.6;display:none}
.reasoning-box.open{display:block}
.key-factors{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.kf-tag{font-family:'IBM Plex Mono',monospace;font-size:9px;background:rgba(14,165,233,.08);color:var(--blue);padding:2px 7px;border-radius:3px}

/* LOADING STATE */
.loading-card{background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:10px;display:flex;align-items:center;gap:12px}
.spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-txt{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--muted)}

/* ORDER PANEL */
.order-wrap{background:var(--s2);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px}
.dir-tabs{display:flex;gap:6px;margin-bottom:12px}
.dtab{flex:1;padding:8px;text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;border-radius:5px;cursor:pointer;border:1px solid var(--border);background:none;color:var(--muted)}
.dtab.yes{color:var(--green);border-color:var(--green);background:rgba(0,255,136,.1)}
.dtab.no{color:var(--red);border-color:var(--red);background:rgba(239,68,68,.1)}
.frow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.flabel{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1px;color:var(--dim);margin-bottom:4px}
.finput{width:100%;background:var(--s3);border:1px solid var(--border);border-radius:5px;padding:7px 10px;color:var(--text);font-family:'IBM Plex Mono',monospace;font-size:13px;outline:none}
.finput:focus{border-color:var(--blue)}
.kelly-box{font-family:'IBM Plex Mono',monospace;font-size:9px;padding:7px 10px;background:rgba(14,165,233,.07);border-left:2px solid var(--blue);border-radius:4px;color:var(--blue);margin-bottom:8px;line-height:1.6}
.exec-btn{width:100%;padding:11px;font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;border:none;letter-spacing:.5px}
.exec-yes{background:var(--green);color:#000}
.exec-no{background:var(--red);color:#fff}

/* POSITIONS */
.pos-card{background:var(--s2);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px}
.pos-dir{font-family:'IBM Plex Mono',monospace;font-size:10px;padding:3px 8px;border-radius:3px;font-weight:700;flex-shrink:0}
.pos-yes{background:rgba(0,255,136,.15);color:var(--green)}
.pos-no{background:rgba(239,68,68,.15);color:var(--red)}
.pos-info{flex:1;min-width:0}
.pos-name{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pos-sub{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted);margin-top:2px}
.pos-pnl{font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:700;text-align:right;flex-shrink:0}
.close-btn{font-family:'IBM Plex Mono',monospace;font-size:9px;padding:4px 8px;border-radius:3px;border:1px solid var(--red);color:var(--red);background:none;cursor:pointer;flex-shrink:0}

/* COMBOS */
.combo-card{background:var(--s2);border-radius:10px;padding:14px;margin-bottom:10px;border:1px solid var(--border);position:relative;overflow:hidden}
.combo-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.combo-card.low::before{background:var(--green)}
.combo-card.med::before{background:var(--amber)}
.combo-card.high::before{background:var(--red)}
.combo-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px}
.combo-ret{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:700;color:var(--amber);text-align:right}
.combo-ret-lbl{font-size:10px;color:var(--muted)}
.combo-leg{display:flex;gap:8px;align-items:center;margin-bottom:5px;font-size:12px}
.leg-n{width:18px;height:18px;border-radius:50%;background:rgba(245,158,11,.15);color:var(--amber);display:flex;align-items:center;justify-content:center;font-size:9px;font-family:'IBM Plex Mono',monospace;flex-shrink:0}
.combo-footer{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px;margin-top:8px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--muted)}
.risk-chip{font-size:9px;padding:2px 7px;border-radius:3px;font-weight:700}
.risk-low{background:rgba(0,255,136,.15);color:var(--green)}
.risk-med{background:rgba(245,158,11,.15);color:var(--amber)}
.risk-high{background:rgba(239,68,68,.15);color:var(--red)}

/* LOG */
.log-wrap{background:var(--s1);border:1px solid var(--border);border-radius:8px;padding:10px;max-height:300px;overflow-y:auto;font-family:'IBM Plex Mono',monospace;font-size:10px;line-height:1.8}
.log-wrap::-webkit-scrollbar{width:3px}
.log-wrap::-webkit-scrollbar-thumb{background:var(--border)}
.log-line{display:flex;gap:8px}
.log-time{color:var(--dim);flex-shrink:0}
.log-type{min-width:44px;font-weight:700}
.log-INFO .log-type{color:var(--blue)}
.log-TRADE .log-type{color:var(--green)}
.log-AI .log-type{color:var(--purple)}
.log-WARN .log-type{color:var(--amber)}
.log-msg{color:var(--muted);flex:1}
.log-msg b{color:var(--text)}

/* AUTO CONFIG */
.cfg-card{background:var(--s2);border:1px solid var(--border);border-radius:7px;padding:10px;margin-bottom:8px}
.cfg-lbl{font-family:'IBM Plex Mono',monospace;font-size:9px;letter-spacing:1px;color:var(--dim);margin-bottom:5px}
.cfg-val{font-family:'IBM Plex Mono',monospace;font-size:15px;font-weight:600;margin-bottom:4px}
.range-row{display:flex;align-items:center;gap:8px}
.range-row input[type=range]{flex:1;accent-color:var(--green)}
.toggle-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.toggle{width:40px;height:20px;background:var(--s3);border-radius:10px;cursor:pointer;position:relative;border:1px solid var(--border);transition:background .2s;flex-shrink:0}
.toggle.on{background:var(--green)}
.toggle::after{content:'';width:14px;height:14px;background:var(--muted);border-radius:50%;position:absolute;top:2px;left:3px;transition:transform .2s}
.toggle.on::after{transform:translateX(20px);background:#000}

/* MODAL */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
.modal{background:var(--s2);border:1px solid var(--border2);border-radius:10px;padding:18px;width:100%;max-width:340px}
.modal-title{font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;margin-bottom:12px}
.modal-row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px}
.modal-row span:first-child{color:var(--muted)}
.modal-row span:last-child{font-family:'IBM Plex Mono',monospace;font-weight:600}
.modal-btns{display:flex;gap:8px;margin-top:12px}
.modal-btns button{flex:1;padding:10px;border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--s3);color:var(--muted)}
.modal-confirm{background:var(--green) !important;color:#000 !important;border-color:var(--green) !important}

.toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--s2);border:1px solid var(--border2);border-radius:8px;padding:10px 16px;font-family:'IBM Plex Mono',monospace;font-size:11px;z-index:200;display:none;white-space:nowrap;box-shadow:0 4px 20px rgba(0,0,0,.5)}
.toast.show{display:block;animation:fadeUp .3s ease}
@keyframes fadeUp{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}

.empty{text-align:center;padding:40px 20px;color:var(--dim);font-family:'IBM Plex Mono',monospace;font-size:11px}

@media(max-width:600px){
  .stats-row{grid-template-columns:1fr 1fr}
  .api-input{width:160px}
  .frow{grid-template-columns:1fr 1fr}
}
</style>
</head>
<body>

<div id="toast" class="toast"></div>
<div id="modal" class="modal-overlay" style="display:none"></div>

<div class="topbar">
  <div class="logo">
    <div class="logo-icon">⚡</div>
    <div>
      <div>KALSHI·BOT</div>
      <div style="font-size:9px;color:var(--green);letter-spacing:1px">AI PREDICTION ENGINE</div>
    </div>
  </div>
  <div class="topbar-right">
    <div class="api-row">
      <input class="api-input" id="kalshi-key" type="password" placeholder="Kalshi API Key">
      <input class="api-input" id="anthropic-key" type="password" placeholder="Groq API Key gsk_...">
    </div>
    <button class="btn btn-blue" onclick="saveKeys()"><i class="ti ti-plug"></i> CONECTAR</button>
    <button class="btn btn-green" id="master-btn" onclick="toggleMaster()"><i class="ti ti-player-play"></i> START</button>
  </div>
</div>

<div class="stats-row">
  <div class="stat-cell"><div class="stat-lbl">BANKROLL</div><div class="stat-val" id="s-bankroll" style="color:var(--text)">$1,000</div></div>
  <div class="stat-cell"><div class="stat-lbl">P&L TOTAL</div><div class="stat-val" id="s-pnl" style="color:var(--green)">+$0.00</div></div>
  <div class="stat-cell"><div class="stat-lbl">POSICIONES</div><div class="stat-val" id="s-pos" style="color:var(--blue)">0</div></div>
  <div class="stat-cell"><div class="stat-lbl">WIN RATE</div><div class="stat-val" id="s-wr" style="color:var(--amber)">—</div></div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('predictions',this)">🧠 PREDICCIONES</button>
  <button class="tab" onclick="showTab('trade',this)">⚡ TRADE</button>
  <button class="tab" onclick="showTab('positions',this)">📊 POSICIONES</button>
  <button class="tab" onclick="showTab('combos',this)">🔗 COMBOS</button>
  <button class="tab" onclick="showTab('auto',this)">🤖 AUTO</button>
  <button class="tab" onclick="showTab('log',this)">📋 LOG</button>
</div>

<!-- PREDICCIONES -->
<div class="panel active" id="panel-predictions">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
    <div class="section-label" style="margin:0">ANÁLISIS IA EN TIEMPO REAL</div>
    <button class="btn btn-blue" id="scan-btn" onclick="runScan()"><i class="ti ti-refresh"></i> ESCANEAR</button>
  </div>
  <div id="predictions-list">
    <div class="empty">Presiona ESCANEAR para que la IA analice<br>los mercados con noticias y datos macro reales</div>
  </div>
</div>

<!-- TRADE -->
<div class="panel" id="panel-trade">
  <div class="section-label">EJECUTAR ORDEN</div>
  <div style="margin-bottom:12px">
    <div class="flabel">MERCADO SELECCIONADO</div>
    <select id="trade-mkt-select" class="finput" onchange="updateTradePanel()" style="cursor:pointer">
      <option value="">— Primero escanea los mercados —</option>
    </select>
  </div>
  <div class="order-wrap">
    <div class="dir-tabs">
      <button class="dtab yes" id="dtab-yes" onclick="setTradeDir('YES')">COMPRAR YES</button>
      <button class="dtab" id="dtab-no" onclick="setTradeDir('NO')">COMPRAR NO</button>
    </div>
    <div class="frow">
      <div><div class="flabel">CONTRATOS</div><input class="finput" id="t-qty" type="number" value="10" min="1" oninput="updateKelly()"></div>
      <div><div class="flabel">PRECIO (¢)</div><input class="finput" id="t-price" type="number" value="50" oninput="updateKelly()"></div>
    </div>
    <div class="kelly-box" id="kelly-box">Kelly: — · EV — · Edge —</div>
    <div style="margin-bottom:8px"><div class="flabel">COSTO TOTAL</div><input class="finput" id="t-total" readonly value="$5.00"></div>
    <button class="exec-btn exec-yes" id="t-exec-btn" onclick="confirmTrade()">⚡ EJECUTAR YES</button>
  </div>
  <div id="trade-reasoning" style="display:none" class="reasoning-box open"></div>
</div>

<!-- POSICIONES -->
<div class="panel" id="panel-positions">
  <div class="section-label">POSICIONES ABIERTAS</div>
  <div id="positions-list"><div class="empty">No hay posiciones abiertas</div></div>
</div>

<!-- COMBOS -->
<div class="panel" id="panel-combos">
  <div class="section-label">COMBOS GENERADOS POR IA</div>
  <div id="combos-list"><div class="empty">Escanea los mercados primero para generar combos</div></div>
</div>

<!-- AUTO TRADING -->
<div class="panel" id="panel-auto">
  <div class="section-label">MOTOR AUTO-TRADING</div>
  <div class="toggle-row">
    <div>
      <div style="font-weight:600;font-size:14px">Auto-Trading IA</div>
      <div style="color:var(--muted);font-size:12px;margin-top:2px">Ejecuta trades automáticamente con edge positivo</div>
    </div>
    <div class="toggle" id="auto-toggle" onclick="toggleAuto()"></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
    <div class="cfg-card">
      <div class="cfg-lbl">EDGE MÍNIMO</div>
      <div class="cfg-val" id="cfg-edge" style="color:var(--green)">8%</div>
      <div class="range-row"><input type="range" min="3" max="25" value="8" oninput="setCfg('edge',this.value)"><span class="mono" style="font-size:10px;color:var(--muted)" id="cfg-edge-lbl">8%</span></div>
    </div>
    <div class="cfg-card">
      <div class="cfg-lbl">MAX POR TRADE</div>
      <div class="cfg-val" id="cfg-max" style="color:var(--amber)">5%</div>
      <div class="range-row"><input type="range" min="1" max="20" value="5" oninput="setCfg('max',this.value)"><span class="mono" style="font-size:10px;color:var(--muted)" id="cfg-max-lbl">5%</span></div>
    </div>
    <div class="cfg-card">
      <div class="cfg-lbl">KELLY FRACTION</div>
      <div class="cfg-val" id="cfg-kelly" style="color:var(--blue)">25%</div>
      <div class="range-row"><input type="range" min="10" max="100" value="25" oninput="setCfg('kelly',this.value)"><span class="mono" style="font-size:10px;color:var(--muted)" id="cfg-kelly-lbl">25%</span></div>
    </div>
    <div class="cfg-card">
      <div class="cfg-lbl">SCAN CADA</div>
      <div class="cfg-val" id="cfg-scan" style="color:var(--purple)">15min</div>
      <div class="range-row"><input type="range" min="5" max="60" value="15" step="5" oninput="setCfg('scan',this.value)"><span class="mono" style="font-size:10px;color:var(--muted)" id="cfg-scan-lbl">15m</span></div>
    </div>
  </div>
  <div style="font-family:'IBM Plex Mono',monospace;font-size:9px;color:var(--dim);padding:10px;background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.15);border-radius:6px;line-height:1.6">
    ⚠️ MODO PAPER TRADING activado por defecto.<br>
    Sin Kalshi API key → todas las órdenes son simuladas.<br>
    Con API key real → activa órdenes reales en Kalshi.
  </div>
</div>

<!-- LOG -->
<div class="panel" id="panel-log">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <div class="section-label" style="margin:0">ACTIVITY LOG</div>
    <button class="btn" onclick="document.getElementById('log-body').innerHTML=''" style="font-size:9px;padding:3px 8px">CLEAR</button>
  </div>
  <div class="log-wrap" id="log-body"></div>
</div>

<script>
// ══ STATE ══════════════════════════════════════════════════
var S = {
  bankroll: 1000, pnl: 0, positions: [], trades: [],
  markets: [], tradeDir: 'YES', botRunning: false, autoOn: false,
  cfg: { edge: 8, max: 5, kelly: 25, scan: 15 },
  keys: { kalshi: '', anthropic: '' },
  autoTimer: null,
};

// ══ KEYS ═══════════════════════════════════════════════════
async function saveKeys() {
  S.keys.kalshi    = document.getElementById('kalshi-key').value.trim();
  S.keys.anthropic = document.getElementById('anthropic-key').value.trim();
  if (!S.keys.anthropic) { toast('⚠️ Groq API Key requerida', 'var(--amber)'); return; }

  addLog('INFO','CFG','Probando conexiones...');

  // Test Kalshi
  try {
    const r = await fetch('/kalshi-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kalshiKey: S.keys.kalshi })
    });
    const d = await r.json();
    if (d.ok) {
      addLog('TRADE','KALSHI','✓ Conectado — ' + d.markets + ' mercados en vivo');
      toast('✓ Kalshi conectado — ' + d.markets + ' mercados', 'var(--green)');
      S.kalshiMode = 'live';
    } else {
      addLog('WARN','KALSHI', d.error ? 'Error: ' + d.error + ' — modo demo' : 'Sin key — modo demo');
      toast('Kalshi: modo demo (sin key válida)', 'var(--amber)');
      S.kalshiMode = 'demo';
    }
  } catch(e) {
    addLog('WARN','KALSHI','Error de conexión: ' + e.message);
    S.kalshiMode = 'demo';
  }

  addLog('AI','GROQ','Groq API key guardada ✓');
  toast('✓ Listo — toca ESCANEAR', 'var(--green)');
}

// ══ SCAN — llama al endpoint /predict del servidor ═════════
async function runScan() {
  if (!S.keys.anthropic) { toast('Ingresa tu Groq API Key (gratis) primero', 'var(--amber)'); return; }
  const btn = document.getElementById('scan-btn');
  const list = document.getElementById('predictions-list');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:6px"></div>ANALIZANDO...';
  list.innerHTML = [1,2,3,4].map(()=>'<div class="loading-card"><div class="spinner"></div><div class="loading-txt">Claude analizando noticias y datos macro...</div></div>').join('');
  addLog('AI','SCAN','Iniciando análisis IA de mercados...');
  try {
    const resp = await fetch('/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kalshiKey: S.keys.kalshi, anthropicKey: S.keys.anthropic })
    });
    const data = await resp.json();
    if (data.error) { toast('Error: ' + data.error, 'var(--red)'); list.innerHTML='<div class="empty">'+data.error+'</div>'; return; }
    S.markets = data.markets || [];
    renderPredictions();
    populateTradeSelect();
    renderCombos();
    addLog('AI','SCAN', S.markets.length + ' mercados analizados · ' + S.markets.filter(m=>Math.abs(m.edge)>=S.cfg.edge).length + ' con edge ≥' + S.cfg.edge + '%');
    // Auto-trade si está activado
    if (S.autoOn) runAutoTrades();
  } catch(e) {
    list.innerHTML='<div class="empty">Error: '+e.message+'</div>';
    addLog('WARN','SCAN','Error: '+e.message);
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="ti ti-refresh"></i> ESCANEAR';
  }
}

// ══ RENDER PREDICTIONS ════════════════════════════════════
function renderPredictions() {
  const el = document.getElementById('predictions-list');
  if (!S.markets.length) { el.innerHTML='<div class="empty">Sin mercados</div>'; return; }
  el.innerHTML = S.markets.map((m,i) => {
    const edge = m.edge || 0;
    const edgeCls = edge >= 5 ? 'edge-pos' : edge <= -5 ? 'edge-neg' : 'edge-neu';
    const edgeTxt = (edge >= 0 ? '+' : '') + edge.toFixed(1) + '%';
    const aiProb  = m.aiProbability || m.marketPrice;
    const barColor = edge >= 5 ? 'var(--green)' : edge <= -5 ? 'var(--red)' : 'var(--amber)';
    return \`<div class="mkt-card" id="mkt-\${i}" onclick="toggleReasoning(\${i})">
      <div class="mkt-top">
        <div class="mkt-question">\${m.question}</div>
        <div class="mkt-probs">
          <div class="mkt-ai-prob" style="color:\${barColor}">\${aiProb.toFixed(0)}%</div>
          <div class="mkt-mkt-prob">MKT \${m.marketPrice}%</div>
        </div>
      </div>
      <div class="mkt-bar-wrap">
        <div class="mkt-bar-mkt" style="width:\${m.marketPrice}%"></div>
        <div class="mkt-bar-ai" style="width:\${aiProb}%;background:\${barColor}"></div>
      </div>
      <div class="mkt-meta">
        <span class="edge-chip \${edgeCls}">EDGE \${edgeTxt}</span>
        <span class="conf-chip conf-\${m.confidence || 'low'}">\${(m.confidence||'low').toUpperCase()}</span>
        <span style="color:var(--amber)">EV \${m.ev >= 0 ? '+' : ''}\${m.ev}</span>
        <span>\${m.expiry}</span>
        \${m.fromCache ? '<span style="color:var(--dim);font-size:10px">CACHE</span>' : ''}
        <button class="btn btn-blue" onclick="event.stopPropagation();selectForTrade('\${m.id}')" style="padding:3px 8px;font-size:10px;margin-left:auto">TRADEAR</button>
      </div>
      <div class="reasoning-box" id="reasoning-\${i}">
        <div style="color:var(--text);margin-bottom:4px">\${m.reasoning || ''}</div>
        \${m.keyFactors && m.keyFactors.length ? '<div class="key-factors">'+m.keyFactors.map(f=>'<span class="kf-tag">'+f+'</span>').join('')+'</div>' : ''}
        \${m.news ? '<div style="margin-top:6px;font-size:10px;color:var(--dim)">📰 '+m.news.slice(0,200)+'...</div>' : ''}
      </div>
    </div>\`;
  }).join('');
}

function toggleReasoning(i) {
  const box = document.getElementById('reasoning-' + i);
  if (box) box.classList.toggle('open');
}

// ══ TRADE PANEL ═══════════════════════════════════════════
function populateTradeSelect() {
  const sel = document.getElementById('trade-mkt-select');
  sel.innerHTML = '<option value="">— Selecciona un mercado —</option>' +
    S.markets.map(m => \`<option value="\${m.id}">\${m.question.slice(0,55)}... (\${m.marketPrice}¢)</option>\`).join('');
}

function selectForTrade(id) {
  showTab('trade', document.querySelector('.tab:nth-child(2)'));
  document.getElementById('trade-mkt-select').value = id;
  updateTradePanel();
}

function updateTradePanel() {
  const id = document.getElementById('trade-mkt-select').value;
  const m  = S.markets.find(x => x.id === id);
  if (!m) return;
  document.getElementById('t-price').value = m.marketPrice;
  const reas = document.getElementById('trade-reasoning');
  if (m.reasoning) {
    reas.style.display = 'block';
    reas.innerHTML = '<div style="color:var(--blue);font-family:IBM Plex Mono,monospace;font-size:9px;letter-spacing:1px;margin-bottom:6px">ANÁLISIS IA</div>'
      + '<div style="font-size:12px;color:var(--muted);line-height:1.6">' + m.reasoning + '</div>'
      + (m.keyFactors ? '<div class="key-factors" style="margin-top:6px">' + m.keyFactors.map(f=>'<span class="kf-tag">'+f+'</span>').join('') + '</div>' : '');
  }
  updateKelly();
}

function setTradeDir(dir) {
  S.tradeDir = dir;
  document.getElementById('dtab-yes').className = 'dtab' + (dir==='YES'?' yes':'');
  document.getElementById('dtab-no').className  = 'dtab' + (dir==='NO'?' no':'');
  document.getElementById('t-exec-btn').className = 'exec-btn exec-' + dir.toLowerCase();
  document.getElementById('t-exec-btn').textContent = '⚡ EJECUTAR ' + dir;
  updateKelly();
}

function updateKelly() {
  const id    = document.getElementById('trade-mkt-select').value;
  const m     = S.markets.find(x => x.id === id);
  const price = parseFloat(document.getElementById('t-price').value) / 100 || 0.5;
  const qty   = parseInt(document.getElementById('t-qty').value) || 10;
  const aiP   = m ? m.aiProbability / 100 : price;
  const p     = S.tradeDir === 'YES' ? aiP : 1 - aiP;
  const q     = 1 - p;
  const b     = (1 - price) / price;
  const kelly = Math.max(0, (b * p - q) / b);
  const frac  = S.cfg.kelly / 100;
  const betAmt= (S.bankroll * kelly * frac).toFixed(2);
  const ev    = ((p * (1 - price)) - (q * price)).toFixed(3);
  const edge  = ((p - price) * 100).toFixed(1);
  const total = (qty * price).toFixed(2);
  document.getElementById('kelly-box').textContent =
    'Kelly óptimo: $' + betAmt + ' · EV ' + (ev > 0 ? '+' : '') + ev + ' · Edge ' + (edge > 0 ? '+' : '') + edge + '%';
  document.getElementById('kelly-box').style.borderLeftColor = ev > 0 ? 'var(--blue)' : 'var(--red)';
  document.getElementById('t-total').value  = '$' + total;
  document.getElementById('t-total').style.color = ev > 0 ? 'var(--green)' : 'var(--red)';
}

// ══ ORDER EXECUTION ════════════════════════════════════════
function confirmTrade() {
  const id    = document.getElementById('trade-mkt-select').value;
  const m     = S.markets.find(x => x.id === id);
  if (!m) { toast('Selecciona un mercado', 'var(--amber)'); return; }
  const price = parseFloat(document.getElementById('t-price').value);
  const qty   = parseInt(document.getElementById('t-qty').value);
  const total = (qty * price / 100).toFixed(2);
  document.getElementById('modal').style.display = 'flex';
  document.getElementById('modal').innerHTML = \`<div class="modal">
    <div class="modal-title">⚡ CONFIRMAR ORDEN</div>
    <div class="modal-row"><span>Mercado</span><span style="max-width:160px;text-align:right;font-size:11px">\${m.question.slice(0,50)}...</span></div>
    <div class="modal-row"><span>Dirección</span><span style="color:\${S.tradeDir==='YES'?'var(--green)':'var(--red)'}">\${S.tradeDir}</span></div>
    <div class="modal-row"><span>Contratos</span><span>\${qty}</span></div>
    <div class="modal-row"><span>Precio</span><span>\${price}¢</span></div>
    <div class="modal-row"><span>Costo total</span><span style="color:var(--amber)">$\${total}</span></div>
    <div class="modal-row"><span>Modo</span><span style="color:\${S.keys.kalshi?'var(--green)':'var(--amber)'}">\${S.keys.kalshi?'REAL':'SIMULACIÓN'}</span></div>
    <div class="modal-btns">
      <button onclick="closeModal()">CANCELAR</button>
      <button class="modal-confirm" onclick="executeOrder('\${id}',\${qty},\${price},'\${S.tradeDir}')">CONFIRMAR</button>
    </div>
  </div>\`;
}

async function executeOrder(mktId, qty, price, dir, auto = false) {
  closeModal();
  const m = S.markets.find(x => x.id === mktId) || { question: mktId, marketPrice: price, ev: 0 };
  const total = qty * price / 100;
  addLog('INFO','ORDER', dir + ' ' + qty + 'x ' + m.question.slice(0,40) + ' @ ' + price + '¢');

  if (S.keys.kalshi) {
    try {
      const resp = await fetch('/kalshi/trade-api/v2/portfolio/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.keys.kalshi },
        body: JSON.stringify({ ticker: mktId, side: dir.toLowerCase(), type: 'limit', count: qty,
          yes_price: dir==='YES' ? price : 100 - price, no_price: dir==='NO' ? price : 100 - price })
      });
      if (resp.ok) {
        const d = await resp.json();
        addLog('TRADE','EXEC','✓ Orden real ejecutada — ID: ' + (d.order?.order_id || 'OK'));
        toast('✓ Orden ejecutada en Kalshi', 'var(--green)');
        simPosition(m, qty, price, dir, total);
        return;
      }
    } catch(e) { addLog('WARN','API', e.message); }
  }
  simPosition(m, qty, price, dir, total);
}

function simPosition(m, qty, price, dir, total) {
  S.positions.push({ id: Date.now(), market: m.question, mktId: m.id || m.market, dir, qty, entry: price, current: price, pnl: 0, ev: parseFloat(m.ev||0), total });
  S.bankroll -= total;
  addLog('TRADE','SIM', dir + ' ' + qty + 'x @ ' + price + '¢ · $' + total.toFixed(2));
  updateStats(); renderPositions();
  toast('✓ ' + dir + ' ' + qty + ' @ ' + price + '¢', 'var(--green)');
  startPriceAnimation();
}

// ══ AUTO TRADING ══════════════════════════════════════════
function toggleAuto() {
  S.autoOn = !S.autoOn;
  const t = document.getElementById('auto-toggle');
  t.classList.toggle('on', S.autoOn);
  if (S.autoOn) {
    addLog('AI','AUTO','Motor auto-trading ACTIVADO · edge mínimo: ' + S.cfg.edge + '%');
    S.autoTimer = setInterval(runScan, S.cfg.scan * 60 * 1000);
    if (S.markets.length) runAutoTrades();
  } else {
    clearInterval(S.autoTimer);
    addLog('WARN','AUTO','Motor auto-trading DETENIDO');
  }
}

function runAutoTrades() {
  const opps = S.markets.filter(m => m.edge >= S.cfg.edge && m.aiProbability > 50);
  if (!opps.length) { addLog('AI','AUTO','Sin oportunidades con edge ≥ ' + S.cfg.edge + '%'); return; }
  opps.slice(0, 2).forEach((m, i) => {
    setTimeout(() => {
      const price = m.marketPrice;
      const b = (1 - price/100) / (price/100);
      const p = m.aiProbability / 100;
      const kelly = Math.max(0, (b * p - (1-p)) / b);
      const betAmt = Math.min(S.bankroll * S.cfg.max / 100, S.bankroll * kelly * S.cfg.kelly / 100);
      const qty = Math.max(1, Math.floor(betAmt / (price / 100)));
      addLog('AI','AUTO','Edge +' + m.edge.toFixed(1) + '% → auto-trade: ' + m.question.slice(0,35));
      executeOrder(m.id, qty, price, 'YES', true);
    }, i * 1200);
  });
}

// ══ COMBOS GENERADOS POR IA ════════════════════════════════
function renderCombos() {
  const el = document.getElementById('combos-list');
  const positives = S.markets.filter(m => m.edge >= 5).slice(0, 4);
  if (positives.length < 2) { el.innerHTML='<div class="empty">Se necesitan ≥2 mercados con edge positivo</div>'; return; }

  // Genera 2-3 combos automáticos con los mejores mercados
  const combos = [];

  // Combo 1: top 2 por edge
  if (positives.length >= 2) {
    const legs = positives.slice(0,2);
    const jointAI  = legs.reduce((a,m) => a * m.aiProbability/100, 1) * 100;
    const jointMkt = legs.reduce((a,m) => a * m.marketPrice/100, 1) * 100;
    const retorno  = ((1/jointMkt*100) - 1).toFixed(0);
    combos.push({ name:'Combo Top-2 Edge', legs, jointAI: jointAI.toFixed(1), jointMkt: jointMkt.toFixed(1), retorno: '+'+retorno+'%', risk:'MED' });
  }

  // Combo 2: top 3 si hay
  if (positives.length >= 3) {
    const legs = positives.slice(0,3);
    const jointAI  = legs.reduce((a,m) => a * m.aiProbability/100, 1) * 100;
    const jointMkt = legs.reduce((a,m) => a * m.marketPrice/100, 1) * 100;
    const retorno  = ((1/jointMkt*100) - 1).toFixed(0);
    combos.push({ name:'Parlay 3-legs', legs, jointAI: jointAI.toFixed(1), jointMkt: jointMkt.toFixed(1), retorno: '+'+retorno+'%', risk:'HIGH' });
  }

  el.innerHTML = combos.map(c => {
    const edgePct = (parseFloat(c.jointAI) - parseFloat(c.jointMkt)).toFixed(1);
    return \`<div class="combo-card \${c.risk.toLowerCase()}">
      <div class="combo-hdr">
        <div>
          <div style="font-weight:700;font-size:14px">\${c.name}</div>
          <div style="font-size:10px;color:var(--muted);font-family:IBM Plex Mono,monospace;margin-top:2px">\${c.legs.length} LEGS</div>
        </div>
        <div style="text-align:right">
          <div class="combo-ret">\${c.retorno}</div>
          <div class="combo-ret-lbl">retorno potencial</div>
        </div>
      </div>
      \${c.legs.map((l,i) => \`<div class="combo-leg"><div class="leg-n">\${i+1}</div><div style="color:var(--muted)">\${l.question.slice(0,50)}... <span style="color:var(--green)">YES (\${l.aiProbability.toFixed(0)}%)</span></div></div>\`).join('')}
      <div class="combo-footer">
        <span>MKT IMPL <b style="color:var(--text)">\${c.jointMkt}%</b></span>
        <span>IA ESTIMA <b style="color:var(--green)">\${c.jointAI}%</b></span>
        <span>EDGE <b style="color:var(--green)">+\${edgePct}%</b></span>
        <span class="risk-chip risk-\${c.risk.toLowerCase()}">\${c.risk}</span>
      </div>
    </div>\`;
  }).join('');
}

// ══ POSITIONS ════════════════════════════════════════════
function renderPositions() {
  const el = document.getElementById('positions-list');
  if (!S.positions.length) { el.innerHTML='<div class="empty">No hay posiciones abiertas</div>'; return; }
  el.innerHTML = S.positions.map(p => \`<div class="pos-card">
    <span class="pos-dir \${p.dir==='YES'?'pos-yes':'pos-no'}">\${p.dir}</span>
    <div class="pos-info">
      <div class="pos-name">\${p.market}</div>
      <div class="pos-sub">\${p.qty} contratos · entrada \${p.entry}¢ · actual <span id="cp-\${p.id}">\${p.current}¢</span></div>
    </div>
    <div class="pos-pnl \${p.pnl>=0?'':'pnl-neg'}" id="pp-\${p.id}">\${p.pnl>=0?'+':''}$\${Math.abs(p.pnl).toFixed(2)}</div>
    <button class="close-btn" onclick="closePos(\${p.id})">CERRAR</button>
  </div>\`).join('');
}

function closePos(id) {
  const p = S.positions.find(x => x.id === id); if(!p) return;
  const exit   = Math.max(1, Math.min(99, p.current + ((Math.random()*10-5)|0)));
  const profit = p.dir==='YES' ? (exit-p.entry)/100*p.qty : (p.entry-exit)/100*p.qty;
  S.bankroll += p.total + profit;
  S.pnl += profit;
  S.trades.push({ profit });
  S.positions = S.positions.filter(x => x.id !== id);
  addLog('TRADE','CLOSE','Cerrada P&L ' + (profit>=0?'+':'') + '$' + Math.abs(profit).toFixed(2));
  updateStats(); renderPositions();
  toast('Posición cerrada: ' + (profit>=0?'+':'') + '$' + Math.abs(profit).toFixed(2), profit>=0?'var(--green)':'var(--red)');
}

// ══ STATS ════════════════════════════════════════════════
function updateStats() {
  const totalPnl = S.positions.reduce((a,p)=>a+p.pnl,0) + S.pnl;
  const wr = S.trades.length ? (S.trades.filter(t=>t.profit>0).length/S.trades.length*100).toFixed(0)+'%' : '—';
  document.getElementById('s-bankroll').textContent = '$'+S.bankroll.toFixed(2);
  document.getElementById('s-pnl').textContent = (totalPnl>=0?'+':'')+'$'+Math.abs(totalPnl).toFixed(2);
  document.getElementById('s-pnl').style.color = totalPnl>=0?'var(--green)':'var(--red)';
  document.getElementById('s-pos').textContent = S.positions.length;
  document.getElementById('s-wr').textContent = wr;
}

// ══ PRICE ANIMATION ══════════════════════════════════════
var _animating = false;
function startPriceAnimation() {
  if (_animating) return; _animating = true;
  setInterval(() => {
    S.positions.forEach(p => {
      p.current = Math.max(1, Math.min(99, p.current + ((Math.random()*4-2)|0)));
      p.pnl = parseFloat(((p.current-p.entry)/100*p.qty*(p.dir==='YES'?1:-1)).toFixed(2));
      const cp = document.getElementById('cp-'+p.id);
      const pp = document.getElementById('pp-'+p.id);
      if(cp) cp.textContent = p.current+'¢';
      if(pp){ pp.textContent=(p.pnl>=0?'+':'')+'$'+Math.abs(p.pnl).toFixed(2); pp.className='pos-pnl '+(p.pnl>=0?'':'pnl-neg'); }
    });
    updateStats();
  }, 3000);
}

// ══ MASTER TOGGLE ════════════════════════════════════════
function toggleMaster() {
  S.botRunning = !S.botRunning;
  const btn = document.getElementById('master-btn');
  if (S.botRunning) {
    btn.className = 'btn btn-red'; btn.innerHTML = '<i class="ti ti-player-stop"></i> STOP';
    addLog('INFO','BOT','Bot iniciado');
    if (S.keys.anthropic) runScan();
  } else {
    btn.className = 'btn btn-green'; btn.innerHTML = '<i class="ti ti-player-play"></i> START';
    if (S.autoOn) toggleAuto();
    addLog('WARN','BOT','Bot detenido');
  }
}

// ══ CONFIG ═══════════════════════════════════════════════
function setCfg(k, v) {
  v = parseInt(v); S.cfg[k] = v;
  if(k==='edge') { document.getElementById('cfg-edge').textContent=v+'%'; document.getElementById('cfg-edge-lbl').textContent=v+'%'; }
  if(k==='max')  { document.getElementById('cfg-max').textContent=v+'%';  document.getElementById('cfg-max-lbl').textContent=v+'%';  }
  if(k==='kelly'){ document.getElementById('cfg-kelly').textContent=v+'%';document.getElementById('cfg-kelly-lbl').textContent=v+'%';}
  if(k==='scan') { document.getElementById('cfg-scan').textContent=v+'min';document.getElementById('cfg-scan-lbl').textContent=v+'m';
    if(S.autoOn){ clearInterval(S.autoTimer); S.autoTimer=setInterval(runScan, v*60*1000); }
  }
}

// ══ UI HELPERS ════════════════════════════════════════════
function showTab(name, el) {
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('panel-'+name).classList.add('active');
  if(el) el.classList.add('active');
  else { const tabs={'predictions':0,'trade':1,'positions':2,'combos':3,'auto':4,'log':5};
    document.querySelectorAll('.tab')[tabs[name]]?.classList.add('active'); }
}

function closeModal() { document.getElementById('modal').style.display='none'; }

function toast(msg, color) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.style.borderColor=color||'var(--text)'; el.style.color=color||'var(--text)';
  el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000);
}

function addLog(type, src, msg) {
  const el=document.getElementById('log-body');
  const now=new Date();
  const t=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0')+':'+now.getSeconds().toString().padStart(2,'0');
  const d=document.createElement('div');
  d.className='log-line log-'+type;
  d.innerHTML='<span class="log-time">'+t+'</span><span class="log-type">'+src+'</span><span class="log-msg">'+msg+'</span>';
  el.appendChild(d); el.scrollTop=el.scrollHeight;
  if(el.children.length>300) el.removeChild(el.firstChild);
}

// ══ BOOT ════════════════════════════════════════════════
addLog('INFO','BOT','Sistema listo — ingresa tus API keys y presiona CONECTAR');
addLog('INFO','INFO','Motor IA: Groq Llama 3.3 (GRATIS) · Datos: FRED + CoinGecko + DuckDuckGo');
</script>
</body>
</html>`;

// ════════════════════════════════════════════════════════════
//  HTTP SERVER
// ════════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  setCORS(res);
  const parsed   = url.parse(req.url);
  const pathname = parsed.pathname || '/';

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Frontend ────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(BOT_HTML); return;
  }

  // ── Kalshi connection test ──────────────────────────────
  if (pathname === '/kalshi-test' && req.method === 'POST') {
    const body = await readBody(req);
    let params = {};
    try { params = JSON.parse(body.toString()); } catch(e) {}
    const key = params.kalshiKey || process.env.KALSHI_API_KEY || '';
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No Kalshi key provided', mode: 'demo' }));
      return;
    }
    try {
      const r = await httpsGet('trading-api.kalshi.com',
        '/trade-api/v2/markets?limit=5&status=open',
        { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' }
      );
      const d = JSON.parse(r.body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (r.status === 200 && d.markets) {
        res.end(JSON.stringify({ ok: true, status: r.status, markets: d.markets.length, mode: 'live' }));
      } else {
        res.end(JSON.stringify({ ok: false, status: r.status, error: d.error || d.message || 'Auth failed', mode: 'demo' }));
      }
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message, mode: 'demo' }));
    }
    return;
  }

  // ── Health ──────────────────────────────────────────────
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, engine: 'kalshi-ai-bot' })); return;
  }

  // ── /predict — motor de predicción IA ───────────────────
  if (pathname === '/predict' && req.method === 'POST') {
    const body = await readBody(req);
    let params = {};
    try { params = JSON.parse(body.toString()); } catch(e) {}
    const kalshiKey   = params.kalshiKey   || process.env.KALSHI_API_KEY   || '';
    const anthropicKey= params.anthropicKey|| process.env.GROQ_API_KEY|| '';

    if (!anthropicKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Groq API key requerida' })); return;
    }
    try {
      const result = await runPredictionEngine(kalshiKey, anthropicKey);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Proxy → Kalshi ──────────────────────────────────────
  if (pathname.startsWith('/kalshi/')) {
    const kPath = pathname.replace('/kalshi', '') + (parsed.search || '');
    await proxyTo('trading-api.kalshi.com', kPath, req, res); return;
  }

  // ── Proxy → Anthropic ───────────────────────────────────
  if (pathname.startsWith('/anthropic/')) {
    const aPath = pathname.replace('/anthropic', '') + (parsed.search || '');
    await proxyTo('api.groq.com', aPath, req, res); return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚡  Kalshi AI Bot corriendo en puerto ' + PORT);
  console.log('  🧠  Motor IA: Groq Llama 3.3 + FRED + CoinGecko + DuckDuckGo');
  console.log('  🌐  Abre la URL en el celular para usar el bot');
  console.log('');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error('Puerto ' + PORT + ' ocupado');
  else console.error(err.message);
  process.exit(1);
});