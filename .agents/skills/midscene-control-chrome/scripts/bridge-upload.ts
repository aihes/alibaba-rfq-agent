import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const stdoutLog = console.log.bind(console);
console.log = (...messages: unknown[]) => console.error(...messages);

const args = process.argv.slice(2);
const url = process.env.MIDSCENE_URL;
const timeout = Number(process.env.MIDSCENE_BRIDGE_TIMEOUT_MS || 20000);

function takeOption(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function output(value: unknown): void {
  stdoutLog(JSON.stringify(value, null, 2));
}

const prompt = takeOption('--prompt');
const files = args.map((file) => resolve(file));

if (!prompt) {
  console.error('Missing --prompt <visible-upload-control-description>.');
  process.exit(1);
}

if (files.length === 0) {
  console.error('Missing file path.');
  process.exit(1);
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`File does not exist: ${file}`);
    process.exit(1);
  }
}

const agent = new AgentOverChromeBridge({
  serverListeningTimeout: timeout,
  closeConflictServer: true,
  generateReport: true,
  autoPrintReportMsg: true,
});

function unwrapCdpValue(response: any): unknown {
  if (response?.result && 'value' in response.result) return response.result.value;
  if (response?.result?.type === 'undefined') return undefined;
  return response;
}

function mimeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}

async function fallbackInjectFiles(center?: [number, number]): Promise<unknown> {
  const payloads = await Promise.all(files.map(async (file) => {
    const bytes = await readFile(file);
    return {
      path: file,
      name: file.split('/').pop() || 'file',
      type: mimeFromPath(file),
      base64: bytes.toString('base64'),
    };
  }));

  const expression = `(() => {
    const center = ${JSON.stringify(center || null)};
    const payloads = ${JSON.stringify(payloads)};
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    if (!inputs.length) throw new Error('No input[type=file] found for fallback upload');
    const candidates = inputs.filter(visible);
    const pool = candidates.length ? candidates : inputs;
    let input = pool[0];
    if (center) {
      input = pool.slice().sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const ad = Math.hypot((ar.x + ar.width / 2) - center[0], (ar.y + ar.height / 2) - center[1]);
        const bd = Math.hypot((br.x + br.width / 2) - center[0], (br.y + br.height / 2) - center[1]);
        return ad - bd;
      })[0];
    }
    if (payloads.length > 1 && !input.multiple) throw new Error('Target file input does not allow multiple files');
    const dt = new DataTransfer();
    for (const payload of payloads) {
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      dt.items.add(new File([bytes], payload.name, { type: payload.type }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const rect = input.getBoundingClientRect();
    return {
      ok: true,
      method: 'dom-fallback',
      selectedNames: Array.from(input.files).map((file) => file.name),
      input: {
        id: input.id || undefined,
        name: input.name || undefined,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      }
    };
  })()`;

  const response = await agent.evaluateJavaScript(`JSON.stringify(${expression})`);
  const value = unwrapCdpValue(response);
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

try {
  if (url) {
    await agent.connectNewTabWithUrl(url);
  } else {
    await agent.connectCurrentTab();
  }

  const located = await agent.aiLocate(prompt).catch(() => undefined);
  const center = Array.isArray(located?.center) ? located.center as [number, number] : undefined;

  try {
    await agent.aiTap(prompt, {
      fileChooserAccept: files,
    });

    output({
      ok: true,
      action: 'upload',
      method: 'native-file-chooser',
      prompt,
      files,
    });
  } catch (error) {
    const fallback = await fallbackInjectFiles(center);
    output({
      ok: true,
      action: 'upload',
      prompt,
      files,
      nativeError: error instanceof Error ? error.message : String(error),
      fallback,
    });
  }
} finally {
  await agent.destroy(false);
}
