const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const db = new Database(path.join(DATA, 'inventario.db'));
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS soles (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, photo TEXT,
  price REAL NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS sole_sizes (
  sole_id INTEGER NOT NULL REFERENCES soles(id) ON DELETE CASCADE,
  size TEXT NOT NULL, stock INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sole_id, size));
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, supplier TEXT DEFAULT '', order_date TEXT NOT NULL, notes TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sole_id INTEGER NOT NULL REFERENCES soles(id), qty INTEGER NOT NULL, price REAL NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  qty INTEGER NOT NULL, received_date TEXT NOT NULL);
`);
// Migración de la versión sin tallas: lo que ya existía queda en la talla "Única".
if (!db.prepare('PRAGMA table_info(order_items)').all().some(c => c.name === 'size'))
  db.exec("ALTER TABLE order_items ADD COLUMN size TEXT NOT NULL DEFAULT 'Única'");
db.exec(`INSERT INTO sole_sizes (sole_id, size, stock) SELECT id, 'Única', stock FROM soles
         WHERE stock > 0 AND id NOT IN (SELECT sole_id FROM sole_sizes); UPDATE soles SET stock = 0;`);

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
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS));

// ---------- Fotos ----------
function savePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, file), Buffer.from(m[2], 'base64'));
  return file;
}
const removePhoto = f => f && fs.rm(path.join(UPLOADS, f), () => {});

// ---------- Tallas ----------
const cleanSizes = list => {
  const seen = new Map();
  for (const s of list || []) {
    const size = String(s.size ?? '').trim();
    if (size) seen.set(size, Math.max(0, Math.floor(s.stock) || 0));
  }
  return [...seen];
};
const setSizes = (id, sizes) => {
  db.prepare('DELETE FROM sole_sizes WHERE sole_id=?').run(id);
  const ins = db.prepare('INSERT INTO sole_sizes (sole_id, size, stock) VALUES (?,?,?)');
  for (const [size, stock] of sizes) ins.run(id, size, stock);
};

// ---------- Suelas (CRUD) ----------
function loadSoles(id) {
  const soles = id ? db.prepare('SELECT * FROM soles WHERE id=?').all(id) : db.prepare('SELECT * FROM soles ORDER BY name').all();
  const sz = db.prepare('SELECT size, stock FROM sole_sizes WHERE sole_id=?');
  for (const s of soles) {
    s.sizes = sz.all(s.id).sort((a, b) => a.size.localeCompare(b.size, 'es', { numeric: true }));
    s.stock = s.sizes.reduce((t, x) => t + x.stock, 0);
  }
  return soles;
}
app.get('/api/soles', (req, res) => res.json(loadSoles()));

app.post('/api/soles', (req, res) => {
  const { name, price, notes, photo } = req.body;
  const sizes = cleanSizes(req.body.sizes);
  if (!name || !name.trim()) return res.status(400).json({ error: 'Falta el nombre de la suela.' });
  if (!sizes.length) return res.status(400).json({ error: 'Agrega al menos una talla.' });
  const file = savePhoto(photo);
  if (!file) return res.status(400).json({ error: 'Falta la foto de la suela.' });
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO soles (name, photo, price, stock, notes) VALUES (?,?,?,0,?)')
      .run(name.trim(), file, +price || 0, notes || '');
    setSizes(r.lastInsertRowid, sizes);
    return r.lastInsertRowid;
  })();
  res.status(201).json(loadSoles(id)[0]);
});

app.put('/api/soles/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM soles WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'No existe esa suela.' });
  const { name, price, notes, photo } = req.body;
  const sizes = cleanSizes(req.body.sizes);
  if (!sizes.length) return res.status(400).json({ error: 'Agrega al menos una talla.' });
  const file = savePhoto(photo);
  db.transaction(() => {
    db.prepare('UPDATE soles SET name=?, photo=?, price=?, notes=? WHERE id=?')
      .run((name || old.name).trim(), file || old.photo, +price || 0, notes || '', old.id);
    setSizes(old.id, sizes);
  })();
  if (file) removePhoto(old.photo);
  res.json(loadSoles(old.id)[0]);
});

app.delete('/api/soles/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM soles WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'No existe esa suela.' });
  try {
    db.prepare('DELETE FROM soles WHERE id=?').run(old.id);
    removePhoto(old.photo);
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Esta suela tiene pedidos registrados, no se puede borrar.' });
  }
});

// ---------- Pedidos ----------
function loadOrders(id) {
  const orders = id
    ? db.prepare('SELECT * FROM orders WHERE id=?').all(id)
    : db.prepare('SELECT * FROM orders ORDER BY order_date DESC, id DESC').all();
  const items = db.prepare(`SELECT i.*, s.name AS sole_name,
    COALESCE((SELECT SUM(qty) FROM receipts r WHERE r.item_id = i.id), 0) AS received
    FROM order_items i JOIN soles s ON s.id = i.sole_id WHERE i.order_id = ? ORDER BY i.id`);
  const recs = db.prepare('SELECT * FROM receipts WHERE item_id=? ORDER BY received_date, id');
  for (const o of orders) {
    o.items = items.all(o.id).map(i => ({
      ...i, missing: Math.max(i.qty - i.received, 0), extra: Math.max(i.received - i.qty, 0), receipts: recs.all(i.id),
    }));
    o.total_ordered = o.items.reduce((t, i) => t + i.qty * i.price, 0);
    o.total_to_pay = o.items.reduce((t, i) => t + i.received * i.price, 0);
    const any = o.items.some(i => i.received), missing = o.items.some(i => i.missing), extra = o.items.some(i => i.extra);
    o.status = !any ? 'Pendiente' : missing ? 'Parcial' : extra ? 'Con sobrantes' : 'Completo';
  }
  return orders;
}
const addStock = db.prepare(`INSERT INTO sole_sizes (sole_id, size, stock) VALUES (?,?,?)
  ON CONFLICT(sole_id, size) DO UPDATE SET stock = MAX(stock + excluded.stock, 0)`);

app.get('/api/orders', (req, res) => res.json(loadOrders()));

app.post('/api/orders', (req, res) => {
  const { supplier, order_date, notes, items } = req.body;
  const valid = (items || []).filter(i => i.sole_id && String(i.size || '').trim() && i.qty > 0);
  if (!valid.length) return res.status(400).json({ error: 'Escribe cuántos pares pediste de al menos una talla.' });
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO orders (supplier, order_date, notes) VALUES (?,?,?)')
      .run(supplier || '', order_date || new Date().toISOString().slice(0, 10), notes || '');
    const ins = db.prepare('INSERT INTO order_items (order_id, sole_id, size, qty, price) VALUES (?,?,?,?,?)');
    for (const i of valid) ins.run(r.lastInsertRowid, i.sole_id, String(i.size).trim(), Math.floor(i.qty), +i.price || 0);
    return r.lastInsertRowid;
  })();
  res.status(201).json(loadOrders(id)[0]);
});

// Registrar una llegada (total o parcial): suma al inventario de esa talla y guarda la fecha.
app.post('/api/orders/:id/receive', (req, res) => {
  const { date, items } = req.body;
  const find = db.prepare('SELECT sole_id, size FROM order_items WHERE id=? AND order_id=?');
  db.transaction(() => {
    for (const it of items || []) {
      const row = find.get(it.item_id, req.params.id);
      const qty = Math.floor(it.qty);
      if (!row || !(qty > 0)) continue;
      db.prepare('INSERT INTO receipts (item_id, qty, received_date) VALUES (?,?,?)')
        .run(it.item_id, qty, date || new Date().toISOString().slice(0, 10));
      addStock.run(row.sole_id, row.size, qty);
    }
  })();
  res.json(loadOrders(req.params.id)[0]);
});

app.delete('/api/receipts/:id', (req, res) => {
  const r = db.prepare(`SELECT r.*, i.sole_id, i.size FROM receipts r JOIN order_items i ON i.id = r.item_id WHERE r.id=?`).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No existe esa llegada.' });
  db.transaction(() => {
    addStock.run(r.sole_id, r.size, -r.qty);
    db.prepare('DELETE FROM receipts WHERE id=?').run(r.id);
  })();
  res.json({ ok: true });
});

app.delete('/api/orders/:id', (req, res) => {
  const recs = db.prepare(`SELECT r.qty, i.sole_id, i.size FROM receipts r JOIN order_items i ON i.id = r.item_id WHERE i.order_id=?`).all(req.params.id);
  db.transaction(() => {
    for (const r of recs) addStock.run(r.sole_id, r.size, -r.qty);
    db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  })();
  res.json({ ok: true });
});

app.use((err, req, res, next) => res.status(500).json({ error: 'Error del servidor: ' + err.message }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Inventario listo en http://localhost:${PORT}`));
