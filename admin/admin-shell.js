// ============================================================
// ไฟล์: admin-shell.js
// ใช้ร่วมกันทุกหน้าใน admin/ — sidebar เมนู, auth guard, helper ต่างๆ
// ============================================================

const ADMIN_MENU = [
  { group: 'ภาพรวม', items: [
    { key: 'dashboard', href: 'dashboard.html', label: 'แดชบอร์ด',
      icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>' },
  ]},
  { group: 'จัดการผู้ใช้งาน', items: [
    { key: 'users', href: 'users.html', label: 'บัญชีผู้ใช้งาน',
      icon: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 9a2.8 2.8 0 1 0 0-5.6M17.5 14.2c2.5.4 4.5 2.4 4.5 5.8"/>' },
  ]},
  { group: 'จัดการอู่ซ่อมรถ', items: [
    { key: 'garages', href: 'garages.html', label: 'อู่ซ่อมรถ & อนุมัติ',
      icon: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-7h6v7"/>' },
  ]},
  { group: 'ควบคุมคุณภาพ', items: [
    { key: 'repairs', href: 'repairs.html', label: 'ปรับสถานะงานซ่อม',
      icon: '<path d="M9 12h6m-6 4h6M9 8h2"/><rect x="4" y="4" width="16" height="16" rx="2.5"/>' },
    { key: 'reviews', href: 'reviews.html', label: 'รีวิว & ข้อร้องเรียน',
      icon: '<path d="M21 11.5a8.5 8.5 0 1 1-4.4-7.4"/><path d="M21 4 12 13l-3-3"/>' },
  ]},
  { group: 'การเงิน', items: [
    { key: 'commissions', href: 'commissions.html', label: 'Wallet & ค่าคอมมิชชั่น',
      icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5c0-1.4 1.3-2.5 3-2.5s3 1.1 3 2.5-1.3 2.5-3 2.5-3 1.1-3 2.5 1.3 2.5 3 2.5 3-1.1 3-2.5"/>' },
  ]},
  { group: 'รายงาน', items: [
    { key: 'reports', href: 'reports.html', label: 'สถิติ & กราฟ',
      icon: '<path d="M4 20V10m6 10V4m6 16v-7"/>' },
  ]},
  { group: 'ระบบ', items: [
    { key: 'settings', href: 'settings.html', label: 'ตั้งค่า & สิทธิ์',
      icon: '<path d="M12 2 3 6v6c0 5 4 8.5 9 10 5-1.5 9-5 9-10V6l-9-4z"/>' },
  ]},
];

// ✅ ใช้ธีมที่เคยเลือกไว้ทันทีที่สคริปต์นี้โหลด (ก่อน mountSidebar/mountAppbar จะ render)
// กันเห็นธีมสว่างวาบแล้วค่อยเปลี่ยนเป็นมืดทีหลัง
(function applyStoredTheme() {
  const saved = localStorage.getItem('adminTheme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
})();

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('adminTheme', next);
  document.querySelectorAll('.theme-toggle-icon').forEach((el) => (el.innerHTML = themeIconSvg(next)));
  document.querySelectorAll('.theme-toggle-label').forEach((el) => (el.textContent = next === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด'));
}

function themeIconSvg(theme) {
  // แสดงไอคอนของ "โหมดที่จะสลับไป" (อยู่มืดอยู่ตอนนี้ -> โชว์ไอคอนพระอาทิตย์ ชวนสลับไปสว่าง)
  return theme === 'dark'
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
    : '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
}

function themeToggleButtonHtml(variant = 'sidebar') {
  const theme = currentTheme();
  if (variant === 'appbar') {
    return `
      <button class="icon-btn" title="สลับธีม" onclick="toggleTheme()">
        <svg class="theme-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${themeIconSvg(theme)}</svg>
      </button>`;
  }
  return `
    <button class="logout-btn theme-toggle-btn" onclick="toggleTheme()" style="margin-top:8px;background:rgba(124,108,240,0.1);border-color:rgba(124,108,240,0.25);color:#a78bfa;">
      <svg class="theme-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${themeIconSvg(theme)}</svg>
      <span class="theme-toggle-label">${theme === 'dark' ? 'โหมดสว่าง' : 'โหมดมืด'}</span>
    </button>`;
}

function requireAdmin() {
  const raw = sessionStorage.getItem('adminUser');
  if (!raw) {
    window.location.href = 'login.html';
    return null;
  }
  return JSON.parse(raw);
}

function mountSidebar(activeKey) {
  const admin = requireAdmin();
  const mount = document.getElementById('sidebarMount');
  if (!mount) return;

  const menuHtml = ADMIN_MENU.map(group => `
    <div class="menu-group">
      <div class="menu-title">${group.group}</div>
      ${group.items.map(item => `
        <a class="menu-item ${item.key === activeKey ? 'active' : ''}" href="${item.href}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>
          ${item.label}
        </a>`).join('')}
    </div>`).join('');

  mount.innerHTML = `
    <div class="sidebar-brand">
      <div class="icon">
        <svg viewBox="0 0 24 24" fill="none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="label">Good Garage<small>ADMIN PANEL</small></div>
    </div>
    <nav class="menu">${menuHtml}</nav>
    <div class="sidebar-footer">
      <div class="admin-chip">
        <div class="admin-avatar">${(admin && admin.email ? admin.email.charAt(0) : 'A').toUpperCase()}</div>
        <div class="admin-info">
          <div class="name">${admin ? (admin.name || 'ผู้ดูแลระบบ') : ''}</div>
          <div class="email">${admin ? admin.email : ''}</div>
        </div>
      </div>
      <button class="logout-btn" onclick="logoutAdmin()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ออกจากระบบ
      </button>
      ${themeToggleButtonHtml('sidebar')}
    </div>
  `;
}

// ✅ แถบบนสุด (Admin Management System + ค้นหา/แจ้งเตือน/avatar) ตรงกับต้นแบบ Figma
// เดิมไม่มีแถบนี้เลย มีแค่หัวข้อหน้าใน .topbar อย่างเดียว
function mountAppbar(mountId = 'appbarMount') {
  const admin = requireAdmin();
  const mount = document.getElementById(mountId);
  if (!mount) return;

  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
      <button class="icon-btn menu-toggle-btn" title="เมนู" onclick="toggleMobileSidebar()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
      <div class="title">Admin Management System</div>
    </div>
    <div class="actions">
      ${themeToggleButtonHtml('appbar')}
      <button class="icon-btn" title="ค้นหา" onclick="alert('ค้นหา — ใช้ช่องค้นหาในแต่ละหน้าแทนได้เลยครับ')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <div class="notif-wrap" style="position:relative;">
        <button class="icon-btn" title="การแจ้งเตือน" onclick="toggleNotifPanel(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <span class="dot"></span>
        </button>
        <div id="notifPanel" style="display:none;position:absolute;top:44px;right:0;width:300px;max-height:360px;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:12px;box-shadow:0 16px 40px -12px rgba(0,0,0,0.3);z-index:50;"></div>
      </div>
      <div class="avatar-chip">
        <div class="circle">${(admin && admin.email ? admin.email.charAt(0) : 'A').toUpperCase()}</div>
        <span class="name">${admin ? (admin.name || 'Admin') : ''}</span>
      </div>
    </div>
  `;
}

// ✅ แจ้งเตือน — เดิมปุ่มนี้ไม่มี onclick เลย กดแล้วไม่มีอะไรเกิดขึ้น (ปุ่มตายจริงๆ)
// ตอนนี้ดึงรายการล่าสุดจาก /api/admin/activity-feed (endpoint เดิมที่ใช้ในตารางกิจกรรมของ
// หน้าแดชบอร์ดอยู่แล้ว) มาโชว์เป็น dropdown แทน — โหลดครั้งเดียวตอนเปิดแผงครั้งแรกแล้วแคชไว้
let __notifLoaded = false;
async function toggleNotifPanel(event) {
  event.stopPropagation();
  const panel = document.getElementById('notifPanel');
  if (!panel) return;
  const willShow = panel.style.display === 'none';
  panel.style.display = willShow ? 'block' : 'none';
  if (!willShow || __notifLoaded) return;

  panel.innerHTML = '<div style="padding:16px;font-size:12.5px;color:var(--text-mute);text-align:center;">กำลังโหลด...</div>';
  try {
    const res = await fetch(window.location.origin + '/api/admin/activity-feed');
    const data = await res.json();
    const items = (data.success && data.data && data.data.activity) ? data.data.activity.slice(0, 8) : [];
    panel.innerHTML = items.length
      ? items.map(a => `
          <div style="padding:10px 14px;border-bottom:1px solid var(--border);font-size:12.5px;">
            <div style="color:var(--text-main);font-weight:600;">${escapeHtml(a.user_name || '-')}</div>
            <div style="color:var(--text-mute);margin-top:2px;">${escapeHtml(a.action)}</div>
            <div style="color:var(--text-faint);font-size:11px;margin-top:2px;">${formatDate(a.at)}</div>
          </div>`).join('')
      : '<div style="padding:16px;font-size:12.5px;color:var(--text-mute);text-align:center;">ยังไม่มีการแจ้งเตือน</div>';
    __notifLoaded = true;
  } catch (err) {
    panel.innerHTML = '<div style="padding:16px;font-size:12.5px;color:var(--danger);text-align:center;">โหลดการแจ้งเตือนไม่สำเร็จ</div>';
  }
}

// ปิดแผงแจ้งเตือนเมื่อคลิกข้างนอก — ผูกครั้งเดียวตอนโหลดสคริปต์นี้ (ไม่ใช่ทุกครั้งที่ mountAppbar)
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  if (panel && panel.style.display === 'block' && !e.target.closest('.notif-wrap')) {
    panel.style.display = 'none';
  }
});

// ✅ เมนูมือถือ — เดิม sidebar แค่ display:none ไปเลยตอนจอเล็กกว่า 860px กดเข้าเมนูอื่น
// ไม่ได้อีกเลย ตอนนี้เปลี่ยนเป็นเลื่อนออกมาจากซ้าย (off-canvas) กดปุ่มขีดสามขีดที่ appbar
// เพื่อเปิด/ปิด มีฉากหลังคลิกเพื่อปิดด้วย (สร้างฉากหลังแบบ lazy ตอนเปิดครั้งแรกเท่านั้น)
function toggleMobileSidebar(forceClose) {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  let backdrop = document.getElementById('sidebarBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebarBackdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.onclick = () => toggleMobileSidebar(true);
    document.body.appendChild(backdrop);
  }

  const shouldOpen = forceClose === true ? false : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', shouldOpen);
  backdrop.classList.toggle('show', shouldOpen);
}

function logoutAdmin() {
  sessionStorage.removeItem('adminUser');
  window.location.href = 'login.html';
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(isoString) {
  if (!isoString) return '-';
  const d = new Date(isoString);
  if (isNaN(d)) return '-';
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

function badge(text, type) {
  return `<span class="badge badge-${type}">${escapeHtml(text)}</span>`;
}

function toast(message, success = true) {
  let box = document.getElementById('toastBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toastBox';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${success ? 'success' : 'error'}`;
  el.textContent = message || (success ? 'สำเร็จ' : 'เกิดข้อผิดพลาด');
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}