import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ArtifactRef, Task, TaskSnapshot, TaskStatus } from '@molly/contracts';
import type { TaskServiceEvent } from '@molly/core';

const STATUS_COPY: Record<TaskStatus, { label: string; tone: string }> = {
  queued_offline: { label: '等待个人节点', tone: 'quiet' },
  queued: { label: '排队中', tone: 'quiet' },
  running: { label: '正在处理', tone: 'active' },
  waiting_input: { label: '需要你确认', tone: 'attention' },
  completed: { label: '已完成', tone: 'done' },
  failed: { label: '需要恢复', tone: 'error' },
  canceled: { label: '已停止', tone: 'quiet' },
};

function timeLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.7"/><path d="m16 16 4 4"/></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>;
}

function StopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M14 7l5 5-5 5"/></svg>;
}

function ExternalIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>;
}

function MollyCore({ status = 'idle', small = false }: { status?: TaskStatus | 'idle'; small?: boolean }) {
  const active = status === 'running' || status === 'queued';
  return (
    <div className={`molly-core ${small ? 'small' : ''} ${active ? 'is-active' : ''}`} aria-label="Molly 状态">
      <div className="core-halo halo-one" />
      <div className="core-halo halo-two" />
      <div className="core-orbit"><i /><i /><i /></div>
      <div className="core-seed" />
    </div>
  );
}

function TaskItem({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: () => void }) {
  const copy = STATUS_COPY[task.status];
  return (
    <button className={`task-item ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className={`status-dot ${copy.tone}`} />
      <span className="task-item-copy">
        <strong>{task.title}</strong>
        <span>{copy.label}</span>
      </span>
      <time>{timeLabel(task.updatedAt)}</time>
    </button>
  );
}

function EmptyConversation({ onPrompt }: { onPrompt: (text: string) => void }) {
  const prompts = ['整理一下我今天的想法', '回顾最近的成长变化', '帮我研究一个产品问题'];
  return (
    <div className="empty-conversation">
      <MollyCore />
      <p className="eyebrow">MOLLY · PERSONAL NODE</p>
      <h1>今天想一起完成什么？</h1>
      <p className="empty-lead">想法可以很模糊。你说出来，我会陪你把它变成行动与产物。</p>
      <div className="prompt-row">
        {prompts.map((prompt) => <button key={prompt} onClick={() => onPrompt(prompt)}>{prompt}</button>)}
      </div>
    </div>
  );
}

function Conversation({ snapshot, streaming }: { snapshot: TaskSnapshot | null; streaming: string }) {
  if (!snapshot) return null;
  const { task, messages, events } = snapshot;
  const latestEvent = events.at(-1);
  return (
    <div className="conversation-scroll">
      <header className="conversation-header">
        <p className="eyebrow">{task.origin === 'feishu' ? '来自飞书' : '桌面任务'} · {timeLabel(task.createdAt)}</p>
        <h1>{task.title}</h1>
        <div className={`status-pill ${STATUS_COPY[task.status].tone}`}>
          <span />{STATUS_COPY[task.status].label}
        </div>
      </header>
      <div className="message-stack">
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div className="message-author">{message.role === 'user' ? 'Yi' : message.role === 'assistant' ? 'Molly' : '系统'}</div>
            <div className="message-body">{message.content}</div>
            <time>{timeLabel(message.createdAt)}</time>
          </article>
        ))}
        {streaming && task.status === 'running' && (
          <article className="message assistant streaming">
            <div className="message-author">Molly</div>
            <div className="message-body">{streaming}<span className="caret" /></div>
          </article>
        )}
        {task.status === 'running' && !streaming && (
          <div className="working-line"><MollyCore status="running" small /><span>{latestEvent?.summary ?? '正在思考'}</span></div>
        )}
        {task.lastError && <div className="inline-error">{task.lastError}</div>}
      </div>
    </div>
  );
}

function ArtifactCard({ artifact, active, onSelect }: { artifact: ArtifactRef; active: boolean; onSelect: () => void }) {
  return (
    <button className={`artifact-tab ${active ? 'active' : ''}`} onClick={onSelect}>
      <span>{artifact.kind === 'document' ? '文' : artifact.kind === 'web' ? '网' : artifact.kind === 'todo' ? '行' : '记'}</span>
      <strong>{artifact.title}</strong>
    </button>
  );
}

function ArtifactPanel({ snapshot }: { snapshot: TaskSnapshot | null }) {
  const artifacts = snapshot?.task.artifacts ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = artifacts.find((item) => item.id === selectedId) ?? artifacts[0] ?? null;

  useEffect(() => {
    if (!artifacts.some((item) => item.id === selectedId)) setSelectedId(artifacts[0]?.id ?? null);
  }, [artifacts, selectedId]);

  return (
    <aside className="artifact-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">OUTCOME</p><h2>产物</h2></div>
        <span className="artifact-count">{artifacts.length}</span>
      </div>
      {artifacts.length > 0 ? (
        <>
          <div className="artifact-tabs">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} active={selected?.id === artifact.id} onSelect={() => setSelectedId(artifact.id)} />
            ))}
          </div>
          {selected && (
            <article className="artifact-preview">
              <div className="paper-pin" />
              <div className="preview-meta"><span>{selected.kind}</span><time>{timeLabel(selected.createdAt)}</time></div>
              <h3>{selected.title}</h3>
              {selected.previewText ? <div className="preview-text">{selected.previewText}</div> : <p className="preview-placeholder">产物已经准备好，可以在原位置打开。</p>}
              {(selected.shareRef || selected.localRef) && (
                <button className="open-artifact" onClick={() => void window.molly.openArtifact(selected.shareRef ?? selected.localRef ?? '')}>
                  打开完整产物 <ExternalIcon />
                </button>
              )}
            </article>
          )}
        </>
      ) : (
        <div className="artifact-empty">
          <div className="empty-sheet"><i /><i /><i /></div>
          <h3>{snapshot ? '产物正在形成' : '产物会出现在这里'}</h3>
          <p>{snapshot ? snapshot.events.at(-1)?.summary : '文档、研究结果和行动卡会留在右侧，随时可以回来继续。'}</p>
        </div>
      )}
      {snapshot && snapshot.events.length > 0 && (
        <div className="activity-strip">
          <p className="eyebrow">ACTIVITY</p>
          {snapshot.events.slice(-4).reverse().map((event) => (
            <div className="activity-item" key={event.id}><span /><p>{event.summary}</p><time>{timeLabel(event.occurredAt)}</time></div>
          ))}
        </div>
      )}
    </aside>
  );
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<TaskSnapshot | null>(null);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState<Record<string, string>>({});
  const [runtimeLabel, setRuntimeLabel] = useState('正在连接');
  const selectionVersion = useRef(0);

  const loadTasks = useCallback(async (query = search) => {
    const list = await window.molly.listTasks(query) as Task[];
    setTasks(list);
  }, [search]);

  const selectTask = useCallback(async (taskId: string) => {
    const version = ++selectionVersion.current;
    setSelectedId(taskId);
    const next = await window.molly.getTask(taskId) as TaskSnapshot | null;
    if (selectionVersion.current === version) setSnapshot(next);
  }, []);

  useEffect(() => {
    void Promise.all([
      loadTasks(''),
      window.molly.runtimeInfo().then((info: { label: string }) => setRuntimeLabel(info.label)),
    ]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTasks(search), 140);
    return () => window.clearTimeout(timer);
  }, [loadTasks, search]);

  useEffect(() => window.molly.onTaskEvent((event: TaskServiceEvent) => {
    if (event.type === 'snapshot') {
      setTasks((current) => {
        const next = current.filter((task) => task.id !== event.snapshot.task.id);
        return [event.snapshot.task, ...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
      if (event.snapshot.task.id === selectedId) setSnapshot(event.snapshot);
      if (['completed', 'failed', 'canceled', 'waiting_input'].includes(event.snapshot.task.status)) {
        setStreaming((current) => ({ ...current, [event.snapshot.task.id]: '' }));
      }
    } else if (event.type === 'runtime') {
      const update = event.update;
      if (update.type !== 'assistant_delta') return;
      setStreaming((current) => ({
        ...current,
        [update.taskId]: `${current[update.taskId] ?? ''}${update.delta}`,
      }));
    }
  }), [selectedId]);

  const beginNew = useCallback(() => {
    selectionVersion.current += 1;
    setSelectedId(null);
    setSnapshot(null);
    setDraft('');
    setError(null);
  }, []);

  const submit = useCallback(async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    setDraft('');
    try {
      const next = selectedId
        ? await window.molly.steerTask(selectedId, text) as TaskSnapshot
        : await window.molly.createTask(text) as TaskSnapshot;
      setSelectedId(next.task.id);
      setSnapshot(next);
      await loadTasks('');
    } catch (reason) {
      setDraft(text);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }, [draft, loadTasks, selectedId, sending]);

  const activeCount = useMemo(() => tasks.filter((task) => ['queued', 'running', 'waiting_input'].includes(task.status)).length, [tasks]);

  return (
    <main className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <div className="grain" />
      <header className="titlebar">
        <button className="brand" onClick={beginNew} aria-label="Molly 首页">
          <MollyCore small />
          <span><strong>Molly</strong><em>和 Yi 一起成长</em></span>
        </button>
        <div className="titlebar-center"><span className="node-light" />个人节点在线 · {runtimeLabel}</div>
        <div className="window-space" />
      </header>

      <aside className="task-sidebar">
        <div className="sidebar-toolbar">
          <button className="collapse-button" onClick={() => setSidebarOpen((open) => !open)} aria-label="收起任务中心">◫</button>
          <button className="new-task" onClick={beginNew}><PlusIcon /><span>新任务</span></button>
        </div>
        <label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索共同经历" /></label>
        <div className="sidebar-section-title"><span>最近</span><em>{tasks.length}</em></div>
        <div className="task-list">
          {tasks.map((task) => <TaskItem key={task.id} task={task} selected={task.id === selectedId} onSelect={() => void selectTask(task.id)} />)}
          {tasks.length === 0 && <p className="task-list-empty">第一段共同经历，会从这里开始。</p>}
        </div>
        <div className="sidebar-footer">
          <button onClick={() => void window.molly.stopAll()} disabled={activeCount === 0}><StopIcon /><span>停止全部</span></button>
          <span>{activeCount > 0 ? `${activeCount} 个进行中` : '此刻很安静'}</span>
        </div>
      </aside>

      <section className="conversation-panel">
        {snapshot ? <Conversation snapshot={snapshot} streaming={streaming[snapshot.task.id] ?? ''} /> : <EmptyConversation onPrompt={setDraft} />}
        <form className="composer" onSubmit={submit}>
          {error && <div className="composer-error">{error}</div>}
          <div className="composer-inner">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder={selectedId ? '继续告诉 Molly…' : '把想法交给 Molly…'}
              rows={2}
            />
            <div className="composer-foot">
              <span>{selectedId ? '补充当前任务' : '创建新的任务'}</span>
              <button type="submit" disabled={!draft.trim() || sending} aria-label="发送">
                {sending ? <span className="send-pulse" /> : <ArrowIcon />}
              </button>
            </div>
          </div>
        </form>
      </section>

      <ArtifactPanel snapshot={snapshot} />
    </main>
  );
}
