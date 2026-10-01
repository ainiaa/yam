import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
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
} from "lucide-react";
import {
  groupProjects,
  isProjects,
  projectKey,
  projectName,
  readPreference,
  type Project,
} from "./workspaces";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

type HealthReport = {
  app: string;
  version: string;
  platform: string;
  architecture: string;
  status: string;
};

type SessionSummary = {
  session_id: string;
  cwd: string;
  command: string | null;
  status: string;
};

type SessionRecord = {
  summary: SessionSummary;
  status: string;
  exit_code: number | null;
  reason: string | null;
  started_at: number;
  ended_at: number | null;
};

type AgentAdapter = {
  id: string;
  label: string;
  executable: string | null;
  available: boolean;
};

type SessionOutput = { session_id: string; data: string };
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

function shellQuote(value: string) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function App() {
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const pendingOutput = useRef(new Map<string, string>());
  const pendingState = useRef(new Map<string, SessionStateEvent>());
  const agentOutputWindow = useRef("");
  const notifiedSessions = useRef(new Set<string>());
  const notificationSetup = useRef(false);
  const launchDialog = useRef<HTMLDialogElement>(null);
  const projectDialog = useRef<HTMLDialogElement>(null);
  const selectionVersion = useRef(0);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [prompt, setPrompt] = useState("");
  const [adapterArgs, setAdapterArgs] = useState("");
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

  useEffect(() => {
    try {
      localStorage.setItem("yam.projects", JSON.stringify(projects));
      localStorage.setItem("yam.sidebar", JSON.stringify(sidebarOpen));
      localStorage.setItem("yam.sessionTitles", JSON.stringify(sessionTitles));
    } catch {
      // Preferences are optional; PTY session history is persisted by the backend.
    }
  }, [projects, sidebarOpen, sessionTitles]);

  async function refreshHistory() {
    try {
      setHistory(await invoke<SessionRecord[]>("list_sessions"));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function notifySession(event: SessionStateEvent) {
    if (
      !terminalStatuses.has(event.status) ||
      notifiedSessions.current.has(event.session_id)
    )
      return;
    notifiedSessions.current.add(event.session_id);
    try {
      let allowed = await isPermissionGranted();
      if (!allowed) allowed = (await requestPermission()) === "granted";
      if (allowed) {
        await sendNotification({
          title: `YAM · ${statusLabels[event.status] ?? event.status}`,
          body: event.reason ?? `Session ${event.session_id} finished`,
        });
      }
    } catch {
      // Notification permission is optional; session state remains authoritative.
    }
  }

  function updateAgentPhase(data: string) {
    const clean = data
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    agentOutputWindow.current = `${agentOutputWindow.current}${clean}`.slice(
      -4096,
    );
    if (
      /working\s*\(|esc to interrupt|working\b/i.test(agentOutputWindow.current)
    ) {
      setAgentPhase("working");
    } else if (
      /ask (codex|claude).*anything|how can i help|›\s*$/i.test(
        agentOutputWindow.current,
      )
    ) {
      setAgentPhase("waiting");
    }
  }

  useEffect(() => {
    if (notificationSetup.current) return;
    notificationSetup.current = true;
    void isPermissionGranted()
      .then((allowed) => {
        if (!allowed) void requestPermission();
      })
      .catch(() => undefined);
  }, []);

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
      if (id)
        void invoke("write_session", { sessionId: id, data }).catch(
          () => undefined,
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

    let unlistenOutput: UnlistenFn | undefined;
    let unlistenState: UnlistenFn | undefined;
    let active = true;
    void listen<SessionOutput>("session-output", (event) => {
      if (!active) return;
      if (event.payload.session_id === sessionId.current) {
        updateAgentPhase(event.payload.data);
        instance.write(event.payload.data);
        return;
      }
      const previous =
        pendingOutput.current.get(event.payload.session_id) ?? "";
      pendingOutput.current.set(
        event.payload.session_id,
        previous + event.payload.data,
      );
    }).then((unlisten) => {
      if (active) unlistenOutput = unlisten;
      else unlisten();
    });
    void listen<SessionStateEvent>("session-state", (event) => {
      if (!active) return;
      void notifySession(event.payload);
      void refreshHistory();
      if (event.payload.session_id !== sessionId.current) {
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
    if (event.status !== "starting" && event.status !== "running") {
      instance.writeln(
        `\r\n[${statusLabels[event.status] ?? event.status}] ${event.reason ?? ""}`,
      );
    }
    void refreshHistory();
  }

  async function startSession(overrides?: { cwd?: string; command?: string }) {
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
        command: overrides
          ? overrides.command || null
          : customCommand ||
            [
              adapter?.executable,
              launchArgs,
              launchPrompt ? shellQuote(launchPrompt) : "",
            ]
              .filter(Boolean)
              .join(" ") ||
            null,
      });
      selectionVersion.current += 1;
      terminal.current?.reset();
      sessionId.current = next.session_id;
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
      setSession(next);
      setSessionStatus(next.status);
      setAgentPhase("idle");
      agentOutputWindow.current = "";
      const bufferedOutput = pendingOutput.current.get(next.session_id);
      if (bufferedOutput) {
        updateAgentPhase(bufferedOutput);
        terminal.current?.write(bufferedOutput);
        pendingOutput.current.delete(next.session_id);
      }
      const bufferedState = pendingState.current.get(next.session_id);
      if (bufferedState) {
        pendingState.current.delete(next.session_id);
        if (terminal.current) applyStateEvent(terminal.current, bufferedState);
      }
      void refreshHistory();
      requestAnimationFrame(() => {
        fitAddon.current?.fit();
        terminal.current?.focus();
        if (terminal.current) {
          void invoke("resize_session", {
            sessionId: next.session_id,
            cols: terminal.current.cols,
            rows: terminal.current.rows,
          }).catch(() => undefined);
        }
      });
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
    try {
      sessionId.current = null;
      const log = await invoke<string>("read_session_log", {
        sessionId: record.summary.session_id,
      });
      if (version !== selectionVersion.current) return;
      setSession(record.summary);
      setActiveProject(record.summary.cwd);
      setSessionStatus(record.status);
      setAgentPhase("idle");
      agentOutputWindow.current = "";
      terminal.current?.reset();
      terminal.current?.write(log || "(No output recorded)\r\n");
      updateAgentPhase(log);
      const isLive =
        record.status === "running" || record.status === "starting";
      if (isLive) {
        sessionId.current = record.summary.session_id;
        const bufferedOutput = pendingOutput.current.get(
          record.summary.session_id,
        );
        if (bufferedOutput) {
          updateAgentPhase(bufferedOutput);
          terminal.current?.write(bufferedOutput);
          pendingOutput.current.delete(record.summary.session_id);
        }
        const bufferedState = pendingState.current.get(
          record.summary.session_id,
        );
        if (bufferedState) {
          pendingState.current.delete(record.summary.session_id);
          if (terminal.current)
            applyStateEvent(terminal.current, bufferedState);
        }
      }
      requestAnimationFrame(() => {
        fitAddon.current?.fit();
        terminal.current?.focus();
        if (sessionId.current && terminal.current) {
          void invoke("resize_session", {
            sessionId: sessionId.current,
            cols: terminal.current.cols,
            rows: terminal.current.rows,
          }).catch(() => undefined);
        }
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function rerunSelectedSession() {
    if (!session) return;
    void startSession({ cwd: session.cwd, command: session.command ?? "" });
  }

  const isRunning = sessionStatus === "running" || sessionStatus === "starting";
  const projectGroups = groupProjects(projects, history);
  const currentProject = projectGroups.find(
    (project) =>
      projectKey(project.path) === projectKey(session?.cwd || activeProject),
  );
  const normalizedQuery = historyQuery.trim().toLowerCase();
  const titleFor = (summary: SessionSummary) =>
    sessionTitles[summary.session_id] || summary.command || "Interactive shell";
  const visibleProjects = projectGroups
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter(
        (record) =>
          !normalizedQuery ||
          `${project.name} ${project.path} ${titleFor(record.summary)} ${record.summary.session_id}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    }))
    .filter(
      (project) =>
        !normalizedQuery ||
        project.sessions.length > 0 ||
        `${project.name} ${project.path}`
          .toLowerCase()
          .includes(normalizedQuery),
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

  function saveProject() {
    const path = projectPath.trim();
    if (!path.startsWith("/") && !/^[A-Za-z]:[\\\\/]/.test(path)) {
      setProjectError("Enter an absolute directory path.");
      return;
    }
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
            saveProject();
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
