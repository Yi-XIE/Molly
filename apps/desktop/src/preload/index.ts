import { contextBridge, ipcRenderer } from 'electron';
import type { TaskInput, TaskSnapshot } from '@molly/contracts';
import type { TaskServiceEvent } from '@molly/core';

const api = {
  listTasks: (query = '') => ipcRenderer.invoke('molly:tasks:list', query),
  getTask: (taskId: string) => ipcRenderer.invoke('molly:tasks:get', taskId),
  createTask: (text: string) => ipcRenderer.invoke('molly:tasks:create', text),
  steerTask: (taskId: string, text: string) => ipcRenderer.invoke('molly:tasks:steer', taskId, text),
  cancelTask: (taskId: string) => ipcRenderer.invoke('molly:tasks:cancel', taskId),
  stopAll: () => ipcRenderer.invoke('molly:tasks:stop-all'),
  listWorkItems: () => ipcRenderer.invoke('molly:work-items:list'),
  getWorkItem: (workItemId: string) => ipcRenderer.invoke('molly:work-items:get', workItemId),
  routeFocus: (currentWorkItemId: string, text: string) => ipcRenderer.invoke('molly:focus:route', currentWorkItemId, text),
  openArtifact: (ref: string) => ipcRenderer.invoke('molly:artifacts:open', ref),
  runtimeInfo: () => ipcRenderer.invoke('molly:runtime:info'),
  onTaskEvent: (listener: (event: TaskServiceEvent) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: TaskServiceEvent) => listener(value);
    ipcRenderer.on('molly:task-event', wrapped);
    return () => { ipcRenderer.off('molly:task-event', wrapped); };
  },
};

contextBridge.exposeInMainWorld('molly', api);

export type MollyDesktopApi = typeof api;
export type { TaskInput, TaskSnapshot };
