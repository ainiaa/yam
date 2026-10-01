import { useEffect, useRef, useState } from "react";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Square,
  RotateCcw,
  Eraser,
  Copy,
  X,
  TerminalSquare,
  Play,
  Pencil,
} from "lucide-react";
import {
  groupProjects,
  matchesStatus,
  validateSessionTitle,
  selectProjectDirectory,
  isProjects,
  projectKey,
  projectName,
  readPreference,
  type Project,
} from "./workspaces";
import { OutputBuffer, consumeOutput, replayOutput, type OutputChunk, type LogSnapshot } from "./session-stream";
import { NotificationQueue, inferAgentPhase } from "./notifications";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

type HealthReport = {
  app: string;
  version: string;
  platform: string;
  architecture: string;
  status: string;
};

type AgentLaunch = { adapter: string; mode: "task" | "interactive"; extra_args: string; prompt: string | null };

type SessionSummary = {
  session_id: string;
  cwd: string;
  command: string | null;
  status: string;
  launch?: AgentLaunch | null;
};

type SessionRecord = {
  summary: SessionSummary;
  status: string;
  exit_code: number | null;
  reason: string | null;
  started_at: number;
  ended_at: number | null;
  notification_pending?: boolean;
};

type AgentAdapter = {
  id: string;
  label: string;
  executable: string | null;
  available: boolean;
};

type SessionOutput = OutputChunk;
type SessionStateEvent = {
  session_id: string;
  status: string;
  exit_code: number | null;
  reason: string | null;
};

type AgentPhase = "idle" | "working" | "waiting";

const statusLabels: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  needs_attention: "Needs attention",
};

const terminalStatuses = new Set([
  "succeeded",
  "failed",
  "stopped",
  "needs_attention",
]);

function App() {
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const pendingOutput = useRef(new OutputBuffer());
  const outputCursor = useRef<number | null>(null);
  const selectedRecord = useRef<SessionRecord | null>(null);
  const pendingState = useRef(new Map<string, SessionStateEvent>());
  const agentOutputWindow = useRef("");
  const notifications = useRef(new NotificationQueue());
  const retryNotifications = useRef(new Map<string, SessionStateEvent>());
  const launchDialog = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const projectDialog = useRef<HTMLDialogElement>(null);
  const selectionVersion = useRef(0);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [prompt, setPrompt] = useState("");
  const [adapterArgs, setAdapterArgs] = useState("");
  const [launchMode, setLaunchMode] = useState<"task" | "interactive">("task");
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState("shell");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [starting, setStarting] = useState(false);
  const [history, setHistory] = useState<SessionRecord[]>([]);
  const [historyQuery, setHistoryQuery] = useState("");
  const [projects, setProjects] = useState<Project[]>(() =>
    readPreference("yam.projects", [], isProjects),
  );
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    readPreference(
      "yam.sidebar",
      true,
      (value): value is boolean => typeof value === "boolean",
    ),
  );
  const [collapsedProjects, setCollapsedProjects] = useState(new Set<string>());
  const [activeProject, setActiveProject] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [sessionTitles, setSessionTitles] = useState<Record<string, string>>(
    () =>
      readPreference(
        "yam.sessionTitles",
        {},
        (value): value is Record<string, string> =>
          !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.values(value).every((item) => typeof item === "string"),
      ),
  );

  const titlesRef = useRef(sessionTitles);
  titlesRef.current = sessionTitles;

  useEffect(() => {
    try {
      localStorage.setItem("yam.projects", JSON.stringify(projects));
      localStorage.setItem("yam.sidebar", JSON.stringify(sidebarOpen));
      localStorage.setItem("yam.sessionTitles", JSON.stringify(sessionTitles));
    } catch (reason) {
      setError(`Failed to save project or session preferences: ${String(reason)}`);
    }
  }, [projects, sidebarOpen, sessionTitles]);

  async function refreshHistory() {
    try {
      const records = await invoke<SessionRecord[]>("list_sessions");
      setHistory(records);
      for (const record of records) if (record.notification_pending) void notifySession({ session_id: record.summary.session_id, status: record.status, exit_code: record.exit_code, reason: record.reason });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function notifySession(event: SessionStateEvent) {
    if (!terminalStatuses.has(event.status) && event.status !== "idle_attention") return;
    const key = `${event.session_id}:${event.status}`;
    if (!notifications.current.canRetry(key)) return;
    if (document.hasFocus() && sessionId.current === event.session_id) {
      notifications.current.suppress(key);
      try { await invoke("acknowledge_notification", {sessionId: event.session_id}); retryNotifications.current.delete(key); notifications.current.clearFailure(key); if (!retryNotifications.current.size) setNotificationError(null); }
      catch (reason) { retryNotifications.current.set(key, event); setNotificationError(notifications.current.recordFailure(key, reason)); }
      return;
    }
    retryNotifications.current.set(key, event);
    try {
      const delivered = await notifications.current.deliver(key, async () => {
        const record = (await invoke<SessionRecord[]>("list_sessions")).find(item => item.summary.session_id === event.session_id);
        const taskName = titlesRef.current[event.session_id] || record?.summary.launch?.adapter || "Session";
        const title = `${projectName(record?.summary.cwd ?? "")} · ${taskName} · ${statusLabels[event.status] ?? "Needs attention"}`.slice(0, 200);
        await invoke("notify_session", { sessionId: event.session_id, title });
      });
      if (delivered) {
        await invoke("acknowledge_notification", {sessionId: event.session_id});
        retryNotifications.current.delete(key);
        notifications.current.clearFailure(key);
        if (!retryNotifications.current.size) setNotificationError(null);
      }
    } catch (reason) { setNotificationError(notifications.current.recordFailure(key, reason)); }
  }

  function updateAgentPhase(data: string) {
    const clean = data
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    agentOutputWindow.current = `${agentOutputWindow.current}${clean}`.slice(
      -4096,
    );
    if (selectedRecord.current?.summary.launch?.mode !== "task") {
      const phase = inferAgentPhase(agentOutputWindow.current);
      if (phase !== "idle") setAgentPhase(phase);
    }
  }



  useEffect(() => {
    invoke<HealthReport>("health_check")
      .then(setHealth)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    invoke<AgentAdapter[]>("list_adapters")
      .then((next) => {
        setAdapters(next);
        if (next.some((adapter) => adapter.id === "shell"))
          setSelectedAdapter("shell");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, []);

  useEffect(() => {
    if (!terminalHost.current) return;

    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#202020",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#484848",
        black: "#202020",
        brightBlack: "#969696",
        green: "#83c99a",
        brightGreen: "#a3dfb5",
      },
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(terminalHost.current);
    terminal.current = instance;
    fitAddon.current = fit;

    const onData = instance.onData((data) => {
      const id = sessionId.current;
      if (id && outputCursor.current !== null)
        void invoke("write_session", { sessionId: id, data }).catch(
          (reason: unknown) => setError(String(reason)),
        );
    });
    const resize = () => {
      fit.fit();
      const id = sessionId.current;
      if (id) {
        void invoke("resize_session", {
          sessionId: id,
          cols: instance.cols,
          rows: instance.rows,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(terminalHost.current);
    requestAnimationFrame(resize);

    const extraListeners: UnlistenFn[] = [];
    const retryTimer = window.setInterval(() => {
      for (const event of retryNotifications.current.values()) void notifySession(event);
    }, 15000);
    for (const [name, callback] of [
      ["session-error", (payload: { session_id: string; data: string }) => setError(payload.data)],
      ["session-phase", (payload: { session_id: string; data: string }) => {
        if (payload.session_id === sessionId.current && ["working", "waiting"].includes(payload.data)) setAgentPhase(payload.data as AgentPhase);
      }],
      ["session-attention", (payload: { session_id: string; data: string }) => {
        if (payload.session_id === sessionId.current) setAgentPhase("waiting");
        void notifySession({session_id: payload.session_id, status: "idle_attention", exit_code: null, reason: payload.data});
      }],
    ] as const) void listen<{ session_id: string; data: string }>(name, event => callback(event.payload)).then(unlisten => {
      if (active) extraListeners.push(unlisten); else unlisten();
    });
    async function selectNotificationSession(id: string) {
      try {
        const records = await invoke<SessionRecord[]>("list_sessions");
        if (!active) return;
        const pending = await invoke<string | null>("pending_notification_selection");
        if (!active || pending !== id) return;
        const record = records.find(item => item.summary.session_id === id);
        if (!record) throw new Error("Notification refers to an unknown session");
        launchDialog.current?.close();
        projectDialog.current?.close();
        renameDialog.current?.close();
        await openHistory(record);
        if (active && sessionId.current === id && outputCursor.current !== null) {
          await invoke("acknowledge_notification_selection", { sessionId: id });
        }
      } catch (reason) { if (active) setError(String(reason)); }
    }
    void listen<string>("session-notification-click", event => { void selectNotificationSession(event.payload); })
      .then(async unlisten => {
        if (!active) { unlisten(); return; }
        extraListeners.push(unlisten);
        const pending = await invoke<string | null>("pending_notification_selection");
        if (pending && active) await selectNotificationSession(pending);
      }).catch(reason => { if (active) setError(String(reason)); });
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenState: UnlistenFn | undefined;
    let active = true;
    void listen<SessionOutput>("session-output", (event) => {
      if (!active) return;
      if (event.payload.session_id === sessionId.current && outputCursor.current !== null) {
        try {
          const next = consumeOutput(outputCursor.current, event.payload);
          outputCursor.current = next.nextOffset;
          updateAgentPhase(next.data);
          instance.write(next.data);
        } catch {
          pendingOutput.current.push(event.payload);
          if (selectedRecord.current) void openHistory(selectedRecord.current);
        }
        return;
      }
      pendingOutput.current.push(event.payload);
    }).then((unlisten) => {
      if (active) unlistenOutput = unlisten;
      else unlisten();
    });
    void listen<SessionStateEvent>("session-state", (event) => {
      if (!active) return;
      void notifySession(event.payload);
      void refreshHistory();
      if (terminalStatuses.has(event.payload.status) && event.payload.session_id !== sessionId.current)
        pendingOutput.current.delete(event.payload.session_id);
      if (event.payload.session_id !== sessionId.current || outputCursor.current === null) {
        pendingState.current.set(event.payload.session_id, event.payload);
        return;
      }
      applyStateEvent(instance, event.payload);
    }).then((unlisten) => {
      if (active) unlistenState = unlisten;
      else unlisten();
    });

    return () => {
      active = false;
      window.clearInterval(retryTimer);
      extraListeners.forEach(unlisten => unlisten());
      onData.dispose();
      window.removeEventListener("resize", resize);
      observer.disconnect();
      unlistenOutput?.();
      unlistenState?.();
      instance.dispose();
      terminal.current = null;
      fitAddon.current = null;
      pendingOutput.current.clear();
      pendingState.current.clear();
    };
  }, []);

  function applyStateEvent(instance: Terminal, event: SessionStateEvent) {
    setSessionStatus(event.status);
    if (selectedRecord.current?.summary.session_id === event.session_id) {
      selectedRecord.current = { ...selectedRecord.current, status:event.status, exit_code:event.exit_code, reason:event.reason };
    }
    if (event.status !== "starting" && event.status !== "running") {
      instance.writeln(
        `\r\n[${statusLabels[event.status] ?? event.status}] ${event.reason ?? ""}`,
      );
    }
    void refreshHistory();
  }

  async function startSession(overrides?: { cwd?: string; command?: string; launch?: AgentLaunch | null }) {
    if (starting) return;
    const adapter = adapters.find((item) => item.id === selectedAdapter);
    const customCommand = (overrides?.command ?? command).trim();
    const workingDirectory = (overrides?.cwd ?? cwd).trim();
    const launchPrompt =
      !overrides && selectedAdapter !== "shell" ? prompt.trim() : "";
    const launchArgs =
      !overrides && selectedAdapter !== "shell" ? adapterArgs.trim() : "";
    if (!overrides && !customCommand && adapter && !adapter.available) {
      setError(`${adapter.label} was not found on PATH`);
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const next = await invoke<SessionSummary>("create_session", {
        cwd: workingDirectory || null,
        command: customCommand || null,
        launch: overrides ? overrides.launch ?? null :
          !customCommand && selectedAdapter !== "shell" ? {
            adapter:selectedAdapter, mode:launchMode, extra_args:launchArgs, prompt:launchPrompt || null,
          } : null,
      });
      setActiveProject(next.cwd);
      setCollapsedProjects((previous) => {
        const copy = new Set(previous);
        copy.delete(projectKey(next.cwd));
        return copy;
      });
      setSessionTitles((previous) => ({
        ...previous,
        [next.session_id]:
          !overrides && selectedAdapter !== "shell" && prompt.trim()
            ? prompt.trim()
            : customCommand ||
              (overrides ? "Interactive shell" : adapter?.label) ||
              "Interactive shell",
      }));
      launchDialog.current?.close();
      await openHistory({summary:next, status:next.status, exit_code:null, reason:null, started_at:Date.now()/1000, ended_at:null});
      void refreshHistory();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      terminal.current?.writeln(`\r\n[Failed to start] ${String(reason)}`);
    } finally {
      setStarting(false);
    }
  }

  async function stopSession() {
    const id = sessionId.current;
    if (!id || !isRunning) return;
    try {
      await invoke("stop_session", { sessionId: id });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function openHistory(record: SessionRecord) {
    const version = ++selectionVersion.current;
    const id = record.summary.session_id;
    sessionId.current = id;
    selectedRecord.current = record;
    outputCursor.current = null;
    setSession(record.summary);
    setActiveProject(record.summary.cwd);
    setSessionStatus(record.status);
    try {
      let replay: ReturnType<typeof replayOutput> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await invoke<LogSnapshot>("read_session_snapshot", { sessionId: id });
        if (version !== selectionVersion.current) return;
        if (snapshot.status) {
          setSessionStatus(snapshot.status);
          selectedRecord.current = {...record, status:snapshot.status};
        }
        try { replay = replayOutput(snapshot, pendingOutput.current.drain(id)); break; }
        catch (reason) { if (attempt === 2) throw reason; }
      }
      if (!replay || version !== selectionVersion.current) return;
      outputCursor.current = replay.nextOffset;
      setAgentPhase("idle");
      agentOutputWindow.current = "";
      terminal.current?.reset();
      terminal.current?.write(replay.data || (terminalStatuses.has(selectedRecord.current?.status ?? record.status) ? "(No output recorded)\r\n" : ""));
      updateAgentPhase(replay.data);
      const bufferedState = pendingState.current.get(id);
      if (bufferedState) {
        pendingState.current.delete(id);
        if (terminal.current) applyStateEvent(terminal.current, bufferedState);
      }
      requestAnimationFrame(() => {
        if (version !== selectionVersion.current) return;
        fitAddon.current?.fit();
        terminal.current?.focus();
        if (terminal.current && !terminalStatuses.has(selectedRecord.current?.status ?? record.status)) {
          void invoke("resize_session", { sessionId:id, cols:terminal.current.cols, rows:terminal.current.rows })
            .catch((reason: unknown) => setError(String(reason)));
        }
      });
    } catch (reason: unknown) {
      if (version !== selectionVersion.current) return;
      sessionId.current = null;
      setSessionStatus("unavailable");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function rerunSelectedSession() {
    if (!session) return;
    void startSession({ cwd: session.cwd, command: session.command ?? "", launch:session.launch });
  }

  const isRunning = sessionStatus === "running" || sessionStatus === "starting";
  const projectGroups = groupProjects(projects, history);
  const currentProject = projectGroups.find(
    (project) =>
      projectKey(project.path) === projectKey(session?.cwd || activeProject),
  );
  const normalizedQuery = historyQuery.trim().toLowerCase();
  const titleFor = (summary: SessionSummary) =>
    sessionTitles[summary.session_id] || summary.launch?.prompt || summary.command || (summary.launch ? `${summary.launch.adapter} · ${summary.launch.mode}` : "Interactive shell");
  const visibleProjects = projectGroups
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter(
        (record) =>
          matchesStatus(record.status, statusFilter) && (!normalizedQuery ||
          `${project.name} ${project.path} ${titleFor(record.summary)} ${record.summary.session_id}`
            .toLowerCase()
            .includes(normalizedQuery)),
      ),
    }))
    .filter(
      (project) =>
        (statusFilter === "all" && !normalizedQuery) ||
        project.sessions.length > 0 ||
        (statusFilter === "all" && !!normalizedQuery && `${project.name} ${project.path}`
          .toLowerCase()
          .includes(normalizedQuery)),
    );

  function newSession(path = activeProject || session?.cwd || "") {
    setCwd(path);
    setCommand("");
    setPrompt("");
    setAdapterArgs("");
    setError(null);
    launchDialog.current?.showModal();
  }

  function addProject() {
    setProjectError(null);
    setProjectPath("");
    setNewProjectName("");
    projectDialog.current?.showModal();
  }

  async function chooseDirectory(target: "launch" | "project") {
    try {
      const path = await selectProjectDirectory(async () => {
        const chosen = await openDirectoryDialog({directory: true, multiple: false, title: "Choose project directory"});
        if (Array.isArray(chosen)) throw new Error("Expected one directory");
        return chosen;
      }, path => invoke("validate_project_directory", {path}));
      if (path !== null) { if (target === "launch") setCwd(path); else { setProjectPath(path); setProjectError(null); } }
    } catch (reason) { if (target === "launch") setError(String(reason)); else setProjectError(String(reason)); }
  }

  async function saveProject() {
    const path = projectPath.trim();
    if (!path.startsWith("/") && !/^[A-Za-z]:[\\\\/]/.test(path)) {
      setProjectError("Enter an absolute directory path.");
      return;
    }
    try { await invoke("validate_project_directory", {path}); }
    catch (reason) { setProjectError(String(reason)); return; }
    const name = newProjectName.trim() || projectName(path);
    setProjects((previous) => [
      ...previous.filter(
        (project) => projectKey(project.path) !== projectKey(path),
      ),
      { path, name },
    ]);
    setActiveProject(path);
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectKey(path));
      return next;
    });
    projectDialog.current?.close();
  }

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside
        className="sidebar"
        aria-label="Projects and sessions"
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
        <header className="sidebar-header">
          <span className="brand-name">YAM</span>
          <button
            className="icon-button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose />
          </button>
        </header>
        <button className="new-session-button" onClick={() => newSession()}>
          <Plus aria-hidden="true" />
          New session
        </button>
        <div className="search-field">
          <Search aria-hidden="true" />
          <input
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search projects and sessions"
          />
          {historyQuery && (
            <button
              className="icon-button small"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => setHistoryQuery("")}
            >
              <X />
            </button>
          )}
        </div>
        <select aria-label="Filter sessions by status" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="all">All sessions</option><option value="active">Active</option>
          <option value="attention">Needs attention</option><option value="succeeded">Completed</option><option value="stopped">Stopped</option>
        </select>
        <div className="section-label">
          <span>Projects</span>
          <button
            className="icon-button small"
            aria-label="Add project"
            title="Add project"
            onClick={addProject}
          >
            <FolderPlus />
          </button>
        </div>
        <nav className="project-list" aria-label="Projects">
          {visibleProjects.map((project) => {
            const key = projectKey(project.path);
            const expanded = !collapsedProjects.has(key) || !!normalizedQuery;
            return (
              <div className="project-group" key={key}>
                <div
                  className={`project-row ${currentProject?.path === project.path ? "current-project" : ""}`}
                >
                  <button
                    className="project-toggle"
                    title={project.path}
                    aria-expanded={expanded}
                    onClick={() => {
                      setActiveProject(project.path);
                      setCollapsedProjects((previous) => {
                        const next = new Set(previous);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      });
                    }}
                  >
                    {expanded ? (
                      <ChevronDown aria-hidden="true" />
                    ) : (
                      <ChevronRight aria-hidden="true" />
                    )}
                    <Folder aria-hidden="true" />
                    <span>{project.name}</span>
                    <span className="project-count">
                      {project.sessions.length}
                    </span>
                  </button>
                  <button
                    className="icon-button small project-add"
                    title={`New session in ${project.name}`}
                    aria-label={`New session in ${project.name}`}
                    onClick={() => newSession(project.path)}
                  >
                    <Plus />
                  </button>
                </div>
                {expanded && (
                  <div className="session-list">
                    {project.sessions.map((record) => (
                      <button
                        className={`session-row ${session?.session_id === record.summary.session_id ? "selected" : ""}`}
                        key={record.summary.session_id}
                        aria-current={
                          session?.session_id === record.summary.session_id
                            ? "page"
                            : undefined
                        }
                        title={`${titleFor(record.summary)}\n${statusLabels[record.status] ?? record.status}`}
                        onClick={() => void openHistory(record)}
                      >
                        <span
                          className={`session-dot status-${record.status}`}
                          aria-label={
                            statusLabels[record.status] ?? record.status
                          }
                        />
                        <span className="session-title">
                          {titleFor(record.summary)}
                        </span>
                        <time
                          dateTime={new Date(
                            record.started_at * 1000,
                          ).toISOString()}
                        >
                          {new Date(
                            record.started_at * 1000,
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </time>
                      </button>
                    ))}
                    {project.sessions.length === 0 && (
                      <button
                        className="empty-project"
                        onClick={() => newSession(project.path)}
                      >
                        <Plus aria-hidden="true" />
                        New session
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {visibleProjects.length === 0 && (
            <div className="sidebar-empty">
              {normalizedQuery ? "No results" : "No projects yet"}
            </div>
          )}
        </nav>
        <footer className="sidebar-footer">
          <span
            className={`session-dot ${health?.status === "ready" ? "status-running" : ""}`}
          />
          <span>
            {health?.status === "ready"
              ? "Local engine ready"
              : "Connecting..."}
          </span>
          <span className="version">v{health?.version ?? "0.1.0"}</span>
        </footer>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          {!sidebarOpen && (
            <button
              className="icon-button"
              aria-label="Expand sidebar"
              title="Expand sidebar"
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen />
            </button>
          )}
          <div className="breadcrumb">
            <span className="breadcrumb-project">
              {currentProject?.name || "YAM"}
            </span>
            {session && (
              <>
                <ChevronRight aria-hidden="true" />
                <h1 title={titleFor(session)}>{titleFor(session)}</h1>
              </>
            )}
          </div>
          <div className="toolbar">
            {session && (
              <span
                className={`session-status status-${sessionStatus}`}
                role="status"
              >
                <span className="session-dot" />
                {statusLabels[sessionStatus] ?? sessionStatus}
              </span>
            )}
            <button
              className="icon-button"
              title="New session"
              aria-label="New session"
              onClick={() => newSession()}
            >
              <Plus />
            </button>
            <button
              className="icon-button"
              title="Run again"
              aria-label="Run again"
              disabled={!session || starting}
              onClick={rerunSelectedSession}
            >
              <RotateCcw />
            </button>
            <button className="icon-button" aria-label="Rename session" title="Rename session" disabled={!session}
              onClick={() => { if (session) { setRenameTitle(titleFor(session)); setRenameError(null); renameDialog.current?.showModal(); } }}><Pencil /></button>
            <button
              className="icon-button stop-button"
              title="Stop session"
              aria-label="Stop session"
              disabled={!isRunning}
              onClick={() => void stopSession()}
            >
              <Square />
            </button>
          </div>
        </header>
        {session && (
          <div className="session-info">
            <span className="session-directory" title={session.cwd}>
              <Folder aria-hidden="true" />
              {session.cwd}
            </span>
            <div className="terminal-tools">
              {isRunning && agentPhase !== "idle" && (
                <span className="agent-phase">
                  {agentPhase === "working" ? "Working" : "Waiting for input"}
                </span>
              )}
              <button
                className="icon-button small"
                title="Copy terminal output"
                aria-label="Copy terminal output"
                onClick={() => {
                  const buffer = terminal.current?.buffer.active;
                  if (!buffer) return;
                  const lines = Array.from(
                    { length: buffer.length },
                    (_, index) =>
                      buffer.getLine(index)?.translateToString(true) ?? "",
                  );
                  void navigator.clipboard
                    .writeText(lines.join("\n"))
                    .catch((reason: unknown) => setError(String(reason)));
                }}
              >
                <Copy />
              </button>
              <button
                className="icon-button small"
                title="Clear terminal"
                aria-label="Clear terminal"
                onClick={() => terminal.current?.clear()}
              >
                <Eraser />
              </button>
            </div>
          </div>
        )}
        <section
          className={`terminal-area ${session ? "" : "terminal-empty"}`}
          aria-label="Terminal"
        >
          <div className="terminal-host" ref={terminalHost} />
          {!session && (
            <div className="empty-state">
              <TerminalSquare className="empty-icon" aria-hidden="true" />
              <h1>{currentProject?.name || "YAM"}</h1>
              {currentProject && (
                <p className="empty-path">{currentProject.path}</p>
              )}
              <div className="empty-actions">
                <button className="primary-button" onClick={() => newSession()}>
                  <Plus aria-hidden="true" />
                  New session
                </button>
                <button className="secondary-button" onClick={addProject}>
                  <FolderPlus aria-hidden="true" />
                  Add project
                </button>
              </div>
            </div>
          )}
        </section>
        {notificationError && (
          <div className="error-banner" role="alert">
            <span>{notificationError}</span>
            <button onClick={() => {
              notifications.current.resetRetries();
              for (const event of retryNotifications.current.values()) void notifySession(event);
            }}>Retry notifications</button>
          </div>
        )}
        {error && !launchDialog.current?.open && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              className="icon-button small"
              title="Dismiss error"
              aria-label="Dismiss error"
              onClick={() => setError(null)}
            >
              <X />
            </button>
          </div>
        )}
        <footer className="statusbar">
          <span>{session ? session.session_id : "No session selected"}</span>
          <span>{session ? "Terminal" : (health?.platform ?? "Local")}</span>
        </footer>
      </main>
      <dialog ref={renameDialog} className="app-dialog" aria-labelledby="rename-title">
        <form onSubmit={event => {
          event.preventDefault(); if (!session) return;
          try { const title = validateSessionTitle(renameTitle); setSessionTitles(previous => ({...previous, [session.session_id]: title})); renameDialog.current?.close(); }
          catch (reason) { setRenameError(String(reason)); }
        }}>
          <header className="dialog-header"><h2 id="rename-title">Rename session</h2></header>
          <div className="dialog-fields"><label><span>Session name</span><input autoFocus value={renameTitle} onChange={event => setRenameTitle(event.target.value)} maxLength={200} /></label>
          {renameError && <p className="dialog-error" role="alert">{renameError}</p>}</div>
          <footer className="dialog-actions"><button className="secondary-button" type="button" onClick={() => renameDialog.current?.close()}>Cancel</button><button className="primary-button" type="submit">Save</button></footer>
        </form>
      </dialog>
      <dialog
        ref={launchDialog}
        className="app-dialog"
        aria-labelledby="launch-title"
        onCancel={(event) => {
          if (starting) event.preventDefault();
        }}
        onClose={() => {
          if (sessionId.current) terminal.current?.focus();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void startSession();
          }}
        >
          <header className="dialog-header">
            <h2 id="launch-title">New session</h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close"
              title="Close"
              disabled={starting}
              onClick={() => launchDialog.current?.close()}
            >
              <X />
            </button>
          </header>
          <div className="dialog-fields">
            <label>
              <span>Project directory</span>
              <button className="secondary-button" type="button" onClick={() => void chooseDirectory("launch")}>Browse directory</button>
              <input
                autoFocus
                value={cwd}
                onChange={(event) => setCwd(event.target.value)}
                placeholder="/path/to/project"
              />
            </label>
            <label>
              <span>Agent</span>
              <select
                aria-label="Agent"
                value={selectedAdapter}
                onChange={(event) => setSelectedAdapter(event.target.value)}
              >
                {adapters.map((adapter) => (
                  <option
                    value={adapter.id}
                    key={adapter.id}
                    disabled={!adapter.available && adapter.id !== "shell"}
                  >
                    {adapter.label}
                    {adapter.available ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
            </label>
            {selectedAdapter !== "shell" && (
              <label>
                <span>Run mode</span>
                <select value={launchMode} onChange={(event) => setLaunchMode(event.target.value as "task" | "interactive")}>
                  <option value="task">Single task · reports completion</option>
                  <option value="interactive">Interactive terminal</option>
                </select>
              </label>
            )}
            {selectedAdapter !== "shell" && (
              <label>
                <span>Prompt</span>
                <textarea
                  rows={4}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </label>
            )}
            <details className="advanced-options">
              <summary>Advanced options</summary>
              <label>
                <span>Custom command</span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                />
              </label>
              {selectedAdapter !== "shell" && (
                <label>
                  <span>CLI arguments</span>
                  <input
                    value={adapterArgs}
                    onChange={(event) => setAdapterArgs(event.target.value)}
                  />
                </label>
              )}
            </details>
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={starting}
              onClick={() => launchDialog.current?.close()}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={starting || adapters.length === 0}
            >
              <Play aria-hidden="true" />
              {starting ? "Starting..." : "Start session"}
            </button>
          </footer>
        </form>
      </dialog>
      <dialog
        ref={projectDialog}
        className="app-dialog"
        aria-labelledby="project-title"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveProject();
          }}
        >
          <header className="dialog-header">
            <h2 id="project-title">Add project</h2>
            <button
              className="icon-button"
              type="button"
              aria-label="Close"
              title="Close"
              onClick={() => projectDialog.current?.close()}
            >
              <X />
            </button>
          </header>
          <div className="dialog-fields">
            <label>
              <span>Directory</span>
              <button className="secondary-button" type="button" onClick={() => void chooseDirectory("project")}>Browse directory</button>
              <input
                required
                autoFocus
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="/path/to/project"
              />
            </label>
            <label>
              <span>Name</span>
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder={
                  projectPath ? projectName(projectPath) : "Project name"
                }
              />
            </label>
            {projectError && (
              <p className="dialog-error" role="alert">
                {projectError}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => projectDialog.current?.close()}
            >
              Cancel
            </button>
            <button className="primary-button" type="submit">
              <FolderPlus aria-hidden="true" />
              Add project
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

export default App;
