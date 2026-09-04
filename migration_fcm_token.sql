-- migration_fcm_token.sql
-- เพิ่มคอลัมน์ fcm_token ในตาราง users เพื่อรองรับการแจ้งเตือนแบบ Firebase Cloud
-- Messaging (FCM) ที่ทำงานได้แม้ผู้ใช้ปิดแอปสนิท (ต่างจาก Socket.IO เดิมที่ต้องเปิดแอป
-- ทิ้งไว้อย่างน้อยเบื้องหลังถึงจะได้รับแจ้งเตือน)
--
-- Flutter จะเรียก PUT /api/users/:id/fcm-token หลังล็อกอินสำเร็จ (ดู server.js) เพื่อ
-- บันทึก token ของอุปกรณ์ไว้ที่นี่ — sendPushNotification() ใน server.js จะอ่านค่านี้
-- ไปใช้ส่งแจ้งเตือนผ่าน Firebase Admin SDK
--
-- วิธีรัน: เปิด Supabase Dashboard -> SQL Editor -> วางไฟล์นี้ทั้งหมด -> กด Run
-- (ปลอดภัย รันซ้ำได้ — ADD COLUMN IF NOT EXISTS จะข้ามเฉยๆ ถ้ามีคอลัมน์อยู่แล้ว)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fcm_token TEXT DEFAULT NULL;

COMMENT ON COLUMN users.fcm_token IS 'Firebase Cloud Messaging registration token ของอุปกรณ์ที่ล็อกอินล่าสุด ใช้ส่งแจ้งเตือนตอนปิดแอปสนิท (ฝั่ง Android)';
