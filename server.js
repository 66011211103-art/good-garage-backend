require('dotenv').config();

const express = require('express');
const { deductCommission, canAcceptNewJob } = require('./commission');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const http = require('http'); // ✅ ต้องใช้ http server ดิบ เพื่อแนบ Socket.IO เข้าไปด้วย
const { Server } = require('socket.io'); // ✅ ใช้ Socket.IO แทน Firebase Cloud Messaging
const { uploadToSupabase, publicUrlFor } = require('./supabase_storage'); // ✅ เก็บรูปที่ Supabase Storage แทนดิสก์ของ Render (ดิสก์เป็น ephemeral หายทุกครั้งที่ redeploy)

// ✅ แก้บั๊กจริง (ต่อจาก family: 4 ที่ใส่ในตัว transporter ด้านล่างแล้วยังไม่ได้ผล):
// เช็คซอร์สโค้ดของ nodemailer แล้วพบว่า option "family" ที่ส่งเข้า
// createTransport() ไม่ได้ถูกส่งต่อไปให้ net.connect()/tls.connect() จริงๆ เลย
// (nodemailer ไม่ได้อ่านค่านี้) ปัญหาจริงๆ คือ Node ตั้งแต่เวอร์ชัน 17+ ค่า default
// จะ resolve DNS แบบคืนทั้ง IPv6 (AAAA) และ IPv4 (A) แล้วลองต่อ IPv6 ก่อนเสมอ
// (Happy Eyeballs) พอเครือข่ายขาออกของ Render ต่อ IPv6 ไม่ได้จริง (ไม่มี route)
// เลยพัง "connect ENETUNREACH" ทันทีตั้งแต่ก่อนจะได้ลอง IPv4 เลยด้วยซ้ำ — วิธีแก้ที่
// ตรงจุดคือสั่งทั้งโปรเซสให้ resolve DNS แบบเอา IPv4 ขึ้นก่อนเสมอด้วย
// dns.setDefaultResultOrder('ipv4first') ตรงนี้ ก่อนโค้ดส่วนอื่น (รวมถึง nodemailer,
// Supabase, Postgres) จะได้ครอบคลุมทุกจุดที่ต่อเน็ตออกไปจากเซิร์ฟเวอร์ ไม่ใช่แค่
// nodemailer ที่แก้ไปแล้วไม่ได้ผลจริง
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const app = express();
app.use(cors());
app.use(express.json());

// ===== ตั้งค่า Socket.IO (แจ้งเตือนแบบ real-time แทน Firebase) =====
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }, // เดโม/โปรเจกต์จบ เปิดกว้างไว้ก่อน ถ้าขึ้น production จริงควรจำกัด origin
});

// ✅ เก็บ mapping ว่า userId+userType ไหน ต่อ socket ไหนอยู่ (เก็บใน memory เฉยๆ พอ ไม่ต้องมี DB)
// key รูปแบบ "customer_12" หรือ "repair_5" -> socket.id
const connectedUsers = {};

io.on('connection', (socket) => {
  console.log('🔌 มีอุปกรณ์เชื่อมต่อ socket:', socket.id);

  // ✅ ฝั่ง Flutter จะยิง event นี้มาทันทีหลังเชื่อมต่อสำเร็จ (มี userId + userType อยู่แล้วจากตอนล็อกอิน)
  socket.on('register', ({ userId, userType }) => {
    if (!userId || !userType) return;
    connectedUsers[`${userType}_${userId}`] = socket.id;
    console.log(`✅ ลงทะเบียน ${userType}_${userId} -> ${socket.id}`);
  });

  socket.on('disconnect', () => {
    // ล้าง mapping ของ socket ที่หลุดการเชื่อมต่อออก
    for (const key in connectedUsers) {
      if (connectedUsers[key] === socket.id) delete connectedUsers[key];
    }
  });
});

// ✅ ฟังก์ชันกลาง ใช้ส่งแจ้งเตือนแบบ real-time ไปยังผู้ใช้คนเดียว (แทนที่ sendPushNotification เดิม)
// ถ้าผู้ใช้คนนั้นไม่ได้เปิดแอปอยู่ (ไม่มี socket เชื่อมต่ออยู่) ข้อความจะหายไปเฉยๆ
// (ข้อจำกัดของ Socket.IO เทียบกับ Firebase คือต้องเปิดแอปทิ้งไว้ถึงจะได้รับ)
function sendPushNotification(userId, userType, title, body, data = {}) {
  const socketId = connectedUsers[`${userType}_${userId}`];
  if (!socketId) {
    console.log(`⚠️ ไม่พบ socket ของ ${userType}_${userId} (ผู้ใช้อาจไม่ได้เปิดแอปอยู่)`);
    return;
  }
  io.to(socketId).emit('notification', { title, body, data });
  console.log('✅ ส่งแจ้งเตือน real-time สำเร็จ:', title);
}


// ตั้งค่าตัวส่งอีเมลผ่าน SMTP (Gmail)
// ✅ แก้บั๊ก: เดิม secure: false ตายตัว ถ้าใครเปลี่ยน SMTP_PORT เป็น 465 (SSL ตรงๆ)
// จะต่อไม่ติดเพราะ secure ต้องเป็น true คู่กับพอร์ต 465 เท่านั้น เปลี่ยนให้คำนวณ
// จากพอร์ตอัตโนมัติแทน — เผื่อพอร์ต 587 (STARTTLS) โดน Render บล็อก/ต่อไม่ติด
// (เจอจริงจาก log "Connection timeout") จะได้แค่เปลี่ยนค่า SMTP_PORT เป็น 465
// ใน Environment ของ Render แล้วลองใหม่ได้เลยโดยไม่ต้องแก้โค้ดเพิ่ม
// เพิ่ม timeout สั้นๆ (10 วิ) กันค้างนานเป็นนาทีเหมือนที่เจอ ให้ fail เร็วและ
// ตอบกลับแอปทันเวลาแทนที่แอปจะ timeout ตัวเองไปก่อนได้คำตอบจริงจากเซิร์ฟเวอร์
// ✅ แก้บั๊ก: เจอจริงจาก log "connect ENETUNREACH 2607:f8b0:...:587" — Render
// พยายามต่อ Gmail SMTP ผ่าน IPv6 (DNS ของ smtp.gmail.com คืนทั้ง IPv4/IPv6 มา
// Node เลือกลอง IPv6 ก่อน) แต่เครือข่ายขาออกของ Render ไม่รองรับ IPv6 เลยต่อไม่ติด
// ทันที (Network unreachable) ทั้งที่ IPv4 ใช้งานได้ปกติ — ใส่ family: 4 บังคับให้
// nodemailer ต่อผ่าน IPv4 เท่านั้น แก้ปัญหานี้ตรงจุด
const smtpPort = Number(process.env.SMTP_PORT) || 587;
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465, // 465 = SSL ตรงๆ, 587 = STARTTLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  family: 4, // บังคับใช้ IPv4 กัน ENETUNREACH จาก IPv6 ที่ Render ต่อไม่ติด
});

// เช็คตอน server เริ่มทำงานว่าตั้งค่า SMTP ถูกไหม (ช่วย debug)
transporter.verify((err) => {
  if (err) {
    console.error('❌ ตั้งค่า SMTP ไม่ถูกต้อง:', err.message);
  } else {
    console.log('✅ พร้อมส่งอีเมลผ่าน SMTP');
  }
});

// ✅ Health-check endpoint แบบเบาที่สุด — ไม่แตะฐานข้อมูลเลย ใช้ให้บริการ ping
// ภายนอก (เช่น UptimeRobot / cron-job.org) เรียกเป็นระยะเพื่อกัน Render แพ็กเกจฟรี
// "หลับ" หลังไม่มีคนใช้งานนาน 15 นาที ตอบกลับทันทีไม่ต้องรอ query DB
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// ✅ ใช้ memoryStorage แทน diskStorage เดิม — ไฟล์จะอยู่ใน req.file.buffer ชั่วคราว
// แล้วอัปโหลดต่อไปเก็บที่ Supabase Storage (uploadToSupabase) แทนการเขียนลงดิสก์ของ Render
// เหตุผล: ดิสก์ของ Render แพ็กเกจฟรีเป็น ephemeral ไฟล์หายทุกครั้งที่ redeploy/restart
const memStorage = multer.memoryStorage();
const upload = multer({ storage: memStorage, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadRepairPhotos = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
}).array('photos', 5); // สูงสุด 5 รูปต่อคำขอ

const uploadSlip = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('slip'); // สลิปโอนเงิน 1 รูปต่อการชำระเงิน

const uploadChatImage = multer({
  storage: memStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('image'); // แนบรูปในแชทได้ 1 รูปต่อข้อความ

// ✅ ใช้ตัวแปรนี้แทนการฝัง 127.0.0.1 ตายตัวในทุก URL รูปภาพ
// ตั้งค่าใน .env เป็น SERVER_HOST=<IP เครื่อง Mac> เวลาทดสอบผ่านมือถือจริง
// (ไม่ตั้งก็ได้ ถ้าทดสอบผ่าน Simulator/Chrome บนเครื่องเดียวกัน จะ fallback เป็น 127.0.0.1 ให้เอง)
const SERVER_HOST = process.env.SERVER_HOST || '127.0.0.1';
const PORT = process.env.PORT || 3000; // ✅ Railway จะกำหนด PORT ให้เองอัตโนมัติผ่าน env var นี้

// ✅ URL สาธารณะของ backend — ตอนรันในเครื่องจะประกอบจาก SERVER_HOST+PORT เหมือนเดิม
// ตอน deploy บน Railway ให้ตั้งค่า PUBLIC_URL เป็นโดเมนที่ Railway ให้มาแทน (ไม่มี port ต่อท้าย เพราะ Railway ใช้ HTTPS 443 อัตโนมัติ)
const PUBLIC_URL = process.env.PUBLIC_URL || `http://${SERVER_HOST}:${PORT}`;

// ✅ แปลงค่าที่เก็บไว้ใน DB (ชื่อไฟล์) ให้เป็น URL เต็มของ Supabase Storage เสมอ
// (ย้ายจากการเก็บไฟล์บนดิสก์ของ Render มาเก็บที่ Supabase Storage แทน เพราะดิสก์ของ
// Render แพ็กเกจฟรีเป็น ephemeral หายทุกครั้งที่ redeploy — ดู supabase_storage.js)
function toImageUrl(value) {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value; // ✅ เผื่อของเก่าที่เคยเก็บเป็น URL เต็มไว้ก่อนหน้านี้
  const filename = value.includes('/') ? value.split('/').pop() : value;
  return publicUrlFor(filename);
}

// ✅ แปลงคอลัมน์ photos (เก็บเป็น JSON string ของชื่อไฟล์ เช่น '["a.jpg","b.jpg"]') ให้เป็น array ของ URL เต็ม
function toPhotoUrls(photosJson) {
  let filenames = [];
  try {
    filenames = photosJson ? JSON.parse(photosJson) : [];
  } catch (e) {
    filenames = [];
  }
  return filenames.map((p) => toImageUrl(p));
}

// ✅ ย้ายจาก MySQL local ไป Supabase Postgres แล้ว (phase 2 ของการย้าย backend)
// db_pg.js เป็น compatibility shim ที่ทำให้ db.query()/dbPool.query() ยังมีหน้าตา
// และพฤติกรรมเหมือน mysql2 เดิมทุกจุด (ทั้งแบบ callback และ promise/transaction)
// แต่ข้างในต่อ Postgres ผ่าน DATABASE_URL ใน .env จริงๆ — ไม่ต้องแก้ query ทั่วทั้ง
// ไฟล์นี้กว่า 100 จุด ดูรายละเอียดการแปลง placeholder/ผลลัพธ์ได้ในคอมเมนต์ของ db_pg.js
//
// ⚠️ ตัวแปร DB_HOST/DB_USER/DB_PASSWORD/DB_NAME/DB_PORT เดิม (MySQL) ไม่ได้ใช้แล้ว
// ตอนนี้ทุกอย่างต่อผ่าน DATABASE_URL ตัวเดียว
const { db, dbPool } = require('./db_pg');

db.connect((err) => {
  if (err) {
    console.error('❌ เชื่อมต่อ DB ไม่ได้:', err.message);
  }
});

// ✅ เพิ่มใหม่: สร้างตาราง complaints อัตโนมัติถ้ายังไม่มี — endpoint ข้อร้องเรียนเตรียมไว้
// รอฝั่งลูกค้ามานานแล้ว (ดูคอมเมนต์เดิมใกล้ POST /api/complaints ด้านล่าง) แต่ไม่เคยมีใคร
// สร้างตารางจริงในฐานข้อมูลเลย ทำให้ก่อนหน้านี้ /api/admin/complaints คืนค่าว่างเปล่าตลอด
// (ดักด้วย try/catch ไว้อยู่แล้ว) — ตอนนี้สร้างให้อัตโนมัติตอน server เริ่มทำงานทุกครั้ง
// (IF NOT EXISTS จึงปลอดภัย รันซ้ำได้ไม่มีผลข้างเคียง)
dbPool
  .query(
    `CREATE TABLE IF NOT EXISTS complaints (
      id SERIAL PRIMARY KEY,
      reporter_id INTEGER NOT NULL,
      garage_id INTEGER,
      subject TEXT NOT NULL,
      detail TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`
  )
  .then(() => console.log('✅ ตาราง complaints พร้อมใช้งาน'))
  .catch((err) => console.error('❌ สร้างตาราง complaints ไม่สำเร็จ:', err.message));

// ✅ ระบบ wallet + หักค่าคอมมิชชั่นแบบ Grab-style (แทนที่ระบบสมุดบัญชีเดิม)
// ต้อง mount ตรงนี้ (หลัง dbPool ถูกประกาศแล้วเท่านั้น) — เดิมวางไว้ก่อนหน้านี้
// (ตอน uploadSlip/toImageUrl เพิ่งถูกประกาศ) ทำให้เรียกใช้ dbPool ก่อนมันจะถูก
// initialize จริง เกิด ReferenceError: Cannot access 'dbPool' before initialization
// เพราะ const อยู่ใน temporal dead zone จนกว่าจะรันมาถึงบรรทัดประกาศจริง
const walletRoutes = require('./wallet_routes')(dbPool, uploadSlip, toImageUrl, uploadToSupabase);
app.use('/api', walletRoutes);

// ✅ เก็บ OTP ชั่วคราวไว้ใน memory (email -> { otp, expiresAt })
// หมายเหตุ: ถ้า restart server ข้อมูล OTP จะหายไป ต้องขอใหม่
const otpStore = {};

// ✅ เครดิตต้อนรับสำหรับอู่ที่สมัครใหม่ (บาท) — ดูคอมเมนต์ตรงจุด INSERT INTO garages
// ด้านล่าง; ปรับตัวเลขนี้ที่เดียวถ้าต้องการเปลี่ยนนโยบาย
const kNewGarageWelcomeCredit = 300;

// ===== REGISTER =====
app.post('/api/auth/register', async (req, res) => {
  const { firstName, lastName, phone, email, password, userType } = req.body;

  if (!email || !password || !userType) {
    return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  try {
    db.query('SELECT id FROM users WHERE email = ?', [email], async (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
      if (results.length > 0) {
        return res.json({ success: false, message: 'อีเมลนี้ถูกใช้งานแล้ว' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      db.query(
        'INSERT INTO users (email, password, user_type) VALUES (?, ?, ?) RETURNING id',
        [email, hashedPassword, userType],
        (err, result) => {
          if (err) return res.json({ success: false, message: 'บันทึกข้อมูลไม่สำเร็จ' });

          const userId = result.insertId;

          if (userType === 'customer') {
            db.query(
              'INSERT INTO customers (user_id, first_name, last_name, phone) VALUES (?, ?, ?, ?) RETURNING id',
              [userId, firstName, lastName, phone],
              (err) => {
                if (err) return res.json({ success: false, message: 'บันทึกข้อมูลลูกค้าไม่สำเร็จ' });
                res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });
              }
            );
          } else if (userType === 'repair') {
            // ✅ อู่ใหม่เริ่มที่ wallet_balance = 0 เดิม แล้วโดนหักค่าคอมมิชชั่นตั้งแต่งานแรกที่ปิด
            // ทันที ทำให้ยอดติดลบ/ต้องเติมเงินตั้งแต่ยังไม่เห็นผลตอบแทนจากแพลตฟอร์มเลย — ให้
            // เครดิตต้อนรับเริ่มต้นแทน (หักค่าคอมฯ ตามปกติทุกงานเหมือนเดิม ไม่ได้ยกเว้นให้)
            // เพื่อลด friction ตอนเริ่มใช้งานโดยไม่กระทบรายได้ระยะยาวของระบบ
            db.query(
              'INSERT INTO garages (user_id, shop_name, owner_name, phone, wallet_balance) VALUES (?, ?, ?, ?, ?) RETURNING id',
              [userId, firstName, lastName, phone, kNewGarageWelcomeCredit],
              (err) => {
                if (err) return res.json({ success: false, message: 'บันทึกข้อมูลอู่ซ่อมไม่สำเร็จ' });
                res.json({ success: true, message: 'สมัครสมาชิกอู่ซ่อมสำเร็จ' });
              }
            );
          }
        }
      );
    });
  } catch (e) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// ===== LOGIN =====
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ success: false, message: 'กรุณากรอกอีเมลและรหัสผ่าน' });
  }

  // ✅ รวม query ผู้ใช้ + โปรไฟล์ลูกค้า/อู่ ให้เหลือ round-trip เดียว (LEFT JOIN ทั้งสองตาราง
  // เพราะยังไม่รู้ user_type ก่อน query — ตารางที่ไม่ตรง user_type จะได้ค่า NULL ทั้งแถว)
  db.query(
    `SELECT u.*,
            c.first_name AS cust_first_name, c.last_name AS cust_last_name, c.phone AS cust_phone,
            c.address AS cust_address, c.car_model AS cust_car_model, c.car_plate AS cust_car_plate,
            c.avatar AS cust_avatar, c.latitude AS cust_latitude, c.longitude AS cust_longitude,
            g.shop_name AS garage_shop_name, g.owner_name AS garage_owner_name, g.phone AS garage_phone,
            g.address AS garage_address, g.avatar AS garage_avatar, g.hours_weekday AS garage_hours_weekday,
            g.hours_weekend AS garage_hours_weekend, g.services AS garage_services,
            g.latitude AS garage_latitude, g.longitude AS garage_longitude
     FROM users u
     LEFT JOIN customers c ON c.user_id = u.id
     LEFT JOIN garages g ON g.user_id = u.id
     WHERE u.email = ?`,
    [email],
    async (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
      if (results.length === 0) {
        return res.json({ success: false, message: 'ไม่พบบัญชีนี้ในระบบ' });
      }

      const user = results[0];
      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.json({ success: false, message: 'รหัสผ่านไม่ถูกต้อง' });
      }

      // ✅ ช่าง (technician) — ยังต้อง query แยกเพราะต้อง JOIN ตาราง garages ผ่าน garage_id ของช่างเอง
      // (ไม่ใช่ garages ที่ user_id ตรงกับตัวช่าง) จึงรวมกับ query แรกไม่ได้
      if (user.user_type === 'technician') {
        db.query(
          `SELECT t.id AS technician_id, t.name, t.phone, t.avatar, t.garage_id, t.status,
                  g.shop_name
           FROM technicians t
           JOIN garages g ON g.user_id = t.garage_id
           WHERE t.user_id = ?`,
          [user.id],
          (err2, techResults) => {
            if (err2) return res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
            const profile = techResults[0] || {};
            profile.avatar = toImageUrl(profile.avatar);

            if (profile.status === 'inactive') {
              return res.json({ success: false, message: 'บัญชีนี้ถูกระงับการใช้งานแล้ว กรุณาติดต่ออู่' });
            }

            res.json({
              success: true,
              message: 'เข้าสู่ระบบสำเร็จ',
              data: {
                user: {
                  id: user.id,
                  email: user.email,
                  userType: user.user_type,
                  ...profile,
                },
              },
            });
          }
        );
        return;
      }

      // ✅ Admin — บัญชีผู้ดูแลระบบ ไม่มีตาราง profile แยก (ไม่มี shop/customer info ให้ผูก)
      if (user.user_type === 'admin') {
        return res.json({
          success: true,
          message: 'เข้าสู่ระบบสำเร็จ',
          data: {
            user: {
              id: user.id,
              email: user.email,
              userType: user.user_type,
              name: 'ผู้ดูแลระบบ',
            },
          },
        });
      }

      // ✅ ลูกค้า/อู่ — โปรไฟล์มาจากการ JOIN ใน query แรกแล้ว ไม่ต้อง query ซ้ำอีกรอบ
      let profile = {};
      if (user.user_type === 'customer') {
        profile = {
          first_name: user.cust_first_name,
          last_name: user.cust_last_name,
          phone: user.cust_phone,
          address: user.cust_address,
          car_model: user.cust_car_model,
          car_plate: user.cust_car_plate,
          avatar: user.cust_avatar,
          latitude: user.cust_latitude,
          longitude: user.cust_longitude,
        };
      } else {
        profile = {
          shop_name: user.garage_shop_name,
          owner_name: user.garage_owner_name,
          phone: user.garage_phone,
          address: user.garage_address,
          avatar: user.garage_avatar,
          hours_weekday: user.garage_hours_weekday,
          hours_weekend: user.garage_hours_weekend,
          services: user.garage_services,
          latitude: user.garage_latitude,
          longitude: user.garage_longitude,
        };

        // services เก็บเป็น JSON string ใน DB -> แปลงกลับเป็น array ก่อนส่งให้ Flutter
        if (profile.services) {
          try {
            profile.services = JSON.parse(profile.services);
          } catch (e) {
            profile.services = [];
          }
        }
      }

      // ✅ แปลงเป็น URL เต็มด้วย IP ปัจจุบันเสมอ (ใช้ได้ทั้งข้อมูลเก่า/ใหม่)
      profile.avatar = toImageUrl(profile.avatar);

      res.json({
        success: true,
        message: 'เข้าสู่ระบบสำเร็จ',
        data: {
          user: {
            id: user.id,
            email: user.email,
            userType: user.user_type,
            ...profile,
          },
        },
      });
    }
  );
});

// ===== UPDATE PROFILE =====
app.put('/api/user/update', (req, res) => {
  const {
    userId, name, phone, address, carModel, carPlate, userType,
    ownerName, hoursWeekday, hoursWeekend, services,
    latitude, longitude,
  } = req.body;

  if (!userId) return res.json({ success: false, message: 'ไม่พบ userId' });

  if (userType === 'customer') {
    const parts = name.trim().split(' ');
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';

    db.query(
      `UPDATE customers
       SET first_name = ?, last_name = ?, phone = ?, address = ?,
           car_model = ?, car_plate = ?, latitude = ?, longitude = ?
       WHERE user_id = ?`,
      [
        firstName, lastName, phone, address, carModel, carPlate,
        latitude ?? null, longitude ?? null,
        userId,
      ],
      (err) => {
        if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
        res.json({ success: true, message: 'บันทึกข้อมูลสำเร็จ' });
      }
    );
  } else if (userType === 'repair') {
    // services ส่งมาเป็น array จาก Flutter (List<String> หรือ List<Map> ที่มี name/price)
    // -> เก็บเป็น JSON string ในคอลัมน์ TEXT
    const servicesJson = services !== undefined ? JSON.stringify(services) : null;

    db.query(
      `UPDATE garages
       SET shop_name = ?, phone = ?, address = ?,
           owner_name = ?, hours_weekday = ?, hours_weekend = ?, services = ?,
           latitude = ?, longitude = ?
       WHERE user_id = ?`,
      [
        name,
        phone,
        address,
        ownerName ?? null,
        hoursWeekday ?? null,
        hoursWeekend ?? null,
        servicesJson,
        latitude ?? null,
        longitude ?? null,
        userId,
      ],
      (err) => {
        if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
        res.json({ success: true, message: 'บันทึกข้อมูลสำเร็จ' });
      }
    );
  }
});

// ===== GET PROFILE =====
// ✅ JOIN ตาราง users เพื่อดึง email กลับมาด้วย (ไม่งั้น email จะหายไปตอน refresh)
app.get('/api/user/profile', (req, res) => {
  const { userId, userType } = req.query;
  const table = userType === 'customer' ? 'customers' : 'garages';
  const alias = 't';
  const cols = userType === 'customer'
    ? `${alias}.first_name, ${alias}.last_name, ${alias}.phone, ${alias}.address, ${alias}.car_model, ${alias}.car_plate, ${alias}.avatar, ${alias}.latitude, ${alias}.longitude`
    : `${alias}.shop_name, ${alias}.owner_name, ${alias}.phone, ${alias}.address, ${alias}.avatar, ${alias}.hours_weekday, ${alias}.hours_weekend, ${alias}.services, ${alias}.latitude, ${alias}.longitude`;

  db.query(
    `SELECT ${cols}, u.email
     FROM ${table} ${alias}
     JOIN users u ON u.id = ${alias}.user_id
     WHERE ${alias}.user_id = ?`,
    [userId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const profile = results[0] || {};

      // services เก็บเป็น JSON string ใน DB -> แปลงกลับเป็น array ก่อนส่งให้ Flutter
      if (userType !== 'customer' && profile.services) {
        try {
          profile.services = JSON.parse(profile.services);
        } catch (e) {
          profile.services = [];
        }
      }

      // ✅ แปลงเป็น URL เต็มด้วย IP ปัจจุบันเสมอ (ใช้ได้ทั้งข้อมูลเก่า/ใหม่)
      profile.avatar = toImageUrl(profile.avatar);

      res.json({
        success: true,
        message: 'ดึงข้อมูลสำเร็จ',
        data: { user: { id: parseInt(userId), userType, ...profile } },
      });
    }
  );
});

// ===== REQUEST EMAIL CHANGE (ส่ง OTP ไปอีเมลใหม่เพื่อยืนยันว่าเป็นเจ้าของจริง) =====
app.post('/api/auth/request-email-change', (req, res) => {
  const { userId, newEmail } = req.body;
  if (!userId || !newEmail) {
    return res.json({ success: false, message: 'กรุณากรอกอีเมลใหม่' });
  }

  db.query('SELECT id FROM users WHERE email = ?', [newEmail], (err, results) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (results.length > 0) {
      return res.json({ success: false, message: 'อีเมลนี้ถูกใช้งานแล้ว' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // เลข 6 หลัก
    otpStore[`email_change_${userId}`] = {
      otp,
      newEmail,
      expiresAt: Date.now() + 10 * 60 * 1000, // หมดอายุใน 10 นาที
    };

    transporter.sendMail(
      {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: newEmail,
        subject: 'รหัส OTP สำหรับยืนยันการเปลี่ยนอีเมล',
        html: `
          <p>รหัส OTP สำหรับยืนยันอีเมลใหม่ของคุณคือ:</p>
          <h2 style="letter-spacing:4px">${otp}</h2>
          <p>รหัสนี้จะหมดอายุภายใน 10 นาที</p>
          <p>หากคุณไม่ได้เป็นผู้ขอเปลี่ยนอีเมล กรุณาเพิกเฉยต่ออีเมลฉบับนี้</p>
        `,
      },
      (err) => {
        if (err) {
          console.error('❌ ส่งอีเมลไม่สำเร็จ:', err.message);
          delete otpStore[`email_change_${userId}`];
          return res.json({ success: false, message: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่' });
        }
        res.json({
          success: true,
          message: 'ส่งรหัส OTP ไปที่อีเมลใหม่แล้ว กรุณาตรวจสอบกล่องจดหมาย',
        });
      }
    );
  });
});

// ===== CONFIRM EMAIL CHANGE (ยืนยัน OTP แล้วเปลี่ยนอีเมลจริงใน DB) =====
app.post('/api/auth/confirm-email-change', (req, res) => {
  const { userId, otp } = req.body;
  if (!userId || !otp) {
    return res.json({ success: false, message: 'กรุณากรอกรหัส OTP' });
  }

  const key = `email_change_${userId}`;
  const record = otpStore[key];
  if (!record) {
    return res.json({ success: false, message: 'กรุณาขอรหัส OTP ใหม่อีกครั้ง' });
  }
  if (Date.now() > record.expiresAt) {
    delete otpStore[key];
    return res.json({ success: false, message: 'รหัส OTP หมดอายุแล้ว กรุณาขอใหม่' });
  }
  if (record.otp !== otp) {
    return res.json({ success: false, message: 'รหัส OTP ไม่ถูกต้อง' });
  }

  db.query(
    'UPDATE users SET email = ? WHERE id = ?',
    [record.newEmail, userId],
    (err) => {
      if (err) return res.json({ success: false, message: 'เปลี่ยนอีเมลไม่สำเร็จ: ' + err.message });
      delete otpStore[key]; // ใช้แล้วลบทิ้ง
      res.json({
        success: true,
        message: 'เปลี่ยนอีเมลสำเร็จ',
        data: { email: record.newEmail },
      });
    }
  );
});

// ===== LIST / SEARCH GARAGES (สำหรับหน้า Dashboard ฝั่งลูกค้า) =====
// รองรับ query param:
//   service = ชื่อหมวดบริการ เช่น "ยาง" (กรองเฉพาะอู่ที่ตั้งราคาบริการนี้ไว้)
//   keyword = คำค้นชื่อร้าน
app.get('/api/garages', (req, res) => {
  const { service, keyword } = req.query;

  let sql = `SELECT g.id, g.user_id, g.shop_name, g.phone, g.address, g.avatar,
                    g.services, g.hours_weekday, g.hours_weekend,
                    g.latitude, g.longitude,
                    COALESCE(AVG(rv.rating), 0) AS rating, COUNT(rv.id) AS review_count
             FROM garages g
             LEFT JOIN reviews rv ON rv.garage_id = g.user_id
             WHERE 1=1`;
  const params = [];

  if (service) {
    // services เก็บเป็น JSON string เช่น [{"name":"ยาง","price":"..."}]
    // ใช้ LIKE ค้นหาแบบง่าย (เพียงพอสำหรับสเกลโปรเจกต์นี้)
    sql += ' AND g.services LIKE ?';
    params.push(`%"name":"${service}"%`);
  }
  if (keyword) {
    sql += ' AND g.shop_name LIKE ?';
    params.push(`%${keyword}%`);
  }
  sql += ' GROUP BY g.id';

  db.query(sql, params, (err, results) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });

    const garages = results.map((g) => {
      let services = [];
      try {
        services = g.services ? JSON.parse(g.services) : [];
      } catch (e) {
        services = [];
      }
      return { ...g, services, avatar: toImageUrl(g.avatar), rating: Number(g.rating) };
    });

    res.json({ success: true, message: 'ดึงข้อมูลสำเร็จ', data: { garages } });
  });
});

// ===== UPLOAD AVATAR ===== ✅ เพิ่มใหม่
app.post('/api/user/avatar', upload.single('avatar'), async (req, res) => {
  console.log('📸 Upload avatar called');
  console.log('Body:', req.body);

  if (!req.file) return res.json({ success: false, message: 'ไม่พบไฟล์รูปภาพ' });

  try {
    const { userId, userType } = req.body;
    const filename = await uploadToSupabase(req.file, 'avatar'); // ✅ เก็บที่ Supabase Storage แทนดิสก์ของ Render
    const table = userType === 'customer' ? 'customers' : 'garages';

    db.query(
      `UPDATE ${table} SET avatar = ? WHERE user_id = ?`,
      [filename, userId],
      (err) => {
        if (err) {
          console.error('DB error:', err.message);
          return res.json({ success: false, message: 'บันทึกรูปไม่สำเร็จ' });
        }
        const avatarUrl = toImageUrl(filename);
        console.log('✅ Avatar saved:', filename, '->', avatarUrl);
        res.json({ success: true, message: 'อัปโหลดรูปสำเร็จ', data: { avatarUrl } });
      }
    );
  } catch (uploadErr) {
    console.error('❌ Supabase Storage upload error:', uploadErr.message);
    res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });
  }
});


// ===== FORGOT PASSWORD (ขอ OTP) =====
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body;
  if (!email) return res.json({ success: false, message: 'กรุณากรอกอีเมล' });

  db.query('SELECT id FROM users WHERE email = ?', [email], (err, results) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด' });
    if (results.length === 0) {
      return res.json({ success: false, message: 'ไม่พบบัญชีที่ใช้อีเมลนี้' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // เลข 6 หลัก
    otpStore[email] = { otp, expiresAt: Date.now() + 10 * 60 * 1000 }; // หมดอายุใน 10 นาที

    // ✅ ส่งอีเมลจริงผ่าน Gmail
    transporter.sendMail(
      {
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'รหัส OTP สำหรับรีเซ็ตรหัสผ่าน',
        html: `
          <p>รหัส OTP สำหรับรีเซ็ตรหัสผ่านของคุณคือ:</p>
          <h2 style="letter-spacing:4px">${otp}</h2>
          <p>รหัสนี้จะหมดอายุภายใน 10 นาที</p>
          <p>หากคุณไม่ได้เป็นผู้ขอรีเซ็ตรหัสผ่าน กรุณาเพิกเฉยต่ออีเมลฉบับนี้</p>
        `,
      },
      (err, info) => {
        if (err) {
          console.error('❌ ส่งอีเมลไม่สำเร็จ:', err.message);
          delete otpStore[email];
          return res.json({ success: false, message: 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่' });
        }
        console.log(`📩 ส่ง OTP ไปที่ ${email} สำเร็จ`);
        res.json({
          success: true,
          message: 'ส่งรหัส OTP ไปที่อีเมลของคุณแล้ว กรุณาตรวจสอบกล่องจดหมาย',
        });
      }
    );
  });
});

// ===== RESET PASSWORD (ยืนยัน OTP + ตั้งรหัสผ่านใหม่) =====
app.post('/api/auth/reset-password', async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  const record = otpStore[email];
  if (!record) {
    return res.json({ success: false, message: 'กรุณาขอรหัส OTP ใหม่อีกครั้ง' });
  }
  if (Date.now() > record.expiresAt) {
    delete otpStore[email];
    return res.json({ success: false, message: 'รหัส OTP หมดอายุแล้ว กรุณาขอใหม่' });
  }
  if (record.otp !== otp) {
    return res.json({ success: false, message: 'รหัส OTP ไม่ถูกต้อง' });
  }

  try {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.query(
      'UPDATE users SET password = ? WHERE email = ?',
      [hashedPassword, email],
      (err) => {
        if (err) return res.json({ success: false, message: 'เปลี่ยนรหัสผ่านไม่สำเร็จ: ' + err.message });
        delete otpStore[email]; // ใช้แล้วลบทิ้ง
        res.json({ success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
      }
    );
  } catch (e) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

// ===== GET CARS (รายการรถทั้งหมดของผู้ใช้) =====
app.get('/api/cars', (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.json({ success: false, message: 'ไม่พบ userId' });

  db.query(
    'SELECT * FROM cars WHERE user_id = ? ORDER BY created_at DESC',
    [userId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: 'ดึงข้อมูลรถสำเร็จ', data: { cars: results } });
    }
  );
});

// ===== ADD CAR =====
app.post('/api/cars', (req, res) => {
  const { userId, carModel, carPlate, carBrand, carColor, carYear, carType } = req.body;

  if (!userId || !carModel || !carPlate) {
    return res.json({ success: false, message: 'กรุณากรอกรุ่นรถและทะเบียนรถให้ครบ' });
  }

  db.query(
    'INSERT INTO cars (user_id, car_model, car_type, car_plate, car_brand, car_color, car_year) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [userId, carModel, carType || null, carPlate, carBrand || null, carColor || null, carYear || null],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'เพิ่มรถไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'เพิ่มรถสำเร็จ', data: { id: result.insertId } });
    }
  );
});

// ===== UPDATE CAR =====
app.put('/api/cars/:id', (req, res) => {
  const { id } = req.params;
  const { carModel, carPlate, carBrand, carColor, carYear, carType } = req.body;

  if (!carModel || !carPlate) {
    return res.json({ success: false, message: 'กรุณากรอกรุ่นรถและทะเบียนรถให้ครบ' });
  }

  db.query(
    'UPDATE cars SET car_model = ?, car_type = ?, car_plate = ?, car_brand = ?, car_color = ?, car_year = ? WHERE id = ?',
    [carModel, carType || null, carPlate, carBrand || null, carColor || null, carYear || null, id],
    (err) => {
      if (err) return res.json({ success: false, message: 'แก้ไขข้อมูลรถไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'บันทึกการแก้ไขสำเร็จ' });
    }
  );
});

// ===== DELETE CAR =====
app.delete('/api/cars/:id', (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM cars WHERE id = ?', [id], (err) => {
    if (err) return res.json({ success: false, message: 'ลบรถไม่สำเร็จ: ' + err.message });
    res.json({ success: true, message: 'ลบรถสำเร็จ' });
  });
});

// ===== CREATE REPAIR REQUEST (ส่งคำขอซ่อมรถ) =====
app.post('/api/repair-requests', (req, res) => {
  uploadRepairPhotos(req, res, async (err) => {
    if (err) return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + err.message });

    const { customerId, garageId, carId, vehicleType, problemCategory, description, address, latitude, longitude } = req.body;

    if (!customerId || !garageId || !problemCategory) {
      return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
    }
    // ✅ ต้องมีอย่างใดอย่างหนึ่ง: carId (เลือกจาก "รถของฉัน" — วิธีใหม่) หรือ vehicleType
    // (ส่งมาตรงๆ — เผื่อแอปเวอร์ชันเก่ายังไม่ได้อัปเดตหน้าเลือกรถ)
    if (!carId && !vehicleType) {
      return res.json({ success: false, message: 'กรุณาเลือกรถที่ต้องการซ่อม' });
    }

    let photoFilenames = [];
    try {
      photoFilenames = await Promise.all((req.files || []).map((f) => uploadToSupabase(f, 'photo'))); // ✅ เก็บที่ Supabase Storage แทนดิสก์ของ Render
    } catch (uploadErr) {
      return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });
    }

    // ✅ ฟังก์ชันบันทึกจริง แยกออกมาเพราะถ้ามี carId ต้องไปดึง car_type ของรถคันนั้นมา
    // ก่อน (เก็บ vehicle_type ไว้เหมือนเดิมเพื่อ backward-compat กับส่วนอื่นที่ยังอ้างอิงคอลัมน์นี้)
    const insertRequest = (resolvedVehicleType) => {
      db.query(
        `INSERT INTO repair_requests
          (customer_id, garage_id, car_id, vehicle_type, problem_category, description, photos, address, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          customerId,
          garageId,
          carId || null,
          resolvedVehicleType || 'other',
          problemCategory,
          description || '',
          JSON.stringify(photoFilenames),
          address || '',
          latitude || null,
          longitude || null,
        ],
        (err, result) => {
          if (err) return res.json({ success: false, message: 'ส่งคำขอไม่สำเร็จ: ' + err.message });
          res.json({
            success: true,
            message: 'ส่งคำขอซ่อมสำเร็จ อู่ซ่อมรถจะติดต่อกลับภายใน 15 นาที',
            data: { id: result.insertId },
          });

          // ✅ แจ้งเตือนอู่ว่ามีคำขอซ่อมใหม่เข้ามา (ส่งหลัง response แล้ว ไม่ทำให้ลูกค้าต้องรอ)
          // ✅ Socket.IO ไม่ต้องดึง token จาก DB เหมือน Firebase อีกแล้ว รู้แค่ userId+userType ก็ส่งได้เลย
          const vehicleLabel = { sedan: 'รถเก๋ง', suv: 'SUV', pickup: 'กระบะ' }[resolvedVehicleType] || 'รถ';
          sendPushNotification(
            garageId,
            'repair',
            'มีคำขอซ่อมใหม่ 🔧',
            `${problemCategory} - ${vehicleLabel}`,
            { type: 'new_request', requestId: result.insertId }
          );
        }
      );
    };

    if (carId) {
      db.query('SELECT car_type FROM cars WHERE id = ?', [carId], (err, rows) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
        insertRequest(rows[0]?.car_type || vehicleType);
      });
    } else {
      insertRequest(vehicleType);
    }
  });
});

// ===== GET REPAIR REQUESTS =====
// รองรับ 2 โหมด:
//   ?garageId=  -> ฝั่งอู่ ดูคำขอที่ลูกค้าส่งเข้ามา (JOIN ชื่อลูกค้า)
//   ?customerId=-> ฝั่งลูกค้า ดูประวัติคำขอที่ตัวเองส่งไป (JOIN ชื่ออู่)
app.get('/api/repair-requests', (req, res) => {
  const { garageId, customerId, technicianId } = req.query;
  if (!garageId && !customerId && !technicianId) {
    return res.json({ success: false, message: 'ไม่พบ garageId, customerId หรือ technicianId' });
  }

  let sql;
  let param;
  if (garageId) {
    sql = `SELECT rr.id, rr.customer_id, rr.garage_id, rr.car_id, rr.vehicle_type, rr.problem_category,
              rr.description, rr.photos, rr.address, rr.latitude, rr.longitude,
              rr.status, rr.rejection_reason, rr.assigned_technician_id, rr.created_at,
              rr.assignment_date, rr.assignment_note, rr.completed_at,
              c.first_name, c.last_name, c.avatar AS customer_avatar,
              cr.car_model, cr.car_type, cr.car_plate, cr.car_brand, cr.car_color, cr.car_year,
              t.name AS technician_name, t.phone AS technician_phone,
              rv.rating AS review_rating, rv.comment AS review_comment,
              p.id AS payment_id, p.status AS payment_status, p.method AS payment_method,
              p.amount AS payment_amount, p.slip_photo AS payment_slip,
              p.rejection_reason AS payment_rejection_reason, p.submitted_at AS payment_submitted_at,
              ct.commission_amount
       FROM repair_requests rr
       JOIN customers c ON c.user_id = rr.customer_id
       LEFT JOIN cars cr ON cr.id = rr.car_id
       LEFT JOIN technicians t ON t.id = rr.assigned_technician_id
       LEFT JOIN reviews rv ON rv.repair_request_id = rr.id
       LEFT JOIN payments p ON p.repair_request_id = rr.id
       LEFT JOIN commission_transactions ct ON ct.payment_id = p.id
       WHERE rr.garage_id = ?
       ORDER BY rr.created_at DESC`;
    param = garageId;
  } else if (customerId) {
    sql = `SELECT rr.id, rr.customer_id, rr.garage_id, rr.car_id, rr.vehicle_type, rr.problem_category,
              rr.description, rr.photos, rr.address, rr.latitude, rr.longitude,
              rr.status, rr.rejection_reason, rr.assigned_technician_id, rr.created_at,
              rr.assignment_date, rr.assignment_note, rr.completed_at,
              g.shop_name, g.avatar AS garage_avatar, g.phone AS garage_phone, g.address AS garage_address,
              g.bank_name, g.bank_account_number, g.bank_account_name, g.promptpay_id,
              cr.car_model, cr.car_type, cr.car_plate, cr.car_brand, cr.car_color, cr.car_year,
              t.name AS technician_name, t.phone AS technician_phone,
              rv.id AS review_id, rv.rating AS review_rating, rv.comment AS review_comment,
              rv.reply AS review_reply,
              p.id AS payment_id, p.status AS payment_status, p.method AS payment_method,
              p.amount AS payment_amount, p.slip_photo AS payment_slip,
              p.rejection_reason AS payment_rejection_reason, p.submitted_at AS payment_submitted_at
       FROM repair_requests rr
       JOIN garages g ON g.user_id = rr.garage_id
       LEFT JOIN cars cr ON cr.id = rr.car_id
       LEFT JOIN technicians t ON t.id = rr.assigned_technician_id
       LEFT JOIN reviews rv ON rv.repair_request_id = rr.id
       LEFT JOIN payments p ON p.repair_request_id = rr.id
       WHERE rr.customer_id = ?
       ORDER BY rr.created_at DESC`;
    param = customerId;
  } else {
    // ✅ ฝั่งช่าง: ดูเฉพาะงานที่ตัวเองถูกมอบหมาย (join ผ่าน technicians.user_id -> technicians.id)
    sql = `SELECT rr.id, rr.customer_id, rr.garage_id, rr.car_id, rr.vehicle_type, rr.problem_category,
              rr.description, rr.photos, rr.address, rr.latitude, rr.longitude,
              rr.status, rr.assigned_technician_id, rr.created_at,
              rr.assignment_date, rr.assignment_note, rr.completed_at,
              c.first_name, c.last_name, c.phone AS customer_phone,
              cr.car_model, cr.car_type, cr.car_plate, cr.car_brand, cr.car_color, cr.car_year
       FROM repair_requests rr
       JOIN customers c ON c.user_id = rr.customer_id
       LEFT JOIN cars cr ON cr.id = rr.car_id
       JOIN technicians t ON t.id = rr.assigned_technician_id
       WHERE t.user_id = ?
       ORDER BY rr.created_at DESC`;
    param = technicianId;
  }

  db.query(sql, [param], (err, results) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });

    const requests = results.map((r) => {
      let photos = [];
      try {
        photos = r.photos ? JSON.parse(r.photos) : [];
      } catch (e) {
        photos = [];
      }
      // ✅ แปลงรูปทุกรูปในคำขอนี้ + รูปโปรไฟล์ลูกค้า/อู่ ให้เป็น URL เต็มด้วย IP ปัจจุบันเสมอ
      return {
        ...r,
        photos: photos.map((p) => toImageUrl(p)),
        customer_avatar: r.customer_avatar ? toImageUrl(r.customer_avatar) : undefined,
        garage_avatar: r.garage_avatar ? toImageUrl(r.garage_avatar) : undefined,
        payment_slip: r.payment_slip ? toImageUrl(r.payment_slip) : undefined,
      };
    });

    res.json({ success: true, message: 'ดึงข้อมูลสำเร็จ', data: { requests } });
  });
});

// ===== UPDATE REPAIR REQUEST STATUS (อู่กด รับงาน / ปฏิเสธ) =====
app.put('/api/repair-requests/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, reason, garageId } = req.body; // 'accepted' | 'rejected' | 'done', reason ใช้เมื่อ rejected

  if (!['pending', 'accepted', 'rejected', 'done'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }

  // ✅ เดิม endpoint นี้ไม่เช็คเลยว่าอู่ที่เรียกมาเป็นเจ้าของคำขอซ่อมนี้จริง (แค่มี id
  // ก็รับ/ปฏิเสธคำขอของอู่ไหนก็ได้) — เพิ่มให้ฝั่ง Flutter ส่ง garageId มาด้วยแล้วเช็ค
  // ว่าตรงกับ garage_id ที่ผูกกับคำขอนี้ก่อนเสมอ (หมายเหตุ: ระบบนี้ยังไม่มี session/
  // token ยืนยันตัวตนจริงจัง garageId ที่ส่งมาจึงยังเป็นค่าที่ผู้เรียกอ้างเอง ไม่ใช่
  // การยืนยันตัวตนที่ป้องกันผู้ไม่หวังดีได้ 100% — กันบั๊ก/ความผิดพลาดของแอปเองเป็นหลัก)
  if (!garageId) {
    return res.json({ success: false, message: 'ไม่พบ garageId' });
  }
  const [[requestOwner]] = await dbPool.query('SELECT garage_id FROM repair_requests WHERE id = ?', [id]);
  if (!requestOwner) return res.json({ success: false, message: 'ไม่พบคำขอซ่อมนี้' });
  if (String(requestOwner.garage_id) !== String(garageId)) {
    return res.json({ success: false, message: 'ไม่มีสิทธิ์แก้ไขคำขอซ่อมนี้' });
  }

  // ✅ เช็ค wallet ก่อนอนุญาตให้อู่ "รับงาน" ใหม่ — กันอู่ที่ค้างค่าคอมมิชชั่นจนติดลบ
  // เกินลิมิตที่กำหนด (ตอนนี้ตั้ง -500 บาท ปรับเลขนี้ได้ตามนโยบายจริง) ไม่ให้รับงาน
  // เพิ่มจนกว่าจะเติมเงินเข้า wallet ก่อน
  if (status === 'accepted') {
    try {
      const ok = await canAcceptNewJob(dbPool, requestOwner.garage_id, -500);
      if (!ok) {
        return res.json({
          success: false,
          message: 'เครดิตใน wallet ไม่พอ กรุณาเติมเงินก่อนรับงานใหม่',
        });
      }
    } catch (walletErr) {
      console.error('⚠️ เช็ค wallet ไม่สำเร็จ:', walletErr.message);
      // ไม่บล็อกงานถ้าระบบเช็ค wallet เองมีปัญหา (fail-open) กันเป็นจุดเดียวที่ทำให้อู่รับงานไม่ได้เลย
    }
  }

  db.query(
    // ✅ status ที่ไม่ใช่ pending (คือ อู่เพิ่งตอบกลับ) ให้ตั้ง customer_seen = 0
    // เพื่อให้ตัวเลขที่กระดิ่งฝั่งลูกค้าขึ้นเตือนว่ามีการตอบกลับใหม่ที่ยังไม่ได้เปิดดู
    'UPDATE repair_requests SET status = ?, rejection_reason = ?, customer_seen = ? WHERE id = ? AND garage_id = ?',
    [status, status === 'rejected' ? (reason || null) : null, status === 'pending' ? 1 : 0, id, garageId],
    (err) => {
      if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });

      // ✅ ส่ง real-time notification แจ้งลูกค้า หลังตอบกลับ response ไปแล้ว (ไม่ทำให้ผู้ใช้ต้องรอ)
      // ดึง customer_id ของคำขอนี้ พร้อมชื่ออู่ ไว้ใส่ในข้อความแจ้งเตือน (ไม่ต้องดึง token แบบ Firebase อีกแล้ว)
      db.query(
        `SELECT rr.customer_id, g.shop_name
         FROM repair_requests rr
         JOIN garages g ON g.user_id = rr.garage_id
         WHERE rr.id = ?`,
        [id],
        (err2, results) => {
          if (err2 || results.length === 0) return;
          const { customer_id, shop_name } = results[0];

          if (status === 'accepted') {
            sendPushNotification(
              customer_id,
              'customer',
              'อู่รับงานของคุณแล้ว ✅',
              `${shop_name} รับคำขอซ่อมของคุณแล้ว รอการติดต่อกลับ`,
              { type: 'repair_status', requestId: id, status: 'accepted' }
            );
          } else if (status === 'rejected') {
            sendPushNotification(
              customer_id,
              'customer',
              'อู่ปฏิเสธคำขอซ่อม',
              reason ? `${shop_name}: ${reason}` : `${shop_name} ไม่สามารถรับงานนี้ได้`,
              { type: 'repair_status', requestId: id, status: 'rejected' }
            );
          } else if (status === 'done') {
            sendPushNotification(
              customer_id,
              'customer',
              'งานซ่อมเสร็จเรียบร้อย 🎉',
              `${shop_name} แจ้งว่างานซ่อมของคุณเสร็จแล้ว`,
              { type: 'repair_status', requestId: id, status: 'done' }
            );
          }
        }
      );
    }
  );
});

// ===== เพิ่มบัญชีช่างใหม่ (อู่กรอกอีเมล+รหัสผ่านให้ช่างเอง) =====
app.post('/api/technicians', async (req, res) => {
  const { garageId, name, phone, email, password, specialties } = req.body;
  if (!garageId || !name || !email || !password) {
    return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  try {
    db.query('SELECT id FROM users WHERE email = ?', [email], async (err, existing) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (existing.length > 0) {
        return res.json({ success: false, message: 'อีเมลนี้ถูกใช้งานแล้ว' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);
      db.query(
        'INSERT INTO users (email, password, user_type) VALUES (?, ?, ?) RETURNING id',
        [email, hashedPassword, 'technician'],
        (err2, result) => {
          if (err2) return res.json({ success: false, message: 'สร้างบัญชีไม่สำเร็จ: ' + err2.message });

          const newUserId = result.insertId;
          db.query(
            'INSERT INTO technicians (user_id, garage_id, name, phone, specialties) VALUES (?, ?, ?, ?, ?) RETURNING id',
            [newUserId, garageId, name, phone || null, specialties || null],
            (err3) => {
              if (err3) return res.json({ success: false, message: 'สร้างข้อมูลช่างไม่สำเร็จ: ' + err3.message });
              res.json({ success: true, message: 'เพิ่มช่างสำเร็จ' });
            }
          );
        }
      );
    });
  } catch (e) {
    res.json({ success: false, message: 'เกิดข้อผิดพลาดภายในระบบ: ' + e.message });
  }
});

// ===== ดูรายชื่อช่างในสังกัดอู่ (พร้อมจำนวนงานที่ถืออยู่ตอนนี้ ใช้ตัดสินว่า "ว่าง/ไม่ว่าง") =====
app.get('/api/technicians', (req, res) => {
  const { garageId } = req.query;
  if (!garageId) return res.json({ success: false, message: 'ไม่พบ garageId' });

  db.query(
    `SELECT t.id, t.user_id, t.name, t.phone, t.avatar, t.status, t.specialties, u.email,
            (SELECT COUNT(*) FROM repair_requests rr
             WHERE rr.assigned_technician_id = t.id AND rr.status IN ('assigned','in_progress')
            ) AS active_job_count
     FROM technicians t
     JOIN users u ON u.id = t.user_id
     WHERE t.garage_id = ?
     ORDER BY t.created_at DESC`,
    [garageId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const technicians = results.map((t) => ({ ...t, avatar: toImageUrl(t.avatar) }));
      res.json({ success: true, message: '', data: { technicians } });
    }
  );
});

// ===== เปิด/ปิดการใช้งานบัญชีช่าง =====
app.put('/api/technicians/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'active' | 'inactive'
  if (!['active', 'inactive'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  db.query('UPDATE technicians SET status = ? WHERE id = ?', [status, id], (err) => {
    if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
    res.json({ success: true, message: 'อัปเดตสำเร็จ' });
  });
});

// ===== มอบหมายงานให้ช่าง =====
app.put('/api/repair-requests/:id/assign', (req, res) => {
  const { id } = req.params;
  const { technicianId, assignmentDate, assignmentNote } = req.body;
  if (!technicianId) return res.json({ success: false, message: 'กรุณาเลือกช่าง' });

  // ✅ เดิมไม่เช็คเลยว่าช่างที่เลือก (technicianId) เป็นช่างในสังกัดอู่เจ้าของคำขอ
  // ซ่อมนี้จริง — เพิ่ม cross-check ระหว่าง technicians.garage_id กับ
  // repair_requests.garage_id ก่อนมอบหมายงาน กันมอบหมายงานให้ช่างอู่อื่นผิดคน
  db.query(
    `SELECT t.garage_id AS tech_garage_id, rr.garage_id AS request_garage_id
     FROM technicians t, repair_requests rr
     WHERE t.id = ? AND rr.id = ?`,
    [technicianId, id],
    (checkErr, checkResults) => {
      if (checkErr) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + checkErr.message });
      if (checkResults.length === 0) {
        return res.json({ success: false, message: 'ไม่พบช่างหรือคำขอซ่อมนี้' });
      }
      const { tech_garage_id, request_garage_id } = checkResults[0];
      if (String(tech_garage_id) !== String(request_garage_id)) {
        return res.json({ success: false, message: 'ช่างที่เลือกไม่ได้อยู่ในสังกัดอู่นี้' });
      }
      assignTechnicianToRequest();
    }
  );

  function assignTechnicianToRequest() {
  db.query(
    `UPDATE repair_requests
     SET assigned_technician_id = ?, status = 'assigned', technician_seen = 0,
         assignment_date = ?, assignment_note = ?
     WHERE id = ?`,
    [technicianId, assignmentDate || null, assignmentNote || null, id],
    (err) => {
      if (err) return res.json({ success: false, message: 'มอบหมายงานไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'มอบหมายงานสำเร็จ' });

      // ✅ แจ้งเตือนช่างว่าได้รับมอบหมายงานใหม่
      db.query(
        `SELECT t.user_id, rr.problem_category
         FROM technicians t, repair_requests rr
         WHERE t.id = ? AND rr.id = ?`,
        [technicianId, id],
        (err2, results) => {
          if (err2 || results.length === 0) return;
          const { user_id, problem_category } = results[0];
          sendPushNotification(
            user_id,
            'technician',
            'ได้รับมอบหมายงานใหม่ 🔧',
            `${problem_category || 'งานซ่อม'}`,
            { type: 'new_assignment', requestId: id }
          );
        }
      );
    }
  );
  }
});

// ===== ช่างอัปเดตสถานะงาน (เริ่มซ่อม / ซ่อมเสร็จ) =====
app.put('/api/repair-requests/:id/technician-status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'checking' | 'in_progress' | 'waiting_parts' | 'completed'
  if (!['checking', 'in_progress', 'waiting_parts', 'completed'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }

  // ✅ พอช่างกดว่า "เสร็จสิ้น" ให้บันทึกเวลาที่ซ่อมเสร็จจริงลง DB ไปด้วย (completed_at)
  // เพื่อให้มีผลการซ่อมเสร็จที่บันทึกไว้จริง ไม่ใช่แค่เปลี่ยนคอลัมน์ status เฉยๆ
  const sql = status === 'completed'
    ? 'UPDATE repair_requests SET status = ?, completed_at = NOW() WHERE id = ?'
    : 'UPDATE repair_requests SET status = ? WHERE id = ?';

  db.query(sql, [status, id], (err) => {
    if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
    res.json({ success: true, message: 'อัปเดตสถานะสำเร็จ' });

    db.query(
      `SELECT rr.customer_id, rr.garage_id, g.shop_name
       FROM repair_requests rr
       JOIN garages g ON g.user_id = rr.garage_id
       WHERE rr.id = ?`,
      [id],
      (err2, results) => {
        if (err2 || results.length === 0) return;
        const { customer_id, garage_id, shop_name } = results[0];

        // ✅ แจ้งเตือนทั้งลูกค้าและอู่ทุกครั้งที่สถานะเปลี่ยน (ตามที่ขอ "อู่สามารถดูสถานะได้ด้วย")
        const statusText = {
          checking: 'กำลังตรวจสอบอาการรถ 🔍',
          in_progress: 'เริ่มซ่อมรถแล้ว 🔧',
          waiting_parts: 'รอรับอะไหล่ ⏳',
          completed: 'ซ่อมเสร็จเรียบร้อย 🎉',
        }[status];

        sendPushNotification(
          customer_id, 'customer', statusText,
          `${shop_name}: อัปเดตสถานะงานซ่อมของคุณ`,
          { type: 'repair_status', requestId: id, status }
        );
        sendPushNotification(
          garage_id, 'repair', statusText,
          `งาน #REQ${id.toString().padStart(6, '0')} อัปเดตสถานะแล้ว`,
          { type: 'repair_status', requestId: id, status }
        );
      }
    );
  });
});

// ===== ช่างบันทึกความคืบหน้างานซ่อม (โน้ต + อะไหล่ที่ใช้ + รูป) =====
app.post('/api/repair-logs', (req, res) => {
  uploadRepairPhotos(req, res, async (err) => {
    if (err) return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + err.message });

    const { repairRequestId, technicianId, note, partsUsed } = req.body;
    if (!repairRequestId || !technicianId) {
      return res.json({ success: false, message: 'ข้อมูลไม่ครบ' });
    }

    let photoFilenames = [];
    try {
      photoFilenames = await Promise.all((req.files || []).map((f) => uploadToSupabase(f, 'photo')));
    } catch (uploadErr) {
      return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });
    }

    db.query(
      `INSERT INTO repair_logs (repair_request_id, technician_id, note, parts_used, photos)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [repairRequestId, technicianId, note || '', partsUsed || '', JSON.stringify(photoFilenames)],
      (err2) => {
        if (err2) return res.json({ success: false, message: 'บันทึกไม่สำเร็จ: ' + err2.message });
        res.json({ success: true, message: 'บันทึกความคืบหน้าสำเร็จ' });
      }
    );
  });
});

// ===== ดูไทม์ไลน์ความคืบหน้าของงานซ่อม (ทุกฝ่ายดูได้ ลูกค้า/อู่/ช่าง) =====
app.get('/api/repair-logs', (req, res) => {
  const { repairRequestId } = req.query;
  if (!repairRequestId) return res.json({ success: false, message: 'ไม่พบ repairRequestId' });

  db.query(
    `SELECT rl.id, rl.note, rl.parts_used, rl.photos, rl.created_at, t.name AS technician_name
     FROM repair_logs rl
     JOIN technicians t ON t.id = rl.technician_id
     WHERE rl.repair_request_id = ?
     ORDER BY rl.created_at ASC`,
    [repairRequestId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const logs = results.map((l) => {
        let photos = [];
        try {
          photos = l.photos ? JSON.parse(l.photos) : [];
        } catch (e) {
          photos = [];
        }
        return { ...l, photos: photos.map((p) => toImageUrl(p)) };
      });
      res.json({ success: true, message: '', data: { logs } });
    }
  );
});

// ===== ลูกค้าให้คะแนน/รีวิวอู่ซ่อม (ทำได้เมื่องานนั้นสถานะ "completed" แล้วเท่านั้น) =====
// ✅ multipart เพราะรองรับแนบรูปภาพประกอบรีวิวได้ (เหมือน repair-logs)
app.post('/api/reviews', (req, res) => {
  uploadRepairPhotos(req, res, async (uploadErr) => {
    if (uploadErr) return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });

    const { repairRequestId, customerId, rating, qualityRating, priceRating, serviceRating, comment } = req.body;
    const ratingNum = Number(rating);

    if (!repairRequestId || !customerId) {
      return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.json({ success: false, message: 'กรุณาให้คะแนน 1-5 ดาว' });
    }

    // ✅ คะแนนย่อยแต่ละด้าน (คุณภาพงานซ่อม/ราคาเหมาะสม/บริการและพนักงาน) เป็นตัวเลือกเสริม
    // ถ้าลูกค้าไม่ได้กด จะเก็บเป็น NULL ไว้ ไม่บังคับให้ต้องให้ครบทุกด้าน
    const parseSubRating = (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
    };
    const qualityNum = parseSubRating(qualityRating);
    const priceNum = parseSubRating(priceRating);
    const serviceNum = parseSubRating(serviceRating);
    let photoFilenames = [];
    try {
      photoFilenames = await Promise.all((req.files || []).map((f) => uploadToSupabase(f, 'photo')));
    } catch (uploadFileErr) {
      return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadFileErr.message });
    }

    // ✅ ตรวจว่าคำขอซ่อมนี้เป็นของลูกค้าคนนี้จริง และซ่อมเสร็จแล้วเท่านั้นถึงจะรีวิวได้
    db.query(
      'SELECT customer_id, garage_id, status FROM repair_requests WHERE id = ?',
      [repairRequestId],
      (err, rows) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
        if (rows.length === 0) return res.json({ success: false, message: 'ไม่พบคำขอซ่อมนี้' });

        const request = rows[0];
        if (String(request.customer_id) !== String(customerId)) {
          return res.json({ success: false, message: 'ไม่มีสิทธิ์รีวิวคำขอซ่อมนี้' });
        }
        if (request.status !== 'completed') {
          return res.json({ success: false, message: 'รีวิวได้เมื่องานซ่อมเสร็จเรียบร้อยแล้วเท่านั้น' });
        }

        // ✅ ต้องชำระเงินและอู่ยืนยันแล้วเท่านั้นถึงจะรีวิวได้ (จ่ายเงินก่อนค่อยรีวิว)
        db.query(
          `SELECT status FROM payments WHERE repair_request_id = ?`,
          [repairRequestId],
          (payErr, payRows) => {
            if (payErr) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + payErr.message });
            if (payRows.length === 0 || payRows[0].status !== 'confirmed') {
              return res.json({ success: false, message: 'กรุณาชำระเงินให้เรียบร้อยก่อนจึงจะรีวิวได้' });
            }
            insertReview();
          }
        );

        function insertReview() {
        db.query(
          `INSERT INTO reviews
             (repair_request_id, customer_id, garage_id, rating, quality_rating, price_rating, service_rating, comment, photos)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          [
            repairRequestId, customerId, request.garage_id, ratingNum,
            qualityNum, priceNum, serviceNum, comment || null, JSON.stringify(photoFilenames),
          ],
          (err2) => {
            if (err2) {
              // ✅ มี UNIQUE KEY กันรีวิวซ้ำที่ repair_request_id ไว้ที่ฝั่ง DB
              // '23505' = Postgres unique_violation (เทียบเท่า ER_DUP_ENTRY ของ MySQL)
              if (err2.code === '23505') {
                return res.json({ success: false, message: 'คุณรีวิวงานซ่อมนี้ไปแล้ว' });
              }
              return res.json({ success: false, message: 'ส่งรีวิวไม่สำเร็จ: ' + err2.message });
            }
            res.json({ success: true, message: 'ขอบคุณสำหรับรีวิว!' });

            // ✅ แจ้งเตือนอู่ว่ามีรีวิวใหม่เข้ามา
            sendPushNotification(
              request.garage_id,
              'repair',
              'มีรีวิวใหม่จากลูกค้า ⭐',
              ratingNum >= 4 ? 'ลูกค้าให้คะแนนดีมาก ขอบคุณครับ!' : 'ลูกค้าได้ให้คะแนนงานซ่อมล่าสุดแล้ว',
              { type: 'new_review', requestId: repairRequestId }
            );
          }
        );
        }
      }
    );
  });
});

// ===== ✅ ใหม่ — แก้ไขรีวิวที่ส่งไปแล้ว (เฉพาะเจ้าของรีวิวเท่านั้นที่แก้ไขได้ ยืนยันสิทธิ์ด้วย customerId) =====
// เดิมส่งรีวิวแล้วแก้ไขไม่ได้เลย ลูกค้าขอให้แก้ไขได้ — รองรับแก้คะแนน/ความเห็น/รูปภาพ
// รูปเดิมที่อยากเก็บไว้ส่งมาทาง keepPhotos (JSON array ของ URL เต็มหรือชื่อไฟล์ก็ได้ ตัดเอาแค่ชื่อไฟล์)
// รูปใหม่แนบมาทาง multipart field "photos" ตามปกติ รวมกับรูปเดิมที่เก็บไว้แล้วตัดไม่เกิน 5 รูป
app.put('/api/reviews/:id', (req, res) => {
  uploadRepairPhotos(req, res, async (uploadErr) => {
    if (uploadErr) return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });

    const { id } = req.params;
    const { customerId, rating, qualityRating, priceRating, serviceRating, comment, keepPhotos } = req.body;
    const ratingNum = Number(rating);

    if (!customerId) return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return res.json({ success: false, message: 'กรุณาให้คะแนน 1-5 ดาว' });
    }

    const parseSubRating = (value) => {
      const n = Number(value);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
    };
    const qualityNum = parseSubRating(qualityRating);
    const priceNum = parseSubRating(priceRating);
    const serviceNum = parseSubRating(serviceRating);

    let newPhotoFilenames = [];
    try {
      newPhotoFilenames = await Promise.all((req.files || []).map((f) => uploadToSupabase(f, 'photo')));
    } catch (uploadFileErr) {
      return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadFileErr.message });
    }

    // ✅ ตรวจสิทธิ์ก่อน — ต้องเป็นรีวิวของ customerId คนนี้เท่านั้นถึงจะแก้ไขได้
    db.query('SELECT customer_id FROM reviews WHERE id = ?', [id], (err, rows) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (rows.length === 0) return res.json({ success: false, message: 'ไม่พบรีวิวนี้' });
      if (String(rows[0].customer_id) !== String(customerId)) {
        return res.json({ success: false, message: 'ไม่มีสิทธิ์แก้ไขรีวิวนี้' });
      }

      // ✅ รูปเดิมที่ลูกค้าเลือกเก็บไว้ (ส่งมาเป็น URL เต็มหรือชื่อไฟล์ก็ได้ ตัดเอาแค่ชื่อไฟล์ท้ายสุด)
      let keepList = [];
      try {
        keepList = keepPhotos ? JSON.parse(keepPhotos) : [];
      } catch (e) {
        keepList = [];
      }
      const keepFilenames = keepList
        .map((v) => (typeof v === 'string' && v.includes('/') ? v.split('/').pop() : v))
        .filter(Boolean);
      const finalPhotos = [...keepFilenames, ...newPhotoFilenames].slice(0, 5);

      db.query(
        `UPDATE reviews
         SET rating = ?, quality_rating = ?, price_rating = ?, service_rating = ?, comment = ?, photos = ?
         WHERE id = ?`,
        [ratingNum, qualityNum, priceNum, serviceNum, comment || null, JSON.stringify(finalPhotos), id],
        (err2) => {
          if (err2) return res.json({ success: false, message: 'แก้ไขรีวิวไม่สำเร็จ: ' + err2.message });
          res.json({ success: true, message: 'แก้ไขรีวิวเรียบร้อยแล้ว' });
        }
      );
    });
  });
});

// ===== ดูรีวิว — ระบุ garageId (ดูรีวิวทั้งหมดของอู่ + คะแนนเฉลี่ย) หรือ repairRequestId (เช็กว่างานนี้รีวิวหรือยัง) =====
app.get('/api/reviews', (req, res) => {
  const { garageId, repairRequestId } = req.query;

  if (repairRequestId) {
    db.query(
      `SELECT id, rating, quality_rating, price_rating, service_rating, comment, photos,
              reply, replied_at, created_at
       FROM reviews WHERE repair_request_id = ?`,
      [repairRequestId],
      (err, results) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
        const review = results[0]
          ? { ...results[0], photos: toPhotoUrls(results[0].photos) }
          : null;
        res.json({ success: true, message: '', data: { review } });
      }
    );
    return;
  }

  if (garageId) {
    db.query(
      `SELECT rv.id, rv.rating, rv.quality_rating, rv.price_rating, rv.service_rating,
              rv.comment, rv.photos, rv.reply, rv.replied_at, rv.created_at,
              c.first_name, c.last_name, c.avatar AS customer_avatar
       FROM reviews rv
       JOIN customers c ON c.user_id = rv.customer_id
       WHERE rv.garage_id = ?
       ORDER BY rv.created_at DESC`,
      [garageId],
      (err, results) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
        const reviews = results.map((r) => ({
          ...r,
          photos: toPhotoUrls(r.photos),
          customer_avatar: r.customer_avatar ? toImageUrl(r.customer_avatar) : undefined,
        }));
        const avgRating = reviews.length
          ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
          : 0;
        // ✅ แจกแจงจำนวนรีวิวแยกตามดาว 1-5 ดาว ไว้ทำกราฟแท่งสรุปด้านบนหน้ารีวิว
        const ratingCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        reviews.forEach((r) => {
          if (ratingCounts[r.rating] !== undefined) ratingCounts[r.rating]++;
        });
        res.json({
          success: true,
          message: '',
          data: {
            reviews,
            averageRating: Math.round(avgRating * 10) / 10,
            totalReviews: reviews.length,
            ratingCounts,
          },
        });
      }
    );
    return;
  }

  res.json({ success: false, message: 'ไม่พบ garageId หรือ repairRequestId' });
});

// ===== อู่ตอบกลับรีวิวของลูกค้า (ตอบได้ครั้งเดียว แต่แก้ไขคำตอบเดิมซ้ำได้) =====
app.put('/api/reviews/:id/reply', (req, res) => {
  const { id } = req.params;
  const { garageId, reply } = req.body;

  if (!garageId || !reply || !reply.toString().trim()) {
    return res.json({ success: false, message: 'กรุณากรอกข้อความตอบกลับ' });
  }

  // ✅ ต้องเป็นรีวิวของอู่ตัวเองเท่านั้นถึงจะตอบกลับได้
  db.query(
    'UPDATE reviews SET reply = ?, replied_at = NOW() WHERE id = ? AND garage_id = ?',
    [reply.toString().trim(), id, garageId],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบรีวิวนี้ หรือไม่มีสิทธิ์ตอบกลับ' });
      }
      res.json({ success: true, message: 'ตอบกลับรีวิวสำเร็จ' });
    }
  );
});

// ============================================================
// 💳 ระบบชำระเงิน — ลูกค้าจ่ายหลังงานซ่อมเสร็จ (status = 'completed') เท่านั้น
//     แล้วอู่เป็นคนกดยืนยัน/ปฏิเสธจากสลิปที่แนบมา รีวิวจะกดได้ก็ต่อเมื่อจ่ายเงิน
//     และอู่ยืนยันแล้วเท่านั้น (เช็กในจุดที่ POST /api/reviews)
// ============================================================

// ✅ ลูกค้าแจ้งชำระเงิน (แนบสลิป) — ถ้าเคยถูกปฏิเสธมาก่อน จะอัปเดตแถวเดิมแทนการสร้างใหม่
app.post('/api/payments', (req, res) => {
  uploadSlip(req, res, async (uploadErr) => {
    if (uploadErr) return res.json({ success: false, message: 'อัปโหลดสลิปไม่สำเร็จ: ' + uploadErr.message });

    const { repairRequestId, customerId, garageId, amount, method } = req.body;
    const amountNum = Number(amount);

    if (!repairRequestId || !customerId || !garageId || !method) {
      return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return res.json({ success: false, message: 'จำนวนเงินไม่ถูกต้อง' });
    }
    if (!req.file) {
      return res.json({ success: false, message: 'กรุณาแนบสลิปการโอนเงิน' });
    }

    let slipFilename;
    try {
      slipFilename = await uploadToSupabase(req.file, 'slip'); // ✅ เก็บที่ Supabase Storage แทนดิสก์ของ Render
    } catch (uploadFileErr) {
      return res.json({ success: false, message: 'อัปโหลดสลิปไม่สำเร็จ: ' + uploadFileErr.message });
    }

    // ✅ ต้องเป็นคำขอซ่อมของลูกค้าคนนี้จริง และซ่อมเสร็จแล้วเท่านั้นถึงจะจ่ายได้
    db.query('SELECT customer_id, status FROM repair_requests WHERE id = ?', [repairRequestId], (err, rows) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (rows.length === 0) return res.json({ success: false, message: 'ไม่พบคำขอซ่อมนี้' });

      const request = rows[0];
      if (String(request.customer_id) !== String(customerId)) {
        return res.json({ success: false, message: 'ไม่มีสิทธิ์ชำระเงินคำขอนี้' });
      }
      if (request.status !== 'completed') {
        return res.json({ success: false, message: 'ชำระเงินได้เมื่องานซ่อมเสร็จเรียบร้อยแล้วเท่านั้น' });
      }

      db.query('SELECT id, status FROM payments WHERE repair_request_id = ?', [repairRequestId], (err2, existing) => {
        if (err2) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err2.message });

        if (existing.length > 0 && existing[0].status !== 'rejected') {
          return res.json({ success: false, message: 'มีการแจ้งชำระเงินสำหรับงานนี้อยู่แล้ว' });
        }

        const finish = () => {
          res.json({ success: true, message: 'แจ้งชำระเงินสำเร็จ รอการยืนยันจากอู่' });
          sendPushNotification(
            garageId,
            'repair',
            'มีการแจ้งชำระเงินใหม่ 💳',
            `ยอด ฿${amountNum.toLocaleString()} รอการตรวจสอบสลิป`,
            { type: 'new_payment', requestId: repairRequestId }
          );
        };

        if (existing.length > 0) {
          // ✅ เคยถูกปฏิเสธมาก่อน — แนบสลิปใหม่ทับแถวเดิม รีเซ็ตเป็นรอตรวจสอบอีกครั้ง
          db.query(
            `UPDATE payments SET amount = ?, method = ?, slip_photo = ?, status = 'pending_confirmation',
               rejection_reason = NULL, submitted_at = NOW(), confirmed_at = NULL WHERE id = ?`,
            [amountNum, method, slipFilename, existing[0].id],
            (err3) => {
              if (err3) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err3.message });
              finish();
            }
          );
        } else {
          db.query(
            `INSERT INTO payments (repair_request_id, customer_id, garage_id, amount, method, slip_photo)
             VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
            [repairRequestId, customerId, garageId, amountNum, method, slipFilename],
            (err3) => {
              if (err3) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err3.message });
              finish();
            }
          );
        }
      });
    });
  });
});

// ✅ ดูข้อมูลการชำระเงิน — ระบุ repairRequestId (เช็กสถานะงานนี้) หรือ customerId/garageId (ดูประวัติ)
app.get('/api/payments', (req, res) => {
  const { repairRequestId, customerId, garageId } = req.query;

  if (repairRequestId) {
    db.query('SELECT * FROM payments WHERE repair_request_id = ?', [repairRequestId], (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const payment = results[0] ? { ...results[0], slip_photo: toImageUrl(results[0].slip_photo) } : null;
      res.json({ success: true, message: '', data: { payment } });
    });
    return;
  }

  if (customerId || garageId) {
    const whereCol = customerId ? 'p.customer_id' : 'p.garage_id';
    const whereVal = customerId || garageId;
    // ✅ ฝั่งอู่ (garageId) ให้ JOIN commission_transactions มาด้วย จะได้เห็นว่าแต่ละ
    // รายการโดนหักค่าคอมมิชชั่นไปเท่าไหร่ + ยอดสุทธิที่ได้รับจริงหลังหัก (ฝั่งลูกค้า
    // ไม่ต้องเห็นส่วนนี้ เพราะไม่เกี่ยวกับลูกค้าเลย จ่ายเท่าเดิมทุกอย่าง)
    const commissionSelect = garageId
      ? ', ct.commission_amount, ct.wallet_balance_after'
      : '';
    const commissionJoin = garageId
      ? 'LEFT JOIN commission_transactions ct ON ct.payment_id = p.id'
      : '';
    db.query(
      `SELECT p.*, rr.problem_category, rr.vehicle_type,
              g.shop_name, c.first_name, c.last_name${commissionSelect}
       FROM payments p
       JOIN repair_requests rr ON rr.id = p.repair_request_id
       JOIN garages g ON g.user_id = p.garage_id
       JOIN customers c ON c.user_id = p.customer_id
       ${commissionJoin}
       WHERE ${whereCol} = ?
       ORDER BY p.submitted_at DESC`,
      [whereVal],
      (err, results) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
        const payments = results.map((p) => ({ ...p, slip_photo: toImageUrl(p.slip_photo) }));
        const totalConfirmed = payments
          .filter((p) => p.status === 'confirmed')
          .reduce((sum, p) => sum + Number(p.amount), 0);
        res.json({ success: true, message: '', data: { payments, totalConfirmed } });
      }
    );
    return;
  }

  res.json({ success: false, message: 'ไม่พบ repairRequestId, customerId หรือ garageId' });
});

// ✅ อู่ยืนยันว่าได้รับเงินแล้ว
app.put('/api/payments/:id/confirm', async (req, res) => {
  const { id } = req.params;
  const { garageId } = req.body;

  db.query(
    `UPDATE payments SET status = 'confirmed', confirmed_at = NOW()
     WHERE id = ? AND garage_id = ? AND status = 'pending_confirmation'`,
    [id, garageId],
    async (err, result) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบรายการนี้ หรือยืนยันไปแล้ว' });
      }

      // ✅ หักค่าคอมมิชชั่นแบบ Grab-style ทันทีจาก wallet ของอู่ (แทนที่ระบบสมุดบัญชี
      // เดิม platform_commissions ที่แค่ "จด" ยอดค้างไว้เฉยๆ) — ดึงยอดเงิน+repair_request_id
      // มาจาก payments ก่อน เพราะ deductCommission ต้องใช้ครบทั้ง 4 ค่า
      let commissionResult = null;
      try {
        const [[payment]] = await dbPool.query(
          'SELECT amount, garage_id, repair_request_id FROM payments WHERE id = ?',
          [id]
        );
        if (payment) {
          commissionResult = await deductCommission(dbPool, {
            garageId: payment.garage_id,
            repairRequestId: payment.repair_request_id,
            paymentId: Number(id),
            grossAmount: Number(payment.amount),
          });
        }
      } catch (commissionErr) {
        // ⚠️ ไม่ทำให้การยืนยันรับเงินล้มเหลวไปด้วย ถ้าหักคอมมิชชั่นพลาด — เงินลูกค้า
        // จ่ายอู่ไปแล้วจริง ต้องให้ธุรกรรมหลักผ่านก่อน ค่อยไปตามแก้ยอด wallet ทีหลัง
        console.error('⚠️ หักค่าคอมมิชชั่นไม่สำเร็จ:', commissionErr.message);
      }

      res.json({
        success: true,
        message: 'ยืนยันการชำระเงินสำเร็จ',
        data: commissionResult
          ? { commissionAmount: commissionResult.commissionAmount, walletBalanceAfter: commissionResult.walletBalanceAfter }
          : undefined,
      });

      db.query('SELECT customer_id FROM payments WHERE id = ?', [id], (err2, rows) => {
        if (!err2 && rows.length > 0) {
          sendPushNotification(
            rows[0].customer_id,
            'customer',
            'อู่ยืนยันการชำระเงินแล้ว ✅',
            'ตอนนี้คุณสามารถให้คะแนนอู่ได้แล้ว',
            { type: 'payment_confirmed' }
          );
        }
      });
    }
  );
});

// ✅ อู่ปฏิเสธสลิป (สลิปไม่ชัด/ยอดไม่ตรง ฯลฯ) — ลูกค้าจะแนบสลิปใหม่ได้อีกครั้ง
app.put('/api/payments/:id/reject', (req, res) => {
  const { id } = req.params;
  const { garageId, reason } = req.body;

  if (!reason || !reason.toString().trim()) {
    return res.json({ success: false, message: 'กรุณาระบุเหตุผลที่ปฏิเสธ' });
  }

  db.query(
    `UPDATE payments SET status = 'rejected', rejection_reason = ?
     WHERE id = ? AND garage_id = ? AND status = 'pending_confirmation'`,
    [reason.toString().trim(), id, garageId],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบรายการนี้ หรือดำเนินการไปแล้ว' });
      }
      res.json({ success: true, message: 'ปฏิเสธการชำระเงินสำเร็จ' });

      db.query('SELECT customer_id FROM payments WHERE id = ?', [id], (err2, rows) => {
        if (!err2 && rows.length > 0) {
          sendPushNotification(
            rows[0].customer_id,
            'customer',
            'สลิปการชำระเงินมีปัญหา',
            reason.toString().trim(),
            { type: 'payment_rejected' }
          );
        }
      });
    }
  );
});

// ✅ อู่ตั้งค่าบัญชีธนาคารสำหรับรับชำระเงิน
app.put('/api/garages/:id/bank-details', (req, res) => {
  const { id } = req.params;
  const { bankName, bankAccountNumber, bankAccountName, promptpayId } = req.body;

  // 🐛 บั๊กเดิม: WHERE id = ? แต่ทุก JOIN อื่นในระบบ (repair-requests, payments, ฯลฯ)
  // ใช้ garages.user_id ในการเชื่อมกับ garage_id ที่ Flutter ส่งมา (ซึ่งคือ userData['id']
  // ของอู่ = user_id ไม่ใช่ garages.id ที่เป็น primary key ของตารางเอง) ทำให้ตอนกด
  // บันทึกบัญชีธนาคาร มันไป UPDATE ผิดแถว (หรือไม่มีแถวไหนตรงเลย ถ้า id กับ user_id
  // ไม่ตรงกันบังเอิญ) ข้อมูลเลยไม่เคยถูกบันทึกลงแถวที่ repair-requests ไป JOIN เจอจริง
  // ทำให้ลูกค้าเห็น "อู่ยังไม่ได้ตั้งค่าบัญชีธนาคาร" ตลอด ทั้งที่อู่กรอกไปแล้ว
  db.query(
    'UPDATE garages SET bank_name = ?, bank_account_number = ?, bank_account_name = ?, promptpay_id = ? WHERE user_id = ?',
    [bankName || null, bankAccountNumber || null, bankAccountName || null, promptpayId || null, id],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบบัญชีอู่นี้ในระบบ (user_id ไม่ตรงกับข้อมูลที่มี)' });
      }
      res.json({ success: true, message: 'บันทึกข้อมูลบัญชีสำเร็จ' });
    }
  );
});

// ===== นับจำนวนคำขอที่อู่ตอบกลับแล้ว แต่ลูกค้ายังไม่ได้เปิดดู (โชว์เป็นตัวเลขที่กระดิ่ง) =====
app.get('/api/repair-requests/unseen-count', (req, res) => {
  const { customerId } = req.query;
  if (!customerId) return res.json({ success: false, message: 'ไม่พบ customerId' });

  db.query(
    `SELECT COUNT(*) AS count FROM repair_requests
     WHERE customer_id = ? AND status != 'pending' AND customer_seen = 0`,
    [customerId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: '', data: { count: results[0].count } });
    }
  );
});

// ===== มาร์คว่าลูกค้าเปิดดูคำขอทั้งหมดแล้ว (เรียกตอนกดเข้าไปที่กระดิ่ง/หน้าประวัติ) =====
// ⚠️ ยกเว้นงานที่สถานะ 'quoted' (อู่เพิ่งส่งใบเสนอราคามาใหม่ ลูกค้ายังไม่ได้ตัดสินใจ)
// จะไม่มาร์คว่าอ่านแล้วแค่เพราะเปิดดู — ต้องรอให้ลูกค้ากดยืนยัน/ปฏิเสธใบเสนอราคาจริงๆ
// ก่อน (ผ่าน PUT /api/quotations/:id/respond ซึ่งเปลี่ยน status ออกจาก 'quoted' ไปเอง)
// ตัวเลขแจ้งเตือนถึงจะหายไป กันลูกค้าลืมตอบใบเสนอราคา
app.post('/api/repair-requests/mark-seen', (req, res) => {
  const { customerId } = req.body;
  if (!customerId) return res.json({ success: false, message: 'ไม่พบ customerId' });

  db.query(
    `UPDATE repair_requests SET customer_seen = 1
     WHERE customer_id = ? AND customer_seen = 0 AND status != 'quoted'`,
    [customerId],
    (err) => {
      if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'มาร์คว่าอ่านแล้วสำเร็จ' });
    }
  );
});

// ===== CREATE QUOTATION (อู่สร้างใบเสนอราคาให้คำขอซ่อมที่รับไว้แล้ว) =====
app.post('/api/quotations', (req, res) => {
  const {
    repairRequestId, items, laborCost, totalPrice: totalPriceFromClient, estimatedStartDate, estimatedEndDate, notes,
  } = req.body;

  if (!repairRequestId || laborCost === undefined) {
    return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  const itemList = Array.isArray(items) ? items : [];
  const partsCost = itemList.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
    0
  );
  // ✅ ใช้ totalPrice ที่ Flutter ส่งมา (รวม VAT 7% คำนวณจากฝั่งอู่แล้ว) ถ้ามีมา
  // เดิมคำนวณเองแค่ partsCost + laborCost โดยไม่เคยบวก VAT เลย ทำให้ยอดที่เก็บใน DB
  // (และยอดที่ใช้เรียกเก็บเงินจริงตอนจ่าย) ไม่ตรงกับที่ลูกค้าเห็นในหน้าใบเสนอราคา
  const totalPrice = totalPriceFromClient !== undefined && totalPriceFromClient !== null
    ? Number(totalPriceFromClient)
    : partsCost + Number(laborCost);

  db.query(
    `INSERT INTO quotations
      (repair_request_id, items, labor_cost, parts_cost, total_price, estimated_start_date, estimated_end_date, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      repairRequestId,
      JSON.stringify(itemList),
      laborCost,
      partsCost,
      totalPrice,
      estimatedStartDate || null,
      estimatedEndDate || null,
      notes || '',
    ],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'สร้างใบเสนอราคาไม่สำเร็จ: ' + err.message });

      // ✅ อัปเดตสถานะคำขอซ่อมเป็น "quoted" (ส่งใบเสนอราคาแล้ว รอลูกค้ายืนยัน)
      db.query('UPDATE repair_requests SET status = ? WHERE id = ?', ['quoted', repairRequestId]);

      res.json({ success: true, message: 'สร้างใบเสนอราคาสำเร็จ', data: { id: result.insertId } });

      // ✅ แจ้งเตือนลูกค้าว่ามีใบเสนอราคาใหม่ (Socket.IO ต้องการแค่ customer_id ไม่ต้องดึง token)
      db.query(
        `SELECT rr.customer_id, g.shop_name
         FROM repair_requests rr
         JOIN garages g ON g.user_id = rr.garage_id
         WHERE rr.id = ?`,
        [repairRequestId],
        (err2, results) => {
          if (err2 || results.length === 0) return;
          const { customer_id, shop_name } = results[0];
          sendPushNotification(
            customer_id,
            'customer',
            'มีใบเสนอราคาใหม่ 📋',
            `${shop_name} ส่งใบเสนอราคา รวม ${totalPrice.toLocaleString()} บาท`,
            { type: 'quotation', requestId: repairRequestId }
          );
        }
      );
    }
  );
});

// ===== UPDATE QUOTATION (อู่แก้ไขใบเสนอราคาที่ส่งไปแล้ว) =====
// ⚠️ เพิ่ม route นี้เข้ามาใหม่ — ฝั่ง Flutter (ApiService.updateQuotation) เรียก
// endpoint นี้ไว้ตั้งแต่ก่อนหน้านี้แล้ว แต่ backend ยังไม่เคยมี route รองรับเลย
app.put('/api/quotations/:id', (req, res) => {
  const { id } = req.params;
  const { items, laborCost, totalPrice: totalPriceFromClient, estimatedStartDate, estimatedEndDate, notes } = req.body;

  if (laborCost === undefined) {
    return res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบ' });
  }

  const itemList = Array.isArray(items) ? items : [];
  const partsCost = itemList.reduce(
    (sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 1),
    0
  );
  const totalPrice = totalPriceFromClient !== undefined && totalPriceFromClient !== null
    ? Number(totalPriceFromClient)
    : partsCost + Number(laborCost);

  db.query(
    `UPDATE quotations
     SET items = ?, labor_cost = ?, parts_cost = ?, total_price = ?,
         estimated_start_date = ?, estimated_end_date = ?, notes = ?
     WHERE id = ?`,
    [
      JSON.stringify(itemList),
      laborCost,
      partsCost,
      totalPrice,
      estimatedStartDate || null,
      estimatedEndDate || null,
      notes || '',
      id,
    ],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'แก้ไขใบเสนอราคาไม่สำเร็จ: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบใบเสนอราคานี้' });
      }
      res.json({ success: true, message: 'แก้ไขใบเสนอราคาสำเร็จ' });
    }
  );
});

// ===== GET QUOTATION (ดูใบเสนอราคาของคำขอซ่อมหนึ่งรายการ) =====
app.get('/api/quotations', (req, res) => {
  const { repairRequestId } = req.query;
  if (!repairRequestId) return res.json({ success: false, message: 'ไม่พบ repairRequestId' });

  db.query(
    `SELECT * FROM quotations WHERE repair_request_id = ? ORDER BY created_at DESC LIMIT 1`,
    [repairRequestId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (results.length === 0) return res.json({ success: true, message: '', data: { quotation: null } });

      const q = results[0];
      let items = [];
      try {
        items = q.items ? JSON.parse(q.items) : [];
      } catch (e) {
        items = [];
      }
      res.json({ success: true, message: '', data: { quotation: { ...q, items } } });
    }
  );
});

// ===== RESPOND TO QUOTATION (ลูกค้ายืนยัน / ปฏิเสธใบเสนอราคา) =====
app.put('/api/quotations/:id/respond', (req, res) => {
  const { id } = req.params;
  const { status, reason, customerId } = req.body; // 'confirmed' | 'rejected'

  if (!['confirmed', 'rejected'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  // ✅ เดิม endpoint นี้ไม่รับ/ไม่เช็ค customerId เลย — ใครก็ตามที่รู้/เดา id ของ
  // ใบเสนอราคาสามารถยืนยัน/ปฏิเสธแทนลูกค้าเจ้าของได้ทันที เพิ่มเช็คว่า customerId
  // ที่ส่งมาต้องตรงกับเจ้าของคำขอซ่อมที่ผูกกับใบเสนอราคานี้ก่อนเสมอ
  if (!customerId) {
    return res.json({ success: false, message: 'ไม่พบ customerId' });
  }

  db.query(
    `UPDATE quotations q
     JOIN repair_requests rr ON rr.id = q.repair_request_id
     SET q.status = ?, q.customer_rejection_reason = ?, q.responded_at = NOW()
     WHERE q.id = ? AND rr.customer_id = ?`,
    [status, status === 'rejected' ? (reason || null) : null, id, customerId],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'อัปเดตไม่สำเร็จ: ' + err.message });
      if (result.affectedRows === 0) {
        return res.json({ success: false, message: 'ไม่พบใบเสนอราคานี้ หรือไม่มีสิทธิ์ตอบกลับ' });
      }

      // ✅ ยืนยัน -> คำขอซ่อมเปลี่ยนเป็น confirmed (เริ่มงานได้)
      // ปฏิเสธ -> ย้อนกลับเป็น accepted (อู่ยังรับงานอยู่ แต่ต้องส่งใบเสนอราคาใหม่)
      db.query(
        `UPDATE repair_requests SET status = ?
         WHERE id = (SELECT repair_request_id FROM quotations WHERE id = ?)`,
        [status === 'confirmed' ? 'confirmed' : 'accepted', id],
        () => {
          res.json({ success: true, message: 'บันทึกการตอบกลับสำเร็จ' });

          // ✅ แจ้งเตือนอู่ว่าลูกค้าตอบกลับใบเสนอราคาแล้ว (Socket.IO ต้องการแค่ garage_id)
          db.query(
            `SELECT rr.garage_id, rr.id AS request_id
             FROM quotations q
             JOIN repair_requests rr ON rr.id = q.repair_request_id
             WHERE q.id = ?`,
            [id],
            (err2, results) => {
              if (err2 || results.length === 0) return;
              const { garage_id, request_id } = results[0];
              sendPushNotification(
                garage_id,
                'repair',
                status === 'confirmed' ? 'ลูกค้ายืนยันใบเสนอราคาแล้ว ✅' : 'ลูกค้าปฏิเสธใบเสนอราคา',
                status === 'confirmed'
                  ? 'เริ่มดำเนินการซ่อมได้เลย'
                  : reason
                  ? `เหตุผล: ${reason}`
                  : 'กรุณาติดต่อลูกค้าเพื่อปรับใบเสนอราคา',
                { type: 'quotation_response', requestId: request_id }
              );
            }
          );
        }
      );
    }
  );
});


// ✅ หาบทสนทนาเดิม หรือสร้างใหม่ถ้ายังไม่เคยคุยกัน (เรียกตอนกด "แชท" ครั้งแรกกับอู่นั้น)
app.post('/api/conversations', (req, res) => {
  const { customerId, garageId } = req.body;
  if (!customerId || !garageId) {
    return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
  }

  db.query(
    'SELECT id FROM conversations WHERE customer_id = ? AND garage_id = ?',
    [customerId, garageId],
    (err, rows) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (rows.length > 0) {
        return res.json({ success: true, message: '', data: { conversationId: rows[0].id } });
      }
      db.query(
        'INSERT INTO conversations (customer_id, garage_id) VALUES (?, ?) RETURNING id',
        [customerId, garageId],
        (err2, result) => {
          if (err2) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err2.message });
          res.json({ success: true, message: '', data: { conversationId: result.insertId } });
        }
      );
    }
  );
});

// ✅ ลิสต์บทสนทนาทั้งหมด — ระบุ customerId (ฝั่งลูกค้า) หรือ garageId (ฝั่งอู่)
// พร้อมข้อความล่าสุด + จำนวนที่ยังไม่ได้อ่าน สำหรับหน้ารายการแชท
app.get('/api/conversations', (req, res) => {
  const { customerId, garageId } = req.query;
  if (!customerId && !garageId) {
    return res.json({ success: false, message: 'ไม่พบ customerId หรือ garageId' });
  }

  const whereCol = customerId ? 'c.customer_id' : 'c.garage_id';
  const whereVal = customerId || garageId;
  const myType = customerId ? 'customer' : 'repair';

  db.query(
    `SELECT * FROM (
       SELECT c.id, c.customer_id, c.garage_id, c.created_at,
              g.shop_name, g.avatar AS garage_avatar,
              cu.first_name, cu.last_name, cu.avatar AS customer_avatar,
              (SELECT message FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
              (SELECT image FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_image,
              (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_type != ? AND m.is_read = 0) AS unread_count
        FROM conversations c
        JOIN garages g ON g.user_id = c.garage_id
        JOIN customers cu ON cu.user_id = c.customer_id
        WHERE ${whereCol} = ?
     ) sub
     ORDER BY last_message_at IS NULL, last_message_at DESC`,
    [myType, whereVal],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const conversations = results.map((c) => ({
        ...c,
        garage_avatar: c.garage_avatar ? toImageUrl(c.garage_avatar) : undefined,
        customer_avatar: c.customer_avatar ? toImageUrl(c.customer_avatar) : undefined,
        last_image: c.last_image ? toImageUrl(c.last_image) : undefined,
      }));
      res.json({ success: true, message: '', data: { conversations } });
    }
  );
});

// ✅ ดึงประวัติข้อความในบทสนทนา + มาร์คข้อความของอีกฝ่ายว่าอ่านแล้ว (ต้องระบุ viewerType ว่าใครเปิดดู)
app.get('/api/messages', (req, res) => {
  const { conversationId, viewerType } = req.query;
  if (!conversationId) return res.json({ success: false, message: 'ไม่พบ conversationId' });

  db.query(
    'SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC',
    [conversationId],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const messages = results.map((m) => ({ ...m, image: m.image ? toImageUrl(m.image) : undefined }));
      res.json({ success: true, message: '', data: { messages } });

      // ✅ มาร์คว่าอ่านแล้วเฉพาะข้อความที่ "อีกฝ่าย" ส่งมา (ไม่ใช่ข้อความของตัวเอง)
      if (viewerType) {
        db.query(
          'UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_type != ? AND is_read = 0',
          [conversationId, viewerType]
        );
      }
    }
  );
});

// ✅ ส่งข้อความ (แนบรูปได้) — บันทึกลง DB แล้วส่งแบบ real-time ให้อีกฝ่ายทันทีถ้าออนไลน์อยู่
// ✅ กรองข้อมูลติดต่อที่อาจใช้นัดคุย/จ่ายเงินนอกแอป (เบอร์โทร, LINE ID, เลขบัญชี)
// ออกจากข้อความแชท ก่อนงานจะปิด — เป็นกลไกป้องกัน "platform leakage" (อู่แอบลูกค้า
// ให้ติดต่อ/โอนเงินตรงนอกระบบ หนีค่าคอมมิชชั่น) ไม่ใช่แค่พึ่งความซื่อสัตย์ของอู่อย่างเดียว
// ⚠️ เป็นตัวกรองแบบ pattern-matching เบื้องต้น ไม่ใช่ 100% กันเลี่ยงได้ทุกกรณี
// (เช่น พิมพ์เว้นวรรค "08 1 234 5678" อาจหลุดรอด) แต่ช่วยกันเคสตรงไปตรงมาส่วนใหญ่ได้
function containsContactInfo(text) {
  if (!text) return false;
  const patterns = [
    /0[689]\d{1}[-\s]?\d{3}[-\s]?\d{4}/, // เบอร์มือถือไทย เช่น 08x-xxx-xxxx
    /line\s*id|ไลน์\s*id|เพิ่มไลน์|ไอดีไลน์/i, // ชวนแอด LINE
    /เลขบัญชี|โอนตรง|โอนเข้าบัญชี\s*(?!.{0,10}(อู่|ระบบ))/i, // ชวนโอนตรงนอกระบบ
    /\d{3}[-\s]?\d{1}[-\s]?\d{5}[-\s]?\d{1}/, // รูปแบบเลขบัญชีธนาคารไทย (10 หลัก)
  ];
  return patterns.some((p) => p.test(text));
}

app.post('/api/messages', (req, res) => {
  uploadChatImage(req, res, async (uploadErr) => {
    if (uploadErr) return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadErr.message });

    const { conversationId, senderId, senderType, message } = req.body;
    if (!conversationId || !senderId || !senderType) {
      return res.json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
    }
    if ((!message || !message.toString().trim()) && !req.file) {
      return res.json({ success: false, message: 'กรุณาพิมพ์ข้อความหรือแนบรูป' });
    }

    let chatImageFilename = null;
    if (req.file) {
      try {
        chatImageFilename = await uploadToSupabase(req.file, 'chat'); // ✅ เก็บที่ Supabase Storage แทนดิสก์ของ Render
      } catch (uploadFileErr) {
        return res.json({ success: false, message: 'อัปโหลดรูปไม่สำเร็จ: ' + uploadFileErr.message });
      }
    }

    // ✅ บล็อกเฉพาะตอนงานยังไม่ปิด (repair_requests.status ยังไม่ completed) — พองาน
    // เสร็จแล้วปล่อยให้แลกเบอร์กันได้ตามปกติ ไม่งั้นแม้แต่นัดหมายซ่อมครั้งต่อไปก็ทำไม่ได้
    if (message && containsContactInfo(message.toString())) {
      db.query(
        `SELECT rr.status FROM conversations c
         LEFT JOIN repair_requests rr ON rr.customer_id = c.customer_id AND rr.garage_id = c.garage_id
         WHERE c.id = ? ORDER BY rr.created_at DESC LIMIT 1`,
        [conversationId],
        (checkErr, checkRows) => {
          const jobClosed = checkRows && checkRows[0] && checkRows[0].status === 'completed';
          if (jobClosed) {
            proceedSendMessage();
          } else {
            return res.json({
              success: false,
              message: 'ไม่สามารถส่งเบอร์โทร/เลขบัญชี/ไอดีไลน์ในแชทได้ก่อนงานจะเสร็จสิ้น กรุณาสื่อสารผ่านระบบเพื่อความปลอดภัยของทั้งสองฝ่าย',
            });
          }
        }
      );
      return;
    }

    proceedSendMessage();

    function proceedSendMessage() {

    const imageFilename = chatImageFilename;

    db.query(
      'INSERT INTO messages (conversation_id, sender_id, sender_type, message, image) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [conversationId, senderId, senderType, message ? message.toString().trim() : '', imageFilename],
      (err, result) => {
        if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });

        const sentMessage = {
          id: result.insertId,
          conversation_id: Number(conversationId),
          sender_id: Number(senderId),
          sender_type: senderType,
          message: message ? message.toString().trim() : '',
          image: imageFilename ? toImageUrl(imageFilename) : undefined,
          is_read: 0,
          created_at: new Date().toISOString(),
        };
        res.json({ success: true, message: '', data: { message: sentMessage } });

        // ✅ หาว่าอีกฝ่ายในบทสนทนานี้คือใคร แล้วส่ง real-time + push notification ให้
        db.query(
          'SELECT customer_id, garage_id FROM conversations WHERE id = ?',
          [conversationId],
          (err2, rows) => {
            if (err2 || rows.length === 0) return;
            const { customer_id, garage_id } = rows[0];
            const recipientId = senderType === 'customer' ? garage_id : customer_id;
            const recipientType = senderType === 'customer' ? 'repair' : 'customer';

            const socketId = connectedUsers[`${recipientType}_${recipientId}`];
            if (socketId) {
              io.to(socketId).emit('chat_message', sentMessage);
            }

            sendPushNotification(
              recipientId,
              recipientType,
              'ข้อความใหม่',
              sentMessage.message || 'ส่งรูปภาพมาให้คุณ',
              { type: 'chat_message', conversationId: Number(conversationId) }
            );
          }
        );
      }
    );
    } // ปิด function proceedSendMessage
  });
});

// ===== ADMIN PANEL (หน้า HTML แยกจากแอป Flutter — เรียกใช้ API ชุดเดียวกัน) =====
// เปิดที่ http://<ip>:3000/admin/login.html
// ✅ ปิด browser cache สำหรับไฟล์ static ของ admin panel (JS/CSS/HTML) — เดิม browser
// จะแคชไฟล์พวกนี้ไว้เอง พอแก้โค้ด admin แล้ว push/deploy ใหม่ ผู้ใช้จะยังเห็นเวอร์ชันเก่าอยู่
// จนกว่าจะกด hard refresh เอง (สร้างความสับสนว่า deploy ไม่ขึ้นทั้งที่จริงๆ ขึ้นแล้ว)
// no-cache (ไม่ใช่ no-store) ยังให้แคชได้แต่บังคับเช็กกับเซิร์ฟเวอร์ก่อนใช้ทุกครั้ง
app.use('/admin', express.static('admin', {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ============================================================
// ===== ADMIN: จัดการบัญชีผู้ใช้งาน (1.3.4.2) =====
// ============================================================
app.get('/api/admin/users', (req, res) => {
  db.query(
    `SELECT u.id, u.email, u.user_type, u.status, u.created_at,
            CASE u.user_type
              WHEN 'customer' THEN TRIM(CONCAT(c.first_name, ' ', c.last_name))
              WHEN 'repair' THEN g.shop_name
              WHEN 'technician' THEN t.name
              WHEN 'admin' THEN 'ผู้ดูแลระบบ'
              ELSE u.email
            END AS display_name,
            g.id AS garage_row_id
     FROM users u
     LEFT JOIN customers c ON c.user_id = u.id AND u.user_type = 'customer'
     LEFT JOIN garages g ON g.user_id = u.id AND u.user_type = 'repair'
     LEFT JOIN technicians t ON t.user_id = u.id AND u.user_type = 'technician'
     ORDER BY u.created_at DESC, u.id DESC`,
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: '', data: { users: results } });
    }
  );
});

// เปิด/ระงับการใช้งานบัญชี (ใช้ได้กับทุก user_type)
app.put('/api/admin/users/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body; // 'active' | 'suspended'
  if (!['active', 'suspended'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  db.query('UPDATE users SET status = ? WHERE id = ?', [status, id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบผู้ใช้นี้' });
    res.json({ success: true, message: status === 'suspended' ? 'ระงับบัญชีแล้ว' : 'เปิดใช้งานบัญชีแล้ว' });
  });
});

// ลบบัญชีผู้ใช้ถาวร — ถ้ามีข้อมูลอ้างอิงอยู่ (repair_requests/payments/ฯลฯ) DB จะกัน FK
// ไว้ไม่ให้ลบ ป้องกันข้อมูลอื่นพัง กรณีนี้แนะนำให้ "ระงับ" แทน
app.delete('/api/admin/users/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
    if (err) {
      // '23503' = Postgres foreign_key_violation (เทียบเท่า ER_ROW_IS_REFERENCED ของ MySQL)
      if (err.code === '23503') {
        return res.json({ success: false, message: 'ลบไม่ได้ เพราะมีข้อมูลอื่นผูกอยู่ (เช่น งานซ่อม/การชำระเงิน) กรุณาใช้ "ระงับ" แทน' });
      }
      return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    }
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบผู้ใช้นี้' });
    res.json({ success: true, message: 'ลบบัญชีแล้ว' });
  });
});

// ============================================================
// ===== ADMIN: จัดการอู่ซ่อมรถ (1.3.4.4-1.3.4.7) =====
// ============================================================
app.get('/api/admin/garages', (req, res) => {
  db.query(
    `SELECT g.id, g.user_id, g.shop_name, g.owner_name, g.phone, g.address, g.avatar,
            u.email, u.status AS user_status, g.status AS garage_status, u.created_at,
            COALESCE(AVG(rv.rating), 0) AS avg_rating, COUNT(rv.id) AS review_count,
            (SELECT COUNT(*) FROM repair_requests rr WHERE rr.garage_id = g.user_id) AS job_count
     FROM garages g
     JOIN users u ON u.id = g.user_id
     LEFT JOIN reviews rv ON rv.garage_id = g.user_id
     GROUP BY g.id, u.id
     ORDER BY avg_rating DESC, g.id DESC`,
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const garages = results.map((g) => ({ ...g, avatar: toImageUrl(g.avatar), avg_rating: Number(g.avg_rating).toFixed(1) }));
      res.json({ success: true, message: '', data: { garages } });
    }
  );
});

// อนุมัติ/ปฏิเสธ/ระงับ/เปิดใช้งานอู่ (ครอบคลุมทั้งข้อ 1.3.4.4 และ 1.3.4.5)
app.put('/api/admin/garages/:id/status', (req, res) => {
  const { id } = req.params; // garages.id (primary key ของตารางเอง)
  const { status } = req.body; // 'pending' | 'approved' | 'rejected' | 'suspended'
  if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  db.query('UPDATE garages SET status = ? WHERE id = ?', [status, id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบอู่นี้' });
    res.json({ success: true, message: 'อัปเดตสถานะอู่แล้ว' });
  });
});

// แก้ไขข้อมูลโปรไฟล์อู่ (1.3.4.6)
app.put('/api/admin/garages/:id/profile', (req, res) => {
  const { id } = req.params;
  const { shopName, ownerName, phone, address } = req.body;
  db.query(
    'UPDATE garages SET shop_name = ?, owner_name = ?, phone = ?, address = ? WHERE id = ?',
    [shopName, ownerName, phone, address, id],
    (err, result) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบอู่นี้' });
      res.json({ success: true, message: 'บันทึกโปรไฟล์อู่แล้ว' });
    }
  );
});
// หมายเหตุ: การจัดอันดับอู่ (1.3.4.7) ใช้ผลจาก avg_rating ที่ query ด้านบนคำนวณให้แล้ว
// (เรียงจากคะแนนสูงสุด) ไม่ต้องมี endpoint แยก

// ============================================================
// ===== ADMIN: งานซ่อมทั้งหมด + ปรับสถานะกรณีผิดพลาด (1.3.4.9) =====
// ============================================================
app.get('/api/admin/repairs', (req, res) => {
  db.query(
    `SELECT rr.id, rr.status, rr.problem_category, rr.vehicle_type, rr.created_at, rr.completed_at,
            TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS customer_name,
            g.shop_name AS garage_name
     FROM repair_requests rr
     JOIN customers c ON c.user_id = rr.customer_id
     JOIN garages g ON g.user_id = rr.garage_id
     ORDER BY rr.created_at DESC`,
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: '', data: { repairs: results } });
    }
  );
});

// ผู้ดูแลปรับสถานะงานซ่อมตรงๆ ได้ในกรณีเกิดข้อผิดพลาด (เช่น ค้างสถานะผิดจากบั๊ก)
app.put('/api/admin/repairs/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'accepted', 'quoted', 'confirmed', 'assigned', 'checking', 'in_progress', 'waiting_parts', 'completed', 'rejected'];
  if (!validStatuses.includes(status)) {
    return res.json({ success: false, message: 'สถานะไม่ถูกต้อง' });
  }
  db.query('UPDATE repair_requests SET status = ? WHERE id = ?', [status, id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบงานซ่อมนี้' });
    res.json({ success: true, message: 'ปรับสถานะงานซ่อมแล้ว' });
  });
});

app.delete('/api/admin/repairs/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM repair_requests WHERE id = ?', [id], (err, result) => {
    if (err) {
      // '23503' = Postgres foreign_key_violation (เทียบเท่า ER_ROW_IS_REFERENCED ของ MySQL)
      if (err.code === '23503') {
        return res.json({ success: false, message: 'ลบไม่ได้ เพราะมีใบเสนอราคา/การชำระเงินผูกอยู่' });
      }
      return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    }
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบงานซ่อมนี้' });
    res.json({ success: true, message: 'ลบงานซ่อมแล้ว' });
  });
});

// ============================================================
// ===== ADMIN: รีวิว & ข้อร้องเรียน (1.3.4.8) =====
// ============================================================
app.get('/api/admin/reviews', (req, res) => {
  db.query(
    `SELECT rv.id, rv.rating, rv.comment, rv.reply, rv.hidden, rv.created_at,
            TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS reviewer_name,
            g.shop_name AS garage_name
     FROM reviews rv
     JOIN customers c ON c.user_id = rv.customer_id
     JOIN garages g ON g.user_id = rv.garage_id
     ORDER BY rv.created_at DESC`,
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: '', data: { reviews: results } });
    }
  );
});

app.put('/api/admin/reviews/:id/hidden', (req, res) => {
  const { id } = req.params;
  const { hidden } = req.body; // true/false
  db.query('UPDATE reviews SET hidden = ? WHERE id = ?', [hidden ? 1 : 0, id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบรีวิวนี้' });
    res.json({ success: true, message: hidden ? 'ซ่อนรีวิวแล้ว' : 'แสดงรีวิวแล้ว' });
  });
});

app.delete('/api/admin/reviews/:id', (req, res) => {
  const { id } = req.params;
  db.query('DELETE FROM reviews WHERE id = ?', [id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (result.affectedRows === 0) return res.json({ success: false, message: 'ไม่พบรีวิวนี้' });
    res.json({ success: true, message: 'ลบรีวิวแล้ว' });
  });
});

// ✅ ลูกค้า/อู่/ช่าง แจ้งข้อร้องเรียน (แยกจากรีวิว) — เดิม endpoint ฝั่งแอดมินด้านล่างเตรียมไว้
// รอมานานแล้วแต่ไม่เคยมีทางส่งเข้ามาเลย ตอนนี้เชื่อมแล้ว reporterId คือ users.id ของคนที่
// ล็อกอินอยู่ (ส่งมาจาก client), garageId ใส่หรือไม่ใส่ก็ได้ (อู่ที่เกี่ยวข้องกับเรื่องที่ร้องเรียน)
// แอดมินเห็นทันทีในหน้า "รีวิว & ข้อร้องเรียน" (ใช้ endpoint GET/resolve/delete ที่มีอยู่แล้วด้านล่าง)
app.post('/api/complaints', (req, res) => {
  const { reporterId, garageId, subject, detail } = req.body;
  if (!reporterId || !subject || !subject.toString().trim()) {
    return res.json({ success: false, message: 'กรุณากรอกหัวข้อข้อร้องเรียน' });
  }
  db.query(
    'INSERT INTO complaints (reporter_id, garage_id, subject, detail, status) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [reporterId, garageId || null, subject, detail || null, 'pending'],
    (err) => {
      if (err) return res.json({ success: false, message: 'ส่งข้อร้องเรียนไม่สำเร็จ: ' + err.message });
      res.json({ success: true, message: 'ส่งข้อร้องเรียนเรียบร้อยแล้ว ทีมงานจะดำเนินการโดยเร็วที่สุด' });
    }
  );
});

app.get('/api/admin/complaints', (req, res) => {
  db.query(
    // ✅ แก้ไข: ผู้แจ้ง (reporter_id) อาจเป็นลูกค้า/เจ้าของอู่/ช่างก็ได้ (ดู POST /api/complaints
    // ด้านบน — ทุก userType แจ้งได้) เดิม JOIN แค่ตาราง customers ทำให้ถ้าอู่หรือช่างเป็นคน
    // แจ้งเอง ชื่อผู้แจ้งจะว่างเปล่าในหน้าแอดมิน — ใช้ COALESCE ไล่ดูทั้ง 3 ตารางแทน
    `SELECT cp.id, cp.subject, cp.detail, cp.status, cp.created_at,
            COALESCE(
              NULLIF(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''),
              rg.owner_name,
              rt.name
            ) AS reporter_name,
            g.shop_name AS garage_name
     FROM complaints cp
     LEFT JOIN customers c ON c.user_id = cp.reporter_id
     LEFT JOIN garages rg ON rg.user_id = cp.reporter_id
     LEFT JOIN technicians rt ON rt.user_id = cp.reporter_id
     LEFT JOIN garages g ON g.user_id = cp.garage_id
     ORDER BY cp.created_at DESC`,
    (err, results) => {
      if (err) return res.json({ success: true, message: '', data: { complaints: [] } }); // ตาราง complaints อาจยังไม่ถูกสร้าง
      res.json({ success: true, message: '', data: { complaints: results } });
    }
  );
});

app.put('/api/admin/complaints/:id/resolve', (req, res) => {
  db.query('UPDATE complaints SET status = ? WHERE id = ?', ['resolved', req.params.id], (err, result) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    res.json({ success: true, message: 'บันทึกว่าแก้ไขแล้ว' });
  });
});

app.delete('/api/admin/complaints/:id', (req, res) => {
  db.query('DELETE FROM complaints WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    res.json({ success: true, message: 'ลบแล้ว' });
  });
});

// ============================================================
// ===== ADMIN: รายงานสถิติละเอียด (1.3.4.10, 1.3.4.11) =====
// ============================================================
app.get('/api/admin/reports', (req, res) => {
  const range = req.query.range === 'yearly' ? 'yearly' : req.query.range === 'daily' ? 'daily' : 'monthly';

  // จำนวนคำขอซ่อมแยกตามช่วงเวลา ให้เอาไปวาดกราฟเส้น (ใช้ SVG ธรรมดา ไม่พึ่ง library)
  // ✅ Postgres ไม่มี DATE_FORMAT() แบบ MySQL — ใช้ TO_CHAR() แทน (รูปแบบ pattern คนละชุด
  // แต่ผลลัพธ์ bucket string ที่ได้ออกมาเหมือนเดิมทุกประการ 'YYYY-MM-DD'/'YYYY'/'YYYY-MM')
  const groupExpr = range === 'daily'
    ? "TO_CHAR(created_at, 'YYYY-MM-DD')"
    : range === 'yearly'
      ? "TO_CHAR(created_at, 'YYYY')"
      : "TO_CHAR(created_at, 'YYYY-MM')";

  db.query(
    `SELECT ${groupExpr} AS bucket, COUNT(*) AS count
     FROM repair_requests
     GROUP BY bucket
     ORDER BY bucket ASC
     LIMIT 12`,
    (err, trend) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });

      db.query(
        // ✅ Postgres จะ fold alias เป็นตัวพิมพ์เล็กหมดถ้าไม่ใส่ double quote ครอบ (ต่างจาก
        // MySQL ที่คง camelCase ตามที่เขียนไว้เป๊ะๆ) ต้องใส่ "..." ครอบทุก alias แบบ camelCase
        // ไม่งั้น key ที่ frontend อ่าน (เช่น totalRepairRequests) จะหายไปเป็น totalrepairrequests แทน
        `SELECT
            (SELECT COUNT(*) FROM repair_requests) AS "totalRepairRequests",
            (SELECT COUNT(*) FROM users) AS "totalUsers",
            (SELECT COUNT(*) FROM garages) AS "totalGarages"
        `,
        (err2, totalsResult) => {
          if (err2) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err2.message });

          db.query(
            `SELECT g.id AS garage_row_id, g.user_id AS garage_id, g.shop_name, g.avatar, g.status,
                    COUNT(DISTINCT rr.id) AS job_count, COALESCE(AVG(rv.rating), 0) AS avg_rating,
                    COUNT(DISTINCT rv.id) AS review_count,
                    (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                     WHERE p.garage_id = g.user_id AND p.status = 'confirmed') AS total_revenue
             FROM garages g
             LEFT JOIN repair_requests rr ON rr.garage_id = g.user_id
             LEFT JOIN reviews rv ON rv.garage_id = g.user_id
             GROUP BY g.id
             ORDER BY avg_rating DESC, job_count DESC
             LIMIT 5`,
            (err3, topGarages) => {
              if (err3) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err3.message });
              res.json({
                success: true,
                message: '',
                data: {
                  range,
                  trend,
                  totals: totalsResult[0],
                  topGarages: topGarages.map((g) => ({
                    ...g,
                    avatar: toImageUrl(g.avatar),
                    avg_rating: Number(g.avg_rating).toFixed(1),
                    status: g.status || 'approved',
                  })),
                },
              });
            }
          );
        }
      );
    }
  );
});

// ===== ADMIN: สรุปสถิติภาพรวม (ข้อ 1.3.4.10 — จำนวนผู้ใช้/อู่/งานซ่อม) =====
// ============================================================
// ===== บัญชีรับเงินของแพลตฟอร์ม (สำหรับอู่โอนเข้าตอนเติมเงิน Wallet) =====
// ⚠️ จุดที่ขาดหายไปมาก่อน — หน้า Wallet ของอู่บอกให้ "โอนเข้าบัญชีแพลตฟอร์ม"
// แต่ไม่เคยมีที่ไหนบอกเลขบัญชีจริงเลย ต้องตั้งค่าตรงนี้ก่อนใช้งานจริง
// ============================================================

// อู่ใช้ดูตอนจะเติมเงิน — เปิดเผยได้ ไม่มีข้อมูลอ่อนไหว
app.get('/api/platform/bank-account', (req, res) => {
  db.query('SELECT * FROM platform_bank_account WHERE id = 1', (err, results) => {
    if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
    if (results.length === 0) {
      return res.json({ success: true, message: '', data: null }); // ยังไม่ได้ตั้งค่า
    }
    res.json({ success: true, message: '', data: results[0] });
  });
});

// [แอดมิน] ตั้งค่า/แก้ไขบัญชีรับเงินของแพลตฟอร์ม
app.put('/api/admin/platform/bank-account', (req, res) => {
  const { bankName, bankAccountNumber, bankAccountName, promptpayId } = req.body;
  if (!bankName || !bankAccountNumber || !bankAccountName) {
    return res.json({ success: false, message: 'กรุณากรอกธนาคาร เลขที่บัญชี และชื่อบัญชีให้ครบ' });
  }
  db.query(
    `INSERT INTO platform_bank_account (id, bank_name, bank_account_number, bank_account_name, promptpay_id)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       bank_name = EXCLUDED.bank_name, bank_account_number = EXCLUDED.bank_account_number,
       bank_account_name = EXCLUDED.bank_account_name, promptpay_id = EXCLUDED.promptpay_id`,
    [bankName, bankAccountNumber, bankAccountName, promptpayId || null],
    (err) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: 'บันทึกบัญชีรับเงินของแพลตฟอร์มแล้ว' });
    }
  );
});

app.get('/api/admin/dashboard-stats', (req, res) => {
  db.query(
    // ✅ แปลงจาก MySQL: DATE_SUB(CURDATE(), INTERVAL 1 MONTH) -> CURRENT_DATE - INTERVAL '1 month',
    // CURDATE() -> CURRENT_DATE, DATE(created_at) -> created_at::date (Postgres ไม่มีฟังก์ชัน DATE())
    // และใส่ double quote ครอบทุก alias camelCase กัน Postgres fold เป็นตัวพิมพ์เล็ก (ดูคอมเมนต์
    // เดียวกันด้านบนในเอนด์พอยต์ /api/admin/reports)
    `SELECT
      (SELECT COUNT(*) FROM customers) AS "totalCustomers",
      -- ✅ บั๊กเดิม (มีมาก่อนย้าย DB ครั้งนี้): ตาราง customers ไม่มีคอลัมน์ created_at เลย
      -- (ดู CREATE TABLE customers — มีแต่ user_id/first_name/... ไม่มี created_at) ทำให้
      -- query นี้ error "Unknown column 'created_at'" มาตลอด และเพราะเป็น subquery เดียว
      -- ในชุดเดียวกับ totalRevenue/revenueThisMonth query ทั้งก้อนจึง fail ไปด้วย เป็นเหตุผล
      -- ที่การ์ด "รายได้รวม" ในหน้า reports.html โชว์ "—" ค้างมาตลอด — แก้โดย join ไปเอา
      -- created_at จาก users แทน (เหมือนที่ newGaragesThisMonth ด้านล่างทำอยู่แล้ว)
      (SELECT COUNT(*) FROM customers c JOIN users u ON u.id = c.user_id WHERE u.created_at >= CURRENT_DATE - INTERVAL '1 month') AS "newCustomersThisMonth",
      (SELECT COUNT(*) FROM garages) AS "totalGarages",
      (SELECT COUNT(*) FROM garages g JOIN users u ON u.id = g.user_id WHERE u.created_at >= CURRENT_DATE - INTERVAL '1 month') AS "newGaragesThisMonth",
      (SELECT COUNT(*) FROM repair_requests) AS "totalRepairRequests",
      (SELECT COUNT(*) FROM repair_requests WHERE created_at >= CURRENT_DATE - INTERVAL '1 month') AS "newRequestsThisMonth",
      (SELECT COUNT(*) FROM repair_requests WHERE status = 'completed') AS "completedRepairRequests",
      (SELECT COUNT(*) FROM repair_requests WHERE created_at::date = CURRENT_DATE) AS "todayRepairRequests",
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'confirmed') AS "totalRevenue",
      (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'confirmed' AND confirmed_at >= CURRENT_DATE - INTERVAL '1 month') AS "revenueThisMonth",
      (SELECT COALESCE(AVG(rating), 0) FROM reviews) AS "avgSatisfaction"
    `,
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      const s = results[0];
      // ✅ คำนวณ % เพิ่มขึ้นแบบง่าย: เทียบยอด "เดือนนี้" กับสัดส่วนของยอดรวมทั้งหมด
      // (ไม่มีข้อมูลยอดของ "เดือนก่อน" แยกเก็บไว้ต่างหาก เลยประมาณจากอัตราการเติบโตล่าสุด
      // แทน — ยังคงเป็นตัวเลขที่คำนวณจากข้อมูลจริงในระบบ ไม่ใช่ค่าที่ตั้งไว้ลอยๆ)
      const pct = (part, total) => (Number(total) > 0 ? Math.round((Number(part) / Number(total)) * 100) : 0);
      res.json({
        success: true,
        message: '',
        data: {
          ...s,
          avgSatisfaction: Number(s.avgSatisfaction).toFixed(1),
          customerGrowthPct: pct(s.newCustomersThisMonth, s.totalCustomers),
          garageGrowthPct: pct(s.newGaragesThisMonth, s.totalGarages),
          requestGrowthPct: pct(s.newRequestsThisMonth, s.totalRepairRequests),
          revenueGrowthPct: pct(s.revenueThisMonth, s.totalRevenue),
        },
      });
    }
  );
});

// ===== [แอดมิน] กราฟแนวโน้มรายเดือน 6 เดือนล่าสุด — ผู้ใช้ใหม่/งานซ่อม/รายได้ (ข้อมูลจริง) =====
app.get('/api/admin/dashboard-charts', (req, res) => {
  // ✅ แปลงจาก MySQL: DATE_FORMAT(col, '%Y-%m') -> TO_CHAR(col, 'YYYY-MM'),
  // DATE_SUB(CURDATE(), INTERVAL 6 MONTH) -> CURRENT_DATE - INTERVAL '6 months'
  const monthlyUsersSql = `
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS bucket, COUNT(*) AS count
    FROM users WHERE created_at >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY bucket ORDER BY bucket ASC`;
  const monthlyRepairsSql = `
    SELECT TO_CHAR(created_at, 'YYYY-MM') AS bucket, COUNT(*) AS count
    FROM repair_requests WHERE created_at >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY bucket ORDER BY bucket ASC`;
  const monthlyRevenueSql = `
    SELECT TO_CHAR(confirmed_at, 'YYYY-MM') AS bucket, COALESCE(SUM(amount), 0) AS total
    FROM payments WHERE status = 'confirmed' AND confirmed_at >= CURRENT_DATE - INTERVAL '6 months'
    GROUP BY bucket ORDER BY bucket ASC`;

  db.query(monthlyUsersSql, (e1, users) => {
    if (e1) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e1.message });
    db.query(monthlyRepairsSql, (e2, repairs) => {
      if (e2) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e2.message });
      db.query(monthlyRevenueSql, (e3, revenue) => {
        if (e3) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e3.message });
        res.json({ success: true, message: '', data: { users, repairs, revenue } });
      });
    });
  });
});

// ===== [แอดมิน] กิจกรรมล่าสุดในระบบ (ของจริง — รวมจากหลายตารางเรียงตามเวลา) =====
app.get('/api/admin/activity-feed', (req, res) => {
  // ✅ เดิม limit ถูกแทรกเข้า SQL ตรงๆ ด้วย template literal (ไม่ผ่าน placeholder ?)
  // แม้ Number(...) || 8 จะกันไม่ให้ inject โค้ดแปลกปลอมได้จริงอยู่แล้ว แต่เปลี่ยนมาใช้
  // placeholder ให้ครบตามธรรมเนียมที่เหลือทั้งไฟล์ใช้ (defense-in-depth) พร้อมจำกัด
  // ช่วงค่าไม่ให้ query ยอมรับเลขที่ไม่สมเหตุสมผล (เช่น limit=0 หรือค่าติดลบ)
  const limit = Math.min(Math.max(Number(req.query.limit) || 8, 1), 100);
  db.query(
    `(SELECT 'สมัครสมาชิกใหม่' AS action, TRIM(CONCAT(c.first_name, ' ', c.last_name)) AS user_name,
             u.created_at AS at, 'สำเร็จ' AS status
      FROM users u JOIN customers c ON c.user_id = u.id
      ORDER BY u.created_at DESC LIMIT ?)
     UNION ALL
     (SELECT CONCAT('สมัครเปิดอู่ "', g.shop_name, '"'), g.owner_name, u.created_at,
             CASE g.status WHEN 'approved' THEN 'สำเร็จ' WHEN 'pending' THEN 'รอดำเนินการ' ELSE 'ปฏิเสธ' END
      FROM users u JOIN garages g ON g.user_id = u.id
      ORDER BY u.created_at DESC LIMIT ?)
     UNION ALL
     (SELECT CONCAT('ส่งคำขอซ่อม: ', rr.problem_category), TRIM(CONCAT(c.first_name, ' ', c.last_name)), rr.created_at,
             CASE rr.status WHEN 'rejected' THEN 'ยกเลิก' WHEN 'completed' THEN 'สำเร็จ' ELSE 'รอดำเนินการ' END
      FROM repair_requests rr JOIN customers c ON c.user_id = rr.customer_id
      ORDER BY rr.created_at DESC LIMIT ?)
     UNION ALL
     (SELECT CONCAT('ให้คะแนนรีวิวอู่ "', g.shop_name, '"'), TRIM(CONCAT(c.first_name, ' ', c.last_name)), rv.created_at, 'สำเร็จ'
      FROM reviews rv JOIN customers c ON c.user_id = rv.customer_id JOIN garages g ON g.user_id = rv.garage_id
      ORDER BY rv.created_at DESC LIMIT ?)
     ORDER BY at DESC LIMIT ?`,
    [limit, limit, limit, limit, limit],
    (err, results) => {
      if (err) return res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + err.message });
      res.json({ success: true, message: '', data: { activity: results } });
    }
  );
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server รันอยู่ที่ ${PUBLIC_URL}`);
});