import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { safeStorage, app, BrowserWindow, nativeTheme, ipcMain, shell } from "electron";
import { generateNodeKeyPair, createId, decryptForNode, PreviewRuntimeAdapter, TaskRepository, WorkItemRepository, TaskService, SqliteMemoryService } from "@molly/core";
import { nodeInboundFrameSchema, taskInputSchema } from "@molly/contracts";
import WebSocket from "ws";
import __cjs_mod__ from "node:module";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
class GatewayNodeClient {
  constructor(options) {
    this.options = options;
    for (const task of options.service.list()) {
      if (task.origin === "feishu") this.remoteTasks.add(task.id);
    }
    this.unsubscribe = options.service.subscribe((event) => this.handleTaskServiceEvent(event));
  }
  options;
  credentials = null;
  socket = null;
  reconnectTimer = null;
  heartbeatTimer = null;
  reconnectAttempt = 0;
  stopped = false;
  paused = false;
  remoteTasks = /* @__PURE__ */ new Set();
  sentSeq = /* @__PURE__ */ new Map();
  sentResults = /* @__PURE__ */ new Map();
  unsubscribe;
  async start() {
    if (!this.options.gatewayUrl) return;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows 安全凭据存储当前不可用，飞书个人节点没有启动。");
    }
    this.credentials = this.loadOrCreateCredentials();
    if (!this.credentials.encryptedNodeToken || !this.credentials.websocketUrl) await this.pair();
    this.connect();
  }
  loadOrCreateCredentials() {
    if (existsSync(this.options.credentialsPath)) {
      const parsed = JSON.parse(readFileSync(this.options.credentialsPath, "utf8"));
      if (parsed.nodeId && parsed.publicKey && parsed.encryptedPrivateKey) return parsed;
    }
    const keys = generateNodeKeyPair();
    const created = {
      nodeId: createId("node"),
      publicKey: keys.publicKey,
      encryptedPrivateKey: safeStorage.encryptString(keys.privateKey).toString("base64"),
      encryptedNodeToken: null,
      websocketUrl: null
    };
    this.saveCredentials(created);
    return created;
  }
  saveCredentials(credentials) {
    mkdirSync(dirname(this.options.credentialsPath), { recursive: true });
    writeFileSync(this.options.credentialsPath, JSON.stringify(credentials, null, 2), { encoding: "utf8", mode: 384 });
  }
  decryptSecret(value) {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  }
  async pair() {
    if (!this.credentials) throw new Error("个人节点密钥尚未创建。");
    if (!this.options.pairingToken) throw new Error("缺少 MOLLY_PAIRING_TOKEN，个人节点无法首次配对。");
    const response = await fetch(new URL("/v1/nodes/pair", this.options.gatewayUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.pairingToken}`
      },
      body: JSON.stringify({ nodeId: this.credentials.nodeId, publicKey: this.credentials.publicKey })
    });
    const payload = await response.json();
    if (!response.ok || typeof payload.nodeToken !== "string" || typeof payload.websocketUrl !== "string") {
      throw new Error(`个人节点配对失败，状态码 ${response.status}。`);
    }
    this.credentials.encryptedNodeToken = safeStorage.encryptString(payload.nodeToken).toString("base64");
    this.credentials.websocketUrl = payload.websocketUrl;
    this.saveCredentials(this.credentials);
  }
  connect() {
    if (this.stopped || !this.credentials?.encryptedNodeToken || !this.credentials.websocketUrl) return;
    const token = this.decryptSecret(this.credentials.encryptedNodeToken);
    const socket = new WebSocket(this.credentials.websocketUrl, { headers: { authorization: `Bearer ${token}` } });
    this.socket = socket;
    socket.on("open", () => {
      this.reconnectAttempt = 0;
      this.sentSeq.clear();
      this.sentResults.clear();
      this.send({ type: "ready", nodeId: this.credentials?.nodeId ?? "" });
      this.startHeartbeat();
      this.replayRemoteState();
    });
    socket.on("message", (data) => {
      try {
        const frame = nodeInboundFrameSchema.parse(JSON.parse(data.toString()));
        void this.handleFrame(frame);
      } catch {
        socket.close(1003, "invalid frame");
      }
    });
    socket.on("close", () => this.scheduleReconnect(socket));
    socket.on("error", () => this.scheduleReconnect(socket));
  }
  async handleFrame(frame) {
    if (frame.type === "pause") {
      this.paused = frame.paused;
      return;
    }
    if (frame.type === "cancel") {
      if (this.options.service.get(frame.taskId)) await this.options.service.cancel(frame.taskId);
      return;
    }
    if (this.paused || !this.credentials) return;
    const privateKey = this.decryptSecret(this.credentials.encryptedPrivateKey);
    const input = taskInputSchema.parse(JSON.parse(decryptForNode(privateKey, frame.job.envelope)));
    if (input.source !== "feishu" || input.taskId !== frame.job.taskId) throw new Error("网关任务来源或编号不匹配。");
    this.remoteTasks.add(frame.job.taskId);
    const snapshot = this.options.service.hasInputEvent(input.eventId) ? this.options.service.get(frame.job.taskId) : this.options.service.get(frame.job.taskId) ? this.options.service.steer(frame.job.taskId, input) : this.options.service.create(input, { taskId: frame.job.taskId, autoRun: true });
    if (!snapshot) throw new Error("本地任务状态不存在，无法确认网关任务。");
    this.send({ type: "job_ack", jobId: frame.job.id, taskId: frame.job.taskId });
    this.publishSnapshot(snapshot);
  }
  handleTaskServiceEvent(event) {
    if (event.type !== "snapshot" || !this.remoteTasks.has(event.snapshot.task.id)) return;
    this.publishSnapshot(event.snapshot);
  }
  replayRemoteState() {
    for (const taskId of this.remoteTasks) {
      const snapshot = this.options.service.get(taskId);
      if (snapshot) this.publishSnapshot(snapshot);
    }
  }
  publishSnapshot(snapshot) {
    const lastSent = this.sentSeq.get(snapshot.task.id) ?? 0;
    for (const event of snapshot.events) {
      if (event.seq <= lastSent) continue;
      if (!this.send({ type: "task_event", event })) return;
      this.sentSeq.set(snapshot.task.id, event.seq);
    }
    if (!["completed", "failed", "canceled"].includes(snapshot.task.status)) return;
    if (this.sentResults.get(snapshot.task.id) === snapshot.task.status) return;
    const summary = [...snapshot.messages].reverse().find((message) => message.role === "assistant")?.content ?? snapshot.events.at(-1)?.summary ?? "任务已结束。";
    if (this.send({ type: "task_result", taskId: snapshot.task.id, summary, artifacts: snapshot.task.artifacts })) {
      this.sentResults.set(snapshot.task.id, snapshot.task.status);
    }
  }
  send(frame) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }
  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", occurredAt: (/* @__PURE__ */ new Date()).toISOString() });
    }, 2e4);
  }
  scheduleReconnect(socket) {
    if (this.socket !== socket || this.stopped) return;
    this.socket = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.reconnectTimer) return;
    const delay = Math.min(3e4, 1e3 * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  async dispose() {
    this.stopped = true;
    this.unsubscribe();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close(1e3, "shutdown");
    this.socket = null;
  }
}
let mainWindow = null;
let taskService = null;
let gatewayNodeClient = null;
let workItemRepository = null;
function projectRoot() {
  if (process.env.MOLLY_PROJECT_ROOT) return resolve(process.env.MOLLY_PROJECT_ROOT);
  if (app.isPackaged) return join(app.getPath("documents"), "Molly");
  return resolve(app.getAppPath(), "..", "..");
}
function createTaskInput(text, taskId) {
  return {
    eventId: createId("desktop_event"),
    taskId,
    source: "desktop",
    senderId: "yi-desktop",
    text,
    attachments: [],
    replyToMessageId: null,
    conversationRef: "molly-desktop",
    receivedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function registerIpc(service, runtimeMode) {
  ipcMain.handle("molly:tasks:list", (_event, query) => service.list(typeof query === "string" ? query : ""));
  ipcMain.handle("molly:tasks:get", (_event, taskId) => {
    if (typeof taskId !== "string") throw new Error("任务编号无效。");
    return service.get(taskId);
  });
  ipcMain.handle("molly:tasks:create", (_event, text) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("告诉 Molly 你希望完成什么。");
    return service.create(createTaskInput(text.trim()));
  });
  ipcMain.handle("molly:tasks:steer", (_event, taskId, text) => {
    if (typeof taskId !== "string" || typeof text !== "string" || !text.trim()) throw new Error("补充内容无效。");
    return service.steer(taskId, createTaskInput(text.trim(), taskId));
  });
  ipcMain.handle("molly:tasks:cancel", async (_event, taskId) => {
    if (typeof taskId !== "string") throw new Error("任务编号无效。");
    return service.cancel(taskId);
  });
  ipcMain.handle("molly:tasks:stop-all", async () => {
    const active = service.list().filter((task) => ["queued", "running", "waiting_input"].includes(task.status));
    await Promise.all(active.map((task) => service.cancel(task.id)));
    return { stopped: active.length };
  });
  ipcMain.handle("molly:work-items:list", () => workItemRepository?.list("active") ?? []);
  ipcMain.handle("molly:work-items:get", (_event, workItemId) => {
    if (typeof workItemId !== "string") throw new Error("工作项编号无效。");
    return workItemRepository?.get(workItemId) ?? null;
  });
  ipcMain.handle("molly:focus:route", (_event, currentWorkItemId, text) => {
    if (typeof currentWorkItemId !== "string" || typeof text !== "string" || !text.trim()) throw new Error("焦点路由参数无效。");
    return service.route(createTaskInput(text.trim()), currentWorkItemId);
  });
  ipcMain.handle("molly:runtime:info", () => ({
    mode: runtimeMode,
    label: runtimeMode === "preview" ? "预览运行" : "Pi Runtime"
  }));
  ipcMain.handle("molly:artifacts:open", async (_event, ref) => {
    if (typeof ref !== "string" || !ref.trim()) return false;
    if (/^https?:\/\//i.test(ref)) {
      await shell.openExternal(ref);
      return true;
    }
    shell.showItemInFolder(resolve(ref));
    return true;
  });
  ipcMain.handle("molly:artifacts:restore", (_event, taskId, artifactId) => {
    if (typeof taskId !== "string" || typeof artifactId !== "string") throw new Error("产物版本参数无效。");
    return service.restoreArtifact(taskId, artifactId);
  });
}
async function createWindow() {
  const root = projectRoot();
  mkdirSync(root, { recursive: true });
  const dataDir = join(app.getPath("userData"), "data");
  mkdirSync(dataDir, { recursive: true });
  const runtimeMode = process.env.MOLLY_RUNTIME_MODE ?? (app.isPackaged ? "pi" : "preview");
  const runtime = runtimeMode === "preview" ? new PreviewRuntimeAdapter() : new (await import("@molly/core/pi-runtime-adapter")).PiRuntimeAdapter({
    cwd: root,
    agentDir: join(root, ".pi-home"),
    sessionDir: join(root, ".pi", "sessions")
  });
  const taskRepository = new TaskRepository(join(dataDir, "molly.db"));
  workItemRepository = new WorkItemRepository(taskRepository.database, join(root, ".molly", "work-items"));
  taskService = new TaskService(taskRepository, runtime, workItemRepository, new SqliteMemoryService(taskRepository.database));
  void taskService.recover().catch((error) => console.error("[molly] task recovery failed:", error));
  gatewayNodeClient = new GatewayNodeClient({
    service: taskService,
    credentialsPath: join(dataDir, "gateway-node.json"),
    gatewayUrl: process.env.MOLLY_GATEWAY_URL ?? "",
    pairingToken: process.env.MOLLY_PAIRING_TOKEN ?? ""
  });
  void gatewayNodeClient.start().catch((error) => {
    console.error("[molly] gateway node disabled:", error instanceof Error ? error.message : String(error));
  });
  registerIpc(taskService, runtimeMode);
  nativeTheme.themeSource = "light";
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: "#F2EFE7",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#F2EFE7",
      symbolColor: "#3A403A",
      height: 42
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  const unsubscribe = taskService.subscribe((event) => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send("molly:task-event", event);
  });
  mainWindow.on("closed", unsubscribe);
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}
app.whenReady().then(createWindow).catch((error) => {
  console.error("[molly] startup failed", error);
  app.quit();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
app.on("before-quit", () => {
  void gatewayNodeClient?.dispose();
  void taskService?.dispose();
});
