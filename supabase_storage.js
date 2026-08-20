// supabase_storage.js
// ============================================================================
// ✅ อัปโหลดรูปภาพ (avatar / รูปงานซ่อม / สลิปโอนเงิน / รูปแชท) ไปเก็บที่ Supabase
// Storage แทนการเขียนลงดิสก์ในเครื่องของ Render
//
// เหตุผล: Render แพ็กเกจฟรีมี filesystem แบบชั่วคราว (ephemeral) — ไฟล์ที่เขียนลง
// ดิสก์ในเครื่อง (โฟลเดอร์ ./uploads/ เดิม) จะถูกล้างหายทุกครั้งที่ service redeploy
// หรือ restart ทำให้รูปที่เคยอัปโหลดไว้ 404 หมด จึงย้ายมาเก็บที่ Supabase Storage
// (bucket แยกต่างหาก ไม่ใช่ตารางในฐานข้อมูล) ซึ่งเป็นพื้นที่เก็บไฟล์แบบถาวร ฟรี
// และอยู่ใน Supabase project เดียวกับที่ใช้เก็บฐานข้อมูลอยู่แล้ว
//
// ต้องตั้งค่า .env / Render Environment เพิ่ม 2 ตัว:
//   SUPABASE_URL          = https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_KEY  = service_role secret key (Project Settings > API)
// และต้องสร้าง bucket ชื่อ "uploads" (ตั้งเป็น Public) ในหน้า Storage ของ Supabase
// ก่อนใช้งานไฟล์นี้
// ============================================================================
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'uploads';

let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
} else {
  console.error(
    '❌ ไม่พบ SUPABASE_URL หรือ SUPABASE_SERVICE_KEY ใน .env — อัปโหลดรูปภาพจะไม่ทำงานจนกว่าจะตั้งค่า'
  );
}

// รับ multer file object (ต้องใช้ multer.memoryStorage() ถึงจะมี .buffer — ไม่ใช่ diskStorage)
// พร้อม prefix สำหรับตั้งชื่อไฟล์ (avatar/photo/slip/chat) คืนค่าเป็น "ชื่อไฟล์" เก็บลง DB
// เหมือนเดิมทุกจุดในระบบ (ไม่เก็บ URL เต็ม) เพื่อให้ toImageUrl()/publicUrlFor() แปลงกลับได้เสมอ
async function uploadToSupabase(file, prefix = 'file') {
  if (!supabase) {
    throw new Error('Supabase Storage ยังไม่ได้ตั้งค่า (SUPABASE_URL/SUPABASE_SERVICE_KEY)');
  }
  const ext = path.extname(file.originalname || '') || '';
  const filename = `${prefix}_${Date.now()}${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(filename, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });
  if (error) throw error;
  return filename;
}

// URL สาธารณะของไฟล์ใน bucket — ใช้แทน `${PUBLIC_URL}/uploads/${filename}` เดิม
function publicUrlFor(filename) {
  if (!supabase || !filename) return null;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
  return data ? data.publicUrl : null;
}

module.exports = { uploadToSupabase, publicUrlFor };
