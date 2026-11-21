const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, session, screen, Menu, Tray, nativeImage, globalShortcut, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

// ★ EPIPE 兜底（2026-09-25）：父 shell 超时被杀后 stdout 管道断，
// 任何 console.log 抛 EPIPE → Uncaught Exception 直接杀死主进程
// （实测崩溃：qlog → console.log → EPIPE）。吞掉它，诊断全走日志文件。
// ★ 崩溃日志（2026-10-24）：用户看不到控制台日志，未捕获错误追加写到项目 crash.log
function appendCrashLog(kind, e) {
  try {
    fs.appendFile(path.join(__dirname, 'crash.log'),
      '[' + new Date().toISOString() + '] ' + kind + ': ' + (e && (e.stack || e.message) || e) + '\n', () => {});
  } catch {}
}
process.on('uncaughtException', (e) => {
  try {
    if (e && e.code === 'EPIPE') return;
    console.error('[FATAL] uncaught:', e && e.message);
    appendCrashLog('uncaught', e);
  } catch {}
});
process.on('unhandledRejection', (e) => {
  try {
    console.error('[FATAL] unhandledRejection:', e && e.message);
    appendCrashLog('unhandledRejection', e);
  } catch {}
});

/* ---- 主进程日志落盘（#10，2026-11-20）：console.log/warn/error 同步写入
   userData/logs/main.log；文件超 1MB 环形截断（只保留尾部 512KB），防止无限膨胀 ---- */
let _logPath = null;
function _logSafeStr(a) {
  try {
    if (typeof a === 'object' && a !== null) return (a.stack || a.message || JSON.stringify(a));
    return String(a);
  } catch { return String(a); }
}
function mainLogLine(level, args) {
  try {
    if (_logPath === null) {
      const dir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(dir, { recursive: true });
      _logPath = path.join(dir, 'main.log');
    }
    const line = '[' + new Date().toISOString() + '] ' + level + ' ' + args.map(_logSafeStr).join(' ') + '\n';
    fs.appendFile(_logPath, line, (err) => {
      if (err) return;
      try {
        const st = fs.statSync(_logPath);
        if (st.size > 1024 * 1024) {   // 环形截断：保留尾部 512KB
          const keepLen = 512 * 1024;
          const fd = fs.openSync(_logPath, 'r+');
          try {
            const keep = Buffer.alloc(keepLen);
            const rd = fs.readSync(fd, keep, 0, keepLen, st.size - keepLen);
            fs.ftruncateSync(fd, rd);
          } finally { fs.closeSync(fd); }
        }
      } catch {}
    });
  } catch {}
}
['log', 'warn', 'error'].forEach((level) => {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    try { orig(...args); } catch {}   // 原 EPIPE 兜底保留：控制台管道断了也不崩
    try { mainLogLine(level.toUpperCase(), args); } catch {}
  };
});

let win;
let authMUSICU = null;      // 登录态：仅存内存，不落盘（scratch session）
let authName = '';
let drawerView = null;      // 内嵌网页抽屉（登录二维码专用）
let qqWatchdogTimer = null; // 泵看门狗句柄
let qqPumpTimer = null;     // 泵句柄（防双泵：重复 open 时先清旧）
let qqCheckTimer = null;    // doCheck 句柄（同上）
function qqWatchdogClear() { if (qqWatchdogTimer) { clearInterval(qqWatchdogTimer); qqWatchdogTimer = null; } }

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.wav', '.opus', '.wma']);
const MAX_DEPTH = 3;

// 隐藏会话：离屏 900x540（登录页画二维码用——canvas 2D 离屏也能 toDataURL）。
// 离屏坐标：登录二维码是 canvas 2D 绘制，离屏也能 toDataURL 抽出，故隐藏会话恒放离屏
function hiddenBounds() {
  return { x: 10000, y: 10000, width: 900, height: 540 };
}
// QQ 扫码登录的确认步（扫码 → login_jump → wx_redirect → 写 cookie）是【页面内导航链】，
// Chromium 对 x:10000 离屏页面做 page-lifecycle 冻结：导航走不完、cookie 落不了，
// ★ 2026-09-26 定稿：QQ 登录页 = 独立离屏 BrowserWindow（不是 BrowserView）。
// 探针实测：独立离屏窗（x:10000, show:true）visibilityState=visible、
// setTimeout 准点、rAF 1ms —— 页面 JS/导航链全部正常。
// 之前 BrowserView 离屏死路的真因 = 视图被主窗 bounds 裁剪成 0 可见区
// → 文档恒 hidden；独立窗口不受裁剪，彻底绕开。
// 确保离屏登录窗存在；返回 webContents
function ensureDrawer(bounds) {
  const b = bounds;
  if (!b) return null;
  if (!drawerView) {
    // ★ 两段式定位：Electron/OS 会把 x:10000 的窗钳位到屏幕内（→ vis=hidden，
    // 页面 confirm 导航被冻结）。先在屏幕外但系统能定位的远点创建，加载完再搬到
    // 真正屏幕外——QR 阶段必须 vis=visible（原生登录链依赖）。
    const start = { x: Math.max(2, (screen.getPrimaryDisplay().bounds.width) - 20), y: -900 };
    drawerView = new BrowserWindow({
      x: start.x, y: start.y, width: b.width, height: b.height,
      show: false,
      skipTaskbar: true,
      frame: false,
      resizable: false,
      movable: false,
      webPreferences: { partition: AUTH_PARTITION, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    drawerView.webContents.setBackgroundThrottling(false);
    drawerView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    drawerView.webContents.once('did-finish-load', () => { try { drawerView.setBounds(b); } catch {} });
    drawerView.show();
  }
  // 注意：不在此处立即 setBounds(b)——首启时窗还在加载期，搬到屏幕外等 did-finish-load
  return drawerView.webContents;
}
function drawerClose() {
  try {
    if (drawerView) {
      const wc = drawerView.webContents;   // 先销毁 webContents，避免孤儿 target
      if (wc && !wc.isDestroyed()) wc.close();
      if (!drawerView.isDestroyed()) drawerView.destroy();
    }
  } catch {}
  drawerView = null;
  qqWatchdogClear();
  // ★ 关模态=停泵：清泵/检查句柄（每 open 都是新闭包，会话状态天然重建，这里不碰）
  if (qqPumpTimer) { try { clearInterval(qqPumpTimer); } catch {} qqPumpTimer = null; }
  if (qqCheckTimer) { try { clearInterval(qqCheckTimer); } catch {} qqCheckTimer = null; }
}

function scanMusicDir(dir, depth = 0) {
  const out = [];
  if (depth > MAX_DEPTH) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      out.push(...scanMusicDir(full, depth + 1));
    } else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      try { out.push({ path: full, name: e.name, size: fs.statSync(full).size }); } catch {}
    }
  }
  return out;
}

/* ---- 窗口位置/大小记忆（2026-10-21）：记住上次窗口 bounds，重启不跳回默认位置 ---- */
const WIN_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
function loadWinState() { try { return JSON.parse(fs.readFileSync(WIN_STATE_FILE, 'utf8')); } catch { return null; } }
let lastNormalBounds = null;
let winSaveTimer = null;
function _wsLog(line) { try { fs.appendFileSync(path.join(__dirname, 'win_state_debug.log'), new Date().toISOString() + ' ' + line + '\n'); } catch {} }
function saveWinState() {
  if (!win || win.isDestroyed()) { _wsLog('saveWinState skipped: win missing/destroyed'); return; }
  try {
    const maxed = win.isMaximized();
    const b = maxed ? (lastNormalBounds || win.getBounds()) : win.getBounds();
    if (!maxed) lastNormalBounds = b;
    fs.writeFileSync(WIN_STATE_FILE, JSON.stringify({ bounds: b, maximized: maxed }));
    _wsLog('SAVED -> ' + WIN_STATE_FILE + ' ' + JSON.stringify(b) + ' maxed=' + maxed);
  } catch (e) { _wsLog('SAVE FAILED: ' + e.message); }
}
function scheduleWinSave() { if (winSaveTimer) return; winSaveTimer = setTimeout(() => { winSaveTimer = null; saveWinState(); }, 400); }
function createWindow() {
  // 自定义窗口/任务栏图标（2026-10-22）：icon.ico 存在才设置，避免缺文件告警
  const iconFile = path.join(__dirname, 'icon.ico');
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    frame: false,                 // 无边框，自绘标题栏
    titleBarStyle: 'hidden',
    backgroundColor: '#0b0b12',
    ...(fs.existsSync(iconFile) ? { icon: iconFile } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu && win.removeMenu();

  // 恢复上次窗口位置/大小（2026-10-21）
  const ws = loadWinState();
  if (ws && ws.bounds && ws.bounds.width >= 940 && ws.bounds.height >= 600) {
    try {
      win.setBounds(ws.bounds);
      lastNormalBounds = ws.bounds;
      _wsLog('RESTORED -> ' + JSON.stringify(ws.bounds) + ' maxed=' + ws.maximized);
      if (ws.maximized) setTimeout(() => { try { win.maximize(); } catch {} }, 400);
    } catch {}
  }
  win.on('resize', () => scheduleWinSave());
  win.on('move', () => scheduleWinSave());
  win.on('close', () => { _wsLog('CLOSE event fired'); saveWinState(); });
  win.on('closed', () => { _wsLog('CLOSED event fired'); if (miniWin && !miniWin.isDestroyed()) { try { miniWin.close(); } catch {} miniWin = null; } });

  // 渲染层 console → 主进程 stdout（调试用）
  win.webContents.on('console-message', (e, level, message) => {
    console.log('[renderer]', message);
  });
  win.webContents.on('did-fail-load', (e, code, desc) => console.log('did-fail-load', code, desc));
  win.webContents.on('render-process-gone', (e, details) => console.log('render-gone', details));

  win.loadFile('index.html');

  // 最大化状态同步给渲染层（图标切换）
  win.on('maximize', () => win.webContents.send('win:max-state', true));
  win.on('unmaximize', () => win.webContents.send('win:max-state', false));

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 快捷键 F11 切换全屏
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
}

/* ---- 单实例锁（2026-10-22）：重复启动不再开第二个实例（共享 userData 会互相干扰），
   而是把已存在的窗口前置/还原 ---- */
if (!app.requestSingleInstanceLock()) {
  // 已有实例在运行：立即退出（second-instance 事件由老实例处理）。
  // 用 process.exit(0) 而非 app.quit()：app.quit() 会被 before-quit 钩子拦截并延迟退出，
  // 期间会短暂创建托盘/空白窗口（2026-10-24 E2E 观察）。
  process.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

/* ---- 全局热键（2026-11-15）：Ctrl+Shift+Space = 播放/暂停（本机若注册失败则回退 Ctrl+Space），Ctrl+Shift+Left/Right = 上一首/下一首，Ctrl+Shift+V = 显示/隐藏窗口，Ctrl+Shift+M = 迷你窗 ---- */
/* ★ 2026-11-21：每键独立 try/catch（原来一把 try 包住全部，第二个键抛错会把后面全部拖死）；
   本 Electron/Windows 下 'ArrowLeft' 不是合法加速器名（必须 'Left'/'Right'） */
let hotkeysRegistered = false;
function registerGlobalHotkeys() {
  if (hotkeysRegistered) return;
  hotkeysRegistered = true;
  const one = (label, key, fn) => {
    try {
      const ok = globalShortcut.register(key, fn);
      if (ok) console.log('[hotkeys] ' + label + ' registered (' + key + ')');
      else console.log('[hotkeys] ' + label + ' not registered (key busy or invalid): ' + key);
      return ok;
    } catch (e) { console.log('[hotkeys] ' + label + ' register failed:', e.message); return false; }
  };
  // ★ 2026-11-21：实测本机 Windows 上 'CommandOrControl+Shift+Space' 注册失败（register 返回 false），
  // 依次回退候选键，保证「播放/暂停」至少有一个热键可用
  const toggleKeys = ['CommandOrControl+Shift+Space', 'CommandOrControl+Space'];
  for (const k of toggleKeys) {
    if (one('toggle', k, () => { if (win && !win.isDestroyed()) win.webContents.send('tray:ctrl', 'toggle'); })) break;
  }
  one('prev', 'CommandOrControl+Shift+Left', () => { if (win && !win.isDestroyed()) win.webContents.send('tray:ctrl', 'prev'); });
  one('next', 'CommandOrControl+Shift+Right', () => { if (win && !win.isDestroyed()) win.webContents.send('tray:ctrl', 'next'); });
  one('show', 'CommandOrControl+Shift+V', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.minimize(); else { win.show(); win.focus(); }
  });
  one('mini', 'CommandOrControl+Shift+M', () => { if (win && !win.isDestroyed()) win.webContents.send('mini:toggle'); });
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  createWindow();
  createTray();
  registerGlobalHotkeys();
  // 持久分区里若已有登录 cookie（上次扫码），启动即恢复登录态并推送给 UI
  setTimeout(async () => {
    try {
      await seedAuthOnce();              // 一次性迁移先前导出的真实 cookie（用后即焚）
      await persistLoginCookies();       // 把登录 cookie 固化到磁盘（会话 cookie → 持久）
      const st = await refreshAuthState();
      if (st.loggedIn && win && !win.isDestroyed()) win.webContents.send('auth:changed', st);
    } catch (e) { console.log('[auth] boot restore failed:', e.message); }
  }, 1200);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { globalShortcut.unregisterAll(); app.quit(); }
});

// 退出前确保登录 cookie 已落盘（会话 cookie → 持久），重启后免扫码。
// before-quit 是唯一能可靠拿到"退出前最后一次写入"的时机；用 preventDefault
// 推迟真正退出，等 flush 完成后再放行。幂等，未登录时是空操作。
let _quitting = false;
app.on('before-quit', (e) => {
  if (_quitting) return;               // 放行第二次
  e.preventDefault();
  _quitting = true;
  const LOGQ = path.join(app.getPath('temp'), 'mh_quit.log');
  const logq = (m) => { try { fs.appendFileSync(LOGQ, m + '\n'); } catch {} };
  logq('before-quit fired ' + new Date().toISOString());
  try { globalShortcut.unregisterAll(); logq('unregistered all global shortcuts'); } catch {}
  (async () => {
    try { const n = await persistLoginCookies(); logq('persistLoginCookies changed=' + n); } catch (err) { logq('persist err ' + err.message); }
    try { const qn = await persistQQCookies(); logq('persistQQCookies changed=' + qn); } catch (err) { logq('persistQQ err ' + err.message); }
  try { saveWinState(); _wsLog('before-quit saveWinState done'); } catch (err) { logq('winState err ' + err.message); }
    try { await authSess().flushStorageData(); logq('flush auth done'); } catch (err) { logq('flush auth err ' + err.message); }
    // 默认会话的 localStorage（mh_session 队列/历史/歌单）也必须落盘，
    // 否则关闭瞬间未刷写的 localStorage 会丢 → 重启不恢复队列
    try { await session.defaultSession.flushStorageData(); logq('flush default (localStorage) done'); } catch (err) { logq('flush default err ' + err.message); }
  })().finally(() => { logq('calling app.quit'); try { app.quit(); } catch (err) { logq('quit err ' + err.message); } });
  // 兜底：若 5s 内仍未退出（如 flush 卡住），强制退出
  setTimeout(() => { logq('fallback app.quit'); try { app.quit(); } catch {} }, 5000);
});

/* ---- 托盘（2026-10-21）：最小化=隐藏到托盘；托盘图标=当前歌曲封面（兜底音符图标），
   tooltip=歌名，菜单含 播放/暂停/上一首/下一首/显示窗口/退出 ---- */
let tray = null;
let trayInfo = { name: '', cover: '', playing: false };
let trayCoverLast = null;
function buildTrayMenu() {
  if (!tray) return;
  const tpl = [
    { label: trayInfo.name ? ('正在播放：' + trayInfo.name) : '音集 MusicHub', enabled: false },
    { type: 'separator' },
    { label: trayInfo.playing ? '暂停' : '播放', click: () => trayCtrl('toggle') },
    { label: '上一首', click: () => trayCtrl('prev') },
    { label: '下一首', click: () => trayCtrl('next') },
    { type: 'separator' },
    { label: '显示窗口', click: () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } } },
    { label: '退出', click: () => app.quit() },
  ];
  try { tray.setMenu(Menu.buildFromTemplate(tpl)); } catch {}
}
function trayCtrl(action) { if (win && !win.isDestroyed()) win.webContents.send('tray:ctrl', action); }

/* ---- 切歌系统通知（#3，2026-11-20）：渲染进程切歌时推送 Windows 通知 ---- */
ipcMain.on('notify:track', (_e, d) => {
  if (!app.isReady() || !Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: '▶ ' + ((d && d.title) || '音集 MusicHub'),
      subtitle: (d && d.artist) || '',
      body: '音集 MusicHub',
    });
    n.show();
  } catch {}
});

/* ---- 显示窗口（#9 闹钟联动，2026-11-21）：从渲染进程请求把主窗显示出来 ---- */
ipcMain.on('win:show', () => {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

/* ---- 早起闹钟（#9，2026-11-21）：渲染进程武装"HH:MM"后，主进程每 15s 巡检，
   到点当天只触发一次：系统通知 + 通知渲染进程开始播放。放主进程是为了不受
   渲染进程后台节流影响；应用关闭则不触发（UI 已注明需保持应用开着）。 ---- */
let wakeTimer = null;
let wakeArmed = '';
let wakeLastFired = '';
function wakeNowHM() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function wakeToday() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function wakeTick() {
  if (!wakeArmed || wakeLastFired === wakeToday()) return;
  if (wakeNowHM() !== wakeArmed) return;
  wakeLastFired = wakeToday();
  mainLogLine('info', ['[wake] fired at ' + wakeArmed]);
  if (Notification.isSupported()) {
    try { const n = new Notification({ title: '⏰ 到点了', body: '音集 MusicHub 开始播放' }); n.show(); } catch {}
  }
  if (win && !win.isDestroyed()) win.webContents.send('wake:fire');
}
ipcMain.on('wake:arm', (_e, hm) => {
  wakeArmed = (typeof hm === 'string' && /^\d{2}:\d{2}$/.test(hm)) ? hm : '';
  if (!wakeTimer) wakeTimer = setInterval(wakeTick, 15000);
  mainLogLine('info', ['[wake] arm ' + (wakeArmed || '(off)')]);
  if (wakeArmed) wakeTick();
});
ipcMain.on('wake:disarm', () => {
  wakeArmed = '';
  if (wakeTimer) { clearInterval(wakeTimer); wakeTimer = null; }
  mainLogLine('info', ['[wake] disarmed']);
});

/* ---- 迷你播放模式（2026-10-25）：常顶层小窗，封面 + 上一/播放暂停/下一/关闭 ---- */
let miniWin = null;
function sendMini(state) {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini:state', state);
}
ipcMain.handle('mini:state', (_e, s) => { sendMini(s); return true; });
// mini-preload 用 ipcRenderer.send 发送命令 → 必须 ipcMain.on（handle 只响应 invoke，send 不触发）
ipcMain.on('mini:cmd:from-mini', (_e, c) => {
  if (c === 'close') { if (miniWin) miniWin.close(); return; }
  if (win && !win.isDestroyed()) win.webContents.send('mini:cmd', c);
});
ipcMain.handle('mini:toggle', () => {
  if (miniWin && !miniWin.isDestroyed()) { miniWin.close(); miniWin = null; return false; }
  miniWin = new BrowserWindow({
    width: 320, height: 144, frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#0B0B12',
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  miniWin.setMenu(null);
  miniWin.loadFile(path.join(__dirname, 'mini.html'));
  miniWin.once('ready-to-show', () => { if (miniWin && !miniWin.isDestroyed()) miniWin.show(); });
  miniWin.on('closed', () => { miniWin = null; });
  return true;
});
// 睡眠定时到期通知（2026-11-15）
ipcMain.on('timer:done', () => {
  if (win && !win.isDestroyed()) win.webContents.send('timer:notify', { action: 'stop' });
});
// 导出触发（2026-11-15）
ipcMain.handle('export:start', async () => {
  // 导出由渲染层 Blob download 完成，主进程负责打开文件夹或验证路径
  const dir = await require('electron').dialog.showOpenDialog(win, {
    title: '选择导出文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (dir.canceled) return false;
  return dir.filePaths[0];
});
// 托盘图标换成当前歌曲封面（小图，失败保持默认音符图标）
function updateTrayCover(cover) {
  if (!tray || !cover || cover === trayCoverLast) return;
  trayCoverLast = cover;
  fetch(cover, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then(r => r.arrayBuffer())
    .then(buf => {
      let img = nativeImage.createFromBuffer(Buffer.from(buf));
      if (img.isEmpty()) return;
      img = img.resize({ width: 32, height: 32 });
      if (tray && !tray.isDestroyed()) tray.setImage(img);
    })
    .catch(() => {});
}
ipcMain.on('tray:state', (_e, d) => {
  d = d || {};
  trayInfo = { name: String(d.name || ''), cover: String(d.cover || ''), playing: !!d.playing };
  if (!tray) return;
  tray.setToolTip(trayInfo.name || '音集 MusicHub');
  buildTrayMenu();
  updateTrayCover(trayInfo.cover);
});
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'tray-icon.png');
    const img = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    tray = new Tray(img);
    tray.setToolTip('音集 MusicHub');
    buildTrayMenu();
    tray.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
    console.log('[tray] created');
  } catch (e) { console.log('[tray] create failed:', e.message); }
}

/* ---- 窗口控制 IPC ---- */
ipcMain.on('win:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });   // 最小化 = 标准最小化到任务栏（2026-10-22 修：原 hide() 会把窗口彻底藏起来，而托盘图标默认在系统"隐藏图标"溢出区，用户找不回窗口）
ipcMain.on('win:maximize', () => {
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:is-maximized', () => (win ? win.isMaximized() : false));

/* ---- 本地音乐库 IPC ---- */
function libTrack(p, folder) {
  const m = p.name.replace(/\.[^.]+$/, '');
  return { path: p.path, trackName: m, folder };
}
/* ---- 本地库自动重扫（2026-10-25）：fs.watch（Windows 递归监听）+ 1.5s 防抖 → lib:changed 推送渲染端 ---- */
let libWatcher = null, libWatchDir = null, libWatchTimer = null;
function stopLibWatch() {
  if (libWatcher) { try { libWatcher.close(); } catch {} libWatcher = null; }
  if (libWatchTimer) { clearTimeout(libWatchTimer); libWatchTimer = null; }
  libWatchDir = null;
}
function startLibWatch(dir) {
  if (typeof dir !== 'string' || !fs.existsSync(dir)) return;
  if (libWatchDir === dir && libWatcher) return;   // 已在监听同一目录
  stopLibWatch();
  try {
    libWatchDir = dir;
    libWatcher = fs.watch(dir, { recursive: true }, () => {
      if (libWatchTimer) clearTimeout(libWatchTimer);
      libWatchTimer = setTimeout(() => {
        libWatchTimer = null;
        try {
          if (!libWatchDir || !fs.existsSync(libWatchDir)) return;
          const tracks = scanMusicDir(libWatchDir).map(p => libTrack(p, path.basename(path.dirname(p.path))));
          if (win && !win.isDestroyed()) win.webContents.send('lib:changed', { dir: libWatchDir, tracks });
        } catch (e) { console.log('[lib:watch] rescan failed:', e.message); }
      }, 1500);
    });
    libWatcher.on('error', (e) => { console.log('[lib:watch] error:', e.message); stopLibWatch(); });
    console.log('[lib:watch] watching', dir);
  } catch (e) { console.log('[lib:watch] start failed:', e.message); stopLibWatch(); }
}
ipcMain.handle('lib:open-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择本地音乐文件夹',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  const tracks = scanMusicDir(dir).map(p => libTrack(p, path.basename(path.dirname(p.path))));
  startLibWatch(dir);
  return { dir, tracks };
});
ipcMain.handle('lib:scan', (_e, dir) => {
  if (typeof dir !== 'string' || !fs.existsSync(dir)) return null;
  const tracks = scanMusicDir(dir).map(p => libTrack(p, path.basename(path.dirname(p.path))));
  startLibWatch(dir);
  return { dir, tracks };
});
// 拖拽文件导入本地库（2026-10-25）：复制文件到目标目录（自动重名），重扫并监听
ipcMain.handle('lib:import-files', (_e, paths, destDir) => {
  if (!Array.isArray(paths) || !paths.length) return { ok: false, err: '无文件' };
  if (typeof destDir !== 'string' || !destDir) return { ok: false, err: '需要目标目录' };
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) { return { ok: false, err: e.message }; }
  const audioExt = /\.(mp3|flac|wav|m4a|ogg|aac)$/i;
  let added = 0, failed = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !audioExt.test(p)) continue;
    const base = sanitizeFileName(path.basename(p));
    let out = path.join(destDir, base);
    for (let k = 1; fs.existsSync(out); k++) {
      const m = base.match(/^(.*?)(\.[^.]+)$/);
      out = path.join(destDir, m ? `${m[1]} (${k})${m[2]}` : base + ' ' + k);
    }
    try { fs.copyFileSync(p, out); added++; }
    catch (e) { failed++; console.log('[lib:import] copy failed:', p, e.message); }
  }
  const tracks = scanMusicDir(destDir).map(p => libTrack(p, path.basename(path.dirname(p.path))));
  startLibWatch(destDir);
  return { ok: true, added, failed, dir: destDir, tracks };
});

/* ---- 下载到本地（2026-10-21）：复用播放地址链，主进程流式写文件，进度经 IPC 推送 ---- */
function sanitizeFileName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'download';
}
ipcMain.handle('dir:pick', async () => {
  const res = await dialog.showOpenDialog(win, { title: '选择下载目录', properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});
ipcMain.handle('net:download', async (e, opt) => {
  opt = opt || {};
  const url = String(opt.url || '');
  const dir = String(opt.dir || '');
  const name = sanitizeFileName(opt.name || 'download');
  if (!/^https?:\/\//.test(url)) return { ok: false, err: '非法 URL' };
  if (!dir || !fs.existsSync(dir)) return { ok: false, err: '下载目录不存在' };
  const outPath = path.join(dir, name);
  const send = (ch, p) => { try { const s = e.sender; if (s && !s.isDestroyed()) s.send(ch, p); } catch {} };
  let res = null, tryErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
      if (r.ok) { res = r; break; }
      // 403/5xx（CDN 短效链接过期或限流）：等待后重试（2026-10-25）
      tryErr = 'HTTP ' + r.status;
      console.log('[net:download] attempt ' + (attempt + 1) + ' got ' + tryErr);
      if (attempt < 2) await new Promise(r2 => setTimeout(r2, 2500));
    } catch (e2) {
      tryErr = e2.message;
      console.log('[net:download] attempt ' + (attempt + 1) + ' failed:', e2.message);
      if (attempt < 2) await new Promise(r2 => setTimeout(r2, 2500));
    }
  }
  if (!res) return { ok: false, err: tryErr || '下载失败' };
  try {
    const r2 = res;
    const total = Number(r2.headers.get('content-length') || 0);
    const reader = r2.body.getReader();
    const chunks = [];
    let received = 0, lastAt = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const now = Date.now();
      if (now - lastAt > 500) { lastAt = now; send('dl:progress', { name, received, total }); }
    }
    fs.writeFileSync(outPath, Buffer.concat(chunks));
    send('dl:progress', { name, received, total, done: true, path: outPath });
    return { ok: true, path: outPath, size: received };
  } catch (e2) {
    console.log('[net:download] failed:', e2.message);
    return { ok: false, err: e2.message };
  }
});

/* ---- 在线整曲（网易云，走公开第三方代理 API，免 key）---- */
async function netJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' } });
  return r.json();
}
// 搜索：网易云官方 API（真分页、每页 50）+ qijieya pic 封面代理
// 批量封面：官方 song/detail 一次拿整页
async function batchCover(ids) {
  if (!ids.length) return {};
  try {
    const j = await netJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent('[' + ids.join(',') + ']')}`);
    const map = {};
    (j.songs || []).forEach(s => { if (s.album && s.album.picUrl) map[s.id] = s.album.picUrl; });
    return map;
  } catch { return {}; }
}
ipcMain.handle('net:search', async (_e, word, page, num) => {
  console.log('[IPC] net:search called with word:', word);
  try {
    const limit = num || 50;
    const offset = (page - 1) * limit;
    const j = await netJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(word)}&limit=${limit}&offset=${offset}&type=1`);
    const songs = (j.result && j.result.songs) || [];
    const total = (j.result && j.result.songCount) || songs.length;
    const coverMap = await batchCover(songs.map(s => s.id));
    const tracks = songs.map(it => ({
      onlineId: String(it.id),
      trackName: it.name || '',
      artistName: (it.artists || []).map(a => a.name).join('/'),
      collectionName: (it.album && it.album.name) || '',
      duration: it.duration || 0,
      cover: coverMap[it.id] || '',
    }));
    return { tracks, total };
  } catch (e) { console.log('[net:search] failed:', e.message); return { tracks: [], total: 0 }; }
});
// 艺人搜索（2026-10-25；2026-10-26 重建：官方 type=2 艺人搜索端点已下线返回空 result，
// 改为从歌曲搜索结果推导：按艺人 id 去重、按出现次数排序取前 N）
ipcMain.handle('net:artists', async (_e, word, limit) => {
  try {
    const j = await netJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(word)}&limit=100&offset=0&type=1`);
    const songs = (j.result && j.result.songs) || [];
    const seen = new Map();
    for (const s of songs) for (const a of (s.artists || [])) {
      if (!a || !a.id) continue;
      const k = String(a.id);
      if (!seen.has(k)) seen.set(k, { id: a.id, name: a.name || '', avatar: a.img1v1Url || '', n: 0 });
      seen.get(k).n++;
    }
    const artists = [...seen.values()].sort((x, y) => y.n - x.n).slice(0, limit || 8);
    return { artists: artists.map(a => ({ onlineId: String(a.id), name: a.name, avatar: a.avatar, songCount: 0 })), total: seen.size };
  } catch (e) { console.log('[net:artists] failed:', e.message); return { artists: [], total: 0 }; }
});
// 艺人歌曲列表（2026-10-25；2026-10-26 重建：artist/song/list 已 404，
// 改为按艺人名歌曲搜索 + 按艺人 id 过滤）+ 批量封面
ipcMain.handle('net:artist-songs', async (_e, artistId, artistName, limit) => {
  try {
    const j = await netJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(String(artistName || ''))}&limit=100&offset=0&type=1`);
    const songs = ((j.result && j.result.songs) || []).filter(s => (s.artists || []).some(a => String(a.id) === String(artistId)));
    const total = songs.length;
    const top = songs.slice(0, limit || 30);
    const coverMap = await batchCover(top.map(s => s.id));
    const tracks = top.map(it => ({
      onlineId: String(it.id),
      trackName: it.name || '',
      artistName: (it.artists || []).map(a => a.name).join('/'),
      collectionName: (it.album && it.album.name) || '',
      duration: it.duration || 0,
      cover: coverMap[it.id] || '',
    }));
    return { tracks, total };
  } catch (e) { console.log('[net:artist-songs] failed:', e.message); return { tracks: [], total: 0 }; }
});
// 歌单导入：解析从网易云歌单页粘贴的歌曲列表（"歌名 - 歌手" 行 / song?id= 链接 / 歌单页全选复制文本）
ipcMain.handle('net:import', async (_e, text) => {
  const raw = String(text || '');
  if (!raw.trim()) return { tracks: [], skipped: 0, playlistUrl: '' };
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const ids = [];
  const idSeen = new Set();
  const queries = [];
  const qSeen = new Set();
  let playlistUrl = '';
  for (let line of lines) {
    const idm = line.match(/song\?id=(\d+)/);
    if (idm) {
      const id = idm[1];
      if (!idSeen.has(id)) { idSeen.add(id); ids.push(id); }
      continue;
    }
    if (/playlist\?id=\d+/.test(line)) {
      const um = line.match(/https?:\/\/[^\s"'<>]+/);
      if (um && !playlistUrl) playlistUrl = um[0];
      continue;
    }
    line = line.replace(/^\d+\s*[\.\)、\-]\s*/, '');   // 去掉行首序号 "1. "
    if (!line || line.length > 80) continue;
    const k = line.replace(/\s+/g, '');
    if (!qSeen.has(k)) { qSeen.add(k); queries.push(line); }
  }
  const tracks = [];
  const seenId = new Set();
  const push = (t) => {
    if (!t || !t.onlineId || seenId.has(t.onlineId)) return false;
    seenId.add(t.onlineId); tracks.push(t); return true;
  };
  // 1) 已知歌曲 ID：官方 song/detail 批量解析（每批 100）
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const j = await netJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent('[' + chunk.join(',') + ']')}`);
      (j.songs || []).forEach(s => push({
        onlineId: String(s.id),
        trackName: s.name || '',
        artistName: (s.artists || []).map(a => a.name).join('/'),
        collectionName: (s.album && s.album.name) || '',
        duration: s.duration || 0,
        cover: (s.album && s.album.picUrl) || '',
      }));
    } catch (e) { console.log('[net:import] song/detail batch failed:', e.message); }
  }
  // 2) 按「歌名 - 歌手」逐行搜索，按得分选最佳（歌手命中 > 标题精确 > 前位）
  const norm = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();
  const pickBest = (songs, qTitle, qArtist) => {
    let best = null, bestScore = -1;
    songs.forEach((it, i) => {
      const tName = norm(it.name);
      const tArt = (it.artists || []).map(a => norm(a.name)).join('/');
      if (!tName || !(qTitle.includes(tName) || tName.includes(qTitle))) return;
      let score = 0;
      const artistHit = qArtist && (tArt.includes(qArtist) || norm(it.name).includes(qArtist));
      if (artistHit) score += 4;
      if (tName === qTitle) score += 3;
      if (/(钢琴|吉他|Cover|翻唱|DJ|深情版|女声|男声|Beat|版)/.test(it.name)) score -= 2;
      score += Math.max(0, 0.2 - i * 0.05);   // 排位靠前的小加分
      if (score > bestScore) { bestScore = score; best = it; }
    });
    return best;
  };
  for (const q of queries.slice(0, 100)) {
    const dash = q.indexOf('-');
    const qTitle = norm(dash > 0 ? q.slice(0, dash) : q);
    const qArtist = dash > 0 ? norm(q.slice(dash + 1)) : '';
    let best = null;
    try {
      const j = await netJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(q)}&limit=20&offset=0&type=1`);
      best = pickBest((j.result && j.result.songs) || [], qTitle, qArtist);
      if (!best && qArtist) {   // 带歌手没找到，只用歌名再搜
        const j2 = await netJson(`https://music.163.com/api/search/get?s=${encodeURIComponent(qTitle)}&limit=20&offset=0&type=1`);
        best = pickBest((j2.result && j2.result.songs) || [], qTitle, qArtist);
      }
    } catch (e) { console.log('[net:import] search failed for ' + JSON.stringify(q) + ':', e.message); }
    if (best) push({
      onlineId: String(best.id),
      trackName: best.name || '',
      artistName: (best.artists || []).map(a => a.name).join('/'),
      collectionName: (best.album && best.album.name) || '',
      duration: best.duration || 0,
      cover: (best.album && best.album.picUrl) || '',
    });
  }
  // 按名称搜索命中的歌曲补封面：search API 的 album 不带 picUrl（实测为空），
  // 统一走 song/detail 批量补齐
  const needCov = tracks.filter(t => !t.cover).map(t => t.onlineId);
  for (let i = 0; i < needCov.length; i += 100) {
    const cm = await batchCover(needCov.slice(i, i + 100));
    tracks.forEach(t => { if (!t.cover && cm[t.onlineId]) t.cover = cm[t.onlineId]; });
  }
  const totalReq = ids.length + queries.length;
  return { tracks, skipped: Math.max(0, totalReq - tracks.length), playlistUrl };
});
// 批量歌曲详情（封面/时长/专辑）：渲染层启动时给旧版同步/导入的无封面曲目回填用（实测免登录）
ipcMain.handle('net:song-details', async (_e, ids) => {
  const out = {};
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(x => /^\d+$/.test(x));
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    if (!chunk.length) continue;
    try {
      const j = await netJson(`https://music.163.com/api/song/detail?ids=${encodeURIComponent('[' + chunk.join(',') + ']')}`);
      (j.songs || []).forEach(s => {
        if (!s || !s.id) return;
        out[s.id] = {
          cover: (s.album && s.album.picUrl) || '',
          duration: s.duration || 0,
          album: (s.album && s.album.name) || '',
        };
      });
    } catch (e) { console.log('[net:song-details] batch failed:', e.message); }
  }
  return out;
});
// 整曲地址：meting 拿 302 的最终 CDN mp3 地址
ipcMain.handle('net:playurl', async (_e, id) => {
  try {
    const j = await netJson(`https://api.qijieya.cn/meting/?type=song&id=${encodeURIComponent(id)}`);
    const proxyUrl = Array.isArray(j) && j[0] && j[0].url;
    if (!proxyUrl) return null;
    const r = await fetch(proxyUrl, { method: 'HEAD', redirect: 'manual' });
    if (r.status === 301 || r.status === 302) {
      const loc = r.headers.get('location');
      if (loc) return loc.replace(/^http:\/\//, 'https://');
    }
    return proxyUrl.replace(/^http:\/\//, 'https://');
  } catch (e) {
    console.log('[net:playurl] primary failed:', e.message, '- trying direct');
    try {
      const j = await netJson(`https://api.qijieya.cn/meting/?type=song&id=${encodeURIComponent(id)}`);
      return Array.isArray(j) && j[0] && j[0].url ? j[0].url.replace(/^http:\/\//, 'https://') : null;
    } catch (e2) { console.log('[net:playurl] fallback failed:', e2.message); return null; }
  }
});
// 歌词（LRC）— 官方 API 保证 ID 与歌词严格匹配
ipcMain.handle('net:lyric', async (_e, id) => {
  try {
    const j = await netJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=0`);
    const lrc = (j.lrc && j.lrc.lyric) || null;
    if (lrc) {
      // Log first lyric line for debugging
      const firstLine = lrc.split('\n').find(l => l.includes(']'));
      console.log(`[lyric] id=${id} firstLine=${firstLine ? firstLine.substring(0, 60) : 'none'}`);
    }
    return lrc;
  } catch (e) {
    console.log(`[lyric] official failed for id=${id}:`, e.message);
    try {
      const j = await netJson(`https://api.vkeys.cn/v2/music/netease/lyric?id=${encodeURIComponent(id)}`);
      return (j.data && (j.data.lrc || j.data.tlyric)) || j.lrc || null;
    } catch (e2) { console.log('[lyric] vkeys fallback failed:', e2.message); return null; }
  }
});
// 翻译歌词（2026-10-25）：官方 lyric 接口的 tlyric 字段（仅中文歌曲有翻译）
ipcMain.handle('net:tlyric', async (_e, id) => {
  try {
    const j = await netJson(`https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=0&kv=-1&tv=-1`);
    return (j.tlyric && j.tlyric.lyric) || null;
  } catch (e) {
    try {
      const j = await netJson(`https://api.vkeys.cn/v2/music/netease/lyric?id=${encodeURIComponent(id)}`);
      return (j.data && j.data.tlyric) || null;
    } catch (e2) { return null; }
  }
});
// 本地曲目同名 .lrc 歌词
ipcMain.handle('lib:read-lrc', (_e, audioPath) => {
  try {
    return fs.readFileSync(audioPath.replace(/\.[^.]+$/, '.lrc'), 'utf8');
  } catch { return null; }
});

/* ---- QQ 音乐（官方 Web API 直连，免 key）---- */
// 实测 2026-09：搜索/歌词/封面/播放 全链路 200。
// 播放 vkey 仅免费歌曲可解析（VIP 歌曲返回 104003，需登录 cookie）。
const QQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
async function qqJson(url, opts) {
  const r = await fetch(url, Object.assign({ headers: { 'User-Agent': QQ_UA, 'Referer': 'https://y.qq.com/' } }, opts || {}));
  return r.json();
}
// 搜索：官方 soso 接口，真分页每页 50；封面直接拼官方 CDN URL（pmid 去版本后缀）
ipcMain.handle('qq:search', async (_e, word, page) => {
  try {
    const limit = 50;
    const j = await qqJson(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?agg=1&cr=1&p=${page}&n=${limit}&w=${encodeURIComponent(word)}&format=json&new_json=1`);
    const songs = (j.data && j.data.song && j.data.song.list) || [];
    const tracks = songs.map(it => ({
      source: 'qq',
      onlineId: it.mid,                       // songmid
      trackName: it.name || '',
      artistName: (it.singer || []).map(a => a.name).join('/'),
      collectionName: (it.album && it.album.name) || '',
      duration: it.interval || 0,            // 秒
      cover: it.album && it.album.pmid
        ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + String(it.album.pmid).replace(/_\d+$/, '') + '.jpg'
        : '',
    })).filter(t => t.onlineId && t.trackName);
    return { tracks, total: Math.max(songs.length, 0) };
  } catch (e) { console.log('[qq:search] failed:', e.message); return { tracks: [], total: 0 }; }
});
// 整曲地址：musicu.fcg vkey 直连。未登录仅免费歌可解析；带 QQ 登录 cookie 后 VIP 歌也可解析
async function readQQCookies() {
  const map = {};
  // 合并 y.qq.com、ptlogin 与 .qq.com 域：新版扫码登录的 qqmusic_key 写在 .qq.com 域
  for (const url of ['https://y.qq.com', 'https://xui.ptlogin2.qq.com', 'https://ptlogin2.qq.com', 'https://qq.com']) {
    try {
      const list = await authSess().cookies.get({ url }).catch(() => []);
      (Array.isArray(list) ? list : []).forEach(c => { map[c.name] = c.value; });
    } catch (e) { console.log('[qq:cookies] read failed for ' + url + ':', e.message); }
  }
  // ptlogin 域 cookie 带 pt_ 前缀，映射成 vkey/歌单接口要的 uin/p_skey
  if (!map.uin && map.pt_uin) map.uin = map.pt_uin;
  if (!map.p_skey && map.pt_p_skey) map.p_skey = map.pt_p_skey;
  return map;
}
ipcMain.handle('qq:playurl', async (_e, mid) => {
  try {
    const ck = await readQQCookies();
    const uin = ck.uin || '0';
    const logged = !!(ck.uin && (ck.p_skey || ck.qqmusic_key));
    const comm = { uin, format: 'json', ct: 24, cv: 0 };
    const body = JSON.stringify({
      req_1: {
        module: 'vkey.GetVkeyServer', method: 'CgiGetVkey',
        param: {
          filename: [`C400${mid}.m4a`], guid: '10000',
          songmid: [mid], songtype: [0], uin, loginflag: 1, platform: '20',
        },
      },
      loginUin: uin,
      comm,
    });
    const headers = { 'content-type': 'application/json;charset=UTF-8' };
    if (logged) {
      headers['Cookie'] = Object.entries(ck).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    }
    const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', { headers: { 'User-Agent': QQ_UA, 'Referer': 'https://y.qq.com/', ...headers }, method: 'POST', body });
    const j = await r.json();
    const d = j.req_1 && j.req_1.data;
    const m = d && d.midurlinfo && d.midurlinfo[0];
    if (!m || !m.purl) return null;          // VIP/无版权 → 无播放地址
    const sip = Array.isArray(d.sip) ? d.sip[0] : d.sip;
    return (sip || 'https://ws.stream.qqmusic.qq.com/') + m.purl;
  } catch (e) { console.log('[qq:playurl] failed mid=' + mid + ':', e.message); return null; }
});
// 歌词：qijieya 代理（QQ 官方直连歌词接口已限流）
ipcMain.handle('qq:lyric', async (_e, mid) => {
  try {
    const r = await fetch(`https://api.qijieya.cn/meting/?server=tencent&type=lrc&id=${encodeURIComponent(mid)}`, { headers: { 'User-Agent': QQ_UA } });
    const t = await r.text();
    return /^\[ti:|^\[0\d{2}:/.test(t) ? t : null;
  } catch (e) { console.log('[qq:lyric] failed mid=' + mid + ':', e.message); return null; }
});

/* ---- QQ 音乐扫码登录 v3（2026-10-20）----
   纯 Node 单会话，逐行对照 guohuiyuan/music-lib qq/login.go（CheckQRLogin/
   completeQQMusicLogin/followQQLoginRedirects）。
   v2 确认链失败的四个根因（已全部修复）：
   1) cookie 未按域作用域——把 qrsig/pt_login_sig 全塞给 graph/y.qq.com；
   2) 跳转链首跳 Referer 应是 xui.ptlogin2.qq.com/（误用 graph.qq.com/）；
   3) authorize POST 缺 Origin: https://graph.qq.com，Referer 应是
      graph.qq.com/oauth2.0/login_jump；
   4) g_tk 应 = gtk33(p_skey)（初值 5381 的经典 gtk 哈希），v2 误用 hash33（初值 0）。
   流程：warmup xlogin → ptqrshow 取码（模态显示的就是这张图）→
   ptqrtoken=hash33(qrsig) 轮询 → code=0 后：跟随跳转链（≤10 跳，收 cookie）→
   POST authorize 换 code → musicu.fcg QQLogin API → 归一化凭证写 .qq.com 域。 */
async function qqLoggedIn() {
  const ck = await readQQCookies();
  // QQ 新版扫码登录不一定下发 p_skey：.qq.com 域的 qqmusic_key 即为播放凭证
  return !!(ck.uin && (ck.p_skey || ck.qqmusic_key));
}
// ---- 模块级日志（handler 内部函数可能在声明点前执行，TDZ 曾致泵无声死亡）----
function qlog(msg) {
  try { fs.appendFileSync(path.join(__dirname, 'qq_login_debug.log'), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  try { console.log('[QQ-AUTH] ' + msg); } catch {}
}
// ---- Node 会话（独立于任何页面；cookie 按域作用域，仿 Go cookiejar）----
const https = require('https');
const crypto = require('crypto');
const QQ_AUTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const QQ_JS_VER = '26071711';
const QQ_PT_JS_VER = 'c1987b96';
let QQ_JAR = [];                                  // [{name, value, domain}]
let qqAuth = null;                                // { qrsig, loginSig, tok, qrDataUrl, createdAt, state }
let qqAuthTimer = null;
let qqAuthBusy = false;
function qqJarClear() { QQ_JAR = []; }
function qqCookiesFor(host) {
  const out = [];
  for (const c of QQ_JAR) {
    let d = (c.domain || '').toLowerCase();
    if (!d) continue;
    if (d.startsWith('.')) d = d.slice(1);
    if (host === d || host.endsWith('.' + d)) out.push(c.name + '=' + c.value);
  }
  return out.join('; ');
}
function qqJarGet(name) {
  for (let i = QQ_JAR.length - 1; i >= 0; i--) if (QQ_JAR[i].name === name && QQ_JAR[i].value) return QQ_JAR[i].value;
  return '';
}
function qqStoreResponseCookies(setCookie, host) {
  for (const c of (setCookie || [])) {
    const segs = c.split(';');
    const i = segs[0].indexOf('=');
    if (i <= 0) continue;
    const name = segs[0].slice(0, i).trim();
    const value = segs[0].slice(i + 1).trim();
    if (!name || value === '') continue;
    let domain = host;
    for (const s of segs.slice(1)) if (s.trim().toLowerCase().startsWith('domain=')) domain = s.trim().slice(7).trim().toLowerCase();
    QQ_JAR = QQ_JAR.filter((x) => !(x.name === name && x.domain === domain));
    QQ_JAR.push({ name, value, domain });
  }
}
// 经典 gtk 哈希（初值 5381）：music-lib gtk33
function gtk33(s) {
  let h = 5381;
  for (const ch of s) h = (h + (h << 5) + ch.codePointAt(0)) | 0;
  return h & 0x7fffffff;
}
// hash33（初值 0，64 位环绕后 & 0x7fffffff）：music-lib hash33，ptqrtoken 用
function hash33(s) {
  let h = 0n;
  for (const ch of s) h = (h * 33n + BigInt(ch.codePointAt(0))) % (1n << 64n);
  return (Number(h & 0x7fffffffn)).toString();
}
function qqReq(url, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const h = { 'User-Agent': QQ_AUTH_UA, 'Accept': '*/*', ...headers };
    const ck = qqCookiesFor(u.hostname);
    if (ck) h['Cookie'] = ck;
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: body ? 'POST' : 'GET', headers: h, timeout: 15000 }, (res) => {
      qqStoreResponseCookies(res.headers['set-cookie'], u.hostname);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(); } catch {} reject(new Error('timeout')); });
    if (body) { r.write(body); }
    r.end();
  });
}
// 新会话 + 新二维码（music-lib CreateQRLogin；取一次码 = 一个会话）
async function qqCreateSession() {
  qqJarClear();
  await qqReq('https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=716027609&daid=383&style=33&login_text=' + encodeURIComponent('登录') + '&hide_title_bar=1&hide_border=1&target=self&s_url=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&pt_3rd_aid=100497308&pt_feedback_link=https%3A%2F%2Fsupport.qq.com%2Fproducts%2F77942%3FcustomInfo%3D.appid100497308&theme=2&verify_theme=');
  const t = (Date.now() / 1000).toFixed(6);
  const res = await qqReq(
    'https://xui.ptlogin2.qq.com/ssl/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=' + t + '&daid=383&pt_3rd_aid=100497308&u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump',
    { Referer: 'https://xui.ptlogin2.qq.com/' }
  );
  const qrsig = qqJarGet('qrsig');
  const loginSig = qqJarGet('pt_login_sig');
  if (res.status !== 200 || !qrsig) throw new Error('ptqrshow failed: ' + res.status);
  qqAuth = { qrsig, loginSig, tok: hash33(qrsig), createdAt: Date.now(), state: 'wait' };
  qqAuth.qrDataUrl = 'data:image/png;base64,' + res.buf.toString('base64');
  qlog('SESSION new QR ' + res.buf.length + ' bytes');
  return qqAuth;
}
async function qqPushNewQr(reason) {
  try {
    await qqCreateSession();
    if (win && !win.isDestroyed()) win.webContents.send('auth:qr', { img: qqAuth.qrDataUrl, url: '', qq: true });
    qlog('NEWQR ' + (reason || 'initial'));
  } catch (e) {
    qlog('NEWQR err ' + e.message);
    if (win && !win.isDestroyed()) win.webContents.send('auth:qr-error', '获取二维码失败，请点「换一张新码」重试');
  }
}
// 轮询（code：0=确认成功 65=过期 66=等待 67=已扫码待确认）
async function qqPollOnce() {
  if (!qqAuth) return;
  const a = qqAuth;
  const url = 'https://xui.ptlogin2.qq.com/ssl/ptqrlogin?u1=https%3A%2F%2Fgraph.qq.com%2Foauth2.0%2Flogin_jump&ptqrtoken=' + a.tok + '&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-' + Date.now() + '&js_ver=' + QQ_JS_VER + '&js_type=1&login_sig=' + encodeURIComponent(a.loginSig) + '&pt_uistyle=40&aid=716027609&daid=383&pt_3rd_aid=100497308&pt_js_version=' + QQ_PT_JS_VER;
  let res;
  try {
    res = await qqReq(url, { Referer: 'https://xui.ptlogin2.qq.com/' });
  } catch (e) { qlog('NPOLL err ' + e.message); return; }
  const body = res.buf.toString('utf8');
  const m = body.match(/ptuiCB\('([^']*)'/);
  const code = m ? m[1] : '?';
  qlog('NPOLL status=' + res.status + ' code=' + code);
  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  // 会话死了（403/65/68）：换新码
  if (res.status !== 200 || code === '65' || code === '68') {
    if (qqAuthBusy) return;
    send('auth:qr-error', '二维码已过期，正在换新码…');
    qqPushNewQr('dead-' + res.status + '/' + code);
    return;
  }
  const parts = (body.match(/'([^']*)'/g) || []).map((x) => x.slice(1, -1));
  const redirectURL = parts.length > 2 ? parts[2] : '';
  const msg = parts.length > 4 ? parts[4] : '';
  if (code === '0' && redirectURL) {
    if (qqAuthBusy) return;
    qqAuthBusy = true;
    a.state = 'confirm';
    send('auth:qr-state', { state: 'confirm' });
    // 确认已消费：停轮询，专心走完成链
    if (qqAuthTimer) { try { clearInterval(qqAuthTimer); } catch {} qqAuthTimer = null; }
    qqFinishQQLogin(redirectURL).then((ok) => {
      qqAuthBusy = false;
      if (ok) { qqAuth = null; }
      else { a.state = 'wait'; send('auth:qr-error', '登录未完成，请点「换一张新码」重试'); }
    }).catch((e) => { qqAuthBusy = false; qlog('complete err ' + e.message); a.state = 'wait'; send('auth:qr-error', '登录失败，请点「换一张新码」重试'); });
  } else if (code === '67') {
    if (a.state === 'wait') {
      a.state = 'scanned';
      send('auth:qr-state', { state: 'scanned' });
      send('auth:qr-error', '已扫码 — 请在手机 QQ 里点「确认登录」');
    }
  } else {
    qlog('NPOLL RAW ' + msg);
  }
}
// 确认链（music-lib completeQQMusicLogin 逐行对应）
async function qqFinishQQLogin(redirectURL) {
  qlog('CONFIRMED redirect=' + redirectURL.slice(0, 200));
  // 1) 跟随跳转链（≤10 跳），cookie 按域入罐；首跳 Referer = xui.ptlogin2.qq.com/
  let cur = redirectURL;
  let referer = 'https://xui.ptlogin2.qq.com/';
  for (let i = 0; i < 10; i++) {
    let res;
    try { res = await qqReq(cur, { Referer: referer }); } catch (e) { qlog('chain err ' + e.message); return false; }
    const loc = res.headers['location'];
    if (res.status >= 301 && res.status <= 308 && loc) {
      const next = new URL(loc, cur).href;
      qlog('chain ' + (i + 1) + ' → ' + next.slice(0, 160));
      referer = cur;
      cur = next;
      continue;
    }
    break;
  }
  // 2) p_skey（缺失 = 硬失败，music-lib 同款）
  const pSkey = qqJarGet('p_skey');
  if (!pSkey) { qlog('complete: missing p_skey'); return false; }
  // 3) POST authorize 换 code（Origin + Referer 与 music-lib 一致）
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: '100497308',
    redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=' + encodeURIComponent('https://y.qq.com/'),
    scope: 'get_user_info,get_app_friends',
    state: 'state',
    switch: '',
    from_ptlogin: '1',
    src: '1',
    update_auth: '1',
    openapi: '1010_1030',
    g_tk: String(gtk33(pSkey)),
    auth_time: String(Date.now()),
    ui: crypto.randomUUID(),
  }).toString();
  let authURL = 'https://graph.qq.com/oauth2.0/authorize';
  let r;
  try {
    r = await qqReq(authURL, { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://graph.qq.com/oauth2.0/login_jump', Origin: 'https://graph.qq.com' }, form);
  } catch (e) { qlog('authorize err ' + e.message); return false; }
  for (let i = 0; i < 10; i++) {
    const loc = r.headers['location'];
    if (r.status >= 301 && r.status <= 308 && loc) {
      const next = new URL(loc, authURL).href;
      qlog('auth ' + (i + 1) + ' → ' + next.slice(0, 200));
      referer = authURL;
      authURL = next;
      r = await qqReq(authURL, { Referer: referer });
      continue;
    }
    break;
  }
  let code = '';
  try { code = decodeURIComponent(new URL(authURL).searchParams.get('code') || ''); } catch {}
  if (!code) { qlog('authorize: no code (final=' + authURL.slice(0, 200) + ')'); return false; }
  qlog('code obtained');
  // 4) QQLogin API 取音乐 cookie
  const apiRes = await qqReq('https://u.y.qq.com/cgi-bin/musicu.fcg', { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' }, JSON.stringify({ comm: { g_tk: 5381, platform: 'yqq', ct: 24, cv: 0 }, req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } } }));
  const apiTxt = apiRes.buf.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(apiTxt); } catch { qlog('api parse err ' + apiTxt.slice(0, 200)); return false; }
  if (parsed.code !== 0 || !parsed.req || parsed.req.code !== 0) {
    qlog('api err ' + (parsed.req && (parsed.req.message || parsed.req.msg) || parsed.message || parsed.msg) + ' (' + parsed.code + '/' + (parsed.req && parsed.req.code) + ')');
    return false;
  }
  // 5) 归一化凭证：全罐 + 响应 JSON data（music-lib normalizeQQMusicCookies + qqWXLoginDataCookies）
  const norm = {};
  for (const c of QQ_JAR) if (c.value) norm[c.name] = c.value;
  const data = (parsed.req && parsed.req.data) || {};
  const dv = (...keys) => {
    for (const k of keys) {
      const v = data[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && v > 0) return String(v);
    }
    return '';
  };
  const musicID = dv('musicid', 'musicId', 'userid', 'user_id', 'uin');
  const musicKey = dv('musickey', 'music_key', 'qqmusic_key', 'qm_keyst', 'strMusicKey');
  if (musicID) { norm.musicid = musicID; if (!norm.uin) norm.uin = musicID; }
  if (musicKey) { norm.musickey = musicKey; norm.qqmusic_key = musicKey; norm.qm_keyst = musicKey; }
  for (const k of ['refresh_key', 'refreshKey', 'refresh_token', 'refreshToken', 'openid', 'openId', 'wxopenid', 'strOpenid', 'unionid', 'unionId', 'wxunionid', 'strUnionid']) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) norm[k] = v.trim();
  }
  if (!norm.uin) norm.uin = [norm.ptui_loginuin, norm.luin, norm.pt2gguin, norm.superuin, norm.p_uin, norm.musicid, norm.userid, norm.wxuin].find(Boolean) || '';
  if (!norm.qqmusic_key) norm.qqmusic_key = [norm.qm_keyst, norm.musickey, norm.music_key, norm.p_skey, norm.skey].find(Boolean) || '';
  if (!norm.qm_keyst) norm.qm_keyst = [norm.qqmusic_key, norm.musickey, norm.music_key, norm.p_skey, norm.skey].find(Boolean) || '';
  if (!norm.qm_keyst && !norm.qqmusic_key && !norm.musickey) { qlog('complete: no music key'); return false; }
  qlog('LOGIN COMPLETE uin=' + norm.uin + ' keys=[' + ['p_skey', 'skey', 'qqmusic_key', 'qm_keyst'].filter((k) => norm[k]).join(',') + ']');
  // 6) 写入应用会话（.qq.com 域，全域可见）
  const exp = Math.floor(Date.now() / 1000 + LOGIN_COOKIE_TTL);
  for (const name of Object.keys(norm)) {
    if (!norm[name] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    try {
      await authSess().cookies.set({ url: 'https://y.qq.com/', name, value: norm[name], path: '/', domain: '.qq.com', expirationDate: exp, httpOnly: true, secure: true });
    } catch (e) { console.log('[qq:auth] cookie write failed ' + name + ':', e.message); }
  }
  try { await authSess().flushStorageData(); } catch {}
  if (win && !win.isDestroyed()) win.webContents.send('qq:auth:changed', { loggedIn: true, name: 'QQ ' + (norm.uin || '') });
  return true;
}
function qqAuthStop() {
  if (qqAuthTimer) { try { clearInterval(qqAuthTimer); } catch {} qqAuthTimer = null; }
  qqAuth = null;
  qqAuthBusy = false;
}
function qqAuthStart() {
  if (qqAuthTimer) { try { clearInterval(qqAuthTimer); } catch {} qqAuthTimer = null; }
  const tick = () => { if (qqAuth) qqPollOnce().catch(() => {}); };
  qqAuthTimer = setInterval(tick, 2000);
  tick();
}
ipcMain.handle('qq:auth:open', async () => {
  if (!win) return { opened: false };
  qlog('open: pure-Node session v3');
  await qqPushNewQr('open');
  qqAuthStart();
  return { opened: true };
});
ipcMain.handle('qq:auth:status', async () => ({ loggedIn: await qqLoggedIn() }));
ipcMain.on('qq:auth:cancel', () => { qqAuthStop(); qlog('cancel: stop poll'); });
// 手动换码：新会话 + 新二维码（已扫码/确认中不刷，避免作废进行中的流程）
ipcMain.on('qq:auth:refresh', async () => {
  if (qqAuth && qqAuth.state !== 'wait') return;
  qlog('manual refresh: new session');
  await qqPushNewQr('manual');
});
ipcMain.handle('qq:auth:logout', async () => {
  try {
    const QQ_NAMES = ['uin', 'wxuin', 'p_skey', 'skey', 'qqmusic_key', 'qzone_vinfo', 'pt_uin', 'pt_p_skey', 'pt_skey'];
    for (const url of ['https://y.qq.com/', 'https://xui.ptlogin2.qq.com/', 'https://ptlogin2.qq.com/', 'https://qq.com/']) {
      const list = await authSess().cookies.get({ url: url.replace(/\/$/, '') }).catch(() => []);
      for (const c of list) {
        if (!QQ_NAMES.includes(c.name)) continue;
        try { await authSess().cookies.remove(url, c.name); } catch {}
      }
    }
    try { await authSess().flushStorageData(); } catch {}
    if (win && !win.isDestroyed()) win.webContents.send('qq:auth:changed', { loggedIn: false });
  } catch (e) { console.log('[qq:logout] failed:', e.message); }
  return { ok: true };
});

/* ---- QQ 歌单同步（2026-09 实测）----
   歌单列表 music.musicasset.PlaylistBaseRead/GetPlaylistByUin 需 QQ 登录 cookie（uin）。
   歌单详情 music.srfDissInfo.DissInfo/CgiGetDiss 免登录（已验证），song_num 每批 100 循环翻页。 */
async function qqPost(body) {
  const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=UTF-8', 'User-Agent': QQ_UA, 'Referer': 'https://y.qq.com/' },
    body: JSON.stringify(body),
  });
  return r.json();
}
function qqTrackFromSong(it) {
  return {
    source: 'qq',
    onlineId: it.mid,
    trackName: it.name || it.title || '',
    artistName: (it.singer || []).map(a => a.name).join('/'),
    collectionName: (it.album && (it.album.name || it.album.title)) || '',
    duration: (it.interval || 0) * 1000,          // 秒→毫秒，与网易云字段对齐
    cover: (it.album && it.album.pmid)
      ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + String(it.album.pmid).replace(/_\d+$/, '') + '.jpg'
      : '',
  };
}
ipcMain.handle('qq:sync-playlists', async () => {
  const ck = await readQQCookies();
  if (!ck.uin || !(ck.p_skey || ck.qqmusic_key)) return { playlists: [], loggedIn: false };
  try {
    const cookie = Object.entries(ck).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
    const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'content-type': 'application/json;charset=UTF-8', 'User-Agent': QQ_UA, 'Referer': 'https://y.qq.com/', Cookie: cookie },
      body: JSON.stringify({ 'music.musicasset.PlaylistBaseRead': { method: 'GetPlaylistByUin', module: 'music.musicasset.PlaylistBaseRead', param: { uin: ck.uin } } }),
    });
    const j = await r.json();
    const d = j['music.musicasset.PlaylistBaseRead'] && j['music.musicasset.PlaylistBaseRead'].data;
    const arr = (d && (d.v_playlist || d.playlist)) || [];
    const playlists = arr
      .filter(p => p && p.tid && !/我喜欢的音乐|我喜欢$/.test(p.dirName || ''))
      .map(p => ({ id: String(p.tid), name: p.dirName || '歌单', count: p.songNum || 0 }));
    return { playlists, loggedIn: true };
  } catch { return { playlists: [], loggedIn: true }; }
});
ipcMain.handle('qq:playlist-tracks', async (_e, disstid) => {
  if (!disstid) return { tracks: [], name: '' };
  try {
    let name = '';
    const tracks = [];
    let begin = 0;
    for (let i = 0; i < 60; i++) {            // 最多 6000 首，防死循环
      const j = await qqPost({ 'music.srfDissInfo.DissInfo': { method: 'CgiGetDiss', module: 'music.srfDissInfo.DissInfo', param: { disstid: Number(disstid), dirid: 0, tag: true, song_begin: begin, song_num: 100, onlysonglist: false } } });
      const d = j['music.srfDissInfo.DissInfo'] && j['music.srfDissInfo.DissInfo'].data;
      if (!d) break;
      if (!name && d.dirinfo) name = d.dirinfo.title || '';
      const sl = d.songlist || [];
      for (const sg of sl) {
        const t = qqTrackFromSong(sg);
        if (t.onlineId && t.trackName) tracks.push(t);
      }
      const total = d.total_song_num || 0;
      begin += sl.length;
      if (!sl.length || begin >= total || begin >= 6000) break;
    }
    return { tracks, name };
  } catch { return { tracks: [], name: '' }; }
});
// QQ 登录 cookie 持久化（uin/p_skey 是会话 cookie，固化到磁盘，重启免扫码）
async function persistQQCookies() {
  const QQ_NAMES = ['uin', 'wxuin', 'p_skey', 'skey', 'qqmusic_key', 'qzone_vinfo', 'pt_uin', 'pt_p_skey', 'pt_skey'];
  try {
    const now = Date.now() / 1000;
    const target = Math.floor(now + LOGIN_COOKIE_TTL);
    let changed = 0;
    for (const url of ['https://y.qq.com', 'https://xui.ptlogin2.qq.com', 'https://ptlogin2.qq.com', 'https://qq.com']) {
      const list = await authSess().cookies.get({ url }).catch(() => []);
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        if (!QQ_NAMES.includes(c.name)) continue;
        if (c.expirationDate && c.expirationDate > now) continue;
        const o = { url: url + '/', name: c.name, value: c.value, path: c.path || '/', expirationDate: target };
        if (c.domain) o.domain = c.domain;
        if (c.secure) o.secure = true;
        if (c.httpOnly) o.httpOnly = true;
        try { await authSess().cookies.set(o); changed++; } catch {}
      }
    }
    try { await authSess().flushStorageData(); } catch {}
    return changed;
  } catch { return 0; }
}

/* ---- 网易云登录同步（persist:auth partition，cookie 自动落盘，重启免扫码）---- */
const AUTH_PARTITION = 'persist:auth';           // 持久化会话：cookie 落盘，重启自动恢复
let authSession = null;
function authSess() {
  if (!authSession) authSession = session.fromPartition(AUTH_PARTITION, { cache: false });
  return authSession;
}

// 把登录相关 cookie 变成"持久 cookie"：给没有有效期（或快到期）的 music.163.com
// cookie 重新设一个长有效期，使其真正写入磁盘，重启后仍在。
// 幂等，可安全多次调用（扫码后、种子迁移后、每次启动都调）。
const LOGIN_COOKIE_TTL = 90 * 24 * 3600; // 90 天
const LOGIN_KEY_COOKIES = new Set(['MUSIC_U', 'nickname', 'nickname_163', '__csrf', 'JSESSIONID', 'JSESSIONID-WYYY', 'MUSIC_A', 'MUSIC_F']);
async function persistLoginCookies() {
  try {
    const list = await authSess().cookies.get({ url: 'https://music.163.com' }).catch(() => []);
    if (!Array.isArray(list) || list.length === 0) return 0;
    const now = Date.now() / 1000;
    const target = now + LOGIN_COOKIE_TTL;
    let changed = 0;
    for (const c of list) {
      // 只处理登录相关、且"仍是会话 cookie（无有效期）或已过期/快过期"的
      const important = LOGIN_KEY_COOKIES.has(c.name) || c.name.indexOf('MUSIC_') === 0;
      if (!important) continue;
      if (c.expirationDate && c.expirationDate > now) continue; // 已是持久 cookie，跳过
      const o = { url: 'https://music.163.com/', name: c.name, value: c.value, path: c.path || '/', expirationDate: Math.floor(target) };
      if (c.domain) o.domain = c.domain;
      if (c.secure) o.secure = true;
      if (c.httpOnly) o.httpOnly = true;
      try { await authSess().cookies.set(o); changed++; } catch {}
    }
    try { await authSess().flushStorageData(); } catch {}
    return changed;
  } catch { return 0; }
}

// 一次性登录种子：首次迁移（把先前导出的真实 cookie 填入 persist:auth，避免重扫）。
// 仅在"持久分区尚无 MUSIC_U"且"种子文件存在"时执行；迁移后持久化并删除种子文件。
const AUTH_SEED_FILE = path.join(app.getPath('temp'), 'mh_auth_seed.json');
async function seedAuthOnce() {
  try {
    if (!fs.existsSync(AUTH_SEED_FILE)) return;
    const cur = await authSess().cookies.get({ url: 'https://music.163.com' }).catch(() => []);
    if (cur.some(c => c.name === 'MUSIC_U')) { fs.unlinkSync(AUTH_SEED_FILE); return; } // 已登录，种子作废
    const seed = JSON.parse(fs.readFileSync(AUTH_SEED_FILE, 'utf-8'));
    let ok = 0;
    for (const c of seed) {
      const o = { url: 'https://music.163.com/', name: c.name, value: c.value, path: c.path || '/' };
      if (c.domain) o.domain = c.domain;
      if (c.httpOnly) o.httpOnly = true;
      if (c.secure) o.secure = true;
      // 全部给长有效期 → 落盘持久化（种子 cookie 本身是会话 cookie，无有效期会丢）
      o.expirationDate = Math.floor(Date.now() / 1000) + LOGIN_COOKIE_TTL;
      try { await authSess().cookies.set(o); ok++; } catch {}
    }
    if (ok > 0) {
      try { await authSess().flushStorageData(); } catch {}
      fs.unlinkSync(AUTH_SEED_FILE);   // 用后即焚
    }
  } catch (e) { console.log('[qq:seed] apply failed:', e.message); }
}
async function readAuthCookies() {
  // 读 persist:auth 分区里 music.163.com 的 cookie（登录抽屉与该分区共享）。
  // 注意：Electron 33 移除了 session.getCookies()，必须用 session.cookies.get({url})。
  const sess = authSess();
  const list = await new Promise((resolve) => {
    const url = 'https://music.163.com';
    const fallback = () => resolve([]);
    try {
      if (sess.cookies && typeof sess.cookies.get === 'function') {
        // Electron 33+ 新 API：返回 Promise<Array<Cookie>>
        Promise.resolve(sess.cookies.get({ url })).then(resolve).catch(fallback);
        return;
      }
    } catch { /* fall through */ }
    try {
      // 旧版回退：session.getCookies(filter)
      Promise.resolve(sess.getCookies({ url })).then(resolve).catch(fallback);
      return;
    } catch { resolve([]); }
  });
  const map = {};
  (Array.isArray(list) ? list : []).forEach(c => { map[c.name] = c.value; });
  // 内存兜底：抽屉不可达时，用 doCheck 成功时缓存的 authMUSICU 继续提供登录态。
  if (!map.MUSIC_U && authMUSICU) map.MUSIC_U = authMUSICU;
  if (!map.nickname && authName) map.nickname = authName;
  return map;
}
async function refreshAuthState() {
  const c = await readAuthCookies();
  authMUSICU = c.MUSIC_U || null;
  authName = c.nickname ? decodeURIComponent(c.nickname) : (c._csrf ? '已登录' : '');
  if (!authName) authName = authMUSICU ? '已登录' : '';
  return { loggedIn: !!authMUSICU, name: authName };
}
// 打开登录：隐藏登录会话加载官方登录页，把二维码抽出来推到渲染端居中显示
const QR_EXTRACT_JS = `(() => {
  const g = document.getElementById('g_iframe');
  if (g && g.contentDocument) {
    const cs = g.contentDocument.querySelectorAll('canvas');
    for (const c of cs) { const r = c.getBoundingClientRect(); if (r.width >= 80) { try { return { type: 'canvas', dataUrl: c.toDataURL() }; } catch (e) { return { type: 'err', msg: String(e).slice(0, 80) }; } } }
  }
  const cs2 = document.querySelectorAll('canvas');
  for (const c of cs2) { const r = c.getBoundingClientRect(); if (r.width >= 80) { try { return { type: 'canvas', dataUrl: c.toDataURL() }; } catch (e) { return { type: 'err', msg: String(e).slice(0, 80) }; } } }
  const im = document.querySelector('img[data-qrcode]') || document.querySelector('.login-qrcode img, .qrcode img, .qr-code img');
  if (im) return { type: 'img', src: im.src };
  return { type: 'none' };
})()`;
const QR_EXPIRED_JS = `(document.body && document.body.innerText && /二维码已过期|不存在或已过期|刷新二维码/.test(document.body.innerText) ? 1 : 0)`;
ipcMain.handle('auth:open', async () => {
  const vc = ensureDrawer(hiddenBounds());   // 离屏画二维码（canvas 离屏可抽）
  if (!vc) return { opened: false };
  const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
  let expired = false;
  const pumpQr = async () => {
    try {
      const r = await Promise.race([vc.executeJavaScript(QR_EXTRACT_JS), new Promise((_, rj) => setTimeout(() => rj(null), 5000))]);
      if (r && (r.type === 'canvas' || r.type === 'img')) send('auth:qr', r);
      const ex = await Promise.race([vc.executeJavaScript(QR_EXPIRED_JS), new Promise((_, rj) => setTimeout(() => rj(0), 5000))]);
      if (ex) {
        if (!expired) {
          expired = true;
          send('auth:qr-error', '二维码已过期，请重新获取');
          vc.loadURL('https://music.163.com/#/login');     // 自动刷新拿新码
          setTimeout(() => { expired = false; }, 1500);
        }
      }
    } catch (e) { if (!/destroy/i.test(String(e && e.message))) console.log('[net:qr] pump failed:', e.message); }
  };
  vc.removeAllListeners('did-finish-load');
  vc.on('did-finish-load', () => { pumpQr(); setTimeout(pumpQr, 2500); });
  vc.loadURL('https://music.163.com/#/login');
  // 定期检测登录态（扫码确认后跳转主站，cookie 写入该 partition）
  const doCheck = async () => {
    if (!drawerView) return false;                    // 抽屉已移除 → 停止轮询
    const st = await refreshAuthState();
    if (st.loggedIn) {
      try {
        await persistLoginCookies();               // 扫码写入的是会话 cookie，立即固化到磁盘
        win.webContents.send('auth:changed', st);
        drawerClose();
      } catch (e) { console.log('[net:auth] persist failed, will retry:', e.message); return false; }
      return true;
    }
    return false;
  };
  const timer = setInterval(async () => { if (await doCheck()) clearInterval(timer); }, 2500);
  // 兜底：15 分钟内未登录则停止轮询并收起（避免残留定时器）
  setTimeout(() => { clearInterval(timer); drawerClose(); }, 15 * 60 * 1000);
  return { opened: true };
});
ipcMain.handle('auth:status', async () => refreshAuthState());
// 用户点「关闭」二维码弹窗：收起隐藏登录会话
ipcMain.on('auth:cancel-login', () => {
  drawerClose();
});
// 用户点「收起」按钮：移除主窗口右侧内嵌抽屉
ipcMain.on('drawer:close', () => drawerClose());
ipcMain.handle('auth:logout', async () => {
  try { await authSess().clearStorageData(); } catch {}
  authMUSICU = null; authName = '';
  const st = { loggedIn: false, name: '' };
  win.webContents.send('auth:changed', st);
  return st;
});

/* ---- 歌单同步：官方 web API 直连（带 persist:auth 登录 cookie），零 DOM 抓取 ----
   实测链路（2026-09，全部 HTTP 200）：
   · GET /api/user/playlist?uid=0&limit=1000 → 我创建的歌单（uid=0 自动解析为登录用户）
   · GET /api/v6/playlist/detail?id=<cid>    → playlist.trackIds（全量）
   · GET /api/v3/song/detail?c=[{"id":n},...] → songs[]（name/ar/dt；artists 字段常为空，用 ar）
   注意：/weapi/* 加密接口在本环境静默 200 空响应（风控），别走加密路线；
        歌名取 song.name（部分 VIP 歌可能混淆时回退 arName）。 */
const NE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
async function neApiGet(path) {
  const c = await readAuthCookies();
  if (!c.MUSIC_U) return null;
  // Cookie header 必须是 ByteString：中文字符（nickname 等）必须 percent-encode，
  // 否则 fetch 直接抛 "Cannot convert argument to a ByteString"。
  const cookie = Object.entries(c)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://music.163.com' + path, {
      headers: { Cookie: cookie, 'User-Agent': NE_UA, 'Referer': 'https://music.163.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}
// 我创建的歌单列表（uid=0 → 服务端自动解析当前登录用户）
async function getPlaylists() {
  const j = await neApiGet('/api/user/playlist?uid=0&limit=1000&offset=0');
  if (!j || j.code !== 200 || !Array.isArray(j.playlist)) return [];
  return j.playlist.map(pl => ({
    id: String(pl.id),
    name: pl.name || '',
    count: pl.trackCount || 0,
    cover: pl.coverImgUrl || '',
  }));
}
// 歌单全量曲目（trackIds 分页 + song/detail 每批 100 首）
// 封面修复（2026-10-22）：v3 song/detail 只返回 name/ar/dt、无封面；
// 追加 v1 song/detail 批量（与 batchCover 同源，免登录）回填 cover/duration/album
async function getPlaylistTracks(cid) {
  const id = String(cid);
  if (!id) return [];
  const d = await neApiGet('/api/v6/playlist/detail?id=' + id);
  if (!d || d.code !== 200 || !d.playlist) return [];
  const trackIds = d.playlist.trackIds || [];
  const tracks = [];
  const byId = {};
  for (let i = 0; i < trackIds.length; i += 100) {
    const batch = trackIds.slice(i, i + 100);
    const c = JSON.stringify(batch.map(t => ({ id: t.id })));
    const s = await neApiGet('/api/v3/song/detail?c=' + encodeURIComponent(c));
    const songs = (s && Array.isArray(s.songs)) ? s.songs : [];
    for (const sg of songs) {
      if (!sg || sg.name === null) continue;   // VIP 不可见歌 name=null，跳过
      const ar = (sg.ar || sg.artists || []).map(a => a.name).join(' ');
      const t = {
        onlineId: String(sg.id),
        trackName: (sg.name || '') + (ar ? ' ' + ar : ''),
        dur: sg.dt ? Math.round(sg.dt / 1000) + 's' : '',
      };
      tracks.push(t);
      byId[t.onlineId] = t;
    }
  }
  // 封面/时长/专辑批量回填（v1 song/detail，每批 100）
  const ids = Object.keys(byId);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const s2 = await neApiGet('/api/song/detail?ids=' + encodeURIComponent('[' + chunk.join(',') + ']'));
    const songs2 = (s2 && Array.isArray(s2.songs)) ? s2.songs : [];
    for (const sg2 of songs2) {
      const t = byId[String(sg2 && sg2.id)];
      if (!t) continue;
      if (sg2.album && sg2.album.picUrl) t.cover = sg2.album.picUrl;
      if (sg2.duration) t.duration = sg2.duration;
      if (sg2.album && sg2.album.name) t.collectionName = sg2.album.name;
    }
  }
  return tracks;
}

ipcMain.handle('auth:sync-playlists', async () => {
  const c = await readAuthCookies();
  if (!c.MUSIC_U) return { playlists: [], loggedIn: false };
  try {
    const playlists = await getPlaylists();
    return { playlists, loggedIn: true };
  } catch { return { playlists: [], loggedIn: true }; }
});

/* ---- 自动歌单同步（#1，2026-11-20）：渲染进程启动时静默调用，
   两个平台各查一次（有登录态才查），渲染进程按自身登录状态应用 ---- */
ipcMain.handle('auto:sync-playlists', async () => {
  const out = { qq: null, ne: null };
  try {
    const ck = await readQQCookies();
    if (ck.uin && (ck.p_skey || ck.qqmusic_key)) {
      const cookie = Object.entries(ck).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
      const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        headers: { 'content-type': 'application/json;charset=UTF-8', 'User-Agent': QQ_UA, 'Referer': 'https://y.qq.com/', Cookie: cookie },
        body: JSON.stringify({ 'music.musicasset.PlaylistBaseRead': { method: 'GetPlaylistByUin', module: 'music.musicasset.PlaylistBaseRead', param: { uin: ck.uin } } }),
      });
      const j = await r.json();
      const d = j['music.musicasset.PlaylistBaseRead'] && j['music.musicasset.PlaylistBaseRead'].data;
      const arr = (d && (d.v_playlist || d.playlist)) || [];
      out.qq = arr.filter(p => p && p.tid).map(p => ({ id: String(p.tid), name: p.dirName || '歌单', count: p.songNum || 0 }));
    }
  } catch (e) { console.log('[auto:sync] qq failed:', e.message); }
  try {
    const c = await readAuthCookies();
    if (c.MUSIC_U) {
      const pls = await getPlaylists();
      if (pls.length) out.ne = pls;
    }
  } catch (e) { console.log('[auto:sync] ne failed:', e.message); }
  return out;
});

ipcMain.handle('auth:playlist-tracks', async (_e, cid) => {
  const c = await readAuthCookies();
  if (!c.MUSIC_U || !cid) return { tracks: [], name: '' };
  try {
    const tracks = await getPlaylistTracks(cid);
    return { tracks, name: '' };
  } catch { return { tracks: [], name: '' }; }
});
