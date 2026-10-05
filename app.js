import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore, collection, doc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, getDocs, serverTimestamp, limit
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ========== FIREBASE CONFIG ========== */
const firebaseConfig = {
  apiKey: "AIzaSyCYwWT5iIRCEkjHGA_YmZ80brKr5bu-Gp0",
  authDomain: "phancongtruc-e5fb6.firebaseapp.com",
  projectId: "phancongtruc-e5fb6",
  storageBucket: "phancongtruc-e5fb6.firebasestorage.app",
  messagingSenderId: "542899039872",
  appId: "1:542899039872:web:ad4f30b61fbac633710065"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

/* ========== CONSTANTS ========== */
const ADMIN_PASSWORD = "13579";
const DAYS = ['mon','tue','wed','thu','fri','sat'];
const DAY_LABEL = { mon:'Thứ 2', tue:'Thứ 3', wed:'Thứ 4', thu:'Thứ 5', fri:'Thứ 6', sat:'Thứ 7' };
const DAY_INDEX = { mon:0, tue:1, wed:2, thu:3, fri:4, sat:5 };
const MAX_PHOTOS_PER_DAY = 5;
const MAX_CONFESS_IMAGES = 5;

/* Ảnh trực nhật */
const IMG_MAX_SIZE = 900;
const IMG_QUALITY = 0.55;
const IMG_MAX_BYTES = 700 * 1024;

/* Ảnh mách lẻo (nhiều ảnh hơn → nén mạnh hơn) */
const CONFESS_IMG_MAX_SIZE = 700;
const CONFESS_IMG_QUALITY = 0.45;
const CONFESS_IMG_MAX_BYTES = 180 * 1024;
const CONFESS_TOTAL_MAX_BYTES = 900 * 1024;

/* ========== STATE ========== */
let isAdmin = false;
let weeks = [];
let messages = [];
let confesses = [];
let view = { screen: 'home', weekId: null, assignmentId: null };
let currentWeekData = null;
let currentAssignments = [];
let currentAssignmentData = null;
let currentPhotos = [];
let pendingDay = null;
let confessImages = []; // danh sách dataUrl đang chọn trong form

let weekUnsub = null;
let assignUnsub = null;
let photoUnsub = null;

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
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
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
  if (diff < 604800) return Math.floor(diff/86400) + ' ngày trước';
  return fmtDateTimeVN(ts);
}
function initials(name){
  const parts = String(name || '?').trim().split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length-1][0]
                            : parts[0].slice(0,2)).toUpperCase();
}
function bytesToStr(b){
  if (b < 1024) return b + ' B';
  if (b < 1024*1024) return (b/1024).toFixed(1) + ' KB';
  return (b/(1024*1024)).toFixed(2) + ' MB';
}
function todayISO(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function addDaysISO(iso, days){
  if (!iso) return '';
  const [y,m,d] = iso.split('-').map(Number);
  const date = new Date(y, m-1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function fmtDateShort(iso){
  if (!iso) return '';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}`;
}

/* Tính deadline (Date object) cho 1 ngày cụ thể trong tuần
   Trả về null nếu ngày đó không có deadline */
function getDeadlineDate(week, day, deadlineStr){
  if (!deadlineStr || !week?.startDate) return null;
  const offset = DAY_INDEX[day];
  const dayISO = addDaysISO(week.startDate, offset);
  const [y,m,d] = dayISO.split('-').map(Number);
  const [h,mi] = deadlineStr.split(':').map(Number);
  return new Date(y, m-1, d, h, mi, 0, 0);
}

/* Đánh giá trạng thái 1 ngày:
   - null: không có deadline
   - 'ontime': có ít nhất 1 ảnh upload trước deadline
   - 'late': có ảnh nhưng ảnh đầu tiên sau deadline
   - 'absent': quá deadline + 10 phút mà chưa có ảnh nào
   - 'pending': chưa tới deadline + 10 phút, chưa có ảnh
   - 'empty': có deadline nhưng chưa tới giờ, chưa có ảnh (giống pending)
*/
function evaluateDay(week, day, deadlineStr, photos){
  if (!deadlineStr) return null;
  const deadline = getDeadlineDate(week, day, deadlineStr);
  if (!deadline) return null;

  const grace = new Date(deadline.getTime() + 10*60*1000);
  const now = new Date();

  if (photos.length > 0){
    // Lấy ảnh sớm nhất
    const firstPhoto = photos
      .map(p => p.uploadedAt?.toDate?.() || null)
      .filter(Boolean)
      .sort((a,b) => a - b)[0];
    if (!firstPhoto) return 'ontime';
    if (firstPhoto <= deadline) return 'ontime';
    return 'late';
  }

  // Chưa có ảnh
  if (now > grace) return 'absent';
  return 'pending';
}

function statusInfo(status){
  if (status === 'ontime') return { cls:'ontime', text:'🟢 Đúng giờ' };
  if (status === 'late') return { cls:'late', text:'🟡 Trễ' };
  if (status === 'absent') return { cls:'absent', text:'🔴 Không lao động' };
  if (status === 'pending') return { cls:'pending', text:'⚪ Chưa nộp' };
  return null;
}

/* ========== MODAL ========== */
function openModal({ title, body, footer, wide, onOpen }){
  history.pushState({ ...(history.state || {}), _modal: true }, '');

  $('modalRoot').innerHTML = `
    <div class="modal-overlay" id="overlay">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <h2>${title}</h2>
          <button class="icon-btn" id="modalClose" aria-label="Đóng">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
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
  if (!document.querySelector('.modal-overlay')) return;
  if (history.state?._modal){
    history.back();
    return;
  }
  $('modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escHandler);
}
function escHandler(e){ if (e.key === 'Escape') closeModal(); }
window.closeModal = closeModal;

/* ========== HEADER / FAB / BREADCRUMB ========== */
function updateHeader(){
  const backBtn = $('backBtn');
  const title = $('pageTitle');
  const bc = $('breadcrumb');
  const inboxBtn = $('inboxBtn');
  const confessBtn = $('confessBtn');

  backBtn.classList.toggle('hidden', view.screen === 'home');

  if (view.screen === 'home'){
    title.textContent = 'Phân Công Trực Nhật';
    confessBtn.classList.add('hidden');
  } else if (view.screen === 'week'){
    title.textContent = currentWeekData ? currentWeekData.name : 'Tuần';
    confessBtn.classList.remove('hidden');
  } else if (view.screen === 'assignment'){
    title.textContent = currentAssignmentData ? currentAssignmentData.studentName : 'Chi tiết';
    confessBtn.classList.remove('hidden');
  } else if (view.screen === 'confess'){
    title.textContent = '🚨 Mách lẻo';
    confessBtn.classList.add('hidden');
  }

  if (view.screen === 'home'){
    bc.classList.add('hidden');
  } else if (view.screen === 'week'){
    bc.classList.remove('hidden');
    bc.innerHTML = `<span>Trang chủ</span><span class="sep">›</span><span class="current">${esc(currentWeekData?.name || '...')}</span>`;
  } else if (view.screen === 'assignment'){
    bc.classList.remove('hidden');
    bc.innerHTML = `<span>Trang chủ</span><span class="sep">›</span><span>${esc(currentWeekData?.name || '...')}</span><span class="sep">›</span><span class="current">${esc(currentAssignmentData?.studentName || '...')}</span>`;
  } else if (view.screen === 'confess'){
    bc.classList.remove('hidden');
    bc.innerHTML = `<span>Trang chủ</span><span class="sep">›</span><span class="current">Mách lẻo</span>`;
  }

  inboxBtn.classList.toggle('hidden', !isAdmin);
}

function updateFab(){
  const fabAdmin = $('fabAdmin');
  const fabConfess = $('fabConfess');

  if (isAdmin){
    fabAdmin.classList.add('admin');
    fabAdmin.title = 'Đang ở chế độ Admin (bấm để thoát)';
    fabAdmin.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/>
      <path d="M5 20h14"/>
    </svg>`;
  } else {
    fabAdmin.classList.remove('admin');
    fabAdmin.title = 'Quyền Admin';
    fabAdmin.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>`;
  }

  // FAB mách lẻo chỉ hiện khi ở trang chủ, hoặc ẩn khi đã ở trang mách lẻo
  if (view.screen === 'confess'){
    fabConfess.classList.add('hidden');
  } else {
    fabConfess.classList.remove('hidden');
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

/* ========== NAVIGATION ========== */
function cleanupSubs(){
  if (weekUnsub){ weekUnsub(); weekUnsub = null; }
  if (assignUnsub){ assignUnsub(); assignUnsub = null; }
  if (photoUnsub){ photoUnsub(); photoUnsub = null; }
}

function navigate(screen, params = {}, push = true){
  cleanupSubs();
  const newState = { screen, ...params };
  if (push) history.pushState(newState, '');
  applyState(newState);
}

function applyState(state){
  view = state;

  if (state.screen === 'home'){
    currentWeekData = null;
    currentAssignments = [];
    currentAssignmentData = null;
    currentPhotos = [];
  } else if (state.screen === 'week'){
    currentAssignments = [];
    currentAssignmentData = null;
    currentPhotos = [];
  } else if (state.screen === 'assignment'){
    currentPhotos = [];
  }

  renderScreen();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderScreen(){
  updateHeader();
  updateFab();
  updateInboxBadge();

  if (view.screen === 'home'){
    renderHome();
  } else if (view.screen === 'week'){
    const w = weeks.find(x => x.id === view.weekId);
    if (w) currentWeekData = w;
    renderWeek();
    const q = query(collection(db, 'assignments'), where('weekId','==',view.weekId));
    weekUnsub = onSnapshot(q, snap => {
      currentAssignments = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a,b) => (a.studentName||'').localeCompare(b.studentName||'', 'vi'));
      if (view.screen === 'week') renderWeek();
    }, err => { console.error(err); toast('❌ Lỗi tải: ' + err.message); });
  } else if (view.screen === 'assignment'){
    const a = currentAssignments.find(x => x.id === view.assignmentId);
    if (a) currentAssignmentData = a;
    renderAssignment();
    assignUnsub = onSnapshot(doc(db, 'assignments', view.assignmentId), snap => {
      if (snap.exists()){
        currentAssignmentData = { id: snap.id, ...snap.data() };
        if (view.screen === 'assignment') { renderAssignment(); updateHeader(); }
      }
    });
    const pq = query(collection(db, 'photos'), where('assignmentId','==',view.assignmentId));
    photoUnsub = onSnapshot(pq, snap => {
      currentPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a,b) => {
          const ta = a.uploadedAt?.toMillis?.() || 0;
          const tb = b.uploadedAt?.toMillis?.() || 0;
          return ta - tb;
        });
      if (view.screen === 'assignment') renderAssignment();
    });
  } else if (view.screen === 'confess'){
    renderConfessScreen();
  }
}

window.openWeek = (weekId) => {
  navigate('week', { weekId, assignmentId: null });
};
window.openAssignment = (assignmentId) => {
  navigate('assignment', { weekId: view.weekId, assignmentId });
};
window.openConfess = () => {
  navigate('confess', {});
};

$('backBtn').onclick = () => history.back();

window.addEventListener('popstate', (e) => {
  const state = e.state || { screen: 'home', weekId: null, assignmentId: null };

  if (document.querySelector('.modal-overlay')){
    $('modalRoot').innerHTML = '';
    document.removeEventListener('keydown', escHandler);
    if (state._modal){
      history.pushState(state, '');
      return;
    }
  }

  if (state._modal) return;

  cleanupSubs();
  applyState(state);
});

/* ========== SUBSCRIBE FIREBASE ========== */
function subscribeWeeks(){
  const q = query(collection(db, 'weeks'), orderBy('order','asc'));
  onSnapshot(q, snap => {
    weeks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (view.screen === 'week' && view.weekId){
      const w = weeks.find(x => x.id === view.weekId);
      if (w) { currentWeekData = w; updateHeader(); if (view.screen === 'week') renderWeek(); }
    }
    if (view.screen === 'home') renderHome();
    if (view.screen === 'assignment' && currentAssignmentData){
      // Cập nhật week info cho assignment
      const w = weeks.find(x => x.id === currentAssignmentData.weekId);
      if (w) { currentWeekData = w; renderAssignment(); }
    }
  }, err => console.error('weeks:', err));
}

function subscribeMessages(){
  const q = query(collection(db, 'messages'), orderBy('uploadedAt','desc'), limit(200));
  onSnapshot(q, snap => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateInboxBadge();
    if (document.querySelector('.inbox-modal')) renderInboxModal();
  }, err => console.error('messages:', err));
}

function subscribeConfesses(){
  const q = query(collection(db, 'confesses'), orderBy('createdAt','desc'), limit(200));
  onSnapshot(q, snap => {
    confesses = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (view.screen === 'confess') renderConfessScreen();
  }, err => console.error('confesses:', err));
}

/* ========== RENDER: HOME ========== */
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
    ${isAdmin ? `<div class="section-head">
      <div class="section-title">Danh sách tuần</div>
      <button class="btn primary" onclick="openCreateWeek()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Tạo tuần
      </button>
    </div>` : ''}
    <div class="week-grid">
      ${weeks.map(w => `
        <div class="week-card" onclick="openWeek('${w.id}')">
          <div class="week-icon">📅</div>
          <div class="week-name">${esc(w.name)}</div>
          <div class="week-meta">${w.startDate ? 'Bắt đầu ' + fmtDateShort(w.startDate) : (w.createdAt ? fmtDateTimeVN(w.createdAt) : 'Mới tạo')}</div>
          ${isAdmin ? `<button class="week-delete"
            onclick="event.stopPropagation();deleteWeek('${w.id}','${esc(w.name)}')"
            title="Xóa tuần">✕</button>` : ''}
        </div>`).join('')}
    </div>

    <div class="section-head" style="margin-top:24px">
      <div class="section-title">Mách lẻo</div>
      <button class="btn pink" onclick="openConfess()">
        Xem tất cả →
      </button>
    </div>
    ${renderConfessPreview()}
  `;
}

function renderConfessPreview(){
  if (!confesses.length){
    return `<div class="empty" style="padding:30px 16px">
      <div class="empty-icon" style="font-size:36px">🚨</div>
      <h3 style="font-size:15px">Chưa có mách lẻo nào</h3>
      <p style="font-size:13px">Bấm nút <b style="color:#ec4899">+</b> ở góc dưới để đăng bài đầu tiên.</p>
    </div>`;
  }
  const preview = confesses.slice(0, 2);
  return `<div>${preview.map(c => confessCardHTML(c, true)).join('')}</div>`;
}

/* ========== RENDER: WEEK ========== */
function renderWeek(){
  const c = $('content');
  if (!currentWeekData){
    c.innerHTML = `<div class="empty"><div class="empty-icon">⏳</div><h3>Đang tải...</h3></div>`;
    return;
  }
  c.innerHTML = `
    ${isAdmin ? `<div class="section-head">
      <div class="section-title">${esc(currentWeekData.name)}</div>
      <button class="btn primary" onclick="openCreateAssignment()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Phân công
      </button>
    </div>` : ''}
    ${currentAssignments.length === 0
      ? `<div class="empty">
           <div class="empty-icon">👥</div>
           <h3>Chưa có phân công</h3>
           <p>${isAdmin ? 'Bấm "Phân công" để thêm học sinh.' : 'Chưa có dữ liệu. Vui lòng chờ admin.'}</p>
           ${isAdmin ? '<button class="btn primary" onclick="openCreateAssignment()">+ Tạo phân công</button>' : ''}
         </div>`
      : `<div class="assign-grid">
           ${currentAssignments.map(a => assignmentCardHTML(a)).join('')}
         </div>`}`;
}

function assignmentCardHTML(a){
  const hasContent = DAYS.some(d => a[d]);
  const hasDeadline = a.deadlines && Object.values(a.deadlines).some(v => v);
  return `
    <div class="assign-card" onclick="openAssignment('${a.id}')">
      <div class="assign-avatar">${esc(initials(a.studentName))}</div>
      <div class="assign-info">
        <div class="assign-name">${esc(a.studentName)}</div>
        <div class="assign-meta">
          ${hasContent ? '📌 Đã có lịch trực' : 'Chưa có lịch'}
          ${hasDeadline ? ' · ⏰' : ''}
        </div>
      </div>
      ${isAdmin ? `<button class="assign-delete"
        onclick="event.stopPropagation();deleteAssignment('${a.id}','${esc(a.studentName)}')"
        title="Xóa">✕</button>` : ''}
    </div>`;
}

/* ========== RENDER: ASSIGNMENT ========== */
function renderAssignment(){
  const c = $('content');
  if (!currentAssignmentData || !currentWeekData){
    c.innerHTML = `<div class="empty"><div class="empty-icon">⏳</div><h3>Đang tải...</h3></div>`;
    return;
  }
  c.innerHTML = `<div class="day-grid">
    ${DAYS.map(d => dayCardHTML(d)).join('')}
  </div>`;
}

function dayCardHTML(day){
  const content = currentAssignmentData[day] || '';
  const deadline = (currentAssignmentData.deadlines || {})[day] || '';
  const photos = currentPhotos.filter(p => p.day === day);
  const canUpload = photos.length < MAX_PHOTOS_PER_DAY;
  const isFull = photos.length >= MAX_PHOTOS_PER_DAY;

  const status = evaluateDay(currentWeekData, day, deadline, photos);
  const info = statusInfo(status);

  return `
    <div class="day-card">
      <div class="day-head">
        <div class="day-name">${DAY_LABEL[day]}</div>
        <div class="day-meta">
          ${deadline ? `<span class="day-deadline">🕐 ${esc(deadline)}</span>` : ''}
          ${info ? `<span class="day-status ${info.cls}">${info.text}</span>` : ''}
          <span class="day-count ${isFull ? 'full' : ''}">${photos.length}/${MAX_PHOTOS_PER_DAY}</span>
        </div>
      </div>
      <div class="day-content">${
        content ? esc(content) : '<span class="empty-text">Không có nội dung</span>'
      }</div>
      <div class="photo-grid">
        ${photos.map(p => `
          <div class="photo-item">
            <img src="${p.dataUrl}" onclick="openPhotoView('${p.id}')" loading="lazy" alt="Ảnh trực nhật"/>
            ${isAdmin ? `<button class="photo-del"
              onclick="event.stopPropagation();deletePhoto('${p.id}')"
              title="Xóa ảnh">✕</button>` : ''}
            ${isAdmin ? `<div class="photo-time">${fmtDateTimeVN(p.uploadedAt)}</div>` : ''}
          </div>`).join('')}
        ${canUpload ? `<button class="photo-add"
          onclick="triggerCamera('${day}')" title="Chụp ảnh">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
        </button>` : ''}
      </div>
    </div>`;
}

/* ========== RENDER: CONFESS ========== */
function renderConfessScreen(){
  const c = $('content');
  c.innerHTML = `
    <div class="section-head">
      <div class="section-title">Bảng mách lẻo</div>
      <button class="btn pink" onclick="openCreateConfess()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Đăng bài
      </button>
    </div>
    ${!confesses.length
      ? `<div class="empty">
           <div class="empty-icon">🚨</div>
           <h3>Chưa có mách lẻo nào</h3>
           <p>Hãy là người đầu tiên đăng bài!</p>
           <button class="btn pink" onclick="openCreateConfess()">+ Đăng mách lẻo</button>
         </div>`
      : confesses.map(c => confessCardHTML(c)).join('')}
  `;
}

function confessCardHTML(conf, isPreview){
  const anon = conf.anonymous;
  const author = anon ? 'Ẩn danh' : (conf.author || 'Ẩn danh');
  const imgs = conf.images || [];
  const imgsCount = imgs.length;
  const canDelete = isAdmin;
  const timeStr = conf.createdAt ? fmtRelativeVN(conf.createdAt) : '';

  return `
    <div class="confess-card">
      <div class="confess-head">
        <div class="confess-avatar ${anon ? 'anon' : ''}">${esc(initials(author))}</div>
        <div class="confess-meta">
          <div class="confess-author">${esc(author)}</div>
          <div class="confess-time">🕐 ${timeStr}${isAdmin && conf.createdAt ? ' · ' + fmtDateTimeVN(conf.createdAt) : ''}</div>
        </div>
        ${canDelete ? `<button class="confess-delete" title="Xóa bài"
          onclick="deleteConfess('${conf.id}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>` : ''}
      </div>
      ${conf.content ? `<div class="confess-body">${esc(conf.content)}</div>` : ''}
      ${imgsCount ? `
        <div class="confess-images count-${imgsCount}">
          ${imgs.map((src, i) => `<img src="${src}" onclick="openConfessPhoto('${conf.id}',${i})" loading="lazy" alt="Ảnh"/>`).join('')}
        </div>
      ` : ''}
    </div>`;
}

window.openConfessPhoto = (confId, idx) => {
  const conf = confesses.find(x => x.id === confId);
  if (!conf) return;
  const src = conf.images[idx];
  if (!src) return;
  openModal({
    title: '📷 Ảnh',
    wide: true,
    body: `<img src="${src}" style="width:100%;border-radius:14px"/>`,
    footer: `
      <a class="btn ghost" href="${src}" download="anh_${confId}_${idx}.jpg">⬇️ Tải về</a>
      <button class="btn ghost" onclick="closeModal()">Đóng</button>
    `
  });
};

/* ========== ADMIN LOGIN ========== */
$('fabAdmin').onclick = () => {
  if (isAdmin){
    if (confirm('Thoát chế độ Admin?')){
      isAdmin = false;
      toast('Đã thoát Admin');
      renderScreen();
    }
    return;
  }
  const pw = prompt('Nhập mật khẩu Admin:');
  if (pw === null) return;
  if (pw === ADMIN_PASSWORD){
    isAdmin = true;
    toast('✅ Đã vào chế độ Admin');
    renderScreen();
  } else {
    toast('❌ Sai mật khẩu');
  }
};

/* ========== TẠO TUẦN ========== */
window.openCreateWeek = () => {
  const suggested = `Tuần ${weeks.length + 1}`;
  openModal({
    title: '📅 Tạo tuần mới',
    body: `
      <div class="hint">
        💡 <b>Ngày bắt đầu tuần</b> là ngày <b>Thứ 2</b> của tuần đó.
        Hệ thống dùng ngày này để tính deadline cho từng ngày T2→T7.
      </div>
      <div class="field">
        <label>Tên tuần</label>
        <input id="w-name" value="${esc(suggested)}" autocomplete="off" placeholder="VD: Tuần 1"/>
      </div>
      <div class="field">
        <label>Ngày thứ 2 của tuần</label>
        <input id="w-start" type="date" value="${todayISO()}"/>
      </div>
      <div class="field">
        <label>Thứ tự (số càng nhỏ càng lên đầu)</label>
        <input id="w-order" type="number" value="${weeks.length + 1}" min="1"/>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="closeModal()">Hủy</button>
      <button class="btn primary" id="btnCreateWeek">Tạo tuần</button>
    `
  });
  setTimeout(() => $('w-name')?.focus(), 100);
  $('btnCreateWeek').onclick = async () => {
    const name = $('w-name').value.trim();
    const startDate = $('w-start').value;
    const order = parseInt($('w-order').value) || (weeks.length + 1);
    if (!name){ toast('⚠️ Nhập tên tuần'); return; }
    if (!startDate){ toast('⚠️ Chọn ngày thứ 2 của tuần'); return; }
    try {
      await addDoc(collection(db, 'weeks'), { name, startDate, order, createdAt: serverTimestamp() });
      toast('✅ Đã tạo tuần');
      closeModal();
    } catch(e){ toast('❌ Lỗi: ' + e.message); }
  };
};

window.deleteWeek = async (weekId, name) => {
  if (!confirm(`Xóa "${name}"?\n\nTất cả phân công, ảnh và mách lẻo liên quan sẽ bị xóa vĩnh viễn.`)) return;
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
    const msgSnap = await getDocs(query(collection(db, 'messages'), where('weekId','==',weekId)));
    for (const m of msgSnap.docs){
      await deleteDoc(doc(db, 'messages', m.id));
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
      <div class="hint">
        🕐 <b>Deadline không bắt buộc</b> — để trống nếu ngày đó không cần đánh giá.
        Nếu điền, hệ thống sẽ đánh giá: <b>đúng giờ</b> / <b>trễ</b> / <b>không lao động</b> (quá giờ + 10 phút mà chưa nộp).
      </div>
      <div class="field">
        <label>Tên học sinh *</label>
        <input id="a-name" placeholder="VD: Nguyễn Văn A" autocomplete="off"/>
      </div>
      ${DAYS.map(d => `
        <div style="padding:12px;background:#fafbff;border:1px solid var(--border-soft);border-radius:12px;margin-bottom:10px">
          <div style="font-weight:800;font-size:13.5px;color:var(--primary-dark);margin-bottom:8px">
            ${DAY_LABEL[d]} ${currentWeekData?.startDate ? `<span style="color:var(--muted);font-weight:500;font-size:12px">· ${fmtDateShort(addDaysISO(currentWeekData.startDate, DAY_INDEX[d]))}</span>` : ''}
          </div>
          <div class="field" style="margin-bottom:8px">
            <label style="font-size:12px">Nội dung</label>
            <input id="a-${d}" placeholder="VD: Quét sân trường..." autocomplete="off"/>
          </div>
          <div class="field" style="margin-bottom:0">
            <label style="font-size:12px">Deadline (để trống = không đánh giá)</label>
            <input id="d-${d}" type="time" placeholder="hh:mm"/>
          </div>
        </div>
      `).join('')}
    `,
    footer: `
      <button class="btn ghost" onclick="closeModal()">Hủy</button>
      <button class="btn primary" id="btnCreateAssign">Tạo phân công</button>
    `
  });
  setTimeout(() => $('a-name')?.focus(), 100);
  $('btnCreateAssign').onclick = async () => {
    const name = $('a-name').value.trim();
    if (!name){ toast('⚠️ Nhập tên học sinh'); return; }
    const data = {
      weekId: view.weekId,
      studentName: name,
      createdAt: serverTimestamp(),
      deadlines: {}
    };
    DAYS.forEach(d => {
      data[d] = $('a-' + d).value.trim();
      const dl = $('d-' + d).value;
      if (dl) data.deadlines[d] = dl;
    });
    try {
      await addDoc(collection(db, 'assignments'), data);
      toast('✅ Đã tạo phân công');
      closeModal();
    } catch(e){ toast('❌ Lỗi: ' + e.message); }
  };
};

window.deleteAssignment = async (id, name) => {
  if (!confirm(`Xóa phân công của "${name}"?\n\nẢnh đã chụp cũng sẽ bị xóa.`)) return;
  try {
    const photoSnap = await getDocs(query(collection(db, 'photos'), where('assignmentId','==',id)));
    for (const p of photoSnap.docs){
      await deleteDoc(doc(db, 'photos', p.id));
    }
    await deleteDoc(doc(db, 'assignments', id));
    toast('🗑️ Đã xóa');
  } catch(e){ toast('❌ Lỗi: ' + e.message); }
};

/* ========== CHỤP ẢNH TRỰC NHẬT ========== */
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
    const { dataUrl, sizeBytes } = await compressToDataURL(file, IMG_MAX_SIZE, IMG_QUALITY, IMG_MAX_BYTES);
    console.log('Ảnh trực nhật:', bytesToStr(sizeBytes));

    if (sizeBytes > IMG_MAX_BYTES){
      toast('⚠️ Ảnh vẫn quá lớn, thử chụp lại');
      return;
    }

    const assignmentId = view.assignmentId;
    const weekId = view.weekId;
    const studentName = currentAssignmentData.studentName;
    const weekName = currentWeekData.name;

    toast('⏳ Đang tải lên...');

    await addDoc(collection(db, 'photos'), {
      weekId, assignmentId, day,
      dataUrl, sizeBytes,
      uploadedAt: serverTimestamp()
    });

    await addDoc(collection(db, 'messages'), {
      type: 'photo_upload',
      weekId, weekName, assignmentId, studentName, day,
      uploadedAt: serverTimestamp(),
      read: false
    });

    toast('✅ Đã tải ảnh lên');
  } catch(err){
    console.error(err);
    toast('❌ Lỗi: ' + err.message);
  }
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
    title: '📷 Ảnh trực nhật',
    wide: true,
    body: `
      <img src="${p.dataUrl}" style="width:100%;border-radius:14px"/>
      ${isAdmin ? `<div style="margin-top:14px;font-size:13.5px;color:var(--muted);text-align:center;font-weight:500">
        🕐 ${fmtDateTimeVN(p.uploadedAt)} (GMT+7)
        ${p.sizeBytes ? `<br>📦 ${bytesToStr(p.sizeBytes)}` : ''}
      </div>` : ''}
    `,
    footer: isAdmin ? `
      <a class="btn ghost" href="${p.dataUrl}" download="truc_${p.id}.jpg">⬇️ Tải về</a>
      <button class="btn danger" onclick="closeModal();setTimeout(()=>deletePhoto('${p.id}'),200)">🗑️ Xóa</button>
    ` : `<button class="btn ghost" onclick="closeModal()">Đóng</button>`
  });
};

/* ========== NÉN ẢNH ========== */
async function compressToDataURL(file, maxSize, quality, maxBytes){
  let s = maxSize, q = quality;
  let dataUrl = await _compressOnce(file, s, q);
  let sizeBytes = Math.round((dataUrl.length * 3) / 4);

  let attempts = 0;
  while (sizeBytes > maxBytes && attempts < 5){
    s = Math.round(s * 0.8);
    q = Math.max(0.3, q - 0.07);
    dataUrl = await _compressOnce(file, s, q);
    sizeBytes = Math.round((dataUrl.length * 3) / 4);
    attempts++;
  }
  return { dataUrl, sizeBytes };
}

function _compressOnce(file, maxSize, quality){
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
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('Không đọc được ảnh'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

/* ========== MÁCH LẺO — ĐĂNG BÀI ========== */
$('fabConfess').onclick = () => {
  openCreateConfess();
};

window.openCreateConfess = () => {
  confessImages = [];
  openModal({
    title: '🚨 Đăng mách lẻo',
    wide: true,
    body: `
      <div class="field">
        <label class="checkbox-label">
          <input type="checkbox" id="c-anon" checked/>
          <span>Ẩn danh (không hiện tên người đăng)</span>
        </label>
      </div>
      <div class="field" id="c-author-wrap" style="display:none">
        <label>Tên bạn</label>
        <input id="c-author" placeholder="VD: Nguyễn Văn A" autocomplete="off"/>
      </div>
      <div class="field">
        <label>Nội dung mách lẻo *</label>
        <textarea id="c-content" rows="4" placeholder="VD: Bạn A hôm nay không trực nhật mà đi chơi..."></textarea>
      </div>
      <div class="field">
        <label>Ảnh bằng chứng (tối đa ${MAX_CONFESS_IMAGES} ảnh)</label>
        <div class="img-picker" id="imgPicker"></div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">
          Tổng dung lượng tối đa: ${bytesToStr(CONFESS_TOTAL_MAX_BYTES)}
        </div>
      </div>
    `,
    footer: `
      <button class="btn ghost" onclick="closeModal()">Hủy</button>
      <button class="btn pink" id="btnCreateConfess">Đăng bài</button>
    `,
    onOpen: () => {
      renderImgPicker();
      const anon = $('c-anon');
      const wrap = $('c-author-wrap');
      anon.addEventListener('change', () => {
        wrap.style.display = anon.checked ? 'none' : 'block';
      });
    }
  });

  $('btnCreateConfess').onclick = submitConfess;
};

function renderImgPicker(){
  const picker = $('imgPicker');
  if (!picker) return;
  const canAdd = confessImages.length < MAX_CONFESS_IMAGES;
  picker.innerHTML = `
    ${confessImages.map((src, i) => `
      <div class="img-thumb">
        <img src="${src}"/>
        <button class="img-thumb-del" onclick="removeConfessImage(${i})" title="Xóa">✕</button>
      </div>
    `).join('')}
    ${canAdd ? `
      <button class="img-add" onclick="pickConfessImage()" title="Thêm ảnh">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    ` : ''}
  `;
}

window.removeConfessImage = (i) => {
  confessImages.splice(i, 1);
  renderImgPicker();
};

window.pickConfessImage = () => {
  let input = $('confessCameraInput');
  if (!input){
    input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.id = 'confessCameraInput';
    input.style.display = 'none';
    document.body.appendChild(input);
  }
  input.value = '';
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (confessImages.length >= MAX_CONFESS_IMAGES){
      toast(`⚠️ Tối đa ${MAX_CONFESS_IMAGES} ảnh`);
      return;
    }
    toast('⏳ Đang nén ảnh...');
    try {
      const { dataUrl, sizeBytes } = await compressToDataURL(
        file, CONFESS_IMG_MAX_SIZE, CONFESS_IMG_QUALITY, CONFESS_IMG_MAX_BYTES
      );
      // Kiểm tra tổng dung lượng
      const currentTotal = confessImages.reduce((sum, d) =>
        sum + Math.round((d.length * 3) / 4), 0);
      if (currentTotal + sizeBytes > CONFESS_TOTAL_MAX_BYTES){
        toast('⚠️ Tổng ảnh quá lớn, xóa bớt ảnh cũ');
        return;
      }
      confessImages.push(dataUrl);
      renderImgPicker();
      console.log('Ảnh mách lẻo:', bytesToStr(sizeBytes), '| Tổng:', confessImages.length);
    } catch(err){
      toast('❌ Lỗi: ' + err.message);
    }
  };
  input.click();
};

async function submitConfess(){
  const anon = $('c-anon').checked;
  const author = anon ? '' : ($('c-author').value.trim() || 'Ẩn danh');
  const content = $('c-content').value.trim();

  if (!content && !confessImages.length){
    toast('⚠️ Nhập nội dung hoặc chọn ảnh');
    return;
  }

  // Kiểm tra tổng dung lượng lần cuối
  const totalBytes = confessImages.reduce((sum, d) =>
    sum + Math.round((d.length * 3) / 4), 0);
  if (totalBytes > CONFESS_TOTAL_MAX_BYTES){
    toast('⚠️ Tổng ảnh quá lớn');
    return;
  }

  try {
    await addDoc(collection(db, 'confesses'), {
      author: author || 'Ẩn danh',
      anonymous: anon,
      content,
      images: confessImages,
      totalBytes,
      createdAt: serverTimestamp()
    });
    toast('✅ Đã đăng mách lẻo');
    confessImages = [];
    closeModal();
  } catch(e){
    toast('❌ Lỗi: ' + e.message);
  }
}

window.deleteConfess = async (id) => {
  if (!confirm('Xóa bài mách lẻo này?')) return;
  try {
    await deleteDoc(doc(db, 'confesses', id));
    toast('🗑️ Đã xóa bài');
  } catch(e){ toast('❌ Lỗi: ' + e.message); }
};

/* ========== HỘP THƯ ADMIN ========== */
$('inboxBtn').onclick = () => {
  openModal({
    title: '📬 Hộp thư thông báo',
    wide: true,
    body: '<div class="inbox-modal"></div>',
    onOpen: renderInboxModal
  });
};

function renderInboxModal(){
  const box = document.querySelector('.inbox-modal');
  if (!box) return;
  if (!messages.length){
    box.innerHTML = `
      <div class="empty" style="padding:40px 16px">
        <div class="empty-icon">📭</div>
        <h3>Hộp thư trống</h3>
        <p>Chưa có thông báo nào.</p>
      </div>`;
    return;
  }
  box.innerHTML = messages.map(m => `
    <div class="inbox-item ${m.read ? '' : 'unread'}" data-id="${m.id}">
      <div class="inbox-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
      </div>
      <div class="inbox-body">
        <div class="inbox-title"><b>${esc(m.studentName)}</b> đã tải ảnh lên</div>
        <div class="inbox-sub">📅 ${esc(m.weekName || '')} · ${DAY_LABEL[m.day] || m.day}</div>
        <div class="inbox-time">🕐 ${fmtDateTimeVN(m.uploadedAt)} (GMT+7) · ${fmtRelativeVN(m.uploadedAt)}</div>
      </div>
    </div>`).join('');

  box.querySelectorAll('.inbox-item').forEach(el => {
    el.onclick = async () => {
      try {
        await updateDoc(doc(db, 'messages', el.dataset.id), { read: true });
      } catch(e){ console.error(e); }
    };
  });
}

/* ========== KHỞI ĐỘNG ========== */
history.replaceState({ screen: 'home', weekId: null, assignmentId: null }, '');
view = { screen: 'home', weekId: null, assignmentId: null };

subscribeWeeks();
subscribeMessages();
subscribeConfesses();
renderScreen();

console.log('%c✅ App đã khởi động','color:#10b981;font-weight:bold;font-size:14px');
console.log('Firebase project:', firebaseConfig.projectId);
