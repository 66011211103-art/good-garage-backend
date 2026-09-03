-- migration_commission_payment_status_pg.sql
-- ✅ แก้บั๊กจริง: ไฟล์เดิม (migration_commission_payment_status.sql) เขียนเป็น MySQL
-- syntax ล้วน (backtick, COMMENT/AFTER ใน ALTER TABLE, ADD KEY, UPDATE...JOIN...SET)
-- ทั้งที่ backend จริงต่อ PostgreSQL ผ่าน Supabase (ดู db_pg.js) — MySQL syntax พวกนี้
-- ไม่มีใน Postgres เลย รันไม่ผ่านแน่นอนถ้ารันไฟล์เดิมตรงๆ กับ Supabase
--
-- ผลที่เป็นไปได้: ถ้าตอนติดตั้งฟีเจอร์ "จ่ายค่าคอมทีละงาน" มีคนแปลงเฉพาะส่วน ALTER TABLE
-- (เพิ่มคอลัมน์) ให้รันผ่านได้ แต่ข้าม/ไม่ได้แปลงส่วน backfill (UPDATE...JOIN) ตรงท้ายไฟล์
-- คอมมิชชั่นแถวเก่าที่จ่ายไปแล้วก่อนฟีเจอร์นี้จะยังค้างเป็น 'unpaid' อยู่ ทำให้ยอด
-- "ค่าคอมมิชชั่นที่ค้างจ่าย" ในแอปอู่ (garage_wallet_page.dart) สูงเกินจริง ไม่ตรงกับ
-- "ยอดเครดิตคงเหลือใน Wallet" จริงๆ
--
-- ไฟล์นี้เขียนใหม่เป็น PostgreSQL syntax ที่ถูกต้อง และทำให้ "รันซ้ำได้อย่างปลอดภัย"
-- (idempotent) ทุกคำสั่ง — ถ้าคอลัมน์/index/constraint มีอยู่แล้วจะข้ามไปเฉยๆ ไม่ error
-- ส่วน backfill ก็รันซ้ำได้เรื่อยๆ เพราะมีเงื่อนไข payment_status = 'unpaid' กันไว้อยู่แล้ว
--
-- วิธีรัน: เปิด Supabase Dashboard -> SQL Editor -> วางไฟล์นี้ทั้งหมด -> กด Run

-- 1) เพิ่มคอลัมน์ payment_status (ถ้ายังไม่มี)
ALTER TABLE commission_transactions
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid';
COMMENT ON COLUMN commission_transactions.payment_status IS 'unpaid | pending_confirmation | paid';

-- 2) เพิ่มคอลัมน์ wallet_topup_id (ถ้ายังไม่มี)
ALTER TABLE commission_transactions
  ADD COLUMN IF NOT EXISTS wallet_topup_id INTEGER DEFAULT NULL;
COMMENT ON COLUMN commission_transactions.wallet_topup_id IS 'อ้างอิงคำขอเติมเงิน (wallet_topups) ที่ใช้จ่ายรายการนี้';

-- 3) index (ถ้ายังไม่มี)
CREATE INDEX IF NOT EXISTS idx_commission_wallet_topup ON commission_transactions (wallet_topup_id);

-- 4) foreign key (ต้องเช็คเองว่ามีอยู่แล้วหรือยัง เพราะ Postgres ไม่มี
--    "ADD CONSTRAINT IF NOT EXISTS" ตรงๆ — ใช้ DO block เช็คจาก pg_constraint แทน)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'commission_transactions_wallet_topup_fk'
  ) THEN
    ALTER TABLE commission_transactions
      ADD CONSTRAINT commission_transactions_wallet_topup_fk
        FOREIGN KEY (wallet_topup_id) REFERENCES wallet_topups (id);
  END IF;
END $$;

-- 5) Backfill: แถวคอมมิชชั่นเก่าที่จริงๆ จ่ายไปแล้ว (มี wallet_topups ที่ confirmed แล้ว
--    ยอดตรงกันพอดี) แต่ยังค้างเป็น 'unpaid' อยู่ -> เปลี่ยนเป็น 'paid' ให้ตรงความจริง
--    (เขียนใหม่จาก UPDATE...JOIN แบบ MySQL เป็น UPDATE...FROM...WHERE แบบ Postgres —
--    รันซ้ำกี่ครั้งก็ปลอดภัย เพราะเงื่อนไข payment_status = 'unpaid' กรองไว้อยู่แล้ว)
UPDATE commission_transactions ct
SET payment_status = 'paid', wallet_topup_id = wt.id
FROM wallet_topups wt
WHERE wt.garage_id = ct.garage_id
  AND wt.status = 'confirmed'
  AND wt.amount = ct.commission_amount
  AND ct.payment_status = 'unpaid';

-- 6) เช็คผลหลังรัน — ถ้ามีแถวที่ backfill ไป จะเห็นในนี้ (รันแยกดูผลได้)
-- SELECT id, garage_id, commission_amount, payment_status, wallet_topup_id
-- FROM commission_transactions
-- WHERE payment_status = 'paid' AND wallet_topup_id IS NOT NULL
-- ORDER BY created_at DESC;
