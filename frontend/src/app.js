const state = { catalog: null, source: 'priced', category: 'all', query: '', priced: false, selected: null, tab: 'summary', view: 'cases', ops: null, opsFlash: '', lastFinishedRun: null, quotes: null, quoteSelected: null, quoteDetail: null, quoteReview: null };
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const fmt = (value, maximumFractionDigits = 3) => value == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value);
const label = (item) => item.sourceType === 'agent_run' ? 'AGENT / RFQ' : item.quotes.length ? 'MANUAL / PI' : 'MANUAL / FILE';
const statusClass = (item) => item.status === 'customer_quote_document' || item.status === 'conditional_quote' ? 'orange' : item.status === 'working_material_only' ? 'gray' : '';
const safeAlibabaUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' && ['sourcing.alibaba.com', 'rfqposting.alibaba.com'].includes(url.hostname) ? url.href : null; } catch { return null; } };

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

const runNames = { refresh: '重新整理数据集', scan: '扫描 RFQ', once: '运行一轮分析', watch: '持续监控', quote_fill: '浏览器回填报价', quote_submit: '向买家提交报价' };
const statusNames = { running: '运行中', stopping: '正在停止', indexing: '正在更新数据集', completed: '已完成', stopped: '已停止', failed: '运行失败', attention: '需要人工处理', interrupted: '服务重启后状态未确认' };
const termLabel = (term) => term === '__all__' ? '全部品类' : term;
const modeHelp = { draft: '当前模式：仅生成报价话术，Agent 不操作报价表单。', auto: '当前模式：浏览器自动报价；回填后仍需逐单确认才会提交。' };
const currentMode = (settings) => settings.quoteEnabled ? 'auto' : 'draft';

async function loadEnv(force = false) {
  const box = $('#env-checks');
  box.innerHTML = '<p class="ops-help">正在检测运行环境…（最长约 30 秒）</p>';
  try {
    const response = await fetch(`/api/env/check${force ? '?force=1' : ''}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    box.innerHTML = value.checks.map((check) => `<div class="env-row ${check.ok ? 'ok' : 'bad'}"><span class="env-dot" aria-hidden="true"></span><div><strong>${esc(check.label)}</strong><small>${esc(check.detail)}</small></div></div>`).join('');
    $('#env-time').textContent = value.checkedAt ? `检测于 ${new Date(value.checkedAt).toLocaleString('zh-CN')}` : '—';
  } catch (error) {
    box.innerHTML = `<p class="ops-help">环境检测失败：${esc(error.message)}</p>`;
    $('#env-time').textContent = '—';
  }
}

function setView(view) {
  state.view = view === 'console' ? 'console' : 'cases';
  $('#case-workspace').hidden = state.view !== 'cases';
  $('#console-workspace').hidden = state.view !== 'console';
  $('#case-navigation').hidden = state.view !== 'cases';
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  const url = new URL(location.href);
  if (state.view === 'console') url.searchParams.set('view', 'console');
  else url.searchParams.delete('view');
  history.replaceState({}, '', url);
  if (state.view === 'console') { updateOps(); loadEnv(); }
}

async function opsRequest(path, payload) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Case-Console': '1' }, body: JSON.stringify(payload) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function renderOps() {
  const data = state.ops;
  if (!data) return;
  const run = data.run;
  $('#browser-enabled').checked = data.settings.browserEnabled;
  $('#alerts-enabled').checked = data.settings.alertsEnabled;
  const mode = currentMode(data.settings);
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active);
  });
  $('#mode-help').textContent = modeHelp[mode];
  const active = run && ['running', 'stopping', 'indexing'].includes(run.status);
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.disabled = !!active || (button.dataset.action !== 'refresh' && !data.settings.browserEnabled);
  });
  $('#stop-run').disabled = !active || run.status !== 'running';
  $('#run-dot').className = `status-dot ${run?.status || 'idle'}`;
  $('#run-status').textContent = run ? `${runNames[run.kind] || run.kind} · ${statusNames[run.status] || run.status}` : '待命';
  $('#run-time').textContent = run?.startedAt ? new Date(run.startedAt).toLocaleString('zh-CN') : '—';
  $('#run-id').textContent = run ? `RUN ${run.id}` : '尚无运行记录';
  $('#run-facts').innerHTML = run ? (run.kind.startsWith('quote_') ? `<div><span>RFQ</span><strong>${esc(run.rfqId || '—')}</strong></div><div><span>草稿</span><strong>${esc(run.draftId || '—')}</strong></div><div><span>退出码</span><strong>${esc(run.exitCode ?? '—')}</strong></div>` : `<div><span>监控品类</span><strong>${esc(termLabel(run.term) || '—')}</strong></div><div><span>新 RFQ 上限</span><strong>${esc(run.limit ?? '—')}</strong></div><div><span>退出码</span><strong>${esc(run.exitCode ?? '—')}</strong></div>`) : '<p>选择品类并启动任务，运行状态和日志会显示在这里。</p>';
  const log = $('#run-log');
  const follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.textContent = data.log || '尚无运行日志。';
  if (follow) log.scrollTop = log.scrollHeight;
  const alert = $('#ops-alert');
  alert.hidden = !state.opsFlash && (!data.settings.alertsEnabled || !run?.alert);
  alert.textContent = state.opsFlash || run?.alert || '';
  renderQuoteButtons();
}

const quoteStatusNames = { quoted: '规则价已确认', needs_review: '需要人工复核', conditional_quote: '条件报价', submitted: '已提交', filled_not_submitted: '已回填，未提交', plugin_prepared_not_submitted: '已分析，未提交', dry_run_not_submitted: '试跑，未提交', skipped: '未联系' };
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

async function loadQuotes() {
  try {
    const response = await fetch('/api/quotes');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.quotes = await response.json();
    $('#submitted-count').textContent = new Set(state.quotes.drafts.filter((draft) => draft.submissionStatus === 'submitted').map((draft) => draft.rfqId)).size;
    if (!state.quotes.drafts.some((draft) => draft.id === state.quoteSelected)) state.quoteSelected = state.quotes.drafts[0]?.id || null;
    $('#quote-count').textContent = `${state.quotes.counts.total} 条草稿 · ${state.quotes.counts.quoted} 条规则报价`;
    renderQuoteList();
    await loadQuoteDetail();
  } catch (error) {
    $('#quote-list').innerHTML = `<div class="empty">无法读取报价草稿：${esc(error.message)}</div>`;
  }
}

function renderQuoteList() {
  $('#quote-list').innerHTML = state.quotes.drafts.length ? state.quotes.drafts.map((draft) => `<button type="button" data-draft="${esc(draft.id)}" class="quote-row ${state.quoteSelected === draft.id ? 'active' : ''}">
    <span class="quote-row-top"><small>${esc(draft.rfqId)}</small><span class="pill ${draft.quoteStatus === 'quoted' ? '' : 'gray'}">${esc(quoteStatusNames[draft.quoteStatus] || draft.quoteStatus)}</span></span>
    <strong>${esc(draft.title)}</strong><small>${esc(quoteStatusNames[draft.submissionStatus] || draft.submissionStatus)}</small>
  </button>`).join('') : '<div class="empty">还没有本地 RFQ 报价草稿。</div>';
  $('#quote-list').querySelectorAll('[data-draft]').forEach((button) => button.addEventListener('click', async () => {
    state.quoteSelected = button.dataset.draft;
    state.quoteReview = null;
    renderQuoteList();
    await loadQuoteDetail();
  }));
}

async function loadQuoteDetail() {
  const id = state.quoteSelected;
  if (!id) { $('#quote-detail').innerHTML = '<div class="empty">选择一条草稿，核对报价内容。</div>'; return; }
  try {
    const response = await fetch(`/api/quote?draft=${encodeURIComponent(id)}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
    if (state.quoteSelected !== id) return;
    state.quoteDetail = value;
    state.quoteReview = null;
    renderQuoteDetail();
  } catch (error) {
    $('#quote-detail').innerHTML = `<div class="empty">无法读取草稿：${esc(error.message)}</div>`;
  }
}

function renderQuoteButtons() {
  if (!state.quoteDetail) return;
  const available = !!state.ops?.settings.browserEnabled && !!state.ops?.settings.quoteEnabled && !['running', 'stopping', 'indexing'].includes(state.ops?.run?.status);
  const fill = $('#quote-detail [data-quote-action="fill"]');
  const submit = $('#quote-detail [data-quote-action="submit"]');
  if (fill) fill.disabled = !available || !state.quoteDetail.fillEligible;
  if (submit) submit.disabled = !available || !state.quoteDetail.submitEligible;
}

function quoteFacts(detail) {
  const entries = [['RFQ ID', detail.rfq.id], ['价格状态', quoteStatusNames[detail.quote.status] || detail.quote.status],
    ['商品', detail.draft.productName], ['数量', detail.quote.quantity], ['单价', quoteMoney(detail.quote.unitPriceUsd)],
    ['一次性费用', quoteMoney(detail.quote.setupUsd || 0)], ['总价', quoteMoney(detail.quote.totalUsd)], ['贸易条款', detail.quote.tradeTerm], ['交货地点', detail.draft.port],
    ['当前浏览器动作', quoteStatusNames[detail.submission.status] || detail.submission.status]];
  return `<div class="quote-facts">${entries.map(([name, value]) => `<div><span>${esc(name)}</span><strong>${esc(value ?? '—')}</strong></div>`).join('')}</div>`;
}

function renderQuoteDetail() {
  const detail = state.quoteDetail;
  if (!detail) return;
  const reasons = detail.fillReasons.length ? detail.fillReasons : ['可审阅并回填浏览器表单'];
  const submitReasons = detail.submitReasons.length ? detail.submitReasons : ['回填证据已核对，可审阅提交'];
  const review = state.quoteReview ? `<div class="quote-confirm" id="quote-confirm">
    <strong>${state.quoteReview === 'fill' ? '确认回填这一条 RFQ' : '确认向买家提交这一条报价'}</strong>
    <p>请核对上面的 RFQ、数量、单价、总价和完整买家留言；草稿在确认后发生变化将被拒绝。</p>
    <label class="quote-check"><input id="quote-approve" type="checkbox" />我已逐项核对上述报价与买家留言</label>
    <label class="quote-id-input">输入完整 RFQ ID 确认<input id="quote-confirm-id" type="text" autocomplete="off" placeholder="${esc(detail.rfq.id)}" /></label>
    <div class="quote-confirm-actions"><button type="button" id="quote-cancel" class="light">取消</button><button type="button" id="quote-confirm-run" class="primary" disabled>${state.quoteReview === 'fill' ? '确认回填，不提交' : '确认向买家提交'}</button></div>
  </div>` : '';
  $('#quote-detail').innerHTML = `<div class="detail-top"><span class="kicker">RFQ QUOTE REVIEW</span><span class="detail-id">${esc(detail.id)}</span></div>
    <h3 class="quote-title">${esc(detail.rfq.title)}</h3>${quoteFacts(detail)}
    <div class="quote-message"><span>商品规格</span><p>${esc(detail.draft.productDetails || '未记录')}</p></div>
    <div class="quote-message"><span>将填入买家留言</span><p>${esc(detail.draft.buyerMessage || '未记录')}</p></div>
    <div class="quote-block"><strong>回填条件</strong><ul>${reasons.map((reason) => `<li>${esc(quoteReason(reason))}</li>`).join('')}</ul></div>
    <div class="quote-block"><strong>提交条件</strong><ul>${submitReasons.map((reason) => `<li>${esc(quoteReason(reason))}</li>`).join('')}</ul></div>
    ${detail.screenshotAvailable ? `<div class="quote-shot"><strong>上次回填截图</strong><img alt="浏览器报价表单回填截图" src="/api/quote/screenshot?draft=${encodeURIComponent(detail.id)}"></div>` : ''}
    <div class="quote-actions"><button type="button" class="light" data-quote-action="fill">审阅并回填</button><button type="button" class="primary" data-quote-action="submit">审阅并提交</button></div>${review}`;
  $('#quote-detail').querySelectorAll('[data-quote-action]').forEach((button) => button.addEventListener('click', () => { state.quoteReview = button.dataset.quoteAction; renderQuoteDetail(); $('#quote-confirm').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
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
    $('.ops-monitor').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    if (!$('#ops-term').options.length) {
      $('#ops-term').innerHTML = `<option value="__all__">全部配置品类</option>` +
        state.ops.searchTerms.map((term) => `<option value="${esc(term)}">${esc(term)}</option>`).join('');
    }
    renderOps();
    const run = state.ops.run;
    if (run && !['running', 'stopping', 'indexing'].includes(run.status) && state.lastFinishedRun !== run.id && ['refresh', 'once', 'watch', 'quote_fill', 'quote_submit'].includes(run.kind)) {
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
    state.ops = await opsRequest('/api/ops/start', { kind, term: $('#ops-term').value, limit: Number($('#ops-limit').value) });
    renderOps();
  } catch (error) {
    state.opsFlash = error.message;
    await updateOps();
  }
}

async function start() {
  try {
    state.selected = new URL(location.href).searchParams.get('case');
    $('#search').addEventListener('input', (event) => { state.query = event.target.value; renderList(); });
    $('#category').addEventListener('change', (event) => { state.category = event.target.value; renderList(); });
    $('#priced').addEventListener('change', (event) => { state.priced = event.target.checked; renderList(); });
    document.addEventListener('keydown', (event) => { if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); } });
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.action)));
    $('#env-recheck').addEventListener('click', () => loadEnv(true));
    document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', async () => {
      const settings = button.dataset.mode === 'auto'
        ? { browserEnabled: true, quoteEnabled: true }
        : { quoteEnabled: false };
      try { state.opsFlash = ''; state.ops = await opsRequest('/api/ops/settings', settings); renderOps(); }
      catch (error) { state.opsFlash = error.message; renderOps(); }
    }));
    for (const [key, id] of [['browserEnabled', '#browser-enabled'], ['alertsEnabled', '#alerts-enabled']]) {
      $(id).addEventListener('change', async (event) => {
        try { state.opsFlash = ''; state.ops = await opsRequest('/api/ops/settings', { [key]: event.target.checked }); renderOps(); }
        catch (error) { event.target.checked = !event.target.checked; state.opsFlash = error.message; renderOps(); }
      });
    }
    $('#stop-run').addEventListener('click', async () => {
      try { state.opsFlash = ''; state.ops = await opsRequest('/api/ops/stop', {}); renderOps(); }
      catch (error) { state.opsFlash = error.message; renderOps(); }
    });
    await reloadCatalog();
    await updateOps();
    await loadQuotes();
    setView(new URL(location.href).searchParams.get('view'));
    setInterval(() => { if (state.view === 'console' || ['running', 'stopping', 'indexing'].includes(state.ops?.run?.status)) updateOps(); }, 2000);
  } catch (error) {
    $('#case-detail').innerHTML = `<div class="empty">无法读取 CASE 数据：${esc(error.message)}<br>请先运行 npm run cases:build，然后启动本地页面。</div>`;
  }
}

start();
