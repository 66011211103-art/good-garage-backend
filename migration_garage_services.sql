-- ============================================================================
-- migration_garage_services.sql   (ขั้นที่ 1 — รันก่อน push server.js)
-- แยกบริการของอู่จากข้อความ JSON ในคอลัมน์ garages.services ไปเป็นตารางลูก garage_services
-- (1 บริการ = 1 แถว, garages 1 : N garage_services) — ตามหลัก Normalization (1NF)
-- *ยังไม่ลบคอลัมน์เดิม* เพื่อให้ server.js ตัวเก่าที่ยังรันอยู่ไม่พัง รันซ้ำได้ปลอดภัย
-- วิธีรัน: Supabase Dashboard -> SQL Editor -> วาง -> Run
-- ============================================================================
CREATE TABLE IF NOT EXISTS garage_services (
  id         SERIAL PRIMARY KEY,
  garage_id  INTEGER NOT NULL REFERENCES garages(id) ON DELETE CASCADE,
  category   VARCHAR(100) NOT NULL DEFAULT 'อื่นๆ',
  name       VARCHAR(255) NOT NULL,
  price_min  VARCHAR(50)  NOT NULL DEFAULT '',
  price_max  VARCHAR(50)  NOT NULL DEFAULT '',
  details    TEXT         NOT NULL DEFAULT '',
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  created_at TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_garage_services_garage ON garage_services(garage_id);
CREATE INDEX IF NOT EXISTS idx_garage_services_category ON garage_services(category);

-- ย้ายข้อมูลเดิม (เฉพาะอู่ที่ยังไม่มีแถวในตารางใหม่ — กันซ้ำถ้ารันหลายรอบ)
INSERT INTO garage_services (garage_id, category, name, price_min, price_max, details, active, sort_order)
SELECT g.id,
       COALESCE(NULLIF(e.elem->>'category', ''), 'อื่นๆ'),
       e.elem->>'name',
       COALESCE(NULLIF(e.elem->>'priceMin', ''), e.elem->>'price', ''),   -- รองรับรูปแบบเก่าที่มีช่อง price ช่องเดียว
       COALESCE(e.elem->>'priceMax', ''),
       COALESCE(e.elem->>'details', ''),
       COALESCE((e.elem->>'active') <> 'false', TRUE),
       (e.ord - 1)::int
FROM garages g,
     jsonb_array_elements(g.services::jsonb) WITH ORDINALITY AS e(elem, ord)
WHERE g.services IS NOT NULL
  AND g.services <> ''
  AND jsonb_typeof(e.elem) = 'object'
  AND COALESCE(e.elem->>'name', '') <> ''
  AND NOT EXISTS (SELECT 1 FROM garage_services s WHERE s.garage_id = g.id);

-- ตรวจผล: จำนวนบริการต่ออู่ (ควรตรงกับจำนวนบริการที่เคยมี)
SELECT g.id, g.shop_name, COUNT(s.id) AS service_count
FROM garages g LEFT JOIN garage_services s ON s.garage_id = g.id
GROUP BY g.id, g.shop_name ORDER BY g.id;
