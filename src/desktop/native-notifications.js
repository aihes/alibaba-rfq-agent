/** 可复用的 Electron 通知适配器。业务规则、持久化去重由 src 的通知
 * 工具负责；这里仅把固定标题、正文与草稿目标交给操作系统。
 * 不向调用者暴露 BrowserWindow、shell、URL 或任意 IPC 权限。
 */
export function createNativeNotifier({ Notification, openDraft, showOpportunity = () => {}, waitMs = 1500 }) {
  const active = new Set();
  const draftPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
  const clean = (value) => String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
  function attach(notification, draftId) {
    active.add(notification);
    notification.on("click", () => openDraft(draftId));
    notification.on("close", () => active.delete(notification));
  }
  async function send(payload) {
    if (payload.draftId !== undefined && !draftPattern.test(payload.draftId)) throw new Error("通知草稿 ID 无效");
    if (payload.test !== true && !payload.draftId) throw new Error("机会通知必须指定草稿 ID");
    const test = payload.test === true;
    // 系统横幅可能被通知权限或专注模式隐藏。真实机会同时唤出本应用，
    // 渲染页从持久化记录弹出提醒；系统通知不可用也不丢失产品内入口。
    if (!test) { try { showOpportunity(); } catch { /* 系统通知仍继续尝试 */ } }
    if (!Notification.isSupported()) return { status: "unsupported", detail: "当前系统不支持原生通知；请在 RFQ 助手查看提醒" };
    const notification = new Notification({ title: "RFQ 助手", id: test ? "rfq-test" : `rfq-${payload.draftId}`,
      groupId: "rfq-opportunities", sound: "default",
      body: test ? "系统通知测试：收到后即可开启持续监控。"
        : `可报价机会：${clean(payload.message)}。点击查看草稿并人工复核。` });
    attach(notification, payload.draftId);
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => done({ status: "requested", detail: "已请求系统通知；请检查 RFQ 助手的通知权限和专注模式" }), waitMs);
      notification.once("show", () => done({ status: "accepted", detail: "系统已接受通知；横幅显示仍取决于系统设置和专注模式" }));
      notification.once("failed", () => {
        active.delete(notification);
        done({ status: "failed", detail: "系统通知未被接受。请允许 RFQ 助手通知；macOS 应用需要代码签名" });
      });
      try { notification.show(); } catch {
        active.delete(notification); done({ status: "failed", detail: "系统通知发送失败，请检查系统通知设置" });
      }
    });
  }
  // 不在启动时读取通知中心历史。系统通知服务或授权异常时，该原生
  // API 可能同步等待，阻塞主进程与窗口启动。只在明确发送时调用系统。
  return { send };
}
