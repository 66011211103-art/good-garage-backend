-- migration_car_type_and_repair_car_link.sql
-- เพิ่มฟีเจอร์: ลูกค้าเลือก "รถของฉัน" ตอนส่งคำขอซ่อม แทนการเลือกประเภทรถแบบลอยๆ
-- และให้ใบเสนอราคาของอู่เชื่อมกับข้อมูลรถของลูกค้า + รายการบริการของอู่เองได้
--
-- 1) cars.car_type — ประเภทรถ (sedan/suv/pickup/...) ย้ายมาผูกกับ "รถ" แต่ละคัน
--    แทนที่จะถามซ้ำทุกครั้งตอนส่งคำขอซ่อม
ALTER TABLE `cars`
  ADD COLUMN `car_type` VARCHAR(30) DEFAULT NULL
    COMMENT 'sedan | suv | pickup | van | motorcycle | other' AFTER `car_model`;

-- 2) repair_requests.car_id — อ้างอิงรถที่ลูกค้าเลือกจากตาราง cars (เลือกได้ตอนส่งคำขอซ่อม)
--    ยังเก็บ vehicle_type ไว้เหมือนเดิมเพื่อ backward-compat กับโค้ด/รายงานเดิมที่อ้างอิงคอลัมน์นี้อยู่
--    (ฝั่ง backend จะ derive ค่านี้จาก cars.car_type ของรถที่เลือกให้อัตโนมัติ)
ALTER TABLE `repair_requests`
  ADD COLUMN `car_id` INT(11) DEFAULT NULL
    COMMENT 'อ้างอิงรถของลูกค้าจากตาราง cars (เลือกจากรถของฉันตอนส่งคำขอซ่อม)' AFTER `customer_id`;

ALTER TABLE `repair_requests`
  ADD KEY `idx_repair_requests_car_id` (`car_id`);

ALTER TABLE `repair_requests`
  ADD CONSTRAINT `repair_requests_ibfk_car`
    FOREIGN KEY (`car_id`) REFERENCES `cars` (`id`) ON DELETE SET NULL;
