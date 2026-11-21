const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaxState: (cb) => ipcRenderer.on('win:max-state', (_e, v) => cb(v)),
  // 本地音乐库
  pickLibrary: () => ipcRenderer.invoke('lib:open-folder'),
  rescanFolder: (dir) => ipcRenderer.invoke('lib:scan', dir),
  importLibFiles: (paths, destDir) => ipcRenderer.invoke('lib:import-files', paths, destDir),
  onLibChanged: (cb) => ipcRenderer.on('lib:changed', (_e, d) => cb(d)),
  // 在线整曲（网易云，免 key）
  netSearch: (word, page, num) => ipcRenderer.invoke('net:search', word, page, num),
  netPlayUrl: (id) => ipcRenderer.invoke('net:playurl', id),
  netLyric: (id) => ipcRenderer.invoke('net:lyric', id),
  netTlyric: (id) => ipcRenderer.invoke('net:tlyric', id),
  netArtists: (word, limit) => ipcRenderer.invoke('net:artists', word, limit),
  netArtistSongs: (artistId, artistName, limit) => ipcRenderer.invoke('net:artist-songs', artistId, artistName, limit),
  netImport: (text) => ipcRenderer.invoke('net:import', text),
  netSongDetails: (ids) => ipcRenderer.invoke('net:song-details', ids),
  // QQ 音乐（官方 Web API 直连，免 key）
  qqSearch: (word, page) => ipcRenderer.invoke('qq:search', word, page),
  qqPlayUrl: (mid) => ipcRenderer.invoke('qq:playurl', mid),
  qqLyric: (mid) => ipcRenderer.invoke('qq:lyric', mid),
  // QQ 扫码登录（VIP 歌曲播放需要登录态）
  qqAuthOpen: () => ipcRenderer.invoke('qq:auth:open'),
  qqAuthStatus: () => ipcRenderer.invoke('qq:auth:status'),
  qqAuthCancel: () => ipcRenderer.send('qq:auth:cancel'),
  qqAuthRefresh: () => ipcRenderer.send('qq:auth:refresh'),
  qqAuthLogout: () => ipcRenderer.invoke('qq:auth:logout'),
  onQQAuthChanged: (cb) => ipcRenderer.on('qq:auth:changed', (_e, st) => cb(st)),
  // QQ 歌单同步（需 QQ 登录；歌单详情免登录）
  qqSync: () => ipcRenderer.invoke('qq:sync-playlists'),
  qqPlaylistTracks: (disstid) => ipcRenderer.invoke('qq:playlist-tracks', disstid),
  // 登录同步（cookie 仅内存，不落盘）
  authOpen: () => ipcRenderer.invoke('auth:open'),
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  authSync: () => ipcRenderer.invoke('auth:sync-playlists'),
  authPlaylistTracks: (cid) => ipcRenderer.invoke('auth:playlist-tracks', cid),
  onAuthChanged: (cb) => ipcRenderer.on('auth:changed', (_e, st) => cb(st)),
  // 扫码登录（居中二维码模态）
  authCancelLogin: () => ipcRenderer.send('auth:cancel-login'),
  onQrImage: (cb) => ipcRenderer.on('auth:qr', (_e, data) => cb(data)),
  onQrError: (cb) => ipcRenderer.on('auth:qr-error', (_e, msg) => cb(msg)),
  onQrRestore: (cb) => ipcRenderer.on('auth:qr-restore', (_e) => cb()),
  onQrState: (cb) => ipcRenderer.on('auth:qr-state', (_e, d) => cb(d && d.state)),
  readLrc: (p) => ipcRenderer.invoke('lib:read-lrc', p),
  // 下载到本地（2026-10-21）
  pickDownloadDir: () => ipcRenderer.invoke('dir:pick'),
  netDownload: (url, dir, name) => ipcRenderer.invoke('net:download', { url, dir, name }),
  onDlProgress: (cb) => ipcRenderer.on('dl:progress', (_e, d) => cb(d)),
  // 托盘（2026-10-21）
  trayState: (d) => ipcRenderer.send('tray:state', d),
  onTrayCtrl: (cb) => ipcRenderer.on('tray:ctrl', (_e, a) => cb(a)),
  // 迷你播放窗（2026-10-25）
  miniToggle: () => ipcRenderer.invoke('mini:toggle'),
  miniState: (s) => ipcRenderer.invoke('mini:state', s),
  onMiniCmd: (cb) => ipcRenderer.on('mini:cmd', (_e, c) => cb(c)),
  onMiniToggle: (cb) => ipcRenderer.on('mini:toggle', (_e) => cb()),
  // 歌单自动同步 + 切歌通知（2026-11-20）
  autoSync: () => ipcRenderer.invoke('auto:sync-playlists'),
  notifyTrack: (d) => ipcRenderer.send('notify:track', d),
  // 早起闹钟 + 显示窗口（#9，2026-11-21）
  armWake: (hm) => ipcRenderer.send('wake:arm', hm),
  disarmWake: () => ipcRenderer.send('wake:disarm'),
  onWake: (cb) => ipcRenderer.on('wake:fire', () => cb()),
  winShow: () => ipcRenderer.send('win:show'),
  // 自动更新（#12，2026-11-21）
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.send('update:install'),
  onUpdateState: (cb) => ipcRenderer.on('update:state', (_e, d) => cb(d && d.state, d && d.detail)),
  isDesktop: true,
});