// cleanup_broken_images.js
// ============================================================================
// ✅ สคริปต์ทำความสะอาดข้อมูล — หาแถวในฐานข้อมูลที่อ้างอิงชื่อไฟล์รูปภาพที่ "ไม่มีอยู่จริง"
// ใน Supabase Storage อีกต่อไป (ส่วนใหญ่เป็นรูปเก่าจากก่อนย้ายระบบมาใช้ Supabase Storage
// ที่หายไปตอน Render ล้าง ephemeral disk) แล้วล้างค่าอ้างอิงที่ตายแล้วออกจาก DB
//
// ทำไมต้องทำ: รูปพวกนี้กู้คืนไม่ได้แล้ว (ไฟล์จริงหายไปถาวร) และเจ้าของรูป (ลูกค้า/อู่)
// ก็ไม่มีทางแก้ไขเองได้เลยถ้าเป็นรูปแนบในแชท/รีวิวที่ส่งไปแล้ว (ไม่มีปุ่ม "แก้ไข"
// ข้อความ/รีวิวเก่าในระบบ) การล้างค่าอ้างอิงออกจาก DB จะทำให้ฝั่งแอปไม่พยายามโหลดรูป
// ที่ไม่มีอยู่จริงอีกต่อไป (จะไม่เห็นกล่อง "โหลดรูปไม่สำเร็จ" ค้างอยู่ถาวร)
//
// ตรวจสอบ 9 จุดที่เก็บชื่อไฟล์รูปภาพไว้ทั้งหมดในระบบ:
//   customers.avatar, garages.avatar, technicians.avatar   (ค่าเดี่ยว)
//   repair_requests.photos, repair_logs.photos, reviews.photos   (JSON array)
//   payments.slip_photo, messages.image, wallet_topups.slip_photo   (ค่าเดี่ยว)
//
// วิธีใช้ (รันจากโฟลเดอร์ backend ที่มี .env อยู่แล้ว):
//   node cleanup_broken_images.js            <- โหมดทดสอบ (dry-run) แค่รายงาน ไม่แก้อะไรจริง
//   node cleanup_broken_images.js --apply    <- โหมดจริง ล้างค่าที่หายไปออกจาก DB จริงๆ
//
// ปลอดภัย: แก้เฉพาะคอลัมน์ที่เก็บชื่อไฟล์รูปเท่านั้น ไม่แตะแถว/ตารางอื่น ไม่ลบข้อมูลใดๆ
// ที่ไม่เกี่ยวกับรูปภาพ (ข้อความแชท/เนื้อหารีวิว/ยอดเงิน ฯลฯ ยังอยู่ครบเหมือนเดิมทุกอย่าง)
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const APPLY = process.argv.includes('--apply');
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';

if (!process.env.DATABASE_URL) {
  console.error('❌ ไม่พบ DATABASE_URL ใน .env');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('❌ ไม่พบ SUPABASE_URL หรือ SUPABASE_SERVICE_KEY ใน .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ดึงรายชื่อไฟล์ทั้งหมดที่มีอยู่จริงใน bucket (วนหน้าไปเรื่อยๆ จนกว่าจะหมด)
async function listAllFiles() {
  const names = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: pageSize, offset });
    if (error) throw new Error('ดึงรายชื่อไฟล์จาก Supabase Storage ไม่สำเร็จ: ' + error.message);
    if (!data || data.length === 0) break;
    data.forEach((f) => names.add(f.name));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return names;
}

function extractFilename(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return null; // URL เต็มแบบเก่า ข้ามไป ไม่ตรวจ (ไม่ใช่ชื่อไฟล์ที่อยู่บน Supabase)
  return value.includes('/') ? value.split('/').pop() : value;
}

async function reportAndClean(label, table, column, pkColumn, existingFiles) {
  const { rows } = await pool.query(`SELECT ${pkColumn}, ${column} FROM ${table} WHERE ${column} IS NOT NULL`);
  const broken = [];
  for (const row of rows) {
    const fname = extractFilename(row[column]);
    if (fname && !existingFiles.has(fname)) {
      broken.push({ id: row[pkColumn], value: row[column] });
    }
  }
  console.log(`\n📋 ${label} (${table}.${column}) — พบทั้งหมด ${rows.length} แถว, เสีย/ไม่มีไฟล์จริง ${broken.length} แถว`);
  broken.slice(0, 10).forEach((b) => console.log(`   - id=${b.id}: ${b.value}`));
  if (broken.length > 10) console.log(`   ... และอีก ${broken.length - 10} แถว`);

  if (APPLY && broken.length > 0) {
    const ids = broken.map((b) => b.id);
    await pool.query(`UPDATE ${table} SET ${column} = NULL WHERE ${pkColumn} = ANY($1::int[])`, [ids]);
    console.log(`   ✅ ล้างค่าแล้ว ${broken.length} แถว`);
  }
  return broken.length;
}

async function reportAndCleanJsonArray(label, table, column, pkColumn, existingFiles) {
  const { rows } = await pool.query(`SELECT ${pkColumn}, ${column} FROM ${table} WHERE ${column} IS NOT NULL`);
  let brokenRowCount = 0;
  let brokenFileCount = 0;
  const updates = [];

  for (const row of rows) {
    let list;
    try {
      list = JSON.parse(row[column]);
    } catch (e) {
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) continue;

    const kept = list.filter((v) => {
      const fname = extractFilename(v);
      return !fname || existingFiles.has(fname); // เก็บไว้ถ้าไฟล์ยังมีจริง (หรือเป็น URL เต็มแบบเก่าที่ข้ามการตรวจ)
    });
    const removedCount = list.length - kept.length;
    if (removedCount > 0) {
      brokenRowCount++;
      brokenFileCount += removedCount;
      updates.push({ id: row[pkColumn], newValue: JSON.stringify(kept) });
    }
  }

  console.log(`\n📋 ${label} (${table}.${column}) — พบทั้งหมด ${rows.length} แถว, มีรูปเสีย ${brokenRowCount} แถว (รวม ${brokenFileCount} ไฟล์)`);
  updates.slice(0, 10).forEach((u) => console.log(`   - id=${u.id}: เหลือ ${u.newValue}`));
  if (updates.length > 10) console.log(`   ... และอีก ${updates.length - 10} แถว`);

  if (APPLY) {
    for (const u of updates) {
      await pool.query(`UPDATE ${table} SET ${column} = $1 WHERE ${pkColumn} = $2`, [u.newValue, u.id]);
    }
    if (updates.length > 0) console.log(`   ✅ ล้างค่าแล้ว ${updates.length} แถว`);
  }
  return brokenFileCount;
}

async function main() {
  console.log(APPLY ? '🔴 โหมดจริง — จะแก้ไขข้อมูลใน DB จริงๆ' : '🟡 โหมดทดสอบ (dry-run) — แค่รายงาน ไม่แก้อะไร (รันด้วย --apply เพื่อแก้จริง)');
  console.log('กำลังดึงรายชื่อไฟล์ทั้งหมดจาก Supabase Storage...');
  const existingFiles = await listAllFiles();
  console.log(`พบไฟล์ทั้งหมด ${existingFiles.size} ไฟล์ใน bucket "${BUCKET}"`);

  let total = 0;
  total += await reportAndClean('รูปโปรไฟล์ลูกค้า', 'customers', 'avatar', 'id', existingFiles);
  total += await reportAndClean('รูปโปรไฟล์อู่', 'garages', 'avatar', 'id', existingFiles);
  total += await reportAndClean('รูปโปรไฟล์ช่าง', 'technicians', 'avatar', 'id', existingFiles);
  total += await reportAndClean('สลิปโอนเงิน (payments)', 'payments', 'slip_photo', 'id', existingFiles);
  total += await reportAndClean('รูปแนบในแชท', 'messages', 'image', 'id', existingFiles);
  total += await reportAndClean('สลิปชำระค่าคอมมิชชั่น', 'wallet_topups', 'slip_photo', 'id', existingFiles);
  total += await reportAndCleanJsonArray('รูปแนบคำขอซ่อม', 'repair_requests', 'photos', 'id', existingFiles);
  total += await reportAndCleanJsonArray('รูปแนบบันทึกงานซ่อม', 'repair_logs', 'photos', 'id', existingFiles);
  total += await reportAndCleanJsonArray('รูปแนบรีวิว', 'reviews', 'photos', 'id', existingFiles);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`รวมรูปที่อ้างอิงไฟล์ที่ไม่มีอยู่จริงแล้ว: ${total} รูป`);
  console.log(APPLY ? '✅ ล้างค่าออกจาก DB เรียบร้อยแล้ว' : 'ยังไม่ได้แก้อะไร — รันซ้ำด้วย "node cleanup_broken_images.js --apply" เพื่อแก้จริง');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
