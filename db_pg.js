// db_pg.js
// ============================================================================
// ✅ Compatibility shim: server.js/wallet_routes.js/commission.js ทั้งหมดเขียนไว้
// สำหรับ mysql2 (ทั้งแบบ callback `db` และแบบ promise `dbPool`) — แทนที่จะไปแก้
// query กว่า 100 จุดทั่วโปรเจกต์ (เสี่ยงพังของเดิมมาก) ไฟล์นี้จำลอง API หน้าตา
// เดียวกับ mysql2 ทุกจุดที่โค้ดเดิมใช้จริง แต่ข้างในต่อ Postgres (Supabase) แทน
//
// รองรับ:
//   - db.connect(callback)
//   - db.query(sql, callback)                  แบบ callback ไม่มี params
//   - db.query(sql, params, callback)          แบบ callback มี params
//   - await dbPool.query(sql, params) -> [rows, fields]        (เหมือน mysql2/promise)
//   - await dbPool.getConnection() -> conn ที่มี .query()/.beginTransaction()/
//     .commit()/.rollback()/.release() ครบ (ใช้กับ transaction ใน wallet_routes.js/commission.js)
//
// สิ่งที่แปลงให้อัตโนมัติ (โค้ดเดิมไม่ต้องรู้เรื่องเลย):
//   1) placeholder "?" (MySQL) -> "$1, $2, ..." (Postgres)
//   2) "IN (?)" ที่ผูกกับค่าพารามิเตอร์เป็น array (mysql2 ขยายให้อัตโนมัติ แต่ pg ไม่ทำให้)
//      -> แปลงเป็น "= ANY($N)" แทน ซึ่ง pg รองรับ array parameter ตรงๆ อยู่แล้ว
//   3) ผลลัพธ์ของ SELECT -> array ของ row object เหมือนเดิม (result.command === 'SELECT')
//   4) ผลลัพธ์ของ INSERT/UPDATE/DELETE -> object ที่มี .insertId/.affectedRows เหมือน
//      mysql2 ResultSetHeader (ต้องมี "RETURNING id" ต่อท้าย INSERT ที่จะอ่าน .insertId —
//      แก้ไว้ในทุกจุดของ server.js/wallet_routes.js ที่จำเป็นแล้ว)
// ============================================================================

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ ไม่พบ DATABASE_URL ใน .env — ต้องตั้งค่าเป็น connection string ของ Supabase ก่อนรัน server');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase pooler ต้องใช้ SSL เสมอ
  max: 10, // ✅ ต่อผ่าน Supabase session pooler อยู่แล้ว ไม่ต้องเปิด connection เยอะฝั่งเรา
});

pool.on('error', (err) => {
  console.error('❌ Postgres pool error (idle client):', err.message);
});

// ---------------------------------------------------------------------------
// แปลง SQL string จาก MySQL placeholder เป็น Postgres placeholder
// จับ "IN (?)" เป็นกรณีพิเศษ -> "= ANY($N)" (ต้องมาก่อนเพื่อกันไม่ให้ regex ตัวถัดไป
// จับ "?" ข้างในซ้ำอีกที เพราะ "IN (?)" ทั้งก้อนถูก consume ไปแล้วในรอบเดียว)
// ---------------------------------------------------------------------------
function translate(sql, params = []) {
  let paramIndex = 0;
  let srcIndex = 0; // ตำแหน่งใน params ต้นฉบับ (นับตาม ? ตัวที่เท่าไหร่ รวม IN(?) เป็น 1 ตำแหน่ง)
  const outParams = [];

  const translatedSql = sql.replace(/\bIN\s*\(\s*\?\s*\)|\?/g, (match) => {
    const value = params[srcIndex];
    srcIndex += 1;
    paramIndex += 1;
    outParams.push(value);
    return match.trim().toUpperCase().startsWith('IN') ? `= ANY($${paramIndex})` : `$${paramIndex}`;
  });

  return { sql: translatedSql, params: outParams };
}

// แปลงผลลัพธ์ pg ให้หน้าตาเหมือน mysql2 (rows array สำหรับ SELECT, ResultSetHeader
// object สำหรับ INSERT/UPDATE/DELETE)
function shapeResult(result) {
  if (result.command === 'SELECT') {
    return result.rows;
  }
  const header = {
    insertId: result.rows && result.rows[0] ? result.rows[0].id : undefined,
    affectedRows: result.rowCount,
    changedRows: result.rowCount,
  };
  return header;
}

// ---------------------------------------------------------------------------
// db — callback-style (แทน mysql2 ธรรมดา, ใช้ทั่วทั้ง server.js)
// ---------------------------------------------------------------------------
const db = {
  connect(callback) {
    pool
      .query('SELECT 1')
      .then(() => {
        console.log('✅ เชื่อมต่อ Postgres (Supabase) สำเร็จ');
        if (callback) callback(null);
      })
      .catch((err) => {
        console.error('❌ เชื่อมต่อ DB ไม่ได้:', err.message);
        if (callback) callback(err);
      });
  },
  query(sql, paramsOrCallback, maybeCallback) {
    let params = [];
    let callback = maybeCallback;
    if (typeof paramsOrCallback === 'function') {
      callback = paramsOrCallback;
    } else if (Array.isArray(paramsOrCallback)) {
      params = paramsOrCallback;
    }
    const { sql: pgSql, params: pgParams } = translate(sql, params);
    pool
      .query(pgSql, pgParams)
      .then((result) => {
        if (callback) callback(null, shapeResult(result), result.fields);
      })
      .catch((err) => {
        if (callback) callback(err);
      });
  },
};

// ---------------------------------------------------------------------------
// dbPool — promise-style (แทน mysql2/promise, ใช้ใน wallet_routes.js/commission.js)
// ---------------------------------------------------------------------------
const dbPool = {
  async query(sql, params = []) {
    const { sql: pgSql, params: pgParams } = translate(sql, params);
    const result = await pool.query(pgSql, pgParams);
    return [shapeResult(result), result.fields];
  },
  async getConnection() {
    const client = await pool.connect();
    return {
      async query(sql, params = []) {
        const { sql: pgSql, params: pgParams } = translate(sql, params);
        const result = await client.query(pgSql, pgParams);
        return [shapeResult(result), result.fields];
      },
      async beginTransaction() {
        await client.query('BEGIN');
      },
      async commit() {
        await client.query('COMMIT');
      },
      async rollback() {
        await client.query('ROLLBACK');
      },
      release() {
        client.release();
      },
    };
  },
};

module.exports = { db, dbPool, pool };
