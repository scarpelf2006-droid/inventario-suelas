const $ = (s, el = document) => el.querySelector(s);
const money = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
const today = () => new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD en hora local
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, method = 'GET', body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('No hay conexión con el servidor. Ejecuta npm start y abre http://localhost:3000'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ocurrió un error inesperado.');
  return data;
}
const run = async fn => { try { await fn(); } catch (e) { alert(e.message); } };

const modal = $('#modal');
const openModal = html => { modal.innerHTML = html; modal.showModal(); };
const closeModal = () => modal.close();
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

let tab = 'soles', soles = [], ordersCache = [], photoData = null;
const render = () => (tab === 'soles' ? renderSoles() : renderOrders());
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  render();
});

/* ---------- Suelas ---------- */
async function renderSoles() {
  soles = await api('/api/soles');
  $('#view').innerHTML = `
    <div class="bar"><input id="q" type="search" placeholder="Buscar suela"><button class="btn primary" onclick="soleForm()">Nueva suela</button></div>
    <div class="grid" id="grid"></div>`;
  const draw = () => {
    const q = $('#q').value.toLowerCase();
    $('#grid').innerHTML = soles.filter(s => s.name.toLowerCase().includes(q)).map(soleCard).join('')
      || '<p class="empty">No hay suelas todavía. Toca “Nueva suela” y toma una foto.</p>';
  };
  $('#q').oninput = draw; draw();
}
const soleCard = s => `<article class="card">
  ${s.photo ? `<img src="${s.photo}" alt="${esc(s.name)}">` : '<div class="noimg">Sin foto</div>'}
  <h3>${esc(s.name)}</h3>
  <p class="stock"><b>${s.stock}</b> pares en total</p>
  <div class="sizes">${s.sizes.map(x => `<span class="chip ${x.stock ? '' : 'zero'}">Talla <b>${esc(x.size)}</b>: ${x.stock}</span>`).join('')}</div>
  <p class="muted">${money(s.price)} por par</p>
  <p class="muted">Valor en bodega: ${money(s.stock * s.price)}</p>
  ${s.notes ? `<p class="muted">${esc(s.notes)}</p>` : ''}
  <div class="row"><button class="btn" onclick="soleForm(${s.id})">Editar</button><button class="btn danger" onclick="delSole(${s.id})">Borrar</button></div>
</article>`;

function soleForm(id) {
  const s = soles.find(x => x.id === id) || { name: '', price: '', notes: '', sizes: [] };
  photoData = null;
  openModal(`<h2>${id ? 'Editar suela' : 'Nueva suela'}</h2>
    <div class="photo">
      <img id="prev" alt="Foto de la suela" ${s.photo ? `src="${s.photo}"` : 'hidden'}>
      <label class="btn primary">Tomar foto<input type="file" accept="image/*" capture="environment" hidden onchange="pickPhoto(this)"></label>
      <label class="btn">Elegir de la galería<input type="file" accept="image/*" hidden onchange="pickPhoto(this)"></label>
    </div>
    <label>Nombre o referencia<input id="f-name" value="${esc(s.name)}"></label>
    <label>Precio por par (COP)<input id="f-price" type="number" min="0" inputmode="numeric" value="${s.price}"></label>
    <label>Notas (color, proveedor…)<input id="f-notes" value="${esc(s.notes)}"></label>
    <h3 style="margin-top:18px">Tallas y pares</h3>
    <div class="line range"><input id="r-from" type="number" inputmode="numeric" placeholder="Desde talla"><input id="r-to" type="number" inputmode="numeric" placeholder="Hasta talla"><button class="btn" onclick="addRange()">Crear rango</button></div>
    <div id="sizes"></div>
    <button class="btn" onclick="addSize()">Agregar una talla</button>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveSole(${id || 0})">Guardar suela</button></div>`);
  s.sizes.length ? s.sizes.forEach(x => addSize(x.size, x.stock)) : addSize();
}
function addSize(size = '', stock = 0) {
  const d = document.createElement('div'); d.className = 'line srow';
  d.innerHTML = `<input class="s-size" placeholder="Talla" value="${esc(size)}"><input class="s-stock" type="number" min="0" inputmode="numeric" placeholder="Pares" value="${stock}"><button class="link" onclick="this.parentNode.remove()">Quitar</button>`;
  $('#sizes').appendChild(d);
}
function addRange() {
  const a = +$('#r-from').value, b = +$('#r-to').value;
  if (!(a > 0 && b >= a && b - a <= 40)) return alert('Escribe la talla inicial y la final, por ejemplo de 34 a 40.');
  const have = new Set([...document.querySelectorAll('.s-size')].map(i => i.value.trim()));
  [...document.querySelectorAll('.srow')].filter(r => !$('.s-size', r).value.trim()).forEach(r => r.remove());
  for (let n = a; n <= b; n++) if (!have.has(String(n))) addSize(n, 0);
}
function pickPhoto(input) {
  const file = input.files[0]; if (!file) return;
  const img = new Image();
  img.onload = () => { // reduce la foto para que pese poco
    const k = Math.min(1, 900 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    photoData = c.toDataURL('image/jpeg', 0.8);
    $('#prev').src = photoData; $('#prev').hidden = false;
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
}
const saveSole = id => run(async () => {
  const sizes = [...document.querySelectorAll('.srow')].map(r => ({ size: $('.s-size', r).value.trim(), stock: +$('.s-stock', r).value })).filter(x => x.size);
  const body = { name: $('#f-name').value.trim(), price: +$('#f-price').value, notes: $('#f-notes').value.trim(), photo: photoData, sizes };
  if (!body.name) return alert('Escribe el nombre o referencia de la suela.');
  if (!id && !photoData) return alert('Toma una foto de la suela para poder reconocerla.');
  if (!sizes.length) return alert('Agrega al menos una talla con su cantidad de pares.');
  await api(id ? `/api/soles/${id}` : '/api/soles', id ? 'PUT' : 'POST', body);
  closeModal(); render();
});
const delSole = id => confirm('¿Borrar esta suela?') && run(async () => { await api(`/api/soles/${id}`, 'DELETE'); render(); });

/* ---------- Pedidos ---------- */
const badge = { Pendiente: 'b-red', Parcial: 'b-amber', Completo: 'b-green', 'Con sobrantes': 'b-blue' };

async function renderOrders() {
  ordersCache = await api('/api/orders');
  $('#view').innerHTML = `<div class="bar"><h2>Pedidos</h2><button class="btn primary" onclick="orderForm()">Nuevo pedido</button></div>`
    + (ordersCache.map(orderCard).join('') || '<p class="empty">No hay pedidos todavía.</p>');
}
function orderCard(o) {
  return `<section class="order">
    <div class="ohead"><div><h3>Pedido ${o.id}${o.supplier ? ', ' + esc(o.supplier) : ''}</h3>
      <p class="muted">Hecho el ${fmtDate(o.order_date)}. ${esc(o.notes)}</p></div>
      <span class="badge ${badge[o.status]}">${o.status}</span></div>
    <div class="scroll"><table>
      <thead><tr><th>Suela</th><th>Talla</th><th>Pedidos</th><th>Llegaron</th><th>Faltan</th><th>Sobran</th><th>Precio par</th><th>A pagar</th></tr></thead>
      <tbody>${o.items.map(i => `<tr><td>${esc(i.sole_name)}</td><td>${esc(i.size)}</td><td>${i.qty}</td><td>${i.received}</td>
        <td class="${i.missing ? 'bad' : ''}">${i.missing || '–'}</td><td class="${i.extra ? 'warn' : ''}">${i.extra || '–'}</td>
        <td>${money(i.price)}</td><td>${money(i.received * i.price)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="totals"><span>Valor total del pedido: <b>${money(o.total_ordered)}</b></span>
      <span class="pay">Total a pagar por lo que ha llegado: <b>${money(o.total_to_pay)}</b></span></div>
    ${arrivals(o)}
    <div class="row"><button class="btn primary" onclick="receiveForm(${o.id})">Registrar llegada</button>
      <button class="btn danger" onclick="delOrder(${o.id})">Borrar pedido</button></div>
  </section>`;
}
function arrivals(o) {
  const rows = o.items.flatMap(i => i.receipts.map(r => ({ ...r, name: i.sole_name, size: i.size })))
    .sort((a, b) => a.received_date.localeCompare(b.received_date) || a.id - b.id);
  if (!rows.length) return '<p class="muted">Todavía no ha llegado nada de este pedido.</p>';
  return `<details><summary>Historial de llegadas (${rows.length})</summary><ul class="hist">${rows.map(r =>
    `<li>${fmtDate(r.received_date)}: llegaron ${r.qty} pares de ${esc(r.name)}, talla ${esc(r.size)} <button class="link" onclick="delReceipt(${r.id})">Quitar</button></li>`).join('')}</ul></details>`;
}

async function orderForm() {
  soles = await api('/api/soles');
  if (!soles.length) return alert('Primero crea al menos una suela en la pestaña Suelas.');
  openModal(`<h2>Nuevo pedido</h2>
    <label>Proveedor<input id="o-sup"></label>
    <label>Fecha del pedido<input id="o-date" type="date" value="${today()}"></label>
    <label>Notas<input id="o-notes"></label>
    <h3 style="margin-top:18px">Suelas pedidas</h3>
    <p class="muted">Elige la suela y escribe cuántos pares pediste de cada talla.</p>
    <div id="lines"></div>
    <button class="btn" onclick="addBlock()">Agregar otra suela</button>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveOrder()">Guardar pedido</button></div>`);
  addBlock();
}
const sizeInputs = s => s.sizes.map(x => `<label>Talla ${esc(x.size)}<input type="number" min="0" inputmode="numeric" data-size="${esc(x.size)}"></label>`).join('');
function addBlock() {
  const d = document.createElement('div'); d.className = 'block';
  d.innerHTML = `<div class="line bl"><select onchange="pickSole(this)">${soles.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
    <input class="l-price" type="number" min="0" inputmode="numeric" placeholder="Precio par" value="${soles[0].price}"></div>
    <div class="szgrid">${sizeInputs(soles[0])}</div>`;
  $('#lines').appendChild(d);
}
function pickSole(sel) {
  const s = soles.find(x => x.id == sel.value), b = sel.closest('.block');
  $('.l-price', b).value = s.price; $('.szgrid', b).innerHTML = sizeInputs(s);
}
const saveOrder = () => run(async () => {
  const items = [];
  document.querySelectorAll('.block').forEach(b => {
    const sole_id = +$('select', b).value, price = +$('.l-price', b).value;
    b.querySelectorAll('[data-size]').forEach(i => { if (+i.value > 0) items.push({ sole_id, size: i.dataset.size, qty: +i.value, price }); });
  });
  if (!items.length) return alert('Escribe cuántos pares pediste de al menos una talla.');
  await api('/api/orders', 'POST', { supplier: $('#o-sup').value.trim(), order_date: $('#o-date').value, notes: $('#o-notes').value.trim(), items });
  closeModal(); render();
});

function receiveForm(id) {
  const o = ordersCache.find(x => x.id === id);
  openModal(`<h2>Registrar llegada del pedido ${o.id}</h2>
    <label>Fecha de llegada<input id="r-date" type="date" value="${today()}"></label>
    <p class="muted">Escribe cuántos pares llegaron de cada talla. Deja 0 en lo que no llegó.</p>
    ${o.items.map(i => `<div class="line rl"><span>${esc(i.sole_name)}, talla ${esc(i.size)}<small class="muted">Faltan ${i.missing} pares</small></span>
      <input type="number" min="0" inputmode="numeric" value="0" data-item="${i.id}"></div>`).join('')}
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveReceive(${o.id})">Guardar llegada</button></div>`);
}
const saveReceive = id => run(async () => {
  const items = [...document.querySelectorAll('[data-item]')].map(i => ({ item_id: +i.dataset.item, qty: +i.value })).filter(i => i.qty > 0);
  if (!items.length) return alert('Escribe al menos un par que haya llegado.');
  await api(`/api/orders/${id}/receive`, 'POST', { date: $('#r-date').value, items });
  closeModal(); render();
});
const delReceipt = id => confirm('¿Quitar esta llegada? El inventario se ajusta solo.') && run(async () => { await api(`/api/receipts/${id}`, 'DELETE'); render(); });
const delOrder = id => confirm('¿Borrar el pedido completo? El inventario se ajusta solo.') && run(async () => { await api(`/api/orders/${id}`, 'DELETE'); render(); });

render();
