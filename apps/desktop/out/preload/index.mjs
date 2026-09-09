import { contextBridge, ipcRenderer } from "electron";
const api = {
  listTasks: (query = "") => ipcRenderer.invoke("molly:tasks:list", query),
  getTask: (taskId) => ipcRenderer.invoke("molly:tasks:get", taskId),
  createTask: (text) => ipcRenderer.invoke("molly:tasks:create", text),
  steerTask: (taskId, text) => ipcRenderer.invoke("molly:tasks:steer", taskId, text),
  cancelTask: (taskId) => ipcRenderer.invoke("molly:tasks:cancel", taskId),
  stopAll: () => ipcRenderer.invoke("molly:tasks:stop-all"),
  listWorkItems: () => ipcRenderer.invoke("molly:work-items:list"),
  getWorkItem: (workItemId) => ipcRenderer.invoke("molly:work-items:get", workItemId),
  openArtifact: (ref) => ipcRenderer.invoke("molly:artifacts:open", ref),
  runtimeInfo: () => ipcRenderer.invoke("molly:runtime:info"),
  onTaskEvent: (listener) => {
    const wrapped = (_event, value) => listener(value);
    ipcRenderer.on("molly:task-event", wrapped);
    return () => {
      ipcRenderer.off("molly:task-event", wrapped);
    };
  }
};
contextBridge.exposeInMainWorld("molly", api);
