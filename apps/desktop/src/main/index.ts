import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron';
import type { TaskInput } from '@molly/contracts';
import {
  PreviewRuntimeAdapter,
  TaskRepository,
  TaskService,
  createId,
} from '@molly/core';
import { PiRuntimeAdapter } from '@molly/core/pi-runtime-adapter';
import { GatewayNodeClient } from './gateway-node-client.js';

let mainWindow: BrowserWindow | null = null;
let taskService: TaskService | null = null;
let gatewayNodeClient: GatewayNodeClient | null = null;

function projectRoot(): string {
  if (process.env.MOLLY_PROJECT_ROOT) return resolve(process.env.MOLLY_PROJECT_ROOT);
  if (app.isPackaged) return join(app.getPath('documents'), 'Molly');
  return resolve(app.getAppPath(), '..', '..');
}

function createTaskInput(text: string, taskId?: string): TaskInput {
  return {
    eventId: createId('desktop_event'),
    taskId,
    source: 'desktop',
    senderId: 'yi-desktop',
    text,
    attachments: [],
    replyToMessageId: null,
    conversationRef: 'molly-desktop',
    receivedAt: new Date().toISOString(),
  };
}

function registerIpc(service: TaskService, runtimeMode: string): void {
  ipcMain.handle('molly:tasks:list', (_event, query: unknown) => service.list(typeof query === 'string' ? query : ''));
  ipcMain.handle('molly:tasks:get', (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') throw new Error('任务编号无效。');
    return service.get(taskId);
  });
  ipcMain.handle('molly:tasks:create', (_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('告诉 Molly 你希望完成什么。');
    return service.create(createTaskInput(text.trim()));
  });
  ipcMain.handle('molly:tasks:steer', (_event, taskId: unknown, text: unknown) => {
    if (typeof taskId !== 'string' || typeof text !== 'string' || !text.trim()) throw new Error('补充内容无效。');
    return service.steer(taskId, createTaskInput(text.trim(), taskId));
  });
  ipcMain.handle('molly:tasks:cancel', async (_event, taskId: unknown) => {
    if (typeof taskId !== 'string') throw new Error('任务编号无效。');
    return service.cancel(taskId);
  });
  ipcMain.handle('molly:tasks:stop-all', async () => {
    const active = service.list().filter((task) => ['queued', 'running', 'waiting_input'].includes(task.status));
    await Promise.all(active.map((task) => service.cancel(task.id)));
    return { stopped: active.length };
  });
  ipcMain.handle('molly:runtime:info', () => ({
    mode: runtimeMode,
    label: runtimeMode === 'preview' ? '预览运行' : 'Pi Runtime',
  }));
  ipcMain.handle('molly:artifacts:open', async (_event, ref: unknown) => {
    if (typeof ref !== 'string' || !ref.trim()) return false;
    if (/^https?:\/\//i.test(ref)) {
      await shell.openExternal(ref);
      return true;
    }
    shell.showItemInFolder(resolve(ref));
    return true;
  });
}

async function createWindow(): Promise<void> {
  const root = projectRoot();
  mkdirSync(root, { recursive: true });
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  const runtimeMode = process.env.MOLLY_RUNTIME_MODE ?? (app.isPackaged ? 'pi' : 'preview');
  const runtime = runtimeMode === 'preview'
    ? new PreviewRuntimeAdapter()
    : new PiRuntimeAdapter({
        cwd: root,
        agentDir: join(root, '.pi-home'),
        sessionDir: join(root, '.pi', 'sessions'),
      });
  taskService = new TaskService(new TaskRepository(join(dataDir, 'molly.db')), runtime);
  gatewayNodeClient = new GatewayNodeClient({
    service: taskService,
    credentialsPath: join(dataDir, 'gateway-node.json'),
    gatewayUrl: process.env.MOLLY_GATEWAY_URL ?? '',
    pairingToken: process.env.MOLLY_PAIRING_TOKEN ?? '',
  });
  void gatewayNodeClient.start().catch((error) => {
    console.error('[molly] gateway node disabled:', error instanceof Error ? error.message : String(error));
  });
  registerIpc(taskService, runtimeMode);

  nativeTheme.themeSource = 'light';
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#F2EFE7',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F2EFE7',
      symbolColor: '#3A403A',
      height: 42,
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  const unsubscribe = taskService.subscribe((event) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send('molly:task-event', event);
  });
  mainWindow.on('closed', unsubscribe);

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow).catch((error) => {
  console.error('[molly] startup failed', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on('before-quit', () => {
  void gatewayNodeClient?.dispose();
  void taskService?.dispose();
});
