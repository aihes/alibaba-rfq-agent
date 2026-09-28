const button = document.querySelector('#export'), status = document.querySelector('#status');
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    // 扩展的 host_permissions 仅覆盖 Alibaba；再显式筛选一次域名，
    // 包含 passport 等子域的 host-only Cookie，避免遗漏登录跳转记录。
    const cookies = (await chrome.cookies.getAll({})).filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain === 'alibaba.com' || domain.endsWith('.alibaba.com');
    });
    if (!cookies.length) throw new Error('未找到 Alibaba 登录记录，请先手动登录。');
    const blob = new Blob([JSON.stringify({ kind: 'rfq-alibaba-cookies', version: 1, cookies })], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'rfq-alibaba-login.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    status.textContent = `已导出 ${cookies.length} 条记录，请在 RFQ 助手的「浏览器」页面导入。`;
  } catch (error) { status.textContent = error.message.includes('未找到') ? error.message : '导出失败，请检查插件权限和 Alibaba 登录状态。'; }
  finally { button.disabled = false; }
});
