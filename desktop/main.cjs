const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell, screen } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { atomicWriteProject } = require('./atomic-save.cjs');
const { readBounded } = require('./bounded-read.cjs');
const { contentPolicy } = require('./content-policy.cjs');

const APP_URL = 'app://orbit/';
const APP_NAME = 'Orbit Lab';
const APP_ID = 'com.orbitlab.app';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
let mainWindow, calculationBusy = false, nativeBusy = 0, closePrompt = false;
const codec = import(pathToFileURL(path.join(__dirname, '..', 'src', 'project.js')).href);

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// Stable profile and origin preserve user data across ordinary app updates.
const profileOverride = process.env.ORBIT_LAB_DATA_DIR;
if (profileOverride && !path.isAbsolute(profileOverride)) throw new Error('ORBIT_LAB_DATA_DIR must be absolute');
app.setPath('userData', profileOverride || path.join(app.getPath('appData'), APP_NAME));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
} }]);

function log(message) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* Logging is optional. */ }
}
function trustedURL(value) {
  try { const url = new URL(value); return url.protocol === 'app:' && url.host === 'orbit' && !url.username && !url.password; }
  catch { return false; }
}
function trustedSender(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !trustedURL(event.senderFrame?.url)) {
    throw new Error('Invalid application sender');
  }
}
function command(value) { mainWindow?.webContents.send('orbit:command', value); }
function safeFileName(value) {
  let name = path.basename(typeof value === 'string' ? value : '궤도 실험.orbit.json')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 160);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `orbit-${name}`;
  return name || '궤도 실험.orbit.json';
}
async function projectTarget(target, allowMissing = false) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('실험 파일의 절대 경로를 확인해 주세요.');
  if (process.platform === 'win32' && path.basename(target).includes(':')) throw new Error('일반 파일을 선택해 주세요.');
  const parent = path.dirname(target), realParent = await fsp.realpath(parent);
  const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalized(parent) !== normalized(realParent)) throw new Error('연결된 폴더 대신 원래 실험 파일 폴더를 선택해 주세요.');
  let stat;
  try { stat = await fsp.lstat(target); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('폴더나 연결 파일 대신 일반 JSON 파일을 선택해 주세요.');
  return stat;
}

async function serveBundle(request) {
  if (!trustedURL(request.url)) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
  try {
    const testBundle = !app.isPackaged && process.env.ORBIT_DESKTOP_TEST === '1';
    const root = path.join(app.getAppPath(), testBundle ? 'output/desktop-test-bundle' : 'dist');
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || pathname.includes('\0')) {
      return new Response('Forbidden', { status: 403 });
    }
    const actual = await fsp.realpath(target), actualRelative = path.relative(root, actual);
    if (!actualRelative || actualRelative.startsWith('..') || path.isAbsolute(actualRelative)) {
      return new Response('Forbidden', { status: 403 });
    }
    const data = await fsp.readFile(actual);
    return new Response(request.method === 'HEAD' ? null : data, { headers: {
      'Content-Type': mime[path.extname(actual)] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': `${contentPolicy}; frame-ancestors 'none'`,
    } });
  } catch { return new Response('Not found', { status: 404 }); }
}

function registerFileActions() {
  ipcMain.on('orbit:busy', (event, busy) => {
    try { trustedSender(event); calculationBusy = busy === true; } catch { /* Ignore unrelated frames. */ }
  });
  ipcMain.handle('orbit:open-project', async event => {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    nativeBusy++;
    try {
      const { MAX_PROJECT_BYTES, parseProject } = await codec;
      const result = await dialog.showOpenDialog(mainWindow, { title: '궤도 실험 열기',
        properties: ['openFile'], filters: [{ name: '궤도 실험 JSON', extensions: ['json'] }] });
      if (result.canceled || !result.filePaths[0]) return { canceled: true };
      const target = result.filePaths[0], stat = await projectTarget(target);
      if (stat.size > MAX_PROJECT_BYTES) throw new Error('실험 파일은 10 MiB 이하인 JSON 파일이어야 합니다.');
      const flags = fs.constants;
      const handle = await fsp.open(target, flags.O_RDONLY | (flags.O_NOFOLLOW || 0) | (flags.O_NONBLOCK || 0));
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > MAX_PROJECT_BYTES || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('실험 파일이 변경되었습니다. 다시 선택해 주세요.');
        bytes = await readBounded(handle, MAX_PROJECT_BYTES);
      } finally { await handle.close(); }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return { canceled: false, project: parseProject(text) };
    } finally { nativeBusy--; }
  });
  async function save(event, payload, original) {
    trustedSender(event);
    if (nativeBusy) return { canceled: true };
    if (!payload || typeof payload !== 'object') throw new Error('실험 파일 내용을 확인해 주세요.');
    nativeBusy++;
    try {
      const { checkProjectTextSize, parseProject } = await codec;
      const { contents } = payload;
      const extension = original ? 'txt' : 'json';
      if (original) checkProjectTextSize(contents);
      else parseProject(contents);
      const name = original ? 'orbit-lab-original.txt' : safeFileName(payload.name);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: original ? '자동 저장 원문 보관' : '궤도 실험 저장',
        defaultPath: path.join(app.getPath('documents'), name.toLowerCase().endsWith('.' + extension) ? name : name + '.' + extension),
        filters: [{ name: original ? '텍스트' : '궤도 실험 JSON', extensions: [extension] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      if (path.extname(result.filePath).toLowerCase() !== '.' + extension) throw new Error(`.${extension} 확장자로 저장해 주세요.`);
      await atomicWriteProject(result.filePath, contents, { validateTarget: target => projectTarget(target, true) });
      return { canceled: false };
    } finally {
      nativeBusy--;
    }
  }
  ipcMain.handle('orbit:save-project', (event, payload) => save(event, payload, false));
  ipcMain.handle('orbit:export-original', (event, contents) => save(event, { contents }, true));
}

function createMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '파일', submenu: [
      { label: '새 실험', accelerator: 'CmdOrCtrl+N', click: () => command('new-project') },
      { label: '실험 열기…', accelerator: 'CmdOrCtrl+O', click: () => command('open-project') },
      { label: '실험 저장…', accelerator: 'CmdOrCtrl+S', click: () => command('save-project') },
      { type: 'separator' }, { label: '종료', accelerator: 'Alt+F4', click: () => mainWindow?.close() },
    ] },
    { label: '편집', submenu: [{ label: '실행 취소', role: 'undo' }, { label: '다시 실행', role: 'redo' },
      { type: 'separator' }, { label: '잘라내기', role: 'cut' }, { label: '복사', role: 'copy' },
      { label: '붙여넣기', role: 'paste' }, { label: '전체 선택', role: 'selectAll' }] },
    { label: '실험', submenu: [
      { label: '궤도 재생 / 일시정지', accelerator: 'CmdOrCtrl+Shift+P', click: () => command('toggle-play') },
    ] },
    { label: '보기', submenu: [
      { label: '3D 크게 보기', accelerator: 'CmdOrCtrl+Shift+F', click: () => command('focus') },
      { type: 'separator' }, { label: '실제 크기', role: 'resetZoom' }, { label: '확대', role: 'zoomIn' },
      { label: '축소', role: 'zoomOut' }, { label: '전체 화면', accelerator: 'F11', role: 'togglefullscreen' },
    ] },
    { label: '도움말', submenu: [
      { label: '사용 안내', accelerator: 'F1', click: () => command('help') },
      { label: '저장 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
      { label: '프로그램 정보', click: () => dialog.showMessageBox(mainWindow, { type: 'info', title: APP_NAME,
        message: `${APP_NAME} ${app.getVersion()}`,
        detail: '고정된 태양 주위의 이상적인 원·타원 궤도와 공전 속력·주기·같은 시간의 쓸린 면적을 관찰하는 교육용 실험 앱입니다.\n\n질량이 무시되는 입자 하나와 한 궤도면을 사용합니다. 실제 날짜의 천체 위치·다체 상호작용·충돌·추력·궤도 전이·탈출을 계산하지 않습니다. 태양과 입자의 크기는 관찰용으로 확대했습니다.\n\n화면 1초당 모형 5·15·30일의 공통 배율을 사용합니다. 조건 변경은 새로운 이상 궤도 선택이며 기동이 아닙니다. 파일은 궤도 조건·공전 위치·비교·시점·관찰 배율을 보관하고 정지 상태로 복원합니다.', buttons: ['확인'] }) },
    ] },
  ]));
}

function windowBounds(saved) {
  const primary = screen.getPrimaryDisplay().workArea;
  const number = (value, fallback) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1000000, Math.min(1000000, Math.round(value))) : fallback;
  const candidate = { x: number(saved.x, primary.x), y: number(saved.y, primary.y),
    width: Math.max(100, Math.min(32768, number(saved.width, 1440))),
    height: Math.max(100, Math.min(32768, number(saved.height, 1000))) };
  const area = screen.getDisplayMatching(candidate).workArea;
  const minWidth = Math.min(960, area.width), minHeight = Math.min(640, area.height);
  const width = Math.max(minWidth, Math.min(candidate.width, area.width));
  const height = Math.max(minHeight, Math.min(candidate.height, area.height));
  const x = Math.max(area.x, Math.min(number(saved.x, area.x + (area.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(number(saved.y, area.y + (area.height - height) / 2), area.y + area.height - height));
  return { x, y, width, height, minWidth, minHeight };
}

function restoreWindowBounds(window, preferred) {
  const keys = ['x', 'y', 'width', 'height'];
  const requested = Object.fromEntries(keys.map(key => [key, preferred[key]]));
  // On Windows at fractional DPI, setBounds/getNormalBounds can differ by a DIP
  // because the native frame rounds its edges to physical pixels. Restore the
  // saved *actual* rectangle, rather than feeding that rounding error into the
  // next saved size. Keep the correction bounded if the OS constrains a window.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested);
    if (process.platform !== 'win32') break;
    const actual = window.getNormalBounds();
    const differences = keys.map(key => preferred[key] - actual[key]);
    if (differences.every(value => value === 0) || differences.some(value => Math.abs(value) > 2)) break;
    keys.forEach((key, index) => { requested[key] += differences[index]; });
  }
}

function createWindow() {
  let saved = {};
  try { const value = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value; } catch { /* First launch. */ }
  const preferredBounds = windowBounds(saved);
  mainWindow = new BrowserWindow({ ...preferredBounds, title: APP_NAME, show: false,
    backgroundColor: '#101820', icon: path.join(__dirname, '..', 'resources', 'app.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-frame-navigate', event => {
    if (!event.isMainFrame || !trustedURL(event.url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    calculationBusy = false; log(`Renderer ended: ${details.reason}`);
    dialog.showMessageBox(mainWindow, { type: 'error', title: APP_NAME, message: '화면을 계속 표시하지 못했습니다.',
      detail: '저장된 관찰 설정은 유지됩니다. 프로그램을 다시 시작해 주세요.', buttons: ['확인'] });
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    log(`Load failed: ${code} ${description} ${url}`);
    dialog.showErrorBox(APP_NAME, '프로그램 파일을 읽지 못했습니다. 설치 파일로 다시 설치해 주세요.'); app.quit();
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Correct the visible normal frame before maximizing so its restored size
    // also stays stable when the app was closed maximized.
    restoreWindowBounds(mainWindow, preferredBounds);
    if (saved.maximized === true) mainWindow.maximize();
  });
  mainWindow.on('close', event => {
    if (calculationBusy || nativeBusy) {
      event.preventDefault(); if (closePrompt) return; closePrompt = true;
      dialog.showMessageBox(mainWindow, { type: 'warning', title: '작업 진행 중',
        message: '자료 처리 또는 파일 작업이 진행 중입니다.', detail: '작업이 끝난 후 창을 닫아 주세요.',
        buttons: ['작업 계속', '작업 중단 후 종료'], defaultId: 0, cancelId: 0, noLink: true,
      }).then(({ response }) => { closePrompt = false; if (response === 1) app.exit(0); }).catch(() => { closePrompt = false; });
      return;
    }
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify({
      ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized(),
    })); } catch { /* Window layout is optional. */ }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  createMenu(); mainWindow.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus();
  } });
  app.whenReady().then(async () => {
    protocol.handle('app', serveBundle);
    session.defaultSession.webRequest.onBeforeRequest(
      (details, callback) => callback({ cancel: !trustedURL(details.url) }));
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    registerFileActions(); createWindow(); log(`Started ${app.getVersion()}`);
  }).catch(error => { log(`Startup failed: ${error.stack}`);
    dialog.showErrorBox(APP_NAME, `프로그램을 시작하지 못했습니다.\n${error.message}`); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
