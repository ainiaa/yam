import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
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

type SessionOutput = { session_id: string; data: string };
type SessionStateEvent = {
  session_id: string;
  status: string;
  exit_code: number | null;
  reason: string | null;
};

const statusLabels: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

function App() {
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    invoke<HealthReport>("health_check").then(setHealth).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason));
    });
  }, []);

  useEffect(() => {
    if (!terminalHost.current) return;

    const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "DM Mono, SFMono-Regular, Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#0d1114",
        foreground: "#d4dde1",
        cursor: "#d6ff5f",
        selectionBackground: "#45523a",
        black: "#0d1114",
        brightBlack: "#61717b",
        green: "#d6ff5f",
        brightGreen: "#e6ff9c",
      },
    });
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.open(terminalHost.current);
    terminal.current = instance;
    fitAddon.current = fit;
    instance.writeln("YAM terminal ready.");
    instance.writeln("Start a workspace session to connect an agent or shell.");

    const onData = instance.onData((data) => {
      const id = sessionId.current;
      if (id) void invoke("write_session", { sessionId: id, data });
    });
    const resize = () => {
      fit.fit();
      const id = sessionId.current;
      if (id) {
        void invoke("resize_session", {
          sessionId: id,
          cols: instance.cols,
          rows: instance.rows,
        });
      }
    };
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);

    let unlistenOutput: UnlistenFn | undefined;
    let unlistenState: UnlistenFn | undefined;
    let active = true;
    void listen<SessionOutput>("session-output", (event) => {
      if (active && event.payload.session_id === sessionId.current) {
        instance.write(event.payload.data);
      }
    }).then((unlisten) => {
      if (active) unlistenOutput = unlisten;
      else unlisten();
    });
    void listen<SessionStateEvent>("session-state", (event) => {
      if (active && event.payload.session_id === sessionId.current) {
        setSessionStatus(event.payload.status);
        if (event.payload.status !== "starting" && event.payload.status !== "running") {
          instance.writeln(`\r\n[${statusLabels[event.payload.status] ?? event.payload.status}] ${event.payload.reason ?? ""}`);
        }
      }
    }).then((unlisten) => {
      if (active) unlistenState = unlisten;
      else unlisten();
    });

    return () => {
      active = false;
      onData.dispose();
      window.removeEventListener("resize", resize);
      unlistenOutput?.();
      unlistenState?.();
      instance.dispose();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, []);

  async function startSession() {
    if (starting || sessionStatus === "running" || sessionStatus === "starting") return;
    setStarting(true);
    setError(null);
    terminal.current?.clear();
    try {
      const next = await invoke<SessionSummary>("create_session", {
        cwd: cwd.trim() || null,
        command: command.trim() || null,
      });
      sessionId.current = next.session_id;
      setSession(next);
      setSessionStatus(next.status);
      requestAnimationFrame(() => {
        fitAddon.current?.fit();
        if (terminal.current) {
          void invoke("resize_session", {
            sessionId: next.session_id,
            cols: terminal.current.cols,
            rows: terminal.current.rows,
          });
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

  const isRunning = sessionStatus === "running" || sessionStatus === "starting";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="YAM home">
          <span className="brand-glyph">Y</span>
          <span className="brand-name">YAM</span>
        </div>
        <div className="sidebar-section">
          <div className="section-label">WORKSPACES</div>
          <button className="workspace-row active" type="button">
            <span className="workspace-dot" />
            <span className="workspace-copy">
              <strong>{session ? "Active session" : "New workspace"}</strong>
              <small>{session ? statusLabels[sessionStatus] ?? sessionStatus : "Ready for your first agent"}</small>
            </span>
          </button>
        </div>
        <button className="new-workspace" type="button" onClick={() => terminal.current?.clear()}>
          <span>+</span> Clear terminal
        </button>
        <div className="sidebar-footer">
          <span className="status-dot" />
          <span>Local engine {health?.status === "ready" ? "ready" : "checking"}</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">MISSION CONTROL / SESSION</p>
            <h1>Run an agent with confidence.</h1>
          </div>
          <span className={`health-badge ${health ? "online" : "pending"}`}>
            <span className="status-dot" /> {health ? "Engine online" : "Checking engine"}
          </span>
        </header>

        <section className="session-panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow accent">LOCAL PTY</p>
              <h2>Start a session</h2>
            </div>
            <span className={`session-status status-${sessionStatus}`}>
              <span className="status-dot" /> {statusLabels[sessionStatus] ?? "Ready"}
            </span>
          </div>
          <div className="session-controls">
            <label>
              <span>Working directory</span>
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Default shell directory" />
            </label>
            <label>
              <span>Command (optional)</span>
              <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Leave empty for an interactive shell" />
            </label>
            <div className="session-actions">
              <button className="primary-button" type="button" onClick={startSession} disabled={starting || isRunning}>
                {starting ? "Starting..." : isRunning ? "Session running" : "Start session"}
              </button>
              <button className="secondary-button" type="button" onClick={stopSession} disabled={!isRunning}>
                Stop
              </button>
            </div>
          </div>
          {session && <div className="session-meta">{session.session_id} · {session.cwd}</div>}
        </section>

        <section className="terminal-panel">
          <div className="terminal-header">
            <span>TERMINAL OUTPUT</span>
            <span>{session ? session.session_id : "No active session"}</span>
          </div>
          <div className="terminal-host" ref={terminalHost} />
        </section>

        {error && <p className="error-message">{error}</p>}
        <footer className="main-footer">
          <span>YAM alpha · {health?.platform ?? "local"}</span>
          <span>PTY events are local and observable</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
