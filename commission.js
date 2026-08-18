// commission.js
// โมดูลคำนวณและหักค่าคอมมิชชั่นแบบ Grab-style (หักจาก wallet ของอู่ ณ ตอนที่ยืนยันว่าลูกค้าจ่ายเงินแล้ว)
// ใช้ dbPool แบบ mysql2/promise ที่ประกาศคู่ขนานไว้ใน server.js

/**
 * หักคอมมิชชั่นจาก wallet ของอู่ หลังยืนยันว่าลูกค้าชำระเงินแล้ว
 * ทำงานเป็น transaction เดียว และล็อกแถวอู่ด้วย FOR UPDATE กันสองงานหักพร้อมกันแล้วยอดเพี้ยน
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {{ garageId: number, repairRequestId: number, paymentId: number, grossAmount: number }} params
 * @returns {Promise<{ commissionAmount: number, walletBalanceAfter: number, alreadyDeducted?: boolean }>}
 */
async function deductCommission(pool, { garageId, repairRequestId, paymentId, grossAmount }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[garage]] = await conn.query(
      'SELECT commission_rate, wallet_balance FROM garages WHERE user_id = ? FOR UPDATE',
      [garageId]
    );
    if (!garage) throw new Error('ไม่พบข้อมูลอู่');

    // กันหักซ้ำถ้า route ถูกเรียกซ้ำ (เช่น ลูกค้ากดปุ่มรัว หรือ retry)
    const [[existing]] = await conn.query(
      'SELECT id FROM commission_transactions WHERE payment_id = ?',
      [paymentId]
    );
    if (existing) {
      await conn.rollback();
      const [[current]] = await pool.query('SELECT wallet_balance FROM garages WHERE user_id = ?', [garageId]);
      return { commissionAmount: 0, walletBalanceAfter: Number(current.wallet_balance), alreadyDeducted: true };
    }

    const commissionRate = Number(garage.commission_rate);
    const commissionAmount = Number((grossAmount * commissionRate / 100).toFixed(2));
    const walletBalanceAfter = Number((Number(garage.wallet_balance) - commissionAmount).toFixed(2));

    await conn.query(
      `INSERT INTO commission_transactions
        (garage_id, repair_request_id, payment_id, gross_amount, commission_rate, commission_amount, wallet_balance_after)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [garageId, repairRequestId, paymentId, grossAmount, commissionRate, commissionAmount, walletBalanceAfter]
    );

    await conn.query('UPDATE garages SET wallet_balance = ? WHERE user_id = ?', [
      walletBalanceAfter,
      garageId,
    ]);

    await conn.commit();
    return { commissionAmount, walletBalanceAfter, alreadyDeducted: false };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * เช็กว่า wallet ของอู่พอให้รับงานใหม่ไหม เรียกก่อนอู่กด "รับงาน" (status -> accepted/confirmed)
 * threshold ปรับได้ตามนโยบาย เช่น -500 = อนุญาตให้ติดลบได้ไม่เกิน 500 บาทก่อนบล็อก
 */
async function canAcceptNewJob(pool, garageId, threshold = 0) {
  const [[garage]] = await pool.query('SELECT wallet_balance FROM garages WHERE user_id = ?', [garageId]);
  if (!garage) return false;
  return Number(garage.wallet_balance) >= threshold;
}

module.exports = { deductCommission, canAcceptNewJob };