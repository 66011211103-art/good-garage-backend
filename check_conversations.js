require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const conv = await pool.query('SELECT id, customer_id, garage_id, created_at FROM conversations ORDER BY id');
  console.log('conversations:', JSON.stringify(conv.rows, null, 2));

  const msgCount = await pool.query('SELECT conversation_id, COUNT(*) FROM messages GROUP BY conversation_id ORDER BY conversation_id');
  console.log('messages per conversation:', JSON.stringify(msgCount.rows, null, 2));

  const customers = await pool.query('SELECT c.user_id, c.first_name, c.last_name, u.email FROM customers c JOIN users u ON u.id = c.user_id ORDER BY c.user_id');
  console.log('customers (user_id list):', JSON.stringify(customers.rows, null, 2));

  const garages = await pool.query('SELECT g.user_id, g.shop_name FROM garages g ORDER BY g.user_id');
  console.log('garages (user_id list):', JSON.stringify(garages.rows, null, 2));

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
