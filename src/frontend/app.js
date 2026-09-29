const state = { catalog: null, source: 'priced', category: 'all', query: '', priced: false, selected: null, tab: 'summary', view: 'cases', ops: null, opsFlash: '', envLoading: false, notificationTesting: false, notificationFlash: '', notificationSeen: null, notificationToastDraft: null, lastFinishedRun: null, quotes: null, quoteSelected: null, quoteDetail: null, quoteExample: null, quoteReview: null, quoteArchiveConfirm: false, quoteArchiveError: '', quoteQuery: '', priceImport: new Map(), quoteStatusFilter: 'all', quoteCategoryFilter: 'all', quoteDateFrom: '', quoteDateTo: '', runHistorySignature: '', stageOpen: new Set(), stageDetailCache: new Map() };
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const fmt = (value, maximumFractionDigits = 3) => value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
const localTime = (value) => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录'; };
const label = (item) => item.sourceType === 'agent_run' ? 'AGENT / RFQ' : item.quotes.length ? 'MANUAL / PI' : 'MANUAL / FILE';
const statusClass = (item) => item.status === 'customer_quote_document' || item.status === 'conditional_quote' ? 'orange' : item.status === 'working_material_only' ? 'gray' : '';
const safeAlibabaUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['sourcing.alibaba.com', 'rfqposting.alibaba.com'].includes(url.hostname) ? url.href : null; } catch { return null; } };
let desktopInfo = null;
state.browser = null; state.browserLoading = false; state.browserAction = false; state.env = null;
const keepRunning = () => desktopInfo?.desktop ? '关闭窗口仍可通知；请保持 RFQ 助手和监控任务运行。内置浏览器会保留在后台，电脑休眠期间无法监听。' : '关闭工作台页面仍可通知；请保持终端、监听 Chrome 和持续监控任务运行。';

function renderBrowserSetup() {
  const embedded = desktopInfo?.browserProvider === 'electron-cdp';
  $('#embedded-browser-setup').hidden = !embedded;
  $('#extension-setup').hidden = embedded;
  $('#browser-desktop-controls').hidden = !embedded;
  $('#browser-web-help').hidden = embedded;
  $('#settings-web-help').hidden = desktopInfo?.desktop === true;
  $('.settings-index').hidden = desktopInfo?.desktop !== true;
  if (!desktopInfo?.desktop) $('#settings-runtime').innerHTML = '<div><dt>运行方式</dt><dd>本机 Web / CLI 服务</dd></div>';
  if (embedded) {
    $('#browser-isolation').textContent = '打开应用内的浏览器并登录 Alibaba，状态会自动更新。登录后可直接在报价 Agent 启动扫描。';
    $('#env-heading').textContent = '运行准备';
    $('#env-recheck').textContent = '刷新状态';
    $('#env-browser-action').hidden = false;
  }
}

async function openEmbeddedBrowser(url) {
  if (state.browserAction) return;
  state.browserAction = true; renderOps(); renderEnv();
  const status = $('#embedded-browser-status');
  status.textContent = '正在打开阿里巴巴窗口…';
  try {
    state.browser = await opsRequest('/api/desktop/browser/open', url ? { url } : {});
    renderBrowser();
    status.textContent = '浏览器已打开。手动登录后，工作台会自动更新状态。';
  } catch (error) { status.textContent = error.message; state.opsFlash = error.message; }
  finally { state.browserAction = false; await loadBrowser(); renderOps(); }
}

function renderModelSettings(settings) {
  if (desktopInfo) desktopInfo.settings = settings;
  $('#model-config-source').value = settings.modelConfigSource || 'auto';
  $('#model-provider').value = settings.agentProvider;
  $('#model-name').value = settings.modelName;
  $('#model-api-url').value = settings.modelApiUrl;
  $('#ocr-provider').value = settings.ocrProvider;
  $('#ocr-api-url').value = settings.ocrApiUrl;
  $('#quote-port').value = settings.quotePort || '';
  $('#poll-interval').value = settings.pollIntervalSeconds || '600';
  $('#model-api-key').value = ''; $('#ocr-api-key').value = '';
  $('#model-environment-status').textContent = settings.environmentError || (settings.agentProvider === 'local-claude-sdk'
    ? settings.claudeExecutableAvailable ? '本机 Claude 已找到；使用本机 GLM 认证变量，不加载 Claude 用户级插件或 hooks。' : '尚未找到本机 Claude。可安装 Claude，或选择 GLM HTTP 接口。'
    : settings.environmentModelAvailable
      ? `检测到 ${settings.environmentSource} · ${settings.environmentKeyVariable}。${settings.effectiveModelSource === 'environment' ? '当前正在使用，密钥仅留在内存中。' : '当前优先使用手动保存的配置。'}`
      : '未检测到可用模型环境变量；可以重新读取或选择手动填写。');
  $('#model-settings-status').textContent = `${settings.agentProvider === 'local-claude-sdk' ? settings.claudeExecutableAvailable ? '本机 Claude 已找到，请测试连接' : '本机 Claude 尚未找到' : `模型${settings.modelKeyConfigured ? settings.effectiveModelSource === 'environment' ? '使用本机环境变量' : '密钥已保存' : '未配置'}`} · OCR 密钥${settings.ocrKeyConfigured ? '可用' : '未配置'}${settings.encryptedStorage === true ? ' · 已保存密钥在本机加密' : settings.encryptedStorage === false ? ' · 系统密钥加密当前不可用' : ''}`;
  const ocrSource = {
    'saved-ocr': '使用单独保存的 OCR Key', 'environment-ocr': '使用本机 GLM_OCR_API_KEY',
    'saved-model': '复用已保存的智普模型 Key', 'environment-model': `复用本机 ${settings.ocrKeyVariable || '智普模型'} Key`,
    'endpoint-mismatch': 'OCR 接口与智普 Key 所属平台不一致，请调整地址或单独填写 OCR Key',
    missing: '未找到可复用的智普 Key'
  }[settings.ocrKeySource] || '未配置';
  $('#ocr-key-status').textContent = `${ocrSource}。实际接口：${settings.effectiveOcrApiUrl || settings.ocrApiUrl}。环境变量密钥只在本机内存中使用。`;
  syncModelSource();
}
function syncModelSource() {
  const source = $('#model-config-source').value;
  const inherited = source === 'environment' || (source === 'auto' && desktopInfo?.settings?.effectiveModelSource === 'environment');
  const localClaude = !inherited && $('#model-provider').value === 'local-claude-sdk';
  for (const id of ['#model-provider', '#model-name']) $(id).disabled = inherited;
  for (const id of ['#model-api-url', '#model-api-key']) $(id).disabled = inherited || localClaude;
  $('#model-api-key').placeholder = inherited ? '从本机环境变量读取，不回显密钥' : localClaude ? '本机 Claude 管理凭据，无需填写' : '留空保留已有密钥';
}
async function loadDesktop() {
  try {
    const response = await fetch('/api/desktop/info');
    if (!response.ok) return;
    desktopInfo = await response.json();
    if (!desktopInfo.desktop) return;
    $('#desktop-setup').hidden = false;
    $('#desktop-data-path').textContent = desktopInfo.workspace;
    $('#runtime-hint').textContent = '关闭窗口继续运行 · 菜单退出停止';
    $('#notification-platform').textContent = '系统通知 + 应用内提醒';
    renderModelSettings(desktopInfo.settings);
    $('#model-config-source').addEventListener('change', syncModelSource);
    $('#claude-setup').addEventListener('click', async () => {
      $('#claude-setup').disabled = true;
      try {
        await opsRequest('/api/desktop/claude/setup', {});
        $('#model-environment-status').textContent = '安装脚本已在系统终端打开。完成后点击「重新读取本机环境变量」，再测试模型连接。';
      } catch (error) { $('#model-environment-status').textContent = error.message; }
      finally { $('#claude-setup').disabled = false; }
    });
    $('#model-environment-refresh').addEventListener('click', async () => {
      $('#model-environment-refresh').disabled = true;
      $('#model-environment-status').textContent = '正在读取本机模型环境变量…';
      try { renderModelSettings(await opsRequest('/api/desktop/settings/environment', {})); }
      catch (error) { $('#model-environment-status').textContent = error.message; }
      finally { $('#model-environment-refresh').disabled = false; }
    });
    $('#settings-runtime').innerHTML = [['版本', `RFQ 助手 ${desktopInfo.version || '—'}`], ['系统', desktopInfo.platform === 'darwin' ? 'macOS' : desktopInfo.platform === 'win32' ? 'Windows' : desktopInfo.platform], ['运行环境', `Electron ${desktopInfo.runtime?.electron || '—'} / Chromium ${desktopInfo.runtime?.chromium || '—'}`], ['数据保存', '本机工作区；升级保留已导入数据']].map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('');
    $('#model-provider').addEventListener('change', () => {
      // 用户显式选择调用方式后退出“自动”，避免保存时又被环境 HTTP
      // 优先级覆盖，造成界面选了 Claude / HTTP 却运行另一种方式。
      if ($('#model-config-source').value === 'auto') $('#model-config-source').value = 'manual';
      const anthropic = $('#model-provider').value === 'anthropic-http';
      if ($('#model-provider').value !== 'local-claude-sdk') $('#model-api-url').value = anthropic ? 'https://api.anthropic.com/v1/messages' : 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
      if (!$('#model-name').value.trim()) $('#model-name').value = 'glm-5.3';
      syncModelSource();
    });
    $('#model-settings-form').addEventListener('submit', async (event) => {
      event.preventDefault(); $('#model-save').disabled = true;
      try {
        const source = $('#model-config-source').value;
        const value = await opsRequest('/api/desktop/settings', { modelConfigSource: source, ...($('#model-provider').disabled ? {} : { agentProvider: $('#model-provider').value,
          modelName: $('#model-name').value, ...($('#model-api-key').disabled ? {} : { modelApiUrl: $('#model-api-url').value,
          modelApiKey: $('#model-api-key').value }) }), ocrProvider: $('#ocr-provider').value,
          ocrApiKey: $('#ocr-api-key').value, ocrApiUrl: $('#ocr-api-url').value,
          quotePort: $('#quote-port').value, pollIntervalSeconds: $('#poll-interval').value });
        renderModelSettings(value);
      } catch (error) { $('#model-settings-status').textContent = error.message; }
      finally { $('#model-save').disabled = false; }
    });
    $('#model-test').addEventListener('click', async () => {
      $('#model-test').disabled = true; $('#model-settings-status').textContent = '正在测试当前调用方式…';
      try { $('#model-settings-status').textContent = (await opsRequest('/api/desktop/model/test', {})).detail; }
      catch (error) { $('#model-settings-status').textContent = error.message; }
      finally { $('#model-test').disabled = false; await loadEnv(); }
    });
    $('#ocr-test').addEventListener('click', async () => {
      $('#ocr-test').disabled = true; $('#ocr-settings-status').textContent = '正在识别内置样张…';
      try { $('#ocr-settings-status').textContent = (await opsRequest('/api/desktop/ocr/test', {})).detail; }
      catch (error) { $('#ocr-settings-status').textContent = error.message; }
      finally { $('#ocr-test').disabled = false; await loadEnv(); }
    });
    $('#model-clear').addEventListener('click', async () => {
      try { renderModelSettings(await opsRequest('/api/desktop/settings', { clearSecrets: ['modelApiKey', 'ocrApiKey'] })); }
      catch (error) { $('#model-settings-status').textContent = error.message; }
    });
    $('#desktop-import').addEventListener('click', async () => {
      $('#desktop-import').disabled = true;
      try {
        const value = await opsRequest('/api/desktop/import', {});
        if (!value.canceled) { state.ops = value; renderOps(); $('#model-settings-status').textContent = `已导入 ${value.importedFiles} 个文件，正在整理 CASE…`; }
      } catch (error) { $('#model-settings-status').textContent = error.message; }
      finally { $('#desktop-import').disabled = false; }
    });
  } catch (error) { $('#model-settings-status').textContent = `无法读取应用设置：${error.message}`; }
}

function renderBrowser() {
  const b = state.browser;
  if (!b) return;
  const busy = b.busy || state.browserAction || state.envLoading || state.ops?.envChecking || ['running', 'stopping', 'indexing'].includes(state.ops?.run?.status);
  $('#browser-live-status').textContent = busy ? '任务 / 检查正在使用浏览器' : '窗口状态自动更新 · 登录状态定期检查';
  $('#browser-window-badge').textContent = !b.opened ? '未打开' : b.loading ? '加载中' : b.visible ? '窗口已显示' : '窗口在后台';
  $('#browser-window-badge').className = `pill ${b.opened && !b.error ? '' : 'gray'}`;
  $('#browser-page-title').textContent = b.title || (b.opened ? 'Alibaba 浏览器' : '尚未打开浏览器');
  const persistence = b.sessionPersistence;
  const sessionText = persistence?.error || (persistence?.enabled ? '本机加密保存 · 重启和升级后自动恢复' : 'Alibaba 专用会话');
  const facts = [['当前页面', b.page || '打开浏览器后显示'], ['Alibaba 账号', b.checks?.find((x) => x.key === 'login')?.state || '正在确认'], ['登录保存', sessionText], ['任务占用', busy ? '占用中 · 暂停导航' : '空闲'], ['浏览器内核', `Chromium ${b.chromium || desktopInfo?.runtime?.chromium || '—'}`]];
  $('#browser-facts').innerHTML = facts.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join('');
  $('#browser-last-error').hidden = !b.error;
  $('#browser-last-error').textContent = b.error || '';
  $('#browser-inspection-result').textContent = b.loading ? '页面加载完成后自动检查登录状态。' : b.inspectionError || (b.inspection ? `${b.inspection.detail} · 检查于 ${new Date(b.inspection.checkedAt).toLocaleString('zh-CN')}` : !b.opened ? '打开浏览器后自动检查登录状态。' : '正在确认当前页面的登录状态…');
  $('#browser-inspect').disabled = !b.opened || busy || b.loading;
  $('#browser-login-import').disabled = busy || b.loading;
  $('#embedded-browser-open').disabled = state.browserAction;
  $('#embedded-browser-home').disabled = busy;
  $('#browser-navigate').disabled = busy;
  document.querySelectorAll('[data-browser-action]').forEach((button) => {
    const action = button.dataset.browserAction;
    button.disabled = !b.opened || (action !== 'hide' && busy) || (action === 'back' && !b.canGoBack) || (action === 'forward' && !b.canGoForward);
  });
  $('#browser-navigation-help').textContent = busy ? '任务或检测正在占用页面。请先在报价 Agent 停止任务，完成后再导航。' : '支持 Alibaba 官方网站和登录页；网址中不会回显登录查询参数。任务运行期间请勿手动切换页面。';
}

async function loadBrowser() {
  if (desktopInfo?.browserProvider !== 'electron-cdp' || state.browserLoading) return;
  state.browserLoading = true;
  try {
    const response = await fetch('/api/desktop/browser');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.browser = await response.json(); renderBrowser(); renderEnv();
  } catch (error) { $('#browser-live-status').textContent = `无法读取浏览器状态：${error.message}`; }
  finally { state.browserLoading = false; }
}

async function browserAction(action, url) {
  if (state.browserAction) return;
  state.browserAction = true; renderBrowser();
  $('#embedded-browser-status').textContent = action === 'inspect' ? '正在只读检测当前页面…' : '正在操作浏览器…';
  try {
    state.browser = await opsRequest(`/api/desktop/browser/${action === 'inspect' ? 'inspect' : 'navigate'}`, action === 'inspect' ? {} : { action, ...(url ? { url } : {}) });
    $('#embedded-browser-status').textContent = action === 'inspect' ? '只读检测完成；没有开启 Agent 控制或报价。' : '浏览器操作完成。';
  } catch (error) { $('#embedded-browser-status').textContent = error.message; }
  finally { state.browserAction = false; await loadBrowser(); renderBrowser(); }
}
async function importBrowserLogin() {
  if (state.browserAction) return;
  state.browserAction = true; renderBrowser();
  const status = $('#browser-import-status'); status.textContent = '请选择原 Chrome 导出的 Alibaba 登录 JSON 文件…';
  try {
    const result = await opsRequest('/api/desktop/browser/import', {});
    if (result.canceled) { status.textContent = '已取消，当前登录记录保持不变。'; return; }
    status.textContent = `${result.detail}${result.ignored || result.expired || result.unsupported ? ` 已跳过 ${result.ignored} 条其他域名、${result.expired} 条过期和 ${result.unsupported} 条分区记录。` : ''}`;
    state.browser = await opsRequest('/api/desktop/browser/open', { url: 'https://sourcing.alibaba.com/rfq_search_list.htm' });
  } catch (error) { status.textContent = error.message; }
  finally { state.browserAction = false; await loadBrowser(); renderBrowser(); }
}

function firstPrice(item) {
  const quote = item.quotes[0];
  if (!quote) return '—';
  return `${quote.currency === 'USD' ? '$' : ''}${fmt(quote.unitPrice)} / 件`;
}

function visibleCases() {
  const query = state.query.trim().toLowerCase();
  return state.catalog.cases.filter((item) => {
    if (state.source === 'manual' && item.sourceType !== 'manual_workbooks') return false;
    if (state.source === 'agent' && item.sourceType !== 'agent_run') return false;
    if (state.source === 'priced' && !item.quotes.length) return false;
    if (state.category !== 'all' && item.category !== state.category) return false;
    if (state.priced && !item.quotes.length) return false;
    if (!query) return true;
    const haystack = [item.id, item.title, item.summary, item.category, item.buyer, item.country, item.sourceGroup,
      ...item.quotes.map((quote) => `${quote.productName} ${quote.description}`)].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function renderNav() {
  const all = state.catalog.cases;
  const items = [
    ['all', '全部案例', all.length],
    ['priced', '有价格记录', all.filter((item) => item.quotes.length).length],
    ['manual', '人工材料', state.catalog.counts.manualCases],
    ['agent', 'Agent 分析', state.catalog.counts.agentCases],
  ];
  $('#source-nav').innerHTML = items.map(([key, name, count]) => `<button type="button" data-source="${key}" class="${state.source === key ? 'active' : ''}"><span>${name}</span><small>${count}</small></button>`).join('');
  $('#source-nav').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    state.source = button.dataset.source;
    renderNav(); renderList();
  }));
}

function renderMetrics() {
  const counts = state.catalog.counts;
  const metrics = [
    ['CASE 总数', counts.cases, '条'],
    ['人工报价 CASE', counts.manualQuoteCases, '条'],
    ['客户报价明细', counts.manualQuoteLines, '行'],
    ['独立决策说明', counts.agentRationaleCases, '条'],
  ];
  $('#metrics').innerHTML = metrics.map(([name, value, unit]) => `<div class="metric"><span>${esc(name)}</span><strong>${fmt(value, 0)}</strong><small>${unit}</small></div>`).join('');
  $('#case-total').textContent = counts.cases;
  $('#edition-date').textContent = state.catalog.generatedAt.slice(0, 10);
}

function renderList() {
  const cases = visibleCases();
  if (!cases.some((item) => item.id === state.selected)) state.selected = cases[0]?.id || null;
  $('#result-count').textContent = `当前显示 ${cases.length} / ${state.catalog.cases.length} 条`;
  $('#case-list').innerHTML = `<div class="list-head"><span>CASE / 商品</span><span>报价状态</span></div>` +
    (cases.length ? cases.map((item) => `<button type="button" class="case-row ${state.selected === item.id ? 'active' : ''}" data-case="${esc(item.id)}" role="listitem" aria-current="${state.selected === item.id}">
      <div class="row-meta"><span class="type">${label(item)}</span><span>${esc(item.date || '日期未记录')}</span></div>
      <h3>${esc(item.title)}</h3>
      <div class="row-bottom"><span class="pill ${statusClass(item)}">${esc(item.statusLabel)}</span><span class="price">${firstPrice(item)}</span></div>
    </button>`).join('') : '<div class="empty">没有符合条件的 CASE。试试其他关键词或筛选条件。</div>');
  $('#case-list').querySelectorAll('[data-case]').forEach((button) => button.addEventListener('click', () => selectCase(button.dataset.case)));
  renderDetail();
}

function selectCase(id) {
  state.selected = id;
  state.tab = 'summary';
  const url = new URL(location.href);
  url.searchParams.set('case', id);
  history.replaceState({}, '', url);
  $('#case-list').querySelectorAll('[data-case]').forEach((button) => {
    const active = button.dataset.case === id;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active);
  });
  renderDetail();
  if (matchMedia('(max-width: 820px)').matches) $('#case-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bulletList(items) {
  return items?.length ? `<ul class="bullets">${items.map((item) => `<li>${esc(typeof item === 'string' ? item : item.fact || item.check || JSON.stringify(item))}</li>`).join('')}</ul>` : '<p>未记录。</p>';
}

function section(title, content) { return `<section class="detail-section"><h3>${esc(title)}</h3>${content}</section>`; }

function renderQuotes(item) {
  if (!item.quotes.length) return section('价格记录', '<p>没有可核验的客户报价数值；此 CASE 保留为需求或人工材料记录。</p>');
  return section('价格记录', `<div class="quote-table-wrap"><table class="quote-table"><thead><tr><th>商品 / 贸易条款</th><th>数量</th><th>单价</th><th>总价</th><th>来源</th></tr></thead><tbody>${item.quotes.map((quote) => `<tr>
    <td><strong>${esc(quote.productName)}</strong><small>${esc(quote.tradeTerm)} · ${quote.status === 'customer_quote_document' ? 'PI 记录 / 发送未验证' : '规则条件价 / 未提交'}</small></td>
    <td>${fmt(quote.quantity, 0)}</td><td class="num">${quote.currency === 'USD' ? '$' : ''}${fmt(quote.unitPrice, 4)}</td>
    <td class="num">${quote.totalPrice == null ? '—' : `${quote.currency === 'USD' ? '$' : ''}${fmt(quote.totalPrice, 2)}`}</td>
    <td><small>${esc(quote.sheet || '定价规则')} ${esc(quote.cells?.unitPrice || '')}</small></td>
  </tr>`).join('')}</tbody></table></div>`);
}

function renderSummary(item) {
  const facts = item.sourceType === 'agent_run' ? [
    ['类目', item.categoryId || item.category], ['采购量', item.rfq?.quantityText || item.rfq?.quantity],
    ['买家地区', item.country], ['Agent 建议', item.analysis?.recommendation],
    ['图片读取', item.analysis?.imageReadStatus], ['外部动作', item.analysis?.submissionStatus],
  ] : [
    ['来源', '人工报价与询价表'], ['报价品项', item.quotes.length], ['原始表格', item.sources.length],
    ['报价发送', '未验证'], ['买家接受', '未验证'], ['案例日期', item.date || '未记录'],
  ];
  return `<div class="callout"><strong>证据边界：</strong>${item.sourceType === 'agent_run' ? 'Agent 的抽取和判断需要复核；规则价格不等于已向买家提交。' : 'PI 是客户报价文件的记录；发送、成交和供应商价格有效性仍待核实。'}</div>` +
    renderQuotes(item) + section('案例概况', `<div class="fact-grid">${facts.map(([key, value]) => `<div class="fact"><span>${esc(key)}</span><strong>${esc(value ?? '—')}</strong></div>`).join('')}</div>`) +
    (item.analysis ? section('结构化规格', `<div class="fact-grid">${Object.entries(item.analysis.fields).filter(([, value]) => value != null).map(([key, value]) => `<div class="fact"><span>${esc(key)}</span><strong>${esc(value)}</strong></div>`).join('') || '<p>无已抽取字段。</p>'}</div>`) :
      section('商品说明', item.quotes.length ? `<div class="source-text">${esc(item.quotes[0].description)}</div>` : '<p>需要从原始工作簿人工确认商品规格。</p>'));
}

function renderOriginal(item) {
  if (item.sourceType === 'agent_run') {
    const photos = item.images.length ? section('产品图片', `<div class="image-grid">${item.images.map((_, index) => `<img loading="lazy" alt="RFQ 产品图片 ${index + 1}" src="/api/image?case=${encodeURIComponent(item.id)}&index=${index}">`).join('')}</div>`) : '';
    const detailUrl = safeAlibabaUrl(item.rfq?.detailUrl);
    return section('买家原始需求', `<div class="source-text">${esc(item.rfq?.detailText || item.summary || '未记录原始正文')}</div>` +
      (detailUrl ? `<p><a href="${esc(detailUrl)}" target="_blank" rel="noopener noreferrer">打开 Alibaba 原始页面 ↗</a></p>` : '')) + photos +
      section('待确认信息', bulletList(item.analysis?.buyerQuestions));
  }
  return section('档案来源', `<p>此 CASE 由同一客户材料目录中的表格组成。目录名：<strong>${esc(item.sourceGroup)}</strong></p><p>PI 中的商品说明和价格已在「概览」列出；完整需求与附件请在「来源文件」下载核对。</p>`) +
    section('报价品项', item.quotes.length ? `<div class="evidence-list">${item.quotes.map((quote) => `<div class="evidence"><span class="ref">${esc(quote.sheet)} · ${esc(quote.cells?.description)} / ${esc(quote.cells?.unitPrice)}</span>${esc(quote.description.slice(0, 400))}</div>`).join('')}</div>` : '<p>尚未从该目录提取出标准 PI 报价行。</p>');
}

function renderRationale(item) {
  const rationale = item.rationale || {};
  if (item.sourceType === 'manual_workbooks') {
    return `<div class="callout"><strong>记录性质：</strong>这里展示原表中的成本与报价线索，尚未还原报价人员的完整决策过程。</div>` +
      section('已知报价路径', `<p>${esc(rationale.summary)}</p>${bulletList(rationale.evidence)}`) +
      section('工厂 / 成本线索', item.costNotes.length ? `<div class="evidence-list">${item.costNotes.map((note) => `<div class="evidence"><span class="ref">${esc(note.sheet)}!${esc(note.cell)} · ${esc(item.sources.find((source) => source.id === note.sourceId)?.name || '')}</span>${esc(note.excerpt)}</div>`).join('')}</div>` : '<p>该组材料未提取到可定位的成本文字；请查看原始工作簿。</p>');
  }
  const checks = rationale.ruleEvaluation?.length ? `<div class="evidence-list">${rationale.ruleEvaluation.map((entry) => `<div class="evidence"><span class="ref">${esc(entry.status)} · ${esc(entry.check)}</span>观察：${esc(entry.observed)}<br>规则：${esc(entry.required)}</div>`).join('')}</div>` : '<p>此 CASE 未保存逐条规则核验。</p>';
  return `<div class="callout"><strong>决策说明：</strong>展示的是可核验的依据与未决问题，不是模型内部思维链。</div>` +
    section('结论', `<p>${esc(rationale.decisionSummary || rationale.summary || item.analysis?.quoteReason || '未记录')}</p>`) +
    section('规则核验', checks) +
    section('缺少的规格', bulletList(item.analysis?.missingRequired)) +
    section('风险与假设', bulletList([...(rationale.assumptions || []), ...(rationale.risks || item.analysis?.riskFlags || [])])) +
    section('下一步', bulletList(rationale.nextAction || item.analysis?.buyerQuestions || []));
}

function renderSources(item) {
  return `<div class="callout"><strong>来源定位：</strong>工作簿保留压缩包内原路径，报价明细保留工作表及单元格；下载的是本地原始文件。</div>` +
    section('来源文件', item.sources.map((source) => `<div class="file-row"><div><span class="filename">${esc(source.name)}</span><small>${esc(source.role)} · ${esc(source.status)}<br>${esc(source.path)}</small></div><a href="/api/source?case=${encodeURIComponent(item.id)}&source=${encodeURIComponent(source.id)}">下载 ↗</a></div>`).join('')) +
    (item.quotes.length ? section('报价单元格', `<div class="evidence-list">${item.quotes.map((quote) => `<div class="evidence"><span class="ref">${esc(quote.sheet || 'config/pricing-rules.json')} · ${esc(quote.cells?.unitPrice || '版本化规则')}</span>${esc(quote.productName)} · ${fmt(quote.quantity, 0)} 件 × ${fmt(quote.unitPrice, 4)} ${esc(quote.currency)} · ${esc(quote.tradeTerm)} · 算术核对：${esc(quote.arithmeticCheck)}</div>`).join('')}</div>`) : '');
}

function renderDetail() {
  const item = state.catalog.cases.find((entry) => entry.id === state.selected);
  if (!item) { $('#case-detail').innerHTML = '<div class="empty">请选择一个 CASE。</div>'; return; }
  const tabs = [['summary', '概览'], ['original', '原始需求'], ['rationale', '报价依据'], ['sources', '来源文件']];
  const body = { summary: renderSummary, original: renderOriginal, rationale: renderRationale, sources: renderSources }[state.tab](item);
  const draftId = item.sourceType === 'agent_run' ? item.sources.find((source) => source.kind === 'local_json')?.path.split('/').pop().replace(/\.json$/, '') : null;
  $('#case-detail').innerHTML = `<div class="detail-top"><span class="kicker">CASE FILE / ${label(item)}</span><span class="detail-id">${esc(item.id)}</span></div>
    <h2 class="detail-title">${esc(item.title)}</h2>
    <div class="detail-sub"><span>${esc(item.category)}</span><span>${esc(item.date || '日期未记录')}</span><span>${esc(item.buyer || item.sourceGroup || '买家未记录')}</span><span class="pill ${statusClass(item)}">${esc(item.statusLabel)}</span></div>
    ${draftId ? `<button type="button" class="quote-link" data-review-draft="${esc(draftId)}">在控制台审阅浏览器报价 ↗</button>` : ''}
    <div class="tabs" role="tablist" aria-label="CASE 内容">${tabs.map(([key, title]) => `<button type="button" role="tab" aria-selected="${state.tab === key}" class="${state.tab === key ? 'active' : ''}" data-tab="${key}">${title}</button>`).join('')}</div>
    <div role="tabpanel">${body}</div>`;
  $('#case-detail').querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.tab = button.dataset.tab; renderDetail(); }));
  $('#case-detail').querySelector('[data-review-draft]')?.addEventListener('click', async (event) => {
    state.quoteSelected = event.currentTarget.dataset.reviewDraft;
    setView('console');
    if (state.quotes) renderQuoteList();
    await loadQuoteDetail();
    $('.quote-workbench').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

const runNames = { refresh: '重新整理数据集', scan: '扫描 RFQ', once: '运行一轮分析', watch: '持续监控', reanalyze: '用当前 Skill 重新分析 RFQ', quote_fill: '浏览器回填报价', quote_submit: '向买家提交报价' };
const statusNames = { running: '运行中', stopping: '正在停止', indexing: '正在更新数据集', completed: '已完成', stopped: '已停止', failed: '运行失败', attention: '需要人工处理', interrupted: '服务重启后状态未确认' };
const stageNames = { connect: '连接浏览器', search: '搜索 RFQ', filter: '筛选价格可用需求', detail: '读取 RFQ 详情', analysis: '模型分析需求', pricing: '核对价格规则', draft: '生成报价草稿', save: '保存结果', waiting: '等待下一轮', complete: '本轮完成', attention: '任务中断', stopped: '任务已停止' };
const termLabel = (term) => term === '__all__' ? '全部品类' : term;
// 保留历史 data-mode="auto" 作为内部键，界面准确表达它只开放逐单操作。
// 扫描/监控的服务端环境始终禁用自动联系，切换模式不会发送未来的草稿。
const modeHelp = { draft: '当前模式：仅生成报价话术，Agent 不操作报价表单。', auto: '当前模式：逐单浏览器报价。请在下方选择草稿，确认后回填，再逐单确认提交；扫描和监控仍只生成草稿。' };
const currentMode = (settings) => settings.quoteEnabled ? 'auto' : 'draft';

function renderExtension(value) {
  $('#extension-version').textContent = `${value.name} · 官方安装包 v${value.releaseVersion}`;
  $('#extension-path').value = value.installPath;
  $('#extension-copy-path').disabled = !value.ready;
  $('#extension-status').textContent = value.ready
    ? '安装文件已就绪。请继续第 2 步，在 Chrome 中加载插件。'
    : '安装文件尚未准备。点击「准备安装文件」后继续。';
}

async function loadExtension() {
  try {
    const response = await fetch('/api/extension');
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    renderExtension(value);
  } catch (error) {
    $('#extension-status').textContent = error.message;
    $('#extension-version').textContent = '本地安装资源尚未就绪';
  }
}

async function prepareExtension() {
  const button = $('#extension-prepare');
  button.disabled = true;
  $('#extension-status').textContent = '正在校验并准备本地安装文件…';
  try {
    // 只准备随项目提供的文件；不改变浏览器/报价开关，也不连接 Chrome。
    renderExtension(await opsRequest('/api/extension/prepare', {}));
  } catch (error) {
    $('#extension-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function copyExtensionField(selector, label) {
  const field = $(selector);
  try {
    await navigator.clipboard.writeText(field.value);
    $('#extension-status').textContent = `${label}已复制。`;
  } catch {
    // 部分浏览器不允许剪贴板写入；直接选中文本，用户仍可手动复制。
    field.focus();
    field.select();
    $('#extension-status').textContent = `已选中${label}，请按 Ctrl+C（Mac 为 ⌘C）复制。`;
  }
}

function renderEnv() {
  if (!state.env) return;
  const embedded = desktopInfo?.browserProvider === 'electron-cdp';
  // 环境配置保持独立；窗口与登录来自同一份实时状态，避免两个页面
  // 一个“未检测”、一个“已登录”。不会为更新状态改动任何操作权限。
  const checks = state.env.checks.map((check) => state.browser?.checks?.find((x) => x.key === check.key) || check);
  const row = (check) => {
    const skipped = state.env.status === 'skipped' && ['bridge', 'login'].includes(check.key);
    const status = check.state || (check.ok ? '就绪' : skipped ? '未检测' : check.required === false ? '待配置' : '需要处理');
    const probe = check.testable ? `<button class="text-button" type="button" data-service-test="${check.key}">测试${check.key === 'model' ? '模型' : ' OCR'} ↗</button>` : '';
    const settings = ['model', 'ocr', 'port'].includes(check.key) && !check.ok && !check.testable ? '<button class="text-button" type="button" data-view="settings">去设置 ↗</button>' : '';
    return `<div class="env-row ${check.ok ? 'ok' : skipped || check.state === '请先打开浏览器' || check.state === '页面加载中' || check.state === '已配置 · 待检测' || check.state === '已关闭' ? 'skipped' : 'bad'}"><span class="env-dot" aria-hidden="true"></span><div><div class="env-row-heading"><strong>${esc(check.label)}</strong><span class="env-state">${esc(status)}</span></div><small>${esc(check.detail)}</small>${check.help ? `<p>${esc(check.help)}</p>` : ''}${probe}${settings}</div></div>`;
  };
  const detailsOpen = $('#env-config-checks details')?.open;
  const primary = checks.filter((x) => ['bridge', 'login'].includes(x.key));
  const configuration = checks.filter((x) => ['model', 'ocr', 'port'].includes(x.key));
  const diagnostic = checks.filter((x) => !['bridge', 'login', 'model', 'ocr', 'port'].includes(x.key));
  const html = `<div class="env-checks">${(embedded ? primary : checks).map(row).join('')}</div>`;
  const more = embedded ? `<div class="env-checks env-configuration">${configuration.map(row).join('')}</div><details class="env-diagnostics"><summary>运行环境详情</summary><div class="env-checks">${diagnostic.map(row).join('')}</div></details>` : '';
  // 自动刷新时保留焦点和展开状态，不持续销毁正在交互的节点。
  if ($('#env-checks').dataset.rendered !== html) { $('#env-checks').innerHTML = html; $('#env-checks').dataset.rendered = html; }
  if ($('#env-config-checks').dataset.rendered !== more) {
    $('#env-config-checks').innerHTML = more; $('#env-config-checks').dataset.rendered = more;
    if ($('#env-config-checks details')) $('#env-config-checks details').open = Boolean(detailsOpen);
  }
  if (embedded) {
    const browser = primary.find((x) => x.key === 'bridge');
    const login = primary.find((x) => x.key === 'login');
    const action = login?.action ? login : browser;
    const button = $('#env-browser-action');
    button.textContent = action?.actionLabel || '打开浏览器';
    button.dataset.openBrowser = action?.action || 'open_browser';
    button.disabled = state.browserAction || (action?.action === 'open_rfq' && (state.browser?.busy || ['running', 'stopping', 'indexing'].includes(state.ops?.run?.status)));
    $('#env-time').textContent = login?.checkedAt ? `登录检查于 ${new Date(login.checkedAt).toLocaleTimeString('zh-CN')}` : state.browser?.loading ? '等待页面加载…' : '状态自动更新';
  } else $('#env-time').textContent = state.env.checkedAt ? `检测于 ${new Date(state.env.checkedAt).toLocaleString('zh-CN')}` : '—';
}

async function loadEnv(force = false) {
  // 避免切换页面/连续点击同时触发检测；服务端仍负责真正的浏览器互斥。
  if (state.envLoading) return;
  state.envLoading = true;
  renderOps();
  const box = $('#env-checks');
  if (!state.env) box.innerHTML = '<p class="ops-help">正在检查运行准备情况…</p>';
  try {
    const response = await fetch(`/api/env/check${force ? '?force=1' : ''}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    state.env = value;
    if (value.browser) state.browser = value.browser;
    renderEnv(); renderBrowser();
  } catch (error) {
    box.innerHTML = `<p class="ops-help">环境检测失败：${esc(error.message)}</p>`;
    delete box.dataset.rendered;
    $('#env-time').textContent = '—';
  } finally {
    state.envLoading = false;
    await updateOps();
  }
}

function setView(view) {
  state.view = ['cases', 'console', 'browser', 'settings'].includes(view) ? view : 'cases';
  $('#case-workspace').hidden = state.view !== 'cases';
  $('#console-workspace').hidden = state.view !== 'console';
  $('#browser-workspace').hidden = state.view !== 'browser';
  $('#settings-workspace').hidden = state.view !== 'settings';
  $('#case-navigation').hidden = state.view !== 'cases';
  document.querySelectorAll('.workspace-nav [data-view]').forEach((button) => { button.classList.toggle('active', button.dataset.view === state.view); button.setAttribute('aria-current', button.dataset.view === state.view ? 'page' : 'false'); });
  const headings = { cases: ['报价<span>数据集</span>', '真实需求与报价样例：保留买家需求、报价过程与决策边界，为后续案例检索与学习准备语料。'], console: ['报价<span>Agent</span>', '扫描需求、分析草稿与逐单报价。环境和任务状态都保留在本机。'], browser: ['应用<span>浏览器</span>', '打开 Alibaba、查看窗口与登录状态。手动浏览和 Agent 运行各自控制。'], settings: ['应用<span>设置</span>', '模型、图片识别、报价与监控配置，以及本机数据管理。'] };
  $('.title-row h1').innerHTML = headings[state.view][0];
  $('.intro').textContent = headings[state.view][1];
  $('.index-stamp').hidden = state.view !== 'cases';
  const url = new URL(location.href);
  if (state.view !== 'cases') url.searchParams.set('view', state.view);
  else url.searchParams.delete('view');
  history.replaceState({}, '', url);
  if (state.view === 'console') { updateOps(); loadEnv(); }
  if (state.view === 'browser') { updateOps(); loadBrowser(); }
  window.scrollTo({ top: 0 });
}

async function opsRequest(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Case-Console': '1' }, body: JSON.stringify(payload) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function showNotificationToast(title, body, draftId = null) {
  state.notificationToastDraft = draftId;
  $('#notification-toast-title').textContent = title;
  $('#notification-toast-body').textContent = body;
  $('#notification-toast-open').hidden = !draftId;
  $('#notification-toast').hidden = false;
}

async function openNotificationDraft(draftId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(draftId || '')) return;
  setView('console');
  await loadQuotes();
  if (!state.quotes?.drafts.some((draft) => draft.id === draftId)) {
    state.notificationFlash = `草稿 ${draftId} 尚未出现在列表中，请等待本轮数据整理完成。`;
    renderOps();
    return;
  }
  state.quoteSelected = draftId;
  renderQuoteList();
  await loadQuoteDetail();
  $('#quote-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#notification-toast').hidden = true;
}

function renderNotificationHistory(events) {
  $('#notification-history-list').innerHTML = events.length ? events.slice(0, 5).map((event) => {
    const opportunity = event.kind === 'opportunity';
    const title = opportunity ? '可报价机会' : '测试通知';
    const detail = opportunity ? event.message : '应用内测试提醒已送达';
    const time = Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toLocaleString('zh-CN') : '';
    return `<button type="button" class="notification-history-item" ${opportunity ? `data-notification-draft="${esc(event.draftId)}"` : 'disabled'}><strong>${title} · ${esc(time)}</strong><small>${esc(detail)}</small></button>`;
  }).join('') : '<small>暂无提醒</small>';
}

function handleNotifications(notifications) {
  const events = Array.isArray(notifications?.events) ? notifications.events : [];
  renderNotificationHistory(events);
  const ids = new Set(events.map((event) => event.id));
  // 首次打开时只展示历史列表；此后出现的新事件才弹出，避免重启应用
  // 时把旧提醒再次误当成新机会。测试按钮每次都有新的时间 ID。
  if (state.notificationSeen) {
    const fresh = events.filter((event) => !state.notificationSeen.has(event.id));
    const latest = fresh[0];
    if (latest?.kind === 'opportunity') showNotificationToast('发现可报价机会', latest.message, latest.draftId);
    else if (latest?.kind === 'test') showNotificationToast('应用内测试提醒',
      `提醒已在 RFQ 助手中显示。系统通知：${latest.detail || latest.status || '已请求'}。`);
  }
  state.notificationSeen = ids;
}

function renderOps() {
  const data = state.ops;
  if (!data) return;
  const run = data.run;
  $('#alerts-enabled').checked = data.settings.alertsEnabled;
  $('#notifications-enabled').checked = data.settings.notificationsEnabled;
  $('#notifications-enabled').disabled = data.notifications?.supported === false;
  $('#notification-test').disabled = !data.settings.notificationsEnabled || data.notifications?.supported === false || state.notificationTesting;
  $('#notification-status').textContent = state.notificationFlash || (data.notifications?.supported === false
    ? '当前系统通知仅支持 macOS；页面内的异常提醒仍可使用。'
    : !data.settings.notificationsEnabled ? '机会系统通知已关闭。开启后请先发送测试通知，并按系统提示允许通知。'
    : data.notifications?.last?.detail || keepRunning());
  const mode = currentMode(data.settings);
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active);
  });
  $('#mode-help').textContent = modeHelp[mode];
  const active = run && ['running', 'stopping', 'indexing'].includes(run.status);
  const envBusy = state.envLoading || data.envChecking;
  $('#env-recheck').disabled = !!active || !!envBusy;
  document.querySelectorAll('[data-action]').forEach((button) => {
    const modelMissing = desktopInfo?.desktop && ['once', 'watch'].includes(button.dataset.action) && desktopInfo.settings?.modelReady === false;
    const reason = active ? '已有任务正在运行；请先停止当前任务或等待完成。'
      : envBusy ? '浏览器或环境正在检测；请等待检测完成。'
      : modelMissing ? '需求分析模型未配置；到「设置」配置 Claude 或 GLM HTTP，再运行分析。' : '';
    button.disabled = Boolean(reason);
    // disabled 按钮本身收不到 hover/focus；提示放在可聚焦的外层。
    const wrap = button.closest('.ops-action-wrap');
    if (wrap) { wrap.dataset.reason = reason; wrap.tabIndex = reason ? 0 : -1; wrap.setAttribute('aria-label', reason ? `${button.textContent}：${reason}` : button.textContent); }
  });
  const disabledScan = document.querySelector('.ops-action-wrap [data-action="scan"]')?.disabled;
  $('#scan-action-help').textContent = disabledScan ? document.querySelector('.ops-action-wrap [data-action="scan"]').closest('.ops-action-wrap').dataset.reason : '启动前确认应用浏览器中的 Alibaba 登录状态。';
  $('#stop-run').disabled = !active || run.status !== 'running';
  $('#run-dot').className = `status-dot ${run?.status || 'idle'}`;
  $('#run-status').textContent = run ? `${active ? '' : '上次'}${runNames[run.kind] || run.kind} · ${statusNames[run.status] || run.status}` : '待命';
  $('#run-time').textContent = run?.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '—';
  $('#run-id').textContent = run ? `RUN ${run.id}` : '尚无运行记录';
  const progress = run?.progress;
  const stage = progress?.stage || (active ? 'connect' : null);
  const stageLabel = stageNames[stage] || '等待启动任务';
  $('#run-progress-stage').textContent = !run ? '等待启动任务' : run.status === 'indexing' ? '正在更新 CASE 列表'
    : ['attention', 'failed', 'interrupted'].includes(run.status) && stage ? `上次停在：${stageLabel}`
      : ['attention', 'failed', 'interrupted'].includes(run.status) ? '上次任务未完成' : stageLabel;
  const category = progress?.categoryIndex && progress?.categoryTotal ? `品类 ${progress.categoryIndex}/${progress.categoryTotal}` : '';
  const item = progress?.itemIndex && progress?.itemTotal ? `需求 ${progress.itemIndex}/${progress.itemTotal}` : '';
  const scanHelp = $('#scan-action-help');
  if (active && ['scan', 'once', 'watch'].includes(run.kind)) {
    scanHelp.textContent = [progress?.message || `正在${stageLabel}…`, category, item].filter(Boolean).join(' · ');
    scanHelp.classList.add('is-running');
  } else scanHelp.classList.remove('is-running');
  $('#run-progress-detail').textContent = [progress?.message || (run ? active ? '任务已启动，正在等待第一条进度…' : run.alert || '本次任务没有阶段记录。' : '点击扫描或分析后，这里会显示当前步骤和处理数量。'), category, item].filter(Boolean).join(' · ');
  $('#run-progress-time').textContent = progress?.at ? `更新于 ${new Date(progress.at).toLocaleTimeString('zh-CN')}` : '—';
  const stages = run?.kind === 'scan' ? ['connect', 'search', 'save'] : ['once', 'watch'].includes(run?.kind) ? ['connect', 'search', 'filter', 'detail', 'analysis', 'pricing', 'draft', 'save'] : run?.kind === 'reanalyze' ? ['analysis', 'pricing', 'draft', 'save'] : [];
  const index = stage === 'complete' ? stages.length : stages.indexOf(stage);
  $('#run-progress-steps').innerHTML = stages.map((key, position) => `<li class="${index >= 0 && position < index ? 'done' : key === stage ? 'active' : ''}">${stageNames[key]}</li>`).join('');
  const recorded = Array.isArray(run?.progressEvents) ? run.progressEvents : [];
  const history = recorded.length ? recorded.map((event, index) => ({ ...event, _index: index })) : progress ? [{ ...progress, _index: 0 }] : [];
  if (run?.finishedAt && ['attention', 'failed', 'interrupted', 'stopped'].includes(run.status) && recorded.length) {
    history.push({ stage: run.status === 'stopped' ? 'stopped' : 'attention', message: run.alert || '任务已停止', at: run.finishedAt, _index: null });
  }
  $('#run-history-count').textContent = recorded.length ? `${history.length} 条阶段记录${run?.progressTruncated ? ' · 仅显示最近记录' : ''} · 最新在上`
    : progress ? '旧版任务仅保留最后一步' : '启动任务后逐步记录';
  // 轮询不重复替换同一段历史，避免每 2 秒让辅助技术重读全部阶段。
  const signature = JSON.stringify([run?.id, history.map((event) => [event.at, event.stage, event.message, event.completedAt]), run?.status]);
  if (signature !== state.runHistorySignature) {
    state.runHistorySignature = signature;
    $('#run-history').innerHTML = history.length ? [...history].reverse().map((event) => {
      const count = [event.categoryIndex && event.categoryTotal ? `品类 ${event.categoryIndex}/${event.categoryTotal}` : '',
        event.itemIndex && event.itemTotal ? `需求 ${event.itemIndex}/${event.itemTotal}` : ''].filter(Boolean).join(' · ');
      if (event._index === null) return `<li class="stage-terminal"><time datetime="${esc(event.at)}">${esc(localTime(event.at))}</time><div><strong>${esc(stageNames[event.stage] || event.stage)}</strong><p>${esc(event.message)}</p></div></li>`;
      const key = `${run.id}:${event._index}`;
      if (state.stageDetailCache.has(key) && (state.stageDetailCache.get(key).completedAt || null) !== (event.completedAt || null)) state.stageDetailCache.delete(key);
      return `<li><details class="stage-entry" data-stage-index="${event._index}" ${state.stageOpen.has(key) ? 'open' : ''}>
        <summary><time datetime="${esc(event.at)}">${esc(localTime(event.at))}</time><span><strong>${esc(stageNames[event.stage] || event.stage)}</strong><small>${event.completedAt ? '已完成 · ' : ''}点击查看输入与输出</small><p>${esc([event.message, count].filter(Boolean).join(' · '))}</p></span></summary>
        <div class="stage-evidence">${state.stageDetailCache.has(key) ? renderStageEvidence(state.stageDetailCache.get(key)) : '正在读取阶段内容…'}</div>
      </details></li>`;
    }).join('') : `<li class="empty">${run ? '这次运行没有阶段流水；旧版本的任务无法补录。' : '暂无阶段记录。'}</li>`;
    $('#run-history').querySelectorAll('[data-stage-index]').forEach((entry) => entry.addEventListener('toggle', async () => {
      const key = `${run.id}:${entry.dataset.stageIndex}`;
      if (!entry.open) { state.stageOpen.delete(key); return; }
      state.stageOpen.add(key);
      if (state.stageDetailCache.has(key)) return;
      try {
        const response = await fetch(`/api/ops/stage?index=${entry.dataset.stageIndex}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        state.stageDetailCache.set(key, data);
        if (entry.isConnected) entry.querySelector('.stage-evidence').innerHTML = renderStageEvidence(data);
      } catch (error) { if (entry.isConnected) entry.querySelector('.stage-evidence').textContent = `无法读取：${error.message}`; }
    }));
  }
  $('#run-facts').innerHTML = run ? (run.kind === 'reanalyze' ? `<div><span>RFQ 草稿</span><strong>${esc(run.draftId || '—')}</strong></div><div><span>动作</span><strong>仅重新分析，不操作浏览器</strong></div><div><span>退出码</span><strong>${esc(run.exitCode ?? '—')}</strong></div>` : run.kind.startsWith('quote_') ? `<div><span>RFQ</span><strong>${esc(run.rfqId || '—')}</strong></div><div><span>草稿</span><strong>${esc(run.draftId || '—')}</strong></div><div><span>退出码</span><strong>${esc(run.exitCode ?? '—')}</strong></div>` : `<div><span>监控品类</span><strong>${esc(termLabel(run.term) || '—')}</strong></div><div><span>发布时间范围</span><strong>${run.recentMinutes === 0 ? '不限' : Number.isInteger(run.recentMinutes) ? `最近 ${esc(run.recentMinutes)} 分钟` : '旧任务未记录'}</strong></div><div><span>退出码</span><strong>${esc(run.exitCode ?? '—')}</strong></div>`) : '<p>选择品类并启动任务，运行状态和日志会显示在这里。</p>';
  if (run && ['once', 'watch', 'reanalyze'].includes(run.kind) && run.modelUsage) {
    const usage = run.modelUsage;
    $('#run-facts').insertAdjacentHTML('beforeend', usage.recorded
      ? `<div><span>本次模型请求</span><strong>${esc(usage.modelAttempts)} 次</strong></div><div><span>本次 OCR 请求</span><strong>${esc(usage.ocrAttempts)} 次</strong></div><div><span>服务返回的用量</span><strong>${esc(usage.inputTokens)} 输入 / ${esc(usage.outputTokens)} 输出 tokens</strong></div><div><span>服务报告的费用</span><strong>${usage.reportedCostUsd > 0 ? `USD ${esc(usage.reportedCostUsd.toFixed(4))}` : '未提供'}</strong><small>${usage.unpriced ? `${esc(usage.unpriced)} 次请求未返回费用；这里不是账单金额` : '仅为服务返回值，非账单'}</small></div>`
      : '<div><span>模型 / OCR 用量</span><strong>旧任务未记录</strong></div>');
  }
  const log = $('#run-log');
  const follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = data.log || '尚无运行日志。';
  if (follow) log.scrollTop = log.scrollHeight;
  $('#run-log-summary').textContent = run ? '上方显示任务阶段与处理结果。这里是开发排障记录，可能包含调用栈，无需根据英文异常自行判断账号状态。' : '运行后可展开排障记录。';
  const alert = $('#ops-alert');
  alert.hidden = !state.opsFlash && (!data.settings.alertsEnabled || !run?.alert);
  const historicalAlert = !state.opsFlash && Boolean(run?.finishedAt);
  alert.classList.toggle('is-history', historicalAlert);
  alert.setAttribute('role', historicalAlert ? 'status' : 'alert');
  const alertTime = run?.finishedAt ? new Date(run.finishedAt).toLocaleTimeString('zh-CN') : '';
  const currentLogin = state.browser?.checks?.find((check) => check.key === 'login')?.state === '已登录';
  const loginNote = currentLogin && /登录提示|登录标记/.test(run?.alert || '') ? ' 当前浏览器页面已显示登录；这条记录不代表现在退出登录。' : '';
  alert.textContent = state.opsFlash || (run?.alert ? `${run.finishedAt ? `上次运行（${alertTime}）` : '本次运行'}：${run.alert}${loginNote}` : '');
  renderQuoteButtons();
  renderBrowser();
}

const stageFieldNames = { rfqId: 'RFQ ID', title: '标题', summary: '列表摘要', detailText: '买家需求正文', quantityText: '买家数量', country: '国家/地区',
  quantity: '数量', widthMm: '宽度 (mm)', heightMm: '高度 (mm)', lengthMm: '长度 (mm)', bottomMm: '底宽 (mm)', capacityOz: '容量 (oz)', gsm: '纸张克重 (gsm)', material: '材料', greaseproof: '防油', printing: '印刷', flute: '楞型', color: '颜色',
  searchTerm: '搜索词', count: '范围内数量', scannedCount: '扫描数量', cards: '搜索结果', candidates: '新需求', scanned: '扫描数量', unique: '去重后', recent: '发布时间范围内', recentMinutes: '最近 N 分钟', recentRfqMinutes: '最近 N 分钟', unknownPublishedAt: '发布时间无法识别', publishedText: '买家发布时间原文', publishedAt: '买家发布时间',
  prompt: '模型请求指令', inputJson: '模型实际输入', requestedModel: '请求模型', provider: '调用方式', analysis: '需求分析结果', fields: '提取规格',
  missingRequired: '缺失规格', riskFlags: '风险提示', buyerQuestions: '待问买家的问题', quote: '报价规则结果', draft: '拟回复',
  productName: '商品名称', productDetails: '拟填规格', buyerMessage: '拟发给买家的回复', quoteStatus: '价格状态', submissionStatus: '提交状态',
  notificationStatus: '提醒状态', fileName: '本机草稿文件', note: '说明', records: '生成记录', savedRecords: '保存记录',
  runScannedTotal: '本轮总扫描数', newCandidates: '进入分析数', priceScreen: '价格可行性初筛', skipped: '无明确价格依据而跳过', reasons: '跳过原因', no_price_rule: '没有价格规则', unknown_quantity: '列表数量未知', no_definite_price_tier: '数量不在明确价格档位', budgetSkipped: '超过本次分析上限', eligibleBeforeLimit: '上限前可分析数', paidAnalysisAttempts: '本次已分析数', paidAnalysisLimit: '本次分析上限', output: '输出', input: '输入' };
function stageValue(value, depth = 0) {
  if (value == null || value === '') return '<span class="stage-missing">未记录</span>';
  if (typeof value !== 'object') return `<span class="stage-value">${esc(value)}</span>`;
  if (depth > 5) return '<span class="stage-missing">内容过深</span>';
  if (Array.isArray(value)) return value.length ? `<ol class="stage-array">${value.map((item) => `<li>${stageValue(item, depth + 1)}</li>`).join('')}</ol>` : '<span class="stage-missing">无</span>';
  return `<dl class="stage-fields">${Object.entries(value).map(([key, item]) => `<div><dt>${esc(stageFieldNames[key] || key)}</dt><dd>${stageValue(item, depth + 1)}</dd></div>`).join('')}</dl>`;
}
function renderStageEvidence(data) {
  return `<p class="stage-source">${esc(data.source || '阶段记录')}${data.completedAt ? ` · 完成于 ${esc(localTime(data.completedAt))}` : ''}</p>
    ${data.note ? `<p class="stage-note">${esc(data.note)}</p>` : ''}
    <div class="stage-io"><section><h4>输入</h4>${stageValue(data.input)}</section><section><h4>输出</h4>${stageValue(data.output)}</section></div>`;
}

const quoteStatusNames = { quoted: '规则价已确认', needs_review: '待确认价格或规格', conditional_quote: '有金额，条件待确认', submitted: '已确认提交成功', filled_not_submitted: '已填报价表，未提交', plugin_prepared_not_submitted: '已分析，未提交', dry_run_not_submitted: '试跑，未提交', skipped: '未联系' };
const quoteCategoryNames = { kraft_food_bag: '食品牛皮纸袋', tumbler_40oz: '40oz 保温杯', corrugated_rsc: '瓦楞运输箱', paper_shopping_bag: '纸质购物袋', cloth_bag: '布袋', folding_carton: '折叠纸盒', unsupported: '暂不支持' };
const quoteRecommendationNames = { quote: '可进入报价复核', review: '需要人工复核', skip: '暂不报价' };
const reasonMap = [
  ['Only non-conditional quoted records are eligible', '价格尚未通过确定性规则确认'],
  ['Analysis confidence is below', '抽取置信度未达标'],
  ['Agent recommendation is not quote', 'Agent 未建议报价'],
  ['Required fields are missing', '存在缺失规格'],
  ['Risk flags require human review', '风险标记需要人工复核'],
  ['Remaining quote slots are unknown or exhausted', '买家剩余报价席位不足或未知'],
  ['Buyer message is missing', '买家留言缺失'],
  ['Verified QUOTE_PORT is missing', '交货地点未核实'],
  ['Quote total exceeds', '报价总额缺失或超过上限'],
  ['RFQ already has an automatic-contact state', '该 RFQ 已有自动联系记录'],
  ['AUTO_CONTACT_DAILY_LIMIT reached', '今日提交上限已达'],
];
function quoteReason(reason) { return reasonMap.find(([original]) => reason.startsWith(original))?.[1] || reason; }
function quoteMoney(value) { return value == null ? '—' : `$${fmt(value, 4)}`; }
const quoteDateKey = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleDateString('sv-SE') : ''; };
const quoteSubmissionSummary = (status) => status === 'submitted' ? '已确认提交成功'
  : ['not_submitted', 'skipped', 'plugin_prepared_not_submitted', 'dry_run_not_submitted'].includes(status) ? '未向买家提交' : '提交状态待核对';
function priceApprovalForm(row) {
  const risks = [...(row.missingRequired || []).map((value) => `待补规格：${value}`), ...(row.riskFlags || [])];
  const today = quoteDateKey(new Date());
  return `<details class="price-approval"><summary>已有核实的当前售价？建立本地报价草稿 ↗</summary>
    <p>只接受你已经确认可用于这条 RFQ 的美元销售单价；历史报价不会自动填入。当前仅支持 EXW，数量固定为买家需求中的 ${esc(row.buyerQuantity ?? '未识别')} 件。保存不会操作浏览器。</p>
    ${risks.length ? `<div class="price-approval-risks"><strong>原分析尚待核对</strong><ul>${risks.map((risk) => `<li>${esc(risk)}</li>`).join('')}</ul></div>` : ''}
    <form data-approve-price="${esc(row.id)}">
      ${state.priceImport.has(row.rfqId) ? `<p class="price-import-notice">已读取这条 RFQ 的填回清单。先核对买家原文与供应商现价，再带入表单；带入后仍需勾选并输入 RFQ ID。</p><button type="button" data-use-price-import="${esc(row.id)}" class="light">带入清单中的现价</button>` : ''}
      <div class="price-approval-fields"><label>当前销售单价 · USD / 件<input name="unitPriceUsd" type="number" min="0.0001" max="10000" step="0.0001" required></label>
        <label>报价有效至<input name="validThrough" type="date" min="${today}" required></label></div>
      <label>价格覆盖的具体商品规格与条件<textarea name="specification" minlength="20" maxlength="1000" required placeholder="尺寸、材质、克重、印刷、包装、数量等；说明与买家 RFQ 的一致性"></textarea></label>
      <label>当前售价的核实依据 · 仅保存在本机<textarea name="sourceNote" minlength="15" maxlength="500" required placeholder="供应商或内部批准的报价编号、确认日期；不要填写密码"></textarea></label>
      ${(row.riskFlags || []).length ? `<label>原分析风险的逐项处理说明<textarea name="riskResolution" minlength="30" maxlength="2000" required placeholder="逐项写明如何核实：例如买家是否接受 EXW、印刷和配件是否计入售价、图片或冲突规格如何确认。未解决的风险不要勾选确认。"></textarea></label>` : ''}
      ${(row.missingRequired || []).length ? `<div class="price-missing-review"><strong>逐项确定原分析中的缺失规格</strong><p>已有买家确认时填写确认值；也可以给出本次售价覆盖的供应商方案。建议方案会明确写进买家回复，供买家决定是否接受。不能用未核实的历史规格代填。</p>
        ${row.missingRequired.map((field, index) => `<div class="price-missing-item"><strong>${esc(field)}</strong><label>依据<select name="missingSource-${index}" required><option value="buyer_confirmed">买家已确认</option><option value="supplier_proposal">我方建议规格</option></select></label><label>本次报价采用的具体值<input name="missingValue-${index}" minlength="4" maxlength="120" placeholder="例如：120 gsm 牛皮纸" required></label></div>`).join('')}</div>` : ''}
      <label class="price-approval-check"><input name="approved" type="checkbox" required>我已核对原始 RFQ、上述风险、当前销售单价和 EXW 条件；该价格可用于这条 RFQ</label>
      <label>输入完整 RFQ ID 确认<input name="rfqId" type="text" autocomplete="off" placeholder="${esc(row.rfqId)}" required></label>
      <button type="submit" ${row.buyerQuantity ? '' : 'disabled'}>保存为待审核报价草稿</button><p class="price-approval-error" role="alert"></p>
    </form></details>`;
}
function matchingPriceOpportunities() {
  return matchingQuotes().filter((row) => !row.definiteQuote && !row.archivedAt);
}

// RFQ 标题和买家原文来自外部网页。CSV 即便由本机下载，随后也可能在
// Excel/Numbers 打开，所以先阻止公式注入；报价列始终为空，历史价格
// 和模型推断的价格都不能冒充供应商当前确认的销售单价。
function inquiryCsvCell(value) {
  let cell = String(value ?? '').slice(0, 8000);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(cell)) cell = `'${cell}`;
  return `"${cell.replaceAll('"', '""')}"`;
}
function exportPriceOpportunities() {
  const rows = matchingPriceOpportunities();
  const status = $('#price-opportunity-export-status');
  if (!rows.length) { status.textContent = '当前筛选没有待核价 RFQ，请调整搜索或范围。'; return; }
  const header = ['RFQ ID', '产品', 'Alibaba RFQ 链接', '品类', '采购数量', '买家原始需求',
    '已提取规格', '待补规格', '待复核风险', '供应商询价草稿',
    '当前销售单价 USD/件（待填）', '有效期 YYYY-MM-DD（待填）', '售价来源和确认日期（待填）', '价格覆盖规格（待填）', '原分析风险处理说明（待填）'];
  const data = rows.map((row) => [row.rfqId, row.title, safeAlibabaUrl(row.detailUrl) || '',
    quoteCategoryNames[row.categoryId] || row.categoryId, row.buyerQuantity || '', row.buyerRequirement || row.summary || '',
    Object.entries(row.analysisFields || {}).map(([key, value]) => `${key}: ${value}`).join('; '),
    (row.missingRequired || []).join('; '), (row.riskFlags || []).join('; '), row.quoteReadiness?.supplierInquiry || '',
    '', '', '', '', '']);
  const csv = '\uFEFF' + [header, ...data].map((items) => items.map(inquiryCsvCell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `RFQ-待核价-${quoteDateKey(new Date()) || 'today'}.csv`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = `已导出 ${rows.length} 条待确认价格或规格的 RFQ。价格列留空；收到现价后，在对应 RFQ 中逐条核对并录入。`;
}
async function importPriceOpportunities(file) {
  const status = $('#price-opportunity-export-status');
  if (!file) return;
  if (file.size > 2_000_000) { status.textContent = '清单超过 2 MB，请分批导入。'; return; }
  try {
    const parsed = RfqPriceCsv.parse(await file.text());
    const known = new Set(quoteRows().filter((row) => !row.definiteQuote && !row.archivedAt).map((row) => row.rfqId));
    const matched = parsed.filled.filter((row) => known.has(row.rfqId));
    state.priceImport = new Map(matched.map((row) => [row.rfqId, row]));
    if (matched.length) {
      state.quoteQuery = matched[0].rfqId;
      state.quoteStatusFilter = 'all';
      state.quoteCategoryFilter = 'all';
      state.quoteDateFrom = '';
      state.quoteDateTo = '';
      $('#quote-search').value = state.quoteQuery;
      $('#quote-status-filter').value = 'all';
      $('#quote-category-filter').value = 'all';
      $('#quote-date-from').value = '';
      $('#quote-date-to').value = '';
      await renderFilteredQuotes(true);
    }
    status.textContent = `读取 ${parsed.total} 条：${matched.length} 条填有完整现价且匹配当前 RFQ${parsed.errors.length ? `，${parsed.errors.length} 条格式待修正（${parsed.errors[0]}）` : ''}${parsed.filled.length - matched.length ? `，${parsed.filled.length - matched.length} 条不属于当前工作区` : ''}。已定位首条匹配记录；仅带入表单，未保存或提交报价。`;
  } catch (error) { status.textContent = `读取失败：${error.message}`; }
}
function renderPriceOpportunities() {
  const container = $('#price-opportunity-list');
  if (!container) return;
  const rows = (state.quotes?.drafts || []).filter((row) => row.id === state.quoteSelected && !row.definiteQuote);
  container.innerHTML = rows.length ? rows.map((row) => {
    const references = row.priceOpportunity?.references || [];
    const benchmarks = row.priceOpportunity?.benchmarks || [];
    const priceMemoryLeads = row.priceMemoryLeads || [];
    const detailUrl = safeAlibabaUrl(row.detailUrl);
    return `<section class="price-opportunity-row"><h4>核价线索与下一步</h4>
      <div class="price-opportunity-body"><p><b>买家原始需求：</b>${detailUrl ? `<a href="${esc(detailUrl)}" target="_blank" rel="noopener noreferrer">打开 Alibaba RFQ ↗</a>` : '原始链接未保存'}</p>
        <div class="price-opportunity-buyer">${esc(row.buyerRequirement || row.summary || '请在买家 RFQ 原文中核对具体规格与数量。')}</div>
        <p><b>模型建议：</b>${esc(quoteRecommendationNames[row.recommendation] || row.recommendation || '未记录')}；${(row.missingRequired || []).length ? `${row.missingRequired.length} 项规格待补` : '没有列出缺失规格'}；${(row.riskFlags || []).length} 项风险待核对。此处只排核价顺序，不代表可直接向买家报价。</p>
        ${row.quoteStatus === 'needs_review' && !row.priceExpired ? `<div class="price-reanalysis"><button type="button" class="light" data-reanalyze="${esc(row.id)}">用当前 Skill 重新分析</button><span>保留原稿；重新调用需求分析模型并更新核价判断，会产生少量模型用量。不会打开浏览器或发送报价。</span><small role="status"></small></div>` : ''}
        <p class="price-opportunity-blocker"><b>目前未形成明确报价：</b>${esc(row.quoteReadiness?.reason || row.reason || '当前价格尚未核实。')} 还需核实适用于本次 RFQ 的销售单价和有效期。</p>
        ${(row.quoteReadiness?.missing?.length || row.quoteReadiness?.risks?.length || row.quoteReadiness?.buyerQuestions?.length) ? `<details class="price-opportunity-checklist"><summary>查看待补规格、风险与买家问题</summary>
          ${row.quoteReadiness.missing?.length ? `<h4>待补规格</h4><ul>${row.quoteReadiness.missing.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
          ${row.quoteReadiness.risks?.length ? `<h4>待复核风险</h4><ul>${row.quoteReadiness.risks.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
          ${row.quoteReadiness.buyerQuestions?.length ? `<h4>可向买家确认</h4><ul>${row.quoteReadiness.buyerQuestions.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
        </details>` : ''}
        <p class="price-opportunity-warning">${row.priceExpired ? `此前核实的售价已于 ${esc(row.priceValidThrough || '未知日期')} 过期，须重新确认。` : priceMemoryLeads.length ? '曾为另一条 RFQ 核实过同品类、同数量及相同已提取规格的售价。请重新确认本次工艺、供应商、条款与有效期；不会自动套价或回填。' : references.length ? '历史单价仅供寻找供应商和核价，不能直接给买家发送或自动回填。' : benchmarks.length ? '以下仅是同品类历史案例，规格或数量存在差异，不能推算本次售价，也不能填入报价表。' : '没有可比的历史报价。须取得当前供应商或内部批准的销售价格。'}</p>
        ${priceMemoryLeads.map((lead) => `<div class="price-reference price-verified-lead"><strong>其他 RFQ 已核实售价 · ${esc(lead.title || lead.rfqId)}</strong>
          <dl><div><dt>原单价</dt><dd>${esc(quoteMoney(lead.unitPriceUsd))} / 件</dd></div><div><dt>数量</dt><dd>${esc(lead.quantity)}</dd></div><div><dt>条款</dt><dd>${esc(lead.currency)} ${esc(lead.tradeTerm)}</dd></div><div><dt>原报价有效至</dt><dd>${esc(lead.validThrough)}</dd></div></dl>
          <small>原 RFQ：${esc(lead.rfqId)} · 核实于 ${esc(localTime(lead.approvedAt))}</small><small>原规格：${esc(lead.specification)}</small><small>原价格依据：${esc(lead.sourceNote)}</small><small>这条价格只获批用于原 RFQ。本次须重新核实并逐单确认。</small>
        </div>`).join('')}
        ${references.map((ref) => `<div class="price-reference"><strong>${esc(ref.description || ref.title)}</strong>
          <dl><div><dt>历史单价</dt><dd>${esc(quoteMoney(ref.unitPriceUsd))} / 件</dd></div><div><dt>历史数量</dt><dd>${esc(ref.quantity)}</dd></div><div><dt>贸易条款</dt><dd>${esc(ref.tradeTerm)}</dd></div><div><dt>报价日期</dt><dd>${esc(ref.date)}</dd></div></dl>
          <small>匹配依据：${esc((ref.signals || []).join('、') || '品类相近')}</small><small>待核对：${esc((ref.differences || []).join('；'))}</small><small>来源：${esc(ref.sourceId)}${ref.sheet ? ` · ${esc(ref.sheet)}` : ''}${ref.cell ? ` · ${esc(ref.cell)}` : ''}</small>
        </div>`).join('')}
        ${benchmarks.map((ref) => `<div class="price-reference price-benchmark"><strong>同品类历史案例 · ${esc(ref.productName || ref.title)}</strong>
          <dl><div><dt>当时单价</dt><dd>${esc(quoteMoney(ref.unitPriceUsd))} / 件</dd></div><div><dt>历史数量</dt><dd>${esc(ref.quantity)}</dd></div><div><dt>历史条款</dt><dd>${esc(ref.tradeTerm)}</dd></div><div><dt>日期</dt><dd>${esc(ref.date)}</dd></div></dl>
          <small>与本次差异：${esc((ref.differences || []).join('；'))}</small><small>来源：${esc(ref.sourceId)}${ref.sheet ? ` · ${esc(ref.sheet)}` : ''}${ref.cell ? ` · ${esc(ref.cell)}` : ''}</small>
        </div>`).join('')}
        <p><b>下一步：</b>${esc(row.priceOpportunity?.nextAction || '向供应商确认现价与有效期。')}</p>
        ${row.quoteReadiness?.supplierInquiry ? `<details class="supplier-inquiry"><summary>准备供应商询价清单</summary><p>这里只准备可复制的草稿，不会联系供应商。发送前核对买家需求、附件和贸易条款；历史单价没有写入清单。</p><textarea readonly aria-label="供应商询价草稿">${esc(row.quoteReadiness.supplierInquiry)}</textarea><button type="button" data-copy-inquiry="${esc(row.id)}">复制询价清单</button><span class="supplier-inquiry-status" role="status"></span></details>` : ''}
        ${priceApprovalForm(row)}</div></section>`;
  }).join('') : '';
  container.querySelectorAll('[data-use-price-import]').forEach((button) => button.addEventListener('click', () => {
    const row = rows.find((entry) => entry.id === button.dataset.usePriceImport);
    const imported = row && state.priceImport.get(row.rfqId);
    const form = button.closest('form');
    if (!imported || !form) return;
    for (const key of ['unitPriceUsd', 'validThrough', 'sourceNote', 'specification', 'riskResolution']) {
      const field = form.elements.namedItem(key);
      if (field) field.value = imported[key] || '';
    }
    // Never carry over an approval, RFQ confirmation, or a previous form's
    // revision hash from CSV. The operator must review the current record.
    form.elements.namedItem('approved').checked = false;
    form.elements.namedItem('rfqId').value = '';
    form.querySelector('.price-approval-error').textContent = '已带入待核对；请逐项确认风险、规格、现价和有效期。';
  }));
  container.querySelectorAll('[data-reanalyze]').forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((entry) => entry.id === button.dataset.reanalyze);
    if (!row) return;
    const status = button.parentElement.querySelector('[role="status"]');
    button.disabled = true;
    status.textContent = '正在启动重新分析…';
    try {
      await opsRequest('/api/quotes/reanalyze', { id: row.id, reviewHash: row.reviewHash });
      status.textContent = '已启动；下方任务状态会显示分析、价格检查和保存阶段。';
      await updateOps();
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  }));
  container.querySelectorAll('[data-approve-price]').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const row = rows.find((entry) => entry.id === form.dataset.approvePrice);
    if (!row) return;
    const fields = new FormData(form);
    const error = form.querySelector('.price-approval-error');
    if (fields.get('rfqId')?.trim() !== row.rfqId) { error.textContent = 'RFQ ID 不匹配，请核对后再保存。'; return; }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    error.textContent = '正在保存本地草稿…';
    try {
      const result = await opsRequest('/api/quotes/approve-price', { id: row.id, rfqId: row.rfqId, reviewHash: row.reviewHash,
        unitPriceUsd: Number(fields.get('unitPriceUsd')), validThrough: fields.get('validThrough'),
        sourceNote: fields.get('sourceNote'), specification: fields.get('specification'),
        riskResolution: fields.get('riskResolution') || '',
        missingResolutions: (row.missingRequired || []).map((field, index) => ({ field,
          source: fields.get(`missingSource-${index}`), value: fields.get(`missingValue-${index}`) })),
        approved: fields.get('approved') === 'on' });
      state.quoteStatusFilter = 'all'; state.quoteCategoryFilter = 'all'; state.quoteQuery = ''; state.quoteDateFrom = ''; state.quoteDateTo = '';
      $('#quote-status-filter').value = 'all'; $('#quote-category-filter').value = 'all'; $('#quote-search').value = ''; $('#quote-date-from').value = ''; $('#quote-date-to').value = '';
      state.quoteSelected = result.id;
      await loadQuotes();
      $('#quote-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
  }));
  container.querySelectorAll('[data-copy-inquiry]').forEach((button) => button.addEventListener('click', async () => {
    const row = rows.find((entry) => entry.id === button.dataset.copyInquiry);
    if (!row?.quoteReadiness?.supplierInquiry) return;
    const section = button.closest('.supplier-inquiry');
    const status = section.querySelector('.supplier-inquiry-status');
    try {
      await navigator.clipboard.writeText(row.quoteReadiness.supplierInquiry);
      status.textContent = '已复制。请核对后再发给供应商。';
    } catch {
      const field = section.querySelector('textarea');
      field.focus(); field.select();
      status.textContent = '已选中清单，请按 Ctrl+C（Mac 为 ⌘C）复制。';
    }
  }));
}
const quoteRows = () => {
  const seen = new Set();
  return (state.quotes?.drafts || []).filter((row) => {
    // 列表与上方漏斗都按 RFQ 去重。先标记最新记录，即使其不适合报价，
    // 也不能让同一 RFQ 的旧条件金额重新冒充当前判断。
    const key = row.rfqId || row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return row.definiteQuote || (row.categoryId !== 'unsupported' &&
      (['needs_review', 'conditional_quote'].includes(row.quoteStatus) || row.priceExpired) &&
      !['submitted', 'attempting', 'needs_manual_review', 'filled_not_submitted'].includes(row.submissionStatus));
  });
};
const quoteViewStatus = (row) => row.archivedAt ? 'archived' : row.submissionStatus === 'submitted' ? 'submitted'
  : row.submissionStatus === 'filled_not_submitted' ? 'filled_not_submitted' : row.definiteQuote ? 'definite'
    : row.quoteStatus === 'conditional_quote' ? 'conditional_quote' : 'needs_review';
const quoteViewLabel = (row) => ({ archived: '已归档草稿', submitted: '已确认提交成功', filled_not_submitted: '已填报价表，未提交',
  definite: '价格已确认，待审核', conditional_quote: '有金额，条件待确认', needs_review: '待确认价格或规格' })[quoteViewStatus(row)];
const quoteEmptyMessage = () => quoteRows().length
  ? '当前筛选没有符合条件的 RFQ，请调整搜索、状态、品类或日期。'
  : '当前没有已保存的 RFQ 报价记录。运行扫描和分析后，相关需求会出现在这里。';
function matchingQuotes() {
  const words = state.quoteQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return quoteRows().filter((draft) => {
    if (state.quoteStatusFilter === 'all' && draft.archivedAt) return false;
    if (state.quoteStatusFilter !== 'all' && quoteViewStatus(draft) !== state.quoteStatusFilter) return false;
    if (state.quoteCategoryFilter !== 'all' && draft.categoryId !== state.quoteCategoryFilter) return false;
    const date = quoteDateKey(draft.createdAt);
    if (state.quoteDateFrom && (!date || date < state.quoteDateFrom)) return false;
    if (state.quoteDateTo && (!date || date > state.quoteDateTo)) return false;
    return words.every((word) => (draft.searchText || '').toLocaleLowerCase().includes(word));
  });
}

async function renderFilteredQuotes(refreshDetail = false) {
  const all = quoteRows();
  const matched = matchingQuotes();
  const visible = matched;
  const previous = state.quoteSelected;
  if (!visible.some((draft) => draft.id === state.quoteSelected)) state.quoteSelected = visible[0]?.id || '';
  $('#quote-workbench-grid').classList.toggle('is-empty', visible.length === 0);
  $('#quote-detail').hidden = visible.length === 0;
  $('#quote-filter-count').textContent = `符合 ${visible.length} / ${all.filter((draft) => state.quoteStatusFilter === 'archived' ? draft.archivedAt : !draft.archivedAt).length} 条`;
  renderQuoteList();
  if (refreshDetail || previous !== state.quoteSelected || (!state.quoteDetail && state.quoteSelected)) await loadQuoteDetail();
  else if (!state.quoteSelected) { state.quoteDetail = null; $('#quote-detail').innerHTML = `<div class="empty">${quoteEmptyMessage()}</div>`; }
}

function renderQuoteFunnel(funnel) {
  const fields = ['analyzed', 'recommended', 'priority', 'priced', 'submitted'];
  for (const field of fields) {
    const value = funnel?.[field];
    $(`#quote-funnel-${field}`).textContent = Number.isSafeInteger(value) && value >= 0 ? String(value) : '—';
  }
  const next = $('#quote-funnel-next');
  if (!funnel || !Number.isSafeInteger(funnel.analyzed)) {
    next.textContent = '暂时无法统计本机草稿的报价进度。';
    return;
  }
  if (funnel.analyzed === 0) {
    next.textContent = '尚无已分析的 RFQ。先运行一轮分析，再查看需要补买家规格还是核实当前售价。';
    return;
  }
  next.textContent = `${funnel.buyerDetailsNeeded} 条建议核价的需求仍有待确定规格，可取得买家确认或提出明确的供货方案；${funnel.needsPrice} 条可优先核实当前售价，其中 ${funnel.riskReview} 条带有风险标记。优先核价不等于能够直接提交。`;
  if (funnel.needsPrice > 0) {
    const link = document.createElement('a');
    link.href = '#drafts-title';
    link.textContent = '查看 RFQ 报价记录 ↗';
    next.append(' ', link);
  }
}

async function loadQuotes() {
  try {
    const response = await fetch('/api/quotes');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.quotes = await response.json();
    renderQuoteFunnel(state.quotes.funnel);
    const drafts = quoteRows();
    const active = drafts.filter((draft) => !draft.archivedAt);
    $('#submitted-count').textContent = new Set(active.filter((draft) => draft.submissionStatus === 'submitted').map((draft) => draft.rfqId)).size;
    const categories = [...new Set(drafts.map((draft) => draft.categoryId).filter(Boolean))].sort();
    $('#quote-category-filter').innerHTML = '<option value="all">全部品类</option>' + categories.map((category) => `<option value="${esc(category)}">${esc(quoteCategoryNames[category] || category)}</option>`).join('');
    if (!categories.includes(state.quoteCategoryFilter)) state.quoteCategoryFilter = 'all';
    $('#quote-category-filter').value = state.quoteCategoryFilter;
    const linkedDraft = new URL(location.href).searchParams.get('draft');
    if (state.quoteSelected === null && drafts.some((draft) => draft.id === linkedDraft)) {
      state.quoteSelected = linkedDraft;
      if (drafts.find((draft) => draft.id === linkedDraft)?.archivedAt) state.quoteStatusFilter = 'archived';
    }
    $('#quote-status-filter').value = state.quoteStatusFilter;
    $('#quote-count').textContent = `${state.quotes.funnel?.analyzed ?? drafts.length} 条已分析 RFQ · ${active.length} 条可浏览记录 · ${active.filter((draft) => draft.definiteQuote).length} 条明确报价`;
    await renderFilteredQuotes(true);
  } catch (error) {
    renderQuoteFunnel(null);
    $('#quote-list').innerHTML = `<div class="empty">无法读取报价草稿：${esc(error.message)}</div>`;
  }
}

function renderQuoteList() {
  const rows = matchingQuotes();
  $('#quote-list-title').textContent = state.quoteStatusFilter === 'all' ? '当前 RFQ 记录' : $('#quote-status-filter').selectedOptions[0]?.textContent || 'RFQ 记录';
  $('#quote-list').innerHTML = rows.length ? rows.map((draft) => `<button type="button" data-draft="${esc(draft.id)}" class="quote-row ${state.quoteSelected === draft.id ? 'active' : ''}">
    <span class="quote-row-top"><small>${esc(draft.rfqId)}</small><span class="pill ${draft.definiteQuote ? '' : 'gray'}">${esc(quoteViewLabel(draft))}</span></span>
    <span class="quote-row-main"><span class="quote-row-image">${draft.images?.length ? `<img loading="lazy" alt="${esc(draft.images[0].label)}" src="/api/quote/image?draft=${encodeURIComponent(draft.id)}&index=${draft.images[0].index}">` : '<span>无本地图片</span>'}</span><span class="quote-row-copy"><strong>${esc(draft.title)}</strong>${draft.summary ? `<span class="quote-row-summary">${esc(draft.summary)}</span>` : ''}<small>分析于 ${esc(localTime(draft.createdAt))}</small>${draft.images?.length ? `<small>买家图片 ${draft.images.length} 张</small>` : ''}</span></span>
    ${draft.definiteQuote && Number.isFinite(draft.totalUsd) && draft.currency === 'USD' ? `<small>${draft.priceSource === 'operator_verified_sell_price' ? '核实报价' : '规则报价'} ${esc(quoteMoney(draft.totalUsd))}</small>` : draft.quoteStatus === 'conditional_quote' ? '<small>条件金额待核实</small>' : '<small>当前尚无可用销售报价</small>'}
  </button>`).join('') : `<div class="empty">${quoteEmptyMessage()}</div>`;
  $('#quote-list').querySelectorAll('[data-draft]').forEach((button) => button.addEventListener('click', async () => {
    state.quoteSelected = button.dataset.draft;
    state.quoteReview = null;
    state.quoteArchiveConfirm = false;
    state.quoteArchiveError = '';
    renderQuoteList();
    await loadQuoteDetail();
  }));
}

async function loadQuoteDetail() {
  const id = state.quoteSelected;
  if (!id) { state.quoteDetail = null; $('#quote-detail').innerHTML = `<div class="empty">${quoteEmptyMessage()}</div>`; return; }
  try {
    const response = await fetch(`/api/quote?draft=${encodeURIComponent(id)}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    if (state.quoteSelected !== id) return;
    state.quoteDetail = value;
    state.quoteReview = null;
    state.quoteArchiveConfirm = false;
    state.quoteArchiveError = '';
    renderQuoteDetail();
  } catch (error) {
    $('#quote-detail').innerHTML = `<div class="empty">无法读取草稿：${esc(error.message)}</div>`;
  }
}

function renderQuoteButtons() {
  if (!state.quoteDetail) return;
  const idle = !state.envLoading && !state.ops?.envChecking && !['running', 'stopping', 'indexing'].includes(state.ops?.run?.status);
  const available = !!state.ops?.settings.quoteEnabled && idle;
  const fill = $('#quote-detail [data-quote-action="fill"]');
  const submit = $('#quote-detail [data-quote-action="submit"]');
  if (fill) fill.disabled = !available || !!state.quoteDetail.archivedAt || !state.quoteDetail.fillEligible;
  if (submit) submit.disabled = !available || !!state.quoteDetail.archivedAt || !state.quoteDetail.submitEligible;
  $('#quote-detail').querySelectorAll('[data-quote-archive]').forEach((button) => { button.disabled = !idle && button.dataset.quoteArchive !== 'cancel'; });
}

function quoteFacts(detail) {
  const conditional = detail.quote.status === 'conditional_quote';
  const offeredSpecs = (detail.quote.priceEvidence?.specReview?.entries || []).filter((entry) => entry.source === 'supplier_proposal');
  const entries = [['RFQ ID', detail.rfq.id], ['价格状态', detail.quote.priceEvidence?.kind === 'operator_verified_sell_price' ? offeredSpecs.length ? '核实售价 · 我方方案待买家接受' : '人工核实售价' : quoteStatusNames[detail.quote.status] || detail.quote.status],
    ['商品', detail.draft.productName || detail.rfq.title], ['数量', detail.quote.quantity ?? detail.rfq.quantityText], [conditional ? '条件单价' : '单价', quoteMoney(detail.quote.unitPriceUsd)],
    ['一次性费用', quoteMoney(detail.quote.setupUsd || 0)], [conditional ? '条件总价' : '总价', quoteMoney(detail.quote.totalUsd)], ['贸易条款', detail.quote.tradeTerm], ['交货地点', detail.draft.port],
    ['当前浏览器动作', quoteStatusNames[detail.submission.status] || detail.submission.status],
    ['买家发布时间', detail.rfq.publishedAt ? localTime(detail.rfq.publishedAt) : detail.rfq.publishedText || '无法识别'],
    ['草稿生成时间', localTime(detail.createdAt)], ['文件更新时间', localTime(detail.updatedAt)]];
  if (detail.submittedAt) entries.push(['实际提交时间', localTime(detail.submittedAt)]);
  if (detail.quote.priceEvidence?.kind === 'operator_verified_sell_price') {
    entries.push(['售价核实时间', localTime(detail.quote.priceEvidence.approvedAt)]);
    entries.push(['售价有效至', detail.quote.priceEvidence.validThrough]);
  }
  if (detail.archivedAt) entries.push(['归档时间', localTime(detail.archivedAt)]);
  return `<div class="quote-facts">${entries.map(([name, value]) => `<div><span>${esc(name)}</span><strong>${esc(value ?? '—')}</strong></div>`).join('')}</div>`;
}

function quoteList(values, empty) {
  return Array.isArray(values) && values.length ? `<ul>${values.map((value) => `<li>${esc(value)}</li>`).join('')}</ul>` : `<p class="quote-empty-note">${esc(empty)}</p>`;
}

function quoteNarrative(detail) {
  const rfq = detail.rfq || {}, analysis = detail.analysis || {}, quote = detail.quote || {};
  const reviewedSpecs = quote.priceEvidence?.specReview?.entries || [];
  const fields = Object.entries(analysis.fields || {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
  const originalUrl = safeAlibabaUrl(rfq.detailUrl);
  const images = Array.isArray(detail.images) ? detail.images : [];
  return `<section class="quote-review-section"><div class="quote-review-heading"><span>01 / BUYER</span><h4>买家原始需求</h4></div>
      <dl class="quote-source-meta"><div><dt>页面数量</dt><dd>${esc(rfq.quantityText || '未记录')}</dd></div><div><dt>国家 / 地区</dt><dd>${esc(rfq.buyer || '未记录')}</dd></div><div><dt>买家发布时间</dt><dd>${esc(rfq.publishedAt ? localTime(rfq.publishedAt) : rfq.publishedText || '无法识别')}</dd></div><div><dt>采集时间</dt><dd>${esc(localTime(rfq.collectedAt))}</dd></div></dl>
      <div class="quote-source-actions">${originalUrl ? `<a href="${esc(originalUrl)}" target="_blank" rel="noopener noreferrer">打开 Alibaba 原始 RFQ ↗</a>` : '<span>这条记录没有可用的原始页面链接</span>'}</div>
      ${rfq.summary ? `<p class="quote-source-summary">列表摘要：${esc(rfq.summary)}</p>` : ''}
      <div class="quote-original"><strong>RFQ 详情原文</strong><p>${esc(rfq.detailText || '原始需求正文未保存在这条记录中；请核对 Alibaba 页面。')}</p></div>
      <div class="quote-buyer-images"><strong>买家图片 · ${images.length} 张</strong>${images.length
        ? `<div class="quote-image-grid">${images.map((image, position) => `<button type="button" data-quote-image="${image.index}" aria-label="放大查看${esc(image.label)} ${position + 1}"><img loading="lazy" alt="${esc(image.label)} ${position + 1}" src="/api/quote/image?draft=${encodeURIComponent(detail.id)}&index=${image.index}"><span>${esc(image.label)} ${position + 1} · 点击放大</span></button>`).join('')}</div>`
        : `<p>${originalUrl ? '本次采集没有保存图片；可打开原始 RFQ 页面核对附件。' : '本次采集没有保存图片，且当前记录没有可用的原始页面链接。'}</p>`}</div>
    </section>
    <dialog class="quote-image-dialog" aria-label="查看买家图片"><button type="button" class="quote-image-close" aria-label="关闭图片">关闭 ×</button><img alt="放大的买家图片"><p></p></dialog>
    <section class="quote-review-section"><div class="quote-review-heading"><span>02 / ANALYSIS</span><h4>需求解析与待确认项</h4></div>
      <p class="quote-review-summary">识别品类：${esc(quoteCategoryNames[analysis.categoryId] || analysis.categoryId || '未分类')} · 建议：${esc(quoteRecommendationNames[analysis.recommendation] || analysis.recommendation || '未记录')} · 置信度：${Number.isFinite(analysis.confidence) ? esc(`${Math.round(analysis.confidence * 100)}%`) : '未记录'}</p>
      <div class="quote-analysis-grid"><div><strong>已提取规格</strong>${fields.length ? `<dl>${fields.map(([key, value]) => `<div><dt>${esc(stageFieldNames[key] || key)}</dt><dd>${esc(typeof value === 'boolean' ? value ? '是' : '否' : value)}</dd></div>`).join('')}</dl>` : '<p class="quote-empty-note">未提取到可核实规格</p>'}</div>
        <div><strong>还需确认</strong>${quoteList(analysis.missingRequired, '没有列出缺失字段')}
          <strong>买家澄清问题</strong>${quoteList(analysis.buyerQuestions, '没有生成澄清问题')}</div></div>
      ${(analysis.riskFlags || []).length ? `<div class="quote-risk"><strong>风险提示</strong>${quoteList(analysis.riskFlags, '')}</div>` : ''}
    </section>
    <section class="quote-review-section"><div class="quote-review-heading"><span>03 / PRICE</span><h4>报价判断</h4></div>
      <p class="quote-review-summary">${esc(quote.priceEvidence?.kind === 'operator_verified_sell_price' ? '人工核实售价' : quoteStatusNames[quote.status] || quote.status)} · ${quote.currency === 'USD' && Number.isFinite(quote.totalUsd) ? `参考总额 ${esc(quoteMoney(quote.totalUsd))}` : '尚无可用报价金额'} · ${quoteSubmissionSummary(detail.submission.status)}</p>
      ${quote.reason ? `<div class="quote-message"><span>规则判断原因</span><p>${esc(quote.reason)}</p></div>` : ''}
      ${quote.basis ? `<div class="quote-message"><span>${quote.priceEvidence?.kind === 'operator_verified_sell_price' ? '人工核实的适用规格' : '价格依据 / 假设'}</span><p>${esc(quote.basis)}</p></div>` : ''}
      ${quote.priceEvidence?.kind === 'operator_verified_sell_price' ? `<div class="quote-message"><span>当前售价核实依据 · 仅供内部查看</span><p>${esc(quote.priceEvidence.sourceNote || '未记录')}</p></div>` : ''}
      ${reviewedSpecs.length ? `<div class="quote-message"><span>原分析缺失规格的逐项处理</span><ul>${reviewedSpecs.map((entry) => `<li>${esc(entry.field)}：${esc(entry.value)} · ${entry.source === 'supplier_proposal' ? '我方建议规格，待买家接受' : '操作员记录买家已确认'}</li>`).join('')}</ul></div>` : ''}
      ${quote.priceEvidence?.riskReview?.note ? `<div class="quote-message"><span>原分析风险的人工复核说明 · 仅供内部查看</span><p>${esc(quote.priceEvidence.riskReview.note)}</p></div>` : ''}
      ${(quote.missingFields || []).length ? `<div class="quote-risk"><strong>价格所缺条件</strong>${quoteList(quote.missingFields, '')}</div>` : ''}
    </section>
    <section class="quote-review-section"><div class="quote-review-heading"><span>04 / RESPONSE</span><h4>准备给买家的回复</h4></div>
      ${detail.hasDraft ? `<div class="quote-message"><span>拟填商品规格</span><p>${esc(detail.draft.productDetails || '未记录')}</p></div>
        <div class="quote-message"><span>拟发送给买家的完整回复 · 当前仍是草稿</span><p>${esc(detail.draft.buyerMessage || '未记录')}</p></div>`
      : `<p class="quote-empty-note">本条尚未生成买家回复。先核对上面的缺失规格与价格判断，再决定是否重新分析。</p>`}
    </section>`;
}

function bindQuoteImages(container) {
  const dialog = container.querySelector('.quote-image-dialog');
  container.querySelectorAll('[data-quote-image]').forEach((button) => button.addEventListener('click', () => {
    const image = button.querySelector('img');
    dialog.querySelector('img').src = image.src;
    dialog.querySelector('img').alt = image.alt;
    dialog.querySelector('p').textContent = image.alt;
    dialog.showModal();
  }));
  dialog.querySelector('.quote-image-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
}

async function importQuoteExample() {
  const section = $('#quote-example');
  const button = $('#quote-import-example');
  section.hidden = false;
  button.disabled = true;
  $('#quote-example-source').textContent = '正在读取本机历史案例…';
  $('#quote-example-detail').innerHTML = '<p class="empty">正在整理买家需求与报价判断…</p>';
  try {
    const response = await fetch('/api/quote/example');
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    const detail = value.detail;
    state.quoteExample = detail;
    $('#quote-example-source').textContent = value.source === 'local_scan'
      ? '来自本机历史分析记录；显示当时保存的真实 RFQ、价格判断与拟回复。'
      : '内置真实扫描记录的脱敏摘录；买家标识和原始链接未随安装包提供。';
    // 示例复用正式草稿的事实与过程视图，但刻意不渲染回填、提交或归档动作。
    // 条件金额也只作为当时的判断展示，不计入明确报价或已提交数量。
    $('#quote-example-detail').innerHTML = `<p class="quote-example-note">案例只读 · ${esc(quoteStatusNames[detail.quote.status] || detail.quote.status)} · ${quoteSubmissionSummary(detail.submission.status)}。载入预览不会修改报价数据，也不会操作浏览器。</p>
      <div class="detail-top"><span class="kicker">RFQ CASE / ${value.source === 'local_scan' ? 'LOCAL' : 'REDACTED'}</span><span class="detail-id">${esc(detail.id)}</span></div>
      <h3 class="quote-title">${esc(detail.rfq.title)}</h3>${quoteFacts(detail)}${quoteNarrative(detail)}`;
    bindQuoteImages($('#quote-example-detail'));
  } catch (error) {
    state.quoteExample = null;
    $('#quote-example-source').textContent = '案例载入失败';
    $('#quote-example-detail').innerHTML = `<p class="empty">${esc(error.message)}</p>`;
  } finally {
    button.disabled = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderQuoteDetail() {
  const detail = state.quoteDetail;
  if (!detail) return;
  const row = (state.quotes?.drafts || []).find((item) => item.id === detail.id);
  if (row && !row.definiteQuote) {
    $('#quote-detail').innerHTML = `<div class="detail-top"><span class="kicker">RFQ PRICE REVIEW</span><span class="detail-id">${esc(detail.id)}</span></div>
      <h3 class="quote-title">${esc(detail.rfq.title)}</h3><p class="quote-pending-note">${esc(quoteViewLabel(row))} · 当前尚无可提交的明确销售报价。下方历史价格只供询价和人工核实。</p>
      ${quoteNarrative(detail)}<div id="price-opportunity-list" class="price-opportunity-list"></div>`;
    bindQuoteImages($('#quote-detail'));
    renderPriceOpportunities();
    return;
  }
  const reasons = detail.fillReasons.length ? detail.fillReasons : ['可审阅并回填浏览器表单'];
  const submitReasons = detail.submitReasons.length ? detail.submitReasons : ['回填证据已核对，可审阅提交'];
  const canArchive = ['not_submitted', 'skipped', 'plugin_prepared_not_submitted', 'dry_run_not_submitted'].includes(detail.submission.status);
  const archiveControls = detail.archivedAt
    ? '<div class="quote-archive-actions"><p>这条草稿已归档，原始文件和报价依据仍在本机。</p><button type="button" data-quote-archive="restore">恢复到当前记录</button></div>'
    : canArchive ? `<div class="quote-archive-actions"><p>这条草稿尚未提交，可以归档；原始证据保留，可随时恢复。</p>
      ${state.quoteArchiveConfirm ? '<button type="button" data-quote-archive="cancel">取消</button><button type="button" class="danger" data-quote-archive="confirm">确认归档这条草稿</button>' : '<button type="button" class="danger" data-quote-archive="prompt">归档这条草稿</button>'}</div>`
      : '<div class="quote-archive-actions"><p>这条记录涉及浏览器报价动作或状态不明，需保留核对，不能归档。</p></div>';
  const review = state.quoteReview ? `<div class="quote-confirm" id="quote-confirm">
    <strong>${state.quoteReview === 'fill' ? '确认回填这一条 RFQ' : '确认向买家提交这一条报价'}</strong>
    <p>请核对上面的 RFQ、数量、单价、总价和完整买家留言；草稿在确认后发生变化将被拒绝。</p>
    <label class="quote-check"><input id="quote-approve" type="checkbox" />我已逐项核对上述报价与买家留言</label>
    <label class="quote-id-input">输入完整 RFQ ID 确认<input id="quote-confirm-id" type="text" autocomplete="off" placeholder="${esc(detail.rfq.id)}" /></label>
    <div class="quote-confirm-actions"><button type="button" id="quote-cancel" class="light">取消</button><button type="button" id="quote-confirm-run" class="primary" disabled>${state.quoteReview === 'fill' ? '确认回填，不提交' : '确认向买家提交'}</button></div>
  </div>` : '';
  $('#quote-detail').innerHTML = `<div class="detail-top"><span class="kicker">RFQ QUOTE REVIEW</span><span class="detail-id">${esc(detail.id)}</span></div>
    <h3 class="quote-title">${esc(detail.rfq.title)}</h3>${quoteFacts(detail)}
    ${quoteNarrative(detail)}
    <div class="quote-block"><strong>回填条件</strong><ul>${reasons.map((reason) => `<li>${esc(quoteReason(reason))}</li>`).join('')}</ul></div>
    <div class="quote-block"><strong>提交条件</strong><ul>${submitReasons.map((reason) => `<li>${esc(quoteReason(reason))}</li>`).join('')}</ul></div>
    ${detail.screenshotAvailable ? `<div class="quote-shot"><strong>上次回填截图</strong><img alt="浏览器报价表单回填截图" src="/api/quote/screenshot?draft=${encodeURIComponent(detail.id)}"></div>` : ''}
    <div class="quote-actions"><button type="button" class="light" data-quote-action="fill">审阅并回填</button><button type="button" class="primary" data-quote-action="submit">审阅并提交</button></div>${archiveControls}
    ${state.quoteArchiveError ? `<p class="ops-alert">${esc(state.quoteArchiveError)}</p>` : ''}${review}`;
  $('#quote-detail').querySelectorAll('[data-quote-action]').forEach((button) => button.addEventListener('click', () => { state.quoteReview = button.dataset.quoteAction; renderQuoteDetail(); $('#quote-confirm').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
  bindQuoteImages($('#quote-detail'));
  $('#quote-detail').querySelectorAll('[data-quote-archive]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.quoteArchive;
    if (action === 'prompt' || action === 'cancel') { state.quoteArchiveConfirm = action === 'prompt'; renderQuoteDetail(); return; }
    try {
      state.quoteArchiveError = '';
      await opsRequest('/api/quotes/archive', { id: detail.id, archived: action === 'confirm' });
      state.quoteArchiveConfirm = false;
      state.quoteStatusFilter = action === 'confirm' ? 'all' : 'definite';
      $('#quote-status-filter').value = state.quoteStatusFilter;
      state.quoteSelected = action === 'confirm' ? '' : detail.id;
      await loadQuotes();
    } catch (error) { state.quoteArchiveError = error.message; renderQuoteDetail(); }
  }));
  if (state.quoteReview) {
    const sync = () => { $('#quote-confirm-run').disabled = !$('#quote-approve').checked || $('#quote-confirm-id').value.trim() !== detail.rfq.id; };
    $('#quote-approve').addEventListener('change', sync);
    $('#quote-confirm-id').addEventListener('input', sync);
    $('#quote-cancel').addEventListener('click', () => { state.quoteReview = null; renderQuoteDetail(); });
    $('#quote-confirm-run').addEventListener('click', () => executeQuoteAction(state.quoteReview));
  }
  renderQuoteButtons();
}

async function executeQuoteAction(kind) {
  const detail = state.quoteDetail;
  try {
    state.opsFlash = '';
    state.ops = await opsRequest('/api/ops/quote/start', { kind, draftId: detail.id, reviewHash: detail.reviewHash,
      confirmation: $('#quote-confirm-id').value.trim(), approved: $('#quote-approve').checked });
    state.quoteReview = null;
    renderOps(); renderQuoteDetail();
    // 使用稳定 ID，避免样式类随布局改名破坏操作。滚动只是展示步骤，
    // 即使监控区以后被移除，也不能把已经成功启动的报价误报成失败。
    $('#ops-monitor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    state.opsFlash = error.message;
    renderOps();
    $('#ops-alert').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function updateOps() {
  try {
    const response = await fetch('/api/ops/status');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.ops = await response.json();
    handleNotifications(state.ops.notifications);
    if (!$('#ops-term').options.length) {
      $('#ops-term').innerHTML = `<option value="__all__">全部配置品类</option>` +
        state.ops.searchTerms.map((term) => `<option value="${esc(term)}">${esc(term)}</option>`).join('');
    }
    renderOps();
    const run = state.ops.run;
    if (run && !['running', 'stopping', 'indexing'].includes(run.status) && state.lastFinishedRun !== run.id && ['refresh', 'once', 'watch', 'reanalyze', 'quote_fill', 'quote_submit'].includes(run.kind)) {
      state.lastFinishedRun = run.id;
      if (run.status === 'completed' || run.status === 'stopped') await reloadCatalog();
      await loadQuotes();
    }
  } catch (error) {
    $('#run-status').textContent = `控制台连接失败：${error.message}`;
  }
}

async function reloadCatalog() {
  const response = await fetch('/api/catalog');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.catalog = await response.json();
  const categories = [...new Set(state.catalog.cases.map((item) => item.category))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const selected = $('#category').value;
  $('#category').innerHTML = '<option value="all">全部品类</option>' + categories.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('');
  $('#category').value = categories.includes(selected) ? selected : 'all';
  state.category = $('#category').value;
  renderNav(); renderMetrics(); renderList();
}

async function runAction(kind) {
  try {
    state.opsFlash = '';
    const windowInput = $('#ops-recent-minutes');
    if (kind !== 'refresh' && (windowInput.value === '' || !windowInput.validity.valid)) {
      throw new Error('请填写 0 至 525600 的整数分钟；0 表示不限时间');
    }
    state.ops = await opsRequest('/api/ops/start', { kind, term: $('#ops-term').value,
      recentMinutes: kind === 'refresh' ? 60 : windowInput.valueAsNumber });
    renderOps();
  } catch (error) {
    state.opsFlash = error.message;
    await updateOps();
  }
}

async function start() {
  try {
    await loadDesktop();
    renderBrowserSetup();
    $('#embedded-browser-open').addEventListener('click', () => openEmbeddedBrowser());
    $('#embedded-browser-home').addEventListener('click', () => openEmbeddedBrowser('https://sourcing.alibaba.com/rfq_search_list.htm'));
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (desktopInfo?.browserProvider === 'electron-cdp' && link && safeAlibabaUrl(link.href)) {
        event.preventDefault(); void openEmbeddedBrowser(link.href);
      }
    });
    state.selected = new URL(location.href).searchParams.get('case');
    $('#search').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
    $('#category').addEventListener('change', (event) => { state.category = event.target.value; renderList(); });
    $('#priced').addEventListener('change', (event) => { state.priced = event.target.checked; renderList(); });
    document.addEventListener('keydown', (event) => { if (state.view === 'cases' && event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); } });
    // 页面链接与动态生成的环境建议共用导航，新增设置项无需再次绑定事件。
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]'); if (button) setView(button.dataset.view);
      const browserButton = event.target.closest('[data-open-browser]');
      if (browserButton) openEmbeddedBrowser(browserButton.dataset.openBrowser === 'open_rfq' ? 'https://sourcing.alibaba.com/rfq_search_list.htm' : undefined);
    });
    document.querySelectorAll('[data-browser-action]').forEach((button) => button.addEventListener('click', () => browserAction(button.dataset.browserAction)));
    $('#browser-address-form').addEventListener('submit', (event) => { event.preventDefault(); browserAction('navigate', $('#browser-address').value.trim()); });
    $('#browser-inspect').addEventListener('click', () => browserAction('inspect'));
    $('#browser-login-import').addEventListener('click', importBrowserLogin);
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.action)));
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-service-test]');
      if (!button || button.disabled) return;
      const key = button.dataset.serviceTest;
      state.opsFlash = '';
      button.disabled = true; button.textContent = '正在检测…';
      try { await opsRequest(`/api/desktop/${key === 'model' ? 'model' : 'ocr'}/test`, {}); }
      catch (error) { state.opsFlash = `${key === 'model' ? '模型' : 'OCR'} 检测失败：${error.message}`; }
      finally { await loadEnv(); renderOps(); }
    });
    $('#env-recheck').addEventListener('click', () => loadEnv(true));
    $('#extension-prepare').addEventListener('click', prepareExtension);
    $('#extension-copy-path').addEventListener('click', () => copyExtensionField('#extension-path', '插件目录'));
    $('#extension-copy-manager').addEventListener('click', () => copyExtensionField('#extension-manager', '扩展管理地址'));
    $('#notification-test').addEventListener('click', async () => {
      state.notificationTesting = true;
      state.notificationFlash = '正在发送系统通知；首次使用请在系统提示中允许通知。';
      renderOps();
      try {
        const result = await opsRequest('/api/notifications/test', {});
        state.notificationFlash = result.detail;
      } catch (error) { state.notificationFlash = error.message; showNotificationToast('测试通知未发送', error.message); }
      finally { state.notificationTesting = false; await updateOps(); }
    });
    $('#notification-toast-close').addEventListener('click', () => { $('#notification-toast').hidden = true; });
    $('#notification-toast-open').addEventListener('click', () => openNotificationDraft(state.notificationToastDraft));
    $('#notification-history-list').addEventListener('click', (event) => {
      const button = event.target.closest('[data-notification-draft]');
      if (button) void openNotificationDraft(button.dataset.notificationDraft);
    });
    $('#quote-import-example').addEventListener('click', importQuoteExample);
    $('#quote-example-close').addEventListener('click', () => { $('#quote-example').hidden = true; });
    $('#quote-search').addEventListener('input', (event) => { state.quoteQuery = event.target.value; void renderFilteredQuotes(); });
    $('#price-opportunity-export').addEventListener('click', exportPriceOpportunities);
    $('#price-opportunity-import').addEventListener('click', () => $('#price-opportunity-import-file').click());
    $('#price-opportunity-import-file').addEventListener('change', (event) => {
      void importPriceOpportunities(event.target.files?.[0]);
      event.target.value = '';
    });
    $('#quote-status-filter').addEventListener('change', (event) => { state.quoteStatusFilter = event.target.value; void renderFilteredQuotes(); });
    $('#quote-category-filter').addEventListener('change', (event) => { state.quoteCategoryFilter = event.target.value; void renderFilteredQuotes(); });
    $('#quote-date-from').addEventListener('change', (event) => { state.quoteDateFrom = event.target.value; void renderFilteredQuotes(); });
    $('#quote-date-to').addEventListener('change', (event) => { state.quoteDateTo = event.target.value; void renderFilteredQuotes(); });
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
      // 这里只改变逐单工作台权限，不启动扫描，也不自动联系买家。
      const settings = { quoteEnabled: button.dataset.mode === 'auto' };
      try { state.opsFlash = ''; state.ops = await opsRequest('/api/ops/settings', settings); renderOps(); await loadEnv(true); }
      catch (error) { state.opsFlash = error.message; renderOps(); }
    }));
    for (const [key, id] of [['alertsEnabled', '#alerts-enabled'], ['notificationsEnabled', '#notifications-enabled']]) {
      $(id).addEventListener('change', async (event) => {
        try {
          state.opsFlash = '';
          if (key === 'notificationsEnabled') state.notificationFlash = '';
          state.ops = await opsRequest('/api/ops/settings', { [key]: event.target.checked });
          renderOps();
        }
        catch (error) { event.target.checked = !event.target.checked; state.opsFlash = error.message; renderOps(); }
      });
    }
    $('#stop-run').addEventListener('click', async () => {
      try { state.opsFlash = ''; state.ops = await opsRequest('/api/ops/stop', {}); renderOps(); }
      catch (error) { state.opsFlash = error.message; renderOps(); }
    });
    await reloadCatalog();
    await updateOps();
    if (desktopInfo?.browserProvider !== 'electron-cdp') await loadExtension();
    await loadQuotes();
    await loadBrowser();
    setView(new URL(location.href).searchParams.get('view') || (desktopInfo?.desktop && !desktopInfo.settings.modelReady ? 'settings' : 'cases'));
    if (new URL(location.href).searchParams.has('draft') && state.view === 'console') $('#quote-detail')?.scrollIntoView({ block: 'start' });
    setInterval(() => { if (state.ops?.settings.notificationsEnabled || ['console', 'browser'].includes(state.view) || ['running', 'stopping', 'indexing'].includes(state.ops?.run?.status)) updateOps(); if (['console', 'browser'].includes(state.view)) loadBrowser(); }, 2000);
  } catch (error) {
    $('#case-detail').innerHTML = `<div class="empty">无法读取 CASE 数据：${esc(error.message)}<br>请先运行 npm run cases:build，然后启动本地页面。</div>`;
  }
}

start();
