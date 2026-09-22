const express = require('express');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable DATABASE_URL (la conexión a tu base de datos en Supabase).');
  process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS soles (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, photo TEXT,
      price NUMERIC NOT NULL DEFAULT 0, notes TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS sole_sizes (
      sole_id INTEGER NOT NULL REFERENCES soles(id) ON DELETE CASCADE,
      size TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sole_id, size));
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, supplier TEXT DEFAULT '', order_date DATE NOT NULL, notes TEXT DEFAULT '');
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      sole_id INTEGER NOT NULL REFERENCES soles(id), size TEXT NOT NULL DEFAULT 'Única',
      qty INTEGER NOT NULL, price NUMERIC NOT NULL);
    CREATE TABLE IF NOT EXISTS receipts (
      id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
      qty INTEGER NOT NULL, received_date DATE NOT NULL);
  `);
}

const app = express();
app.use(express.json({ limit: '8mb' }));

// Clave opcional: si defines APP_PASSWORD, el navegador pedirá contraseña (usuario: cualquiera).
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const raw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
    if (raw.slice(raw.indexOf(':') + 1) === process.env.APP_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Inventario"').status(401).send('Acceso restringido');
  });
}
app.use(express.static(require('path').join(__dirname, 'public')));

// ---------- Fotos (se suben a Cloudinary, quedan en internet, no en el servidor) ----------
async function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME, preset = process.env.CLOUDINARY_UPLOAD_PRESET;
  if (!cloud || !preset) throw Object.assign(new Error('Falta configurar Cloudinary (CLOUDINARY_CLOUD_NAME / CLOUDINARY_UPLOAD_PRESET) en las variables de entorno.'), { status: 500 });
  const body = new URLSearchParams({ file: dataUrl, upload_preset: preset });
  const r = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: 'POST', body });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error?.message || 'No se pudo subir la foto.'), { status: 502 });
  return data.secure_url;
}

// ---------- Tallas ----------
const cleanSizes = list => {
  const seen = new Map();
  for (const s of list || []) {
    const size = String(s.size ?? '').trim();
    if (size) seen.set(size, Math.max(0, Math.floor(s.stock) || 0));
  }
  return [...seen];
};
async function setSizes(client, id, sizes) {
  await client.query('DELETE FROM sole_sizes WHERE sole_id=$1', [id]);
  for (const [size, stock] of sizes)
    await client.query('INSERT INTO sole_sizes (sole_id, size, stock) VALUES ($1,$2,$3)', [id, size, stock]);
}

// ---------- Suelas (CRUD) ----------
async function loadSoles(id) {
  const { rows: soles } = id
    ? await pool.query('SELECT * FROM soles WHERE id=$1', [id])
    : await pool.query('SELECT * FROM soles ORDER BY name');
  for (const s of soles) {
    const { rows } = await pool.query('SELECT size, stock FROM sole_sizes WHERE sole_id=$1', [s.id]);
    s.sizes = rows.sort((a, b) => a.size.localeCompare(b.size, 'es', { numeric: true }));
    s.stock = s.sizes.reduce((t, x) => t + x.stock, 0);
    s.price = Number(s.price);
  }
  return soles;
}
app.get('/api/soles', async (req, res, next) => { try { res.json(await loadSoles()); } catch (e) { next(e); } });

app.post('/api/soles', async (req, res, next) => {
  const { name, price, notes, photo } = req.body;
  const sizes = cleanSizes(req.body.sizes);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre de la suela.' });
  if (!sizes.length) return res.status(400).json({ error: 'Agrega al menos una talla.' });
  try {
    const url = await savePhoto(photo);
    if (!url) return res.status(400).json({ error: 'Falta la foto de la suela.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO soles (name, photo, price, notes) VALUES ($1,$2,$3,$4) RETURNING id',
        [name.trim(), url, +price || 0, notes || '']);
      await setSizes(client, rows[0].id, sizes);
      await client.query('COMMIT');
      res.status(201).json((await loadSoles(rows[0].id))[0]);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (e) { next(e); }
});

app.put('/api/soles/:id', async (req, res, next) => {
  try {
    const { rows: [old] } = await pool.query('SELECT * FROM soles WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'No existe esa suela.' });
    const { name, price, notes, photo } = req.body;
    const sizes = cleanSizes(req.body.sizes);
    if (!sizes.length) return res.status(400).json({ error: 'Agrega al menos una talla.' });
    const url = photo ? await savePhoto(photo) : null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE soles SET name=$1, photo=$2, price=$3, notes=$4 WHERE id=$5',
        [(name || old.name).trim(), url || old.photo, +price || 0, notes || '', old.id]);
      await setSizes(client, old.id, sizes);
      await client.query('COMMIT');
      res.json((await loadSoles(old.id))[0]);
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch (e) { next(e); }
});

app.delete('/api/soles/:id', async (req, res, next) => {
  try {
    const { rows: [old] } = await pool.query('SELECT * FROM soles WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'No existe esa suela.' });
    try {
      await pool.query('DELETE FROM soles WHERE id=$1', [old.id]);
      res.json({ ok: true });
    } catch {
      res.status(409).json({ error: 'Esta suela tiene pedidos registrados, no se puede borrar.' });
    }
  } catch (e) { next(e); }
});

// ---------- Pedidos ----------
async function loadOrders(id) {
  const { rows: orders } = id
    ? await pool.query('SELECT * FROM orders WHERE id=$1', [id])
    : await pool.query('SELECT * FROM orders ORDER BY order_date DESC, id DESC');
  for (const o of orders) {
    o.order_date = o.order_date.toISOString().slice(0, 10);
    const { rows: items } = await pool.query(`SELECT i.*, s.name AS sole_name,
      COALESCE((SELECT SUM(qty) FROM receipts r WHERE r.item_id = i.id), 0) AS received
      FROM order_items i JOIN soles s ON s.id = i.sole_id WHERE i.order_id = $1 ORDER BY i.id`, [o.id]);
    o.items = [];
    for (const i of items) {
      i.qty = Number(i.qty); i.price = Number(i.price); i.received = Number(i.received);
      const { rows: receipts } = await pool.query('SELECT * FROM receipts WHERE item_id=$1 ORDER BY received_date, id', [i.id]);
      o.items.push({
        ...i, missing: Math.max(i.qty - i.received, 0), extra: Math.max(i.received - i.qty, 0),
        receipts: receipts.map(r => ({ ...r, qty: Number(r.qty), received_date: r.received_date.toISOString().slice(0, 10) })),
      });
    }
    o.total_ordered = o.items.reduce((t, i) => t + i.qty * i.price, 0);
    o.total_to_pay = o.items.reduce((t, i) => t + i.received * i.price, 0);
    const any = o.items.some(i => i.received), missing = o.items.some(i => i.missing), extra = o.items.some(i => i.extra);
    o.status = !any ? 'Pendiente' : missing ? 'Parcial' : extra ? 'Con sobrantes' : 'Completo';
  }
  return orders;
}
async function addStock(client, sole_id, size, delta) {
  await client.query(`INSERT INTO sole_sizes (sole_id, size, stock) VALUES ($1,$2,$3)
    ON CONFLICT (sole_id, size) DO UPDATE SET stock = GREATEST(sole_sizes.stock + EXCLUDED.stock, 0)`, [sole_id, size, delta]);
}

app.get('/api/orders', async (req, res, next) => { try { res.json(await loadOrders()); } catch (e) { next(e); } });

app.post('/api/orders', async (req, res, next) => {
  const { supplier, order_date, notes, items } = req.body;
  const valid = (items || []).filter(i => i.sole_id && String(i.size || '').trim() && i.qty > 0);
  if (!valid.length) return res.status(400).json({ error: 'Escribe cuántos pares pediste de al menos una talla.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO orders (supplier, order_date, notes) VALUES ($1,$2,$3) RETURNING id',
      [supplier || '', order_date || new Date().toISOString().slice(0, 10), notes || '']);
    for (const i of valid)
      await client.query('INSERT INTO order_items (order_id, sole_id, size, qty, price) VALUES ($1,$2,$3,$4,$5)',
        [rows[0].id, i.sole_id, String(i.size).trim(), Math.floor(i.qty), +i.price || 0]);
    await client.query('COMMIT');
    res.status(201).json((await loadOrders(rows[0].id))[0]);
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

// Registrar una llegada (total o parcial): suma al inventario de esa talla y guarda la fecha.
app.post('/api/orders/:id/receive', async (req, res, next) => {
  const { date, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of items || []) {
      const { rows: [row] } = await client.query('SELECT sole_id, size FROM order_items WHERE id=$1 AND order_id=$2', [it.item_id, req.params.id]);
      const qty = Math.floor(it.qty);
      if (!row || !(qty > 0)) continue;
      await client.query('INSERT INTO receipts (item_id, qty, received_date) VALUES ($1,$2,$3)',
        [it.item_id, qty, date || new Date().toISOString().slice(0, 10)]);
      await addStock(client, row.sole_id, row.size, qty);
    }
    await client.query('COMMIT');
    res.json((await loadOrders(req.params.id))[0]);
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

app.delete('/api/receipts/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: [r] } = await client.query(`SELECT r.*, i.sole_id, i.size FROM receipts r JOIN order_items i ON i.id = r.item_id WHERE r.id=$1`, [req.params.id]);
    if (!r) { client.release(); return res.status(404).json({ error: 'No existe esa llegada.' }); }
    await client.query('BEGIN');
    await addStock(client, r.sole_id, r.size, -r.qty);
    await client.query('DELETE FROM receipts WHERE id=$1', [r.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

app.delete('/api/orders/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { rows: recs } = await client.query(`SELECT r.qty, i.sole_id, i.size FROM receipts r JOIN order_items i ON i.id = r.item_id WHERE i.order_id=$1`, [req.params.id]);
    await client.query('BEGIN');
    for (const r of recs) await addStock(client, r.sole_id, r.size, -r.qty);
    await client.query('DELETE FROM orders WHERE id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) { await client.query('ROLLBACK'); next(e); } finally { client.release(); }
});

app.use((err, req, res, next) => { console.error(err); res.status(err.status || 500).json({ error: 'Error del servidor: ' + err.message }); });

const PORT = process.env.PORT || 3000;
init()
  .then(() => app.listen(PORT, '0.0.0.0', () => console.log(`Inventario listo en http://localhost:${PORT}`)))
  .catch(e => { console.error('No se pudo conectar a la base de datos:', e.message); process.exit(1); });
