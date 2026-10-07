import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'crypto';

const db = new Database('ziri.db');
db.exec(`
create table if not exists users(id integer primary key, name text, email text unique, hash text, role text, active int default 1);
create table if not exists sessions(token text primary key, user_id int);
create table if not exists orders(id integer primary key, shopify_id text unique, number text, customer text, phone text,
  wilaya text, address text, items text, total real, status text default 'new', assigned_to int, note text, tracking text,
  created_at text default current_timestamp, confirmed_at text, confirmed_by int);`);

const STATUSES = ['new', 'confirmed', 'no_answer', 'postponed', 'callback', 'cancelled', 'duplicate', 'shipped', 'delivered', 'returned'];
const hash = (p, s = crypto.randomBytes(8).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const check = (p, h) => { const [s] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(hash(p, s)), Buffer.from(h)); };

if (!db.prepare('select 1 from users').get()) {
  const e = process.env.ADMIN_EMAIL || 'admin@ziri.local', p = process.env.ADMIN_PASSWORD || 'ziri1234';
  db.prepare('insert into users(name,email,hash,role) values(?,?,?,?)').run('المدير', e, hash(p), 'owner');
  console.log(`Compte propriétaire créé : ${e} / ${p}  (changez-le !)`);
}

if (process.env.ADMIN_EMAIL) db.prepare("update users set email=? where role='owner'").run(process.env.ADMIN_EMAIL.toLowerCase());
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

const app = express();

// ---- Shopify webhook (orders/create) : doit lire le corps brut pour vérifier la signature ----
app.post('/webhooks/shopify', express.raw({ type: '*/*' }), (req, res) => {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || '';
  const sig = Buffer.from(req.get('x-shopify-hmac-sha256') || '');
  const mine = Buffer.from(crypto.createHmac('sha256', secret).update(req.body).digest('base64'));
  if (!secret || sig.length !== mine.length || !crypto.timingSafeEqual(sig, mine)) return res.sendStatus(401);
  const o = JSON.parse(req.body), a = o.shipping_address || {};
  // distribution automatique : le confirmateur actif ayant le moins de commandes « nouvelles »
  const rep = db.prepare(`select u.id from users u where role='confirmer' and active=1
    order by (select count(*) from orders where assigned_to=u.id and status='new') limit 1`).get();
  db.prepare(`insert or ignore into orders(shopify_id,number,customer,phone,wilaya,address,items,total,assigned_to) values(?,?,?,?,?,?,?,?,?)`)
    .run(String(o.id), o.name, a.name || o.customer?.first_name || '', a.phone || o.phone || '', a.province || a.city || '',
      [a.address1, a.city].filter(Boolean).join(', '), (o.line_items || []).map(i => `${i.title} ×${i.quantity}`).join(' | '),
      Number(o.total_price) || 0, rep?.id ?? null);
  res.sendStatus(200);
});

app.use(express.json());
app.use(express.static('public'));

// ---- Auth ----
app.post('/api/login', (req, res) => {
  const u = db.prepare('select * from users where email=? and active=1').get(req.body.email || '');
  if (!u || !u.hash || !check(req.body.password || '', u.hash)) return res.status(401).json({ error: 'بيانات غير صحيحة' });
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('insert into sessions values(?,?)').run(token, u.id);
  res.json({ token, user: { id: u.id, name: u.name, role: u.role } });
});

// ---- Connexion avec Google (OAuth2 / OpenID Connect) ----
const states = new Set();
const newSession = id => { const t = crypto.randomBytes(24).toString('hex'); db.prepare('insert into sessions values(?,?)').run(t, id); return t; };
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(12).toString('hex'); states.add(state);
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID || '', redirect_uri: BASE + '/auth/google/callback', response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account' }));
});
app.get('/auth/google/callback', async (req, res) => {
  try {
    if (!states.delete(req.query.state)) throw new Error('state');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: BASE + '/auth/google/callback', grant_type: 'authorization_code' }) });
    const j = await r.json(); if (!j.id_token) throw new Error('token');
    const p = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url')); // reçu directement de Google en HTTPS
    if (!p.email_verified) throw new Error('email');
    const u = db.prepare('select * from users where lower(email)=? and active=1').get(p.email.toLowerCase());
    if (!u) return res.redirect('/#err=not_invited'); // seuls les e-mails ajoutés par le propriétaire peuvent entrer
    res.redirect('/#t=' + newSession(u.id));
  } catch (e) { console.error('google', e.message); res.redirect('/#err=google'); }
});
const auth = (req, res, next) => {
  const t = (req.get('authorization') || '').replace('Bearer ', '');
  req.user = db.prepare('select u.* from sessions s join users u on u.id=s.user_id where s.token=? and u.active=1').get(t);
  req.user ? next() : res.status(401).json({ error: 'auth' });
};
app.get('/api/me', auth, (req, res) => res.json({ id: req.user.id, name: req.user.name, role: req.user.role }));
const owner = (req, res, next) => (req.user.role === 'owner' ? next() : res.sendStatus(403));
const mine = (req, id) => db.prepare('select * from orders where id=?').get(id) && (req.user.role === 'owner'
  ? db.prepare('select * from orders where id=?').get(id)
  : db.prepare('select * from orders where id=? and assigned_to=?').get(id, req.user.id));

// ---- Commandes ----
app.get('/api/orders', auth, (req, res) => {
  const { status = '', q = '' } = req.query, like = `%${q}%`;
  res.json(db.prepare(`select o.*, u.name as agent from orders o left join users u on u.id=o.assigned_to
    where (?='' or o.status=?) and (o.number like ? or o.customer like ? or o.phone like ?)
    and (?='owner' or o.assigned_to=?) order by o.id desc limit 500`)
    .all(status, status, like, like, like, req.user.role, req.user.id));
});
app.get('/api/stats', auth, (req, res) => {
  const rows = db.prepare(`select status, count(*) n, coalesce(sum(total),0) t from orders where (?='owner' or assigned_to=?) group by status`)
    .all(req.user.role, req.user.id);
  res.json(rows);
});
app.patch('/api/orders/:id', auth, (req, res) => {
  const o = mine(req, req.params.id); if (!o) return res.sendStatus(404);
  const { status, note, assigned_to } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'status' });
  db.prepare('update orders set status=coalesce(?,status), note=coalesce(?,note), assigned_to=coalesce(?,assigned_to) where id=?')
    .run(status ?? null, note ?? null, req.user.role === 'owner' ? assigned_to ?? null : null, o.id);
  res.json({ ok: true });
});
app.post('/api/orders/:id/confirm', auth, (req, res) => { // تأكيد بضغطة واحدة
  const o = mine(req, req.params.id); if (!o) return res.sendStatus(404);
  db.prepare("update orders set status='confirmed', confirmed_at=current_timestamp, confirmed_by=? where id=?").run(req.user.id, o.id);
  res.json({ ok: true });
});

// ---- Envoi à la société de livraison ----
async function sendToCarrier(o) {
  const { CARRIER_URL, CARRIER_TOKEN } = process.env;
  if (!CARRIER_URL) return { tracking: 'DEMO-' + o.number.replace('#', '') }; // mode test sans API
  // ⚠ Adaptez les noms de champs à la documentation de VOTRE société (Yalidine, ZR, Ecotrack...)
  const r = await fetch(CARRIER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CARRIER_TOKEN },
    body: JSON.stringify({ reference: o.number, client: o.customer, phone: o.phone, adresse: o.address, commune: o.wilaya, montant: o.total, produit: o.items }),
  });
  if (!r.ok) throw new Error('carrier ' + r.status);
  const j = await r.json();
  return { tracking: j.tracking || j.tracking_number || j.id };
}
app.post('/api/orders/:id/ship', auth, async (req, res) => {
  const o = mine(req, req.params.id); if (!o) return res.sendStatus(404);
  if (o.status !== 'confirmed') return res.status(400).json({ error: 'أكّد الطلب أولاً' });
  try {
    const { tracking } = await sendToCarrier(o);
    db.prepare("update orders set status='shipped', tracking=? where id=?").run(String(tracking), o.id);
    res.json({ tracking });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Équipe : confirmateurs / confirmatrices ----
app.get('/api/team', auth, owner, (req, res) => res.json(db.prepare(`select u.id,u.name,u.email,u.role,u.active,
  (select count(*) from orders where assigned_to=u.id) assigned,
  (select count(*) from orders where confirmed_by=u.id) confirmed from users u`).all()));
app.post('/api/team', auth, owner, async (req, res) => { // دعوة موظف بالبريد
  const { name, email } = req.body;
  if (!name || !/^\S+@\S+$/.test(email || '')) return res.status(400).json({ error: 'حقول ناقصة' });
  try { db.prepare('insert into users(name,email,role) values(?,?,?)').run(name, email.toLowerCase(), 'confirmer'); }
  catch { return res.status(409).json({ error: 'البريد مستعمل' }); }
  let mailed = false;
  if (process.env.SMTP_HOST) try {
    const nm = (await import('nodemailer')).default, port = Number(process.env.SMTP_PORT || 465);
    await nm.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } })
      .sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: email, subject: 'دعوة للانضمام إلى زيري',
        text: `مرحباً ${name}،\nتمت دعوتك للعمل كمؤكِّد/ة في زيري.\nافتح الرابط: ${BASE}\nثم اضغط "المتابعة مع Google" بحساب ${email}` });
    mailed = true;
  } catch (e) { console.error('mail', e.message); }
  res.json({ ok: true, link: BASE, mailed });
});
app.patch('/api/team/:id', auth, owner, (req, res) => {
  db.prepare("update users set active=? where id=? and role='confirmer'").run(req.body.active ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.listen(process.env.PORT || 3000, () => console.log('Ziri : http://localhost:' + (process.env.PORT || 3000)));
