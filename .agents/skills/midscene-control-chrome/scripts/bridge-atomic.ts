import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import { Buffer } from 'node:buffer';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';

const stdoutLog = console.log.bind(console);
console.log = (...messages: unknown[]) => console.error(...messages);

const command = process.argv[2];
const args = process.argv.slice(3);
const url = process.env.MIDSCENE_URL;
const timeout = Number(process.env.MIDSCENE_BRIDGE_TIMEOUT_MS || 20000);
const reuseTabPolicy = (process.env.MIDSCENE_REUSE_TAB || 'exact').toLowerCase();

function parseOption(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function positionalArgs(): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      i += 1;
    } else {
      values.push(args[i]);
    }
  }
  return values;
}

function inferImageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF') return '.webp';
  return '.jpg';
}

function output(value: unknown): void {
  stdoutLog(JSON.stringify(value, null, 2));
}

function unwrapCdpValue(response: any): unknown {
  if (response?.result && 'value' in response.result) return response.result.value;
  if (response?.result?.type === 'undefined') return undefined;
  return response;
}

function normalizedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

function sameOrigin(left: string | undefined, right: string | undefined): boolean {
  try {
    return Boolean(left && right && new URL(left).origin === new URL(right).origin);
  } catch {
    return false;
  }
}

async function connectRequestedUrl(targetUrl: string): Promise<{ mode: string; tabId?: string; url: string }> {
  const targetNormalized = normalizedUrl(targetUrl) || targetUrl;

  if (reuseTabPolicy !== 'off') {
    const tabs = await agent.getBrowserTabList().catch((error) => {
      console.error(`Could not inspect tabs before opening URL: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });

    const exactTab = tabs?.find((tab) => normalizedUrl(tab.url) === targetNormalized);
    if (exactTab) {
      await agent.setActiveTabId(exactTab.id);
      await agent.connectCurrentTab({ forceSameTabNavigation: true, timeout });
      return { mode: 'reuse-exact-tab', tabId: exactTab.id, url: exactTab.url };
    }

    if (reuseTabPolicy === 'same-origin') {
      const sameOriginTab = tabs?.find((tab) => sameOrigin(tab.url, targetNormalized));
      if (sameOriginTab) {
        await agent.setActiveTabId(sameOriginTab.id);
        await agent.connectCurrentTab({ forceSameTabNavigation: true, timeout });
        if (normalizedUrl(sameOriginTab.url) !== targetNormalized) {
          await agent.page.navigate(targetUrl);
        }
        return { mode: 'reuse-same-origin-tab', tabId: sameOriginTab.id, url: targetUrl };
      }
    }
  }

  await agent.connectNewTabWithUrl(targetUrl);
  return { mode: 'new-tab', url: targetUrl };
}

async function evaluateJsonExpression(expression: string): Promise<unknown> {
  const response = await agent.evaluateJavaScript(`JSON.stringify(${expression})`);
  const value = unwrapCdpValue(response);
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

const pageSummaryScript = (textLimit: number, elementLimit: number) => `
(() => {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const selector = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="link"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[aria-label]'
  ].join(',');
  const elements = Array.from(document.querySelectorAll(selector))
    .filter(visible)
    .slice(0, ${elementLimit})
    .map((el, index) => {
      const rect = el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const text = clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder'));
      return {
        index,
        tag,
        role: el.getAttribute('role') || undefined,
        type: el.getAttribute('type') || undefined,
        text,
        name: el.getAttribute('name') || undefined,
        id: el.id || undefined,
        href: tag === 'a' ? el.href : undefined,
        disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
  return {
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight
    },
    text: clean(document.body ? document.body.innerText : '').slice(0, ${textLimit}),
    elements
  };
})()
`;

const agent = new AgentOverChromeBridge({
  serverListeningTimeout: timeout,
  closeConflictServer: true,
  generateReport: false,
  autoPrintReportMsg: false,
});

try {
  let connection: { mode: string; tabId?: string; url?: string } | undefined;

  if (command === 'tabs') {
    output(await agent.getBrowserTabList());
    process.exit(0);
  }

  if (url) {
    connection = await connectRequestedUrl(url);
  } else {
    await agent.connectCurrentTab();
    connection = { mode: 'current-tab' };
  }

  if (command === 'snapshot') {
    const textLimit = Number(parseOption('--text-limit') || 8000);
    const elementLimit = Number(parseOption('--element-limit') || 120);
    const screenshotOption = parseOption('--screenshot');
    const summary = await evaluateJsonExpression(pageSummaryScript(textLimit, elementLimit));

    let screenshotPath: string | undefined;
    if (screenshotOption) {
      const base64 = await agent.page.screenshotBase64();
      const bytes = Buffer.from(base64, 'base64');
      const extension = screenshotOption === 'auto' ? inferImageExtension(bytes) : (extname(screenshotOption) || inferImageExtension(bytes));
      screenshotPath = screenshotOption === 'auto'
        ? resolve(`midscene_run/snapshots/snapshot-${Date.now()}${extension}`)
        : resolve(screenshotOption);
      await mkdir(dirname(screenshotPath), { recursive: true });
      await writeFile(screenshotPath, bytes);
    }

    output({ ...(summary as Record<string, unknown>), connection, screenshotPath });
  } else if (command === 'eval') {
    const script = args.join(' ');
    if (!script) throw new Error('Missing JavaScript for eval.');
    output(await evaluateJsonExpression(script));
  } else if (command === 'click') {
    const [x, y] = positionalArgs().map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Usage: click <x> <y>');
    await agent.page.mouse.click(x, y, { button: 'left' });
    output({ ok: true, action: 'click', x, y, connection });
  } else if (command === 'type') {
    const text = positionalArgs().join(' ');
    await agent.page.keyboard.type(text);
    output({ ok: true, action: 'type', length: text.length, connection });
  } else if (command === 'press') {
    const [key] = positionalArgs();
    if (!key) throw new Error('Usage: press <key>');
    await agent.page.keyboard.press({ key: key as any });
    output({ ok: true, action: 'press', key, connection });
  } else if (command === 'scroll') {
    const [direction, distanceArg] = positionalArgs();
    const distance = distanceArg ? Number(distanceArg) : undefined;
    if (direction === 'down') await agent.page.scrollDown(distance);
    else if (direction === 'up') await agent.page.scrollUp(distance);
    else if (direction === 'left') await agent.page.scrollLeft(distance);
    else if (direction === 'right') await agent.page.scrollRight(distance);
    else if (direction === 'top') await agent.page.scrollUntilTop();
    else if (direction === 'bottom') await agent.page.scrollUntilBottom();
    else throw new Error('Usage: scroll <down|up|left|right|top|bottom> [distance]');
    output({ ok: true, action: 'scroll', direction, distance, connection });
  } else if (command === 'nav') {
    const [targetUrl] = positionalArgs();
    if (!targetUrl) throw new Error('Usage: nav <url>');
    await agent.page.navigate(targetUrl);
    output({ ok: true, action: 'nav', url: targetUrl, connection });
  } else if (command === 'back') {
    await agent.page.goBack();
    output({ ok: true, action: 'back', connection });
  } else if (command === 'forward') {
    await agent.page.goForward();
    output({ ok: true, action: 'forward', connection });
  } else if (command === 'reload') {
    await agent.page.reload();
    output({ ok: true, action: 'reload', connection });
  } else {
    throw new Error(`Unknown atomic command: ${command}`);
  }
} finally {
  await agent.destroy(false);
}
