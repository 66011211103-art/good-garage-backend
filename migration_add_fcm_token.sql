-- ============================================================
-- Migration: เพิ่มคอลัมน์ fcm_token ในตาราง users
-- ทำไม: ฝั่งแอป Flutter (socket_notification_service.dart + api_service.dart)
-- ลงทะเบียน Firebase Cloud Messaging (FCM) token ของแต่ละเครื่องไว้แล้ว
-- (เรียก PUT /api/users/:id/fcm-token หลังล็อกอินสำเร็จทุกครั้ง) แต่ backend
-- ยังไม่มีที่เก็บ token นี้เลย ทำให้ส่งแจ้งเตือนตอนแอปปิดสนิทไม่ได้จริง
-- (มีแค่ Socket.IO ซึ่งต้องเปิดแอปทิ้งไว้เท่านั้น)
--
-- วิธีรัน: เชื่อมต่อ Postgres ของ backend แล้วรันไฟล์นี้ครั้งเดียว เช่น
--   psql "$DATABASE_URL" -f migration_add_fcm_token.sql
-- (หรือรันคำสั่ง ALTER TABLE ด้านล่างตรงๆ ผ่านเครื่องมือ DB ที่ใช้อยู่ก็ได้)
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS fcm_token TEXT;
