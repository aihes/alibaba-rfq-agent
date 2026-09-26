import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../frontend/src/index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../frontend/src/app.js", import.meta.url), "utf8");

for (const monitorPresent of [true, false]) {
  test(`starting a quote stays successful with monitor ${monitorPresent ? "present" : "absent"}`, async () => {
    let monitorScrolls = 0;
    let alertScrolls = 0;
    let requests = 0;
    // 运行真实报价事件函数，模拟 API 成功启动任务。不会连接 Alibaba。
    // 监控区 ID 来自真实 HTML，避免测试用旧的样式选择器掩盖布局回归。
    const monitorId = html.match(/<div class="monitor-card" id="([^"]+)"/)[1];
    const elements = {
      "#quote-confirm-id": { value: "rfq-exact" },
      "#quote-approve": { checked: true },
      "#ops-alert": { scrollIntoView: () => alertScrolls++ }
    };
    if (monitorPresent) elements[`#${monitorId}`] = { scrollIntoView: () => monitorScrolls++ };
    const context = vm.createContext({ document: { querySelector: (selector) => elements[selector] || null } });
    // 禁用页面自动初始化；此测试只审计“API 已成功后”的报价完成路径。
    vm.runInContext(source.replace(/\nstart\(\);\s*$/, ""), context);
    context.quoteRequest = async (_path, body) => {
      requests++;
      assert.equal(body.confirmation, "rfq-exact");
      assert.equal(body.approved, true);
      return { run: { status: "running" } };
    };
    vm.runInContext(`
      state.quoteDetail = { id: 'rfq-exact', reviewHash: 'review' };
      opsRequest = quoteRequest;
      renderOps = () => {};
      renderQuoteDetail = () => {};
    `, context);
    await vm.runInContext("executeQuoteAction('fill')", context);
    assert.equal(requests, 1);
    assert.equal(vm.runInContext("state.opsFlash", context), "");
    assert.equal(vm.runInContext("state.ops.run.status", context), "running");
    assert.equal(alertScrolls, 0);
    assert.equal(monitorScrolls, monitorPresent ? 1 : 0);
  });
}
