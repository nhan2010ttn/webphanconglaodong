import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, getDocs, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ========== DÁN CONFIG CỦA BẠN VÀO ĐÂY ========== */
const firebaseConfig = {
  apiKey: "AIzaSyCYwWT5iIRCEkjHGA_YmZ80brKr5bu-Gp0",
  authDomain: "phancongtruc-e5fb6.firebaseapp.com",
  projectId: "phancongtruc-e5fb6",
  storageBucket: "phancongtruc-e5fb6.firebasestorage.app",
  messagingSenderId: "542899039872",
  appId: "1:542899039872:web:ad4f30b61fbac633710065"
};
/* ================================================ */

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const ADMIN_PASSWORD = "13579";
const DAYS = ['mon','tue','wed','thu','fri','sat'];
const DAY_LABEL = { mon:'Thứ 2', tue:'Thứ 3', wed:'Thứ 4', thu:'Thứ 5', fri:'Thứ 6', sat:'Thứ 7' };
const MAX_PHOTOS_PER_DAY = 5;

/* Kích thước nén ảnh — càng nhỏ càng tiết kiệm Firestore */
const IMG_MAX_SIZE = 900;      // px cạnh dài nhất
const IMG_QUALITY = 0.55;      // 0..1 — càng nhỏ càng nhẹ

/* ========== STATE ========== */
let isAdmin = false;
let weeks = [];
let messages = [];
let view = { screen: 'home', weekId: null, assignmentId: null };
let currentWeekData = null;
let currentAssignments = [];
let currentAssignmentData = null;
let currentPhotos = [];
let pendingDay = null;

/* ========== HELPERS ========== */
const $ = id => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}
window.toast = toast;

function fmtDateTimeVN(ts){
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}
function fmtRelativeVN(ts){
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'vừa xong';
  if (diff < 3600) return Math.floor(diff/60) + ' phút trước';
  if (diff < 86400) return Math.floor(diff/3600) + ' giờ trước';
  return fmtDateTimeVN(ts);
}
function initials(name){
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length-1][0]
                            : parts[0].slice(0,2)).toUpperCase();
}
function bytesToMB(b){
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(2) + ' MB';
}

/* ========== MODAL ========== */
function openModal({ title, body, footer, wide, onOpen }){
  $('modalRoot').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h2>${title}</h2>
          <button class="icon-btn" id="modalClose">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  $('modalClose').onclick = closeModal;
  $('overlay').addEventListener('click', e => { if (e.target.id === 'overlay') closeModal(); });
  document.addEventListener('keydown', escHandler);
  if (onOpen) onOpen();
}
function closeModal(){
  $('modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escHandler);
}
function escHandler(e){ if (e.key === 'Escape') closeModal(); }
window.closeModal = closeModal;

/* ========== HEADER / FAB ========== */
function updateHeader(){
  const backBtn = $('backBtn');
  const title = $('pageTitle');
  const inboxBtn = $('inboxBtn');

  if (view.screen === 'home'){
    backBtn.classList.add('hidden');
    title.textContent = '📋 Phân Công Trực Nhật';
  } else if (view.screen === 'week'){
    backBtn.classList.remove('hidden');
    title.textContent = currentWeekData ? currentWeekData.name : 'Tuần';
  } else if (view.screen === 'assignment'){
    backBtn.classList.remove('hidden');
    title.textContent = currentAssignmentData ? currentAssignmentData.studentName : 'Chi tiết';
  }
  inboxBtn.classList.toggle('hidden', !isAdmin);
}

function updateFab(){
  const fab = $('fabAdmin');
  if (isAdmin){
    fab.textContent = '👑';
    fab.style.background = 'linear-gradient(135deg,#16a34a,#22c55e)';
    fab.title = 'Đang ở chế độ Admin (bấm để thoát)';
  } else {
    fab.textContent = '🔐';
    fab.style.background = 'linear-gradient(135deg,#1e293b,#334155)';
    fab.title = 'Quyền Admin';
  }
}

function updateInboxBadge(){
  const badge = $('inboxBadge');
  const unread = messages.filter(m => !m.read).length;
  if (unread > 0){
    badge.textContent = unread > 99 ? '99+' : unread;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/* ========== SUBSCRIBE FIREBASE ========== */
function subscribeWeeks(){
  const q = query(collection(db, 'weeks'), orderBy('order','asc'));
  onSnapshot(q, snap => {
    weeks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (view.screen === 'week' && view.weekId){
      const w = weeks.find(x => x.id === view.weekId);
      if (w) currentWeekData = w;
    }
    renderAll();
  }, err => console.error('weeks:', err));
}

function subscribeMessages(){
  const q = query(collection(db, 'messages'), orderBy('uploadedAt','desc'), limit(100));
  onSnapshot(q, snap => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateInboxBadge();
    if (document.querySelector('.inbox-modal')) renderInboxModal();
  }, err => console.error('messages:', err));
}

/* ========== RENDER CHÍNH ========== */
function renderAll(){
  updateHeader();
  updateFab();
  if (view.screen === 'home') renderHome();
  else if (view.screen === 'week') renderWeek();
  else if (view.screen === 'assignment') renderAssignment();
}

function renderHome(){
  const c = $('content');
  if (!weeks.length){
    c.innerHTML = `
      <div class="empty">
        <div class="empty-icon">📅</div>
        <h3>Chưa có tuần nào</h3>
        <p>${isAdmin ? 'Bấm "Tạo tuần" để bắt đầu.' : 'Vui lòng chờ admin tạo tuần.'}</p>
        ${isAdmin ? '<button class="btn primary" onclick="openCreateWeek()">+ Tạo tuần</button>' : ''}
      </div>`;
    return;
  }
  c.innerHTML = `
    ${isAdmin ? '<button class="btn primary" style="margin-bottom:16px" onclick="openCreateWeek()">+ Tạo tuần</button>' : ''}
    <div class="week-grid">
      ${weeks.map(w => `
        <div class="week-card" onclick="openWeek('${w.id}')">
          <div class="week-name">${esc(w.name)}</div>
          <div class="week-meta">${w.createdAt ? fmtDateTimeVN(w.createdAt) : ''}</div>
          ${isAdmin ? `<button class="week-delete"
            onclick="event.stopPropagation();deleteWeek('${w.id}','${esc(w.name)}')"
            title="Xóa tuần">🗑️</button>` : ''}
        </div>`).join('')}
    </div>`;
}

function renderWeek(){
  const c = $('content');
  if (!currentWeekData){
    c.innerHTML = '<div class="empty">Đang tải...</div>';
    return;
  }
  c.innerHTML = `
    ${isAdmin ? '<button class="btn primary" style="margin-bottom:16px" onclick="openCreateAssignment()">+ Tạo phân công</button>' : ''}
    ${currentAssignments.length === 0
      ? `<div class="empty"><div class="empty-icon">👥</div>
           <h3>Chưa có phân công</h3>
           <p>${isAdmin ? 'Bấm "Tạo phân công" để thêm.' : 'Chưa có dữ liệu.'}</p></div>`
      : `<div class="assign-grid">
           ${currentAssignments.map(a => assignmentCardHTML(a)).join('')}
         </div>`}`;
}

function assignmentCardHTML(a){
  const hasContent = DAYS.some(d => a[d]);
  return `
    <div class="assign-card" onclick="openAssignment('${a.id}')">
      <div class="assign-avatar">${esc(initials(a.studentName))}</div>
      <div class="assign-info">
        <div class="assign-name">${esc(a.studentName)}</div>
        <div class="assign-meta">${hasContent ? 'Đã có lịch trực' : 'Chưa có lịch'}</div>
      </div>
      ${isAdmin ? `<button class="assign-delete"
        onclick="event.stopPropagation();deleteAssignment('${a.id}','${esc(a.studentName)}')"
        title="Xóa">🗑️</button>` : ''}
    </div>`;
}

function renderAssignment(){
  const c = $('content');
  if (!currentAssignmentData){
    c.innerHTML = '<div class="empty">Đang tải...</div>';
    return;
  }
  c.innerHTML = `<div class="day-grid">
    ${DAYS.map(d => dayCardHTML(d, currentAssignmentData[d])).join('')}
  </div>`;
}

function dayCardHTML(day, content){
  const photos = currentPhotos.filter(p => p.day === day);
  const canUpload = photos.length < MAX_PHOTOS_PER_DAY;

  return `
    <div class="day-card">
      <div class="day-head">
        <div class="day-name">${DAY_LABEL[day]}</div>
        <div class="day-count">${photos.length}/${MAX_PHOTOS_PER_DAY} ảnh</div>
      </div>
      <div class="day-content">${
        content ? esc(content) : '<span class="empty-text">Không có nội dung</span>'
      }</div>
      <div class="photo-grid">
        ${photos.map(p => `
          <div class="photo-item">
            <img src="${p.dataUrl}" onclick="openPhotoView('${p.id}')" loading="lazy"/>
            ${isAdmin ? `<button class="photo-del"
              onclick="event.stopPropagation();deletePhoto('${p.id}')"
              title="Xóa ảnh">✕</button>` : ''}
            ${isAdmin ? `<div class="photo-time">${fmtDateTimeVN(p.uploadedAt)}</div>` : ''}
          </div>`).join('')}
        ${canUpload ? `<button class="photo-add"
          onclick="triggerCamera('${day}')" title="Chụp ảnh"><span>+</span></button>` : ''}
      </div>
    </div>`;
}

/* ========== NAVIGATION ========== */
window.openWeek = (weekId) => {
  const w = weeks.find(x => x.id === weekId);
  if (!w) return;
  currentWeekData = w;
  view = { screen:'week', weekId, assignmentId:null };
  renderWeek();

  if (window._weekUnsub) { window._weekUnsub(); window._weekUnsub = null; }
  const q = query(collection(db, 'assignments'), where('weekId','==',weekId));
  window._weekUnsub = onSnapshot(q, snap => {
    currentAssignments = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => (a.studentName||'').localeCompare(b.studentName||'', 'vi'));
    if (view.screen === 'week') renderWeek();
  }, err => { console.error(err); toast('❌ Lỗi tải: ' + err.message); });
};

window.openAssignment = (assignmentId) => {
  const a = currentAssignments.find(x => x.id === assignmentId);
  if (!a) return;
  currentAssignmentData = a;
  view = { screen:'assignment', weekId: a.weekId, assignmentId };
  currentPhotos = [];
  renderAssignment();

  if (window._assignUnsub) { window._assignUnsub(); window._assignUnsub = null; }
  if (window._photoUnsub) { window._photoUnsub(); window._photoUnsub = null; }

  window._assignUnsub = onSnapshot(doc(db, 'assignments', assignmentId), snap => {
    if (snap.exists()){
      currentAssignmentData = { id: snap.id, ...snap.data() };
      if (view.screen === 'assignment') renderAssignment();
    }
  });

  const pq = query(collection(db, 'photos'), where('assignmentId','==',assignmentId));
  window._photoUnsub = onSnapshot(pq, snap => {
    currentPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a,b) => {
        const ta = a.uploadedAt?.toMillis?.() || 0;
        const tb = b.uploadedAt?.toMillis?.() || 0;
        return ta - tb;
      });
    if (view.screen === 'assignment') renderAssignment();
  });
};

$('backBtn').onclick = () => {
  if (view.screen === 'assignment'){
    if (window._assignUnsub) { window._assignUnsub(); window._assignUnsub = null; }
    if (window._photoUnsub) { window._photoUnsub(); window._photoUnsub = null; }
    currentPhotos = [];
    view = { screen:'week', weekId: view.weekId, assignmentId:null };
    renderWeek();
  } else if (view.screen === 'week'){
    if (window._weekUnsub) { window._weekUnsub(); window._weekUnsub = null; }
    currentAssignments = [];
    currentWeekData = null;
    view = { screen:'home', weekId:null, assignmentId:null };
    renderHome();
    updateHeader();
  }
};

/* ========== ADMIN ========== */
$('fabAdmin').onclick = () => {
  if (isAdmin){
    if (confirm('Thoát chế độ Admin?')){ isAdmin = false; toast('Đã thoát Admin'); renderAll(); }
    return;
  }
  const pw = prompt('Nhập mật khẩu Admin:');
  if (pw === null) return;
  if (pw === ADMIN_PASSWORD){ isAdmin = true; toast('✅ Đã vào Admin'); renderAll(); }
  else toast('❌ Sai mật khẩu');
};

/* ========== TẠO TUẦN ========== */
window.openCreateWeek = () => {
  const suggested = `Tuần ${weeks.length + 1}`;
  openModal({
    title: '📅 Tạo tuần mới',
    body: `
      <div class="field"><label>Tên tuần</label>
        <input id="w-name" value="${esc(suggested)}" autocomplete="off"/></div>
      <div class="field"><label>Thứ tự (số)</label>
        <input id="w-order" type="number" value="${weeks.length + 1}" min="1"/></div>
    `,
    footer: `<button class="btn ghost" onclick="closeModal()">Hủy</button>
             <button class="btn primary" id="btnCreateWeek">Tạo</button>`
  });
  setTimeout(() => $('w-name')?.focus(), 50);
  $('btnCreateWeek').onclick = async () => {
    const name = $('w-name').value.trim();
    const order = parseInt($('w-order').value) || (weeks.length + 1);
    if (!name){ toast('⚠️ Nhập tên tuần'); return; }
    try {
      await addDoc(collection(db, 'weeks'), { name, order, createdAt: serverTimestamp() });
      toast('✅ Đã tạo tuần');
      closeModal();
    } catch(e){ toast('❌ Lỗi: ' + e.message); }
  };
};

window.deleteWeek = async (weekId, name) => {
  if (!confirm(`Xóa "${name}"?\n\nTất cả phân công và ảnh của tuần này sẽ bị xóa vĩnh viễn.`)) return;
  toast('⏳ Đang xóa...');
  try {
    const assignSnap = await getDocs(query(collection(db, 'assignments'), where('weekId','==',weekId)));
    for (const d of assignSnap.docs){
      const photoSnap = await getDocs(query(collection(db, 'photos'), where('assignmentId','==',d.id)));
      for (const p of photoSnap.docs){
        await deleteDoc(doc(db, 'photos', p.id));
      }
      await deleteDoc(doc(db, 'assignments', d.id));
    }
    await deleteDoc(doc(db, 'weeks', weekId));
    toast('🗑️ Đã xóa tuần');
  } catch(e){ toast('❌ Lỗi: ' + e.message); }
};

/* ========== TẠO PHÂN CÔNG ========== */
window.openCreateAssignment = () => {
  openModal({
    title: '👤 Tạo phân công',
    wide: true,
    body: `
      <div class="field"><label>Tên học sinh *</label>
        <input id="a-name" placeholder="Nguyễn Văn A" autocomplete="off"/></div>
      ${DAYS.map(d => `
        <div class="field"><label>${DAY_LABEL[d]}</label>
          <input id="a-${d}" placeholder="Nội dung trực..." autocomplete="off"/></div>
      `).join('')}
    `,
    footer: `<button class="btn ghost" onclick="closeModal()">Hủy</button>
             <button class="btn primary" id="btnCreateAssign">Tạo</button>`
  });
  setTimeout(() => $('a-name')?.focus(), 50);
  $('btnCreateAssign').onclick = async () => {
    const name = $('a-name').value.trim();
    if (!name){ toast('⚠️ Nhập tên học sinh'); return; }
    const data = { weekId: view.weekId, studentName: name, createdAt: serverTimestamp() };
    DAYS.forEach(d => data[d] = $('a-' + d).value.trim());
    try {
      await addDoc(collection(db, 'assignments'), data);
      toast('✅ Đã tạo phân công');
      closeModal();
    } catch(e){ toast('❌ Lỗi: ' + e.message); }
  };
};

window.deleteAssignment = async (id, name) => {
  if (!confirm(`Xóa phân công của "${name}"?`)) return;
  try {
    const photoSnap = await getDocs(query(collection(db, 'photos'), where('assignmentId','==',id)));
    for (const p of photoSnap.docs){
      await deleteDoc(doc(db, 'photos', p.id));
    }
    await deleteDoc(doc(db, 'assignments', id));
    toast('🗑️ Đã xóa');
  } catch(e){ toast('❌ Lỗi: ' + e.message); }
};

/* ========== CHỤP ẢNH ========== */
window.triggerCamera = (day) => {
  pendingDay = day;
  let input = $('cameraInput');
  if (!input){
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.id = 'cameraInput';
    input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = handleCameraFile;
  input.click();
};

async function handleCameraFile(e){
  const file = e.target.files?.[0];
  if (!file || !pendingDay) return;
  const day = pendingDay;
  pendingDay = null;

  const current = currentPhotos.filter(p => p.day === day).length;
  if (current >= MAX_PHOTOS_PER_DAY){
    toast(`⚠️ ${DAY_LABEL[day]} đã đủ ${MAX_PHOTOS_PER_DAY} ảnh`);
    return;
  }

  toast('⏳ Đang nén ảnh...');
  try {
    const dataUrl = await compressToDataURL(file, IMG_MAX_SIZE, IMG_QUALITY);
    const sizeBytes = Math.round((dataUrl.length * 3) / 4);
    console.log('Ảnh sau nén:', bytesToMB(sizeBytes));

    if (sizeBytes > 900 * 1024){
      toast('⚠️ Ảnh còn quá lớn, thử lại với ảnh khác');
      return;
    }

    const assignmentId = view.assignmentId;
    const weekId = view.weekId;
    const studentName = currentAssignmentData.studentName;
    const weekName = currentWeekData.name;

    toast('⏳ Đang tải lên...');

    await addDoc(collection(db, 'photos'), {
      weekId, assignmentId, day,
      dataUrl,
      sizeBytes,
      uploadedAt: serverTimestamp()
    });

    await addDoc(collection(db, 'messages'), {
      type: 'photo_upload',
      weekId, weekName, assignmentId, studentName, day,
      photoPreview: dataUrl.slice(0, 2000),
      uploadedAt: serverTimestamp(),
      read: false
    });

    toast('✅ Đã tải ảnh lên');
  } catch(err){
    console.error(err);
    toast('❌ Lỗi: ' + err.message);
  }
}

/* Nén ảnh thành Base64 data URL */
function compressToDataURL(file, maxSize, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize){
          height = Math.round(height * maxSize / width); width = maxSize;
        } else if (height > maxSize){
          width = Math.round(width * maxSize / height); height = maxSize;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve(dataUrl);
      };
      img.onerror = () => reject(new Error('Không đọc được ảnh'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

window.deletePhoto = async (photoId) => {
  if (!confirm('Xóa ảnh này?')) return;
  try {
    await deleteDoc(doc(db, 'photos', photoId));
    toast('🗑️ Đã xóa ảnh');
  } catch(e){ toast('❌ Lỗi: ' + e.message); }
};

window.openPhotoView = (photoId) => {
  const p = currentPhotos.find(x => x.id === photoId);
  if (!p) return;
  openModal({
    title: '📷 Ảnh',
    wide: true,
    body: `
      <img src="${p.dataUrl}" style="width:100%;border-radius:10px"/>
      ${isAdmin ? `<div style="margin-top:12px;font-size:13.5px;color:var(--muted);text-align:center">
        Tải lên lúc: <b>${fmtDateTimeVN(p.uploadedAt)}</b> (GMT+7)
        ${p.sizeBytes ? `<br>Dung lượng: ${bytesToMB(p.sizeBytes)}` : ''}</div>` : ''}
    `,
    footer: isAdmin ? `
      <a class="btn ghost" href="${p.dataUrl}" download="truc_${p.id}.jpg">⬇️ Tải về</a>
      <button class="btn danger"
        onclick="closeModal();deletePhoto('${p.id}')">🗑️ Xóa</button>
    ` : `<button class="btn ghost" onclick="closeModal()">Đóng</button>`
  });
};

/* ========== HỘP THƯ ========== */
$('inboxBtn').onclick = () => {
  openModal({
    title: '📬 Hộp thư',
    wide: true,
    body: '<div class="inbox-modal">Đang tải...</div>',
    onOpen: renderInboxModal
  });
};

function renderInboxModal(){
  const box = document.querySelector('.inbox-modal');
  if (!box) return;
  if (!messages.length){
    box.innerHTML = `<div class="empty" style="padding:30px 10px">
      <div class="empty-icon">📭</div><h3>Hộp thư trống</h3>
      <p>Chưa có thông báo nào.</p></div>`;
    return;
  }
  box.innerHTML = messages.map(m => `
    <div class="inbox-item ${m.read ? '' : 'unread'}" data-id="${m.id}">
      <div class="inbox-icon">📷</div>
      <div class="inbox-body">
        <div class="inbox-title"><b>${esc(m.studentName)}</b> đã tải ảnh lên</div>
        <div class="inbox-sub">${esc(m.weekName || '')} · ${DAY_LABEL[m.day] || m.day} · ${fmtRelativeVN(m.uploadedAt)}</div>
        <div class="inbox-time">${fmtDateTimeVN(m.uploadedAt)} (GMT+7)</div>
      </div>
    </div>`).join('');

  box.querySelectorAll('.inbox-item').forEach(el => {
    el.onclick = async () => {
      try { await updateDoc(doc(db, 'messages', el.dataset.id), { read: true }); } catch(e){}
    };
  });
}

/* ========== KHỞI ĐỘNG ========== */
subscribeWeeks();
subscribeMessages();
renderAll();