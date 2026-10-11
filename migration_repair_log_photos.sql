-- ============================================================================
-- migration_repair_log_photos.sql
-- ตารางใหม่ repair_log_photos: เก็บ "รูปแต่ละใบของบันทึกความคืบหน้างานซ่อม" แยกเป็นแถว
-- พร้อมประเภทรูป (before = ก่อนซ่อม, after = หลังซ่อม, part = อะไหล่ที่ใช้)
-- แทนการยัดรายการรูปเป็น JSON ในคอลัมน์ repair_logs.photos (คอลัมน์เดิมยังอยู่ ไม่ลบ)
-- รันซ้ำได้ปลอดภัย — วิธีรัน: Supabase Dashboard -> SQL Editor -> วาง -> Run
-- ============================================================================
CREATE TABLE IF NOT EXISTS repair_log_photos (
  id            SERIAL PRIMARY KEY,
  repair_log_id INTEGER NOT NULL REFERENCES repair_logs(id) ON DELETE CASCADE,
  photo_type    VARCHAR(10) NOT NULL CHECK (photo_type IN ('before', 'after', 'part')),
  photo_url     TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repair_log_photos_log ON repair_log_photos(repair_log_id);
