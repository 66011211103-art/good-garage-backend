// wallet_routes.js
// เอ็นด์พอยต์สำหรับ "ชำระค่าคอมมิชชั่นที่ค้างจ่ายทีละงาน" ของอู่ + แอดมินยืนยัน/ปฏิเสธ + ดูยอดคงเหลือ
// (เดิมเป็นระบบ "เติมเงินเข้า wallet" แบบพิมพ์ยอดเอง — เปลี่ยนมาให้อู่เลือกงานที่ยัง
// ไม่ได้จ่ายค่าคอม (commission_transactions.payment_status = 'unpaid') แล้วจ่ายทีละรายการ/
// หลายรายการพร้อมกัน ยอดที่ต้องโอนคำนวณจากรายการที่เลือกเสมอ ไม่รับยอดจาก client ตรงๆ)
// ต้องรัน migration_commission_payment_status.sql ก่อนใช้งานไฟล์นี้
//
// วิธีติดตั้ง: mount ใน server.js หลังประกาศ dbPool และ uploadSlip แล้ว
//   const walletRoutes = require('./backend_modules/wallet_routes')(dbPool, uploadSlip, toImageUrl);
//   app.use('/api', walletRoutes);

const express = require('express');

// ✅ รับ uploadSlip (multer middleware ตัวเดียวกับที่ /api/payments ใช้อยู่แล้ว) และ
// toImageUrl (helper แปลงชื่อไฟล์ -> URL เต็ม) เข้ามาจาก server.js แทนที่จะสร้าง
// multer instance ใหม่แยกต่างหาก — กันไม่ให้ path เก็บไฟล์/รูปแบบชื่อไฟล์เพี้ยนไปจากไฟล์อื่นในระบบ
module.exports = (pool, uploadSlip, toImageUrl, uploadToSupabase) => {
  const router = express.Router();

  // ===== อู่ดูประวัติการชำระค่าคอมมิชชั่นของตัวเอง =====
  // ✅ บั๊กจริง (มีมาตั้งแต่ก่อนแก้ระบบนี้): route นี้ต้องประกาศไว้ "ก่อน"
  // '/wallet/:garageId' ที่เป็น path พารามิเตอร์แบบเดียวกัน (1 segment ใต้ /wallet/)
  // เพราะ Express match ตามลำดับที่ประกาศ — ถ้า ':garageId' มาก่อน request ที่ยิงไป
  // /wallet/topups จะหลุดเข้า handler นั้นแทน (garageId กลายเป็น string "topups"
  // หา garage ไม่เจอ ตอบ error กลับไปแทนประวัติจริง) ย้ายมาไว้บนสุดเพื่อกันปัญหานี้
  router.get('/wallet/topups', async (req, res) => {
    try {
      const { garageId } = req.query;
      const [rows] = await pool.query(
        `SELECT wt.*,
                (SELECT COUNT(*) FROM commission_transactions ct WHERE ct.wallet_topup_id = wt.id) AS job_count
         FROM wallet_topups wt
         WHERE wt.garage_id = ? ORDER BY wt.submitted_at DESC`,
        [garageId]
      );
      const withUrls = rows.map((r) => ({ ...r, slip_photo: toImageUrl(r.slip_photo) }));
      res.json({ success: true, message: '', data: withUrls });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== อู่ดูรายการค่าคอมมิชชั่นที่ "ค้างจ่าย" ทีละงาน =====
  // ✅ เปลี่ยนจากเดิมที่อู่พิมพ์ยอดเติมเงินเอาเอง (เสี่ยงพิมพ์ผิด/ไม่ตรงกับยอดค้างจริง)
  // มาเป็นให้เลือกจากรายการงานที่ยังไม่ได้จ่ายค่าคอม (payment_status = 'unpaid') แทน
  // ยอดที่ต้องจ่ายจะคำนวณจากรายการที่เลือกฝั่ง backend เสมอ ไม่รับยอดจาก client ตรงๆ
  router.get('/wallet/:garageId/unpaid-commissions', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT ct.id, ct.repair_request_id, ct.payment_id, ct.gross_amount,
                ct.commission_rate, ct.commission_amount, ct.created_at,
                rr.problem_category, rr.vehicle_type
         FROM commission_transactions ct
         LEFT JOIN repair_requests rr ON rr.id = ct.repair_request_id
         WHERE ct.garage_id = ? AND ct.payment_status = 'unpaid'
         ORDER BY ct.created_at ASC`,
        [req.params.garageId]
      );
      res.json({ success: true, message: '', data: rows });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== อู่ดูยอดเครดิตคงเหลือ + อัตราคอมมิชชั่นของตัวเอง =====
  // ⚠️ ต้องอยู่ "หลัง" /wallet/topups และ /wallet/:garageId/unpaid-commissions เสมอ —
  // เป็น path พารามิเตอร์แบบกว้างสุด (1 segment) ถ้าย้ายขึ้นไปไว้บนจะแย่ง route ทั้งสองด้านบนไปหมด
  router.get('/wallet/:garageId', async (req, res) => {
    try {
      const [[garage]] = await pool.query(
        'SELECT wallet_balance, commission_rate FROM garages WHERE user_id = ?',
        [req.params.garageId]
      );
      if (!garage) return res.json({ success: false, message: 'ไม่พบข้อมูลอู่' });
      res.json({ success: true, message: '', data: garage });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== อู่ส่งชำระค่าคอมมิชชั่นของงานที่เลือก (โอนเข้าบัญชีแพลตฟอร์ม แล้วอัปโหลดสลิป) =====
  router.post('/wallet/topup', uploadSlip, async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const { garageId } = req.body;
      // ✅ ส่งมาจาก multipart form เป็น string เสมอ ต้อง parse เป็น array ก่อน
      let commissionTransactionIds = [];
      try {
        commissionTransactionIds = JSON.parse(req.body.commissionTransactionIds || '[]');
      } catch (e) {
        commissionTransactionIds = [];
      }
      if (!garageId || !Array.isArray(commissionTransactionIds) || commissionTransactionIds.length === 0) {
        conn.release();
        return res.json({ success: false, message: 'กรุณาเลือกรายการค่าคอมมิชชั่นที่ต้องการจ่าย' });
      }

      await conn.beginTransaction();

      // ✅ ล็อกแถวที่เลือกไว้ก่อน กันอู่กดส่งซ้ำ/เลือกรายการที่จ่ายไปแล้วจากอีกแท็บ
      const [rows] = await conn.query(
        `SELECT id, commission_amount FROM commission_transactions
         WHERE id IN (?) AND garage_id = ? AND payment_status = 'unpaid' FOR UPDATE`,
        [commissionTransactionIds, garageId]
      );
      if (rows.length === 0) {
        await conn.rollback();
        conn.release();
        return res.json({ success: false, message: 'รายการที่เลือกถูกดำเนินการไปแล้ว กรุณารีเฟรชหน้าจอ' });
      }

      // ✅ ยอดที่ต้องจ่ายคำนวณจากฝั่ง backend เสมอ ไม่เชื่อยอดที่ client ส่งมา
      const amount = rows.reduce((sum, r) => sum + Number(r.commission_amount), 0);
      const matchedIds = rows.map((r) => r.id);

      // ✅ เก็บแค่ "ชื่อไฟล์" ลง DB (ไม่เก็บ path เต็ม) ให้ตรงกับทุกตารางอื่นในระบบ
      // (photos, avatar, slip_photo ของ payments ฯลฯ) เพื่อให้ toImageUrl() แปลงกลับ
      // เป็น URL เต็มได้ถูกต้องเสมอ ต่อให้ IP/โดเมนเซิร์ฟเวอร์เปลี่ยนทีหลัง
      let slipPhoto = null;
      if (req.file) {
        try {
          slipPhoto = await uploadToSupabase(req.file, 'slip'); // ✅ เก็บที่ Supabase Storage แทนดิสก์ของ Render
        } catch (uploadFileErr) {
          await conn.rollback();
          conn.release();
          return res.json({ success: false, message: 'อัปโหลดสลิปไม่สำเร็จ: ' + uploadFileErr.message });
        }
      }
      const [result] = await conn.query(
        "INSERT INTO wallet_topups (garage_id, amount, slip_photo, status) VALUES (?, ?, ?, 'pending_confirmation') RETURNING id",
        [garageId, amount, slipPhoto]
      );

      await conn.query(
        `UPDATE commission_transactions
         SET payment_status = 'pending_confirmation', wallet_topup_id = ?
         WHERE id IN (?)`,
        [result.insertId, matchedIds]
      );

      await conn.commit();
      res.json({
        success: true,
        message: `ส่งคำขอชำระค่าคอมมิชชั่น ${matchedIds.length} รายการสำเร็จ รอตรวจสอบ`,
        data: { id: result.insertId, amount, jobCount: matchedIds.length },
      });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.json({ success: false, message: 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่' });
    } finally {
      conn.release();
    }
  });

  // ===== [แอดมิน] ดูคำขอชำระค่าคอมมิชชั่นที่รอตรวจสอบทั้งหมด =====
  router.get('/admin/wallet/topups', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT wt.*, g.shop_name,
                (SELECT COUNT(*) FROM commission_transactions ct WHERE ct.wallet_topup_id = wt.id) AS job_count
         FROM wallet_topups wt
         JOIN garages g ON g.user_id = wt.garage_id
         WHERE wt.status = 'pending_confirmation'
         ORDER BY wt.submitted_at ASC`
      );
      const withUrls = rows.map((r) => ({ ...r, slip_photo: toImageUrl(r.slip_photo) }));
      res.json({ success: true, message: '', data: withUrls });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== [แอดมิน] ยืนยันการชำระค่าคอมมิชชั่น -> บวกเข้า wallet_balance จริง
  //       และปิดสถานะงานที่จ่ายเป็น 'paid' =====
  router.put('/admin/wallet/topups/:id/confirm', async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[topup]] = await conn.query(
        'SELECT * FROM wallet_topups WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (!topup || topup.status !== 'pending_confirmation') {
        await conn.rollback();
        return res.json({ success: false, message: 'รายการนี้ถูกดำเนินการไปแล้ว' });
      }

      await conn.query(
        "UPDATE wallet_topups SET status = 'confirmed', confirmed_at = NOW(), confirmed_by_admin_id = ? WHERE id = ?",
        [req.body.adminId || null, topup.id]
      );
      await conn.query('UPDATE garages SET wallet_balance = wallet_balance + ? WHERE user_id = ?', [
        topup.amount,
        topup.garage_id,
      ]);
      // ✅ ปิดงานที่ผูกกับคำขอนี้ให้เป็น 'paid' — ไม่ขึ้นในรายการ "ค้างจ่าย" ของอู่อีก
      await conn.query(
        "UPDATE commission_transactions SET payment_status = 'paid' WHERE wallet_topup_id = ?",
        [topup.id]
      );

      await conn.commit();
      res.json({ success: true, message: 'ยืนยันการชำระค่าคอมมิชชั่นสำเร็จ' });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    } finally {
      conn.release();
    }
  });

  // ===== [แอดมิน] ปฏิเสธคำขอชำระค่าคอมมิชชั่น -> คืนงานที่เลือกไว้กลับเป็น 'unpaid'
  //       ให้อู่กลับมาเลือกจ่ายใหม่ได้ =====
  router.put('/admin/wallet/topups/:id/reject', async (req, res) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "UPDATE wallet_topups SET status = 'rejected', rejection_reason = ? WHERE id = ?",
        [req.body.reason || null, req.params.id]
      );
      await conn.query(
        "UPDATE commission_transactions SET payment_status = 'unpaid', wallet_topup_id = NULL WHERE wallet_topup_id = ?",
        [req.params.id]
      );
      await conn.commit();
      res.json({ success: true, message: 'ปฏิเสธรายการเรียบร้อย' });
    } catch (err) {
      await conn.rollback();
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    } finally {
      conn.release();
    }
  });

  // ===== [แอดมิน] ดูยอด wallet + อัตราคอมมิชชั่นของอู่ทุกราย (สรุปหน้ารวม) =====
  router.get('/admin/wallet/summary', async (req, res) => {
    try {
      const [rows] = await pool.query(
        `SELECT g.id AS garage_row_id, g.user_id AS garage_id, g.shop_name,
                g.wallet_balance, g.commission_rate,
                (SELECT COUNT(*) FROM wallet_topups wt WHERE wt.garage_id = g.user_id AND wt.status = 'pending_confirmation') AS pending_topups
         FROM garages g
         ORDER BY g.wallet_balance ASC`
      );
      res.json({ success: true, message: '', data: rows });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== [แอดมิน] ประวัติการหักค่าคอมมิชชั่นทั้งหมด (ตรวจสอบย้อนหลัง) =====
  router.get('/admin/commission-transactions', async (req, res) => {
    try {
      const { garageId } = req.query;
      let sql = `SELECT ct.*, g.shop_name FROM commission_transactions ct
                 JOIN garages g ON g.user_id = ct.garage_id WHERE 1=1`;
      const params = [];
      if (garageId) {
        sql += ' AND ct.garage_id = ?';
        params.push(garageId);
      }
      sql += ' ORDER BY ct.created_at DESC LIMIT 200';
      const [rows] = await pool.query(sql, params);
      res.json({ success: true, message: '', data: rows });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  // ===== [แอดมิน] ปรับอัตราคอมมิชชั่นของอู่รายร้าน =====
  router.put('/admin/garages/:garageId/commission-rate', async (req, res) => {
    try {
      const { commissionRate } = req.body;
      await pool.query('UPDATE garages SET commission_rate = ? WHERE user_id = ?', [
        commissionRate,
        req.params.garageId,
      ]);
      res.json({ success: true, message: 'ปรับอัตราคอมมิชชั่นสำเร็จ' });
    } catch (err) {
      console.error(err);
      res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    }
  });

  return router;
};