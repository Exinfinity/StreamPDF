import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';

globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

const { EventBus, PDFViewer, PDFLinkService } = await import(
  '/vendor/pdfjs/web/pdf_viewer.mjs'
);

const DEFAULT_CONFIG = Object.freeze({
  rangeChunkSize: 1024 * 1024,
});
const RECENT_KEY = 'streampdf.recent.v1';
const AUTH_KEY = 'streampdf.auth.v1';
const MAX_RECENT = 6;
const MAX_OUTLINE_ITEMS = 2500;

const els = {
  app: document.getElementById('app'),
  landing: document.getElementById('landing'),
  viewerShell: document.getElementById('viewerShell'),
  viewerContainer: document.getElementById('viewerContainer'),
  viewer: document.getElementById('viewer'),
  toolbar: document.getElementById('toolbar'),
  sidebar: document.getElementById('sidebar'),
  openButton: document.getElementById('openButton'),
  authButton: document.getElementById('authButton'),
  toggleSidebar: document.getElementById('toggleSidebar'),
  closeDocument: document.getElementById('closeDocument'),
  openDialog: document.getElementById('openDialog'),
  openDialogSlot: document.getElementById('openDialogSlot'),
  dialogClose: document.querySelector('.dialog-close'),
  authDialog: document.getElementById('authDialog'),
  authForm: document.getElementById('authForm'),
  authTokenInput: document.getElementById('authTokenInput'),
  authError: document.getElementById('authError'),
  authDialogClose: document.getElementById('authDialogClose'),
  authForget: document.getElementById('authForget'),
  authSpinner: document.getElementById('authSpinner'),
  pageNumber: document.getElementById('pageNumber'),
  pageCount: document.getElementById('pageCount'),
  prevPage: document.getElementById('prevPage'),
  nextPage: document.getElementById('nextPage'),
  zoomOut: document.getElementById('zoomOut'),
  zoomIn: document.getElementById('zoomIn'),
  zoomValue: document.getElementById('zoomValue'),
  fitWidth: document.getElementById('fitWidth'),
  rotatePage: document.getElementById('rotatePage'),
  streamChip: document.getElementById('streamChip'),
  docName: document.getElementById('docName'),
  docLocation: document.getElementById('docLocation'),
  docSize: document.getElementById('docSize'),
  docPages: document.getElementById('docPages'),
  docSource: document.getElementById('docSource'),
  chunkSize: document.getElementById('chunkSize'),
  servedBytes: document.getElementById('servedBytes'),
  servedPercent: document.getElementById('servedPercent'),
  transferBar: document.getElementById('transferBar'),
  requestCount: document.getElementById('requestCount'),
  docSizeShort: document.getElementById('docSizeShort'),
  activity: document.getElementById('activity'),
  outlineList: document.getElementById('outlineList'),
  outlineCount: document.getElementById('outlineCount'),
  backToTop: document.getElementById('backToTop'),
  stageOverlay: document.getElementById('stageOverlay'),
  overlaySpinner: document.getElementById('overlaySpinner'),
  overlayKicker: document.getElementById('overlayKicker'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayMessage: document.getElementById('overlayMessage'),
  overlayProgress: document.getElementById('overlayProgress'),
  overlayMeta: document.getElementById('overlayMeta'),
  overlayLoaded: document.getElementById('overlayLoaded'),
  overlayTotal: document.getElementById('overlayTotal'),
  overlayAction: document.getElementById('overlayAction'),
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
  toastClose: document.getElementById('toastClose'),
};

const state = {
  config: { ...DEFAULT_CONFIG },
  current: null,
  openSeq: 0,
  opening: false,
  statsTimer: null,
  statsAbort: null,
  statsFetching: false,
  toastTimer: null,
  overlayAction: null,
  memoryToken: '',
};

const eventBus = new EventBus();
const linkService = new PDFLinkService({
  eventBus,
  externalLinkTarget: 2,
  externalLinkRel: 'noopener noreferrer',
});
const pdfViewer = new PDFViewer({
  container: els.viewerContainer,
  viewer: els.viewer,
  eventBus,
  linkService,
  textLayerMode: 1,
  annotationMode: pdfjsLib.AnnotationMode?.ENABLE_FORMS ?? 2,
  imageResourcesPath: '/vendor/pdfjs/web/images/',
  maxCanvasPixels: 16 * 1024 * 1024,
});
linkService.setViewer(pdfViewer);

init();

function init() {
  // P1-3: never act on ?path= / ?url= / ?open= (or any other query string).
  // Opening a document requires an explicit form submit or recent-list click,
  // so a crafted link cannot make the server read a URL on the user's behalf.
  initAuth();
  initOpenPanels();
  renderRecent();
  bindViewerEvents();
  bindUiEvents();

  if (getAuthToken()) {
    loadConfig();
  } else {
    window.setTimeout(() => showAuthDialog(), 0);
  }
}

/* ------------------------------------------------------------------- Auth */

function getAuthToken() {
  try {
    const stored = sessionStorage.getItem(AUTH_KEY);
    if (stored) {
      return stored;
    }
  } catch {
    // Fall back to the in-memory token when storage is disabled.
  }
  return state.memoryToken;
}

function setAuthToken(token) {
  state.memoryToken = token;
  try {
    sessionStorage.setItem(AUTH_KEY, token);
  } catch {
    // The in-memory token still protects the current page session.
  }
}

function clearAuthToken() {
  state.memoryToken = '';
  try {
    sessionStorage.removeItem(AUTH_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function authHeaders() {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function initAuth() {
  els.authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitAuthToken();
  });

  els.authButton.addEventListener('click', () => showAuthDialog());

  els.authForget.addEventListener('click', () => {
    clearAuthToken();
    els.authTokenInput.value = '';
    els.authError.hidden = true;
    els.authTokenInput.focus();
  });

  els.authDialogClose.addEventListener('click', () => {
    if (getAuthToken()) {
      els.authDialog.close();
    } else {
      els.authTokenInput.focus();
    }
  });

  els.authDialog.addEventListener('cancel', (event) => {
    if (!getAuthToken()) {
      event.preventDefault();
    }
  });
}

async function submitAuthToken() {
  const token = els.authTokenInput.value.trim();
  if (token.length < 16) {
    showAuthError('访问令牌至少需要 16 个字符。');
    return;
  }

  const submit = els.authForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  els.authSpinner.hidden = false;

  try {
    const response = await fetch('/api/config', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      showAuthError(
        response.status === 401 ? '访问令牌无效。' : `验证访问令牌失败（HTTP ${response.status}）。`,
      );
      return;
    }

    const config = await response.json().catch(() => null);
    setAuthToken(token);
    els.authError.hidden = true;
    els.authDialog.close();
    applyConfig(config);
    if (!state.current) {
      focusLandingInput();
    }
  } catch {
    showAuthError('无法连接后端服务，请确认服务已启动。');
  } finally {
    submit.disabled = false;
    els.authSpinner.hidden = true;
  }
}

function showAuthDialog(message = '') {
  if (message) {
    showAuthError(message);
  } else {
    els.authError.hidden = true;
  }
  els.authTokenInput.value = getAuthToken();
  if (!els.authDialog.open) {
    els.authDialog.showModal();
  }
  window.setTimeout(() => els.authTokenInput.focus(), 30);
}

function showAuthError(message) {
  els.authError.textContent = message;
  els.authError.hidden = false;
}

function handleAuthFailure() {
  clearAuthToken();
  showAuthDialog('访问令牌无效或已失效，请重新输入。');
}

async function apiFetch(input, init = {}) {
  const headers = new Headers(init.headers ?? {});
  for (const [name, value] of Object.entries(authHeaders())) {
    headers.set(name, value);
  }

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    handleAuthFailure();
  }
  return response;
}

/* ------------------------------------------------------------------ Viewer */

function bindViewerEvents() {
  eventBus.on('pagesinit', () => {
    if (!state.current?.pdf) {
      return;
    }
    updatePageCount();
    updatePageNumber(pdfViewer.currentPageNumber);
    pdfViewer.currentScaleValue = 'page-width';
    updateZoom(pdfViewer.currentScale);
  });

  eventBus.on('pagechanging', ({ pageNumber }) => {
    updatePageNumber(pageNumber);
    els.backToTop.hidden = els.viewerContainer.scrollTop < 700;
  });

  eventBus.on('scalechanging', ({ scale }) => {
    updateZoom(scale);
  });

  eventBus.on('pagesloaded', () => {
    const current = state.current;
    if (!current?.pdf) {
      return;
    }
    current.loading = false;
    if (current.overlayTimer) {
      window.clearTimeout(current.overlayTimer);
      current.overlayTimer = null;
    }
    window.setTimeout(() => {
      if (state.current === current && !current.loading) {
        hideOverlay();
      }
    }, 120);
  });

  eventBus.on('pagerendered', () => {
    const current = state.current;
    if (!current?.loading) {
      return;
    }
    // pagesloaded normally fires first; this is a fallback for unusual files.
    window.setTimeout(() => {
      if (state.current === current) {
        current.loading = false;
        hideOverlay();
      }
    }, 180);
  });
}

function updatePageCount() {
  const count = state.current?.pdf?.numPages ?? 0;
  els.pageCount.textContent = count ? String(count) : '–';
  els.docPages.textContent = count ? formatNumber(count) : '–';
  if (count) {
    els.pageNumber.max = String(count);
  } else {
    els.pageNumber.removeAttribute('max');
  }
}

function updatePageNumber(pageNumber) {
  if (!Number.isFinite(pageNumber) || pageNumber < 1) {
    return;
  }
  if (document.activeElement !== els.pageNumber) {
    els.pageNumber.value = String(pageNumber);
  }
}

function updateZoom(scale) {
  if (!Number.isFinite(scale) || scale <= 0) {
    return;
  }
  els.zoomValue.textContent = `${Math.round(scale * 100)}%`;
}

function goToPage(pageNumber) {
  if (!state.current?.pdf) {
    return;
  }
  const total = state.current.pdf.numPages;
  const page = Math.min(total, Math.max(1, Math.trunc(pageNumber)));
  pdfViewer.currentPageNumber = page;
  updatePageNumber(page);
}

function setZoom(scale) {
  if (!state.current?.pdf) {
    return;
  }
  const clamped = Math.min(5, Math.max(0.25, scale));
  pdfViewer.currentScaleValue = String(clamped);
}

function zoomBy(factor) {
  setZoom((pdfViewer.currentScale || 1) * factor);
}

function fitWidth() {
  if (!state.current?.pdf) {
    return;
  }
  pdfViewer.currentScaleValue = 'page-width';
}

/* ---------------------------------------------------------------- UI setup */

function initOpenPanels() {
  const landingPanel = els.landing.querySelector('.open-panel');
  const dialogPanel = landingPanel.cloneNode(true);
  els.openDialogSlot.append(dialogPanel);

  for (const panel of document.querySelectorAll('.open-panel')) {
    panel.querySelector('.source-input')?.addEventListener('input', () => {
      clearFormError(panel);
    });
  }
}

function bindUiEvents() {
  document.addEventListener('click', (event) => {
    const recent = event.target.closest('.recent-item');
    if (recent) {
      const panel = recent.closest('.open-panel');
      if (panel?.dataset.busy === '1') {
        return;
      }
      const value = recent.dataset.value;
      if (value) {
        if (panel) {
          const input = panel.querySelector('.source-input');
          input.value = value;
          clearFormError(panel);
        }
        openDocument(value, panel);
      }
      return;
    }

    const clearButton = event.target.closest('.clear-recent');
    if (clearButton) {
      clearRecent();
    }
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches('.open-form')) {
      return;
    }
    event.preventDefault();
    const panel = form.closest('.open-panel');
    if (!panel || panel.dataset.busy === '1') {
      return;
    }
    const input = form.querySelector('.source-input');
    const value = input.value.trim();
    if (!value) {
      showFormError(panel, '请输入 PDF 的 HTTP(S) URL。');
      input.focus();
      return;
    }
    if (!/^https?:\/\//i.test(value)) {
      showFormError(panel, 'URL 需要以 http:// 或 https:// 开头。');
      input.focus();
      return;
    }
    openDocument(value, panel);
  });

  els.openButton.addEventListener('click', () => {
    if (state.current) {
      openOpenDialog();
    } else {
      focusLandingInput();
    }
  });

  els.toggleSidebar.addEventListener('click', () => {
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    if (mobile) {
      const visible = els.app.classList.toggle('sidebar-visible');
      els.toggleSidebar.setAttribute('aria-expanded', String(visible));
    } else {
      const collapsed = els.app.classList.toggle('sidebar-collapsed');
      els.toggleSidebar.setAttribute('aria-expanded', String(!collapsed));
    }
  });

  els.closeDocument.addEventListener('click', () => {
    closeDocument();
  });

  els.dialogClose.addEventListener('click', closeOpenDialog);
  els.openDialog.addEventListener('click', (event) => {
    if (event.target === els.openDialog) {
      closeOpenDialog();
    }
  });

  els.prevPage.addEventListener('click', () => goToPage(pdfViewer.currentPageNumber - 1));
  els.nextPage.addEventListener('click', () => goToPage(pdfViewer.currentPageNumber + 1));
  els.pageNumber.addEventListener('change', () => {
    const value = Number.parseInt(els.pageNumber.value, 10);
    if (Number.isFinite(value)) {
      goToPage(value);
    } else if (state.current?.pdf) {
      updatePageNumber(pdfViewer.currentPageNumber);
    }
  });
  els.pageNumber.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.pageNumber.blur();
      const value = Number.parseInt(els.pageNumber.value, 10);
      if (Number.isFinite(value)) {
        goToPage(value);
      }
    }
  });

  els.zoomOut.addEventListener('click', () => zoomBy(1 / 1.18));
  els.zoomIn.addEventListener('click', () => zoomBy(1.18));
  els.zoomValue.addEventListener('click', () => setZoom(1));
  els.fitWidth.addEventListener('click', fitWidth);
  els.rotatePage.addEventListener('click', () => {
    if (!state.current?.pdf) {
      return;
    }
    pdfViewer.pagesRotation = (pdfViewer.pagesRotation + 90) % 360;
  });

  els.viewerContainer.addEventListener(
    'scroll',
    () => {
      els.backToTop.hidden = !state.current?.pdf || els.viewerContainer.scrollTop < 700;
    },
    { passive: true },
  );

  els.backToTop.addEventListener('click', () => {
    els.viewerContainer.scrollTo({ top: 0, behavior: 'smooth' });
  });

  els.toastClose.addEventListener('click', hideToast);

  els.overlayAction.addEventListener('click', () => {
    if (state.overlayAction) {
      state.overlayAction();
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      if (state.current) {
        openOpenDialog();
      } else {
        focusLandingInput();
      }
      return;
    }

    if (event.key === 'Escape') {
      if (els.openDialog.open || els.authDialog.open) {
        return;
      }
      if (window.matchMedia('(max-width: 900px)').matches) {
        els.app.classList.remove('sidebar-visible');
        els.toggleSidebar.setAttribute('aria-expanded', 'false');
      }
    }
  });

  window.addEventListener('beforeunload', () => {
    stopStatsPolling();
  });
}

function focusLandingInput() {
  const panel = els.landing.querySelector('.open-panel');
  const input = panel?.querySelector('.source-input');
  if (!input) {
    return;
  }
  els.landing.scrollTop = 0;
  input.focus({ preventScroll: true });
  input.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function openOpenDialog() {
  if (!els.openDialog.open) {
    els.openDialog.showModal();
  }
  const panel = els.openDialogSlot.querySelector('.open-panel');
  window.setTimeout(() => panel?.querySelector('.source-input')?.focus(), 40);
}

function closeOpenDialog() {
  if (els.openDialog.open) {
    els.openDialog.close();
  }
}

function setAllFormsBusy(busy) {
  for (const panel of document.querySelectorAll('.open-panel')) {
    panel.dataset.busy = busy ? '1' : '0';
    const submit = panel.querySelector('.open-submit');
    const label = panel.querySelector('.open-submit-label');
    const spinner = panel.querySelector('.button-spinner');
    if (submit) {
      submit.disabled = busy;
    }
    if (label) {
      label.textContent = busy ? '正在打开…' : '打开文档';
    }
    if (spinner) {
      spinner.hidden = !busy;
    }
  }
  els.openButton.disabled = busy;
}

function showFormError(panel, errorOrMessage) {
  const message =
    typeof errorOrMessage === 'string'
      ? errorOrMessage
      : [errorOrMessage?.message, errorOrMessage?.hint].filter(Boolean).join(' ');
  if (!panel) {
    showToast(message || '打开文档失败。', 'error');
    return;
  }
  const error = panel.querySelector('.form-error');
  if (!error) {
    showToast(message || '打开文档失败。', 'error');
    return;
  }
  error.textContent = message;
  error.hidden = false;
  if (panel.offsetParent === null) {
    showToast(message, 'error');
  }
}

function clearFormError(panel) {
  panel?.querySelectorAll('.form-error').forEach((node) => {
    node.hidden = true;
    node.textContent = '';
  });
}

function clearAllFormErrors() {
  document.querySelectorAll('.open-panel').forEach(clearFormError);
}

/* ------------------------------------------------------------- Open document */

async function openDocument(value, panel = null) {
  if (state.opening) {
    return;
  }

  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    showFormError(panel, '请输入 PDF 的 HTTP(S) URL。');
    return;
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    showFormError(panel, 'URL 需要以 http:// 或 https:// 开头。');
    return;
  }

  state.opening = true;
  const seq = ++state.openSeq;
  clearAllFormErrors();
  setAllFormsBusy(true);

  let meta = null;
  try {
    meta = await createDocument(trimmed);
    if (seq !== state.openSeq) {
      void deleteServerDocument(meta.id);
      return;
    }

    if (state.current) {
      await teardownCurrent({ reveal: false });
    }
    if (seq !== state.openSeq) {
      void deleteServerDocument(meta.id);
      return;
    }

    closeOpenDialog();
    state.current = {
      meta,
      pdf: null,
      loadingTask: null,
      loading: true,
      overlayTimer: null,
    };
    showDocumentView(meta);
    await loadPdfDocument(meta, seq);

    if (seq !== state.openSeq) {
      return;
    }

    addRecent({
      value: trimmed,
      name: meta.name,
      size: meta.size,
    });
  } catch (error) {
    if (seq !== state.openSeq) {
      return;
    }
    if (isAuthError(error)) {
      handleAuthFailure();
    }
    if (!meta) {
      showFormError(panel, error);
    } else {
      showOverlayError('无法渲染 PDF', toUserMessage(error));
    }
  } finally {
    if (seq === state.openSeq) {
      state.opening = false;
      setAllFormsBusy(false);
    }
  }
}

async function createDocument(value) {
  let response;
  try {
    response = await apiFetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'url', value }),
    });
  } catch {
    throw new ApiError({
      message: '无法连接后端服务。',
      hint: '请确认已运行 npm start，并访问 Node 服务输出的地址。',
    });
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new ApiError(payload?.error ?? { message: `服务器返回 HTTP ${response.status}。` });
  }
  if (!payload?.document?.id) {
    throw new ApiError({ message: '服务器返回了无法识别的响应。' });
  }
  return payload.document;
}

async function loadPdfDocument(meta, seq) {
  const current = state.current;
  if (!current || current.meta.id !== meta.id) {
    return;
  }

  showOverlayLoading('正在打开文档', '正在读取 PDF 结构…');
  updateOverlayProgress(0, meta.size);

  const loadingTask = pdfjsLib.getDocument({
    url: new URL(meta.contentUrl, window.location.href).href,
    httpHeaders: authHeaders(),
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
    rangeChunkSize: state.config.rangeChunkSize,
    disableAutoFetch: true,
    disableStream: true,
    enableScripting: false,
    enableXfa: false,
  });
  current.loadingTask = loadingTask;

  loadingTask.onProgress = ({ loaded, total }) => {
    if (seq !== state.openSeq || state.current !== current) {
      return;
    }
    updateOverlayProgress(loaded, total || meta.size);
  };

  loadingTask.onPassword = (updatePassword, reason) => {
    if (seq !== state.openSeq || state.current !== current) {
      return;
    }
    const promptText =
      reason === pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD
        ? '密码不正确，请重新输入 PDF 密码：'
        : '此 PDF 已加密，请输入密码：';
    const password = window.prompt(promptText);
    if (password === null) {
      void loadingTask.destroy();
      return;
    }
    updatePassword(password);
  };

  current.overlayTimer = window.setTimeout(() => {
    if (state.current === current && current.loading) {
      current.loading = false;
      hideOverlay();
      showToast('首屏渲染时间较长，可以尝试滚动或稍候。', 'info');
    }
  }, 25_000);

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    if (current.overlayTimer) {
      window.clearTimeout(current.overlayTimer);
      current.overlayTimer = null;
    }
    throw error;
  }

  if (seq !== state.openSeq || state.current !== current) {
    await loadingTask.destroy().catch(() => {});
    return;
  }

  current.pdf = pdf;
  current.loading = true;
  updatePageCount();
  startStatsPolling(meta);

  try {
    pdfViewer.setDocument(pdf);
    linkService.setDocument(pdf, null);
  } catch (error) {
    throw error;
  }

  document.title = `${meta.name} · StreamPDF`;
  els.overlayTitle.textContent = '正在准备页面';
  els.overlayMessage.textContent = '文档结构已解析，正在渲染首屏…';
  els.overlayKicker.textContent = 'RENDERING';

  loadOutline(pdf).catch(() => {});
  loadPdfMetadata(pdf);
}

async function loadPdfMetadata(pdf) {
  try {
    const { info } = await pdf.getMetadata();
    if (info?.Title && state.current?.pdf === pdf) {
      els.docName.title = info.Title;
    }
  } catch {
    // Metadata is optional.
  }
}

/* ------------------------------------------------------------------- Outline */

async function loadOutline(pdf) {
  if (state.current?.pdf !== pdf) {
    return;
  }
  setOutlineMessage('正在读取目录…');
  let outline;
  try {
    outline = await pdf.getOutline();
  } catch {
    if (state.current?.pdf === pdf) {
      setOutlineMessage('无法读取此文档的目录');
    }
    return;
  }
  if (state.current?.pdf !== pdf) {
    return;
  }

  if (!Array.isArray(outline) || outline.length === 0) {
    els.outlineCount.textContent = '';
    setOutlineMessage('此文档没有目录');
    return;
  }

  const fragment = document.createDocumentFragment();
  let count = 0;
  let truncated = false;

  const visit = (items, depth) => {
    for (const item of items) {
      if (count >= MAX_OUTLINE_ITEMS) {
        truncated = true;
        return;
      }
      if (!item || typeof item.title !== 'string') {
        continue;
      }
      const actionable = Boolean(item.dest || item.url);
      const node = document.createElement(actionable ? 'button' : 'div');
      node.className = 'outline-item';
      node.style.setProperty('--depth', String(Math.min(depth, 8)));
      if (actionable) {
        node.type = 'button';
      }
      node.title = item.title;

      const dot = document.createElement('span');
      dot.className = 'outline-dot';
      const text = document.createElement('span');
      text.className = 'outline-text';
      text.textContent = item.title || '未命名书签';
      node.append(dot, text);

      if (actionable) {
        node.addEventListener('click', async () => {
          for (const active of els.outlineList.querySelectorAll('.outline-item.is-current')) {
            active.classList.remove('is-current');
          }
          node.classList.add('is-current');
          if (window.matchMedia('(max-width: 900px)').matches) {
            els.app.classList.remove('sidebar-visible');
            els.toggleSidebar.setAttribute('aria-expanded', 'false');
          }
          try {
            if (item.url) {
              const target = safeOutlineUrl(item.url);
              if (!target) {
                showToast('该书签链接被拒绝。', 'error');
                return;
              }
              window.open(target, '_blank', 'noopener,noreferrer');
            } else if (item.dest) {
              await linkService.goToDestination(item.dest);
            }
          } catch {
            showToast('无法跳转到该书签。', 'error');
          }
        });
      }

      fragment.append(node);
      count += 1;

      if (Array.isArray(item.items) && item.items.length > 0 && depth < 12) {
        visit(item.items, depth + 1);
      }
      if (truncated) {
        return;
      }
    }
  };

  visit(outline, 0);
  els.outlineCount.textContent = truncated ? `${formatNumber(count)}+ 项` : `${formatNumber(count)} 项`;
  els.outlineList.replaceChildren(fragment);
  if (truncated) {
    const note = document.createElement('p');
    note.className = 'outline-empty';
    note.textContent = `目录过长，仅显示前 ${formatNumber(MAX_OUTLINE_ITEMS)} 项。`;
    els.outlineList.append(note);
  }
}

function safeOutlineUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const url = new URL(raw, window.location.href);
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function setOutlineMessage(message) {  const p = document.createElement('p');
  p.className = 'outline-empty';
  p.textContent = message;
  els.outlineList.replaceChildren(p);
}

/* ------------------------------------------------------------ Document views */

function showDocumentView(meta) {
  els.landing.hidden = true;
  els.viewerShell.hidden = false;
  els.sidebar.hidden = false;
  els.toolbar.hidden = false;
  els.toggleSidebar.hidden = false;
  els.backToTop.hidden = true;

  els.docName.textContent = meta.name;
  els.docName.title = meta.name;
  els.docLocation.textContent = meta.display;
  els.docLocation.title = meta.display;
  els.docSize.textContent = formatBytes(meta.size);
  els.docSizeShort.textContent = formatBytes(meta.size);
  els.docPages.textContent = '–';
  els.docSource.textContent = sourceLabel(meta);
  els.docSource.title = meta.display || '';
  els.chunkSize.textContent = formatChunkSize(state.config.rangeChunkSize);

  els.pageNumber.value = '1';
  els.pageNumber.removeAttribute('max');
  els.pageCount.textContent = '–';
  els.zoomValue.textContent = '100%';
  els.servedBytes.textContent = '0 B';
  els.servedPercent.textContent = '已传输 0%';
  els.transferBar.style.width = '0%';
  els.requestCount.textContent = '0';
  els.activity.classList.remove('is-active');
  els.activity.querySelector('b').textContent = '空闲';
  els.streamChip.lastElementChild.textContent = '按需流式';
  setOutlineMessage('正在读取目录…');
  els.outlineCount.textContent = '';
  els.stageOverlay.hidden = true;
  els.viewerContainer.scrollTop = 0;
  els.app.classList.remove('sidebar-visible');
  els.toggleSidebar.setAttribute('aria-expanded', String(!els.app.classList.contains('sidebar-collapsed')));
}

function showLandingView() {
  els.landing.hidden = false;
  els.viewerShell.hidden = true;
  els.sidebar.hidden = true;
  els.toolbar.hidden = true;
  els.toggleSidebar.hidden = true;
  els.backToTop.hidden = true;
  els.landing.scrollTop = 0;
  els.app.classList.remove('sidebar-visible');
  els.stageOverlay.hidden = true;
  document.title = 'StreamPDF · 大文件流式预览';
}

async function closeDocument() {
  state.openSeq += 1;
  state.opening = false;
  setAllFormsBusy(false);
  closeOpenDialog();
  await teardownCurrent({ reveal: true });
}

async function teardownCurrent({ reveal }) {
  const previous = state.current;
  state.current = null;
  stopStatsPolling();
  hideOverlay();

  if (previous?.overlayTimer) {
    window.clearTimeout(previous.overlayTimer);
  }

  try {
    if (pdfViewer.pdfDocument) {
      pdfViewer.setDocument(null);
    }
  } catch {
    // The viewer may already be partially reset.
  }
  try {
    linkService.setDocument(null, null);
  } catch {
    // Ignore link-service teardown failures.
  }

  if (previous?.loadingTask) {
    await previous.loadingTask.destroy().catch(() => {});
  }

  els.viewer.replaceChildren();
  els.viewerContainer.querySelectorAll(':scope > #hiddenCopyElement').forEach((node) => node.remove());
  els.viewerContainer.scrollTop = 0;
  els.viewerContainer.scrollLeft = 0;

  resetDocumentUi();

  if (previous?.meta?.id) {
    void deleteServerDocument(previous.meta.id);
  }
  if (reveal) {
    showLandingView();
    window.setTimeout(focusLandingInput, 60);
  }
}

function resetDocumentUi() {
  els.docName.textContent = '未打开文档';
  els.docName.title = '';
  els.docLocation.textContent = '';
  els.docLocation.title = '';
  els.docSize.textContent = '–';
  els.docSizeShort.textContent = '–';
  els.docPages.textContent = '–';
  els.docSource.textContent = '–';
  els.pageCount.textContent = '–';
  els.pageNumber.value = '1';
  els.pageNumber.removeAttribute('max');
  els.zoomValue.textContent = '100%';
  els.servedBytes.textContent = '0 B';
  els.servedPercent.textContent = '已传输 0%';
  els.transferBar.style.width = '0%';
  els.requestCount.textContent = '0';
  els.activity.classList.remove('is-active');
  els.activity.querySelector('b').textContent = '空闲';
  els.streamChip.lastElementChild.textContent = '按需流式';
  els.outlineCount.textContent = '';
  setOutlineMessage('打开文档后显示目录');
  els.backToTop.hidden = true;
}

/* --------------------------------------------------------------------- Stats */

function startStatsPolling(meta) {
  stopStatsPolling();
  state.statsAbort = new AbortController();

  const poll = async () => {
    if (state.statsFetching || !state.current || state.current.meta.id !== meta.id) {
      return;
    }
    state.statsFetching = true;
    try {
      const response = await apiFetch(`/api/documents/${encodeURIComponent(meta.id)}/stats`, {
        signal: state.statsAbort.signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      if (state.current?.meta.id === meta.id && payload?.stats) {
        renderStats(payload.stats, meta);
      }
    } catch {
      // Stats are decorative; stream failures are reported by PDF.js.
    } finally {
      state.statsFetching = false;
    }
  };

  void poll();
  state.statsTimer = window.setInterval(poll, 1500);
}

function stopStatsPolling() {
  if (state.statsTimer) {
    window.clearInterval(state.statsTimer);
    state.statsTimer = null;
  }
  if (state.statsAbort) {
    state.statsAbort.abort();
    state.statsAbort = null;
  }
  state.statsFetching = false;
}

function renderStats(stats, meta) {
  const bytes = Number(stats.bytesServed) || 0;
  const rawPercent = meta.size > 0 ? (bytes / meta.size) * 100 : 0;
  const percent = Math.min(100, rawPercent);
  els.servedBytes.textContent = formatBytes(bytes);
  els.servedPercent.textContent =
    rawPercent > 100.5 ? '已传输 100%+（含探测）' : `已传输 ${formatPercent(percent)}`;
  els.servedPercent.title =
    rawPercent > 100.5
      ? '统计包含 PDF.js 探测请求取消前已传输的字节，因此可能超过文件大小。'
      : '';
  els.transferBar.style.width = `${bytes > 0 ? Math.max(0.8, percent) : 0}%`;
  els.requestCount.textContent = formatNumber(Number(stats.rangeRequests) || 0);
  els.streamChip.lastElementChild.textContent = bytes > 0 ? `流式 · ${formatBytes(bytes)}` : '按需流式';

  const active = Number(stats.activeRequests) > 0;
  els.activity.classList.toggle('is-active', active);
  els.activity.querySelector('b').textContent = active ? '读取中' : '空闲';
}

/* -------------------------------------------------------------------- Overlay */

function showOverlayLoading(title, message) {
  els.stageOverlay.hidden = false;
  els.stageOverlay.classList.remove('is-error');
  els.overlaySpinner.hidden = false;
  els.overlayKicker.textContent = 'STREAMING';
  els.overlayTitle.textContent = title;
  els.overlayMessage.textContent = message;
  els.overlayProgress.hidden = false;
  els.overlayMeta.hidden = false;
  els.overlayLoaded.textContent = '';
  els.overlayTotal.textContent = '';
  els.overlayAction.hidden = true;
  els.overlayAction.textContent = '返回开始页';
  state.overlayAction = null;
}

function updateOverlayProgress(loaded, total) {
  const loadedBytes = Number(loaded) || 0;
  const totalBytes = Number(total) || 0;
  els.overlayLoaded.textContent = loadedBytes > 0 ? `已读取 ${formatBytes(loadedBytes)}` : '';
  els.overlayTotal.textContent = totalBytes > 0 ? `文件共 ${formatBytes(totalBytes)}` : '';
}

function showOverlayError(title, message) {
  els.stageOverlay.hidden = false;
  els.stageOverlay.classList.add('is-error');
  els.overlaySpinner.hidden = false;
  els.overlayKicker.textContent = 'FAILED';
  els.overlayTitle.textContent = title;
  els.overlayMessage.textContent = message || '未知错误';
  els.overlayProgress.hidden = true;
  els.overlayMeta.hidden = true;
  els.overlayAction.hidden = false;
  els.overlayAction.textContent = '返回开始页';
  state.overlayAction = () => {
    closeDocument();
  };
}

function hideOverlay() {
  els.stageOverlay.hidden = true;
  els.stageOverlay.classList.remove('is-error');
}

/* --------------------------------------------------------------------- Recent */

function readRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry) =>
          entry &&
          (entry.source === undefined || entry.source === 'url') &&
          typeof entry.value === 'string' &&
          /^https?:\/\//i.test(entry.value),
      )
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function addRecent(entry) {
  const recent = readRecent().filter((item) => item.value !== entry.value);
  recent.unshift({
    source: 'url',
    value: entry.value,
    name: entry.name,
    size: entry.size,
    at: Date.now(),
  });
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // Ignore storage failures.
  }
  renderRecent();
}

function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY);
  } catch {
    // Ignore storage failures.
  }
  renderRecent();
}

function renderRecent() {
  const recent = readRecent();
  for (const list of document.querySelectorAll('.recent-list')) {
    const section = list.closest('.recent-section');
    list.replaceChildren();
    if (recent.length === 0) {
      if (section) {
        section.hidden = true;
      }
      continue;
    }
    if (section) {
      section.hidden = false;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of recent) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-item';
      button.dataset.value = entry.value;
      button.title = entry.value;

      const icon = document.createElement('span');
      icon.className = 'recent-icon';
      icon.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11 7.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.6-1.6"/></svg>';

      const copy = document.createElement('span');
      copy.className = 'recent-copy';
      const name = document.createElement('strong');
      name.textContent = entry.name || entry.value.split('/').pop() || entry.value;
      const pathText = document.createElement('small');
      pathText.textContent = entry.value;
      copy.append(name, pathText);

      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      meta.textContent = entry.size ? formatBytes(entry.size) : 'URL';

      button.append(icon, copy, meta);
      fragment.append(button);
    }
    list.append(fragment);
  }
}

/* ---------------------------------------------------------------------- Misc */

class ApiError extends Error {
  constructor(payload) {
    super(payload?.message || '请求失败。');
    this.name = 'ApiError';
    this.hint = payload?.hint || null;
    this.code = payload?.code || null;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function toUserMessage(error) {
  if (error instanceof ApiError) {
    return [error.message, error.hint].filter(Boolean).join(' ');
  }
  if (isAuthError(error)) {
    return '访问令牌无效或已失效，请重新输入。';
  }
  if (error?.name === 'PasswordException') {
    return '此 PDF 需要密码，但密码输入被取消。';
  }
  if (error?.name === 'InvalidPDFException') {
    return 'PDF 文件格式无效或已损坏。';
  }
  if (error?.name === 'MissingPDFException') {
    return '找不到 PDF 数据。';
  }
  if (error?.name === 'UnexpectedResponseException') {
    return `读取 PDF 时服务器返回异常：${error.message}`;
  }
  if (error?.name === 'AbortException') {
    return '加载已取消。';
  }
  return error?.message || '发生未知错误。';
}

function isAuthError(error) {
  if (!error) {
    return false;
  }
  if (error.status === 401) {
    return true;
  }
  if (error.code === 'UNAUTHORIZED') {
    return true;
  }
  return error.name === 'UnexpectedResponseException' && /\(401\)/.test(error.message || '');
}

function applyConfig(config) {
  if (Number.isFinite(config?.rangeChunkSize) && config.rangeChunkSize > 0) {
    state.config.rangeChunkSize = config.rangeChunkSize;
    els.chunkSize.textContent = formatChunkSize(config.rangeChunkSize);
  }
}

async function loadConfig() {
  try {
    const response = await apiFetch('/api/config', { cache: 'no-store' });
    if (!response.ok) {
      return false;
    }
    applyConfig(await response.json());
    return true;
  } catch {
    // Defaults are enough to start.
    return false;
  }
}

function sourceLabel(meta) {
  return '网络 URL';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unitIndex]}`;
}

function formatChunkSize(bytes) {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

function formatNumber(value) {
  try {
    return new Intl.NumberFormat('zh-CN').format(value);
  } catch {
    return String(value);
  }
}

function formatPercent(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0%';
  }
  if (value < 0.1) {
    return '<0.1%';
  }
  if (value >= 10) {
    return `${value.toFixed(1)}%`;
  }
  return `${value.toFixed(2)}%`;
}

function deleteServerDocument(id) {
  return apiFetch(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    keepalive: true,
  }).catch(() => {});
}

function showToast(message, type = 'info') {
  if (!message) {
    return;
  }
  if (state.toastTimer) {
    window.clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  els.toastMessage.textContent = message;
  els.toast.classList.remove('is-error', 'is-info');
  els.toast.classList.add(type === 'error' ? 'is-error' : 'is-info');
  els.toast.hidden = false;
  state.toastTimer = window.setTimeout(hideToast, type === 'error' ? 9000 : 6000);
}

function hideToast() {
  if (state.toastTimer) {
    window.clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  els.toast.hidden = true;
}
