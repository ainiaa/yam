// Author: Jeff.Liu. Connection disclosure reads recorded session facts.
import {t} from "./i18n";
import {connectionDetails,type ProviderConfig} from "./provider-config";
import {sessionRuntimeInfo} from "./session-runtime-info";
import type {AgentState} from "./agent-events";
type ConnectionLaunch={adapter:string;mode?:string;provider?:ProviderConfig|null;codex?:{image_mode:string}};

function SessionConnection({launch,agent,installedPiVersion,status='unknown',available=true,reconnecting=false,onReconnect}:{launch:ConnectionLaunch|null|undefined;agent?:AgentState;installedPiVersion?:string|null;status?:string;available?:boolean;reconnecting?:boolean;onReconnect?:()=>void}) {
  const connection=connectionDetails(launch),runtime=sessionRuntimeInfo(launch,agent,status,available);
  return <details className="session-connection" onKeyDown={event=>{if(event.key==="Escape"&&event.currentTarget.open&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
    <summary aria-label={t("Connection details")}>{t("Connection")}</summary>
    <div className="toolbar-more-actions">
      <p role="status"><strong>{t(runtime.stage.label)}</strong><br/>{t(runtime.stage.detail)}</p>
      {runtime.stage.reconnect&&onReconnect&&<button type="button" disabled={reconnecting} onClick={onReconnect}>{t('Reconnect background')}</button>}
      <strong>{t("Launch connection")}</strong>
      <dl>
        <dt>{t("CLI")}</dt><dd>{connection.cli}</dd>
        {launch?.adapter==="pi"&&<><dt>{t("Local Pi version")}</dt><dd>{installedPiVersion??t("Unknown")}</dd></>}
        <dt>{t("CLI version at launch")}</dt><dd>{agent?.cli_version??t("Unknown")}</dd>
        <dt>{t("CLI executable at launch")}</dt><dd>{runtime.executable}</dd>
        <dt>{t("Native session ID")}</dt><dd>{runtime.nativeSession}</dd>
        <dt>{t("Last confirmed state update (UTC)")}</dt><dd>{runtime.lastStateAt?<time dateTime={runtime.lastStateAt}>{runtime.lastStateAt}</time>:t("Unknown")}</dd>
        <dt>{t("Trusted hooks")}</dt><dd>{t(runtime.hooks)}</dd>
        <dt>{t("Launch platform")}</dt><dd>{agent?.cli_platform??t("Unknown")}</dd>
        {launch?.mode==='interactive'&&launch.adapter==='codex'&&<><dt>{t("Failure fallback")}</dt><dd>{agent?.integration!=="connected"&&agent?.cli_version?t("Not connected; trusted hooks required"):agent?.integration==="connected"&&agent.cli_platform==="macos"?t("Event validation enabled; trusted hooks and readable native transcript required"):t("Unverified platform or connection")}</dd></>}
        <dt>{t("Configuration")}</dt><dd>{t(connection.source)}</dd>
        <dt>{t("Configured model")}</dt><dd>{connection.model}</dd>
        <dt>{t("Effective model")}</dt><dd>{t(runtime.effectiveModel)}</dd>
        <dt>{t("Reasoning parameters")}</dt><dd>{t(runtime.reasoning)}</dd>
        <dt>{t("Credential source")}</dt><dd>{t(runtime.credentialSource)}</dd>
        <dt>{t("Configured endpoint")}</dt><dd>{connection.endpoint}</dd>
        {launch?.adapter==="codex"&&launch.codex&&<><dt>{t("Image generation")}</dt><dd>{launch.codex.image_mode==="gateway_api"?t("Gateway image API (imagegen skill)"):t("Codex default")}</dd><dt>{t("Inherited configuration")}</dt><dd>{launch.provider?t("Private snapshot of original Codex configuration; session connection override"):t("Existing Codex configuration")}</dd></>}
      </dl>
      <p>{t("Current model, authentication, billing and final upstream are not verified. Session launch values come from saved settings. Launch-time compatibility does not prove a receipt was delivered.")}</p>
      <p>{t("This is the last confirmed state change, not a heartbeat. Elapsed time alone does not prove that a task is stuck.")}</p>
      {launch?.mode==='interactive'&&launch.adapter==='claude'&&<p>{t("Esc interrupts Claude in the native terminal. An external interruption receipt is not guaranteed; check the terminal before submitting again.")}</p>}
      {launch?.mode==='interactive'&&launch.adapter==='codex'&&<p>{t("Compatibility follows native event structure, not a CLI version whitelist. Codex 0.162.1 and 0.163.0 were measured on macOS; each receipt still requires matching session, directory, turn and terminal event. Unknown structures do not synthesize failure.")}</p>}
    </div>
  </details>;
}

export {SessionConnection};
