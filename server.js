const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// AI (receipt OCR) and durable file storage are platform services injected
// at runtime in production. Staging and standalone runs have neither, so
// every use is gated on presence and degrades to the manual path instead of
// failing.
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;
const STORAGE_ENABLED = !!process.env.USERNODE_STORAGE_TOKEN;

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

/* ── Dates ────────────────────────────────────────────────────────────────
 * All day arithmetic is done on 'YYYY-MM-DD' strings in UTC. The app
 * reasons in UTC (see CLAUDE.md); DATE columns are selected as text so no
 * timezone shifts a stored deadline by a day.
 */
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function daysUntil(dateStr, todayStr) {
  const ms = Date.UTC(
    +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)
  ) - Date.UTC(
    +todayStr.slice(0, 4), +todayStr.slice(5, 7) - 1, +todayStr.slice(8, 10)
  );
  return Math.round(ms / 86400000);
}
function addDays(dateStr, n) {
  const t = Date.UTC(
    +dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10)
  ) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function addMonths(dateStr, m) {
  const day = +dateStr.slice(8, 10);
  const t = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1 + m, day));
  // Clamp day-of-month overflow (Jan 31 + 1 month lands on Mar 3 otherwise).
  if (t.getUTCDate() !== day) t.setUTCDate(0);
  return t.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORIES = ['electronics', 'appliances', 'furniture', 'clothing', 'other'];

/* ── Status and reminders ─────────────────────────────────────────────────
 * Status is computed at read time from the row's dates against req.now,
 * never stored and never computed in SQL with NOW(). Return window beats
 * everything: it is the action with a clock on it.
 */
function statusFor(item, today) {
  if (item.return_deadline && item.return_deadline >= today) return 'return-window';
  if (item.warranty_expires_on) {
    const diff = daysUntil(item.warranty_expires_on, today);
    if (diff < 0) return 'expired';
    if (diff <= 30) return 'expiring-soon';
  }
  return 'covered';
}

// The fixed reminder schedule: warranty expiration minus 30 and minus 7
// days, then minus 1 day (plus the day itself), return deadline minus 3
// days, then minus 1 day (plus the day itself). Exact day-counts only, so
// a reminder appears on the day it is about, not as a standing state.
// Lowercase text; the page prefixes the item name.
function reminderFor(item, today) {
  if (item.return_deadline) {
    const diff = daysUntil(item.return_deadline, today);
    if (diff === 3) return { kind: 'return', text: 'return window closes in 3 days' };
    if (diff === 1) return { kind: 'return', text: 'return window closes tomorrow' };
    if (diff === 0) return { kind: 'return', text: 'return window closes today' };
  }
  if (item.warranty_expires_on) {
    const diff = daysUntil(item.warranty_expires_on, today);
    if (diff === 30) return { kind: 'warranty', text: 'warranty ends in 30 days' };
    if (diff === 7) return { kind: 'warranty', text: 'warranty ends in 7 days' };
    if (diff === 1) return { kind: 'warranty', text: 'warranty ends tomorrow' };
    if (diff === 0) return { kind: 'warranty', text: 'warranty expires today' };
  }
  return null;
}

function presentItem(row, today) {
  const item = { ...row };
  item.status = statusFor(item, today);
  item.reminder = reminderFor(item, today);
  return item;
}

// Date columns are selected as text so they are compared in UTC.
const ITEM_COLUMNS = `
  id, user_id, username, name, category, store,
  purchase_date::text AS purchase_date,
  price_cents, warranty_months,
  warranty_expires_on::text AS warranty_expires_on,
  return_deadline::text AS return_deadline,
  serial_number, manual_url, receipt_file_id, receipt_url, created_at
`;

/* ── Staging demo data ────────────────────────────────────────────────────
 * `items` is staging:private, so staging starts with an empty table — and
 * every read route is owner-scoped, so boot-seeded rows under a fake user
 * would be invisible to any viewer. The sanctioned mechanism here is
 * request-time demo injection: read-only rows behind ?demo=1 that persist
 * nothing and belong to no one. Dates are computed relative to req.now so
 * every status, chip and reminder line shows whenever a preview is opened.
 * Never attribute demo rows to the visitor, and never read a signal ("has
 * this user added an item?") from them.
 */
function demoReceipt(label) {
  // A tiny obviously-placeholder receipt image; platform-stored files are
  // never cloned into staging, so demo rows carry an inline data URI.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200">` +
    `<rect width="160" height="200" fill="#f5f5f4"/>` +
    `<rect x="20" y="20" width="120" height="7" rx="3.5" fill="#78716c"/>` +
    `<rect x="20" y="44" width="92" height="5" rx="2.5" fill="#d6d3d1"/>` +
    `<rect x="20" y="60" width="108" height="5" rx="2.5" fill="#d6d3d1"/>` +
    `<rect x="20" y="76" width="76" height="5" rx="2.5" fill="#d6d3d1"/>` +
    `<rect x="20" y="104" width="120" height="1.5" fill="#a8a29e"/>` +
    `<rect x="20" y="118" width="100" height="5" rx="2.5" fill="#d6d3d1"/>` +
    `<rect x="20" y="134" width="120" height="7" rx="3.5" fill="#57534e"/>` +
    `<text x="80" y="182" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#a8a29e">${label}</text>` +
    `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function demoItems(today) {
  const r = (n) => addDays(today, n);
  return [
    {
      id: 900001,
      name: 'Staging demo cordless drill',
      category: 'electronics',
      store: 'Staging demo hardware store',
      purchase_date: r(-337),
      price_cents: 12999,
      warranty_months: 12,
      warranty_expires_on: r(7),   // hits the 7-day warranty reminder
      return_deadline: r(-307),
      serial_number: 'SD-DRILL-0042',
      manual_url: 'https://example.com/staging-demo-drill-manual.pdf',
      receipt_file_id: null,
      receipt_url: demoReceipt('Staging demo drill'),
    },
    {
      id: 900002,
      name: 'Staging demo espresso machine',
      category: 'appliances',
      store: 'Staging demo kitchen store',
      purchase_date: r(-27),
      price_cents: 49900,
      warranty_months: 12,
      warranty_expires_on: r(338),
      return_deadline: r(3),       // hits the 3-day return reminder
      serial_number: null,
      manual_url: null,
      receipt_file_id: null,
      receipt_url: demoReceipt('Staging demo espresso'),
    },
    {
      id: 900003,
      name: 'Staging demo desk lamp',
      category: 'furniture',
      store: 'Staging demo home store',
      purchase_date: r(-64),
      price_cents: 4550,
      warranty_months: 12,
      warranty_expires_on: r(301), // comfortably covered
      return_deadline: r(-34),
      serial_number: null,
      manual_url: null,
      receipt_file_id: null,
      receipt_url: null,
    },
    {
      id: 900004,
      name: 'Staging demo winter jacket',
      category: 'clothing',
      store: 'Staging demo outdoors store',
      purchase_date: r(-425),
      price_cents: 18900,
      warranty_months: 12,
      warranty_expires_on: r(-60), // expired, quiet
      return_deadline: r(-395),
      serial_number: null,
      manual_url: null,
      receipt_file_id: null,
      receipt_url: null,
    },
    {
      id: 900005,
      name: 'Staging demo yoga mat',
      category: 'other',
      store: 'Staging demo sports store',
      purchase_date: r(-20),
      price_cents: 3200,
      warranty_months: null,       // no warranty: return-window-only item
      warranty_expires_on: null,
      return_deadline: r(10),
      serial_number: null,
      manual_url: null,
      receipt_file_id: null,
      receipt_url: null,
    },
  ];
}

/* ── Items API ──────────────────────────────────────────────────────────── */

app.get('/api/items', async (req, res) => {
  const today = isoDate(req.now);
  try {
    if (IS_STAGING && req.query.demo === '1') {
      let demo = demoItems(today).map((i) => presentItem(i, today));
      const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
      if (q) {
        demo = demo.filter((i) =>
          i.name.toLowerCase().includes(q) || (i.store || '').toLowerCase().includes(q));
      }
      if (req.query.filter === 'expiring') {
        demo = demo.filter((i) => i.status === 'return-window' || i.status === 'expiring-soon');
      }
      return res.json({ items: demo });
    }

    const params = [req.user ? req.user.id : null];
    let where = 'user_id = $1';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      params.push('%' + q + '%');
      where += ` AND (name ILIKE $${params.length} OR store ILIKE $${params.length})`;
    }
    const { rows } = await pool.query(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE ${where} ORDER BY created_at DESC, id DESC`,
      params
    );
    let items = rows.map((row) => presentItem(row, today));
    if (req.query.filter === 'expiring') {
      items = items.filter((i) => i.status === 'return-window' || i.status === 'expiring-soon');
    }
    res.json({ items });
  } catch (err) {
    console.error('GET /api/items failed:', err.message);
    res.status(500).json({ error: 'Could not load items' });
  }
});

app.get('/api/items/:id', async (req, res) => {
  const today = isoDate(req.now);
  try {
    const id = Number(req.params.id);
    if (IS_STAGING && req.query.demo === '1') {
      const demo = demoItems(today).find((i) => i.id === id);
      if (demo) return res.json({ item: presentItem(demo, today) });
      // Not a demo id: fall through to the owner-scoped lookup below.
    }
    const { rows } = await pool.query(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: presentItem(rows[0], today) });
  } catch (err) {
    console.error('GET /api/items/:id failed:', err.message);
    res.status(500).json({ error: 'Could not load the item' });
  }
});

const VALID_DATE = (v) => v === null || v === undefined || v === '' ||
  (typeof v === 'string' && DATE_RE.test(v));
const VALID_INT = (v) => v === null || v === undefined || v === '' ||
  (Number.isInteger(v) && v >= 0);

app.post('/api/items', async (req, res) => {
  const b = req.body || {};
  try {
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Item name is required' });
    const category = CATEGORIES.includes(b.category) ? b.category : 'other';
    if (!VALID_DATE(b.purchase_date) || !VALID_DATE(b.return_deadline)) {
      return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
    }
    if (!VALID_INT(b.price_cents) || !VALID_INT(b.warranty_months)) {
      return res.status(400).json({ error: 'Price and warranty must be whole numbers' });
    }
    const purchase = DATE_RE.test(b.purchase_date || '') ? b.purchase_date : null;
    const months = Number.isInteger(b.warranty_months) ? b.warranty_months : null;
    // The warranty end date is decided once, at save time.
    const warrantyExpires = purchase && months ? addMonths(purchase, months) : null;
    const returnDeadline = DATE_RE.test(b.return_deadline || '') ? b.return_deadline : null;

    // Optional product manual link. Must be a real web address with an
    // http(s) scheme, so it can never run anything inside Backed; the
    // stored value is the trimmed input as typed. The page shows the error
    // text in #form-error, so it doubles as the message a person sees.
    let manualUrl = null;
    if (typeof b.manual_url === 'string' && b.manual_url.trim() !== '') {
      const raw = b.manual_url.trim();
      if (raw.length > 2048) {
        return res.status(400).json({ error: 'Manual link must be a web address starting with https://' });
      }
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('bad scheme');
        }
        manualUrl = raw;
      } catch {
        return res.status(400).json({ error: 'Manual link must be a web address starting with https://' });
      }
    }

    const { rows } = await pool.query(`
      INSERT INTO items
        (user_id, username, name, category, store, purchase_date, price_cents,
         warranty_months, warranty_expires_on, return_deadline, serial_number,
         manual_url, receipt_file_id, receipt_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING id
    `, [
      req.user.id, req.user.username, name, category,
      (b.store && String(b.store).trim()) || null,
      purchase,
      Number.isInteger(b.price_cents) ? b.price_cents : null,
      months,
      warrantyExpires,
      returnDeadline,
      (b.serial_number && String(b.serial_number).trim()) || null,
      manualUrl,
      typeof b.receipt_file_id === 'string' ? b.receipt_file_id : null,
      typeof b.receipt_url === 'string' ? b.receipt_url : null,
    ]);
    res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('POST /api/items failed:', err.message);
    res.status(500).json({ error: 'Could not save the item' });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Item not found' });
    const { rows } = await pool.query(
      `DELETE FROM items WHERE id = $1 AND user_id = $2 RETURNING receipt_file_id`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    // Best effort: remove the stored receipt too. A storage failure must not
    // block the item delete — the row is already gone.
    const fileId = rows[0].receipt_file_id;
    if (fileId && STORAGE_ENABLED) {
      try {
        await fetch(`${process.env.USERNODE_STORAGE_URL}/files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE',
          headers: {
            'x-usernode-app-token': process.env.USERNODE_STORAGE_TOKEN,
            'x-usernode-user-token': req.headers['x-usernode-token'],
          },
        });
      } catch (err) {
        console.warn('receipt delete failed:', err.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/items/:id failed:', err.message);
    res.status(500).json({ error: 'Could not delete the item' });
  }
});

// Receipt OCR. The photo is already stored platform-side (the page uploads
// it with usernode.uploadFile); this call reads it through the platform's
// LLM proxy, billed to the user's own grant. Stateless: it never writes.
const OCR_PROMPT = `You read receipt photos for Backed, a warranty tracker. ` +
  `Extract from this receipt photo: the store name, the item name (the main ` +
  `product bought), the purchase date, and the total price paid.\n` +
  `Reply with ONLY a JSON object, no other text:\n` +
  `{"store": string or null, "item_name": string or null, ` +
  `"purchase_date": "YYYY-MM-DD" or null, "price_cents": integer or null, ` +
  `"low_confidence": boolean}\n` +
  `Set low_confidence true when the photo is faded, blurry, or any value is ` +
  `a guess or missing. If the image is not a readable receipt, return all ` +
  `nulls with low_confidence true. Decline and return nulls if the content ` +
  `is sexual, violent, gambling-related or otherwise disallowed.`;

function parseScanJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

app.post('/api/items/scan', async (req, res) => {
  const { receiptUrl } = req.body || {};
  if (!LLM_ENABLED) {
    return res.status(503).json({ error: 'ai_unavailable' });
  }
  if (typeof receiptUrl !== 'string' || !/^https?:\/\//.test(receiptUrl)) {
    return res.status(400).json({ error: 'receiptUrl required' });
  }
  try {
    const upstream = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': req.headers['x-usernode-token'],
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: receiptUrl } },
            { type: 'text', text: OCR_PROMPT },
          ],
        }],
      }),
    });

    if (upstream.status === 403) {
      const body = await upstream.json().catch(() => ({}));
      return res.status(403).json({ error: body.code || 'grant_required' });
    }
    if (upstream.status === 429) {
      const body = await upstream.json().catch(() => ({}));
      return res.status(429).json({ error: body.code || 'budget_exceeded' });
    }
    if (!upstream.ok) {
      console.warn('scan upstream status', upstream.status);
      return res.status(502).json({ error: 'scan_failed' });
    }

    const data = await upstream.json();
    const text = (data.content || []).map((b) => b.text || '').join('');
    const parsed = parseScanJson(text);
    if (!parsed) return res.status(502).json({ error: 'scan_failed' });
    res.json({
      store: typeof parsed.store === 'string' ? parsed.store : null,
      name: typeof parsed.item_name === 'string' ? parsed.item_name : null,
      purchase_date: DATE_RE.test(parsed.purchase_date || '') ? parsed.purchase_date : null,
      price_cents: Number.isInteger(parsed.price_cents) && parsed.price_cents >= 0
        ? parsed.price_cents : null,
      low_confidence: parsed.low_confidence === true,
    });
  } catch (err) {
    console.error('POST /api/items/scan failed:', err.message);
    res.status(502).json({ error: 'scan_failed' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/backed-9c33d3/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/backed-9c33d3/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // The app's own data. Receipt photos are personal purchase records, so
  // the table is staging:private: staging clones the schema only, and the
  // demo block above covers previews with request-time fake rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      store TEXT,
      purchase_date DATE,
      price_cents INTEGER,
      warranty_months INTEGER,
      warranty_expires_on DATE,
      return_deadline DATE,
      serial_number TEXT,
      receipt_file_id TEXT,
      receipt_url TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Appended later than the CREATE TABLE above; older databases get the
  // column on their next boot. Existing rows read as NULL, no backfill.
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS manual_url TEXT`);
  await pool.query(`COMMENT ON TABLE items IS 'staging:private'`);
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Platform convention: stop accepting connections, drain briefly, close
  // the pool, exit. Without this a SIGTERM mid-request drops connections.
  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal}, shutting down`);
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 3000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
