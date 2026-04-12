// ─── API Helper ───────────────────────────────────────────────
const API = {
    base: '',
    getToken: () => localStorage.getItem('hms_token'),
    getUser: () => {
        try { return JSON.parse(localStorage.getItem('hms_user')); } catch { return null; }
    },
    setAuth: (token, user) => {
        localStorage.setItem('hms_token', token);
        localStorage.setItem('hms_user', JSON.stringify(user));
    },
    clearAuth: () => {
        localStorage.removeItem('hms_token');
        localStorage.removeItem('hms_user');
    },
    headers: () => ({
        'Content-Type': 'application/json',
        ...(localStorage.getItem('hms_token') ? { Authorization: `Bearer ${localStorage.getItem('hms_token')}` } : {})
    }),
    async get(path) {
        const res = await fetch(this.base + path, { headers: this.headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Request failed');
        return data;
    },
    async post(path, body) {
        const res = await fetch(this.base + path, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Request failed');
        return data;
    },
    async del(path) {
        const res = await fetch(this.base + path, { method: 'DELETE', headers: this.headers() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Request failed');
        return data;
    },
    async patch(path, body = {}) {
        const res = await fetch(this.base + path, { method: 'PATCH', headers: this.headers(), body: JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Request failed');
        return data;
    }
};

// ─── Auth Guard ───────────────────────────────────────────────
function requireAuth(redirectTo = '/index.html') {
    if (!API.getToken()) { window.location.href = redirectTo; return false; }
    return true;
}
function requireAdmin() {
    const user = API.getUser();
    if (!user || user.role !== 'admin') { window.location.href = '/hospitals.html'; return false; }
    return true;
}
function logout() {
    API.clearAuth();
    if (window.socket) window.socket.disconnect();
    window.location.href = '/index.html';
}

// ─── Socket.io Setup ───────────────────────────────────────────
function initSocket() {
    if (typeof io === 'undefined') return;
    const user = API.getUser();
    if (!user) return;
    window.socket = io();
    window.socket.emit('join-room', user._id);
    window.socket.on('notification', (notif) => {
        showToast(notif.message, notif.type);
        updateNotifBadge();
    });
    window.socket.on('bed-update', () => {
        if (typeof onBedUpdate === 'function') onBedUpdate();
    });
}

// ─── Toast Notification Queue ─────────────────────────────────
const _toastQueue = [];
let _toastActive = false;

function showToast(message, type = 'general') {
    _toastQueue.push({ message, type });
    if (!_toastActive) _processToastQueue();
}

function _processToastQueue() {
    if (_toastQueue.length === 0) { _toastActive = false; return; }
    _toastActive = true;
    const { message, type } = _toastQueue.shift();
    const colors = {
        booking: '#16a34a', cancellation: '#ef4444', queue: '#3b82f6',
        transfer: '#8b5cf6', fraud: '#f59e0b', general: '#64748b'
    };
    const toast = document.createElement('div');
    toast.style.cssText = `
    position:fixed; bottom:1.5rem; left:50%; transform:translateX(-50%) translateY(0);
    background:${colors[type] || '#16a34a'}; color:#fff;
    padding:0.8rem 1.5rem; border-radius:10px; font-size:0.88rem;
    font-weight:600; z-index:99999; box-shadow:0 4px 20px rgba(0,0,0,0.2);
    max-width:90vw; text-align:center; font-family:'Inter',sans-serif;
    transition: opacity 0.3s ease, transform 0.3s ease; opacity:0;
  `;
    toast.textContent = message;
    document.body.appendChild(toast);
    // Animate in
    requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(-50%) translateY(-4px)'; });
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(4px)';
        setTimeout(() => { toast.remove(); _processToastQueue(); }, 350);
    }, 3500);
}

// ─── Notification Badge ───────────────────────────────────────
async function updateNotifBadge() {
    if (!API.getToken()) return;
    try {
        const notifs = await API.get('/api/notifications');
        const unread = notifs.filter(n => !n.read).length;
        const badges = document.querySelectorAll('.notif-count');
        badges.forEach(b => { b.textContent = unread; b.style.display = unread > 0 ? 'inline-flex' : 'none'; });
    } catch (_) { }
}

// ─── Build Navbar ─────────────────────────────────────────────
function buildNavbar(activePage) {
    const user = API.getUser();
    const nav = document.getElementById('navbar');
    if (!nav) return;
    const isAdmin = user?.role === 'admin';
    const isGuest = !user;

    // When not logged in, show only the brand and a Login CTA
    const links = isGuest ? [] : isAdmin ? [
        { href: '/admin-dashboard.html', label: '📊 Dashboard', id: 'dashboard' },
        { href: '/admin-dashboard.html#transfers', label: '🔄 Transfers', id: 'transfers' },
    ] : [
        { href: '/hospitals.html', label: '🏥 Hospitals', id: 'hospitals' },
        { href: '/booking.html', label: (user && user.activeBookingId) ? '📋 My Bookings' : '📋 Book Bed', id: 'booking' },
        { href: '/queue.html', label: '⏳ My Queue', id: 'queue' },
    ];

    nav.innerHTML = `
    <a href="${isGuest ? '/' : isAdmin ? '/admin-dashboard.html' : '/hospitals.html'}" class="navbar-brand">
      <span class="logo-icon">🏥</span> MediTrack
    </a>
    <div class="navbar-links" id="nav-links">
      ${links.map(l => `<a href="${l.href}" class="${activePage === l.id ? 'active' : ''}">${l.label}</a>`).join('')}
      ${user ? `
        <button onclick="toggleNotifPanel()" style="position:relative">
          🔔 <span class="notif-badge notif-count" style="display:none">0</span>
        </button>
        <button onclick="logout()" class="btn btn-danger btn-sm">Logout</button>
      ` : `<a href="/index.html" class="btn btn-primary btn-sm">🔑 Login</a>`}
    </div>
    <div id="notif-panel" class="notif-panel">
      <div style="padding:1rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <strong>Notifications</strong>
        <button onclick="markAllRead()" class="btn btn-ghost btn-sm">Mark all read</button>
      </div>
      <div id="notif-list">Loading...</div>
    </div>
  `;
    if (user) { updateNotifBadge(); }
}

function toggleNotifPanel() {
    const panel = document.getElementById('notif-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) loadNotifications();
}

async function loadNotifications() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    try {
        const notifs = await API.get('/api/notifications');
        if (notifs.length === 0) { list.innerHTML = '<div style="padding:1rem;color:var(--text-muted);text-align:center">No notifications</div>'; return; }
        list.innerHTML = notifs.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="markRead('${n._id}', this)">
        ${n.message}
        <div class="notif-time">${new Date(n.createdAt).toLocaleString()}</div>
      </div>
    `).join('');
    } catch (_) { }
}

async function markRead(id, el) {
    try {
        await API.patch(`/api/notifications/read/${id}`);
        el.classList.remove('unread');
        updateNotifBadge();
        document.getElementById('notif-panel').classList.remove('open');
    } catch (_) { }
}
async function markAllRead() {
    try {
        await API.patch('/api/notifications/read-all');
        document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
        updateNotifBadge();
        document.getElementById('notif-panel').classList.remove('open');
    } catch (_) { }
}

// ─── Bed progress bar color ───────────────────────────────────
function bedBarClass(available, visible) {
    if (visible === 0) return 'danger';
    const pct = available / visible;
    if (pct <= 0.2) return 'danger';
    if (pct <= 0.5) return 'warning';
    return '';
}

// ─── Format Date ─────────────────────────────────────────────
function fmtDate(d) { return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }

// ─── Custom UI Tools ──────────────────────────────────────────
function initCustomModal() {
    if (document.getElementById('custom-confirm-modal')) return;
    const div = document.createElement('div');
    div.id = 'custom-confirm-modal';
    div.style = 'display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; justify-content:center; align-items:center; backdrop-filter:blur(3px);';
    div.innerHTML = `
        <div class="card fade-in" style="max-width:400px; width:90%; padding:2.5rem 2rem; text-align:center; box-shadow:0 10px 25px rgba(0,0,0,0.2);">
            <div style="font-size:3rem; margin-bottom:1rem;">⚠️</div>
            <h3 style="margin-top:0; color:var(--text-main); font-size:1.25rem;">Active Request Found</h3>
            <p style="color:var(--text-muted); margin-bottom:2rem; line-height:1.5" id="custom-confirm-msg">You already have an active request. Do you want to cancel the old one and place a new one?</p>
            <div style="display:flex; gap:1rem; justify-content:center;">
                <button class="btn btn-outline" id="custom-confirm-no" style="flex:1">Cancel</button>
                <button class="btn btn-primary" id="custom-confirm-yes" style="flex:1; background-color:var(--danger); border-color:var(--danger);">Yes, Replace</button>
            </div>
        </div>
    `;
    document.body.appendChild(div);
}

window.showCustomConfirm = function (msg, onConfirm) {
    initCustomModal();
    const modal = document.getElementById('custom-confirm-modal');
    document.getElementById('custom-confirm-msg').textContent = msg;
    modal.style.display = 'flex';

    document.getElementById('custom-confirm-yes').onclick = () => {
        modal.style.display = 'none';
        onConfirm();
    };
    document.getElementById('custom-confirm-no').onclick = () => {
        modal.style.display = 'none';
    };
}
