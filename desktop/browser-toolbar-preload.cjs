const { contextBridge, ipcRenderer } = require("electron");
// 只向本地标签栏暴露固定导航与复制动作。远程 Alibaba 页面不加载此 preload，
// 也不接触窗口标题、剪贴板或任务令牌。
contextBridge.exposeInMainWorld("rfqTab", {
  copy: () => ipcRenderer.invoke("rfq-tab-copy"),
  navigate: (action) => ipcRenderer.invoke("rfq-tab-navigate", action),
  onState: (callback) => ipcRenderer.on("rfq-tab-state", (_event, state) => callback(state))
});
