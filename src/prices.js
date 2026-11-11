// Price book: the office price sheets as data. Everyone can look prices up; admins change them.
// Work orders copy the price into their own lines (job_lines), so changing a price never changes old jobs.
const { seedItems, CATEGORIES, CATEGORY_NOTES, LAGOON_MEMBERS, slug } = require('./priceSeed');
const { currentActor } = require('./actor');

class PriceError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const DEFAULT_START = '116 William St, Parry Sound, ON P2A 1V8';
const str = (v, max = 300) => (v == null ? '' : String(v).trim().slice(0, max));
const money = (v) => (v == null ? 'no set price' : `$${Number(v).toFixed(2)}`);

function priceValue(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1e6) throw new PriceError(`"${v}" isn't a price`);
  return Math.round(n * 10000) / 10000;
}

function createPrices(db) {
  async function getSetting(key, fallback) {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? row.value : fallback;
  }
  async function setSetting(key, value) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  /** Fill an empty price book from the price sheets (first start only). */
  async function seed() {
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM price_items')).n);
    if (n) return 0;
    const items = seedItems();
    await db.tx(async (t) => {
      for (const it of items) {
        await t.run(`INSERT INTO price_items (key, category, grp, name, unit, price, taxable, max_km, notes, sort)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, it.key, it.category, it.grp, it.name, it.unit, it.price, it.taxable, it.max_km, it.notes, it.sort);
      }
    });
    return items.length;
  }

  async function settings() {
    return {
      start_address: await getSetting('price_start_address', DEFAULT_START),
      hst_rate: Number(await getSetting('price_hst_rate', '13')),
      members: JSON.parse(await getSetting('price_lagoon_members', JSON.stringify(LAGOON_MEMBERS))),
    };
  }

  async function saveSettings(data) {
    const before = await settings();
    const changes = [];
    if ('start_address' in data) {
      const a = str(data.start_address, 200);
      if (!a) throw new PriceError('Enter the starting address for delivery distances');
      if (a !== before.start_address) { await setSetting('price_start_address', a); changes.push(`Starting address: ${before.start_address} → ${a}`); }
    }
    if ('hst_rate' in data) {
      const r = Number(data.hst_rate);
      if (!Number.isFinite(r) || r < 0 || r > 30) throw new PriceError('HST must be a percentage, e.g. 13');
      if (r !== before.hst_rate) { await setSetting('price_hst_rate', String(r)); changes.push(`HST: ${before.hst_rate}% → ${r}%`); }
    }
    if ('members' in data) {
      const list = (Array.isArray(data.members) ? data.members : String(data.members).split(/[,\n]/)).map((m) => str(m, 60)).filter(Boolean);
      if (list.join('|') !== before.members.join('|')) {
        await setSetting('price_lagoon_members', JSON.stringify(list));
        changes.push(`Lagoon members: ${list.join(', ')}`);
      }
    }
    for (const c of changes) await db.run('INSERT INTO price_changes (item_name, change, actor) VALUES (?, ?, ?)', 'Pricing settings', c, currentActor());
    return settings();
  }

  async function list({ includeInactive = false } = {}) {
    return db.all(`SELECT * FROM price_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, id`);
  }

  /** What the pricing calculator needs (public/pricing.js). */
  async function book() {
    const items = {};
    for (const it of await list()) {
      items[it.key] = { name: it.name, unit: it.unit, price: it.price, taxable: it.taxable, max_km: it.max_km, grp: it.grp, category: it.category };
    }
    const s = await settings();
    return { items, members: s.members, hst_rate: s.hst_rate, start_address: s.start_address };
  }

  /** Admin edits: [{ id, price, name, unit, notes, taxable, active }] or new items [{ category, name, unit, price }]. */
  async function save(changes) {
    const out = [];
    for (const c of Array.isArray(changes) ? changes : [changes]) {
      if (c.id) {
        const it = await db.get('SELECT * FROM price_items WHERE id = ?', Number(c.id));
        if (!it) throw new PriceError('Price not found');
        const next = {
          price: 'price' in c ? priceValue(c.price) : it.price,
          name: 'name' in c ? str(c.name, 200) || it.name : it.name,
          unit: 'unit' in c ? str(c.unit, 40) : it.unit,
          notes: 'notes' in c ? str(c.notes, 500) : it.notes,
          taxable: 'taxable' in c ? (c.taxable ? 1 : 0) : it.taxable,
          active: 'active' in c ? (c.active ? 1 : 0) : it.active,
        };
        const log = [];
        if (Number(next.price ?? -1) !== Number(it.price ?? -1)) log.push(`${money(it.price)} → ${money(next.price)}`);
        if (next.name !== it.name) log.push(`renamed from "${it.name}"`);
        if (next.unit !== it.unit) log.push(`unit: ${it.unit || '(none)'} → ${next.unit || '(none)'}`);
        if (next.notes !== it.notes) log.push('note changed');
        if (next.taxable !== it.taxable) log.push(next.taxable ? 'now charged HST' : 'now HST-exempt');
        if (next.active !== it.active) log.push(next.active ? 'put back on the price list' : 'taken off the price list');
        if (!log.length) { out.push(it); continue; }
        await db.run(`UPDATE price_items SET price = ?, name = ?, unit = ?, notes = ?, taxable = ?, active = ?, updated_at = datetime('now') WHERE id = ?`,
          next.price, next.name, next.unit, next.notes, next.taxable, next.active, it.id);
        await db.run('INSERT INTO price_changes (item_id, item_name, change, actor) VALUES (?, ?, ?, ?)', it.id, next.name, log.join('; '), currentActor());
        out.push(await db.get('SELECT * FROM price_items WHERE id = ?', it.id));
      } else {
        const category = CATEGORIES.some(([k]) => k === c.category) ? c.category : 'other';
        const name = str(c.name, 200);
        if (!name) throw new PriceError('Give the new price a name');
        const price = priceValue(c.price);
        let key = `${category}.custom.${slug(name)}`;
        if (await db.get('SELECT id FROM price_items WHERE key = ?', key)) key += `-${Date.now().toString(36)}`;
        const max = Number((await db.get('SELECT MAX(sort) AS m FROM price_items')).m) || 0;
        const r = await db.run(`INSERT INTO price_items (key, category, name, unit, price, taxable, notes, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          key, category, name, str(c.unit, 40), price, c.taxable === false || c.taxable === 0 ? 0 : 1, str(c.notes, 500), max + 1);
        await db.run('INSERT INTO price_changes (item_id, item_name, change, actor) VALUES (?, ?, ?, ?)', Number(r.lastInsertRowid), name, `added at ${money(price)}`, currentActor());
        out.push(await db.get('SELECT * FROM price_items WHERE id = ?', Number(r.lastInsertRowid)));
      }
    }
    return out;
  }

  async function changes(limit = 100) {
    return db.all('SELECT * FROM price_changes ORDER BY id DESC LIMIT ?', limit);
  }

  return { seed, list, book, save, settings, saveSettings, changes, categories: CATEGORIES, categoryNotes: CATEGORY_NOTES };
}

module.exports = { createPrices, PriceError, DEFAULT_START };
