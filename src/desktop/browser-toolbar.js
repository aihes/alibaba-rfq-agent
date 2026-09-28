const title = document.querySelector("#tab-title"), address = document.querySelector("#address"), copy = document.querySelector("#copy"), feedback = document.querySelector("#feedback");
const back = document.querySelector("#back"), forward = document.querySelector("#forward");
let canCopy = false, navigating = false, canGoBack = false, canGoForward = false;
function updateNavigationButtons() {
  back.disabled = navigating || !canGoBack;
  forward.disabled = navigating || !canGoForward;
}
window.rfqTab.onState((state) => {
  title.textContent = state.title || "Alibaba";
  address.value = state.url || "";
  canCopy = state.canCopy; copy.disabled = !canCopy;
  canGoBack = Boolean(state.canGoBack) && !state.busy;
  canGoForward = Boolean(state.canGoForward) && !state.busy;
  updateNavigationButtons();
  address.title = state.canCopy ? "选中后可使用 ⌘C / Ctrl+C，也可点击复制链接" : "登录页面不显示认证参数";
  feedback.textContent = "";
});
for (const [button, action] of [[back, "back"], [forward, "forward"]]) button.addEventListener("click", async () => {
  navigating = true; updateNavigationButtons(); feedback.textContent = "";
  try {
    const result = await window.rfqTab.navigate(action);
    if (!result.ok) feedback.textContent = result.error || "暂不可导航";
  } catch { feedback.textContent = "导航失败"; }
  finally { navigating = false; updateNavigationButtons(); }
});
copy.addEventListener("click", async () => {
  copy.disabled = true;
  try { feedback.textContent = (await window.rfqTab.copy()).ok ? "已复制" : "暂不可复制"; }
  catch { feedback.textContent = "复制失败"; }
  finally { copy.disabled = !canCopy; }
});
