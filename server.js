const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS customer_transactions (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
      counterparty TEXT,
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT DEFAULT 'USD',
      reference TEXT UNIQUE,
      note TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers (
      phone TEXT PRIMARY KEY,
      pin TEXT NOT NULL,
      name TEXT,
      balance NUMERIC(12,2) DEFAULT 0
    );
  `);

  // 测试客户
  await db.query(
    `INSERT INTO customers (phone, pin, name, balance) VALUES ($1,$2,$3,$4)
     ON CONFLICT (phone) DO NOTHING`,
    ['0979935561', '123456', 'Test User', 10809.36]
  );

  // 检查是否已有数据
  const { rows } = await db.query(`SELECT COUNT(*)::int AS c FROM customer_transactions WHERE phone='0979935561'`);
  if (rows[0].c === 0) {
    const seed = require('./seed-data');
    for (const t of seed) {
      await db.query(
        `INSERT INTO customer_transactions (phone, direction, counterparty, amount, currency, reference, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [t.phone, t.direction, t.counterparty, t.amount, t.currency, t.reference, t.note, t.created_at]
      );
    }
    console.log(`Seeded ${seed.length} transactions for 0979935561`);
  } else {
    console.log(`Already have ${rows[0].c} transactions, skip seeding.`);
  }
}

// 登录
app.post('/api/auth/login', async (req, res) => {
  const { phone, pin } = req.body || {};
  if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
  const { rows } = await db.query(`SELECT phone, name, balance FROM customers WHERE phone=$1 AND pin=$2`, [phone, pin]);
  if (rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
  res.json({ ok: true, customer: rows[0] });
});

// 按手机号查交易流水
app.get('/api/wallet/transactions-by-phone', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone query param required' });
  const { rows } = await db.query(
    `SELECT * FROM customer_transactions WHERE phone=$1 ORDER BY created_at DESC`,
    [phone]
  );
  res.json({ phone, count: rows.length, transactions: rows });
});

// 账户信息
app.get('/api/wallet/account', async (req, res) => {
  const phone = req.query.phone;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const { rows } = await db.query(`SELECT phone, name, balance FROM customers WHERE phone=$1`, [phone]);
  if (rows.length === 0) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// 记录一笔交易
app.post('/api/wallet/transactions/record', async (req, res) => {
  const { phone, direction, counterparty, amount, currency, reference, note } = req.body || {};
  if (!phone || !direction || !amount) return res.status(400).json({ error: 'missing fields' });
  const ref = reference || `REF-${Date.now()}`;
  const { rows } = await db.query(
    `INSERT INTO customer_transactions (phone, direction, counterparty, amount, currency, reference, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [phone, direction, counterparty || '', amount, currency || 'USD', ref, note || '']
  );
  res.json({ ok: true, transaction: rows[0] });
});

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

initDB().then(() => {
  app.listen(PORT, () => console.log(`Wallet testnet running on http://localhost:${PORT}`));
}).catch(e => { console.error('DB init failed', e); process.exit(1); });
