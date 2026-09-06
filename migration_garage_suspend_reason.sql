-- เพิ่มคอลัมน์เก็บสาเหตุตอนแอดมินกด "ระงับ" อู่ในหน้า admin/garages.html
-- (คู่ขนานกับ migration_suspend_reason.sql ที่ทำไว้ก่อนหน้าสำหรับ users.suspend_reason —
--  อันนี้แยกเป็นคอลัมน์ของตาราง garages เอง เพราะการระงับ "อู่" กับการระงับ "บัญชีผู้ใช้"
--  เป็นคนละสถานะกัน: users.status ใช้ระงับได้ทุกประเภทบัญชี (ลูกค้า/อู่/ช่าง/แอดมิน)
--  ส่วน garages.status ใช้เฉพาะงานอนุมัติ/ระงับ "อู่" ในฐานะธุรกิจที่ลงทะเบียนไว้)
ALTER TABLE garages ADD COLUMN IF NOT EXISTS suspend_reason TEXT DEFAULT NULL;
COMMENT ON COLUMN garages.suspend_reason IS 'เหตุผลที่แอดมินระงับอู่นี้ (กรอกตอนกดปุ่ม "ระงับ" ในหน้า admin/garages.html) — ใช้โชว์ให้เจ้าของอู่เห็นตอนพยายามล็อกอิน และล้างค่าอัตโนมัติเมื่อเปิดใช้งานอีกครั้ง';
