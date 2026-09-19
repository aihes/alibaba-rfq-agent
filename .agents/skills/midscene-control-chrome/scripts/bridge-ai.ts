import { AgentOverChromeBridge } from '@midscene/web/bridge-mode';

const mode = process.argv[2] || 'ask';
const prompt = process.argv.slice(3).join(' ').trim();
const url = process.env.MIDSCENE_URL;
const timeout = Number(process.env.MIDSCENE_BRIDGE_TIMEOUT_MS || 20000);

if (!prompt && mode !== 'tabs') {
  console.error('Missing prompt.');
  process.exit(1);
}

const agent = new AgentOverChromeBridge({
  serverListeningTimeout: timeout,
  closeConflictServer: true,
  generateReport: true,
  autoPrintReportMsg: true,
});

try {
  if (mode === 'tabs') {
    const tabs = await agent.getBrowserTabList();
    console.log(JSON.stringify(tabs, null, 2));
  } else {
    if (url) {
      await agent.connectNewTabWithUrl(url);
    } else {
      await agent.connectCurrentTab();
    }

    if (mode === 'act') {
      const result = await agent.ai(prompt);
      if (result) console.log(result);
    } else if (mode === 'assert') {
      const result = await agent.aiAssert(prompt);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await agent.aiAsk(prompt);
      console.log(result);
    }
  }
} finally {
  await agent.destroy(false);
}
