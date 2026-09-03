-- migration_commission_payment_status.sql
-- ⚠️ ไฟล์นี้เขียนเป็น MySQL syntax (ดู "วิธีรัน" ด้านล่าง) แต่ backend จริงต่อ
-- PostgreSQL ผ่าน Supabase — รันไฟล์นี้ตรงๆ กับ Supabase ไม่ผ่านแน่นอน (backtick,
-- COMMENT/AFTER ใน ALTER TABLE, ADD KEY, UPDATE...JOIN...SET ไม่มีใน Postgres)
-- ใช้ migration_commission_payment_status_pg.sql (เวอร์ชัน Postgres ที่ถูกต้อง,
-- รันซ้ำได้อย่างปลอดภัย) แทนไฟล์นี้ — เก็บไฟล์นี้ไว้อ้างอิงเจตนาเดิมเฉยๆ
--
-- ทำให้ commission_transactions แต่ละแถวมี "สถานะการจ่าย" ของตัวเอง
-- (unpaid / pending_confirmation / paid) แทนที่จะให้อู่กรอกยอดเติมเงินเอาเอง
-- เพื่อรองรับหน้า "ค่าคอมมิชชั่นที่ค้างจ่าย" แบบเลือกจ่ายทีละงาน
--
-- วิธีรัน: import ไฟล์นี้ผ่าน phpMyAdmin หรือ
--   mysql -u <user> -p garage_app < migration_commission_payment_status.sql

ALTER TABLE `commission_transactions`
  ADD COLUMN `payment_status` VARCHAR(20) NOT NULL DEFAULT 'unpaid'
    COMMENT 'unpaid | pending_confirmation | paid' AFTER `wallet_balance_after`,
  ADD COLUMN `wallet_topup_id` INT(11) DEFAULT NULL
    COMMENT 'อ้างอิงคำขอเติมเงิน (wallet_topups) ที่ใช้จ่ายรายการนี้' AFTER `payment_status`;

ALTER TABLE `commission_transactions`
  ADD KEY `idx_commission_wallet_topup` (`wallet_topup_id`);

ALTER TABLE `commission_transactions`
  ADD CONSTRAINT `commission_transactions_ibfk_4`
    FOREIGN KEY (`wallet_topup_id`) REFERENCES `wallet_topups` (`id`);

-- ------------------------------------------------------------------
-- Backfill ข้อมูลเดโมที่มีอยู่แล้ว (ไม่บังคับ — ข้ามได้ถ้าไม่ต้องการ)
-- ในดัมป์ปัจจุบัน มี commission_transactions 2 แถว ซึ่งอู่ได้เติมเงินและแอดมิน
-- ยืนยันไปแล้วก่อนที่ฟีเจอร์นี้จะมีอยู่ (wallet_topups id 1 และ 3) จึงถือว่า "จ่ายแล้ว"
-- ผูกกลับไปยัง topup เดิมให้ตรงกัน ป้องกันไม่ให้ขึ้นเป็นรายการค้างจ่ายซ้ำในแอป
-- ------------------------------------------------------------------
UPDATE `commission_transactions` ct
JOIN `wallet_topups` wt
  ON wt.garage_id = ct.garage_id
  AND wt.status = 'confirmed'
  AND wt.amount = ct.commission_amount
SET ct.payment_status = 'paid', ct.wallet_topup_id = wt.id
WHERE ct.payment_status = 'unpaid';
