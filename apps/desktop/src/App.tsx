import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type HealthReport = {
  app: string;
  version: string;
  platform: string;
  architecture: string;
  status: string;
};

const starterSessions = [
  { name: "New workspace", detail: "Ready for your first agent", state: "idle" },
];

function App() {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<HealthReport>("health_check")
      .then(setHealth)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark" aria-label="YAM home">
          <span className="brand-glyph">Y</span>
          <span className="brand-name">YAM</span>
        </div>

        <div className="sidebar-section">
          <div className="section-label">WORKSPACES</div>
          {starterSessions.map((session) => (
            <button className="workspace-row active" key={session.name} type="button">
              <span className="workspace-dot" />
              <span className="workspace-copy">
                <strong>{session.name}</strong>
                <small>{session.detail}</small>
              </span>
            </button>
          ))}
        </div>

        <button className="new-workspace" type="button">
          <span>+</span> New workspace
        </button>

        <div className="sidebar-footer">
          <span className="status-dot" />
          <span>Local engine {health?.status === "ready" ? "ready" : "checking"}</span>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p className="eyebrow">MISSION CONTROL</p>
            <h1>Good to have you here.</h1>
          </div>
          <button className="icon-button" type="button" aria-label="Open settings" title="Settings">
            <span aria-hidden="true">⚙</span>
          </button>
        </header>

        <section className="hero-panel">
          <div>
            <p className="eyebrow accent">FIRST RUN</p>
            <h2>Bring your agents into focus.</h2>
            <p className="hero-copy">
              Create a workspace to run Codex, Claude Code, or any CLI agent with reliable state and notifications.
            </p>
            <button className="primary-button" type="button">
              <span>+</span> Create workspace
            </button>
          </div>
          <div className="hero-signal" aria-hidden="true">
            <div className="signal-ring ring-one" />
            <div className="signal-ring ring-two" />
            <div className="signal-core">Y</div>
          </div>
        </section>

        <section className="overview-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">SYSTEM</p>
              <h2>Runtime health</h2>
            </div>
            <span className={`health-badge ${health ? "online" : "pending"}`}>
              <span className="status-dot" /> {health ? "Online" : "Checking"}
            </span>
          </div>

          <div className="health-grid">
            <div className="metric-card">
              <span className="metric-label">Engine</span>
              <strong>{health?.app ?? "YAM"}</strong>
              <small>{health ? `v${health.version}` : "Loading runtime"}</small>
            </div>
            <div className="metric-card">
              <span className="metric-label">Platform</span>
              <strong>{health?.platform ?? "—"}</strong>
              <small>{health?.architecture ?? "Waiting for IPC"}</small>
            </div>
            <div className="metric-card">
              <span className="metric-label">Active sessions</span>
              <strong>0</strong>
              <small>Nothing running</small>
            </div>
          </div>

          {error && <p className="error-message">Runtime check failed: {error}</p>}
        </section>

        <footer className="main-footer">
          <span>YAM alpha</span>
          <span>Local-first · Built for agent workflows</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
