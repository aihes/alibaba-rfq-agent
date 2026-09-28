/** 两种浏览器传输共用的 DOM 接口。读取与写入分开标记；
 * Electron 主进程对写入额外检查逐单报价授权。这里不决定金额或批准提交。
 */
function selectorExpression(selector, index, body) {
  return `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    const element = nodes[${index}];
    ${body}
  })()`;
}

export class DomLocator {
  constructor(page, selector, index = 0) {
    this.page = page;
    this.selector = selector;
    this.index = index;
  }

  first() {
    return new DomLocator(this.page, this.selector, 0);
  }

  nth(index) {
    return new DomLocator(this.page, this.selector, index);
  }

  async waitFor({ state = "visible", timeout = 15000 } = {}) {
    const started = Date.now();
    while (Date.now() - started <= timeout) {
      const matches = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
        if (!element) return false;
        if (${JSON.stringify(state)} === "attached") return true;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      `));
      if (matches) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${this.selector} (${state})`);
  }

  async evaluateAll(callback, argument) {
    const expression = `(${callback.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(this.selector)})), ${JSON.stringify(argument)})`;
    return this.page.evaluateJson(expression);
  }

  async innerText({ timeout = 15000 } = {}) {
    await this.waitFor({ state: "attached", timeout });
    return this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      return element.innerText || element.textContent || "";
    `));
  }

  async fill(value) {
    const serialized = JSON.stringify(String(value));
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) return { ok: false, error: "element not found" };
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, ${serialized}); else element.value = ${serialized};
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: element.value === ${serialized}, value: element.value };
    `), { mutation: true });
    if (!result?.ok) throw new Error(`Could not fill ${this.selector}: ${result?.error || "value did not stick"}`);
  }

  async selectOption(value) {
    const serialized = JSON.stringify(String(value));
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!(element instanceof HTMLSelectElement)) return { ok: false, error: "select not found" };
      const option = Array.from(element.options).find((candidate) => candidate.value === ${serialized} || candidate.text.trim() === ${serialized});
      if (!option) return { ok: false, error: "option not found", options: Array.from(element.options).map((candidate) => ({ value: candidate.value, text: candidate.text.trim() })) };
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, option.value); else element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: element.value === option.value, value: element.value };
    `), { mutation: true });
    if (!result?.ok) throw new Error(`Could not select ${value} in ${this.selector}: ${result?.error || "value did not stick"}`);
  }

  async inputValue() {
    return this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) throw new Error("element not found");
      return element.value || "";
    `));
  }

  async check() {
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!(element instanceof HTMLInputElement)) return { ok: false, error: "input not found" };
      if (!element.checked) element.click();
      return { ok: element.checked };
    `), { mutation: true });
    if (!result?.ok) throw new Error(`Could not check ${this.selector}: ${result?.error || "state did not stick"}`);
  }

  async click() {
    const result = await this.page.evaluateJson(selectorExpression(this.selector, this.index, `
      if (!element) return { ok: false, error: "element not found" };
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "element is disabled" };
      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return { ok: true };
    `), { mutation: true });
    if (!result?.ok) throw new Error(`Could not click ${this.selector}: ${result?.error || "unknown error"}`);
  }

  async count() {
    return this.page.evaluateJson(`document.querySelectorAll(${JSON.stringify(this.selector)}).length`);
  }

  async screenshot() {
    throw new Error("Element screenshots are unavailable; use a page screenshot");
  }
}
