-- migration_suspend_reason.sql
-- เพิ่มคอลัมน์ suspend_reason ในตาราง users เพื่อเก็บสาเหตุที่แอดมินระงับบัญชี
--
-- ก่อนหน้านี้ปุ่ม "ระงับ" ในหน้าแอดมิน (admin/users.html) แค่เปลี่ยนค่า users.status
-- เป็น 'suspended' เฉยๆ แต่ /api/auth/login ไม่เคยเช็คค่านี้เลย ทำให้บัญชีที่ถูกระงับ
-- ยังล็อกอินเข้าแอปได้ปกติทุกอย่าง — ตอนนี้แก้ให้ /api/auth/login เช็คสถานะนี้จริง และ
-- ต้องมีคอลัมน์นี้ไว้เก็บสาเหตุ เพื่อโชว์ให้ผู้ใช้เห็นตอนพยายามล็อกอินว่าเพราะอะไร
--
-- วิธีรัน: เปิด Supabase Dashboard -> SQL Editor -> วางไฟล์นี้ทั้งหมด -> กด Run
-- (ปลอดภัย รันซ้ำได้ — ADD COLUMN IF NOT EXISTS จะข้ามเฉยๆ ถ้ามีคอลัมน์อยู่แล้ว)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS suspend_reason TEXT DEFAULT NULL;

COMMENT ON COLUMN users.suspend_reason IS 'สาเหตุที่แอดมินระงับบัญชีนี้ (กรอกตอนกดปุ่ม "ระงับ" ในหน้าแอดมิน) — โชว์ให้ผู้ใช้เห็นตอนพยายามล็อกอิน ค่าจะถูกล้างกลับเป็น NULL อัตโนมัติเมื่อแอดมินกด "ปลดระงับ"';
