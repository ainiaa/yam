import {ProjectWorkspace} from './ProjectWorkspace';
import {PiRoutingConfig,PiRoutingBar} from './PiRouting';
import DataSettings from './DataSettings';
import {createPreferencesBackup,preferencesImportWrites,applyPreferencesImport,type PreferencesBackup} from './preferences-backup';
import {startupTimings} from './startup-timings';
import {connectionTemplate} from './saved-connections';
import {duplicateSessionDraft,readSessionLaunchSettings,saveSessionLaunchSettings,readSessionName,saveSessionName,loadSessionNames,isSessionPreferenceKey,type SessionLaunchSettings} from "./session-actions";
import {SettingsNavigation,type SettingsPage} from "./SettingsNavigation";
import {applyAppThemeDocument,applyAppTerminalTheme} from "./app-themes";
import {AppAppearance} from "./AppAppearance";
import {APP_PREFERENCES_KEY,loadAppPreferences,saveAppPreferences,resolveLocale,type AppPreferences} from "./app-preferences";
import {setLocale} from "./i18n";
import {useTranslation} from "react-i18next";
import {i18n} from "./i18n";
import {t} from "./i18n";
import {fontPresets,terminalFontCatalog} from "./terminal-fonts";
import {installActionMenus} from "./action-menus";
import {dispatchNativeMenu,nativeMenuLabels,type NativeMenuAction} from "./native-menu";
import {Select} from "./Select";
import {conversationRoundRevision} from "./conversation-view";
import {ConversationView} from "./ConversationView";
import {loadTerminalLineHeight,decodeTerminalLineHeight,saveTerminalLineHeight,terminalLineHeightOptions,type TerminalLineHeight} from "./terminal-line-height";
import {getCurrentWebview} from "@tauri-apps/api/webview";
import {TerminalFileDropDialog,type TerminalFileDropContent} from "./TerminalFileDropDialog";
import {inspectTerminalFileDrop,fileDropText,sameTerminalFileDropTarget,type TerminalFileDropTarget} from "./terminal-file-drop";
import {SshLaunchDialog} from "./SshLaunchDialog";
import {isSshLaunch,sshTitle,snapshotSshSettings,type SshLaunch} from "./ssh-launch";
import {loadTerminalRetention,decodeTerminalRetention,saveTerminalRetention,type TerminalRetention} from "./terminal-retention";
import {loadTerminalCursor,decodeTerminalCursor,saveTerminalCursor,terminalCursorOptions,type TerminalCursor} from "./terminal-cursor";
import {TerminalFilePreview} from "./TerminalFilePreview";
import {BrowserWindowDialog} from "./BrowserWindowDialog";
import {BrowserControls,type BrowserAction} from "./browser-window";
import {selectedFilePath,filePreviewReply,type TerminalFilePreviewData} from "./terminal-file-actions";
import {ZshDirectoryReporting} from "./ZshDirectoryReporting";
import {ZshCommandReporting} from "./ZshCommandReporting";
import {loadZshCommandReporting,saveZshCommandReporting,zshCommandReportingEligible} from "./zsh-command-reporting";
import {loadZshDirectoryReporting,saveZshDirectoryReporting,zshDirectoryReportingEligible} from "./zsh-directory-reporting";
import {installTerminalLinks} from "./terminal-links";
import {openUrl} from "@tauri-apps/plugin-opener";
import {TerminalPastePreview,TerminalPasteSettings} from "./TerminalPastePreview";
import {loadTerminalPaste,saveTerminalPaste,inspectTerminalPaste,terminalPasteInputEligible,sameTerminalPasteTarget,type TerminalPasteMode,type TerminalPasteText,type PendingTerminalPaste,type TerminalPasteTarget} from "./terminal-paste";
import {SearchAddon} from "@xterm/addon-search";
import {TerminalFindController,FindWorker,createFindWorker} from "./terminal-find";
import {TerminalFindBar} from "./TerminalFind";
import {createTerminalScroll,updateTerminalScroll,type TerminalScrollState} from "./terminal-scroll";
import {GitChanges} from "./GitChanges";
import {ProjectFiles} from "./ProjectFiles";
import {RunChanges} from "./RunChanges";
import {ReviewFeedback} from "./ReviewFeedback";
import {reviewOrigin,reviewReady,deliverReviewFeedback,type ReviewOrigin,type ReviewLocation} from "./review-feedback";
import {relativeProjectFile,type ProjectFileRequest} from "./project-files";
import type {DiffTarget} from "./git-diff-navigation";
import {ProviderCatalog} from "./ProviderCatalog";
import UpdaterSettings from "./UpdaterSettings";
import {UpdaterController,loadUpdaterPreference,saveUpdaterPreference,updaterAutomaticAction,UPDATE_CHECK_INTERVAL_MS,updaterBusy,type UpdaterSnapshot} from "./updater";
import SystemEntrySettings from "./SystemEntrySettings";
import {SystemEntryController,type NotificationPauseState} from "./system-entry";
import {saveTerminalLayout} from "./terminal-layout-persistence";
import {TerminalLayout} from "./TerminalLayout";
import {createTerminalLayout,changeTerminalLayout,assignTerminalPane,replaceTerminalSession,removeTerminalPane,isTerminalProtocolResponse,resizeTerminalNode,clampSplitPercent,swapTerminalPanes,terminalPaneId,terminalPaneIndex,terminalLeaves,terminalLayoutRoot,splitTerminalPane,terminalTabs,terminalMembers,terminalSessionPane,removeTerminalTab,splitAndMoveTerminalTab,type TerminalPaneEdge,moveTerminalTab,terminalDirectionPane,type TerminalPaneDirection,type TerminalPaneRect,type TerminalLayoutMode} from "./terminal-layout";
import {GitContextPolling,gitContextLabel,type GitContext} from "./git-context";
import {historyRequest,capacityLevel,type HistoryItem,type HistoryCursor,type HistoryPage,type HistoryOverview,type InboxItem,type PendingKey,type HistoryCapacity} from "./history";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import {memoryLabel, startMemoryPolling, type MemorySample} from "./memory";
import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import {getWindowContext,terminalWindowClaim,terminalMoveReply,type TerminalMoveReceipt,createWindowStorage,publishWindowPreference,acceptWindowPreferenceCommit,type WindowPreferenceCommit,desktopInvoke,windowPreferenceKey as slotPreferenceKey,readWindowPreference} from "./window-context";
function invoke<T=unknown>(name:string,args?:Record<string,unknown>):Promise<T>{return desktopInvoke(nativeInvoke,getWindowContext(),name,args);}
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Ellipsis,
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
  Bell,
  BellOff,
  LogOut,
  ListFilter,
  Settings,
  Pin, PinOff, ArrowUp, ArrowDown, Trash2, Archive, HardDrive, GitBranch,
} from "lucide-react";
import {
  groupProjects, sidebarSessions, defaultTerminalTitle,
  validateProjectName, moveProjectAdjacent, moveProjectToTarget, setProjectPinned, validProjectColor, validProjectIcon, projectColor, PROJECT_COLORS,
  validateSessionTitle,
  selectProjectDirectory,
  isProjects,
  projectKey,
  projectName,
  readPreference,
  type Project,
} from "./workspaces";
import { OutputBuffer, consumeOutput, replayOutput, type OutputChunk, type LogSnapshot } from "./session-stream";
import { TerminalViews } from "./terminal-views";
import {TERMINAL_SCROLLBACK_LINES,applyTerminalFrame,validateTerminalFrame,terminalReportedCwd,terminalReportedCommand,terminalReportedPromptNavigation,terminalClearDisplayVersion,type TerminalFrame} from "./terminal-frame";
import {WorktreeControls} from "./WorktreeControls";
import {ProjectConfigPreview} from "./ProjectConfigPreview";
import {ProjectConfigSelection,resolveLaunchDefaults,isLaunchDefaults,type LaunchDefaults,type ProjectPreview} from "./project-config";
import {supportsProvider,providerPreset,providerChoice,isProviderConfig,connectionDetails,type ProviderConfig} from "./provider-config";
import {LaunchTemplateCollection,projectLaunchFields,type LaunchTemplate} from "./launch-templates";
import {LaunchTemplates} from "./LaunchTemplates";
import {loadShellLaunch,saveShellLaunch,shellStartError,type ShellLaunch} from "./shell-launch";
import {TerminalSettings as TerminalSettingsDialog,CommandPalette} from "./TerminalSettings";
import {TerminalProfiles} from "./TerminalProfiles";
import {TerminalProfileCollection,terminalProfileStart,type TerminalProfileDraft} from "./terminal-profiles";
import {loadTerminalSettings,saveTerminalSettings,terminalOptions,queueTerminalResize,zoomTerminalSettings,type TerminalZoomAction,type TerminalSettings} from "./terminal-settings";
import {KeyboardShortcutSettings} from "./KeyboardShortcutSettings";
import {loadAppShortcuts,saveAppShortcuts,resolveAppShortcut,shortcutHint,type AppShortcuts} from "./app-shortcuts";
import {paletteEntries,executePaletteEntry,isPinnedSessions,orderPinnedSessions,togglePinnedSession,canCloseSessionView,type PaletteEntry} from "./command-palette";
import {HistoryArchive} from "./HistoryArchive";
import { SessionLogSearch } from "./SessionLogSearch";
import { SessionLogExport } from "./SessionLogExport";
import {sessionRecovery,type SessionAvailability} from "./session-recovery";
import {AttentionCard} from "./AttentionCard";
import {captureAttention,isCurrentAttention} from "./attention-actions";
import {agentLabel,type AgentState,type AgentReceipt} from "./agent-events";
import {sessionRuntimeInfo} from "./session-runtime-info";
import { NotificationQueue, inferAgentPhase, discardAttentionRetries, terminalStatuses } from "./notifications";
import "@xterm/xterm/css/xterm.css";
import "./App.css";

type HealthReport = {
  app: string;
  version: string;
  platform: string;
  architecture: string;
  status: string;
};

type AgentLaunch = {codex?:{image_mode:"native"|"gateway_api";context?:string}; adapter: string; mode: "task" | "interactive"; extra_args: string; prompt: string | null; provider?:ProviderConfig|null; env_refs?:Record<string,string> };

type SessionSummary = {
  ssh?:SshLaunch;
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
  agent?: AgentState;
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

type TerminalView = {continuation?:{chunks:{data:string;paste:boolean}[];length:number;cancelled:boolean};inputQueue?:{write:Promise<void>|null;version:number;length:number;count:number};agentRefreshVersion?:number;recordedOnly?:boolean;clearDisplayVersion?:1|null;clearPending?:boolean; reportedPromptNavigation?:ReturnType<typeof terminalReportedPromptNavigation>;promptNavigationPending?:boolean; moving?:boolean;moveDisposal?:boolean;moveListenerRevision?:number;refreshMoveListeners?:()=>void; desktopGeneration:number; reportedCommand:ReturnType<typeof terminalReportedCommand>;reportedCommandSequence:number;reportedCommandPair:string|null; reportedCwd:string|null;reportedCwdSequence:number; appearance:TerminalSettings;appearanceRevision:number;appearanceFitPending?:()=>boolean; find?:TerminalFindController; scroll?:TerminalScrollState;scrollReturnPending?:boolean;scrollReturnIntent?:number; availability?:SessionAvailability; record?:SessionRecord; attachVersion?:number; attaching?:boolean; instance: Terminal; fit: FitAddon; element: HTMLDivElement; cursor: number | null; ready: boolean; replayVersion:number; firstAttachment:boolean; parsing:Promise<void>|null; finishReplay:(()=>void)|null; live: boolean; status:string|null; notice: string | null; persisted:boolean; projection:boolean; frameRevision:number; frameInstance:string|null; dirty:boolean; updating:boolean; selecting:boolean; lifecycleRevision:number; projecting:boolean; viewportRevision:number; resizing:boolean;resizePending:{cols:number;rows:number}|null;disposed:boolean;writable:boolean; dispose(): void };

type AgentPhase = "idle" | "working" | "waiting";

const statusLabels: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  needs_attention: "Needs attention",
};

type HiddenTerminal={token:object;id:string;pane:string;view:TerminalView;instance:Terminal;epoch:number;generation:number;owner:number;parser:string|null;attachment:number|undefined;lifecycle:number;live:boolean;status:string|null};
type PendingTerminalMove={id:string;view:TerminalView;instance:Terminal;generation:number;connection:number;attachment:number|undefined;appearance:TerminalSettings;writable:boolean;receipt:TerminalMoveReceipt|null};
function ProviderPortCheck({endpoint}:{endpoint:string}) {
 const pending=useRef(false);
 const [result,setResult]=useState<{endpoint:string;status:string}|null>(null);
 async function check(){
  if(pending.current)return;pending.current=true;setResult({endpoint,status:"checking"});
  try{const reply=await invoke<string>("probe_provider_endpoint",{endpoint});setResult({endpoint,status:["reachable","unreachable","timed_out","unsupported"].includes(reply)?reply:"unavailable"});}
  catch{setResult({endpoint,status:"unavailable"});}
  finally{pending.current=false;}
 }
 const messages:Record<string,string>={checking:"Checking local port…",reachable:"Port is reachable. Authentication and model are not verified.",unreachable:"Cannot connect to this local port.",timed_out:"Local port check timed out (2 seconds maximum).",unsupported:"This check only supports local gateways at localhost, 127.0.0.1 or ::1 using HTTP or HTTPS.",unavailable:"Check unavailable. Try again manually."};
 return <div><button type="button" disabled={pending.current} onClick={check}>{t("Check local port")}</button><small>{t("TCP port check only; authentication and model are not verified. No model request is sent.")}</small>{result?.endpoint===endpoint&&<p className={`connection-result ${result.status==="checking"?"pending":result.status==="reachable"?"success":"error"}`} role={result.status==="checking"||result.status==="reachable"?"status":"alert"}>{result.status==="checking"?"":result.status==="reachable"?"✓ ":"✕ "}{t(messages[result.status])}</p>}</div>;
}

function SessionConnection({launch,agent}:{launch:AgentLaunch|null|undefined;agent?:AgentState}) {
  const connection=connectionDetails(launch),runtime=sessionRuntimeInfo(launch,agent);
  return <details className="toolbar-more session-connection" onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
    <summary aria-label={t("Connection details")}>{t("Connection")+" "}<ChevronDown size={12} aria-hidden="true"/></summary>
    <div className="toolbar-more-actions">
      <strong>{t("Launch connection")}</strong>
      <dl>
        <dt>{t("CLI")}</dt><dd>{connection.cli}</dd>
        <dt>{t("CLI executable at launch")}</dt><dd>{runtime.executable}</dd>
        <dt>{t("Native session ID")}</dt><dd>{runtime.nativeSession}</dd>
        <dt>{t("Trusted hooks")}</dt><dd>{t(runtime.hooks)}</dd>
        <dt>{t("CLI version at launch")}</dt><dd>{agent?.cli_version??t("Unknown")}</dd>
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
      <p>{t("Current model, authentication, billing and final upstream are not verified. Values above are the saved launch settings. Launch-time compatibility does not prove a receipt was delivered.")}</p>
      {launch?.mode==='interactive'&&launch.adapter==='claude'&&<p>{t("Esc interrupts Claude in the native terminal. An external interruption receipt is not guaranteed; check the terminal before submitting again.")}</p>}
      {launch?.mode==='interactive'&&launch.adapter==='codex'&&<p>{t("Compatibility follows native event structure, not a CLI version whitelist. Codex 0.162.1 and 0.163.0 were measured on macOS; each receipt still requires matching session, directory, turn and terminal event. Unknown structures do not synthesize failure.")}</p>}
    </div>
  </details>;
}
function App() {
  useTranslation(undefined,{i18n});
  const desktopWindow=getWindowContext(),isMainWindow=desktopWindow.slot==="main";
  const localStorage=createWindowStorage(window.localStorage,desktopWindow,(key,value)=>{void publishWindowPreference(nativeInvoke,desktopWindow,key,value).catch(()=>setError(key==="yam.terminalLineHeight.v1"?"Line height was saved, but could not reach the other window.":"Shared preferences could not reach the second window."));});
  const preferenceRevision=useRef(0),viewClaimSelection=useRef(0),paneClaimSelection=useRef(new Map<string,number>()),pendingViewClaims=useRef(new Map<string,{count:number;generation:number}>());
  const windowPreferenceKey=(name:string)=>slotPreferenceKey(desktopWindow.slot,name);
  function openMainSettings(target:string="settings"){void invoke("open_main_settings",{target}).catch(()=>setError("Main settings window is unavailable."));}
  const terminalMoveTaskRef=useRef<PendingTerminalMove|null>(null),terminalMoveIncomingRef=useRef<TerminalMoveReceipt|null>(null),terminalMoveOperationRef=useRef(false);
  const [movePending,setMovePending]=useState(false),[moveBusy,setMoveBusy]=useState(false);
  function terminalMoveSourceCurrent(task:PendingTerminalMove){return terminalMoveTaskRef.current===task&&terminalMounted.current&&terminalViews.current.get(task.id)===task.view&&!task.view.disposed&&task.view.instance===task.instance&&task.view.desktopGeneration===task.generation&&task.view.attachVersion===task.attachment&&ownerConnectionAvailable.current.version===task.connection;}
  function suspendTerminalMove(task:PendingTerminalMove){const view=task.view;view.moveListenerRevision=(view.moveListenerRevision??0)+1;view.moving=true;view.clearDisplayVersion=null;view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;view.writable=false;view.resizePending=null;view.scrollReturnPending=false;view.lifecycleRevision++;view.viewportRevision++;view.attachVersion=(view.attachVersion??0)+1;task.attachment=view.attachVersion;cancelTerminalPaste(false);cancelTerminalFile();cancelTerminalFileDrop();setTerminalNotice("Moving tab: input and terminal updates are paused. Use Check/Continue move if the result is unavailable.");setMovePending(true);setRecoveryRevision(v=>v+1);}
  function resumeTerminalMove(task:PendingTerminalMove,generation:number){if(!terminalMoveSourceCurrent(task))return;const view=task.view;view.desktopGeneration=generation;view.lifecycleRevision++;view.viewportRevision++;view.attachVersion=(view.attachVersion??0)+1;view.moving=false;view.writable=task.writable;view.dirty=true;view.refreshMoveListeners?.();terminalMoveTaskRef.current=null;setMovePending(false);setTerminalNotice(null);setRecoveryRevision(v=>v+1);}
  function canMoveTerminalTab(){const id=sessionId.current,view=id?terminalViews.current.get(id):null;return !terminalMoveTaskRef.current&&!terminalMoveOperationRef.current&&!!id&&!!view&&!view.disposed&&!view.moving&&view.ready&&view.live&&view.projection&&!view.attaching&&!view.parsing&&!view.updating&&!view.resizing&&view.availability!=="owner_unavailable"&&view.availability!=="terminal_unavailable"&&ownerConnectionAvailable.current.available&&terminalPaneVisible(id)&&view.element.isConnected&&!view.element.inert&&view.element.style.visibility!=="hidden"&&view.instance.modes.mouseTrackingMode==="none"&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop');}
  async function disposeMoveSource(task:PendingTerminalMove,receipt:TerminalMoveReceipt){
    if(receipt.source!==desktopWindow.slot||receipt.source_epoch!==desktopWindow.epoch||receipt.source_generation!==task.generation||receipt.session_id!==task.id)throw Error("Terminal move source changed. Keep the pending task and check it again.");
    task.receipt=receipt;if(receipt.phase!=="awaiting_source")return;
    if(terminalViews.current.get(task.id)===task.view){if(!terminalMoveSourceCurrent(task)&&!task.view.disposed)throw Error("Terminal move source attachment changed.");task.view.moveDisposal=true;terminalViews.current.retain(view=>view!==task.view);}
    if(!task.view.disposed||task.view.element.isConnected||terminalViews.current.get(task.id)===task.view)throw Error("Source terminal disposal is incomplete. Check/Continue move to retry.");
    const layout=terminalLayoutRef.current,pane=terminalSessionPane(layout,task.id);if(pane>=0){const next=removeTerminalTab(layout,pane,task.id);terminalLayoutRef.current=next;setTerminalLayout(next);showTerminalLayout();try{localStorage.setItem(windowPreferenceKey("lastSession"),JSON.stringify(next.panes[next.focused]));}catch{setError("Moved tab layout could not be saved. Current GUI ownership is retained.");}}
    const reply=terminalMoveReply(await invoke("release_terminal_view",{sessionId:task.id,desktopGeneration:task.generation,moveToken:receipt.token}));
    if(reply.status!=="pending"&&reply.status!=="completed")throw Error("Move disposal acknowledgment is pending. Check/Continue move.");task.receipt=reply.receipt;
    recoverRevealedTerminals(layout);
  }
  async function moveTerminalTabToOtherWindow(){
    if(!canMoveTerminalTab())return;const id=sessionId.current!,view=terminalViews.current.get(id)!;
    const task:PendingTerminalMove={id,view,instance:view.instance,generation:view.desktopGeneration,connection:ownerConnectionAvailable.current.version,attachment:view.attachVersion,appearance:{...view.appearance},writable:view.writable,receipt:null};terminalMoveTaskRef.current=task;terminalMoveOperationRef.current=true;setMoveBusy(true);suspendTerminalMove(task);
    try{const reply=terminalMoveReply(await invoke("prepare_terminal_move",{sessionId:id,desktopGeneration:task.generation,appearance:task.appearance}));if(!terminalMounted.current)return;if(reply.status==="pending"){if(!terminalMoveSourceCurrent(task))throw Error("Move is pending after source attachment changed.");await disposeMoveSource(task,reply.receipt);}else if(reply.status==="busy"||reply.status==="unavailable"||reply.status==="stale"){resumeTerminalMove(task,task.generation);setError("Terminal move is busy or unavailable. The source tab was preserved.");}else if(reply.status==="completed"){terminalMoveTaskRef.current=null;setMovePending(false);}else{throw Error("Terminal move result is pending.");}}
    catch{setError("Terminal move result is unavailable. The task was preserved; use Check/Continue move.");}
    finally{terminalMoveOperationRef.current=false;setMoveBusy(false);}
  }
  async function continueTerminalMove(){
    if(terminalMoveOperationRef.current)return;const task=terminalMoveTaskRef.current;terminalMoveOperationRef.current=true;setMoveBusy(true);
    try{let reply=terminalMoveReply(await invoke("query_terminal_move",{sessionId:task?.id??terminalMoveIncomingRef.current?.session_id??null}));if(!terminalMounted.current)return;
      if(reply.status==="pending"&&reply.receipt.source===desktopWindow.slot){if(reply.receipt.target_destroyed)reply=terminalMoveReply(await invoke("recover_terminal_move",{token:reply.receipt.token}));if(reply.status==="pending"){terminalMoveIncomingRef.current=reply.receipt;if(task){task.receipt=reply.receipt;if(reply.receipt.phase==="awaiting_source")await disposeMoveSource(task,reply.receipt);}else if(reply.receipt.phase==="awaiting_source")throw Error("Source disposal proof is unavailable. The pending process is preserved.");setMovePending(true);}}
      else if(reply.status==="completed"){terminalMoveTaskRef.current=null;terminalMoveIncomingRef.current=null;setMovePending(false);}
      else if(reply.status==="stale"&&task&&!task.view.disposed){const reconciled=terminalMoveReply(await invoke("reconcile_terminal_move",{sessionId:task.id,desktopGeneration:task.generation}));if(reconciled.status==="resume")resumeTerminalMove(task,reconciled.generation);else if(reconciled.status==="pending"){task.receipt=reconciled.receipt;await disposeMoveSource(task,reconciled.receipt);}else throw Error("Move reconciliation is still unavailable.");}
      else if(reply.status==="pending"){terminalMoveIncomingRef.current=reply.receipt;setMovePending(true);}else throw Error("Terminal move is still pending or unavailable.");
    }catch{setError("Terminal move could not be reconciled. Keep the pending task and use Check/Continue move again.");}finally{terminalMoveOperationRef.current=false;setMoveBusy(false);}
  }
  async function openMovedTerminalTab(){
    const expected=terminalMoveIncomingRef.current;if(!expected||terminalMoveOperationRef.current)return;const openingDetail=detailVersion.current,openingRestore=layoutRestore.current.version;terminalMoveOperationRef.current=true;setMoveBusy(true);
    try{let reply=terminalMoveReply(await invoke("query_terminal_move",{sessionId:expected.session_id}));if(reply.status!=="pending"&&reply.status!=="completed")throw Error();if(reply.receipt.target!==desktopWindow.slot||(reply.receipt.target_epoch!==desktopWindow.epoch&&!reply.receipt.target_destroyed))throw Error();
      if(reply.receipt.target_destroyed){reply=terminalMoveReply(await invoke("recover_terminal_move",{token:reply.receipt.token}));if(reply.status!=="pending")throw Error();}
      reply=terminalMoveReply(await invoke("accept_terminal_move",{token:reply.receipt.token}));if(reply.status!=="pending"&&reply.status!=="completed")throw Error();const receipt=reply.receipt;terminalMoveIncomingRef.current=receipt;
      const record=await invoke<SessionRecord>("get_session",{sessionId:receipt.session_id});if(!terminalMounted.current||detailVersion.current!==openingDetail||layoutRestore.current.version!==openingRestore||terminalMoveIncomingRef.current?.token!==receipt.token)throw Error();const current=()=>terminalMounted.current&&terminalMoveIncomingRef.current?.token===receipt.token&&terminalWindowClaim(receipt.session_id)===receipt.target_generation;
      const attachment=await openHistory(record,false,undefined,undefined,current,receipt.appearance,receipt);
      if(!current()||!attachment||attachment.view.disposed||!attachment.view.ready||attachment.view.desktopGeneration!==receipt.target_generation)throw Error();
      const completed=terminalMoveReply(await invoke("complete_terminal_move",{token:receipt.token}));if(completed.status!=="completed")throw Error();terminalMoveIncomingRef.current=null;setMovePending(!!terminalMoveTaskRef.current);
    }catch{setError("Moved tab is still pending. Use Open moved tab to retry; the process was not restarted.");}finally{terminalMoveOperationRef.current=false;setMoveBusy(false);}
  }
  async function receiveTerminalMove(autoOpen=false){if(!terminalMounted.current)return;try{const reply=terminalMoveReply(await invoke("query_terminal_move",{sessionId:null}));if(!terminalMounted.current)return;if(reply.status==="pending"){terminalMoveIncomingRef.current=reply.receipt;setMovePending(true);if(autoOpen&&reply.receipt.target===desktopWindow.slot&&reply.receipt.target_epoch===desktopWindow.epoch&&reply.receipt.phase==="awaiting_target")await openMovedTerminalTab();}}catch{setError("Pending window moves are unavailable. Use Check/Continue move to query again.");}}
  useEffect(()=>{let active=true,unlisten:UnlistenFn|null=null;void listen("terminal-tab-move",()=>{if(active)void receiveTerminalMove(true);}).then(dispose=>{if(!active){dispose();return;}unlisten=dispose;void receiveTerminalMove(false);}).catch(()=>{if(active)setError("Move events unavailable. Use Check/Continue move to query pending tasks.");});return()=>{active=false;unlisten?.();};},[]);
  async function openSecondWindow(){try{await invoke("open_terminal_window");}catch{setError("Second terminal window is unavailable. Running tasks were preserved.");}}
  function applyLaunchTemplate(template:LaunchTemplate){
    if(template.mode!=="interactive"){setError("One-shot task templates are kept for automation and cannot be applied to New session.");return;}
    editLaunch({...projectLaunchFields(template),provider:template.provider??null,codex:template.adapter==="codex"?template.codex??{image_mode:"native"}:undefined});
    if(launchSettingsDialog.current?.open){launchSettingsDialog.current.close();launchDialog.current?.showModal();}
  }
  const [updaterPreferenceLoad]=useState(()=>loadUpdaterPreference(()=>localStorage.getItem("yam.updater.v1")));
  const updaterController=useRef(new UpdaterController());
  const updaterMounted=useRef(false);
  const updaterIntent=useRef(0);
  const [updaterOpen,setUpdaterOpen]=useState(false);
  const [dataSettingsOpen,setDataSettingsOpen]=useState(false);
  const [updaterSnapshot,setUpdaterSnapshot]=useState<UpdaterSnapshot|null>(null);
  const [updaterAutomatic,setUpdaterAutomatic]=useState(updaterPreferenceLoad.automatic);
  const updaterAutomaticRef=useRef(updaterAutomatic);updaterAutomaticRef.current=updaterAutomatic;
  const [updaterError,setUpdaterError]=useState<string|null>(updaterPreferenceLoad.error);
  const [updaterBusyAction,setUpdaterBusy]=useState(false);
  useEffect(()=>{
    if(!isMainWindow)return;
    updaterMounted.current=true;let active=true;const intent=++updaterIntent.current;
    void (async()=>{
      try {
        const initial=await updaterController.current.load(invoke);
        if(!active||!updaterMounted.current||intent!==updaterIntent.current)return;
        setUpdaterSnapshot(initial);
        const next=await updaterController.current.startup(invoke,updaterAutomaticRef.current,()=>updaterMounted.current&&updaterAutomaticRef.current);
        if(active&&updaterMounted.current&&intent===updaterIntent.current&&next)setUpdaterSnapshot(next);
      } catch {if(active&&updaterMounted.current&&intent===updaterIntent.current)setUpdaterError("updater_unavailable");}
    })();
    return ()=>{active=false;updaterMounted.current=false;updaterIntent.current++;updaterController.current.cancel();};
  },[]);
  useEffect(()=>{
    if(!isMainWindow||(!updaterOpen&&!updaterAutomaticRef.current&&!updaterBusy(updaterSnapshot?.state??"idle")&&!["available","verified"].includes(updaterSnapshot?.state??"idle")))return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      let waitingForStatus=false;
      try {
        let next=await updaterController.current.refresh(invoke);waitingForStatus=next===null;
        if(active&&updaterMounted.current&&updaterAutomaticAction(next,updaterAutomaticRef.current))next=await updaterController.current.action(invoke,"download");
        if(active&&updaterMounted.current&&next)setUpdaterSnapshot(next);
      }
      catch {if(active&&updaterMounted.current)setUpdaterError("updater_unavailable");}
      // A closed predecessor can still own the single status RPC. Retry without overlap.
      if(active&&(waitingForStatus||(updaterController.current.snapshot&&(updaterBusy(updaterController.current.snapshot.state)||updaterController.current.snapshot.state==="verified"))))timer=setTimeout(poll,1000);
    }
    void poll();
    return ()=>{active=false;if(timer!==undefined)clearTimeout(timer);};
  },[updaterOpen||updaterAutomatic,updaterSnapshot?.state,updaterAutomatic]);
  useEffect(()=>{
    if(!isMainWindow||!updaterAutomatic)return;
    const timer=window.setInterval(()=>{
      const current=updaterController.current.snapshot;
      if(current?.configured&&!updaterBusy(current.state))void runUpdaterAction("check");
    },UPDATE_CHECK_INTERVAL_MS);
    return()=>window.clearInterval(timer);
  },[updaterAutomatic]);
  async function runUpdaterAction(action:"check"|"download"|"cancel"|"install") {
    if(!isMainWindow){openMainSettings();return;}
    const intent=++updaterIntent.current;setUpdaterBusy(true);
    try {const next=await updaterController.current.action(invoke,action);if(updaterMounted.current&&intent===updaterIntent.current&&next){setUpdaterSnapshot(next);setUpdaterError(null);}}
    catch {if(updaterMounted.current&&intent===updaterIntent.current)setUpdaterError("updater_operation_failed");}
    finally {if(updaterMounted.current&&intent===updaterIntent.current)setUpdaterBusy(false);}
  }
  async function changeUpdaterAutomatic(enabled:boolean) {
    const intent=++updaterIntent.current;
    const error=saveUpdaterPreference(raw=>localStorage.setItem("yam.updater.v1",raw),enabled);
    const automatic=error?false:enabled;updaterAutomaticRef.current=automatic;setUpdaterAutomatic(automatic);setUpdaterError(error);
    const current=updaterController.current.snapshot;if(!current)return;
    setUpdaterBusy(true);
    try {const next=await invoke("updater_set_automatic_checks",{expected_generation:current.generation,enabled:automatic});if(updaterMounted.current&&intent===updaterIntent.current){updaterController.current.accept(next);setUpdaterSnapshot(updaterController.current.snapshot);}}
    catch {if(updaterMounted.current&&intent===updaterIntent.current)setUpdaterError("updater_preference_unavailable");}
    finally {if(updaterMounted.current&&intent===updaterIntent.current)setUpdaterBusy(false);}
  }
  function closeUpdaterSettings(){setUpdaterOpen(false);}
  // Live views stay warm; ended background-owned scenes release idle hidden renderers after selection.
  const terminalViews = useRef(new TerminalViews<TerminalView>(16));
  const terminalReopen=useRef<HiddenTerminal|null>(null),terminalReopenFlight=useRef<object|null>(null);
  const [layoutPreferenceLoad]=useState(()=>desktopWindow.preference);
  const layoutRestore=useRef({version:0,pending:true,ids:[] as string[],adoptable:false,queued:false});
  const [layoutRestoreReady,setLayoutRestoreReady]=useState(false);
  const layoutRestoreRetry=useRef<(()=>Promise<void>)|null>(null);
  const [layoutRestoreRetrying,setLayoutRestoreRetrying]=useState(false);
  const [splitPercent]=useState(()=>layoutPreferenceLoad.splitPercent);
  const splitPercentRef=useRef(splitPercent);splitPercentRef.current=splitPercent;
  const terminalLayoutFitFrame=useRef<number|null>(null);
  const terminalLayoutFitIntent=useRef(0);
  const [terminalLayout,setTerminalLayout]=useState(createTerminalLayout);
  const terminalLayoutRef=useRef(terminalLayout);
  const [zoomedPaneId,setZoomedPaneId]=useState<string|null>(null);
  const zoomedPaneIdRef=useRef<string|null>(null),terminalPaneZoomIntent=useRef(0);
  const terminalTabFocus=useRef<{id:string;paneId:string;revision:number;owner:number;zoom:number;origin:Element|null;view:TerminalView;queued:boolean}|null>(null);
  const terminalTabDrag=useRef<{id:string;paneId:string;revision:number;owner:number;zoom:number;zoomed:string|null}|null>(null);
  const paneZoomGeneration=terminalPaneZoomIntent.current;
  const paneHosts=useRef(new Map<string,HTMLDivElement>());
  const terminalMounted=useRef(false);
  const ownerConnectionAvailable=useRef({available:true,version:0});
  const [conversationOpen,setConversationOpen]=useState(false);
  const conversationOpenRef=useRef(conversationOpen);conversationOpenRef.current=conversationOpen;
  function showConversation(open:boolean,focusOrigin=document.activeElement){conversationOpenRef.current=open;setConversationOpen(open);if(open)void refreshSelectedAgent();if(!open)requestAnimationFrame(()=>{if(!conversationOpenRef.current){requestTerminalLayoutFit();if(document.activeElement===focusOrigin||document.activeElement===document.body)focusTerminalPane(terminalLayoutRef.current.focused,true);}});}
  const stopAllPending=useRef(false),reconnectPending=useRef(false);
  const [stopAllBusy,setStopAllBusy]=useState(false),[reconnecting,setReconnecting]=useState(false);
  const notificationContextVersion=useRef(0);
  const notificationContextFlight=useRef<{
    sending:boolean;
    pending:{selected:string|null;paused:boolean;version:number}|null;
  }>({sending:false,pending:null});
  const shellWindows=navigator.platform.startsWith("Win");
  const [directoryReportingLoad]=useState(()=>loadZshDirectoryReporting(()=>localStorage.getItem("yam.zsh-directory-reporting.v1")));
  const [directoryReporting,setDirectoryReporting]=useState(directoryReportingLoad.enabled);
  const directoryReportingRef=useRef(directoryReporting);directoryReportingRef.current=directoryReporting;
  const [directoryReportingError,setDirectoryReportingError]=useState<string|null>(directoryReportingLoad.error);
  const [directoryReportingOpen,setDirectoryReportingOpen]=useState(false);
  function applyDirectoryReporting(enabled:boolean){saveZshDirectoryReporting((key,value)=>localStorage.setItem(key,value),enabled);directoryReportingRef.current=enabled;setDirectoryReporting(enabled);setDirectoryReportingError(null);}
  const [commandReportingLoad]=useState(()=>loadZshCommandReporting(()=>localStorage.getItem("yam.zsh-command-reporting.v1")));
  const [commandReporting,setCommandReporting]=useState(commandReportingLoad.enabled);
  const commandReportingRef=useRef(commandReporting);commandReportingRef.current=commandReporting;
  const [commandReportingError,setCommandReportingError]=useState<string|null>(commandReportingLoad.error);
  const [commandReportingOpen,setCommandReportingOpen]=useState(false);
  function applyCommandReporting(enabled:boolean){saveZshCommandReporting((key,value)=>localStorage.setItem(key,value),enabled);commandReportingRef.current=enabled;setCommandReporting(enabled);setCommandReportingError(null);}
  const [shellPreferenceLoad]=useState(()=>loadShellLaunch(()=>localStorage.getItem("yam.shellLaunch.v1"),shellWindows));
  const [shellLaunch,setShellLaunch]=useState<ShellLaunch|null>(shellPreferenceLoad.shell);
  const shellLaunchRef=useRef(shellLaunch);shellLaunchRef.current=shellLaunch;
  const [shellLaunchError,setShellLaunchError]=useState<string|null>(shellPreferenceLoad.error);
  const [terminalProfileCollection]=useState(()=>{const collection=new TerminalProfileCollection({getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)});collection.load();return collection;});
  const [,setTerminalProfileRevision]=useState(0);
  const [sshOpen,setSshOpen]=useState(false);
  const [sshError,setSshError]=useState<string|null>(null);
  const [terminalProfilesOpen,setTerminalProfilesOpen]=useState(false);
  const [terminalProfileDraft,setTerminalProfileDraft]=useState<TerminalProfileDraft>(()=>({name:"",shell:shellLaunch===null?null:{...shellLaunch},cwd:{mode:"context",path:null},envRefs:{},appearance:null}));
  const [terminalProfileActionError,setTerminalProfileActionError]=useState<string|null>(null);
  function refreshTerminalProfileUi(){setTerminalProfileRevision(value=>value+1);}
  function newTerminalProfile(){terminalProfileCollection.select(null);setTerminalProfileDraft({name:"",shell:shellLaunchRef.current===null?null:{...shellLaunchRef.current},cwd:{mode:"context",path:null},envRefs:{},appearance:null});refreshTerminalProfileUi();}
  function selectTerminalProfile(id:string){try{terminalProfileCollection.select(id);const row=terminalProfileCollection.profiles.find(row=>row.id===id)!;setTerminalProfileDraft({name:row.name,shell:row.shell===null?null:{...row.shell},cwd:{...row.cwd},envRefs:Object.fromEntries(Object.entries(row.envRefs)),appearance:row.appearance===null?null:{...row.appearance}});}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}
  function saveTerminalProfile(){try{const row=terminalProfileCollection.save(terminalProfileDraft);setTerminalProfileDraft({name:row.name,shell:row.shell===null?null:{...row.shell},cwd:{...row.cwd},envRefs:Object.fromEntries(Object.entries(row.envRefs)),appearance:row.appearance===null?null:{...row.appearance}});setTerminalProfileActionError(null);setError(null);}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}
  function updateTerminalProfile(){try{const id=terminalProfileCollection.selectedId;if(id===null)throw Error("Selected terminal profile is unavailable.");const row=terminalProfileCollection.update(id,terminalProfileDraft);setTerminalProfileDraft({name:row.name,shell:row.shell===null?null:{...row.shell},cwd:{...row.cwd},envRefs:Object.fromEntries(Object.entries(row.envRefs)),appearance:row.appearance===null?null:{...row.appearance}});setTerminalProfileActionError(null);setError(null);}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}
  function duplicateTerminalProfile(){try{const id=terminalProfileCollection.selectedId;if(id===null)throw Error("Selected terminal profile is unavailable.");const row=terminalProfileCollection.duplicate(id);setTerminalProfileDraft({name:row.name,shell:row.shell===null?null:{...row.shell},cwd:{...row.cwd},envRefs:Object.fromEntries(Object.entries(row.envRefs)),appearance:row.appearance===null?null:{...row.appearance}});setTerminalProfileActionError(null);setError(null);}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}
  function deleteTerminalProfile(){try{const id=terminalProfileCollection.selectedId;if(id===null)throw Error("Selected terminal profile is unavailable.");terminalProfileCollection.delete(id);newTerminalProfile();setTerminalProfileActionError(null);setError(null);}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}
  function defaultTerminalProfile(id:string|null){try{terminalProfileCollection.setDefault(id);setTerminalProfileActionError(null);setError(null);}catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile operation failed.");}refreshTerminalProfileUi();}

  const [pastePreferenceLoad]=useState(()=>loadTerminalPaste(()=>localStorage.getItem("yam.terminal-paste.v1")));
  const [pasteMode,setPasteMode]=useState<TerminalPasteMode>(pastePreferenceLoad.mode);
  const pasteModeRef=useRef(pasteMode);pasteModeRef.current=pasteMode;
  const [pastePolicyError,setPastePolicyError]=useState<string|null>(pastePreferenceLoad.error);
  const [pasteSettingsOpen,setPasteSettingsOpen]=useState(false);
  const pastePending=useRef<PendingTerminalPaste<TerminalView,Terminal>|null>(null);
  const [pastePreview,setPastePreview]=useState<TerminalPasteText|null>(null);
  const pasteDialog=useRef<HTMLDialogElement>(null);
  function applyPastePolicy(mode:TerminalPasteMode){saveTerminalPaste((key,raw)=>localStorage.setItem(key,raw),mode);pasteModeRef.current=mode;setPasteMode(mode);setPastePolicyError(null);}
  const filePending=useRef<{id:string;view:TerminalView;instance:Terminal;buffer:Terminal["buffer"]["active"];identity:string;path:string;preview:TerminalFilePreviewData|null;selection:{dispose():void}|null}|null>(null);
  const fileJobBusy=useRef(false);
  const [fileBusy,setFileBusy]=useState(false);
  const [filePreview,setFilePreview]=useState<TerminalFilePreviewData|null>(null);
  const browserControls=useRef(new BrowserControls()),browserMounted=useRef(false);
  const [browserOpen,setBrowserOpen]=useState(false),[,setBrowserVersion]=useState(0);
  useEffect(()=>{browserMounted.current=true;browserControls.current.activate();return()=>{browserMounted.current=false;browserControls.current.dispose();};},[]);
  async function openBrowserDialog(){
    if(!isMainWindow)return;setBrowserOpen(true);const pending=browserControls.current.read(invoke);setBrowserVersion(value=>value+1);await pending;if(browserMounted.current)setBrowserVersion(value=>value+1);
  }
  async function browserAction(action:BrowserAction,url:string){
    if(!isMainWindow)return;const pending=browserControls.current.action(action,url,invoke);setBrowserVersion(value=>value+1);await pending;if(browserMounted.current)setBrowserVersion(value=>value+1);
  }
  function closeBrowserDialog(){setBrowserOpen(false);}
  const fileDialog=useRef<HTMLDialogElement>(null);
  const fileDropDialog=useRef<HTMLDialogElement>(null);
  const fileDropPending=useRef<{target:TerminalFileDropTarget<TerminalView,Terminal>;path:string;preview:TerminalFileDropContent|null;selection:{dispose():void}|null}|null>(null);
  const [fileDropPreview,setFileDropPreview]=useState<TerminalFileDropContent|null>(null);
  function terminalFileDropTarget(id:string,view:TerminalView):TerminalFileDropTarget<TerminalView,Terminal>{return {...terminalPasteTarget(id,view),slot:desktopWindow.slot,epoch:desktopWindow.epoch,generation:view.desktopGeneration};}
  function terminalFileDropCurrent(pending:NonNullable<typeof fileDropPending.current>,requirePending=true){
    const target=pending.target,view=target.view,layout=terminalLayoutRef.current,currentWindow=getWindowContext();
    return (!requirePending||fileDropPending.current===pending)&&target.slot===currentWindow.slot&&target.epoch===currentWindow.epoch&&terminalMounted.current&&terminalViews.current.get(target.sessionId)===view&&view.instance===target.instance&&sessionId.current===target.sessionId&&layout.panes[layout.focused]===target.sessionId&&terminalPaneVisible(target.sessionId)&&view.ready&&view.live&&view.availability!=="terminal_unavailable"&&!view.disposed&&!view.moving&&!view.attaching&&terminalPasteInputEligible(view,ownerConnectionAvailable.current.available)&&Number.isSafeInteger(target.epoch)&&target.epoch>0&&Number.isSafeInteger(target.generation)&&target.generation>0&&terminalWindowClaim(target.sessionId)===target.generation&&sameTerminalFileDropTarget(target,terminalFileDropTarget(target.sessionId,view))&&view.element.isConnected&&!view.element.inert&&view.element.style.visibility!=="hidden"&&view.instance.modes.mouseTrackingMode==="none"&&!terminalMoveOperationRef.current&&!terminalMoveTaskRef.current&&!terminalMoveIncomingRef.current&&!pastePending.current&&!filePending.current&&!Array.from(document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop')).some(node=>node!==fileDropDialog.current);
  }
  function cancelTerminalFileDrop(){const pending=fileDropPending.current;fileDropPending.current=null;pending?.selection?.dispose();fileDropDialog.current?.close();setFileDropPreview(null);}
  async function captureTerminalFileDrop(payload:unknown){
    if(!shortcutMac||!terminalMounted.current||fileJobBusy.current||fileDropPending.current)return;
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;if(!id||!view)return;
    const pending={target:terminalFileDropTarget(id,view),path:"",preview:null as TerminalFileDropContent|null,selection:null as {dispose():void}|null};
    if(!terminalFileDropCurrent(pending,false))return;
    try{const path=inspectTerminalFileDrop(payload,window.devicePixelRatio,view.element.getBoundingClientRect());if(path===null)return;pending.path=path;}catch{setError("Drop exactly one regular local file onto the active terminal.");return;}
    fileDropPending.current=pending;fileJobBusy.current=true;setFileBusy(true);
    try{pending.selection=view.instance.onSelectionChange(()=>{if(fileDropPending.current===pending)cancelTerminalFileDrop();});const reply=await invoke<unknown>("preview_terminal_file",{path:pending.path});if(!terminalFileDropCurrent(pending)){if(fileDropPending.current===pending)cancelTerminalFileDrop();return;}const preview=filePreviewReply(reply,pending.path);pending.preview={...preview,text:fileDropText(preview.canonical)};setFileDropPreview(pending.preview);}
    catch{if(fileDropPending.current===pending){cancelTerminalFileDrop();setError("Could not preview this regular file on this Mac.");}}
    finally{fileJobBusy.current=false;if(terminalMounted.current)setFileBusy(false);}
  }
  async function confirmTerminalFileDrop(){
    const pending=fileDropPending.current;if(!pending||fileJobBusy.current)return;
    if(!pending.preview||!terminalFileDropCurrent(pending)){cancelTerminalFileDrop();setError("File drop target changed. Nothing was inserted.");return;}
    fileJobBusy.current=true;setFileBusy(true);
    try{const reply=filePreviewReply(await invoke<unknown>("preview_terminal_file",{path:pending.path}),pending.path);if(!terminalFileDropCurrent(pending))return;if(reply.canonical!==pending.preview.canonical)throw Error("changed");const text=pending.preview.text;cancelTerminalFileDrop();pending.target.instance.focus();if(!terminalFileDropCurrent(pending,false)||!terminalHasInputFocus(pending.target.sessionId)){setError("The original terminal could not receive focus. Nothing was inserted.");return;}pending.target.instance.paste(text);}
    catch{if(fileDropPending.current===pending)cancelTerminalFileDrop();setError("The file path could not be inserted. Nothing was retried.");}
    finally{if(fileDropPending.current===pending&&!terminalFileDropCurrent(pending))cancelTerminalFileDrop();fileJobBusy.current=false;if(terminalMounted.current)setFileBusy(false);}
  }
  function subscribeTerminalFileDrop(){
    let active=true,unlisten:UnlistenFn|null=null;
    if(!shortcutMac)return()=>{};
    try{getCurrentWebview().listen<{paths:string[];position:{x:number;y:number}}>("tauri://drag-drop",event=>{if(active&&terminalMounted.current)void captureTerminalFileDrop({type:"drop",paths:event.payload.paths,position:event.payload.position});}).then(value=>{if(active)unlisten=value;else value();}).catch(()=>{if(active){active=false;setError("File drop listening is unavailable in this window.");}});}catch{active=false;setError("File drop listening is unavailable in this window.");}
    return()=>{active=false;unlisten?.();cancelTerminalFileDrop();};
  }
  useEffect(subscribeTerminalFileDrop,[]);
  useEffect(()=>{const pending=fileDropPending.current;if(pending&&!terminalFileDropCurrent(pending))cancelTerminalFileDrop();});
  function terminalFileIdentity(id:string,view:TerminalView):string|null{
    const layout=terminalLayoutRef.current;
    if(view.disposed||!view.ready||!view.instance.getSelectionPosition()||terminalViews.current.get(id)!==view||sessionId.current!==id||layout.panes[layout.focused]!==id||!terminalPaneVisible(id)||!view.element.isConnected||view.element.inert||view.element.style.visibility==="hidden"||!document.hasFocus()||view.instance.modes.mouseTrackingMode!=="none"||Array.from(document.querySelectorAll('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop')).some(node=>node!==fileDialog.current))return null;
    return JSON.stringify([desktopWindow.epoch,view.frameInstance,view.attachVersion,view.lifecycleRevision,view.frameRevision,view.viewportRevision,view.appearanceRevision,ownerConnectionAvailable.current.version,selectionVersion.current,layout.revision,layout.focused,layout.panes,view.instance.cols,view.instance.rows,view.instance.getSelection(),view.instance.getSelectionPosition()]);
  }
  function terminalFileCurrent(pending:NonNullable<typeof filePending.current>){return filePending.current===pending&&pending.view.instance===pending.instance&&pending.instance.buffer.active===pending.buffer&&terminalFileIdentity(pending.id,pending.view)===pending.identity;}
  function cancelTerminalFile(){const pending=filePending.current;filePending.current=null;pending?.selection?.dispose();fileDialog.current?.close();setFilePreview(null);}
  async function previewSelectedTerminalFile(){
    if(!shortcutMac||fileJobBusy.current||filePending.current)return;
    const id=sessionId.current,view=id?terminalViews.current.get(id):null;
    if(!id||!view)return;
    const identity=terminalFileIdentity(id,view);if(identity===null){setError("The selected terminal file is unavailable.");return;}
    let path:string;try{path=selectedFilePath(view.instance.getSelection());}catch(reason){setError(reason instanceof Error?reason.message:"The selected terminal file is invalid.");return;}
    const pending={id,view,instance:view.instance,buffer:view.instance.buffer.active,identity,path,preview:null as TerminalFilePreviewData|null,selection:null as {dispose():void}|null};
    filePending.current=pending;fileJobBusy.current=true;setFileBusy(true);
    try{pending.selection=view.instance.onSelectionChange(()=>{if(filePending.current===pending)cancelTerminalFile();});const reply=await invoke<unknown>("preview_terminal_file",{path});if(!terminalFileCurrent(pending)){if(filePending.current===pending)cancelTerminalFile();return;}pending.preview=filePreviewReply(reply,path);setFilePreview(pending.preview);}
    catch{if(filePending.current===pending){cancelTerminalFile();setError("Could not preview this regular file on this Mac.");}}
    finally{fileJobBusy.current=false;setFileBusy(false);}
  }
  async function confirmTerminalFile(){
    const pending=filePending.current;if(!pending||fileJobBusy.current)return;
    const valid=terminalFileCurrent(pending),preview=pending.preview;cancelTerminalFile();
    if(!valid||!preview){setError("The selected terminal file changed. Nothing was revealed.");return;}
    fileJobBusy.current=true;setFileBusy(true);
    try{await invoke("reveal_terminal_file",{path:pending.path,canonical:preview.canonical});}
    catch{setError("Could not show this regular file in Finder.");}
    finally{fileJobBusy.current=false;setFileBusy(false);}
  }
  useEffect(()=>{const pending=filePending.current;if(pending&&!terminalFileCurrent(pending))cancelTerminalFile();});
  useEffect(()=>()=>{const pending=filePending.current;filePending.current=null;pending?.selection?.dispose();},[]);
  function terminalLinkIdentity(id:string,view:TerminalView):string|null{if(view.disposed||terminalViews.current.get(id)!==view||!terminalPaneVisible(id)||!view.element.isConnected||view.element.inert||view.element.style.visibility==="hidden"||!document.hasFocus()||document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop'))return null;const layout=terminalLayoutRef.current;return JSON.stringify([view.frameInstance,view.attachVersion,view.lifecycleRevision,view.frameRevision,view.viewportRevision,view.appearanceRevision,ownerConnectionAvailable.current.version,selectionVersion.current,layout.revision,layout.focused,layout.panes,view.instance.cols,view.instance.rows]);}
  function terminalPasteTarget(id:string,view:TerminalView):TerminalPasteTarget<TerminalView,Terminal>{const layout=terminalLayoutRef.current;return{sessionId:id,view,instance:view.instance,frameInstance:view.frameInstance,attachVersion:view.attachVersion,lifecycleRevision:view.lifecycleRevision,connectionVersion:ownerConnectionAvailable.current.version,paneId:terminalPaneId(layout,layout.focused),selectionVersion:selectionVersion.current,layoutRevision:layout.revision};}
  function terminalPasteCurrent(pending:PendingTerminalPaste<TerminalView,Terminal>){const target=pending.target,view=terminalViews.current.get(target.sessionId),layout=terminalLayoutRef.current;return view===target.view&&sessionId.current===target.sessionId&&layout.panes[layout.focused]===target.sessionId&&terminalPaneVisible(target.sessionId)&&(terminalPasteInputEligible(target.view,ownerConnectionAvailable.current.available)||canContinueTerminalInput(target.sessionId,target.view))&&sameTerminalPasteTarget(target,terminalPasteTarget(target.sessionId,target.view));}
  function cancelTerminalPaste(restoreFocus=true){const pending=pastePending.current;pastePending.current=null;pasteDialog.current?.close();setPastePreview(null);if(restoreFocus&&pending&&terminalPasteCurrent(pending))pending.target.instance.focus();}
  async function fillReviewInOriginalTerminal(origin:ReviewOrigin,location:ReviewLocation,text:string){
    const view=terminalViews.current.get(origin.sessionId);
    if(!isMainWindow||!terminalMounted.current||!view||sessionId.current!==origin.sessionId)throw "review_target_unavailable";
    const target=terminalPasteTarget(origin.sessionId,view);
    try{
      await deliverReviewFeedback(origin,location,text,()=>invoke<SessionRecord>("get_session",{sessionId:origin.sessionId}),async formatted=>{
        const pending={target,content:inspectTerminalPaste(formatted)};
        const eligible=()=>terminalMounted.current&&terminalPasteCurrent(pending)&&view.ready&&!view.moving&&!view.persisted&&!view.attaching&&!view.parsing&&!view.projecting&&!view.resizing&&!view.clearPending&&view.instance.modes.bracketedPasteMode;
        if(!eligible()||view.inputQueue?.write||view.inputQueue?.count||view.inputQueue?.length||pastePending.current||fileDropPending.current)throw "review_target_unavailable";
        setProjectToolsOpen(false);view.instance.focus();
        if(!eligible()||!terminalHasInputFocus(origin.sessionId))throw "review_target_unavailable";
        const version=view.inputQueue?.version??0;
        view.instance.paste(pending.content.text);
        const write=view.inputQueue?.write;if(!write)throw "review_delivery_unknown";
        try{await write;}catch{throw "review_delivery_unknown";}
        if(!terminalPasteCurrent(pending)||view.inputQueue?.version!==version||!view.writable)throw "review_delivery_unknown";
        setTerminalNotice("Feedback was filled into the original CLI. Check the input and press Enter there to submit.");
      });
    }catch(reason){setError(reason==="review_target_unavailable"?"The original CLI cannot receive this feedback now. Nothing was filled.":reason==="review_invalid_feedback"?"Choose a diff location and use up to 16 KiB of text without terminal controls.":"Delivery could not be confirmed. Check the original terminal before retrying.");throw reason;}
  }
  function confirmTerminalPaste(){const pending=pastePending.current;pastePending.current=null;if(!pending)return;pasteDialog.current?.close();setPastePreview(null);if(!terminalPasteCurrent(pending)){setError("Paste target changed or is unavailable. Nothing was sent.");return;}pending.target.instance.focus();if(!terminalPasteCurrent(pending)||!terminalHasInputFocus(pending.target.sessionId)){setError("The original terminal could not receive focus. Nothing was sent.");return;}if(canContinueTerminalInput(pending.target.sessionId,pending.target.view))continueTerminalInput(pending.target.sessionId,pending.target.view,pending.content.text,true);else pending.target.instance.paste(pending.content.text);}
  function validatePendingTerminalPaste(){const pending=pastePending.current;if(pending&&!terminalPasteCurrent(pending))cancelTerminalPaste(false);}
  function captureTerminalPaste(id:string,view:TerminalView,event:ClipboardEvent){
    if(event.target!==view.instance.textarea||!event.clipboardData||!Array.from(event.clipboardData.types).includes("text/plain"))return;
    const stop=()=>{event.preventDefault();event.stopImmediatePropagation();};
    if(pastePending.current){stop();setError("Confirm or cancel the current paste preview first.");return;}
    if(!(terminalPasteInputEligible(view,ownerConnectionAvailable.current.available)||canContinueTerminalInput(id,view))||!terminalHasInputFocus(id)){stop();setError("This terminal cannot receive pasted text. Nothing was sent.");return;}
    let text:string;try{text=event.clipboardData.getData("text/plain");}catch{stop();setError("Pasted text is invalid. Nothing was sent.");return;}
    let content:TerminalPasteText;try{content=inspectTerminalPaste(text);}catch(reason){stop();setError(reason instanceof Error?reason.message:"Pasted text is invalid. Nothing was sent.");return;}
    if(content.text===""){stop();return;}
    if(pasteModeRef.current==="never"||(pasteModeRef.current==="risky"&&!content.risky)){if(canContinueTerminalInput(id,view)){stop();continueTerminalInput(id,view,content.text,true);}return;}
    stop();pastePending.current={target:terminalPasteTarget(id,view),content};setPastePreview(content);
  }
  useEffect(()=>{validatePendingTerminalPaste();});

  function readTerminalSystemTheme():"dark"|"light"{try{return typeof window.matchMedia==="function"&&window.matchMedia("(prefers-color-scheme: dark)").matches===false?"light":"dark";}catch{return "dark";}}
  const [initialTerminalSystemTheme]=useState(readTerminalSystemTheme);
  const terminalSystemThemeRef=useRef(initialTerminalSystemTheme);
  function applyTerminalSystemTheme(theme:"dark"|"light"){
    if(terminalSystemThemeRef.current===theme)return;
    terminalSystemThemeRef.current=theme;
    for(const view of terminalViews.current.all){if(!view.disposed&&view.appearance.theme==="system")view.instance.options.theme=terminalOptions(view.appearance,theme).theme;}
  }
  function subscribeTerminalSystemTheme(){
    let active=true,query:MediaQueryList|null=null;
    const cleanup=()=>{active=false;try{query?.removeEventListener("change",changed);}catch{/* unavailable platform cleanup remains safe */}query=null;};
    const changed=()=>{if(!active||!query)return;try{applyTerminalSystemTheme(query.matches===false?"light":"dark");}catch{cleanup();applyTerminalSystemTheme("dark");}};
    try{if(typeof window.matchMedia!=="function")throw Error("media unavailable");query=window.matchMedia("(prefers-color-scheme: dark)");if(typeof query.addEventListener!=="function"||typeof query.removeEventListener!=="function")throw Error("media subscription unavailable");query.addEventListener("change",changed);changed();}
    catch{cleanup();applyTerminalSystemTheme("dark");}
    return cleanup;
  }
  useEffect(()=>subscribeTerminalSystemTheme(),[]);
  const [terminalRetentionLoad]=useState(()=>loadTerminalRetention(()=>localStorage.getItem("yam.terminalRetention.v1")));
  const [terminalRetention,setTerminalRetention]=useState(terminalRetentionLoad.retention);
  const terminalRetentionRef=useRef(terminalRetention);terminalRetentionRef.current=terminalRetention;
  const [terminalRetentionError,setTerminalRetentionError]=useState<string|null>(terminalRetentionLoad.error);
  const [terminalLineHeightLoad]=useState(()=>loadTerminalLineHeight(()=>localStorage.getItem("yam.terminalLineHeight.v1")));
  const [terminalLineHeight,setTerminalLineHeight]=useState(terminalLineHeightLoad.lineHeight);
  const terminalLineHeightRef=useRef(terminalLineHeight);terminalLineHeightRef.current=terminalLineHeight;
  const [terminalLineHeightError,setTerminalLineHeightError]=useState<string|null>(terminalLineHeightLoad.error);
  const [terminalCursorLoad]=useState(()=>loadTerminalCursor(()=>localStorage.getItem("yam.terminalCursor.v1")));
  const [terminalCursor,setTerminalCursor]=useState(terminalCursorLoad.cursor);
  const terminalCursorRef=useRef(terminalCursor);terminalCursorRef.current=terminalCursor;
  const [terminalCursorError,setTerminalCursorError]=useState<string|null>(terminalCursorLoad.error);
  const [terminalPreferenceLoad]=useState(()=>loadTerminalSettings(()=>localStorage.getItem("yam.terminalSettings")));
  const [terminalSettings,setTerminalSettings]=useState<TerminalSettings>(terminalPreferenceLoad.settings);
  const terminalSettingsRef=useRef(terminalSettings);terminalSettingsRef.current=terminalSettings;
  const [terminalSettingsError,setTerminalSettingsError]=useState<string|null>(terminalPreferenceLoad.error);
  const [terminalSettingsOpen,setTerminalSettingsOpen]=useState(false);
  const [appearanceOpen,setAppearanceOpen]=useState(false);
  const [appPreferenceLoad]=useState(()=>loadAppPreferences(()=>localStorage.getItem(APP_PREFERENCES_KEY)));
  const [appPreferences,setAppPreferences]=useState(appPreferenceLoad.value);
  const [appPreferenceError,setAppPreferenceError]=useState(appPreferenceLoad.error);
  function applyAppPreferences(next:AppPreferences,persist=true){
    if(persist)saveAppPreferences(next,raw=>localStorage.setItem(APP_PREFERENCES_KEY,raw));
    setAppPreferences({...next});setAppPreferenceError(null);
    setLocale(resolveLocale(next.language,navigator.languages));
  }
  useEffect(()=>{const changed=()=>setLocale(resolveLocale(appPreferences.language,navigator.languages));changed();window.addEventListener("languagechange",changed);return()=>window.removeEventListener("languagechange",changed);},[appPreferences.language]);
  useEffect(()=>{
    let active=true;let media:MediaQueryList|undefined;
    const refresh=()=>{if(!active)return;const theme=applyAppThemeDocument(appPreferences,media?.matches!==false,document.documentElement);applyAppTerminalTheme(terminalViews.current.all,theme);void nativeInvoke("native_menu_labels",{labels:nativeMenuLabels(shortcutsRef.current,shortcutMac),locale:i18n.language,theme:appPreferences.theme==="system"?"system":theme==="light"?"light":"dark"}).catch(()=>setAppPreferenceError("Window appearance could not be updated. Try again."));};
    try{media=window.matchMedia("(prefers-color-scheme: dark)");media.addEventListener("change",refresh);}catch{/* Deterministic dark fallback when OS appearance is unavailable. */}
    refresh();window.addEventListener("focus",refresh);return()=>{active=false;window.removeEventListener("focus",refresh);media?.removeEventListener?.("change",refresh);};
  },[appPreferences]);



  const notificationLocaleFlight=useRef(Promise.resolve());
  useEffect(()=>{
    if(!isMainWindow)return;
    let active=true;const locale=i18n.language;
    const sync=()=>{notificationLocaleFlight.current=notificationLocaleFlight.current.catch(()=>{}).then(async()=>{if(active)await invoke<void>("set_notification_locale",{locale});}).catch(()=>{if(active)setAppPreferenceError("Notification language could not be updated. Try again.");});};
    sync();window.addEventListener("focus",sync);return()=>{active=false;window.removeEventListener("focus",sync);};
  },[i18n.language,ownerConnectionAvailable.current.version]);

  const [paletteOpen,setPaletteOpen]=useState(false);
  const [paletteQuery,setPaletteQuery]=useState("");
  const paletteVersion=useRef(0);
  const paletteClearIntent=useRef<{id:string;view:TerminalView;instance:Terminal;epoch:number;generation:number|undefined;parser:string|null;attachment:number|undefined;lifecycle:number;selection:number;owner:number;version:number}|null>(null);
  useEffect(()=>()=>{paletteClearIntent.current=null;},[]);
  const [pinnedSessions,setPinnedSessions]=useState<string[]>(()=>readPreference("yam.pinnedSessions",[],isPinnedSessions));
  const pinnedSessionsRef=useRef(pinnedSessions);pinnedSessionsRef.current=pinnedSessions;
  const createView = useRef<((id: string,appearance?:TerminalSettings) => TerminalView) | null>(null);
  const creatingSession = useRef(false);
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const sessionId = useRef<string | null>(null);
  const previousSession = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pendingOutput = useRef(new OutputBuffer());
  const outputCursor = useRef<number | null>(null);
  const selectedRecord = useRef<SessionRecord | null>(null);
  const pendingState = useRef(new Map<string, SessionStateEvent>());
  const agentOutputWindow = useRef("");
  const notifications = useRef(new NotificationQueue());
  const retryNotifications = useRef(new Map<string, SessionStateEvent>());
  const launchDialog = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);
  const renameTarget=useRef<string|null>(null),sessionCopyIntent=useRef(0);
  const [sessionCopy,setSessionCopy]=useState<ReturnType<typeof duplicateSessionDraft>|null>(null);
  const [copyName,setCopyName]=useState("");
  const ordinaryLaunchSnapshot=useRef<SessionLaunchSettings["ordinary"]>(undefined);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const projectDialog = useRef<HTMLDialogElement>(null);
  const selectionVersion = useRef(0);
  const historyRefreshVersion = useRef(0);
  const deletionReceiptKey = useRef("");
  const attentionOperation = useRef(0);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [terminalNotice, setTerminalNotice] = useState<string | null>(null);
  const [,setRecoveryRevision]=useState(0);
  const [error, setError] = useState<string | null>(()=>desktopWindow.conflict?"A saved session belonged to both windows. Main keeps it.":null);
  const notificationTestBusy=useRef(false);
  const [notificationTestStatus,setNotificationTestStatus]=useState<string|null>(null);
  async function testNotification(){
    const id=sessionId.current;if(!id||notificationTestBusy.current)return;
    notificationTestBusy.current=true;setNotificationTestStatus("Sending test notification…");
    try{await invoke("test_notification",{sessionId:id});setNotificationTestStatus("System accepted the test notification. If no banner appears, check Focus and screen-sharing notification settings.");}
    catch{setNotificationTestStatus("Notification test failed. Check system notification permission and try again.");}
    finally{notificationTestBusy.current=false;}
  }
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [launchDirectoryOverride,setLaunchDirectoryOverride]=useState<string|undefined>(undefined);
  const [launchTerminalProfile,setLaunchTerminalProfile]=useState<string|null|undefined>(undefined);
  const [launchWorktreeAttempt,setLaunchWorktreeAttempt]=useState<string|undefined>(undefined);
  const [launchDraft,setLaunchDraft]=useState<LaunchDefaults>({adapter:"codex",mode:"interactive",extra_args:"",prompt:null,command:null,provider:null});
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);
  const [globalLaunchDefaults,setGlobalLaunchDefaults]=useState<LaunchDefaults>(launchDraft);
  const launchSettingsDialog=useRef<HTMLDialogElement>(null);
  const [projectToolsPath,setProjectToolsPath]=useState("");
  const [projectToolsOpen,setProjectToolsOpen]=useState(false);
  const projectToolsOpenRef=useRef(projectToolsOpen);projectToolsOpenRef.current=projectToolsOpen;
  const [projectToolsTab,setProjectToolsTab]=useState<"files"|"changes"|"worktrees">("changes");
  function closeProjectTools(){
    const id=sessionId.current,origin=document.activeElement;projectToolsOpenRef.current=false;setProjectToolsOpen(false);
    requestAnimationFrame(()=>{requestTerminalLayoutFit();if(!projectToolsOpenRef.current&&sessionId.current===id&&(document.activeElement===origin||document.activeElement===document.body)&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')){showConversation(false);focusTerminalPane(terminalLayoutRef.current.focused,true);}});
  }
  const projectFileSequence=useRef(0);
  const [projectFileRequest,setProjectFileRequest]=useState<ProjectFileRequest|null>(null);
  const [reviewLocation,setReviewLocation]=useState<ReviewLocation|null>(null);
  function diffProjectPath(target:DiffTarget):string|null{
    if(!session||session.ssh||sessionId.current!==target.sessionId||session.session_id!==target.sessionId)return null;
    const path=relativeProjectFile(session.cwd,target.absolutePath);
    if(!path)setError("This file is outside the selected session project. Open it from the local file list instead.");
    return path;
  }
  function openDiffFile(target:DiffTarget){const path=diffProjectPath(target);if(path){setProjectToolsTab("files");setProjectFileRequest({id:++projectFileSequence.current,sessionId:target.sessionId,path,line:target.side==="new"&&target.basis!=="staged"?target.line:null});}}
  function reviewDiffFile(target:DiffTarget){const path=diffProjectPath(target);if(path){setProjectToolsTab("changes");setReviewLocation({sessionId:target.sessionId,path,line:target.line,side:target.side,basis:target.basis});}}

  const [launchDefaultsNotice,setLaunchDefaultsNotice]=useState<string|null>(null);
  const projectSelection=useRef(new ProjectConfigSelection());
  const projectConfigVersion=useRef(0);
  const [projectPreview,setProjectPreview]=useState<ProjectPreview|null>(null);
  const [projectLaunchEdits,setProjectLaunchEdits]=useState<Partial<LaunchDefaults>>({});
  const [projectTemplate,setProjectTemplate]=useState("");
  const [useProjectSettings,setUseProjectSettings]=useState(false);
  const [projectConfigBusy,setProjectConfigBusy]=useState(false);
  const [projectConfigError,setProjectConfigError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void invoke<Partial<LaunchDefaults>>("get_launch_defaults").then(value=>{const next={adapter:"codex",mode:"interactive",extra_args:"",prompt:null,command:null,...value};if(!isLaunchDefaults(next))throw Error("Invalid application launch defaults");if(active)setGlobalLaunchDefaults(next);}).catch(reason=>{if(active)setProjectConfigError(`Launch defaults unavailable: ${String(reason)}`);});return()=>{active=false;projectConfigVersion.current++;projectSelection.current.cancel();};},[]);
  useEffect(()=>{projectConfigVersion.current++;projectSelection.current.cancel();setProjectPreview(null);setUseProjectSettings(false);setProjectTemplate("");setProjectConfigBusy(false);},[cwd]);
  const projectDefaults=projectPreview?.config?{...projectPreview.config.defaults,...projectPreview.config.templates?.find(item=>item.name===projectTemplate)}:null;
  const formLaunch={...(useProjectSettings&&projectPreview?.trusted?resolveLaunchDefaults(globalLaunchDefaults,projectDefaults,projectLaunchEdits):launchDraft),mode:"interactive"};
  const [piValidation,setPiValidation]=useState({valid:false,scope:""});
  const piFormValid=piValidation.valid&&piValidation.scope===JSON.stringify([cwd,formLaunch.extra_args]);
  const formAdapter=formLaunch.adapter==="custom"?"shell":formLaunch.adapter;
  const selectedAdapter=formAdapter,command=formLaunch.command??"",prompt=formLaunch.prompt??"",adapterArgs=formLaunch.extra_args,providerConfig=formLaunch.provider??null;
  function editLaunch(fields:Partial<LaunchDefaults>){
    if(fields.adapter&&fields.adapter!=="codex"&&formLaunch.codex)fields={...fields,codex:undefined};
    setLaunchDraft(()=>({...formLaunch,...fields}));
    setProjectLaunchEdits(previous=>({...previous,...fields}));
  }
  const [sessionTerminal,setSessionTerminal]=useState("yam");
  const [installedTerminals,setInstalledTerminals]=useState<string[]>([]);
  useEffect(()=>{let active=true;void invoke<string[]>("list_external_terminals").then(value=>{
    if(active&&Array.isArray(value)&&value.every(id=>["terminal","iterm2"].includes(id)))setInstalledTerminals(value);
  }).catch(()=>{});return()=>{active=false;};},[]);
  const [terminalFonts,setTerminalFonts]=useState<string[]>(fontPresets),[fontCatalogError,setFontCatalogError]=useState<string|null>(null);
  useEffect(()=>{if(!terminalSettingsOpen&&!terminalProfilesOpen)return;let active=true;void terminalFontCatalog(invoke).then(result=>{if(active){setTerminalFonts(result.fonts);setFontCatalogError(result.error);}});return()=>{active=false;};},[terminalSettingsOpen,terminalProfilesOpen]);
  const [installedGateways,setInstalledGateways]=useState<string[]>([]);
  const [gatewayDiscoveryError,setGatewayDiscoveryError]=useState(false);
  useEffect(()=>{let active=true;void invoke<string[]>("list_local_gateways").then(value=>{
    if(!Array.isArray(value)||value.some(id=>!["magpie","cc-switch","echobird"].includes(id)))throw Error("Invalid local gateway discovery");
    if(active)setInstalledGateways(value);
  }).catch(()=>{if(active)setGatewayDiscoveryError(true);});return()=>{active=false;};},[]);
  function changeProvider(value:string) {
    const provider=value==="inherited"?null:providerPreset(value==="isolated"?"custom":value,formAdapter).provider;
    if(provider&&!supportsProvider(formAdapter,provider)){setError("This connection does not support the selected CLI. Choose a compatible preset.");return;}
    editLaunch({provider,...(!provider?{codex:formAdapter==="codex"?{image_mode:"native"}:undefined}:{})});
  }
  function changeProviderFields(fields:Partial<ProviderConfig>) {
    const current=formLaunch.provider;if(!current)return;
    editLaunch({provider:{...current,...fields}});
  }
  function changeAdapter(adapter:string) {
    const current=formLaunch.provider;
    if(current&&!supportsProvider(adapter,current)){setError("Use existing CLI configuration before switching to an incompatible CLI.");return;}
    const gateway=current?.id==="custom"?providerChoice(formAdapter,current):null;
    if(gateway==="echobird"&&adapter==="gemini"){setError("EchoBird does not provide a native Gemini API preset. Use existing CLI configuration or configure a compatible gateway before switching.");return;}
    let provider=current;
    if(adapter!==formAdapter&&current&&["cc-switch","echobird"].includes(gateway??"")){
      const next=providerPreset(gateway!,adapter).provider;
      if(next)provider={...current,base_url:next.base_url};
    }
    if(adapter!==formAdapter&&current?.id==='deepseek'&&['codex','claude'].includes(formAdapter)&&['codex','claude'].includes(adapter)){
      const from=providerPreset(formAdapter==='claude'?'deepseek-claude':'deepseek').provider;
      const to=providerPreset(adapter==='claude'?'deepseek-claude':'deepseek').provider;
      if(current.base_url===from?.base_url&&to)provider={...current,base_url:to.base_url};
    }
    editLaunch({adapter,...(provider!==current?{provider}:{}),...(adapter!=="shell"&&formAdapter==="shell"?{command:null}:{}),...(adapter!==formAdapter&&(adapter==="pi"||formAdapter==="pi")?{extra_args:adapter==="pi"?"--yam-gateway http://127.0.0.1:3425 --yam-small yam-gateway/codex/gpt-6-luna --yam-strong yam-gateway/codex/gpt-6.1-sol":""}:{})});
    if(adapter!==formAdapter&&!useProjectSettings&&!launchWorktreeAttempt&&launchDirectoryOverride===undefined){
      try{setCwd(adapter==="shell"?terminalDirectory(undefined,launchTerminalProfile):currentProject?.path||session?.cwd||activeProject||"");}
      catch(reason){setError(reason instanceof Error?reason.message:"Terminal profile is unavailable.");}
    }
  }
  const [launchTemplateCollection]=useState(()=>{const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)};const collection=new LaunchTemplateCollection(storage);collection.load();return collection;});
  const [,setLaunchTemplateRevision]=useState(0);
  const [launchTemplateName,setLaunchTemplateName]=useState("");
  const [connectionName,setConnectionName]=useState("");
  function saveConnection(){if(!isMainWindow||!formLaunch.provider)return;try{launchTemplateCollection.save(connectionName,connectionTemplate(formAdapter,formLaunch.provider));setConnectionName("");setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  const [launchTemplateActionError,setLaunchTemplateActionError]=useState<string|null>(null);
  function refreshLaunchTemplateUi(){setLaunchTemplateRevision(revision=>revision+1);}
  function handleLaunchTemplateError(reason:unknown){setLaunchTemplateActionError(launchTemplateCollection.writeError?null:String(reason));refreshLaunchTemplateUi();}
  function selectLaunchTemplate(id:string){launchTemplateCollection.select(id);refreshLaunchTemplateUi();}
  function saveLaunchTemplate(){if(!isMainWindow){openMainSettings();return;}try{launchTemplateCollection.save(launchTemplateName,formLaunch);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function updateLaunchTemplate(){if(!isMainWindow){openMainSettings();return;}const id=launchTemplateCollection.selectedId;if(!id)return;try{launchTemplateCollection.update(id,launchTemplateName,formLaunch);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function duplicateLaunchTemplate(){if(!isMainWindow){openMainSettings();return;}const id=launchTemplateCollection.selectedId;if(!id)return;try{const copy=launchTemplateCollection.duplicate(id);setLaunchTemplateName(copy.name);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function deleteLaunchTemplate(){if(!isMainWindow){openMainSettings();return;}const id=launchTemplateCollection.selectedId;if(!id)return;try{launchTemplateCollection.delete(id);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  async function copyOriginalLaunchTemplates(){
    if(!isMainWindow||launchTemplateCollection.rawStorage===null)return;
    try{await navigator.clipboard.writeText(launchTemplateCollection.rawStorage);setLaunchTemplateActionError(null);}
    catch{setLaunchTemplateActionError("Could not copy original launch templates. Original data has not been changed.");}
    refreshLaunchTemplateUi();
  }
  async function resetLaunchTemplates(){
    if(!isMainWindow)return;
    try{
      if(await invoke<boolean>("confirm_template_reset")!==true)return;
      launchTemplateCollection.reset();setLaunchTemplateActionError(null);refreshLaunchTemplateUi();
    }catch(reason){handleLaunchTemplateError(reason);}
  }
  function cancelProjectPreview(){projectConfigVersion.current++;projectSelection.current.cancel();setProjectPreview(null);setUseProjectSettings(false);setProjectConfigBusy(false);setProjectConfigError(null);}
  async function readProjectConfig(){
    const version=++projectConfigVersion.current;
    setProjectConfigBusy(true);setProjectConfigError(null);setProjectPreview(null);setUseProjectSettings(false);
    try{await projectSelection.current.load(()=>invoke<ProjectPreview>("preview_project_config",{cwd:cwd.trim()}));if(version!==projectConfigVersion.current)return;const next=projectSelection.current.preview;if(next){setProjectPreview(next);setUseProjectSettings(next.config!==null);setProjectTemplate("");}}
    catch(reason){if(version===projectConfigVersion.current)setProjectConfigError(String(reason));}finally{if(version===projectConfigVersion.current)setProjectConfigBusy(false);}
  }
  async function approveProjectConfig(){
    const version=++projectConfigVersion.current;
    setProjectConfigBusy(true);setProjectConfigError(null);
    try{await projectSelection.current.approve(preview=>invoke<ProjectPreview>("trust_project_config",{cwd:preview.root,preview}));if(version===projectConfigVersion.current)setProjectPreview(projectSelection.current.preview);}
    catch(reason){if(version===projectConfigVersion.current)setProjectConfigError(String(reason));}finally{if(version===projectConfigVersion.current)setProjectConfigBusy(false);}
  }
  async function saveLaunchDefaults(){if(!isMainWindow){openMainSettings();return;}try{const defaults=projectLaunchFields(formLaunch);await invoke("set_launch_defaults",{defaults});setGlobalLaunchDefaults(defaults);try{localStorage.setItem("yam.lastSessionCli",JSON.stringify(defaults.adapter==="custom"?"shell":defaults.adapter));setLaunchDefaultsNotice("Defaults saved for new sessions.");}catch{setLaunchDefaultsNotice("Defaults saved, but the last CLI choice could not be updated.");}}catch(reason){setLaunchDefaultsNotice(String(reason));}}

  const [session, setSession] = useState<SessionSummary | null>(null);
  const [sessionStatus, setSessionStatus] = useState("idle");
  const [agentPhase, setAgentPhase] = useState<AgentPhase>("idle");
  const [starting, setStarting] = useState(false);
  const worktreeContextRef=useRef({root:"",owner:0});
  const [selectedWorktree, setSelectedWorktree] = useState<import("./worktree-controls").ManagedWorktree | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyCursor,setHistoryCursor]=useState<HistoryCursor|null>(null);
  const [historyOverview,setHistoryOverview]=useState<HistoryOverview>({total:0,active:0,unread_receipts:0,failed_receipts:0,attention_sessions:0,metadata_bytes:null});
  const [historyLoading,setHistoryLoading]=useState(false);
  const [inbox,setInbox]=useState<InboxItem[]>([]);
  const [inboxCursor,setInboxCursor]=useState<HistoryCursor|null>(null);
  const inboxVersion=useRef(0);
  const inboxLoading=useRef(false);
  const pendingLoading=useRef(false);
  const [selectedAgent,setSelectedAgent]=useState<AgentState|undefined>();
  const detailVersion=useRef(0);
  const capacityVersion=useRef(0);
  const [archiveOpen,setArchiveOpen]=useState(false);
  const [capacityOpen,setCapacityOpen]=useState(false);
  const capacityDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(capacityOpen)capacityDialog.current?.showModal();},[capacityOpen]);
  const [capacity,setCapacity]=useState<HistoryCapacity|null>(null);
  const [capacityBusy,setCapacityBusy]=useState(false);
  const [capacityError,setCapacityError]=useState<string|null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [logSearchOpen,setLogSearchOpen]=useState(false);
  const [logExportOpen,setLogExportOpen]=useState(false);
  const diagnosticsBusy=useRef(false);
  const [diagnosticsExporting,setDiagnosticsExporting]=useState(false);
  const [diagnosticsMessage,setDiagnosticsMessage]=useState<string|null>(null);
  const [inboxOpen,setInboxOpen]=useState(false);
  const shortcutMac=/Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const [shortcutLoad]=useState(()=>loadAppShortcuts(key=>localStorage.getItem(key),shortcutMac));
  const [shortcuts,setShortcuts]=useState<AppShortcuts>(shortcutLoad.bindings);
  const shortcutsRef=useRef(shortcuts);
  const [shortcutError,setShortcutError]=useState<string|null>(shortcutLoad.error);
  const [keyboardShortcutsOpen,setKeyboardShortcutsOpen]=useState(false);
  function saveKeyboardShortcuts(draft:AppShortcuts){const next=saveAppShortcuts(draft,shortcutMac,(key,raw)=>localStorage.setItem(key,raw));shortcutsRef.current=next;setShortcuts(next);setShortcutError(null);setKeyboardShortcutsOpen(false);}
  const [notificationsPaused,setNotificationsPaused]=useState(()=>readPreference("yam.notificationsPaused",false,(value):value is boolean=>typeof value==="boolean"));
  const pausedRef=useRef(notificationsPaused);pausedRef.current=notificationsPaused;
  const notificationPause=useRef(new SystemEntryController());
  const notificationPauseState=useRef<NotificationPauseState|null>(null);
  const notificationPauseVersion=useRef(0);
  const systemEntryVersion=useRef(0);
  const systemEntryMutation=useRef(0);
  const [systemEntryOpen,setSystemEntryOpen]=useState(false);
  const systemEntryDialog=useRef<HTMLDialogElement>(null);
  useEffect(()=>{if(systemEntryOpen)systemEntryDialog.current?.showModal();},[systemEntryOpen]);
  const [systemEntryBusy,setSystemEntryBusy]=useState(false);
  const [systemEntry,setSystemEntry]=useState({global_shortcut_enabled:false,global_shortcut_registered:false,shortcut_available:false,tray_available:false,warning:"",owner_instance:""});

  const [projects, setProjects] = useState<Project[]>(() =>
    readPreference("yam.projects", [], isProjects),
  );
  const projectsRef=useRef(projects);projectsRef.current=projects;
  const projectDragRef=useRef<{path:string;projects:Project[]}|null>(null);
  const projectRenameRef=useRef<{key:string;path:string;name:string;color?:Project["color"];icon?:Project["icon"]}|null>(null);
  const projectRenameDialog=useRef<HTMLDialogElement>(null);
  const [projectRename,setProjectRename]=useState<{key:string;path:string;name:string;color?:Project["color"];icon?:Project["icon"]}|null>(null);
  const [renameProjectName,setRenameProjectName]=useState("");
  const [renameProjectColor,setRenameProjectColor]=useState("");
  const [renameProjectIcon,setRenameProjectIcon]=useState("");
  const [projectRenameError,setProjectRenameError]=useState<string|null>(null);
  useEffect(()=>()=>{projectRenameRef.current=null;},[]);
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try{const raw=readWindowPreference(localStorage,desktopWindow.slot,"sidebar");const value=raw===null?true:JSON.parse(raw);return typeof value==="boolean"?value:true;}catch{return true;}
  });
  const [collapsedProjects, setCollapsedProjects] = useState(new Set<string>());
  const gitPolling = useRef(new GitContextPolling());
  const [gitOwner, setGitOwner] = useState(0);
  const [gitContext, setGitContext] = useState<{path:string;owner:number;value:GitContext}|null>(null);
  useEffect(() => {
    let active = true;
    const disposers: UnlistenFn[] = [];
    const register = (name:string) => void listen(name, () => {
      if (active) setGitOwner(owner => owner + 1);
    }).then(dispose => { if (active) disposers.push(dispose); else dispose(); });
    register("background-gap");
    void listen<{session_id:string}>("session-error", event => {
      if (active && event.payload.session_id === "") setGitOwner(owner => owner + 1);
    }).then(dispose => { if (active) disposers.push(dispose); else dispose(); });
    return () => { active = false; disposers.forEach(dispose => dispose()); gitPolling.current.cancel(); };
  }, []);
  const [activeProject, setActiveProject] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [sessionNamePreferences]=useState(()=>{
    const legacy=readPreference(
        "yam.sessionTitles",
        {},
        (value): value is Record<string, string> =>
          !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.values(value).every((item) => typeof item === "string"),
      );
    try{return{titles:loadSessionNames(window.localStorage,legacy),error:null};}
    catch{return{titles:legacy,error:"Saved session names are unavailable. Previous labels were preserved."};}
  });
  const [sessionTitles,setSessionTitles]=useState<Record<string,string>>(sessionNamePreferences.titles);
  useEffect(()=>{if(sessionNamePreferences.error)setError(sessionNamePreferences.error);},[]);

  const historyContext=useRef({query:historyQuery,status:statusFilter,titles:sessionTitles,projects});
  historyContext.current={query:historyQuery,status:statusFilter,titles:sessionTitles,projects};
  const titlesRef = useRef(sessionTitles);
  titlesRef.current = sessionTitles;

  const [memory, setMemory] = useState<MemorySample | null>(null);
  useEffect(() => startMemoryPolling(
    () => invoke<MemorySample>("memory_usage"), setMemory,
    () => document.visibilityState !== "hidden",
  ), []);

  const [terminalLayoutAppearanceRevision,setTerminalLayoutAppearanceRevision]=useState(0);
  useEffect(()=>{
    if(!layoutRestoreReady||desktopWindow.restore_blocked)return;
    const appearances:Record<string,TerminalSettings>={},recordedOnly:string[]=[];
    for(const id of terminalMembers(terminalLayoutRef.current)){
      const view=terminalViews.current.get(id),appearance=view&&!view.disposed?view.appearance:layoutPreferenceLoad.appearances?.[id];
      if(appearance)appearances[id]={fontFamily:appearance.fontFamily,fontSize:appearance.fontSize,theme:appearance.theme};
      if(view&&!view.disposed?view.recordedOnly:layoutPreferenceLoad.recordedOnly?.includes(id))recordedOnly.push(id);
    }
    const warning=saveTerminalLayout(terminalLayout,value=>localStorage.setItem(windowPreferenceKey("terminalLayout"),value),terminalLayout.root?.kind==="split"?terminalLayout.root.ratio:splitPercent,appearances,recordedOnly);
    if(warning)setError(warning);
  },[terminalLayout,splitPercent,layoutRestoreReady,terminalLayoutAppearanceRevision]);

  useEffect(()=>{
    if(session?.session_id) {try{localStorage.setItem(windowPreferenceKey("lastSession"),JSON.stringify(session.session_id));}catch(reason){setError(`Failed to save last session: ${String(reason)}`);}}
  },[session?.session_id]);

  useEffect(()=>{ syncNotificationContext(); },[session?.session_id,notificationsPaused]);

  useEffect(() => {
    try {
      localStorage.setItem(windowPreferenceKey("sidebar"), JSON.stringify(sidebarOpen));
      if(isMainWindow){localStorage.setItem("yam.sessionTitles", JSON.stringify(sessionTitles));}
    } catch (reason) {
      setError(`Failed to save project or session preferences: ${String(reason)}`);
    }
  }, [sidebarOpen, sessionTitles]);

  async function refreshSelectedAgent(valid=()=>true){
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!id||!view?.record||view.disposed||!terminalMounted.current||!ownerConnectionAvailable.current.available)return;
    const owner=ownerConnectionAvailable.current.version,attachment=view.attachVersion,selection=selectionVersion.current;
    const version=view.agentRefreshVersion=(view.agentRefreshVersion??0)+1;
    const current=()=>valid()&&terminalMounted.current&&ownerConnectionAvailable.current.available&&ownerConnectionAvailable.current.version===owner&&sessionId.current===id&&selectionVersion.current===selection&&terminalViews.current.get(id)===view&&!view.disposed&&view.attachVersion===attachment&&view.agentRefreshVersion===version;
    try{
      const record=await invoke<SessionRecord>("get_session",{sessionId:id});
      if(!current()||record?.summary.session_id!==id)return;
      view.record={...record,status:view.status??record.status};selectedRecord.current=view.record;setSession(record.summary);setSelectedAgent(record.agent);
    }catch{ /* The existing owner recovery controls handle unavailable metadata. */ }
  }
  async function refreshHistory(valid?:()=>boolean) {
    const version=++historyRefreshVersion.current;
    // Scoped receipt refresh takes over pending responses without owning a loading indicator.
    setHistoryLoading(!valid);
    try {
      const context=historyContext.current;
      const request=historyRequest(context.query,context.status,context.titles,context.projects);
      const [page,overview]=await Promise.all([invoke<HistoryPage<HistoryItem>>("list_session_summaries",{request}),invoke<HistoryOverview>("history_overview")]);
      if(version!==historyRefreshVersion.current||(valid&&!valid()))return;
      if(isMainWindow)for(const item of page.items)for(const previous of item.previous_runs??[])migrateTerminalMetadata(previous,item.summary.session_id);
      setHistory(page.items);setHistoryCursor(page.next_cursor);setHistoryOverview(overview);
      if(overview.latest_deletion?.deleted_ids.length){
        const receipt=overview.latest_deletion;
        const key=JSON.stringify([receipt.preview_id,receipt.deleted_ids]);
        if(key!==deletionReceiptKey.current){clearDeletedSessionNames(receipt.deleted_ids,false);deletionReceiptKey.current=key;}
      }
      if(valid)await refreshInbox(false,valid);else {void refreshInbox();void refreshPendingNotifications();}
      if(version!==historyRefreshVersion.current||(valid&&!valid()))return;
      await refreshSelectedAgent(()=>version===historyRefreshVersion.current&&(!valid||valid()));
    } catch (reason: unknown) {
      if(version===historyRefreshVersion.current&&(!valid||valid()))setError(reason instanceof Error?reason.message:String(reason));
    } finally {if(!valid&&version===historyRefreshVersion.current)setHistoryLoading(false);}
  }
  async function loadMoreHistory(){
    if(!historyCursor||historyLoading)return;
    const version=++historyRefreshVersion.current;setHistoryLoading(true);
    try {const page=await invoke<HistoryPage<HistoryItem>>("list_session_summaries",{request:historyRequest(historyContext.current.query,historyContext.current.status,historyContext.current.titles,historyContext.current.projects,historyCursor)});
      if(version!==historyRefreshVersion.current)return;
      if(isMainWindow)for(const item of page.items)for(const previous of item.previous_runs??[])migrateTerminalMetadata(previous,item.summary.session_id);
      setHistory(records=>[...records,...page.items]);setHistoryCursor(page.next_cursor);
    }catch(reason){if(version!==historyRefreshVersion.current)return;if(String(reason).includes("cursor expired")){setHistory([]);setHistoryCursor(null);void refreshHistory();}else setError(String(reason));}
    finally{if(version===historyRefreshVersion.current)setHistoryLoading(false);}
  }
  async function refreshInbox(more=false,valid?:()=>boolean){
    const version=++inboxVersion.current;inboxLoading.current=true;
    try{const page=await invoke<HistoryPage<InboxItem>>("list_unread_receipts",{request:{page_size:100,cursor:more?inboxCursor:null}});
      if(version!==inboxVersion.current||(valid&&!valid()))return;setInbox(items=>more?[...items,...page.items]:page.items);setInboxCursor(page.next_cursor);
    }catch(reason){if(version!==inboxVersion.current||(valid&&!valid()))return;if(more&&String(reason).includes("cursor expired"))void refreshInbox();else setError(String(reason));}
    finally{if(version===inboxVersion.current)inboxLoading.current=false;}
  }
  async function refreshPendingNotifications(){
    if(!isMainWindow)return;
    if(pendingLoading.current)return;pendingLoading.current=true;
    try{let afterKey:PendingKey|null=null;
      do{const page:{items:SessionStateEvent[];next_key:PendingKey|null}=await invoke<{items:SessionStateEvent[];next_key:PendingKey|null}>("list_pending_notifications",{limit:100,afterKey});
        for(const event of page.items)await notifySession(event);afterKey=page.next_key;
      }while(afterKey);
    }catch(reason){setNotificationError(String(reason));}finally{pendingLoading.current=false;}
  }
  async function openSession(id:string,onAttached?:(view:TerminalView,detail:number,intent:number)=>void,valid=()=>true,recordedOnly=false,pane?:string){
    cancelLayoutRestore();
    const version=++detailVersion.current,intent=layoutRestore.current.version;
    const current=()=>valid()&&version===detailVersion.current&&intent===layoutRestore.current.version;
    try {
      const record=await invoke<SessionRecord>("get_session",{sessionId:id});
      if(!current())return false;
      const inspect=recordedOnly||terminalStatuses.has(record.status);
      const receipt=inspect?await openHistory(record,false,pane,undefined,onAttached?valid:undefined,undefined,undefined,undefined,true):await openTerminal(record,pane,undefined,onAttached?valid:undefined);
      if(!receipt)return false;
      const {view,attachment,detail,intent:attachmentIntent}=receipt;
      const attachedId=view.record?.summary.session_id;
      if(!attachedId||!valid()||detail!==detailVersion.current||attachmentIntent!==layoutRestore.current.version||sessionId.current!==attachedId||terminalViews.current.get(attachedId)!==view||view.attachVersion!==attachment||view.disposed)return false;
      view.recordedOnly=inspect;
      onAttached?.(view,detail,attachmentIntent);
      return true;
    } catch(reason){if(current())setError(String(reason));return false;}
  }
  async function scanCapacity(){
    const version=++capacityVersion.current;setCapacityBusy(true);setCapacityError(null);
    try{const result=await invoke<HistoryCapacity>("scan_history_capacity");if(version===capacityVersion.current)setCapacity(result);}
    catch(reason){if(version===capacityVersion.current)setCapacityError(String(reason));}
    finally{if(version===capacityVersion.current)setCapacityBusy(false);}
  }
  async function cancelCapacity(){capacityVersion.current++;setCapacityBusy(false);try{await invoke("cancel_history_capacity");}catch(reason){setCapacityError(String(reason));}}

  async function exportDiagnostics() {
    if(diagnosticsBusy.current)return;
    diagnosticsBusy.current=true;setDiagnosticsExporting(true);setDiagnosticsMessage(null);
    try {
      const saved=await invoke<boolean>("export_diagnostics",{startup:startupTimings(performance.getEntriesByType("measure"))});
      setDiagnosticsMessage(saved?"Diagnostics saved.":"Export cancelled.");
    } catch(reason) {
      const messages:Record<string,string>={
        destination_exists:"File already exists. Choose a new file name.",
        destination_unwritable:"Cannot save diagnostics. Choose a writable folder.",
        size_limit:"Diagnostics exceeded the 1 MiB limit.",
        publish_failed:"Cannot publish diagnostics in this folder. Choose another folder.",
        cleanup_failed:"Diagnostics saved, but temporary file cleanup failed.",
      };
      setDiagnosticsMessage(typeof reason==="string"&&Object.prototype.hasOwnProperty.call(messages,reason)?messages[reason]:"Diagnostics export failed.");
    } finally {diagnosticsBusy.current=false;setDiagnosticsExporting(false);}
  }

  async function notifySession(event: SessionStateEvent) {
    if(!isMainWindow)return;
    if (!terminalStatuses.has(event.status) && event.status !== "idle_attention") return;
    if (terminalStatuses.has(event.status)) {
      for (const oldKey of discardAttentionRetries(retryNotifications.current, event.session_id))
        notifications.current.clearFailure(oldKey);
    }
    const key = `${event.session_id}:${event.status}`;
    const discardMissing=(reason:unknown)=>{
      if(!/^(?:Error: )?(?:Unknown notification session|Unknown session)$/.test(String(reason)))return false;
      retryNotifications.current.delete(key);notifications.current.clearFailure(key);notifications.current.suppress(key);
      if(!retryNotifications.current.size)setNotificationError(null);
      return true;
    };
    if(pausedRef.current){retryNotifications.current.set(key,event);return;}
    if (!notifications.current.canRetry(key)) return;
    if (terminalHasInputFocus(event.session_id)||await invoke<boolean>("terminal_input_focused",{sessionId:event.session_id})) {
      notifications.current.suppress(key);
      try { await invoke("acknowledge_notification", {sessionId: event.session_id, expectedStatus: event.status}); retryNotifications.current.delete(key); notifications.current.clearFailure(key); if (!retryNotifications.current.size) setNotificationError(null); }
      catch (reason) { if(!discardMissing(reason)){retryNotifications.current.set(key, event); setNotificationError(notifications.current.recordFailure(key, reason));} }
      return;
    }
    retryNotifications.current.set(key, event);
    try {
      const record = await invoke<SessionRecord>("get_session",{sessionId:event.session_id});
      if (pausedRef.current || !notifications.current.canRetry(key)) return;
      const superseded = event.status === "idle_attention" && record && terminalStatuses.has(record.status);
      const delivered = superseded || await notifications.current.deliver(key, async () => {
        const taskName = titlesRef.current[event.session_id] || record?.summary.launch?.adapter || "Session";
        const title = `${projectName(record?.summary.cwd ?? "")} · ${taskName} · ${t(statusLabels[event.status] ?? "Needs attention")}`.slice(0, 200);
        await invoke("notify_session", { sessionId: event.session_id, title, expectedStatus:event.status });
      }, event.session_id);
      if (delivered) {
        // Completion can arrive while the OS is sending the older attention request.
        // Do not consume the newer terminal receipt with that older request.
        const latest = event.status === "idle_attention" && !superseded
          ? await invoke<SessionRecord>("get_session",{sessionId:event.session_id})
          : record;
        if (!(event.status === "idle_attention" && latest && terminalStatuses.has(latest.status)))
          await invoke("acknowledge_notification", {sessionId: event.session_id, expectedStatus: event.status});
        retryNotifications.current.delete(key);
        notifications.current.clearFailure(key);
        if (!retryNotifications.current.size) setNotificationError(null);
      }
    } catch (reason) {
      if(discardMissing(reason))return;
      if (retryNotifications.current.has(key))
        setNotificationError(notifications.current.recordFailure(key, reason));
    }
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
        setLaunchDraft(previous=>next.some(adapter=>adapter.id===previous.adapter&&adapter.available)?previous:{...previous,adapter:next.find(adapter=>adapter.available&&adapter.id!=="shell")?.id??"shell"});
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [historyQuery,statusFilter,sessionTitles,projects]);

  useEffect(() => {
    if (!terminalHost.current) return;

    terminalMounted.current=true;
    const startupVersion=++layoutRestore.current.version;
    const startupPending=layoutRestore.current.pending;
    if(startupPending)setLayoutRestoreReady(false);
    const startupValid=()=>active&&terminalMounted.current&&layoutRestore.current.pending&&layoutRestore.current.version===startupVersion;
    syncNotificationContext();
    createView.current = (id,initialAppearance) => {
      const appearance={...(initialAppearance??terminalSettingsRef.current)};
      const element = document.createElement("div");
      element.className = "terminal-view";
      terminalHost.current!.append(element);
      const instance = new Terminal({
      scrollback:TERMINAL_SCROLLBACK_LINES,
      linkHandler:{allowNonHttpProtocols:false,activate(event){event.preventDefault();}},
      allowProposedApi:true,
      convertEol: true,
      ...terminalCursorOptions(terminalCursorRef.current),
      lineHeight:terminalLineHeightRef.current.lineHeight,
      ...terminalOptions(appearance,terminalSystemThemeRef.current),
    });
      const fit = new FitAddon();
      try { instance.loadAddon(fit); instance.open(element); }
      catch (reason) { instance.dispose(); element.remove(); throw reason; }
      const view: TerminalView = {
        desktopGeneration:terminalWindowClaim(id),clearDisplayVersion:null,clearPending:false,reportedPromptNavigation:null,promptNavigationPending:false,reportedCommand:null,reportedCommandSequence:-1,reportedCommandPair:null,reportedCwd:null,reportedCwdSequence:-1,appearance,appearanceRevision:0,instance, fit, element, cursor: null, ready:false, replayVersion:0, firstAttachment:false, parsing:null, finishReplay:null, live:false, status:null, notice:null,persisted:false, projection:false, frameRevision:-1, frameInstance:null,dirty:true,updating:false,selecting:false,lifecycleRevision:0,projecting:false,viewportRevision:0,resizing:false,resizePending:null,disposed:false,writable:false,
        dispose() { if(!view.moveDisposal)void invoke("release_terminal_view",{desktopGeneration:view.desktopGeneration,sessionId:id}).catch(()=>setError("Terminal view is still draining or unavailable."));view.clearDisplayVersion=null;view.reportedCwd=null;view.reportedCwdSequence=-1;view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;view.find?.dispose();view.disposed=true;view.resizePending=null;if(view.attaching){view.attaching=false;if(terminalMounted.current)setRecoveryRevision(revision=>revision+1);}view.finishReplay?.(); onData.dispose(); onScroll.dispose(); instance.dispose(); element.remove(); },
      };
      const bindData=()=>{const generation=view.desktopGeneration,listenerRevision=view.moveListenerRevision??0;return instance.onData(data => {
        if(view.desktopGeneration!==generation||(view.moveListenerRevision??0)!==listenerRevision)return;
        const protocol=isTerminalProtocolResponse(data);
        const connected=ownerConnectionAvailable.current.available&&view.availability!=="owner_unavailable";
        if(!view.live&&!protocol){continueTerminalInput(id,view,data);return;}
        if (!view.disposed && !view.moving && connected && !(view.projection&&protocol) && view.live && (view.projection || (view.cursor !== null && (view.ready || view.firstAttachment)))
          && (terminalHasInputFocus(id) || (!view.projection && protocol))){
          const owner=view.frameInstance,attachment=view.attachVersion,connectionVersion=ownerConnectionAvailable.current.version;
          const valid=()=>!view.disposed&&!view.moving&&view.live&&view.desktopGeneration===generation&&(view.moveListenerRevision??0)===listenerRevision&&ownerConnectionAvailable.current.available&&view.availability!=="owner_unavailable"&&ownerConnectionAvailable.current.version===connectionVersion&&view.frameInstance===owner&&view.attachVersion===attachment;
          const MAX_PENDING_INPUT=256*1024,MAX_PENDING_WRITES=256;
          const queue=view.inputQueue??={write:null,version:0,length:0,count:0};
          if(queue.length+data.length>MAX_PENDING_INPUT||queue.count>=MAX_PENDING_WRITES){queue.version++;view.writable=false;setError("Too much pending terminal input. Unsent input was discarded; check the prompt before typing again.");return;}
          const version=queue.version;
          queue.length+=data.length;queue.count++;
          // Separate IPC calls can reach the owner out of order; keep one write in flight per view.
          const write=async()=>{
            if(version!==queue.version||!valid())return;
            try{await invoke("write_session",{desktopGeneration:generation,sessionId:id,data});if(version===queue.version&&valid()){view.writable=true;syncViewSize(view);}}
            catch(reason){if(version===queue.version)queue.version++;if(valid()){view.writable=false;if(terminalHasInputFocus(id))setError(`${String(reason)}. Pending terminal input was discarded; check the prompt before typing again.`);}}
          };
          const pending=queue.write?queue.write.then(write):write();
          queue.write=pending;
          void pending.finally(()=>{queue.length-=data.length;queue.count--;if(queue.write===pending)queue.write=null;});
        }
      });};let onData=bindData();
      const links=installTerminalLinks(instance,element,()=>view.instance===instance&&view.element===element?terminalLinkIdentity(id,view):null,url=>openUrl(url),()=>setError("Could not open the link. Try again from the current terminal."),shortcutMac);
      const onPaste=(event:ClipboardEvent)=>captureTerminalPaste(id,view,event);
      element.addEventListener("paste",onPaste,true);
      const bindScroll=()=>{const generation=view.desktopGeneration,listenerRevision=view.moveListenerRevision??0;return instance.onScroll(line=>{if(view.desktopGeneration===generation&&(view.moveListenerRevision??0)===listenerRevision)handleTerminalScroll(view,id,line);});};let onScroll=bindScroll();
      view.refreshMoveListeners=()=>{onData.dispose();onScroll.dispose();onData=bindData();onScroll=bindScroll();};
      element.addEventListener("pointerdown",()=>{view.find?.manualSelection();view.selecting=view.instance.modes.mouseTrackingMode === "none";});
      const finishSelection=()=>{view.selecting=false;};
      window.addEventListener("pointerup",finishSelection);
      const originalDispose=view.dispose;view.dispose=()=>{if(terminalReopen.current?.view===view){terminalReopen.current=null;if(terminalMounted.current)setRecoveryRevision(value=>value+1);}view.clearDisplayVersion=null;links.dispose();element.removeEventListener("paste",onPaste,true);if(pastePending.current?.target.view===view)cancelTerminalPaste(false);if(fileDropPending.current?.target.view===view)cancelTerminalFileDrop();window.removeEventListener("pointerup",finishSelection);originalDispose();};
      element.style.visibility = "hidden";
      element.inert = true;
      return view;
    };
    const resize = () => fitTerminalViews();
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(terminalHost.current);

    const frameTimer=window.setInterval(()=>{validatePendingTerminalPaste();pollTerminalFrames();},100);
    const focusChanged=()=>syncNotificationContext();
    const surfaceChanged=()=>restoreTerminalSurface();
    document.addEventListener("focusin",focusChanged);
    document.addEventListener("focusout",focusChanged);
    window.addEventListener("focus",focusChanged);
    window.addEventListener("blur",focusChanged);
    window.addEventListener("focus",surfaceChanged);
    document.addEventListener("visibilitychange",surfaceChanged);
    const extraListeners: UnlistenFn[] = [];
    const retryTimer = isMainWindow?window.setInterval(() => {
      for (const event of retryNotifications.current.values()) void notifySession(event);
    }, 15000):null;
    for (const [name, callback] of [
      ["agent-state", (_payload: { session_id: string; data: string }) => {void refreshHistory();}],
      ["session-error", (payload: { session_id: string; data: string }) => {
        if(payload.session_id==="") {
          cancelLayoutRestore(false,false);
          ownerConnectionAvailable.current={available:false,version:ownerConnectionAvailable.current.version+1};
          let recoveryChanged=false;
          for(const view of terminalViews.current.all) {
            view.attachVersion=(view.attachVersion??0)+1;
            if(view.attaching){view.attaching=false;recoveryChanged=true;}
            if(view.availability!=="owner_unavailable") {view.availability="owner_unavailable";recoveryChanged=true;}
            if(view.clearDisplayVersion||view.reportedPromptNavigation)recoveryChanged=true;view.clearDisplayVersion=null;if(view.reportedCwd!==null&&view.reportedCwd!==undefined){view.reportedCwd=null;recoveryChanged=true;}view.reportedCwdSequence=-1;view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;
            view.firstAttachment=false;view.writable=false;view.ready=false;view.resizePending=null;
            view.dirty=true;
          }
          if(recoveryChanged)setRecoveryRevision(revision=>revision+1);
        }
        setError(payload.data);
      }],
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
    void listen<{missing_events:boolean}>("background-gap", event => {
      cancelLayoutRestore(false,false);
      for (const view of terminalViews.current.all) {
        view.clearDisplayVersion=null;view.reportedCwd=null;view.reportedCwdSequence=-1;view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;
      view.cursor = null;view.writable=false; view.ready = false; view.firstAttachment = false;
        view.lifecycleRevision++; view.viewportRevision++;
      }
      outputCursor.current = null;
      pendingOutput.current.clear();
      for (const view of terminalViews.current.all) view.dirty=true;
      if(event.payload?.missing_events!==false) setError("Background event buffer exceeded its limit. Reloading the latest terminal state.");
      void refreshHistory();
      for(let pane=0;pane<terminalLayoutRef.current.panes.length;pane++){const id=terminalLayoutRef.current.panes[pane],record=id?terminalViews.current.get(id)?.record:null;if(record)void openHistory(record,false,pane);}
    }).then(unlisten => { if (active) extraListeners.push(unlisten); else unlisten(); });
    async function selectNotificationSession(id: string, restoreOnFailure=false) {
      cancelLayoutRestore(true,false);
      let intent=layoutRestore.current.version;
      let version=++detailVersion.current;
      try {
        const record = await invoke<SessionRecord>("get_session",{sessionId:id});
        if (!active||intent!==layoutRestore.current.version) return;
        const pending = await invoke<string | null>("pending_notification_selection");
        if (!active || version!==detailVersion.current || intent!==layoutRestore.current.version) return;
        if(pending!==id){if(restoreOnFailure)throw Error("Pending notification changed. Restoring saved terminals.");return;}
        if (!record) throw new Error("Notification refers to an unknown session");
        setDataSettingsOpen(false);
        launchDialog.current?.close();
        projectDialog.current?.close();
        renameDialog.current?.close();
        const receipt=await openTerminal(record);
        if(!receipt)return;intent=receipt.intent;version=receipt.detail;
        if (active && intent===layoutRestore.current.version && version===detailVersion.current && sessionId.current === receipt.view.record?.summary.session_id && outputCursor.current !== null) {
          await invoke("acknowledge_notification_selection", { sessionId: id });
        }
      } catch (reason) {
        if(active&&intent===layoutRestore.current.version&&version===detailVersion.current){
          setError(String(reason));
          if(restoreOnFailure){const fallback=++layoutRestore.current.version;layoutRestore.current.pending=true;layoutRestore.current.adoptable=false;setLayoutRestoreReady(false);await restoreSavedLayout(fallback);}
        }
      }
    }
    void listen<string>("terminal-window-selection",event=>{void openSession(event.payload);}).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});
    if(isMainWindow)void listen<{previous:string;next:string}>("terminal-reopened",event=>{
      const {previous,next}=event.payload??{};
      if(active&&typeof previous==="string"&&typeof next==="string"&&previous.length<=128&&next.length<=128&&/^s-[a-f0-9]+-[a-f0-9]+$/.test(previous)&&/^s-[a-f0-9]+-[a-f0-9]+$/.test(next))migrateTerminalMetadata(previous,next);
    }).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});
    if(isMainWindow){void listen<string>("terminal-main-zoom",event=>zoomTerminal(event.payload as TerminalZoomAction)).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});}
    void listen<WindowPreferenceCommit>("terminal-window-preferences",event=>receiveWindowPreference(event.payload)).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});
    if(isMainWindow){void listen<unknown>("terminal-main-settings",event=>nativeMenuHandler.current(event.payload??"settings")).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});}
    void listen<string>("terminal-window-error",event=>setError(event.payload)).then(unlisten=>{if(active)extraListeners.push(unlisten);else unlisten();}).catch(()=>{});
    async function restoreSavedLayout(version:number){
      const retryValid=()=>active&&terminalMounted.current&&layoutRestore.current.pending&&layoutRestore.current.version===version;
        try{
          const preference=layoutPreferenceLoad;
          if(preference.warning){desktopWindow.restore_blocked=true;setError(preference.warning);finishLayoutRestore(version);return;}
          let layout=preference.layout;
          if(!preference.present){
            const last=readPreference<string|null>(windowPreferenceKey("lastSession"),null,(value):value is string|null=>typeof value==="string" && /^s-[a-f0-9]+-[a-f0-9]+$/.test(value));
            if(last)layout={...createTerminalLayout(),panes:[last]};
          }
          layoutRestore.current.ids=terminalMembers(layout);
          const records=new Map<string,SessionRecord>();
          for(const id of terminalMembers(layout)){
            if(!id)continue;
            const record=await invoke<SessionRecord|null>("get_session",{sessionId:id});
            if(!retryValid())return;
            if(!record||record.summary.session_id!==id)throw Error("invalid_saved_session");
            records.set(id,record);
          }
          if(!retryValid())return;
          desktopWindow.restore_blocked=false;
          terminalLayoutRef.current={...layout,panes:[...layout.panes]};setTerminalLayout(terminalLayoutRef.current);
          showTerminalLayout();
          layoutRestore.current.adoptable=true;
          const attachments:Promise<unknown>[]=[];
          for(let pane=0;pane<layout.panes.length;pane++){
            for(const id of terminalTabs(terminalLeaves(terminalLayoutRoot(layout))[pane])){
              const record=records.get(id)!;
              const recordedOnly=(preference.recordedOnly?.includes(id)??false)||terminalStatuses.has(record.status);
              attachments.push(layout.panes[pane]===id&&!recordedOnly?openTerminal(record,terminalPaneId(layout,pane),version,undefined,preference.appearances?.[id]):openHistory(record,false,terminalPaneId(layout,pane),version,undefined,preference.appearances?.[id],undefined,undefined,recordedOnly));
            }
          }
          const attached=await Promise.all(attachments);
          if(!retryValid())return;
          desktopWindow.restore_blocked=false;
          focusTerminalPane(layout.focused,false,true);
          if(attached.every(Boolean))setError(null);
          finishLayoutRestore(version);
        }catch{
          if(!retryValid())return;
          // An owner read failure does not prove that the saved sessions disappeared.
          desktopWindow.restore_blocked=true;
          terminalLayoutRef.current=createTerminalLayout();setTerminalLayout(terminalLayoutRef.current);
          showTerminalLayout();focusTerminalPane(0,false,true);
          setError("Saved terminal layout is unavailable. Using a single pane.");
          finishLayoutRestore(version);
        }
    }
    let restoreRetryBusy=false;
    layoutRestoreRetry.current=async()=>{
      if(!active||restoreRetryBusy||!desktopWindow.restore_blocked||desktopWindow.preference.warning)return;
      restoreRetryBusy=true;setLayoutRestoreRetrying(true);
      const version=++layoutRestore.current.version;layoutRestore.current.pending=true;layoutRestore.current.adoptable=false;setLayoutRestoreReady(false);
      try{await restoreSavedLayout(version);}finally{restoreRetryBusy=false;if(active)setLayoutRestoreRetrying(false);}
    };
    void listen<string>("session-notification-click", event => { void selectNotificationSession(event.payload); })
      .then(async unlisten => {
        if (!active) { unlisten(); return; }
        extraListeners.push(unlisten);
        const pending = desktopWindow.requested_session??await invoke<string | null>("pending_notification_selection").catch(()=>null);
        if(!startupPending||!startupValid())return;
        if(pending){if(desktopWindow.owned_ids.includes(pending)||isMainWindow) {await selectNotificationSession(pending,true);return;}}
        await restoreSavedLayout(startupVersion);
      }).catch(async()=>{
        if(startupValid()){
          await restoreSavedLayout(startupVersion);
          if(active&&!desktopWindow.restore_blocked)setError("Notification click events are unavailable. Use the sidebar to open sessions.");
        }
      });
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenState: UnlistenFn | undefined;
    let active = true;
    void listen<SessionOutput>("session-output", (event) => {
      if (!active) return;
      const view = terminalViews.current.get(event.payload.session_id);
      if(view?.projection){view.dirty=true;if(event.payload.session_id===sessionId.current) updateAgentPhase(event.payload.data);return;}
      if (view && view.cursor !== null) {
        try {
          const next = consumeOutput(view.cursor, event.payload);
          view.cursor = next.nextOffset;
          view.instance.write(next.data);
          if (event.payload.session_id === sessionId.current) {
            outputCursor.current = view.cursor;
            updateAgentPhase(next.data);
          }
        } catch {
          view.cursor = null;view.writable=false;
          view.ready = false;
          view.firstAttachment = false;
          if (event.payload.session_id === sessionId.current) outputCursor.current = null;
          pendingOutput.current.push(event.payload);
          setError("Terminal output gap. Select the session to reload its recorded log; full live TUI state cannot be recovered from a log tail.");
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
      const live = ["starting", "running"].includes(event.payload.status);
      terminalViews.current.setRunning(event.payload.session_id, live);
      const view = terminalViews.current.get(event.payload.session_id);
      if (view) { if(!live)view.reportedCwd=null;view.live = live; view.status = event.payload.status; view.dirty=true; view.lifecycleRevision++; }
      void notifySession(event.payload);
      void refreshHistory();
      if (terminalStatuses.has(event.payload.status) && event.payload.session_id !== sessionId.current)
        pendingOutput.current.delete(event.payload.session_id);
      if (event.payload.session_id !== sessionId.current || outputCursor.current === null) {
        pendingState.current.set(event.payload.session_id, event.payload);
        return;
      }
      pendingState.current.delete(event.payload.session_id);
      if (terminal.current) applyStateEvent(terminal.current, event.payload);
    }).then((unlisten) => {
      if (active) unlistenState = unlisten;
      else unlisten();
    });

    return () => {
      active = false;terminalMounted.current=false;terminalReopen.current=null;terminalReopenFlight.current=null;layoutRestoreRetry.current=null;
      layoutRestore.current.adoptable=false;layoutRestore.current.version++;
      document.removeEventListener("focusin",focusChanged);document.removeEventListener("focusout",focusChanged);
      window.removeEventListener("focus",focusChanged);window.removeEventListener("blur",focusChanged);
      window.removeEventListener("focus",surfaceChanged);document.removeEventListener("visibilitychange",surfaceChanged);
      if(retryTimer!==null)window.clearInterval(retryTimer);
      window.clearInterval(frameTimer);
      extraListeners.forEach(unlisten => unlisten());
      createView.current = null;
      window.removeEventListener("resize", resize);
      observer.disconnect();
      unlistenOutput?.();
      unlistenState?.();
      terminalViews.current.clear();
      terminal.current = null;
      fitAddon.current = null;
      pendingOutput.current.clear();
      pendingState.current.clear();
    };
  }, []);

  useEffect(()=>{
    if(!isMainWindow)return;
    let active=true;
    const unlisten:UnlistenFn[]=[];
    notificationPause.current.cancel();notificationPauseState.current=null;systemEntryMutation.current++;setSystemEntryBusy(false);
    void refreshNotificationPause();
    void refreshSystemEntry();
    void listen<NotificationPauseState>("notification-pause-state",event=>{
      if(active&&terminalMounted.current&&notificationPause.current.accept(event.payload))applyNotificationPause(event.payload);
    }).then(dispose=>{if(active)unlisten.push(dispose);else dispose();}).catch(()=>{if(active&&terminalMounted.current)setError("System entry events unavailable. Use the normal YAM window and refresh settings.");});
    void listen<typeof systemEntry>("system-entry-status",event=>{
      if(active&&terminalMounted.current&&event.payload.owner_instance===notificationPauseState.current?.owner_instance)setSystemEntry({...event.payload,warning:event.payload.warning||""});
    }).then(dispose=>{if(active)unlisten.push(dispose);else dispose();}).catch(()=>{if(active&&terminalMounted.current)setError("System entry events unavailable. Use the normal YAM window and refresh settings.");});
    return ()=>{active=false;notificationPauseVersion.current++;systemEntryVersion.current++;systemEntryMutation.current++;notificationPause.current.cancel();notificationPauseState.current=null;unlisten.forEach(dispose=>dispose());};
  },[gitOwner]);

  function applyNotificationPause(state:NotificationPauseState){
    notificationPauseState.current=state;pausedRef.current=state.paused;setNotificationsPaused(state.paused);
    try{localStorage.setItem("yam.notificationsPaused",JSON.stringify(state.paused));}catch{setError("Notification preferences unavailable.");}
  }
  async function refreshNotificationPause(){
    const version=++notificationPauseVersion.current;
    try{
      const state=await notificationPause.current.load(invoke,pausedRef.current);
      if(terminalMounted.current&&version===notificationPauseVersion.current)applyNotificationPause(state);
    }catch{if(terminalMounted.current&&version===notificationPauseVersion.current)setError("Notification pause state unavailable. Reopen YAM to reconnect.");}
  }
  async function toggleNotificationPause(){
    const current=notificationPauseState.current;
    if(!current)return;
    const version=++notificationPauseVersion.current;
    try{
      const state=await notificationPause.current.setPause(invoke,!current.paused);
      if(terminalMounted.current&&version===notificationPauseVersion.current&&notificationPauseState.current?.owner_instance===current.owner_instance)applyNotificationPause(state);
    }catch{
      if(terminalMounted.current&&version===notificationPauseVersion.current&&notificationPauseState.current?.owner_instance===current.owner_instance){setError("Notification pause state changed or unavailable. Review the refreshed state and retry.");await refreshNotificationPause();}
    }
  }
  async function refreshSystemEntry(){
    const version=++systemEntryVersion.current;
    try{
      const state=await invoke<typeof systemEntry>("get_system_entry_status");
      if(terminalMounted.current&&version===systemEntryVersion.current)setSystemEntry({...state,warning:state.warning||""});
    }catch{if(terminalMounted.current&&version===systemEntryVersion.current)setSystemEntry(previous=>({...previous,warning:"System entry unavailable. Open the normal YAM window."}));}
  }
  async function setGlobalShortcut(enabled:boolean){
    const owner=notificationPauseState.current?.owner_instance;
    if(!owner)return;
    const version=++systemEntryVersion.current,mutation=++systemEntryMutation.current;setSystemEntryBusy(true);
    try{
      const state=await invoke<typeof systemEntry>("set_global_shortcut",{enabled,expectedOwnerInstance:owner});
      if(terminalMounted.current&&version===systemEntryVersion.current&&notificationPauseState.current?.owner_instance===owner)setSystemEntry({...state,warning:state.warning||""});
    }catch{
      if(terminalMounted.current&&version===systemEntryVersion.current&&notificationPauseState.current?.owner_instance===owner){await refreshSystemEntry();if(terminalMounted.current&&mutation===systemEntryMutation.current&&notificationPauseState.current?.owner_instance===owner)setError("Global shortcut could not be applied. Review System entry settings and use the normal YAM window.");}
    }finally{if(terminalMounted.current&&mutation===systemEntryMutation.current&&notificationPauseState.current?.owner_instance===owner)setSystemEntryBusy(false);}
  }

  function applyStateEvent(instance: Terminal, event: SessionStateEvent) {
    setSessionStatus(event.status);
    if (selectedRecord.current?.summary.session_id === event.session_id) {
      selectedRecord.current = { ...selectedRecord.current, status:event.status, exit_code:event.exit_code, reason:event.reason };
    }
    if (!terminalViews.current.get(event.session_id)?.projection && event.status !== "starting" && event.status !== "running") {
      instance.writeln(
        `\r\n[${statusLabels[event.status] ?? event.status}] ${event.reason ?? ""}`,
      );
    }
    void refreshHistory();
  }

  function worktreeCreated(record: import("./worktree-controls").ManagedWorktree, expectedRoot?:string, expectedOwner?:number) {
    if(expectedRoot!==undefined && (worktreeContextRef.current.root!==expectedRoot || worktreeContextRef.current.owner!==expectedOwner))return;
    cancelProjectPreview();
    setProjectTemplate("");
    setCwd(record.target);
    setActiveProject(record.target);
    setSelectedWorktree(record);
  }
  async function startManagedWorktree(record: import("./worktree-controls").ManagedWorktree) {
    if (cwd.trim() !== record.target) {
      setError("Select this worktree before starting its reserved session.");
      return;
    }
    setProjectToolsOpen(false);
    newSession(record.target,undefined,record.attempt);
  }
  async function startNewSession(quickCopy?:ReturnType<typeof duplicateSessionDraft>){
    const launchAdapter=quickCopy?.draft.adapter??formAdapter,launch=quickCopy?.draft??formLaunch;
    if(launchAdapter==="pi"&&!quickCopy&&!piFormValid){setError("Check the connection and available Pi models.");return;}
    const projectSettings=!quickCopy&&useProjectSettings,worktree=quickCopy?undefined:launchWorktreeAttempt;
    const ordinaryTerminal=launchAdapter==="shell"&&!launch.command?.trim()&&!launch.provider&&!projectSettings&&!worktree;
    const copy=quickCopy??sessionCopy,outputTerminal=quickCopy?.settings.terminal??sessionTerminal,name=quickCopy?"":copy?copyName.trim():"";
    if(name)try{validateSessionTitle(name);}catch{setError("Use a session name of 1–200 characters.");return;}
    let next:SessionSummary|undefined,ordinarySnapshot:SessionLaunchSettings["ordinary"];
    if(copy&&!projectSettings&&!worktree){
      const directory=quickCopy?.cwd??cwd;
      if(ordinaryTerminal&&copy.settings.ordinary){const ordinary={...copy.settings.ordinary,...(copy.settings.appearance?{appearance:copy.settings.appearance}:{})};ordinarySnapshot=ordinary;ordinaryLaunchSnapshot.current=ordinary;next=await startSession({cwd:directory,...ordinary,command:"",launch:null});}
      else if(ordinaryTerminal){const pending=newTerminal(directory,launchTerminalProfile,copy.settings.appearance);ordinarySnapshot=ordinaryLaunchSnapshot.current;next=await pending;}
      else next=await startSession({cwd:directory,...(copy.settings.appearance?{viewAppearance:copy.settings.appearance}:{}),command:launch.command??"",launch:launchAdapter!=="shell"&&launchAdapter!=="custom"?{adapter:launchAdapter,mode:"interactive",extra_args:launch.extra_args,prompt:launch.prompt,provider:launch.provider??null,...(launchAdapter==="codex"?{codex:launch.codex??{image_mode:"native" as const}}:{}),...(copy.settings.envRefs?{env_refs:copy.settings.envRefs}:{})}:null});
    }else if(ordinaryTerminal){const pending=newTerminal(launchDirectoryOverride,launchTerminalProfile);ordinarySnapshot=ordinaryLaunchSnapshot.current;next=await pending;}
    else next=worktree?await startSession(undefined,worktree):await startSession();
    if(next)try{
      const appearance=copy?.settings.appearance??(ordinaryTerminal?ordinarySnapshot?.appearance:undefined)??terminalSettingsRef.current;
      saveSessionLaunchSettings(localStorage,next.session_id,{terminal:outputTerminal as SessionLaunchSettings["terminal"],appearance:{...appearance},...(ordinaryTerminal&&ordinarySnapshot?{ordinary:ordinarySnapshot}:{}),...(next.launch?.env_refs?{envRefs:next.launch.env_refs}:{})});
      if(name){const title=saveSessionName(localStorage,next.session_id,name);setSessionTitles(previous=>({...previous,[next!.session_id]:title!}));}
    }catch{setError("Session started, but its name or launch settings could not be saved. Use the existing session; do not start it again.");}
    if(next&&worktree)setLaunchWorktreeAttempt(undefined);
    if(next&&outputTerminal!=="yam")try{await invoke("open_external_terminal",{sessionId:next.session_id,terminal:outputTerminal});}catch{setError("The session was created in YAM, but the external terminal could not be opened. Check macOS Automation permission; use this existing session instead of starting it again.");}
    if(next&&isMainWindow)try{localStorage.setItem("yam.lastSessionCli",JSON.stringify(next.launch?.adapter??"shell"));}catch{setError("Session started, but the last CLI choice could not be saved.");}
  }
  async function startSession(overrides?: { cwd?: string; command?: string; launch?: AgentLaunch | null; resumeFrom?: string; shell?: ShellLaunch; envRefs?: Record<string,string>; appearance?:TerminalSettings; viewAppearance?:TerminalSettings; directoryReporting?:boolean; commandReporting?:boolean; retainedLines?:number;ssh?:SshLaunch }, worktreeAttempt?: string) {
    if(overrides?.ssh&&(!isSshLaunch(overrides.ssh)||overrides.command!==undefined||overrides.launch!==undefined||overrides.resumeFrom||worktreeAttempt||overrides.shell||overrides.envRefs&&Object.keys(overrides.envRefs).length||overrides.directoryReporting||overrides.commandReporting)){setError("Invalid SSH launch.");return;}
    if(!isMainWindow&&(overrides?.ssh||overrides?.resumeFrom||worktreeAttempt)){openMainSettings();return;}
    if(overrides?.retainedLines!==undefined&&(!Number.isSafeInteger(overrides.retainedLines)||overrides.retainedLines<200||overrides.retainedLines>2000||(overrides.retainedLines!==2000&&!overrides.ssh&&((overrides.command??command).trim()||overrides.launch||overrides.resumeFrom||worktreeAttempt)))){setError("Invalid terminal retention.");return;}
    cancelLayoutRestore(false,false);
    if (starting || creatingSession.current) return;
    desktopWindow.restore_blocked=false;
    if (terminalMembers(terminalLayoutRef.current).length>=16||!terminalViews.current.canOpen) { setError("Terminal limit reached. Hide an ended pane before starting another session."); return; }
    const projectStart=!overrides&&useProjectSettings;
    if(projectStart&&(!projectPreview?.trusted||projectConfigBusy)){setError("Preview and trust this exact project configuration before starting.");return;}
    const initialAppearance=overrides?.viewAppearance?{...overrides.viewAppearance}:overrides&&!overrides.resumeFrom&&!overrides.command&&!overrides.launch&&!worktreeAttempt&&overrides.appearance?{...overrides.appearance}:undefined;
    const adapter = adapters.find((item) => item.id === selectedAdapter);
    const customCommand = overrides?.ssh?"":(overrides?.command ?? command).trim();
    const workingDirectory = (overrides?.cwd ?? cwd).trim();
    const launchPrompt =
      !overrides && selectedAdapter !== "shell" ? prompt.trim() : "";
    const launchArgs =
      !overrides && selectedAdapter !== "shell" ? adapterArgs.trim() : "";
    if(!projectStart&&!overrides&&providerConfig&&(!isProviderConfig(providerConfig)||!supportsProvider(selectedAdapter,providerConfig)||customCommand)){setError("Choose a compatible CLI and valid provider settings, or use native login.");return;}
    if (!projectStart && !overrides && !customCommand && adapter && !adapter.available) {
      setError(`${adapter.label} was not found on PATH`);
      return;
    }
    const releasable=(view:TerminalView)=>!view.live&&view.projection&&view.persisted&&!view.disposed&&!view.moving&&!view.attaching&&!view.parsing&&!view.projecting&&!view.updating&&!view.resizing&&!view.selecting&&!terminalMembers(terminalLayoutRef.current).includes(view.element.dataset.sessionId!);
    if(!terminalViews.current.reserveAdmission(releasable)){setError("Terminal limit reached. Hide an ended pane before starting another session.");return;}
    creatingSession.current = true;
    setStarting(true);
    setError(null);
    const clickStarted=performance.now();
    const dialog=launchDialog.current,focusOrigin=dialog?.open?document.activeElement:null,restoreFocus=dialog?.open&&dialog.contains?.(focusOrigin),launchWasOpen=dialog?.open;
    let revealed=false;
    const reveal=()=>{if(!revealed){revealed=true;dialog?.close();}};
    if(dialog?.open)reveal();
    try {
      const argumentsForStart = overrides?.ssh ? {cwd:workingDirectory||null,command:null,launch:null,ssh:{...overrides.ssh},...(overrides.retainedLines!==undefined&&overrides.retainedLines!==2000?{retainedLines:overrides.retainedLines}:{})} : overrides?.resumeFrom ? {resumeFrom:overrides.resumeFrom,cwd:null,command:null,launch:null} : projectStart ? {cwd:null,command:null,launch:null,projectConfig:{root:projectPreview!.root,template:projectTemplate||null,overrides:{...projectLaunchEdits,mode:"interactive"}}} : {
        cwd: workingDirectory || null,
        command: customCommand || null,
        ...(overrides?.shell?{shell:overrides.shell}:{}),
        ...(overrides?.retainedLines!==undefined&&overrides.retainedLines!==2000?{retainedLines:overrides.retainedLines}:{}),
        ...(!customCommand&&!overrides?.launch&&!worktreeAttempt&&overrides?.directoryReporting===true?{directoryReporting:true}:{}),
        ...(!customCommand&&!overrides?.launch&&!worktreeAttempt&&overrides?.commandReporting===true?{commandReporting:true}:{}),
        ...(!customCommand&&!overrides?.launch&&!worktreeAttempt&&overrides?.envRefs&&Object.keys(overrides.envRefs).length?{envRefs:Object.fromEntries(Object.entries(overrides.envRefs))}:{}),
        launch: overrides ? overrides.launch ?? null :
          !customCommand && selectedAdapter !== "shell" ? {
            adapter:selectedAdapter, mode:"interactive", extra_args:launchArgs, prompt:launchPrompt || null,...(selectedAdapter==="codex"?{codex:{image_mode:providerConfig?(formLaunch.codex?.image_mode??"native"):"native"}}:{}),...(providerConfig?{provider:{...providerConfig}}:{}),
          } : null,
      };
      const endedView=terminalViews.current.all?.find(releasable);
      if(endedView&&!endedView.moveDisposal){
        const id=endedView.element.dataset.sessionId!,generation=endedView.desktopGeneration;
        endedView.moving=true;
        try{await invoke("release_terminal_view",{sessionId:id,desktopGeneration:generation});}finally{endedView.moving=false;}
        if(!terminalMounted.current||terminalViews.current.get(id)!==endedView||endedView.desktopGeneration!==generation||!releasable(endedView))throw Error("Terminal views changed while releasing capacity. Review the current tabs and try again.");
        // Keep its saved scene until the new renderer exists, even when startup fails.
        endedView.moveDisposal=true;
      }else if(!endedView&&terminalViews.current.size>=16)throw Error("Terminal views are active, visible, or still being saved. Close an ended tab and wait for its output to finish saving.");
      const reply = await invoke<SessionSummary & {directory_reporting_warning?:string;command_reporting_warning?:string}>("create_session", worktreeAttempt ? {...argumentsForStart,worktreeAttempt} : argumentsForStart);
      if(performance.getEntriesByName("yam.start.create").length>=32)performance.clearMeasures("yam.start.create");
      performance.measure("yam.start.create",{start:clickStarted,end:performance.now()});
      const {directory_reporting_warning,command_reporting_warning,...next}=reply;
      setActiveProject(next.cwd);
      setCollapsedProjects((previous) => {
        const copy = new Set(previous);
        copy.delete(projectKey(next.cwd));
        return copy;
      });
      if(isMainWindow&&overrides?.resumeFrom)migrateTerminalMetadata(overrides.resumeFrom,next.session_id);
      if(isMainWindow)setSessionTitles((previous) => ({
        ...previous,
        [next.session_id]:
          next.ssh ? sshTitle(next.ssh) : overrides?.resumeFrom ? previous[next.session_id] || previous[overrides.resumeFrom] || `Continue ${next.launch?.adapter ?? "conversation"}` : next.launch?.prompt?.trim() ||
            next.command || adapters.find((item) => item.id === next.launch?.adapter && item.id !== "shell")?.label ||
            (!overrides && !projectStart && adapter?.id!=="shell" ? adapter?.label : null) || defaultTerminalTitle(next.session_id,t("Terminal")),
      }));
      if(overrides?.ssh)setSshOpen(false);
      // Select the new view before closing; its first frame may arrive later.
      let attached:Awaited<ReturnType<typeof openHistory>>=undefined,attachmentFailed=false;
      try{attached=await openHistory({summary:next, status:next.status, exit_code:null, reason:null, started_at:Date.now()/1000, ended_at:null},true,undefined,undefined,undefined,initialAppearance,undefined,undefined,undefined,reveal);}
      catch{attachmentFailed=true;}
      const focusCurrent=restoreFocus&&(dialog?.open?dialog.contains(document.activeElement):document.activeElement===focusOrigin||document.activeElement===document.body);
      reveal();
      if(restoreFocus&&focusCurrent&&!dialog?.open&&attached?.view?.ready&&!attached.view.disposed&&sessionId.current===next.session_id)attached.view.instance.focus();
      if(attached?.view?.ready){if(performance.getEntriesByName("yam.start.frame").length>=32)performance.clearMeasures("yam.start.frame");performance.measure("yam.start.frame",{start:clickStarted,end:performance.now()});}
      if(attachmentFailed)setError("The session was created, but YAM could not attach its view. Open the existing session from history; do not start it again.");
      else if(directory_reporting_warning&&command_reporting_warning)setError("Directory reporting and command status reporting are unavailable for this terminal. The shell is running with its original startup.");
      else if(directory_reporting_warning)setError("Zsh directory reporting is unavailable for this terminal.");
      else if(command_reporting_warning)setError("Command status reporting is unavailable for this terminal. The shell is running with its original startup.");
      void refreshHistory();
      return next;
    } catch (reason: unknown) {
      const failure=reason instanceof Error?reason.message:String(reason);
      if(failure==="terminal_view_limit"){setError("The 16-view limit is shared by both windows. Close an ended tab in either window and wait for its output to finish saving.");return;}
      const unknownStart=failure==="terminal_start_outcome_unknown";
      if(launchWasOpen&&!unknownStart&&!dialog?.open&&(document.activeElement===focusOrigin||document.activeElement===document.body)&&!document.querySelector?.('dialog[open]'))dialog?.showModal();
      const message=unknownStart?"Start outcome unknown. New starts in the current window are paused. Check existing sessions; do not retry automatically.":overrides?.ssh?"SSH start unavailable. Check the terminal owner and macOS OpenSSH. The start outcome may be unknown; do not retry automatically.":overrides?.commandReporting?"Command status reporting could not be started. Update the terminal owner before trying again.":overrides?.directoryReporting?"Zsh directory reporting could not be started. Check terminal owner compatibility.":overrides?.envRefs&&Object.keys(overrides.envRefs).length?"Terminal environment references could not be applied. Check the profile and terminal owner compatibility.":overrides?.shell?shellStartError(reason):reason instanceof Error?reason.message:String(reason);
      setError(message);
    } finally {
      terminalViews.current.releaseAdmission();
      creatingSession.current = false;
      setStarting(false);
    }
  }

  async function stopAllAndQuit(){
    if(stopAllPending.current)return;stopAllPending.current=true;setStopAllBusy(true);
    try{if(await invoke<boolean>("confirm_stop_all")===true&&terminalMounted.current)await invoke("stop_all_and_quit");}
    catch{if(terminalMounted.current)setError("Stop all tasks could not be completed. Check the background connection before trying again.");}
    finally{stopAllPending.current=false;if(terminalMounted.current)setStopAllBusy(false);}
  }
  async function reconnectBackground(){
    if(reconnectPending.current||ownerConnectionAvailable.current.available)return;
    reconnectPending.current=true;setReconnecting(true);
    const version=ownerConnectionAvailable.current.version,layoutVersion=layoutRestore.current.version;
    const current=()=>terminalMounted.current&&ownerConnectionAvailable.current.version===version;
    try{
      await invoke("reconnect_background");if(!current())return;
      ownerConnectionAvailable.current={available:true,version:version+1};setRecoveryRevision(value=>value+1);setError(null);
      await refreshHistory();
      const attached=()=>terminalMounted.current&&ownerConnectionAvailable.current.available&&ownerConnectionAvailable.current.version===version+1&&layoutRestore.current.version===layoutVersion;
      for(let pane=0;pane<terminalLayoutRef.current.panes.length;pane++){
        const id=terminalLayoutRef.current.panes[pane];if(!id||!attached())continue;
        const record=await invoke<SessionRecord>("get_session",{sessionId:id});if(!attached())return;
        await openHistory(record,false,pane,layoutVersion);
      }
    }catch{if(terminalMounted.current&&(ownerConnectionAvailable.current.version===version||ownerConnectionAvailable.current.version===version+1))setError("The original background connection is unavailable. Tasks were not restarted. Reopen YAM if the owner has exited.");}
    finally{reconnectPending.current=false;if(terminalMounted.current)setReconnecting(false);}
  }

  async function stopSession() {
    const id = sessionId.current;
    if (!id || !isRunning) return;
    const version = detailVersion.current;
    try {
      await invoke("stop_session", { sessionId: id });
    } catch (reason: unknown) {
      if (!terminalMounted.current || detailVersion.current !== version || sessionId.current !== id) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function retrySavedLayout(){await layoutRestoreRetry.current?.();}

  function finishLayoutRestore(version:number){
    if(!terminalMounted.current||layoutRestore.current.version!==version)return;
    layoutRestore.current.pending=false;layoutRestore.current.adoptable=false;
    setLayoutRestoreReady(true);
    restoreTerminalSurface();
  }
  function cancelLayoutRestore(resetPendingLayout=false,adoptVisible=true){
    const restore=layoutRestore.current,pending=restore.pending;
    restore.version++;restore.pending=false;
    if(!adoptVisible)restore.adoptable=false;
    if(resetPendingLayout&&pending){
      terminalLayoutRef.current=createTerminalLayout();setTerminalLayout(terminalLayoutRef.current);
      showTerminalLayout();
    }
    // One microtask observes the final membership after nested mode/focus/close callbacks.
    if(restore.adoptable&&!restore.queued){
      restore.queued=true;
      void Promise.resolve().then(()=>{
        restore.queued=false;
        if(!terminalMounted.current||!restore.adoptable||creatingSession.current)return;
        const version=restore.version,layout=terminalLayoutRef.current;
        const attachments:Promise<unknown>[]=[];
        for(let pane=0;pane<layout.panes.length;pane++){
          for(const id of terminalTabs(terminalLeaves(terminalLayoutRoot(layout))[pane])){
            const view=terminalViews.current.get(id);
            if(restore.ids.includes(id)&&view?.record&&!view.ready)attachments.push(openHistory(view.record,false,terminalPaneId(layout,pane),version));
          }
        }
        void Promise.all(attachments).then(()=>{
          if(restore.version===version)restore.adoptable=false;
        });
      });
    }
    setLayoutRestoreReady(true);
  }
  function terminalPaneVisible(id:string){
    const layout=terminalLayoutRef.current,index=layout.panes.indexOf(id);
    return index>=0&&(!zoomedPaneIdRef.current||terminalPaneId(layout,index)===zoomedPaneIdRef.current);
  }
  function setTerminalPaneZoom(paneId:string|null){
    if(zoomedPaneIdRef.current===paneId)return;
    cancelTerminalLayoutFit();terminalPaneZoomIntent.current++;zoomedPaneIdRef.current=paneId;setZoomedPaneId(paneId);
    showTerminalLayout();syncNotificationContext();requestTerminalLayoutFit();
  }
  function toggleTerminalPaneZoom(){
    const layout=terminalLayoutRef.current;
    setTerminalPaneZoom(zoomedPaneIdRef.current?null:terminalPaneId(layout,layout.focused));
    focusTerminalPane(layout.focused,true);
  }
  function focusTerminalPaneDirection(direction:TerminalPaneDirection){
    const layout=terminalLayoutRef.current,rects=new Map<string,TerminalPaneRect>();
    for(let index=0;index<layout.panes.length;index++){
      const id=terminalPaneId(layout,index);if(zoomedPaneIdRef.current&&zoomedPaneIdRef.current!==id)continue;
      const section=paneHosts.current.get(id)?.parentElement;
      if(section?.matches("section.terminal-pane"))rects.set(id,section.getBoundingClientRect());
    }
    const target=terminalDirectionPane(layout,direction,rects,zoomedPaneIdRef.current);
    if(target!==null)focusTerminalPane(target,true);
  }
  function terminalPaneHasSize(view:TerminalView){
    const rect=view.element.getBoundingClientRect();return rect.width>0&&rect.height>0;
  }
  function terminalHasInputFocus(id:string){
    const layout=terminalLayoutRef.current,view=terminalViews.current.get(id);
    return terminalPaneVisible(id)&&document.hasFocus()&&layout.panes[layout.focused]===id&&sessionId.current===id
      &&!!view&&!view.disposed&&view.element.contains(document.activeElement);
  }
  function syncNotificationContext(){
    const flight=notificationContextFlight.current;
    if(!terminalMounted.current){flight.pending=null;return;}
    const id=sessionId.current;
    flight.pending={
      selected:id&&terminalHasInputFocus(id)?id:null,
      paused:pausedRef.current,
      version:++notificationContextVersion.current,
    };
    if(flight.sending)return;
    flight.sending=true;
    void (async()=>{
      try{
        while(terminalMounted.current&&flight.pending){
          const snapshot=flight.pending;
          flight.pending=null;
          try{
            await invoke("set_agent_notification_context",{selected:snapshot.selected});
          }catch(reason){
            if(terminalMounted.current&&snapshot.version===notificationContextVersion.current)setError(String(reason));
          }
        }
      }finally{
        flight.sending=false;
        if(!terminalMounted.current)flight.pending=null;
      }
    })();
  }
  function showTerminalLayout(){
    const layout=terminalLayoutRef.current;
    if(zoomedPaneIdRef.current&&terminalPaneIndex(layout,zoomedPaneIdRef.current)<0){cancelTerminalLayoutFit();terminalPaneZoomIntent.current++;zoomedPaneIdRef.current=null;setZoomedPaneId(null);requestTerminalLayoutFit();}
    terminalViews.current.setProtected(terminalMembers(layout));
    for(const view of terminalViews.current.all){
      const index=layout.panes.indexOf(view.element.dataset.sessionId!);
      const visible=index>=0&&terminalPaneVisible(view.element.dataset.sessionId!),host=visible?paneHosts.current.get(terminalPaneId(layout,index)):terminalHost.current;
      if(host&&view.element.parentElement!==host)host.append(view.element);
      if(!visible){
        if(view.element.style.visibility==="visible")view.find?.close();
        view.resizePending=null;
        if(view.element.style.visibility==="visible"&&!terminalMembers(layout).includes(view.element.dataset.sessionId!)){
          view.attachVersion=(view.attachVersion??0)+1;
          if(view.attaching){view.attaching=false;setRecoveryRevision(revision=>revision+1);}
        }
      }
      view.element.style.visibility=visible?"visible":"hidden";
      view.element.inert=!visible||!view.ready;
    }
  }
  function focusTerminalPane(index:number,focusInput=false,restoring=false){
    if(!restoring)cancelLayoutRestore();
    const layout=terminalLayoutRef.current;if(index<0||index>=layout.panes.length)return;
    if(zoomedPaneIdRef.current&&terminalPaneId(layout,index)!==zoomedPaneIdRef.current)setTerminalPaneZoom(null);
    if(layout.focused!==index){terminalLayoutRef.current={...layout,focused:index};setTerminalLayout(terminalLayoutRef.current);}
    const id=layout.panes[index],view=id?terminalViews.current.get(id):undefined;
    const changed=sessionId.current!==id;
    if(changed)selectionVersion.current++;
    if(sessionId.current&&id&&sessionId.current!==id)previousSession.current=sessionId.current;
    sessionId.current=id;terminal.current=view?.instance??null;fitAddon.current=view?.fit??null;outputCursor.current=view?.cursor??null;
    selectedRecord.current=view?.record?{...view.record,status:view.status??view.record.status}:null;
    setSession(view?.record?.summary??null);setSelectedAgent(view?.record?.agent);setSessionStatus(view?.status??"idle");setTerminalNotice(view?.notice??null);
    if(view?.record)setActiveProject(view.record.summary.cwd);
    if(focusInput&&!conversationOpenRef.current&&view?.ready&&!view.disposed)view.instance.focus();
    if(!restoring&&(changed||conversationOpenRef.current))void refreshSelectedAgent();
    syncNotificationContext();
  }
  function mountTerminalPane(paneId:string,host:HTMLDivElement|null){
    if(host)paneHosts.current.set(paneId,host);else paneHosts.current.delete(paneId);
    showTerminalLayout();if(host){requestTerminalLayoutFit();requestTerminalTabFocus();}
  }
  function changeLayoutMode(mode:TerminalLayoutMode){
    setTerminalPaneZoom(null);
    cancelLayoutRestore();
    cancelTerminalLayoutFit();
    terminalLayoutRef.current=changeTerminalLayout(terminalLayoutRef.current,mode,splitPercentRef.current);setTerminalLayout(terminalLayoutRef.current);
    showTerminalLayout();focusTerminalPane(terminalLayoutRef.current.focused,false);requestTerminalLayoutFit();
  }
  function splitFocusedTerminalPane(axis:"horizontal"|"vertical"){
    let next;
    try{next=splitTerminalPane(terminalLayoutRef.current,axis,splitPercentRef.current);}catch(reason){setError(reason instanceof Error?reason.message:"Unable to split terminal pane.");return;}
    cancelLayoutRestore();cancelTerminalLayoutFit();detailVersion.current++;
    terminalLayoutRef.current=next;setTerminalLayout(next);showTerminalLayout();focusTerminalPane(next.focused,false);requestTerminalLayoutFit();
  }
  function terminalReopenCurrent(record:HiddenTerminal){
    const view=record.view;
    return terminalMounted.current&&terminalReopen.current===record&&desktopWindow.epoch===record.epoch&&ownerConnectionAvailable.current.available&&ownerConnectionAvailable.current.version===record.owner&&terminalViews.current.get(record.id)===view&&view.instance===record.instance&&view.desktopGeneration===record.generation&&terminalWindowClaim(record.id)===record.generation&&view.frameInstance===record.parser&&view.attachVersion===record.attachment&&view.lifecycleRevision===record.lifecycle&&view.live===record.live&&view.status===record.status&&!!view.record&&view.record.summary.session_id===record.id&&view.ready&&view.availability==="available"&&!terminalMembers(terminalLayoutRef.current).includes(record.id)&&!view.disposed&&!view.attaching&&!view.parsing&&!view.moving&&!view.updating&&!view.projecting&&!view.resizing&&!view.resizePending&&!view.selecting&&!view.clearPending&&!view.promptNavigationPending&&!view.scrollReturnPending&&!view.appearanceFitPending&&!layoutRestore.current.pending&&!desktopWindow.restore_blocked&&!creatingSession.current&&!terminalMoveTaskRef.current&&!terminalMoveIncomingRef.current&&!terminalMoveOperationRef.current;
  }
  function rememberHiddenTerminal(id:string,pane:string){
    const view=terminalViews.current.get(id);terminalReopen.current=null;
    if(!view)return;
    const record:HiddenTerminal={token:{},id,pane,view,instance:view.instance,epoch:desktopWindow.epoch,generation:view.desktopGeneration,owner:ownerConnectionAvailable.current.version,parser:view.frameInstance,attachment:view.attachVersion,lifecycle:view.lifecycleRevision,live:view.live,status:view.status};
    terminalReopen.current=record;if(!terminalReopenCurrent(record))terminalReopen.current=null;
    setRecoveryRevision(value=>value+1);
  }
  function canReopenTerminalTab(){const record=terminalReopen.current;return !!record&&!terminalReopenFlight.current&&!pendingViewClaims.current.has(record.id)&&terminalReopenCurrent(record);}
  async function reopenTerminalTab(){
    if(!canReopenTerminalTab())return;const record=terminalReopen.current!,operation={};terminalReopenFlight.current=operation;setRecoveryRevision(value=>value+1);
    const layout=terminalLayoutRef.current,selected=sessionId.current,selection=selectionVersion.current,zoom=terminalPaneZoomIntent.current;
    const target=terminalPaneIndex(layout,record.pane)>=0?record.pane:terminalPaneId(layout,layout.focused);
    if(!record.live&&!record.view.recordedOnly){try{await openTerminal(record.view.record!,target);}finally{if(terminalReopenFlight.current===operation){terminalReopenFlight.current=null;setRecoveryRevision(value=>value+1);}}return;}
    let entered=false,detail=detailVersion.current,restore=layoutRestore.current.version,claim=viewClaimSelection.current;
    const valid=()=>terminalReopenFlight.current===operation&&terminalReopenCurrent(record)&&terminalLayoutRef.current===layout&&sessionId.current===selected&&selectionVersion.current===selection&&terminalPaneZoomIntent.current===zoom&&(!entered||(detailVersion.current===detail&&layoutRestore.current.version===restore&&viewClaimSelection.current===claim));
    try{
      const pending=openHistory(record.view.record!,false,target,undefined,valid);
      entered=true;detail=detailVersion.current;restore=layoutRestore.current.version;claim=viewClaimSelection.current;
      const result=await pending;
      if(result?.view===record.view&&terminalReopen.current===record&&terminalMembers(terminalLayoutRef.current).includes(record.id)){terminalReopen.current=null;setRecoveryRevision(value=>value+1);}
    }finally{if(terminalReopenFlight.current===operation){terminalReopenFlight.current=null;if(terminalMounted.current)setRecoveryRevision(value=>value+1);}}
  }
  function closeTerminalPane(index:number){
    const before=terminalLayoutRef.current,id=before.panes[index],pane=terminalPaneId(before,index);
    cancelLayoutRestore();
    cancelTerminalLayoutFit();
    terminalLayoutRef.current=removeTerminalPane(terminalLayoutRef.current,index);setTerminalLayout(terminalLayoutRef.current);
    detailVersion.current++;showTerminalLayout();focusTerminalPane(terminalLayoutRef.current.focused,false);requestTerminalLayoutFit();
    if(id&&pane&&!terminalMembers(terminalLayoutRef.current).includes(id))rememberHiddenTerminal(id,pane);
    recoverRevealedTerminals(before);
  }
  function recoverRevealedTerminals(before:ReturnType<typeof createTerminalLayout>){
    const layout=terminalLayoutRef.current;
    for(let pane=0;pane<layout.panes.length;pane++){
      const id=layout.panes[pane],view=id?terminalViews.current.get(id):undefined;
      if(id&&!before.panes.includes(id)&&view?.record&&!view.recordedOnly&&terminalStatuses.has(view.status??view.record.status)){
        void openTerminal({...view.record,status:view.status??view.record.status},terminalPaneId(layout,pane),layoutRestore.current.version);
      }
    }
  }
  function selectTerminalTab(index:number,id:string){
    const layout=terminalLayoutRef.current;if(terminalSessionPane(layout,id)!==index)return;
    const view=terminalViews.current.get(id);
    if(!view?.record){void openSession(id,undefined,undefined,layoutPreferenceLoad.recordedOnly?.includes(id)??false,terminalPaneId(layout,index));return;}
    const origin=document.activeElement;
    const opening=view.recordedOnly?openHistory(view.record,false,terminalPaneId(layout,index)):openTerminal(view.record,terminalPaneId(layout,index));
    void opening.then(receipt=>{
      if(receipt&&terminalLayoutRef.current.panes[terminalLayoutRef.current.focused]===receipt.view.record?.summary.session_id
        &&(document.activeElement===origin||(origin?.isConnected===false&&document.activeElement===document.body)))focusTerminalPane(terminalLayoutRef.current.focused,true);
    });
  }
  function closeTerminalTab(index:number,id:string){
    const before=terminalLayoutRef.current,pane=terminalPaneId(before,index);
    const next=removeTerminalTab(terminalLayoutRef.current,index,id);if(next===terminalLayoutRef.current)return;
    cancelLayoutRestore();cancelTerminalLayoutFit();detailVersion.current++;
    terminalLayoutRef.current=next;setTerminalLayout(next);showTerminalLayout();focusTerminalPane(next.focused,false);requestTerminalLayoutFit();
    if(pane&&!terminalMembers(next).includes(id))rememberHiddenTerminal(id,pane);
    recoverRevealedTerminals(before);
  }
  function beginTerminalTabDrag(id:string,paneId:string):object|null{
    const layout=terminalLayoutRef.current,index=terminalSessionPane(layout,id);
    if(!terminalMounted.current||!ownerConnectionAvailable.current.available||layoutRestore.current.pending||creatingSession.current
      ||index<0||terminalPaneId(layout,index)!==paneId||(zoomedPaneIdRef.current!==null&&zoomedPaneIdRef.current!==paneId)||!terminalViews.current.get(id))return null;
    const token={id,paneId,revision:layout.revision,owner:ownerConnectionAvailable.current.version,zoom:terminalPaneZoomIntent.current,zoomed:zoomedPaneIdRef.current};
    terminalTabDrag.current=token;return token;
  }
  function cancelTerminalTabDrag(token:object){if(terminalTabDrag.current===token)terminalTabDrag.current=null;}
  function commitTerminalTabDrag(token:object,paneId:string,before:string|null,edge?:TerminalPaneEdge){
    const drag=terminalTabDrag.current;if(!drag||drag!==token)return;terminalTabDrag.current=null;
    const layout=terminalLayoutRef.current,source=terminalSessionPane(layout,drag.id),target=terminalPaneIndex(layout,paneId);
    if(!terminalMounted.current||!ownerConnectionAvailable.current.available||layoutRestore.current.pending||creatingSession.current
      ||drag.owner!==ownerConnectionAvailable.current.version||drag.revision!==layout.revision
      ||drag.zoom!==terminalPaneZoomIntent.current||drag.zoomed!==zoomedPaneIdRef.current
      ||source<0||terminalPaneId(layout,source)!==drag.paneId||target<0||(zoomedPaneIdRef.current!==null&&zoomedPaneIdRef.current!==paneId))return;
    if(edge!==undefined){
      if(before!==null)return;
      let next;try{next=splitAndMoveTerminalTab(layout,drag.id,paneId,edge);}catch{return;}
      applyTerminalTabMove(next,drag.id,true);
      return;
    }
    moveTerminalSession(drag.id,target,before);
  }
  function reorderTerminalSession(id:string,direction:"left"|"right"){
    const layout=terminalLayoutRef.current,index=terminalSessionPane(layout,id);if(index<0)return;
    const tabs=terminalTabs(terminalLeaves(terminalLayoutRoot(layout))[index]),position=tabs.indexOf(id);
    if(direction==="left"&&position>0)moveTerminalSession(id,index,tabs[position-1]);
    if(direction==="right"&&position<tabs.length-1)moveTerminalSession(id,index,tabs[position+2]??null);
  }
  function moveTerminalSession(id:string,target:number,before:string|null=null){
    const layout=terminalLayoutRef.current;let next;try{next=moveTerminalTab(layout,id,target,before);}catch{return;}
    if(next===layout)return;
    const view=terminalViews.current.get(id);if(!view)return;
    if(terminalSessionPane(layout,id)===target){terminalLayoutRef.current=next;setTerminalLayout(next);return;}
    applyTerminalTabMove(next,id);
  }
  function applyTerminalTabMove(next:ReturnType<typeof moveTerminalTab>,id:string,restoreZoom=false){
    const before=terminalLayoutRef.current,view=terminalViews.current.get(id);if(!view)return;
    view.attachVersion=(view.attachVersion??0)+1;view.attaching=false;
    cancelLayoutRestore();cancelTerminalLayoutFit();detailVersion.current++;
    terminalLayoutRef.current=next;setTerminalLayout(next);
    if(restoreZoom&&zoomedPaneIdRef.current!==null)setTerminalPaneZoom(null);
    showTerminalLayout();focusTerminalPane(next.focused,!restoreZoom);requestTerminalLayoutFit();
    if(restoreZoom&&view.ready){
      terminalTabFocus.current={paneId:terminalPaneId(next,next.focused),id,revision:next.revision,owner:ownerConnectionAvailable.current.version,zoom:terminalPaneZoomIntent.current,origin:document.activeElement,view,queued:false};
      requestTerminalTabFocus();
    }

    const recovering=!before.panes.includes(id)&&!view.recordedOnly&&terminalStatuses.has(view.status??view.record?.status??"");
    if(!view.ready&&view.record&&!recovering)void openHistory(view.record,false,terminalPaneId(next,next.focused),layoutRestore.current.version);
    recoverRevealedTerminals(before);
  }

  function requestTerminalTabFocus(){
    const intent=terminalTabFocus.current;if(!intent||intent.queued)return;intent.queued=true;
    requestAnimationFrame(()=>{
      if(terminalTabFocus.current!==intent)return;intent.queued=false;
      const current=terminalLayoutRef.current,index=terminalPaneIndex(current,intent.paneId),host=paneHosts.current.get(intent.paneId);
      if(!terminalMounted.current||!ownerConnectionAvailable.current.available||ownerConnectionAvailable.current.version!==intent.owner||terminalPaneZoomIntent.current!==intent.zoom
        ||current.revision!==intent.revision||index!==current.focused||current.panes[index]!==intent.id||terminalViews.current.get(intent.id)!==intent.view||intent.view.disposed||document.activeElement!==intent.origin){terminalTabFocus.current=null;return;}
      if(!host||intent.view.element.parentElement!==host)return;
      terminalTabFocus.current=null;focusTerminalPane(index,true);
    });
  }

  function requestTerminalLayoutFit(){
    if(terminalLayoutFitFrame.current!==null)return;
    const intent=terminalLayoutFitIntent.current;
    let frame=0;
    frame=requestAnimationFrame(()=>{
      if(terminalLayoutFitFrame.current!==frame)return;
      terminalLayoutFitFrame.current=null;
      if(intent!==terminalLayoutFitIntent.current||!terminalMounted.current)return;
      // Coalesced mount/tab requests must fit the current layout, not discard its newer revision.
      fitTerminalViews();
    });
    terminalLayoutFitFrame.current=frame;
  }
  function restoreTerminalSurface(){
    if(!terminalMounted.current||document.hidden||!ownerConnectionAvailable.current.available)return;
    // A hidden window can miss its first positive-size fit; waking must use the existing view.
    showTerminalLayout();requestTerminalLayoutFit();
    const layout=terminalLayoutRef.current,id=layout.panes[layout.focused],view=id?terminalViews.current.get(id):undefined,origin=document.activeElement;
    if(!id||!view?.ready||conversationOpenRef.current||!document.hasFocus()||(origin!==document.body&&!view.element.contains(origin)))return;
    terminalTabFocus.current={paneId:terminalPaneId(layout,layout.focused),id,revision:layout.revision,owner:ownerConnectionAvailable.current.version,zoom:terminalPaneZoomIntent.current,origin,view,queued:false};
    requestTerminalTabFocus();
  }
  function cancelTerminalLayoutFit(zoomGeneration?:number){
    if(zoomGeneration!==undefined&&zoomGeneration!==terminalPaneZoomIntent.current)return;
    terminalLayoutFitIntent.current++;
    const frame=terminalLayoutFitFrame.current;
    if(frame!==null){cancelAnimationFrame(frame);terminalLayoutFitFrame.current=null;}
  }
  function previewTerminalSplit(_value?:number,zoomGeneration?:number){if(zoomGeneration!==undefined&&zoomGeneration!==terminalPaneZoomIntent.current)return;cancelTerminalLayoutFit();requestTerminalLayoutFit();}
  function commitTerminalNodeSplit(nodeId:string,value:number,zoomGeneration=terminalPaneZoomIntent.current){
    if(zoomedPaneIdRef.current||zoomGeneration!==terminalPaneZoomIntent.current)return;
    const layout=terminalLayoutRef.current,next=resizeTerminalNode(layout,nodeId,value);
    cancelTerminalLayoutFit();
    if(next!==layout){if(next.root?.kind==="split")splitPercentRef.current=next.root.ratio;terminalLayoutRef.current=next;setTerminalLayout(next);}
    requestTerminalLayoutFit();
  }
  function commitTerminalSplit(value:number){
    const next=clampSplitPercent(value),layout=terminalLayoutRef.current,root=terminalLayoutRoot(layout,splitPercentRef.current);
    if(root.kind!=="split")return;
    const updated=resizeTerminalNode(layout,root.nodeId,next);
    cancelTerminalLayoutFit();
    if(updated!==layout){splitPercentRef.current=next;terminalLayoutRef.current=updated;setTerminalLayout(updated);}
    requestTerminalLayoutFit();
  }

  function canSwapTerminalPanes(target?:number){
    const layout=terminalLayoutRef.current;
    const paneCount=layout.mode==="grid"?4:layout.mode==="horizontal"||layout.mode==="vertical"?2:0;
    const targetIndex=target??(paneCount===2?(layout.focused===0?1:0):-1);
    if(!paneCount||layout.panes.length!==paneCount||!Number.isSafeInteger(targetIndex)||targetIndex<0||targetIndex>=layout.panes.length||targetIndex===layout.focused||layout.panes[targetIndex]===layout.panes[layout.focused]||layoutRestore.current.pending||creatingSession.current||!ownerConnectionAvailable.current.available)return false;
    return layout.panes.every(id=>{
      if(id===null)return true;
      const view=terminalViews.current.get(id);
      return !!view&&!view.disposed&&view.ready&&!view.attaching&&!view.parsing&&view.availability!=="owner_unavailable"&&view.availability!=="terminal_unavailable";
    });
  }
  function swapTerminalPane(target?:number){
    if(!canSwapTerminalPanes(target))return;
    const current=terminalLayoutRef.current;
    const targetIndex=target??(current.focused===0?1:0);
    const next=swapTerminalPanes(current,current.focused,targetIndex);
    if(next===current)return;
    cancelTerminalLayoutFit();
    terminalLayoutRef.current=next;setTerminalLayout(next);showTerminalLayout();requestTerminalLayoutFit();
  }
  function refreshTerminalScroll(view:TerminalView,endOffset?:number) {
    if(view.disposed||view.moving||view.projecting)return;
    const buffer=view.instance.buffer?.active;if(!buffer)return;
    const state=view.scroll??(view.scroll=createTerminalScroll());
    if(updateTerminalScroll(state,buffer,endOffset)&&sessionId.current===view.element.dataset.sessionId)setRecoveryRevision(revision=>revision+1);
  }
  function canNavigateReportedPrompt(direction:"previous"|"next"):boolean{
    const id=sessionId.current,view=id?terminalViews.current.get(id):null;
    return !!view&&terminalPaneVisible(id!)&&view.ready&&view.live&&view.projection&&!view.selecting&&terminalWindowClaim(id!)===view.desktopGeneration&&typeof view.frameInstance==="string"&&/^[a-f0-9]{64}$/.test(view.frameInstance)&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop')&&!view.persisted&&!view.disposed&&!view.moving&&!view.attaching&&!view.parsing&&!view.resizing&&!view.resizePending&&!view.promptNavigationPending&&view.availability==="available"&&ownerConnectionAvailable.current.available&&!view.record?.summary.command&&!view.record?.summary.launch&&!view.record?.summary.ssh&&!!view.reportedPromptNavigation?.[direction];
  }
  async function navigateReportedPrompt(direction:"previous"|"next"){
    if(!canNavigateReportedPrompt(direction))return;
    const id=sessionId.current!,view=terminalViews.current.get(id)!;
    const epoch=desktopWindow.epoch,generation=view.desktopGeneration,instance=view.frameInstance,attachment=view.attachVersion,lifecycle=view.lifecycleRevision,connection=ownerConnectionAvailable.current.version,selection=selectionVersion.current,intent=++view.viewportRevision;
    const valid=()=>terminalMounted.current&&sessionId.current===id&&terminalViews.current.get(id)===view&&terminalPaneVisible(id)&&!view.disposed&&!view.moving&&!view.resizing&&!view.resizePending&&view.desktopGeneration===generation&&desktopWindow.epoch===epoch&&view.frameInstance===instance&&view.attachVersion===attachment&&view.lifecycleRevision===lifecycle&&view.viewportRevision===intent&&selectionVersion.current===selection&&terminalWindowClaim(id)===generation&&ownerConnectionAvailable.current.available&&ownerConnectionAvailable.current.version===connection;
    view.promptNavigationPending=true;setRecoveryRevision(value=>value+1);
    try{const reply=await invoke<{status:"moved"|"unavailable"|"stale"}>("navigate_reported_prompt",{desktopEpoch:epoch,desktopGeneration:generation,sessionId:id,direction,expectedInstance:instance});if(valid()){if(!reply||!["moved","unavailable","stale"].includes(reply.status)||Object.keys(reply).length!==1)throw Error("Invalid reported prompt navigation reply");view.dirty=true;if(reply.status!=="moved")view.reportedPromptNavigation=null;}}
    catch(reason){if(valid())setError(String(reason));}
    finally{view.promptNavigationPending=false;if(terminalMounted.current&&terminalViews.current.get(id)===view)setRecoveryRevision(value=>value+1);}
  }
  function canClearTerminalDisplay(){
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    return !!view&&terminalMounted.current&&terminalPaneVisible(id!)&&view.ready&&view.live&&!view.persisted&&view.projection&&view.clearDisplayVersion===1&&view.instance.buffer.active.type==="normal"&&!view.disposed&&!view.moving&&!view.attaching&&!view.parsing&&!view.updating&&!view.resizing&&!view.resizePending&&!view.selecting&&!view.clearPending&&!view.promptNavigationPending&&!view.scrollReturnPending&&view.availability==="available"&&ownerConnectionAvailable.current.available&&terminalWindowClaim(id!)===view.desktopGeneration&&typeof view.frameInstance==="string"&&/^[a-f0-9]{64}$/.test(view.frameInstance)&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop');
  }
  async function clearTerminalDisplay(){
    if(!canClearTerminalDisplay())return;
    const id=sessionId.current!,view=terminalViews.current.get(id)!,instance=view.instance,epoch=desktopWindow.epoch,generation=view.desktopGeneration,owner=view.frameInstance,attachment=view.attachVersion,lifecycle=view.lifecycleRevision,connection=ownerConnectionAvailable.current.version,selection=selectionVersion.current,intent=++view.viewportRevision;
    const attached=()=>terminalMounted.current&&!view.disposed&&!view.moving&&terminalViews.current.get(id)===view&&view.instance===instance&&view.desktopGeneration===generation&&desktopWindow.epoch===epoch&&view.frameInstance===owner&&view.attachVersion===attachment&&view.lifecycleRevision===lifecycle&&terminalWindowClaim(id)===generation&&ownerConnectionAvailable.current.available&&ownerConnectionAvailable.current.version===connection;
    const current=()=>attached()&&sessionId.current===id&&terminalPaneVisible(id)&&view.viewportRevision===intent&&selectionVersion.current===selection;
    view.clearPending=true;setRecoveryRevision(value=>value+1);
    try{
      const reply=await invoke<unknown>("clear_terminal_display",{desktopEpoch:epoch,desktopGeneration:generation,sessionId:id,expectedInstance:owner});
      const field=reply&&typeof reply==="object"&&!Array.isArray(reply)?Object.getOwnPropertyDescriptor(reply,"status"):null;
      if(!field||!("value" in field)||Reflect.ownKeys(reply as object).length!==1||!["cleared","unavailable","stale"].includes(field.value))throw Error("Invalid terminal clear reply");
      if(attached()&&field.value==="cleared"){view.dirty=true;if(current()){view.find?.close();instance.clearSelection();if(pastePending.current?.target.view===view)cancelTerminalPaste(false);if(filePending.current?.view===view)cancelTerminalFile();if(fileDropPending.current?.target.view===view)cancelTerminalFileDrop();setError(null);}}
      else if(current())setError("Terminal display clear is unavailable. Nothing was retried.");
    }catch{if(attached())view.dirty=true;if(current())setError("Terminal display clear could not be confirmed. Nothing was retried.");}
    finally{view.clearPending=false;if(terminalMounted.current&&terminalViews.current.get(id)===view)setRecoveryRevision(value=>value+1);}
  }
  function handleTerminalScroll(view:TerminalView,id:string,line:number) {
    if(view.disposed||view.moving||view.projecting)return;
    refreshTerminalScroll(view);
    if(!view.projection||!view.live)return;
    const viewport=++view.viewportRevision,owner=view.frameInstance,attachment=view.attachVersion,lifecycle=view.lifecycleRevision,connection=ownerConnectionAvailable.current.version;
    const generation=view.desktopGeneration,focused=terminalHasInputFocus(id);
    view.scrollReturnPending=false;
    if(view.clearPending){return;}
    const valid=()=>!view.disposed&&!view.moving&&view.desktopGeneration===generation&&(!focused||(sessionId.current===id&&terminalHasInputFocus(id)))&&terminalViews.current.get(id)===view&&view.viewportRevision===viewport&&view.frameInstance===owner&&view.attachVersion===attachment&&view.lifecycleRevision===lifecycle&&ownerConnectionAvailable.current.version===connection;
    void invoke("set_terminal_viewport",{desktopGeneration:view.desktopGeneration,sessionId:id,line}).then(()=>{if(valid())view.dirty=true;}).catch(reason=>{if(valid()&&sessionId.current===id)setError(String(reason));});
  }
  async function returnTerminalToLive() {
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!id||!view||view.moving||!view.projection||!view.frameInstance||view.disposed||!view.ready||view.attaching||view.parsing||view.clearPending||view.scrollReturnPending||!view.scroll?.held||view.availability==="owner_unavailable"||view.availability==="terminal_unavailable"||!ownerConnectionAvailable.current.available)return;
    if(!view.live){
      if(!view.persisted)return;
      const generation=view.desktopGeneration,attachment=view.attachVersion,connection=ownerConnectionAvailable.current.version;
      view.projecting=true;
      try{view.instance.scrollToBottom();}
      catch{if(sessionId.current===id&&terminalViews.current.get(id)===view&&!view.disposed&&!view.moving&&view.desktopGeneration===generation&&view.attachVersion===attachment&&ownerConnectionAvailable.current.version===connection)setError("Terminal bottom navigation is unavailable.");return;}
      finally{view.projecting=false;}
      refreshTerminalScroll(view);return;
    }

    const viewport=++view.viewportRevision,owner=view.frameInstance,attachment=view.attachVersion,lifecycle=view.lifecycleRevision,connection=ownerConnectionAvailable.current.version;
    const generation=view.desktopGeneration,focused=terminalHasInputFocus(id);
    const intent=view.scrollReturnIntent=(view.scrollReturnIntent??0)+1;
    view.scrollReturnPending=true;setRecoveryRevision(revision=>revision+1);
    const attached=()=>terminalMounted.current&&!view.disposed&&!view.moving&&view.desktopGeneration===generation&&(!focused||(sessionId.current===id&&terminalHasInputFocus(id)))&&terminalViews.current.get(id)===view&&view.frameInstance===owner&&view.attachVersion===attachment&&view.lifecycleRevision===lifecycle&&ownerConnectionAvailable.current.version===connection;
    const valid=()=>attached()&&view.viewportRevision===viewport;
    try{await invoke("set_terminal_viewport",{desktopGeneration:view.desktopGeneration,sessionId:id,line:0,bottom:true});if(valid())view.dirty=true;}
    catch(reason){if(valid()&&sessionId.current===id)setError(String(reason));}
    finally{if(view.scrollReturnIntent===intent){view.scrollReturnPending=false;if(attached()&&sessionId.current===id)setRecoveryRevision(revision=>revision+1);}}
  }
  function pollTerminalFrames(){
    if(!terminalMounted.current||document.hidden)return;
    const panes=terminalLayoutRef.current.panes;
    for(let slot=0;slot<panes.length;slot++){
      const id=panes[slot],view=id?terminalViews.current.get(id):undefined;
      if(!id||!terminalPaneVisible(id)||!view?.projection||!view.dirty||view.updating||view.selecting||view.clearPending||(view.find?view.find.blocksProjection():view.instance.hasSelection())||view.disposed||view.moving)continue;
      view.updating=true;view.dirty=false;
      const lifecycle=view.lifecycleRevision,viewport=view.viewportRevision,owner=view.frameInstance,attachment=view.attachVersion;
      const valid=()=>terminalMounted.current&&!view.disposed&&terminalViews.current.get(id)===view&&terminalPaneVisible(id)
        &&view.attachVersion===attachment&&view.frameInstance===owner&&view.viewportRevision===viewport;
      void invoke<TerminalFrame|null>("read_terminal_frame",{desktopGeneration:view.desktopGeneration,sessionId:id}).then(async frame=>{
        if(!valid()){if(!view.disposed)view.dirty=true;return;}
        if(frame)await renderFrame(view,id,frame,lifecycle,valid);
      }).catch(reason=>{
         if(valid()) {
           view.clearDisplayVersion=null;view.reportedCwd=null;view.reportedCwdSequence=-1;view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;
           view.reportedPromptNavigation=null;view.reportedCommand=null;
      if(view.availability!=="terminal_unavailable") {view.availability="terminal_unavailable";setRecoveryRevision(revision=>revision+1);}
           if(sessionId.current===id) {
             setSessionStatus("unavailable");
             setTerminalNotice("This terminal state is unavailable. The previous terminal state cannot be restored here.");
             setError(String(reason));
           }
         }
       }).finally(()=>{view.updating=false;});
    }
  }

  function createTerminalView(id: string,appearance?:TerminalSettings): TerminalView {
    if (!createView.current) throw new Error("Terminal is not ready");
    const view = createView.current(id,appearance);
    view.element.dataset.sessionId = id;
    view.availability=ownerConnectionAvailable.current.available?"available":"owner_unavailable";
    return view;
  }

  async function renderFrame(view:TerminalView,id:string,frame:TerminalFrame,lifecycleRevision:number,valid=()=>!view.disposed) {
    const attachment=view.attachVersion,connectionVersion=ownerConnectionAvailable.current.version,generation=view.desktopGeneration,instance=view.instance;
    const current=()=>valid()&&terminalMounted.current&&!view.disposed&&!view.moving&&terminalViews.current.get(id)===view&&view.instance===instance&&view.desktopGeneration===generation&&view.attachVersion===attachment&&ownerConnectionAvailable.current.version===connectionVersion;
    if(!current())return;
    validateTerminalFrame(frame,id);
    if(view.frameInstance && view.live && frame.projection.instance!==view.frameInstance) {
      if(view.clearDisplayVersion||view.reportedCwd||view.reportedCommand||view.reportedPromptNavigation){view.clearDisplayVersion=null;view.reportedCwd=null;view.reportedPromptNavigation=null;view.reportedCommand=null;setRecoveryRevision(revision=>revision+1);}view.reportedCwdSequence=-1;view.reportedCommandSequence=-1;view.reportedCommandPair=null;
      throw Error("The terminal owner changed; the previous live state is unavailable.");
    }
    while(view.parsing) await view.parsing;
    if(!current())return;
    if(view.frameInstance===frame.projection.instance && frame.projection.revision<view.frameRevision) return;
    const newOwner=view.frameInstance!==frame.projection.instance;
    if(newOwner)view.writable=false;
    view.projection=true;
    if(frame.projection.revision!==view.frameRevision || view.frameInstance!==frame.projection.instance || !view.ready) {
      view.find?.beforeFrame();
      view.projecting=true;
      const parsing=view.parsing=applyTerminalFrame(view.instance,frame,id);
      try{await parsing;}catch(reason){if(current()){const changed=!!view.clearDisplayVersion||!!view.reportedPromptNavigation||!!view.reportedCommand;view.clearDisplayVersion=null;view.reportedPromptNavigation=null;view.reportedCommand=null;if(changed)setRecoveryRevision(revision=>revision+1);}throw reason;}finally{view.projecting=false;if(view.parsing===parsing)view.parsing=null;}
      if(!current())return;
      view.frameRevision=frame.projection.revision;view.frameInstance=frame.projection.instance;
      const viewport=view.viewportRevision;
      void view.find?.afterFrame(()=>current()&&view.lifecycleRevision===lifecycleRevision&&view.viewportRevision===viewport&&!view.resizing&&!view.scrollReturnPending);
    }
    if(view.availability!=="available") {view.availability="available";setRecoveryRevision(revision=>revision+1);}
    ownerConnectionAvailable.current.available=true;
    view.persisted=frame.persisted===true && terminalStatuses.has(frame.status);
    view.cursor=frame.end_offset;view.ready=true;view.firstAttachment=false;
    if(view.lifecycleRevision===lifecycleRevision){if(newOwner)view.scroll=createTerminalScroll();refreshTerminalScroll(view,frame.end_offset);}
    if(view.lifecycleRevision===lifecycleRevision){view.status=frame.status;view.live=["starting","running"].includes(frame.status);}
    if(terminalViews.current.get(id)===view&&view.lifecycleRevision===lifecycleRevision){
      if(newOwner){view.reportedCommandSequence=-1;view.reportedCommandPair=null;}
      const clearVersion=!frame.persisted&&view.live?terminalClearDisplayVersion(frame):null;if(clearVersion!==(view.clearDisplayVersion??null)){view.clearDisplayVersion=clearVersion;setRecoveryRevision(value=>value+1);}
      const navigation=terminalReportedPromptNavigation(frame);
      const nextNavigation=!frame.persisted&&view.live&&frame.projection.buffer==="normal"&&!view.record?.summary.command&&!view.record?.summary.launch&&!view.record?.summary.ssh?navigation:null;
      if(JSON.stringify(nextNavigation)!==JSON.stringify(view.reportedPromptNavigation??null)){view.reportedPromptNavigation=nextNavigation;setRecoveryRevision(value=>value+1);}
      const command=terminalReportedCommand(frame);let nextCommand=view.reportedCommand??null;
      const eligible=!frame.persisted&&view.live&&frame.projection.buffer==="normal"&&!view.record?.summary.command&&!view.record?.summary.launch&&!view.record?.summary.ssh;
      if(!eligible||!command)nextCommand=null;
      else {
        const pair=JSON.stringify([command.phase,command.last_exit]);
        if(command.sequence>(view.reportedCommandSequence??-1)){view.reportedCommandSequence=command.sequence;view.reportedCommandPair=pair;nextCommand=command;}
        else if(command.sequence<(view.reportedCommandSequence??-1)||pair!==view.reportedCommandPair)nextCommand=null;
      }
      if(JSON.stringify(nextCommand)!==JSON.stringify(view.reportedCommand??null)){view.reportedCommand=nextCommand;setRecoveryRevision(revision=>revision+1);}
      const report=terminalReportedCwd(frame);
      let path=view.reportedCwd??null;
      if(newOwner)view.reportedCwdSequence=-1;
      if(frame.persisted||!["starting","running"].includes(frame.status)||!view.live){path=null;}
      else if(!report){path=null;}
      else if(report.sequence>(view.reportedCwdSequence??-1)) {view.reportedCwdSequence=report.sequence;path=report.path;}
      if(path!==(view.reportedCwd??null)){view.reportedCwd=path;setRecoveryRevision(revision=>revision+1);}
    }
    view.element.inert=!terminalPaneVisible(id)||!view.ready;
    view.notice=view.live?null:view.record?.summary.ssh?"Saved terminal scene. Reconnect SSH to continue.":"The previous process ended. Type to open a new terminal here; the previous task will not be rerun.";
    terminalViews.current.setRunning(id,view.live);
    if(sessionId.current===id){outputCursor.current=view.cursor;setSessionStatus(view.status??frame.status);setTerminalNotice(view.notice);}
  }
  async function claimWindowView(id:string){try{return await invoke<number|null>("claim_terminal_view",{sessionId:id});}catch(reason){setError(String(reason));return false;}}
  function migrateTerminalMetadata(previous:string,next:string){
    if(previous===next)return;
    const titles=titlesRef.current,title=titles[previous],pins=pinnedSessionsRef.current;
    try{
      if(title&&!titles[next]&&localStorage.getItem(`yam.sessionName.${next}`)===null){
        const updated={...titles,[next]:title};
        if(isMainWindow)localStorage.setItem("yam.sessionTitles",JSON.stringify(updated));
        titlesRef.current=updated;setSessionTitles(updated);
      }
      if(pins.includes(previous)){
        const updated=[...new Set(pins.map(id=>id===previous?next:id))];
        if(isMainWindow)localStorage.setItem("yam.pinnedSessions",JSON.stringify(updated));
        pinnedSessionsRef.current=updated;setPinnedSessions(updated);
      }
      if(localStorage.getItem(`yam.sessionLaunch.${next}`)===null&&localStorage.getItem(`yam.sessionLaunch.${previous}`)!==null){
        const settings=readSessionLaunchSettings(localStorage,previous);if(settings)saveSessionLaunchSettings(localStorage,next,settings);
      }
    }catch{setError("Session name, pin, or launch settings could not be saved. The terminal is running.");}
  }
  async function openTerminal(record:SessionRecord,pane?:number|string,restoreVersion?:number,scopeValid?:()=>boolean,appearance?:TerminalSettings){
    return openHistory(record,false,pane,restoreVersion,scopeValid,appearance,undefined,undefined,terminalStatuses.has(record.status));
  }
  async function openHistory(record: SessionRecord, firstAttachment=false, pane?:number|string, restoreVersion?:number, scopeValid?:()=>boolean,appearance?:TerminalSettings,moveReceipt?:TerminalMoveReceipt,replaceFrom?:string,recordedOnly?:boolean,onSelected?:()=>void) {
    if(scopeValid&&!scopeValid())return;
    if(restoreVersion===undefined)cancelLayoutRestore();
    const connectionVersion=ownerConnectionAvailable.current.version;
    const restoreValid=()=>restoreVersion===undefined||(terminalMounted.current&&layoutRestore.current.version===restoreVersion);
    if(!restoreValid())return;
    if(restoreVersion===undefined)detailVersion.current++;
    const focusOrigin = document.activeElement;
    const id = record.summary.session_id;
    const openingDetail=detailVersion.current,openingIntent=layoutRestore.current.version,openingClaim=++viewClaimSelection.current;
    const openingPane=pane===undefined?null:terminalPaneId(terminalLayoutRef.current,typeof pane==="string"?terminalPaneIndex(terminalLayoutRef.current,pane):pane);
    if(openingPane!==null&&restoreVersion===undefined){for(const key of paneClaimSelection.current.keys()){if(terminalPaneIndex(terminalLayoutRef.current,key)<0)paneClaimSelection.current.delete(key);}paneClaimSelection.current.set(openingPane,openingClaim);}
    const admission=pendingViewClaims.current.get(id)??{count:0,generation:0};admission.count++;pendingViewClaims.current.set(id,admission);
    try {
    const generation=moveReceipt?(terminalWindowClaim(id)===moveReceipt.target_generation?moveReceipt.target_generation:false):await claimWindowView(id);
    if(typeof generation==="number")admission.generation=Math.max(admission.generation,generation);
    if(!generation||!restoreValid()||!terminalMounted.current||ownerConnectionAvailable.current.version!==connectionVersion||(restoreVersion===undefined&&pane===undefined&&(detailVersion.current!==openingDetail||layoutRestore.current.version!==openingIntent))||(openingPane!==null&&(terminalPaneIndex(terminalLayoutRef.current,openingPane)<0||(restoreVersion===undefined&&paneClaimSelection.current.get(openingPane)!==openingClaim)))||(scopeValid&&!scopeValid()))return;
    let scopeDetail:number|undefined,scopeIntent:number|undefined;
    // Focus/setup changes intent synchronously; freeze it before the first read awaits.
    const scopeCurrent=()=>!scopeValid||(scopeValid()&&(scopeDetail===undefined
      ||(detailVersion.current===scopeDetail&&layoutRestore.current.version===scopeIntent&&sessionId.current===id)));
    let existing = terminalViews.current.get(id);
    const inspecting=recordedOnly??existing?.recordedOnly;
    if(existing?.moving)return;
    if(existing&&existing.desktopGeneration!==generation){existing.moveDisposal=true;terminalViews.current.retain(other=>other!==existing);existing=undefined;}
    if (creatingSession.current && !existing && !firstAttachment) {
      setError("A session is starting. Select an already open terminal or wait for startup to finish.");
      return;
    }
    const status = existing?.status ?? record.status;
    const currentLayout=terminalLayoutRef.current;
    const baseLayout=replaceFrom?replaceTerminalSession(currentLayout,replaceFrom,id):currentLayout;
    const target=typeof pane==="string"?terminalPaneIndex(baseLayout,pane):pane??baseLayout.focused;
    if(target<0)return;
    let nextLayout;
    try{nextLayout=restoreVersion===undefined?assignTerminalPane(baseLayout,target,id):baseLayout;}catch(reason){setError(String(reason));return;}
    if(restoreVersion!==undefined||openingClaim!==viewClaimSelection.current)nextLayout.focused=currentLayout.focused;
    const slot=terminalSessionPane(nextLayout,id),attachedPane=terminalPaneId(nextLayout,slot);
    if(restoreVersion===undefined&&zoomedPaneIdRef.current&&attachedPane!==zoomedPaneIdRef.current)setTerminalPaneZoom(null);
    if(slot<0)return;
    let view: TerminalView;
    try {
      terminalViews.current.setProtected(terminalMembers(nextLayout));
      view = terminalViews.current.open(id, existing?.live ?? ["starting", "running"].includes(status), () => createTerminalView(id,appearance));
    } catch (reason) {terminalViews.current.setProtected(terminalMembers(currentLayout));setError(String(reason));return;}
    if(inspecting!==undefined)view.recordedOnly=inspecting;
    terminalLayoutRef.current=nextLayout;setTerminalLayout(nextLayout);
    if(existing?.ready&&existing.desktopGeneration===generation&&!existing.attaching&&existing.availability!=="owner_unavailable"&&existing.availability!=="terminal_unavailable"&&restoreVersion===undefined&&!firstAttachment){
      showTerminalLayout();focusTerminalPane(nextLayout.focused,false);requestTerminalLayoutFit();return {view,attachment:view.attachVersion,detail:detailVersion.current,intent:layoutRestore.current.version};
    }
    const version=view.attachVersion=(view.attachVersion??0)+1;
    view.reportedPromptNavigation=null;view.reportedCommand=null;view.reportedCommandSequence=-1;view.reportedCommandPair=null;
    if(!view.attaching){view.attaching=true;setRecoveryRevision(revision=>revision+1);}
    const attached=()=>scopeCurrent()&&terminalMounted.current&&ownerConnectionAvailable.current.version===connectionVersion&&restoreValid()&&!view.disposed&&terminalViews.current.get(id)===view&&terminalSessionPane(terminalLayoutRef.current,id)===terminalPaneIndex(terminalLayoutRef.current,attachedPane)&&view.attachVersion===version;
    const focused=()=>attached()&&terminalLayoutRef.current.panes[terminalLayoutRef.current.focused]===id&&terminalPaneId(terminalLayoutRef.current,terminalLayoutRef.current.focused)===attachedPane;
    if(!["starting","running"].includes(status)){view.reportedCwd=null;view.reportedPromptNavigation=null;view.reportedCommand=null;}
    view.record={...record,status};view.status=status;view.live=["starting","running"].includes(status);
    showTerminalLayout();
    if(focused())focusTerminalPane(terminalPaneIndex(terminalLayoutRef.current,attachedPane),false,restoreVersion!==undefined);
    // Native focus restoration is safe after selection; do not hold the modal for frame rendering.
    onSelected?.();
    scopeDetail=detailVersion.current;scopeIntent=layoutRestore.current.version;
    try {
      view.lifecycleRevision??=0;
      const lifecycleRevision=view.lifecycleRevision;
      const frame=await invoke<TerminalFrame|null>("read_terminal_frame",{desktopGeneration:view.desktopGeneration,sessionId:id});
      if(!attached()) return;
      if(frame){view.dirty=false;await renderFrame(view,id,frame,lifecycleRevision,attached);if(attached())pendingOutput.current.delete(id);}
      if(!attached())return;
      let replay: ReturnType<typeof replayOutput> | null = null;
      if(!view.ready&&view.cursor!==null&&(restoreVersion!==undefined||view.availability==="owner_unavailable"||!!scopeValid)){
        await view.parsing;
        if(!attached())return;
        view.cursor=null;
      }
      if (view.cursor === null) {
        const replayVersion = view.replayVersion = (view.replayVersion ?? 0) + 1;
        view.finishReplay?.();
        view.finishReplay = null;
        view.ready = false;
        // Only the creator can authorize startup query responses; cold history suppresses old queries.
        view.firstAttachment ||= firstAttachment;
      for (let attempt = 0; attempt < 3; attempt++) {
        const snapshot = await invoke<LogSnapshot>("read_session_snapshot", {desktopGeneration:view.desktopGeneration, sessionId: id });
        if (!attached()) return;
        if (snapshot.status && !pendingState.current.has(id)) {
          view.live = ["starting", "running"].includes(snapshot.status);
          view.status = snapshot.status;
          terminalViews.current.setRunning(id, view.live);
          view.record={...view.record,status:snapshot.status};
          if(focused()){setSessionStatus(snapshot.status);selectedRecord.current=view.record;}
        }
        if (snapshot.offset > 0 || !view.live) {
          view.notice = "Recorded log only: cold replay may omit earlier output and cannot fully restore alternate-screen, cursor or terminal parser state.";
          if(focused())setTerminalNotice(view.notice);
        }
        try { replay = replayOutput(snapshot, pendingOutput.current.drain(id)); break; }
        catch (reason) { if (attempt === 2) throw reason; }
      }
      if (!replay || !attached()) return;
      // A fresh creator's authenticated live snapshot authorizes its startup replies before parsing.
      if(firstAttachment&&view.live){if(view.availability!=="available") {view.availability="available";setRecoveryRevision(revision=>revision+1);}ownerConnectionAvailable.current.available=true;}
      view.cursor = replay.nextOffset;
      if(focused()){outputCursor.current=view.cursor;setAgentPhase("idle");agentOutputWindow.current="";}
      view.instance.reset();
      const replayData = replay.data || (terminalStatuses.has(selectedRecord.current?.status ?? record.status) ? "(No output recorded)\r\n" : "");
      const parsing=new Promise<void>(resolve => {view.finishReplay=resolve;view.instance.write(replayData, () => {
        if (terminalMounted.current && ownerConnectionAvailable.current.version===connectionVersion && view.replayVersion === replayVersion && !view.disposed && restoreValid() && scopeCurrent()) {
          view.ready = true;
          if(view.availability!=="available") {view.availability="available";setRecoveryRevision(revision=>revision+1);}
          ownerConnectionAvailable.current.available=true;
          view.firstAttachment=false;
          view.element.inert = !terminalPaneVisible(id)||!view.ready;
          view.finishReplay=null;
        }
        resolve();
      });});
      view.parsing=parsing;
      await parsing;
      if (view.parsing === parsing) view.parsing=null;
      if(focused())updateAgentPhase(replay.data);
      }
      await view.parsing;
      if (!attached()) return;
      if (view.projection) terminalViews.current.retain(other =>
        terminalMembers(terminalLayoutRef.current).includes(other.element.dataset.sessionId!) || other === view || other.live || !other.projection || !other.persisted || !!other.parsing || other.updating);
      const bufferedState = pendingState.current.get(id);
      if (bufferedState) {
        pendingState.current.delete(id);
        view.live=["starting","running"].includes(bufferedState.status);
        view.status=bufferedState.status;
        terminalViews.current.setRunning(id,view.live);
        if (focused()) applyStateEvent(view.instance, bufferedState);
      }
      if(firstAttachment&&view.live&&!view.disposed)view.writable=true;
      requestAnimationFrame(() => {
        if (!attached()) return;
        if(!terminalPaneVisible(id)||!terminalPaneHasSize(view))return;
        view.viewportRevision++;view.fit.fit();
        if (focused() && !focusOrigin?.closest?.("dialog")?.open && (document.activeElement === focusOrigin || (focusOrigin?.isConnected === false && document.activeElement === document.body))) view.instance.focus();
        syncViewSize(view);

      });
      return {view,attachment:version,detail:scopeDetail??detailVersion.current,intent:scopeIntent??layoutRestore.current.version};
    } catch (reason: unknown) {
      if (!attached()) return;
      view.cursor = null;view.writable=false;
      if(view.availability!=="terminal_unavailable") {view.availability="terminal_unavailable";setRecoveryRevision(revision=>revision+1);}
      view.firstAttachment=false;
      if(focused()){outputCursor.current=null;setSessionStatus("unavailable");setError(reason instanceof Error ? reason.message : String(reason));}
    } finally {
      if(view.attachVersion===version&&view.attaching){view.attaching=false;setRecoveryRevision(revision=>revision+1);}
    }
    } finally {
      admission.count--;
      if(admission.count===0){
        pendingViewClaims.current.delete(id);
        if(!moveReceipt&&admission.generation>0&&!terminalViews.current.get(id)){
          try{await invoke("release_terminal_view",{sessionId:id,desktopGeneration:admission.generation});}
          catch(reason){setError(String(reason));}
        }
      }
    }
  }

  function canContinueTerminalInput(id:string,view:TerminalView){
    return terminalMounted.current&&ownerConnectionAvailable.current.available&&terminalViews.current.get(id)===view&&sessionId.current===id&&terminalPaneVisible(id)&&view.ready&&!view.live&&!view.disposed&&!view.moving&&!view.attaching&&view.availability==="available"&&!!view.record&&terminalStatuses.has(view.status??view.record.status)&&!view.record.summary.ssh;
  }
  function continueTerminalInput(id:string,view:TerminalView,data:string,paste=false){
    if(!canContinueTerminalInput(id,view)||!terminalHasInputFocus(id)||!data)return;
    const existing=view.continuation;
    const pending=existing??{chunks:[],length:0,cancelled:false};
    if(pending.length+data.length>262144||pending.chunks.length>=256){pending.cancelled=true;pending.chunks=[];setError("Too much pending terminal input. Unsent input was discarded; check the prompt before typing again.");return;}
    pending.chunks.push({data,paste});pending.length+=data.length;
    if(existing)return;
    view.continuation=pending;
    const origin=view.instance.textarea;
    void (async()=>{
      const next=await newTerminal(view.record!.summary.cwd,null,view.appearance);
      const target=next?terminalViews.current.get(next.session_id):undefined;
      if(!next||!target?.ready||!target.live||target.disposed||pending.cancelled||sessionId.current!==next.session_id||document.activeElement!==origin&&document.activeElement!==target.instance.textarea&&document.activeElement!==document.body){setError("Terminal input was not sent. Check the current terminal before typing again.");return;}
      target.instance.focus();
      if(!terminalHasInputFocus(next.session_id)){setError("Terminal input was not sent. Check the current terminal before typing again.");return;}
      for(const chunk of pending.chunks){if(chunk.paste)target.instance.paste(chunk.data);else target.instance.input(chunk.data,true);}
      const write=target.inputQueue?.write;
      if(!write){setError("Terminal input was not sent. Check the current terminal before typing again.");return;}
      await write;
    })().catch(()=>setError("Terminal input was not sent. Check the current terminal before typing again.")).finally(()=>{pending.chunks=[];if(view.continuation===pending)view.continuation=undefined;});
  }

  function selectedRecovery() {
    return sessionRecovery(selectedRecord.current, sessionId.current, session?.session_id ?? null,
      sessionStatus, starting, ownerConnectionAvailable.current.available
        ? terminalViews.current.get(sessionId.current ?? "")?.availability ?? "available" : "owner_unavailable");
  }
  function openSelectedTerminal(){if(session&&selectedRecovery().canOpenTerminal)void newTerminal(session.cwd,null);}
  function resumeSelectedSession(){if(session && selectedRecovery().canContinue)void startSession({resumeFrom:session.session_id});}

  async function connectSsh(ssh:SshLaunch) {
    if(!isMainWindow||starting||creatingSession.current)return;
    try {if(!isSshLaunch(ssh))throw Error("Invalid SSH destination");const snap=snapshotSshSettings(terminalRetentionRef.current.retainedLines,terminalSettingsRef.current);const localCwd=currentProject?.path||session?.cwd||activeProject||cwd;setSshError(null);await startSession({cwd:localCwd,ssh:{...ssh},retainedLines:snap.retainedLines,appearance:snap.initialAppearance});}catch{setSshError("SSH destination or terminal preferences unavailable.");}
  }
  function rerunSelectedSession() {
    if (!session || !selectedRecovery().canRunAgain) return;
    if(session.ssh){if(!isMainWindow){openMainSettings();return;}if(!isSshLaunch(session.ssh)){setError("Stored SSH connection is unavailable.");return;}const snap=snapshotSshSettings(terminalRetentionRef.current.retainedLines,terminalSettingsRef.current);void startSession({cwd:session.cwd,ssh:{...session.ssh},retainedLines:snap.retainedLines,appearance:snap.initialAppearance});return;}
    void startSession({ cwd: session.cwd, command: session.command ?? "", launch:session.launch });
  }

  const isRunning = sessionStatus === "running" || sessionStatus === "starting";
  const orderedHistory=orderPinnedSessions(history.map(record=>({id:record.summary.session_id,record})),pinnedSessions).map(item=>item.record);
  const projectGroups = groupProjects(projects, orderedHistory);
  const currentProject = (session?.cwd || activeProject) ? projectGroups.find(
    (project) =>
      projectKey(project.path) === projectKey(session?.cwd || activeProject),
  ) : undefined;
  const gitProjectPath = currentProject?.path ?? activeProject;
  useEffect(() => {
    let active = true;
    gitPolling.current.select(gitProjectPath, String(gitOwner));
    const refresh = () => {
      if (!active) return Promise.resolve();
      return gitPolling.current.poll(performance.now(), path => invoke<GitContext>("get_git_context", {path}), value => {
        if (active) setGitContext({path:gitProjectPath,owner:gitOwner,value});
      });
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { active = false; clearInterval(timer); gitPolling.current.cancel(); };
  }, [gitProjectPath, gitOwner]);
  const visibleGitContext = gitContext?.path === gitProjectPath && gitContext.owner === gitOwner ? gitContext.value : null;
  useEffect(()=>{if(projectToolsOpen)setProjectToolsPath(visibleGitContext?.root||gitProjectPath);},[projectToolsOpen,gitProjectPath,visibleGitContext?.root]);
  worktreeContextRef.current={root:projectToolsPath,owner:gitOwner};
  const titleFor = (summary: SessionSummary | HistoryItem["summary"]) => {
    if(sessionTitles[summary.session_id])return sessionTitles[summary.session_id];
    if("title" in summary)return summary.title;
    if(summary.ssh)return sshTitle(summary.ssh);
    return summary.launch?.prompt||summary.command||(summary.launch?`${summary.launch.adapter} · ${summary.launch.mode}`:defaultTerminalTitle(summary.session_id,t("Terminal")));
  };
  const normalizedQuery = historyQuery.trim().toLowerCase();
  const visibleProjects = projectGroups;

  function reconcileTerminalLayoutSelection(){
    showTerminalLayout();focusTerminalPane(terminalLayoutRef.current.focused,false,true);
  }
  function clearDeletedSessionNames(ids:string[],userIntent=true) {
    const deleted=new Set(ids),restore=layoutRestore.current;
    const changesMembers=terminalMembers(terminalLayoutRef.current).some(id=>deleted.has(id));
    const invalidHints=restore.pending&&(restore.ids.length?restore.ids:terminalMembers(layoutPreferenceLoad.layout)).some(id=>id&&deleted.has(id));
    const affectsSelection=terminalMembers(terminalLayoutRef.current).some(id=>deleted.has(id))||!!(sessionId.current&&deleted.has(sessionId.current));
    if(invalidHints){
      cancelLayoutRestore(true,false);
      focusTerminalPane(0,false,true);
      setError("Saved terminal layout is unavailable. Using a single pane.");
    }else if(userIntent||terminalMembers(terminalLayoutRef.current).some(id=>deleted.has(id))){
      cancelLayoutRestore();
    }
    const layout=terminalLayoutRef.current;
    if(terminalMembers(layout).some(id=>deleted.has(id))){
      let next=layout;for(const id of deleted){const pane=terminalSessionPane(next,id);if(pane>=0)next=removeTerminalTab(next,pane,id);}
      terminalLayoutRef.current={...next,revision:layout.revision+1};
      showTerminalLayout();setTerminalLayout(terminalLayoutRef.current);
    }

    const nextPins=pinnedSessionsRef.current.filter(id=>!deleted.has(id));pinnedSessionsRef.current=nextPins;setPinnedSessions(nextPins);
    setSessionTitles(previous=>{const next={...previous};for(const id of deleted)delete next[id];return next;});
    const views=new Set(ids.map(id=>terminalViews.current.get(id)).filter(Boolean));
    terminalViews.current.retain(view=>!views.has(view));
    for(const id of deleted){pendingOutput.current.delete(id);pendingState.current.delete(id);}
    if(previousSession.current&&deleted.has(previousSession.current))previousSession.current=null;
    if(selectedRecord.current&&deleted.has(selectedRecord.current.summary.session_id))selectedRecord.current=null;
    if(userIntent||invalidHints||affectsSelection){detailVersion.current++;selectionVersion.current++;}
    if(sessionId.current&&deleted.has(sessionId.current)){
      sessionId.current=null;terminal.current=null;fitAddon.current=null;outputCursor.current=null;setSession(null);setSessionStatus("idle");
    }
    try {
      for(const id of deleted)for(const kind of ["Name","Launch"]){const key=`yam.session${kind}.${id}`;if(localStorage.getItem(key)!==null)localStorage.removeItem(key);}
      localStorage.setItem("yam.pinnedSessions",JSON.stringify(nextPins));
      const stored=localStorage.getItem(windowPreferenceKey("lastSession"));
      let last=stored;try{last=stored===null?null:JSON.parse(stored);}catch{}
      if(typeof last==="string"&&deleted.has(last))localStorage.removeItem(windowPreferenceKey("lastSession"));
    }catch(reason){setError(`Failed to save session preferences: ${String(reason)}`);}
    if(changesMembers){reconcileTerminalLayoutSelection();recoverRevealedTerminals(layout);}
  }

  async function takeTerminalControl(){
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!id||!view||view.moving||!view.live)return;
    const owner=view.frameInstance,generation=view.desktopGeneration,attachment=view.attachVersion;
    try{await invoke("take_terminal_control",{desktopGeneration:view.desktopGeneration,sessionId:id});if(sessionId.current!==id||terminalViews.current.get(id)!==view||view.disposed||view.moving||view.desktopGeneration!==generation||view.attachVersion!==attachment||view.frameInstance!==owner)return;view.writable=true;setError(null);syncViewSize(view);terminal.current?.focus();}
    catch(reason){if(!view.disposed&&view.frameInstance===owner){view.writable=false;if(sessionId.current===id)setError(String(reason));}}
  }
  function syncViewSize(view:TerminalView){
    if(view.moving)return;const generation=view.desktopGeneration;
    if(!terminalPaneVisible(view.element.dataset.sessionId!)||!terminalPaneHasSize(view)||!view.live||!view.ready||!view.writable||view.cursor===null||view.disposed)return;
    const owner=view.frameInstance,attachment=view.attachVersion,id=view.element.dataset.sessionId!;
    void queueTerminalResize(view,(cols,rows)=>view.moving||view.desktopGeneration!==generation?Promise.resolve():invoke("resize_session",{desktopGeneration:generation,sessionId:id,cols,rows}),reason=>{
      if(!view.disposed&&view.frameInstance===owner&&view.attachVersion===attachment){view.writable=false;if(terminalPaneVisible(id))setError(String(reason));}
    });
  }
  function fitTerminalViews(views:TerminalView[]=terminalViews.current.all){for(const view of views){if(!terminalPaneVisible(view.element.dataset.sessionId!)||!terminalPaneHasSize(view)){view.resizePending=null;continue;}view.find?.beforeFrame();view.viewportRevision++;view.fit.fit();view.instance.refresh(0,view.instance.rows-1);refreshTerminalScroll(view);syncViewSize(view);const viewport=view.viewportRevision,owner=view.frameInstance,attachment=view.attachVersion,lifecycle=view.lifecycleRevision;void view.find?.afterFrame(()=>terminalPaneVisible(view.element.dataset.sessionId!)&&!view.disposed&&view.frameInstance===owner&&view.attachVersion===attachment&&view.lifecycleRevision===lifecycle&&view.viewportRevision===viewport&&!view.resizing&&!view.scrollReturnPending);}}
  function applyShellPreferences(next:ShellLaunch|null){saveShellLaunch(next,shellWindows,value=>localStorage.setItem("yam.shellLaunch.v1",value));shellLaunchRef.current=next;setShellLaunch(next);setShellLaunchError(null);}
  function fitTerminalAppearanceViews(views:TerminalView[],report:(error:string)=>void){
    const targets=views.map(view=>{const revision=++view.appearanceRevision,instance=view.instance,lifecycle=view.lifecycleRevision,attachment=view.attachVersion,generation=view.desktopGeneration,owner=view.frameInstance,connection=ownerConnectionAvailable.current.version;
      const current=()=>terminalMounted.current&&!view.disposed&&!view.moving&&terminalViews.current.get(view.element.dataset.sessionId!)===view&&view.instance===instance&&view.appearanceRevision===revision&&view.lifecycleRevision===lifecycle&&view.attachVersion===attachment&&view.desktopGeneration===generation&&view.frameInstance===owner&&ownerConnectionAvailable.current.version===connection;
      view.appearanceFitPending=current;return{view,current};});
    const finish=()=>{for(const {view,current} of targets){if(!current())continue;try{fitTerminalViews([view]);view.appearanceFitPending=undefined;}catch{report("Terminal layout could not be updated.");}}};
    finish();requestAnimationFrame(()=>{void(document.fonts?.ready??Promise.resolve()).then(finish);});
  }
  function applyTerminalLineHeight(next:TerminalLineHeight,persist=true){
    const options=terminalLineHeightOptions(next);
    if(persist)saveTerminalLineHeight((key,raw)=>localStorage.setItem(key,raw),next);
    terminalLineHeightRef.current={...options};setTerminalLineHeight({...options});setTerminalLineHeightError(null);
    const changed=terminalViews.current.all.filter(view=>!view.disposed&&(view.instance.options.lineHeight!==options.lineHeight||view.appearanceFitPending?.()));
    for(const view of changed)Object.assign(view.instance.options,options);
    fitTerminalAppearanceViews(changed,setTerminalLineHeightError);
  }
  function commitTerminalAppearance(next:TerminalSettings,updates:{view:TerminalView;appearance:TerminalSettings}[],action:"apply"|TerminalZoomAction="apply",persist=true){
    const options=updates.map(update=>terminalOptions(update.appearance,terminalSystemThemeRef.current));terminalOptions(next);
    if(persist){saveTerminalSettings(next,value=>localStorage.setItem("yam.terminalSettings",value));void publishWindowPreference(nativeInvoke,desktopWindow,"yam.terminalSettings",JSON.stringify(next),action).catch(()=>setTerminalSettingsError("Appearance could not reach the second window."));}
    terminalSettingsRef.current={...next};setTerminalSettings({...next});setTerminalSettingsError(null);
    const targets=updates.map(({view,appearance},index)=>{view.appearance={...appearance};Object.assign(view.instance.options,options[index]);return view;});
    fitTerminalAppearanceViews(targets,setTerminalSettingsError);
    if(targets.length)setTerminalLayoutAppearanceRevision(revision=>revision+1);
  }
  function receiveWindowPreference(value:unknown){
    if(!acceptWindowPreferenceCommit(value,desktopWindow.main_epoch,preferenceRevision.current))return;
    const commit=value;preferenceRevision.current=commit.revision;
    if(isMainWindow&&!isSessionPreferenceKey(commit.key))return;
    try{
      if(isSessionPreferenceKey(commit.key)){
        if(commit.key.startsWith("yam.sessionName.")){const id=commit.key.slice("yam.sessionName.".length),name=readSessionName(window.localStorage,id);setSessionTitles(previous=>{const next={...previous};if(name===null)delete next[id];else next[id]=name;return next;});}
        return;
      }
      if(commit.key===APP_PREFERENCES_KEY){const loaded=loadAppPreferences(()=>commit.value);if(loaded.error){setAppPreferenceError(loaded.error);return;}applyAppPreferences(loaded.value,false);}
      else if(commit.key==="yam.terminalSettings"){
        if(commit.value===null)return;const next=JSON.parse(commit.value) as TerminalSettings;terminalOptions(next);
        const action=commit.appearance_action;if(action===null)return;
        const updates=terminalViews.current.all.filter(view=>!view.disposed).map(view=>({view,appearance:action==="apply"?{...next}:zoomTerminalSettings(view.appearance,action)}));commitTerminalAppearance(next,updates,action,false);
      } else if(commit.key==="yam.terminalRetention.v1"){
        try{if(commit.value===null)throw Error();applyTerminalRetention(decodeTerminalRetention(commit.value),false);}catch{setTerminalRetentionError("Invalid terminal retention received. Current preference was preserved.");}
      } else if(commit.key==="yam.terminalLineHeight.v1"){
        try{if(commit.value===null)throw Error();applyTerminalLineHeight(decodeTerminalLineHeight(commit.value),false);}catch{setTerminalLineHeightError("Invalid line height received. Current spacing was preserved.");}
      } else if(commit.key==="yam.terminalCursor.v1"){
        try{if(commit.value===null)throw Error();applyTerminalCursor(decodeTerminalCursor(commit.value),false);}catch{setTerminalCursorError("Invalid cursor defaults received. Current defaults were preserved.");}
      } else if(commit.key.startsWith("yam.terminalProfiles.")){terminalProfileCollection.load();refreshTerminalProfileUi();}
      else if(commit.key==="yam.shellLaunch.v1"){const next=loadShellLaunch(()=>localStorage.getItem(commit.key),shellWindows);shellLaunchRef.current=next.shell;setShellLaunch(next.shell);setShellLaunchError(next.error);}
      else if(commit.key==="yam.zsh-directory-reporting.v1"){const next=loadZshDirectoryReporting(()=>localStorage.getItem(commit.key));directoryReportingRef.current=next.enabled;setDirectoryReporting(next.enabled);setDirectoryReportingError(next.error);}
      else if(commit.key==="yam.zsh-command-reporting.v1"){const next=loadZshCommandReporting(()=>localStorage.getItem(commit.key));commandReportingRef.current=next.enabled;setCommandReporting(next.enabled);setCommandReportingError(next.error);}
      else if(commit.key==="yam.terminal-paste.v1"){const next=loadTerminalPaste(()=>localStorage.getItem(commit.key));pasteModeRef.current=next.mode;setPasteMode(next.mode);setPastePolicyError(next.error);}
      else if(commit.key==="yam.appShortcuts.v1"){const next=loadAppShortcuts(key=>localStorage.getItem(key),shortcutMac);shortcutsRef.current=next.bindings;setShortcuts(next.bindings);setShortcutError(next.error);}
      else if(commit.key.startsWith("yam.launchTemplates.")){launchTemplateCollection.load();refreshLaunchTemplateUi();}
      else if(commit.key==="yam.projects")setProjects(readPreference(commit.key,[],isProjects));
      else if(commit.key==="yam.sessionTitles")setSessionTitles(loadSessionNames(window.localStorage,readPreference(commit.key,{},(value):value is Record<string,string>=>!!value&&typeof value==="object"&&!Array.isArray(value)&&Object.values(value).every(item=>typeof item==="string"))));
      else if(commit.key==="yam.pinnedSessions"){const next=readPreference(commit.key,[],isPinnedSessions);pinnedSessionsRef.current=next;setPinnedSessions(next);}
    }catch{setError("Shared preferences are invalid or unavailable.");}
  }
  function applyTerminalCursor(next:TerminalCursor,persist=true){
    const options=terminalCursorOptions(next);
    if(persist)saveTerminalCursor((key,raw)=>localStorage.setItem(key,raw),next);
    terminalCursorRef.current={shape:options.cursorStyle,blink:options.cursorBlink};setTerminalCursor({...terminalCursorRef.current});setTerminalCursorError(null);
    for(const view of terminalViews.current.all){if(!view.disposed)Object.assign(view.instance.options,options);}
  }
  function applyTerminalPreferences(next:TerminalSettings){commitTerminalAppearance(next,terminalViews.current.all.filter(view=>!view.disposed).map(view=>({view,appearance:{...next}})));}
  function zoomTerminal(action:TerminalZoomAction){
    if(!isMainWindow){void invoke("request_main_terminal_zoom",{action}).catch(reason=>setTerminalSettingsError(String(reason)));return;}
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!view||!view.ready||view.disposed)return;
    try{const next=zoomTerminalSettings(terminalSettingsRef.current,action),updates=terminalViews.current.all.filter(view=>!view.disposed).map(view=>({view,appearance:zoomTerminalSettings(view.appearance,action)}));if(next.fontSize!==terminalSettingsRef.current.fontSize||updates.some(({view,appearance})=>appearance.fontSize!==view.appearance.fontSize))commitTerminalAppearance(next,updates,action);}
    catch(reason){setTerminalSettingsError(String(reason));}
  }
  function toggleSessionPin(id:string){if(!isMainWindow){openMainSettings();return;}try{const next=togglePinnedSession(pinnedSessionsRef.current,id);localStorage.setItem("yam.pinnedSessions",JSON.stringify(next));pinnedSessionsRef.current=next;setPinnedSessions(next);}catch(reason){setError(String(reason));}}
  function closeEndedView(){
    cancelLayoutRestore();
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!view||view.live||view.parsing||view.updating||!view.persisted||!canCloseSessionView(view.status??""))return;
    const layout=terminalLayoutRef.current;
    terminalLayoutRef.current=removeTerminalTab(layout,terminalSessionPane(layout,id!),id!);
    terminalViews.current.setProtected(terminalMembers(terminalLayoutRef.current));setTerminalLayout(terminalLayoutRef.current);
    terminalViews.current.retain(other=>other!==view);pendingOutput.current.delete(id!);pendingState.current.delete(id!);selectionVersion.current++;detailVersion.current++;
    selectedRecord.current=null;sessionId.current=null;terminal.current=null;fitAddon.current=null;outputCursor.current=null;
    setSession(null);setSessionStatus("idle");setSelectedAgent(undefined);setTerminalNotice("View closed. Select its history to reopen the saved scene.");
    try{const stored=localStorage.getItem(windowPreferenceKey("lastSession"));if(stored&&JSON.parse(stored)===id)localStorage.removeItem(windowPreferenceKey("lastSession"));}catch(reason){setError(String(reason));}
    reconcileTerminalLayoutSelection();
    recoverRevealedTerminals(layout);
    if(!sessionId.current)setTerminalNotice("View closed. Select its history to reopen the saved scene.");
  }
  function openCommandPalette(){paletteVersion.current++;setPaletteQuery("");setPaletteOpen(true);}
  function closeCommandPalette(){paletteVersion.current++;setPaletteOpen(false);}
  const recovery=selectedRecovery();
  const canContinue=recovery.canContinue;
  const recoveryNotice=ownerConnectionAvailable.current.available?(recovery.notice ?? terminalNotice):null;
  const commandEntries=paletteEntries(paletteQuery,orderedHistory.map(record=>({id:record.summary.session_id,title:titleFor(record.summary),status:record.status})),canContinue,{new:shortcutHint(shortcuts.terminal,shortcutMac),previous:shortcutHint(shortcuts.previous,shortcutMac),search:shortcutHint(shortcuts.search,shortcutMac),"clear-display":shortcutHint(shortcuts["clear-display"],shortcutMac)},canReopenTerminalTab());
  function clearEntryAdmission(){return !starting&&!terminalReopenFlight.current&&!layoutRestore.current.pending&&!desktopWindow.restore_blocked&&!creatingSession.current&&!terminalMoveTaskRef.current&&!terminalMoveIncomingRef.current&&!terminalMoveOperationRef.current;}
  function queuePaletteClear(version:number){
    if(!paletteOpen||version!==paletteVersion.current)return;
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;if(!id||!view)return;
    closeCommandPalette();
    paletteClearIntent.current={id,view,instance:view.instance,epoch:desktopWindow.epoch,generation:view.desktopGeneration,parser:view.frameInstance,attachment:view.attachVersion,lifecycle:view.lifecycleRevision,selection:selectionVersion.current,owner:ownerConnectionAvailable.current.version,version:paletteVersion.current};
  }
  useEffect(()=>{
    if(paletteOpen)return;
    const intent=paletteClearIntent.current;paletteClearIntent.current=null;if(!intent)return;
    const {id,view}=intent;
    if(!terminalMounted.current||paletteVersion.current!==intent.version||sessionId.current!==id||terminalViews.current.get(id)!==view||view.instance!==intent.instance||desktopWindow.epoch!==intent.epoch||view.desktopGeneration!==intent.generation||view.frameInstance!==intent.parser||view.attachVersion!==intent.attachment||view.lifecycleRevision!==intent.lifecycle||selectionVersion.current!==intent.selection||ownerConnectionAvailable.current.version!==intent.owner||!document.hasFocus()||!clearEntryAdmission()||!canClearTerminalDisplay())return;
    void clearTerminalDisplay();
  },[paletteOpen]);
  async function choosePaletteEntry(entry:PaletteEntry){
    const version=paletteVersion.current;
    try{await executePaletteEntry(entry,{"clear-display":()=>queuePaletteClear(version),reopen:()=>reopenTerminalTab(),"second-window":()=>openSecondWindow(),new:()=>newSession(),terminal:()=>newSession(),previous:()=>previousSession.current?openSession(previousSession.current):undefined,search:()=>{setSidebarOpen(true);requestAnimationFrame(()=>{searchInput.current?.focus();searchInput.current?.select();});},logs:()=>setLogSearchOpen(true),inbox:()=>setInboxOpen(true),resume:()=>{if(canContinue)resumeSelectedSession();},diagnostics:()=>exportDiagnostics(),appearance:()=>(isMainWindow?setAppearanceOpen(true):void openMainSettings("appearance")),settings:()=>(isMainWindow?setTerminalSettingsOpen(true):void openMainSettings("settings")),profiles:()=>(isMainWindow?setTerminalProfilesOpen(true):void openMainSettings("profiles")),"paste-settings":()=>(isMainWindow?setPasteSettingsOpen(true):void openMainSettings("paste-settings")),"keyboard-shortcuts":()=>(isMainWindow?setKeyboardShortcutsOpen(true):void openMainSettings("keyboard-shortcuts")),larger:()=>zoomTerminal("larger"),smaller:()=>zoomTerminal("smaller"),reset:()=>zoomTerminal("reset"),switch:id=>id?openSession(id):undefined},()=>paletteOpen&&version===paletteVersion.current);}
    catch(reason){if(version===paletteVersion.current)setError(String(reason));}
    finally{if(version===paletteVersion.current)closeCommandPalette();}
  }

  function applyTerminalRetention(value:TerminalRetention,persist=true){
    if(persist)saveTerminalRetention((key,raw)=>localStorage.setItem(key,raw),value);
    const next=decodeTerminalRetention(JSON.stringify(value));terminalRetentionRef.current=next;setTerminalRetention(next);setTerminalRetentionError(null);
  }
  function newTerminal(path?:string,profileId?:string|null,appearance?:TerminalSettings) {
    if(!isMainWindow){const latestRetention=loadTerminalRetention(()=>localStorage.getItem("yam.terminalRetention.v1"));terminalRetentionRef.current=latestRetention.retention;setTerminalRetentionError(latestRetention.error);terminalProfileCollection.load();const latest=loadShellLaunch(()=>localStorage.getItem("yam.shellLaunch.v1"),shellWindows);shellLaunchRef.current=latest.shell;directoryReportingRef.current=loadZshDirectoryReporting(()=>localStorage.getItem("yam.zsh-directory-reporting.v1")).enabled;commandReportingRef.current=loadZshCommandReporting(()=>localStorage.getItem("yam.zsh-command-reporting.v1")).enabled;}
    const retainedLines=terminalRetentionRef.current.retainedLines;
    try{if(profileId!==null&&terminalProfileCollection.loadError)throw Error(terminalProfileCollection.loadError);const snapshot=terminalProfileStart({version:3,profiles:terminalProfileCollection.profiles,defaultId:terminalProfileCollection.defaultId},profileId,path,currentProject?.path||session?.cwd||activeProject||"",shellLaunchRef.current,shellWindows,terminalSettingsRef.current);const options={...snapshot,...(appearance?{appearance}:{}),...(retainedLines===2000?{}:{retainedLines}),...(zshDirectoryReportingEligible(directoryReportingRef.current,snapshot.shell,shellWindows)?{directoryReporting:true}:{}),...(zshCommandReportingEligible(commandReportingRef.current,snapshot.shell,shellWindows)?{commandReporting:true}:{})};const {cwd:_cwd,command:_command,launch:_launch,...settings}=options;ordinaryLaunchSnapshot.current=settings;return startSession(options);}
    catch(reason){setError(reason instanceof Error?reason.message:"Terminal profile is unavailable.");}
  }
  async function startSelectedTerminalProfile(){
    try{const id=terminalProfileCollection.selectedId;if(id===null)throw Error("Selected terminal profile is unavailable.");terminalDirectory(undefined,id);setTerminalProfileActionError(null);setTerminalProfilesOpen(false);newSession(undefined,id);}
    catch(reason){setTerminalProfileActionError(reason instanceof Error?reason.message:"Terminal profile is unavailable.");}
  }

  function terminalDirectory(path?:string,profileId?:string|null){
    if(profileId!==null&&terminalProfileCollection.loadError)throw Error(terminalProfileCollection.loadError);
    return terminalProfileStart({version:3,profiles:terminalProfileCollection.profiles,defaultId:terminalProfileCollection.defaultId},profileId,path,currentProject?.path||session?.cwd||activeProject||"",shellLaunchRef.current,shellWindows,terminalSettingsRef.current).cwd;
  }
  function newSession(path?:string,profileId?:string|null,worktreeAttempt?:string) {
    sessionCopyIntent.current++;setSessionCopy(null);setCopyName("");ordinaryLaunchSnapshot.current=undefined;
    cancelLayoutRestore();
    setError(null);
    setLaunchDirectoryOverride(path);setLaunchTerminalProfile(profileId);setLaunchWorktreeAttempt(worktreeAttempt);
    cancelProjectPreview();setProjectLaunchEdits({});
    const defaults=globalLaunchDefaults.mode==="task"?{adapter:globalLaunchDefaults.adapter,mode:"interactive",extra_args:"",prompt:null,command:null,provider:null}:globalLaunchDefaults;
    const available=adapters.filter(item=>item.available||item.id==="shell");
    const preferred=readPreference("yam.lastSessionCli",defaults.adapter==="custom"?"shell":defaults.adapter,(value):value is string=>typeof value==="string"&&available.some(item=>item.id===value));
    const adapter=profileId!==undefined?"shell":available.some(item=>item.id===preferred)?preferred:available.find(item=>item.id!=="shell")?.id??"shell";
    setLaunchDraft({...defaults,adapter,mode:"interactive",...(adapter==="pi"&&defaults.adapter!=="pi"?{extra_args:"--yam-gateway http://127.0.0.1:3425 --yam-small yam-gateway/codex/gpt-6-luna --yam-strong yam-gateway/codex/gpt-6.1-sol"}:{}),...(defaults.provider&&!supportsProvider(adapter,defaults.provider)?{provider:null}:{}),...(adapter!=="shell"||!isMainWindow?{command:null}:{}),...(profileId!==undefined?{command:null,provider:null,prompt:null,extra_args:""}:{})});
    let directory=path??currentProject?.path??session?.cwd??activeProject??"";
    if(adapter==="shell"&&!worktreeAttempt)try{directory=terminalDirectory(path,profileId);}catch(reason){setError(reason instanceof Error?reason.message:"Terminal profile is unavailable.");}
    setCwd(directory);
    launchDialog.current?.querySelectorAll("details").forEach(item=>item.open=false);
    launchDialog.current?.showModal();
  }
  const currentAgent=selectedAgent;
  const reviewRecord=session?{summary:session,status:sessionStatus,agent:currentAgent}:null;
  const currentReviewOrigin=reviewOrigin(reviewRecord);
  const unreadTotal=historyOverview.unread_receipts;
  async function openReceipt(record:HistoryItem,entry:AgentReceipt,agent?:AgentState){
    const action=captureAttention(record,entry,agent),focusOrigin=document.activeElement;
    const operation=++attentionOperation.current,owner=ownerConnectionAvailable.current.version;
    const valid=()=>terminalMounted.current&&operation===attentionOperation.current&&owner===ownerConnectionAvailable.current.version;
    let proof:{view:TerminalView;attachment:number|undefined;detail:number;intent:number}|null=null;
    const opened=await openSession(action.sessionId,(view,detail,intent)=>{proof={view,attachment:view.attachVersion,detail,intent};},valid,true);
    if(!opened||!proof)return;
    const attachment=proof as {view:TerminalView;attachment:number|undefined;detail:number;intent:number};
    const attached=()=>valid()&&ownerConnectionAvailable.current.available
      &&sessionId.current===action.sessionId&&detailVersion.current===attachment.detail
      &&layoutRestore.current.version===attachment.intent
      &&terminalViews.current.get(action.sessionId)===attachment.view&&!attachment.view.disposed
      &&attachment.view.attachVersion===attachment.attachment&&attachment.view.ready
      &&attachment.view.cursor!==null&&attachment.view.availability!=="owner_unavailable"
      &&attachment.view.availability!=="terminal_unavailable";
    const current=()=>attached()&&attachment.view.live&&["starting","running"].includes(attachment.view.status??"");
    if(!attached())return;
    if(action.state!=="current"||!current()){showConversation(false,focusOrigin);return;}
    try {
      const fresh=await invoke<SessionRecord>("get_session",{sessionId:action.sessionId});
      if(!current()||!isCurrentAttention(action,fresh))return;
      await invoke("read_agent_receipt",{sessionId:action.sessionId,receipt:action.receipt.id,revision:action.receipt.revision});
      if(current())await refreshHistory(current);
    }catch(reason){if(current())setError(String(reason));}
    finally{if(attached())showConversation(false,focusOrigin);}
  }
  async function jumpToAttention(){const version=++detailVersion.current;try{const id=await invoke<string|null>("next_attention",{currentSessionId:sessionId.current});if(version===detailVersion.current&&id)await openSession(id);}catch(reason){if(version===detailVersion.current)setError(String(reason));}}
  function openTerminalFind(){
    if(conversationOpenRef.current)return;
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(id&&view?.ready&&!view.disposed&&terminalPaneVisible(id)){
      view.find??=new TerminalFindController(view.instance,()=>{const addon=new SearchAddon({highlightLimit:200});view.instance.loadAddon(addon);return addon;},new FindWorker(createFindWorker),()=>{if(!view.disposed&&sessionId.current===id)setRecoveryRevision(revision=>revision+1);});
      view.find.open();
    }
  }
  function closeTerminalFind(view:TerminalView,id:string){
    view.find?.close();
    if(sessionId.current===id&&terminalViews.current.get(id)===view&&terminalPaneVisible(id)&&view.ready&&!view.disposed&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop'))view.instance.focus();
  }
  function terminalKeyboardScrollView(){
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!id||!view||!Number.isSafeInteger(view.desktopGeneration)||!view.desktopGeneration||terminalWindowClaim(id)!==view.desktopGeneration||!terminalMounted.current||layoutRestore.current.pending||terminalTabDrag.current||terminalMoveTaskRef.current||terminalMoveOperationRef.current
      ||!terminalHasInputFocus(id)||!terminalPaneVisible(id)||!ownerConnectionAvailable.current.available||view.disposed||view.moving||!view.ready||!view.projection||!view.frameInstance
      ||view.attaching||view.parsing||view.updating||view.projecting||view.resizing||view.scrollReturnPending||view.selecting||view.instance.hasSelection()
      ||view.find?.state.visible||view.find?.blocksProjection()||view.availability==="owner_unavailable"||view.availability==="terminal_unavailable"
      ||!view.element.isConnected||view.element.inert||view.element.style.visibility==="hidden"||view.instance.buffer.active.type!=="normal"||view.instance.modes.mouseTrackingMode!=="none")return null;
    return {id,view};
  }
  function scrollTerminalPage(id:string,view:TerminalView,direction:number){
    const generation=view.desktopGeneration,attachment=view.attachVersion,connection=ownerConnectionAvailable.current.version;
    try{view.instance.scrollPages(direction);}
    catch{if(sessionId.current===id&&terminalHasInputFocus(id)&&terminalViews.current.get(id)===view&&!view.disposed&&!view.moving&&view.desktopGeneration===generation&&view.attachVersion===attachment&&ownerConnectionAvailable.current.version===connection)setError("Terminal page navigation is unavailable.");}
  }
  useEffect(()=>installActionMenus(document),[]);
  const nativeMenuHandler=useRef<(action:unknown)=>void>(()=>{});
  nativeMenuHandler.current=action=>{
    const blocked=!!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop');
    if(action==="support"){if(!blocked)openSettingsSection("support");return;}
    const fileWorkspace=document.activeElement?.closest('.project-workspace');
    if((action==="hide"||action==="close")&&!blocked&&fileWorkspace){const closeFile=fileWorkspace.querySelector<HTMLButtonElement>('.project-tools-panel:not([hidden]) [data-close-active-file="true"]');if(closeFile)closeFile.click();else closeProjectTools();return;}
    dispatchNativeMenu(action,{
      new:()=>newSession(),"second-window":()=>void openSecondWindow(),project:()=>addProject(),ssh:()=>{if(isMainWindow){setSshError(null);setSshOpen(true);}else openMainSettings("updates");},
      close:()=>void nativeInvoke("native_close_window").catch(()=>setError("Window could not be closed.")),
      hide:()=>{const layout=terminalLayoutRef.current,id=layout.panes[layout.focused];if(id)closeTerminalTab(layout.focused,id);},reopen:()=>void reopenTerminalTab(),sidebar:()=>setSidebarOpen(value=>!value),palette:()=>openCommandPalette(),find:()=>openTerminalFind(),
      larger:()=>zoomTerminal("larger"),smaller:()=>zoomTerminal("smaller"),reset:()=>zoomTerminal("reset"),"split-horizontal":()=>splitFocusedTerminalPane("horizontal"),"split-vertical":()=>splitFocusedTerminalPane("vertical"),zoom:()=>toggleTerminalPaneZoom(),
      previous:()=>{if(previousSession.current)void openSession(previousSession.current);},attention:()=>void jumpToAttention(),logs:()=>setLogSearchOpen(true),appearance:()=>(isMainWindow?setAppearanceOpen(true):openMainSettings("appearance")),settings:()=>(isMainWindow?setTerminalSettingsOpen(true):openMainSettings("settings")),profiles:()=>(isMainWindow?setTerminalProfilesOpen(true):openMainSettings("profiles")),"keyboard-shortcuts":()=>(isMainWindow?setKeyboardShortcutsOpen(true):openMainSettings("keyboard-shortcuts")),updates:()=>{if(isMainWindow){setUpdaterOpen(true);const current=updaterController.current.snapshot;if(current?.configured&&!updaterBusy(current.state)&&current.state!=="verified")void runUpdaterAction("check");}else openMainSettings("updates");}
     ,"paste-settings":()=>(isMainWindow?setPasteSettingsOpen(true):openMainSettings("paste-settings")),"system-entry":()=>{if(isMainWindow){setSystemEntryOpen(true);void refreshSystemEntry();}else openMainSettings("system-entry");},"directory-reporting":()=>(isMainWindow?setDirectoryReportingOpen(true):openMainSettings("directory-reporting")),"command-reporting":()=>(isMainWindow?setCommandReportingOpen(true):openMainSettings("command-reporting")),"launch-settings":()=>{if(isMainWindow){setLaunchDefaultsNotice(null);launchSettingsDialog.current?.showModal();}else openMainSettings("launch-settings");}
    } satisfies Record<NativeMenuAction,()=>unknown>,blocked);
  };
  useEffect(()=>{
    let active=true,unlisten:(()=>void)|undefined;
    void getCurrentWebview().listen<unknown>("native-menu",event=>{if(active)nativeMenuHandler.current(event.payload);}).then(stop=>{if(active)unlisten=stop;else stop();}).catch(()=>setError("Native menu actions are unavailable."));
    return()=>{active=false;unlisten?.();};
  },[]);
  useEffect(()=>{
    const sync=()=>{void nativeInvoke("native_menu_labels",{labels:nativeMenuLabels(shortcuts,shortcutMac),locale:i18n.language}).catch(()=>{});};
    sync();window.addEventListener("focus",sync);return()=>window.removeEventListener("focus",sync);
  },[shortcuts,shortcutMac,i18n.language]);
  function handleShortcut(event:KeyboardEvent){
    const target=event.target instanceof Element?event.target:null;
    const editing=!!target?.closest('input,textarea,select,[role="combobox"],[role="listbox"],[contenteditable]:not([contenteditable="false"])')&&!target?.closest(".xterm-helper-textarea");
    const blocked=!!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"],.modal-backdrop')||!!target?.closest("[data-shortcuts]");
    if(editing||blocked)return;
    const mac=/Mac|iPhone|iPad|iPod/.test(navigator.platform),action=resolveAppShortcut(event,shortcutsRef.current,mac);if(action===null)return;
    if(action==="find"||action.startsWith("font-")){const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;if(!id||!view?.ready||view.disposed||(action==="find"?!terminalPaneVisible(id):!terminalHasInputFocus(id)))return;}
    const scrolling=action.startsWith("scroll-")?terminalKeyboardScrollView():null;
    if(action.startsWith("scroll-")&&!scrolling)return;
    if(action==="clear-display"&&(!sessionId.current||!terminalHasInputFocus(sessionId.current)||!clearEntryAdmission()||!canClearTerminalDisplay()))return;
    if(action==="previous"&&!previousSession.current)return;
    event.preventDefault();event.stopPropagation();
    if(scrolling){if(action==="scroll-bottom")void returnTerminalToLive();else scrollTerminalPage(scrolling.id,scrolling.view,action==="scroll-page-up"?-1:1);}
    else if(action==="clear-display")void clearTerminalDisplay();
    else if(action==="terminal")newSession();
    else if(action==="palette")openCommandPalette();
    else if(action==="split-horizontal"||action==="split-vertical")splitFocusedTerminalPane(action==="split-horizontal"?"horizontal":"vertical");
    else if(action==="pane-zoom")toggleTerminalPaneZoom();
    else if(action.startsWith("pane-"))focusTerminalPaneDirection(action.slice(5) as TerminalPaneDirection);
    else if(action==="find")openTerminalFind();
    else if(action.startsWith("font-"))zoomTerminal(action.slice(5) as TerminalZoomAction);
    else if(action==="attention")jumpToAttention();
    else if(action==="previous")void openSession(previousSession.current!);
    else if(action==="search"){setSidebarOpen(true);requestAnimationFrame(()=>{searchInput.current?.focus();searchInput.current?.select();});}
    else void toggleNotificationPause();
  }
  useEffect(()=>{
    window.addEventListener("keydown",handleShortcut,true);return()=>window.removeEventListener("keydown",handleShortcut,true);
  },[history,shortcuts,session,activeProject,projects,starting]);

  function commitProjects(next:Project[]){
    const raw=JSON.stringify(next);localStorage.setItem("yam.projects",raw);projectsRef.current=next;setProjects(next);
  }
  function pinProject(path:string,desired:boolean){
    if(!isMainWindow)return;
    const current=projectsRef.current,next=setProjectPinned(current,path,desired);if(next===current)return;
    try{commitProjects(next);}catch{setError("Could not save project pin. Try again.");}
  }
  function canMoveProject(path:string,direction:"up"|"down"){return isMainWindow&&moveProjectAdjacent(projectsRef.current,path,direction)!==projectsRef.current;}
  function moveProject(path:string,direction:"up"|"down"){
    if(!isMainWindow)return;
    const current=projectsRef.current,next=moveProjectAdjacent(current,path,direction);
    if(next===current)return;
    try{commitProjects(next);}catch{setError("Could not save project order. Try again.");}
  }
  function beginProjectDrag(event:DragEvent,project:Project){
    projectDragRef.current=null;
    if(!canRenameProject(project)){event.preventDefault();return;}
    try{event.dataTransfer.setData("application/x-yam-project","1");event.dataTransfer.effectAllowed="move";projectDragRef.current={path:project.path,projects:projectsRef.current};event.stopPropagation();}
    catch{projectDragRef.current=null;event.preventDefault();}
  }
  function endProjectDrag(){projectDragRef.current=null;}
  function dropProject(event:DragEvent,path:string,drop=false){
    const intent=projectDragRef.current,transfer=event.dataTransfer;
    if(!isMainWindow||!intent||!Array.from(transfer.types).includes("application/x-yam-project")||Array.from(transfer.types).includes("Files")||transfer.files.length||Array.from(transfer.items).some(item=>item.kind==="file"))return;
    event.preventDefault();event.stopPropagation();transfer.dropEffect="move";
    if(!drop)return;
    projectDragRef.current=null;
    const current=projectsRef.current;if(intent.projects!==current)return;
    const next=moveProjectToTarget(current,intent.path,path);if(next===current)return;
    try{commitProjects(next);}catch{setError("Could not save project order. Try again.");}
  }
  function canRenameProject(project:Project){const matches=projectsRef.current.filter(row=>projectKey(row.path)===projectKey(project.path));return isMainWindow&&matches.length===1&&matches[0].path===project.path&&matches[0].name===project.name;}
  function beginProjectRename(project:Project){
    if(!canRenameProject(project))return;
    const intent={key:projectKey(project.path),path:project.path,name:project.name,color:project.color,icon:project.icon};projectRenameRef.current=intent;setProjectRename(intent);setRenameProjectName(project.name);setRenameProjectColor(project.color??"");setRenameProjectIcon(project.icon??"");setProjectRenameError(null);projectRenameDialog.current?.showModal();
  }
  function closeProjectRename(){projectRenameRef.current=null;setProjectRename(null);projectRenameDialog.current?.close();}
  function saveProjectRename(intent:{key:string;path:string;name:string;color?:Project["color"];icon?:Project["icon"]}|null){
    if(!isMainWindow||!intent||projectRenameRef.current!==intent)return;
    try{
      const name=validateProjectName(renameProjectName),current=projectsRef.current,matches=current.filter(row=>projectKey(row.path)===intent.key);
      if((renameProjectColor!==""&&!validProjectColor(renameProjectColor))||(renameProjectIcon!==""&&!validProjectIcon(renameProjectIcon)))throw new Error("Invalid project appearance");
      if(matches.length!==1||matches[0].path!==intent.path||matches[0].name!==intent.name||matches[0].color!==intent.color||matches[0].icon!==intent.icon){setProjectRenameError("This project changed. Close and reopen Edit project.");return;}
      const updated={...matches[0],name};if(renameProjectColor==="")delete updated.color;else updated.color=renameProjectColor as Project["color"];if(renameProjectIcon==="")delete updated.icon;else updated.icon=renameProjectIcon as Project["icon"];
      if(name!==intent.name||updated.color!==matches[0].color||updated.icon!==matches[0].icon)commitProjects(current.map(row=>row===matches[0]?updated:row));
      closeProjectRename();
    }catch{setProjectRenameError("Could not save project name. Use 1–200 characters and try again.");}
  }
  function addProject() {if(!isMainWindow){openMainSettings();return;}
    setProjectError(null);
    setProjectPath("");
    setNewProjectName("");
    projectDialog.current?.showModal();
  }
  const projectDeleteDialog=useRef<HTMLDialogElement>(null),projectDeleteRef=useRef<Project|null>(null);
  const [projectDelete,setProjectDelete]=useState<Project|null>(null);
  const sessionDeleteDialog=useRef<HTMLDialogElement>(null);
  type SessionDeleteTarget={id:string;title:string;archived:boolean;previewId:string|null};
  const sessionDeleteRef=useRef<SessionDeleteTarget|null>(null),sessionDeleteBusyRef=useRef(false);
  const [sessionDelete,setSessionDelete]=useState<SessionDeleteTarget|null>(null);
  const [sessionDeleteBusy,setSessionDeleteBusy]=useState(false),[sessionDeleteError,setSessionDeleteError]=useState<string|null>(null);
  function deleteProject(project:Project){
    if(!isMainWindow)return;
    const intent={path:project.path,name:project.name};projectDeleteRef.current=intent;setProjectDelete(intent);projectDeleteDialog.current?.showModal();
  }
  function closeProjectDeletion(){projectDeleteRef.current=null;setProjectDelete(null);projectDeleteDialog.current?.close();}
  function confirmProjectDeletion(intent:Project|null){
    if(!isMainWindow||!intent||projectDeleteRef.current!==intent)return;
    const current=projectsRef.current,matches=current.filter(row=>projectKey(row.path)===projectKey(intent.path));
    if(matches.length>1||matches.length===1&&(matches[0].path!==intent.path||matches[0].name!==intent.name)){setError("This project changed. Reopen Delete project.");return;}
    try{
      const next=matches.length?current.map(row=>row===matches[0]?{...row,hidden:true,hiddenBefore:Date.now()/1000}:row):[...current,{...intent,hidden:true,hiddenBefore:Date.now()/1000}];
      commitProjects(next);if(activeProject===intent.path)setActiveProject("");closeProjectDeletion();
    }catch{setError("Could not delete project. Try again.");}
  }
  function openSessionMenu(row:HTMLElement,x:number,y:number){
    const menu=row.parentElement?.querySelector<HTMLDetailsElement>("details.session-context-menu");if(!menu)return;
    const actions=menu.querySelector<HTMLElement>('[role="menu"]');if(!actions)return;
    menu.open=true;
    actions.style.left=Math.max(8,Math.min(x,window.innerWidth-actions.offsetWidth-8))+"px";
    actions.style.top=Math.max(8,Math.min(y,window.innerHeight-actions.offsetHeight-8))+"px";
    actions.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }
  function positionProjectMenu(menu:HTMLDetailsElement){
    if(!menu.open)return;
    const actions=menu.querySelector<HTMLElement>('.toolbar-more-actions');if(!actions)return;
    const rect=menu.getBoundingClientRect(),width=actions.offsetWidth,height=actions.offsetHeight;
    actions.style.left=Math.max(8,Math.min(rect.right-width,window.innerWidth-width-8))+"px";
    const top=rect.bottom+6+height<=window.innerHeight-8?rect.bottom+6:rect.top-height-6;
    actions.style.top=Math.max(8,Math.min(top,window.innerHeight-height-8))+"px";
  }
  function beginSessionDeletion(record:HistoryItem|SessionRecord|null=selectedRecord.current){
    if(!isMainWindow||sessionDeleteBusyRef.current||!record)return;
    if(!["succeeded","failed","stopped"].includes(record.status)){setError("Stop the session before deleting it.");return;}
    const target={id:record.summary.session_id,title:titleFor(record.summary),archived:false,previewId:null};
    sessionDeleteRef.current=target;setSessionDelete(target);setSessionDeleteError(null);sessionDeleteDialog.current?.showModal();
  }
  function closeSessionDeletion(){
    if(sessionDeleteBusyRef.current)return;
    const target=sessionDeleteRef.current;sessionDeleteRef.current=null;setSessionDelete(null);sessionDeleteDialog.current?.close();
    if(target?.previewId)void invoke("cancel_archive_deletion_preview",{previewId:target.previewId}).catch(()=>{});
  }
  async function confirmSessionDeletion(){
    const target=sessionDeleteRef.current;if(!isMainWindow||!target||sessionDeleteBusyRef.current)return;
    sessionDeleteBusyRef.current=true;setSessionDeleteBusy(true);setSessionDeleteError(null);
    let complete=false;
    try{
      if(!target.archived){await invoke("archive_session",{sessionId:target.id});target.archived=true;}
      if(!target.previewId){
        const preview=await invoke<{preview_id:string;session_ids:string[]}>("preview_archive_deletion",{sessionIds:[target.id]});
        if(preview.session_ids.length!==1||preview.session_ids[0]!==target.id)throw Error("Deletion preview changed.");
        target.previewId=preview.preview_id;
      }
      const result=await invoke<{deleted_ids:string[];complete:boolean;issues:string[]}>("confirm_archive_deletion",{previewId:target.previewId});
      if(result.deleted_ids.some(id=>id!==target.id))throw Error("Deletion preview changed.");
      if(result.deleted_ids.length)clearDeletedSessionNames(result.deleted_ids);
      complete=result.complete;
      if(!complete)setSessionDeleteError("Deletion remains pending. Retry to finish, or browse archived sessions.");
    }catch(reason){setSessionDeleteError(String(reason));}
    finally{
      if(target.archived)await refreshHistory().catch(reason=>setSessionDeleteError(String(reason)));
      sessionDeleteBusyRef.current=false;setSessionDeleteBusy(false);
      if(complete)closeSessionDeletion();
    }
  }

  async function duplicateSession(id:string,quick=false){
    if(starting||creatingSession.current)return;const intent=++sessionCopyIntent.current;
    try{
      const record=await invoke<SessionRecord>("get_session",{sessionId:id});
      if(!terminalMounted.current||sessionCopyIntent.current!==intent)return;
      const copy=duplicateSessionDraft(record.summary,readSessionLaunchSettings(localStorage,id));
      const sourceView=terminalViews.current.get(id);if(sourceView?.appearance)copy.settings.appearance={...sourceView.appearance};
      if(quick&&!copy.reviewCommand&&!copy.warning){await startNewSession(copy);return;}
      newSession(copy.cwd);setLaunchDraft(copy.draft);setCwd(copy.cwd);setSessionCopy(copy);setSessionTerminal(copy.settings.terminal);
      setCopyName([...(titlesRef.current[id]||record.summary.launch?.adapter||"Terminal")].slice(0,190).join("")+" "+t("copy"));
      if(copy.reviewCommand){const advanced=launchDialog.current?.querySelector<HTMLDetailsElement>("details");if(advanced)advanced.open=true;}
    }catch{if(sessionCopyIntent.current===intent)setError("Could not copy this session. Its saved configuration was preserved.");}
  }
  function beginRename(id:string,title:string){renameTarget.current=id;setRenameTitle(title);setRenameError(null);renameDialog.current?.showModal();}
  function saveRename(reset=false){
    const id=renameTarget.current;if(!id)return false;
    try{const name=saveSessionName(localStorage,id,reset?null:renameTitle);const next={...titlesRef.current};if(name===null)delete next[id];else next[id]=name;titlesRef.current=next;setSessionTitles(next);renameDialog.current?.close();return true;}
    catch{setRenameError("Could not save the session name. Use 1–200 characters and try again.");return false;}
  }
  async function renameTab(id:string,title:string){
    const name=saveSessionName(localStorage,id,title);const next={...titlesRef.current,[id]:name!};titlesRef.current=next;setSessionTitles(next);
  }

  async function chooseDirectory(target: "launch" | "project") {
    try {
      const path = await selectProjectDirectory(async () => {
        const chosen = await openDirectoryDialog({directory: true, multiple: false, title: "Choose project directory"});
        if (Array.isArray(chosen)) throw new Error("Expected one directory");
        return chosen;
      }, path => invoke("validate_project_directory", {path}));
      if (path !== null) { if (target === "launch") {setCwd(path);setLaunchDirectoryOverride(path);} else { setProjectPath(path); setProjectError(null); } }
    } catch (reason) { if (target === "launch") setError(String(reason)); else setProjectError(String(reason)); }
  }

  async function saveProject() {
    if(!isMainWindow)return;
    const path = projectPath.trim();
    if (!path.startsWith("/") && !/^[A-Za-z]:[\\\\/]/.test(path)) {
      setProjectError("Enter an absolute directory path.");
      return;
    }
    try { await invoke("validate_project_directory", {path}); }
    catch (reason) { setProjectError(String(reason)); return; }
    const name = newProjectName.trim() || projectName(path);
    try{const current=projectsRef.current,matches=current.filter(project=>projectKey(project.path)===projectKey(path)),previous=matches.length===1&&matches[0].path===path?matches[0]:undefined;commitProjects([...current.filter(project=>projectKey(project.path)!==projectKey(path)),{...previous,path,name,hidden:false}]);}
    catch{setProjectError("Could not save project. Try again.");return;}
    setActiveProject(path);
    setCollapsedProjects((previous) => {
      const next = new Set(previous);
      next.delete(projectKey(path));
      return next;
    });
    projectDialog.current?.close();
  }

  function openSettingsSection(page:SettingsPage){
    if(!isMainWindow){openMainSettings(page);return;}
    if(starting||systemEntryBusy)return;
    if(terminalProfilesOpen){if(terminalProfileCollection.selectedId)selectTerminalProfile(terminalProfileCollection.selectedId);else newTerminalProfile();}
    setDataSettingsOpen(false);setAppearanceOpen(false);setTerminalSettingsOpen(false);setTerminalProfilesOpen(false);setKeyboardShortcutsOpen(false);setPasteSettingsOpen(false);setUpdaterOpen(false);setSystemEntryOpen(false);setDirectoryReportingOpen(false);setCommandReportingOpen(false);launchSettingsDialog.current?.close();
    const pages:Record<SettingsPage,()=>void>={support:()=>setDataSettingsOpen(true),appearance:()=>setAppearanceOpen(true),settings:()=>setTerminalSettingsOpen(true),profiles:()=>setTerminalProfilesOpen(true),"keyboard-shortcuts":()=>setKeyboardShortcutsOpen(true),"paste-settings":()=>setPasteSettingsOpen(true),updates:()=>setUpdaterOpen(true),"system-entry":()=>{setSystemEntryOpen(true);void refreshSystemEntry();},"directory-reporting":()=>setDirectoryReportingOpen(true),"command-reporting":()=>setCommandReportingOpen(true),"launch-settings":()=>{setLaunchDefaultsNotice(null);requestAnimationFrame(()=>launchSettingsDialog.current?.showModal());}};
    pages[page]();
  }
  async function exportPreferences(){return invoke<boolean>("export_preferences",{backup:createPreferencesBackup(key=>window.localStorage.getItem(key),launchTemplateCollection.templates,shortcutMac)});}
  async function importPreferences(backup:PreferencesBackup){
    const writes=preferencesImportWrites(backup,launchTemplateCollection.templates,undefined,launchTemplateCollection.loadError,appPreferences);
    // Commit local preferences before publishing them; no task or CLI configuration is touched.
    applyPreferencesImport(window.localStorage,writes);
    const appearance=loadAppPreferences(()=>window.localStorage.getItem(APP_PREFERENCES_KEY));if(!appearance.error)applyAppPreferences(appearance.value,false);
    if(writes["yam.terminalSettings"]){const defaults=loadTerminalSettings(()=>window.localStorage.getItem("yam.terminalSettings"));terminalSettingsRef.current=defaults.settings;setTerminalSettings(defaults.settings);}
    if(writes["yam.terminalLineHeight.v1"]){const next=loadTerminalLineHeight(()=>window.localStorage.getItem("yam.terminalLineHeight.v1"));terminalLineHeightRef.current=next.lineHeight;setTerminalLineHeight(next.lineHeight);}
    if(writes["yam.terminalCursor.v1"]){const next=loadTerminalCursor(()=>window.localStorage.getItem("yam.terminalCursor.v1"));terminalCursorRef.current=next.cursor;setTerminalCursor(next.cursor);}
    if(writes["yam.appShortcuts.v1"]){const keyboard=loadAppShortcuts(key=>window.localStorage.getItem(key),shortcutMac);shortcutsRef.current=keyboard.bindings;setShortcuts(keyboard.bindings);}
    launchTemplateCollection.load();refreshLaunchTemplateUi();
    for(const [key,value]of Object.entries(writes))await publishWindowPreference(nativeInvoke,desktopWindow,key,value);
  }
  function settingsNavigation(page:SettingsPage){return (dirty:boolean)=><SettingsNavigation current={page} dirty={dirty} blocked={starting||systemEntryBusy} onSelect={openSettingsSection}/>;}
  const settingsOpen=appearanceOpen||terminalSettingsOpen||terminalProfilesOpen||keyboardShortcutsOpen||pasteSettingsOpen||updaterOpen||systemEntryOpen||directoryReportingOpen||commandReportingOpen||dataSettingsOpen||capacityOpen;
  const settingsOrigin=useRef<HTMLElement|null>(null);
  useLayoutEffect(()=>{
    if(settingsOpen){settingsOrigin.current=document.activeElement instanceof HTMLElement&&document.activeElement!==document.body?document.activeElement:null;return;}
    const origin=settingsOrigin.current;settingsOrigin.current=null;if(!origin)return;
    const frame=requestAnimationFrame(()=>{if(origin.isConnected&&document.activeElement===document.body&&!document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]'))origin.focus();});
    return()=>cancelAnimationFrame(frame);
  },[settingsOpen]);

  const newSessionButton = <button className="new-session-button" onClick={() => newSession()}>
          <Plus aria-hidden="true" />
          {t("New session")}</button>;
  const scrollView=session?.session_id?terminalViews.current.get(session.session_id):undefined;
  const showScrollControl=scrollView?.scroll?.held&&scrollView.projection&&!!scrollView.frameInstance&&!scrollView.disposed&&scrollView.ready&&(scrollView.live||scrollView.persisted);

  return (
    <div className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"} ${projectToolsOpen?"project-tools-open":""}`}>
      {!conversationOpen&&scrollView?.find?.state.visible&&<TerminalFindBar key={session!.session_id} controller={scrollView.find} onClose={()=>closeTerminalFind(scrollView,session!.session_id)} onLogSearch={()=>setLogSearchOpen(true)}/>}
      {terminalSettingsError&&<p role="alert" className="terminal-preference-error">{t(terminalSettingsError)}</p>}
      {dataSettingsOpen&&<DataSettings navigation={settingsNavigation("support")} mac={shortcutMac} onClose={()=>setDataSettingsOpen(false)} onExport={exportPreferences} onImport={importPreferences} onDiagnostics={()=>void exportDiagnostics()} diagnosticsStatus={diagnosticsMessage} diagnosticsBusy={diagnosticsExporting} onNotification={()=>void testNotification()} notificationStatus={notificationTestStatus} canNotify={!!session&&!notificationTestBusy.current}/>}
      {updaterOpen&&<UpdaterSettings navigation={settingsNavigation("updates")} snapshot={updaterSnapshot} automatic={updaterAutomatic} busy={updaterBusyAction} error={updaterError} onAutomatic={value=>void changeUpdaterAutomatic(value)} onAction={action=>void runUpdaterAction(action)} onClose={closeUpdaterSettings}/>}
      {systemEntryOpen&&<dialog ref={systemEntryDialog} className="app-dialog system-entry-dialog settings-surface" aria-label={t("System entry")} onCancel={event=>{event.preventDefault();if(!systemEntryBusy)setSystemEntryOpen(false);}}><header className="dialog-header"><h2>{t("System entry")}</h2></header>{settingsNavigation("system-entry")(false)}<div className="settings-page-body"><SystemEntrySettings showTitle={false} enabled={systemEntry.global_shortcut_enabled} registered={systemEntry.global_shortcut_registered} available={systemEntry.shortcut_available} busy={systemEntryBusy} warning={systemEntry.warning} onChange={enabled=>void setGlobalShortcut(enabled)}/></div><footer className="dialog-actions"><button type="button" disabled={systemEntryBusy} onClick={()=>setSystemEntryOpen(false)}>{t("Close")}</button></footer></dialog>}
      {isMainWindow&&browserOpen&&<BrowserWindowDialog snapshot={browserControls.current.snapshot} busy={browserControls.current.busy} error={browserControls.current.error} onAction={(action,url)=>void browserAction(action,url)} onRefresh={()=>void openBrowserDialog()} onClose={closeBrowserDialog}/>}
      {fileDropPreview&&<TerminalFileDropDialog content={fileDropPreview} dialog={fileDropDialog} busy={fileBusy} onConfirm={()=>void confirmTerminalFileDrop()} onCancel={cancelTerminalFileDrop}/>}
      {filePreview&&<TerminalFilePreview content={filePreview} dialog={fileDialog} onConfirm={()=>void confirmTerminalFile()} onCancel={cancelTerminalFile}/>}
      {pastePreview&&<TerminalPastePreview content={pastePreview} dialog={pasteDialog} onConfirm={confirmTerminalPaste} onCancel={()=>cancelTerminalPaste()}/>}
      {directoryReportingOpen&&<ZshDirectoryReporting navigation={settingsNavigation("directory-reporting")} enabled={directoryReporting} error={directoryReportingError} onApply={applyDirectoryReporting} onClose={()=>setDirectoryReportingOpen(false)}/>}
      {commandReportingOpen&&<ZshCommandReporting navigation={settingsNavigation("command-reporting")} enabled={commandReporting} error={commandReportingError} onApply={applyCommandReporting} onClose={()=>setCommandReportingOpen(false)}/>}
      {pasteSettingsOpen&&<TerminalPasteSettings navigation={settingsNavigation("paste-settings")} mode={pasteMode} error={pastePolicyError} onApply={applyPastePolicy} onClose={()=>setPasteSettingsOpen(false)}/>}
      {isMainWindow&&sshOpen&&<SshLaunchDialog busy={starting} error={sshError??error} cwd={currentProject?.path||session?.cwd||activeProject||cwd} onConnect={value=>void connectSsh(value)} onClose={()=>setSshOpen(false)}/>}
      {terminalProfilesOpen&&<TerminalProfiles navigation={settingsNavigation("profiles")} fonts={terminalFonts} fontError={fontCatalogError} profiles={terminalProfileCollection.profiles} selectedId={terminalProfileCollection.selectedId} defaultId={terminalProfileCollection.defaultId} draft={terminalProfileDraft} windows={shellWindows} starting={starting} error={terminalProfileCollection.writeError??terminalProfileActionError??terminalProfileCollection.loadError??error} onDraftChange={setTerminalProfileDraft} onSelect={selectTerminalProfile} onNew={newTerminalProfile} onSave={saveTerminalProfile} onUpdate={updateTerminalProfile} onDuplicate={duplicateTerminalProfile} onDelete={deleteTerminalProfile} onDefault={defaultTerminalProfile} onStart={()=>void startSelectedTerminalProfile()} onWithoutProfile={()=>{setTerminalProfilesOpen(false);newSession(undefined,null);}} onClose={()=>setTerminalProfilesOpen(false)}/>}
      {appearanceOpen&&<AppAppearance navigation={settingsNavigation("appearance")} onTerminalSettings={()=>{setAppearanceOpen(false);setTerminalSettingsOpen(true);}} value={appPreferences} error={appPreferenceError} onSave={applyAppPreferences} onClose={()=>setAppearanceOpen(false)}/>}
      {terminalSettingsOpen&&<TerminalSettingsDialog navigation={settingsNavigation("settings")} settingsError={terminalSettingsError} fonts={terminalFonts} fontError={fontCatalogError} lineHeight={terminalLineHeight} lineHeightError={terminalLineHeightError} onLineHeightApply={applyTerminalLineHeight} retention={terminalRetention} retentionError={terminalRetentionError} onRetentionApply={applyTerminalRetention} cursor={terminalCursor} cursorError={terminalCursorError} onCursorApply={applyTerminalCursor} settings={terminalSettings} shell={shellLaunch} shellWindows={shellWindows} shellError={shellLaunchError} onDirectoryReporting={()=>{setTerminalSettingsOpen(false);setDirectoryReportingOpen(true);}} onCommandReporting={()=>{setTerminalSettingsOpen(false);setCommandReportingOpen(true);}} onShellApply={applyShellPreferences} onApply={applyTerminalPreferences} onClose={()=>setTerminalSettingsOpen(false)}/>}
      {keyboardShortcutsOpen&&<KeyboardShortcutSettings navigation={settingsNavigation("keyboard-shortcuts")} bindings={shortcuts} mac={shortcutMac} warning={shortcutError} onSave={saveKeyboardShortcuts} onClose={()=>setKeyboardShortcutsOpen(false)}/>}
      {paletteOpen&&<CommandPalette query={paletteQuery} onQuery={setPaletteQuery} entries={commandEntries} onChoose={entry=>void choosePaletteEntry(entry)} onClose={closeCommandPalette}/>}
      {capacityOpen&&<dialog ref={capacityDialog} className="app-dialog history-capacity-dialog" aria-label={t("History capacity management")} onCancel={event=>{event.preventDefault();setCapacityOpen(false);}}>
        <header className="dialog-header"><h2>{t("History capacity management")}</h2><button type="button" className="icon-button" aria-label={t("Close")} onClick={()=>setCapacityOpen(false)}><X aria-hidden="true"/></button></header>
        <div className="history-capacity-controls">
          <p role="status">{history.length} {t("loaded ·")+" "}{historyOverview.total} {t("sessions ·")+" "}{historyOverview.active} {t("active")}</p>
          {historyCursor&&<button type="button" disabled={historyLoading} onClick={()=>void loadMoreHistory()}>{t("Load more sessions")}</button>}
          {historyOverview.metadata_bytes!=null&&capacityLevel(historyOverview.metadata_bytes)!=="normal"&&<p role="status">{t("History metadata")+" "}{capacityLevel(historyOverview.metadata_bytes)==="protected"?t("has reached its 32 MiB protection limit"):t("is near its 32 MiB limit")}</p>}
            <p>{t("No history is deleted automatically. Browse archived sessions to restore saved history.")}</p>
            {capacity&&<><dl>{([['Metadata',capacity.metadata_bytes],['Logs',capacity.log_bytes],['Scenes',capacity.scene_bytes],['Backups',capacity.backup_bytes],['Archive',capacity.archive_bytes],['Other',capacity.other_bytes]] as const).map(([name,bytes])=><div key={name}><dt>{t(name)}</dt><dd>{(bytes/1024/1024).toFixed(2)} {t("MiB")}</dd></div>)}</dl><p>{capacity.complete?t("Complete scan"):t("Partial scan")} · {capacity.scanned_entries} {t("entries")}</p>{capacity.issues.length>0&&<p>{t("Some entries could not be scanned. Totals may be incomplete.")}</p>}</>}
            {capacityError&&<p role="alert">{t(capacityError)}</p>}
            <button type="button" className="secondary-button" disabled={capacityBusy} onClick={()=>void scanCapacity()}>{t("Refresh capacity")}</button>
            {capacityBusy&&<button type="button" onClick={()=>void cancelCapacity()}>{t("Cancel scan")}</button>}
        </div>
        <footer className="dialog-actions"><button type="button" className="secondary-button" onClick={()=>{setCapacityOpen(false);setArchiveOpen(true);}}>{t("Browse archived sessions")}</button><button type="button" className="secondary-button" onClick={()=>setCapacityOpen(false)}>{t("Close")}</button></footer>
      </dialog>}
      {archiveOpen&&<HistoryArchive titleFor={titleFor} history={history} onDeleted={clearDeletedSessionNames} onClose={()=>{setArchiveOpen(false);void refreshHistory();}} onChanged={async()=>{await refreshHistory();if(capacityOpen)await scanCapacity();}} onSelect={async id=>{if(!await openSession(id))throw Error("Session selection was superseded or unavailable");}}/>}
      {logSearchOpen&&<SessionLogSearch sessions={history.map(record=>({id:record.summary.session_id,title:titleFor(record.summary),cwd:record.summary.cwd}))} selected={session?.session_id??null} onClose={()=>setLogSearchOpen(false)} onSelect={async id=>{if(!await openSession(id))throw Error("Session selection was superseded or unavailable");}}/>}
      {logExportOpen&&session&&<SessionLogExport sessionId={session.session_id} title={titleFor(session)} onClose={()=>setLogExportOpen(false)}/>}
      <dialog ref={projectDeleteDialog} className="app-dialog" aria-label={t("Delete project")} onCancel={event=>{event.preventDefault();closeProjectDeletion();}}><h2>{t("Delete project")}</h2><p>{t("Delete project {{value0}} from the sidebar?",{value0:projectDelete?.name??""})}</p><p>{t("Project files and session history are kept. Add the directory again to show it in the sidebar.")}</p><div className="dialog-actions"><button type="button" onClick={closeProjectDeletion}>{t("Cancel")}</button><button type="button" onClick={()=>confirmProjectDeletion(projectDelete)}>{t("Delete")}</button></div></dialog>
      <dialog ref={sessionDeleteDialog} className="app-dialog session-delete-dialog" aria-label={t("Delete session")} aria-describedby="session-delete-description" onCancel={event=>{event.preventDefault();closeSessionDeletion();}}><header className="dialog-header"><h2>{t("Delete session")}</h2></header><div className="dialog-body" id="session-delete-description"><p>{t("Delete session {{value0}}?",{value0:sessionDelete?.title??""})}</p><p>{t("Permanently deletes this session's YAM history, log and saved terminal scene. This cannot be undone. Project files and native CLI history are kept.")}</p><p>{t("If deletion cannot finish, the session remains in archived history. Retry here or open archived sessions.")}</p>{sessionDeleteError&&<p role="alert">{t(sessionDeleteError)}</p>}</div><div className="dialog-actions"><button type="button" disabled={sessionDeleteBusy} onClick={closeSessionDeletion}>{t("Cancel")}</button><button type="button" disabled={sessionDeleteBusy} onClick={()=>void confirmSessionDeletion()}>{t("Delete")}</button></div></dialog>
      <aside
        className="sidebar"
        aria-label={t("Projects and sessions")}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
        <header className="sidebar-header">
          <span className="brand-name">{t("YAM")}</span>
          <button
            className="icon-button"
            aria-label={t("Collapse sidebar")}
            title={t("Collapse sidebar")}
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose />
          </button>
        </header>
        {sidebarOpen&&newSessionButton}
        {isMainWindow&&updaterSnapshot&&["available","downloading","verified","installing","restarting"].includes(updaterSnapshot.state)&&<button type="button" className="update-badge" onClick={()=>setUpdaterOpen(true)}>{updaterSnapshot.state==="verified"?t("Update ready · ")+updaterSnapshot.release?.version:updaterSnapshot.state==="installing"||updaterSnapshot.state==="restarting"?t("Installing update…"):updaterSnapshot.state==="downloading"?t("Downloading update…"):t("Update available · ")+updaterSnapshot.release?.version}</button>}
        <div className="sidebar-search">
        <div className="search-field">
          <Search aria-hidden="true" />
          <input
            ref={searchInput}
            onKeyDown={event=>{
              if(event.nativeEvent.isComposing)return;
              if(event.key==='Enter'){const match=visibleProjects.flatMap(project=>project.sessions)[0];if(match){event.preventDefault();void openSession(match.summary.session_id);}}
              else if(event.key==='Escape'){setHistoryQuery("");terminal.current?.focus();}
            }}
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.target.value)}
            placeholder={t("Search")}
            aria-label={t("Search projects and sessions")}
          />
          {historyQuery && (
            <button
              className="icon-button small"
              aria-label={t("Clear search")}
              title={t("Clear search")}
              onClick={() => setHistoryQuery("")}
            >
              <X />
            </button>
          )}
        </div>
        <details className="toolbar-more session-filter-tools" onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
          <summary className="icon-button small" aria-label={t("Filter sessions by status")} title={t("Filter sessions by status")}><ListFilter aria-hidden="true"/>{statusFilter!=="all"&&<span className="filter-active"/>}</summary>
          <div className="toolbar-more-actions">
        <Select aria-label={t("Filter sessions by status")} value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          <option value="all">{t("All sessions")}</option><option value="active">{t("Active")}</option>
          <option value="attention">{t("Needs attention")}</option><option value="succeeded">{t("Completed")}</option><option value="stopped">{t("Stopped")}</option>
        </Select>
          <button type="button" onClick={openCommandPalette}>{t("Find session")}</button>
          </div>
        </details>
        </div>
        {(unreadTotal>0||historyOverview.attention_sessions>0)&&<div className="sidebar-attention">
          {unreadTotal>0&&<button type="button" className="inbox-toggle" onClick={()=>setInboxOpen(value=>!value)} aria-expanded={inboxOpen}><Bell size={14} aria-hidden="true"/>{t("Inbox ·")+" "}{unreadTotal} {t("unread")}</button>}
          {historyOverview.attention_sessions>0&&<button type="button" className={unreadTotal>0?"icon-button small":"inbox-toggle"} onClick={jumpToAttention} aria-label={t("Next attention")} title={t("Next attention")+(shortcutHint(shortcuts.attention,shortcutMac)?" · "+shortcutHint(shortcuts.attention,shortcutMac):"")}>{unreadTotal>0?<ChevronRight aria-hidden="true"/>:t("Next attention")}</button>}
        </div>}
        {inboxOpen && <section className="agent-inbox" aria-label={t("Agent round inbox")}>
          {inbox.map(({session:record,receipt:entry})=>{
            const agent=sessionId.current===record.summary.session_id?currentAgent:undefined;
            return <AttentionCard key={`${record.summary.session_id}:${entry.id}`} record={record} entry={entry} agent={agent} title={titleFor(record.summary)} onOpen={()=>void openReceipt(record,entry,agent)}/>;
          })}
          {inboxCursor&&<button type="button" onClick={()=>void refreshInbox(true)}>{t("Load more unread rounds")}</button>}
          {!unreadTotal && <p>{t("No unread rounds")}</p>}
        </section>}
        <div className="section-label">
          <span>{t("Projects")}</span>
          <button
            className="icon-button small"
            aria-label={t("Add project")}
            title={t("Add project")}
            onClick={addProject}
          >
            <FolderPlus />
          </button>
        </div>
        <nav className="project-list" aria-label={t("Projects")}>
          {visibleProjects.map((project) => {
            const key = projectKey(project.path);
            const expanded = !collapsedProjects.has(key) || !!normalizedQuery || statusFilter!=="all";
            const grouped=sidebarSessions(project.sessions,session?.session_id??null,pinnedSessions,!!normalizedQuery||statusFilter!=="all");
            const renderSession=(record:HistoryItem)=>(
<div className="session-item" key={record.summary.session_id}><button
                        className={`session-row ${session?.session_id === record.summary.session_id ? "selected" : ""}`}
                        key={record.summary.session_id}
                        aria-current={
                          session?.session_id === record.summary.session_id
                            ? "page"
                            : undefined
                        }
                        title={`${titleFor(record.summary)}\n${t(statusLabels[record.status] ?? record.status)}${record.summary.mode==="interactive"?" · "+(!["starting","running"].includes(record.status)?t("Last event: "):"")+t(agentLabel({phase:record.agent.phase,integration:record.agent.integration,agent_session_id:null,inbox:[]},record.status)):""}`}
                        onContextMenu={event=>{event.preventDefault();openSessionMenu(event.currentTarget,event.clientX,event.clientY);}}
                        onKeyDown={event=>{if(event.key==="ContextMenu"||event.shiftKey&&event.key==="F10"){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();openSessionMenu(event.currentTarget,rect.left,rect.bottom);}}}
                        onClick={() => void openSession(record.summary.session_id)}
                      >
                        <span
                          className={`session-dot status-${record.status}`}
                          aria-label={
                            t(statusLabels[record.status] ?? record.status)
                          }
                        />
                        <span className="session-title">
                          {titleFor(record.summary)}
                        </span>
                        {record.agent?.unread_count>0&&<span className="session-unread" aria-label={t("{{value0}} unread",{value0:record.agent.unread_count})}>{record.agent.unread_count}</span>}
                      </button><details className="toolbar-more session-context-menu" onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;const target=event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(".session-row")??event.currentTarget.querySelector("summary");target?.focus();}}}><summary className="sr-only" tabIndex={-1} onFocus={event=>event.currentTarget.closest(".session-item")?.querySelector<HTMLButtonElement>(".session-row")?.focus()}>{t("Session actions")}</summary><div className="toolbar-more-actions" role="menu" aria-label={t("Session actions")}><button type="button" role="menuitem" disabled={starting} onClick={()=>void duplicateSession(record.summary.session_id,true)}>{t("New with these settings")}</button><button type="button" role="menuitem" onClick={()=>void duplicateSession(record.summary.session_id)}>{t("Duplicate session…")}</button><button type="button" role="menuitem" onClick={()=>beginRename(record.summary.session_id,titleFor(record.summary))}>{t("Rename session")}</button><button type="button" role="menuitem" onClick={()=>toggleSessionPin(record.summary.session_id)}>{pinnedSessions.includes(record.summary.session_id)?t("Unpin"):t("Pin")}</button>{isMainWindow&&<button type="button" role="menuitem" className="session-delete-action" disabled={!["succeeded","failed","stopped"].includes(record.status)} onClick={()=>beginSessionDeletion(record)}>{t("Delete")}</button>}</div></details>{!!record.previous_runs?.length&&<details className="session-runs"><summary>{t("Previous runs (")}{record.previous_runs.length})</summary>{record.previous_runs.map((id,index)=><button key={id} type="button" onClick={()=>void openSession(id,undefined,undefined,true)}>{t("Open run")+" "}{record.previous_runs!.length-index}</button>)}</details>}</div>
            );
            return (
              <div className="project-group" key={key}>
                <div
                  className={`project-row ${currentProject?.path === project.path ? "current-project" : ""}`}
                  onDragOver={event=>dropProject(event,project.path)}
                  onDrop={event=>dropProject(event,project.path,true)}
                >
                  <button
                    type="button"
                    className="project-toggle"
                    draggable={isMainWindow&&canRenameProject(project)}
                    onDragStart={event=>beginProjectDrag(event,project)}
                    onDragEnd={endProjectDrag}
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
                    {project.icon==="terminal"?<TerminalSquare aria-hidden="true" style={{color:projectColor(project.color)}}/>:project.icon==="play"?<Play aria-hidden="true" style={{color:projectColor(project.color)}}/>:expanded?<FolderOpen aria-hidden="true" style={{color:projectColor(project.color)}}/>:<Folder aria-hidden="true" style={{color:projectColor(project.color)}}/>}
                    <span>{project.name}</span>
                    <span className="project-count">
                      {project.sessions.length}
                    </span>
                  </button>
                  {isMainWindow&&<details className="toolbar-more project-more" onToggle={event=>positionProjectMenu(event.currentTarget)} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}><summary aria-label={t("Actions for project {{value0}}", {value0:project.name})} title={t("Project actions")}>⋯</summary><div className="toolbar-more-actions desktop-menu">
                  <button type="button" className="secondary-button" onClick={()=>newSession(project.path)}><Plus aria-hidden="true"/><span>{t("New session")}</span></button>
                  {isMainWindow&&canRenameProject(project)&&<>
                    <div className="menu-separator" role="separator"/>
                    <button type="button" className="secondary-button" aria-label={t("Edit project {{value0}}", {value0:project.name})} onClick={()=>beginProjectRename(project)}><Pencil aria-hidden="true"/><span>{t("Edit project…")}</span></button>
                    <button type="button" className="secondary-button" aria-label={`${project.pinned?t("Unpin project"):t("Pin project")} ${project.name}`} onClick={()=>pinProject(project.path,project.pinned!==true)}>{project.pinned?<PinOff aria-hidden="true"/>:<Pin aria-hidden="true"/>}<span>{project.pinned?t("Unpin project"):t("Pin project")}</span></button>
                    <button type="button" className="secondary-button" aria-label={t("Move project {{value0}} up", {value0:project.name})} disabled={!canMoveProject(project.path,"up")} onClick={()=>moveProject(project.path,"up")}><ArrowUp aria-hidden="true"/><span>{t("Move up")}</span></button>
                    <button type="button" className="secondary-button" aria-label={t("Move project {{value0}} down", {value0:project.name})} disabled={!canMoveProject(project.path,"down")} onClick={()=>moveProject(project.path,"down")}><ArrowDown aria-hidden="true"/><span>{t("Move down")}</span></button>
                  </>}
                  <div className="menu-separator" role="separator"/>
                  <button type="button" className="secondary-button menu-danger" onClick={()=>deleteProject(project)}><Trash2 aria-hidden="true"/><span>{t("Delete project")}</span></button>
                  </div></details>}
                </div>
                {expanded && (
                  <div className="session-list">
                    {grouped.current.map(renderSession)}
                    {grouped.ended.length>0&&<details className="project-ended-sessions"><summary>{t("Ended sessions ({{value0}})",{value0:grouped.ended.length})}</summary>{grouped.ended.map(renderSession)}</details>}

                  </div>
                )}
              </div>
            );
          })}
          {visibleProjects.length === 0 && (
            <div className="sidebar-empty">
              {normalizedQuery ? t("No results") : t("No projects yet")}
            </div>
          )}
        </nav>
        <div className="sidebar-footer">
        <button type="button" className="sidebar-settings" onClick={()=>openSettingsSection("appearance")}><Settings size={15} aria-hidden="true"/>{t("Settings")}</button>
        <details className="toolbar-more sidebar-more" onToggle={event=>positionProjectMenu(event.currentTarget)} onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}><summary className="icon-button small" aria-label={t("Manage workspace")} title={t("Manage workspace")}><Ellipsis aria-hidden="true"/></summary><div className="toolbar-more-actions desktop-menu">
          <button type="button" className="secondary-button inbox-toggle" onClick={()=>setInboxOpen(value=>!value)} aria-expanded={inboxOpen}><Bell aria-hidden="true"/><span>{t("Inbox")}</span><span className="menu-meta">{unreadTotal}</span></button>
          <button type="button" className="secondary-button inbox-toggle" onClick={jumpToAttention} disabled={!historyOverview.attention_sessions} title={shortcutHint(shortcuts.attention,shortcutMac)||undefined}><ArrowDown aria-hidden="true"/><span>{t("Next attention")}</span></button>
          <div className="menu-separator" role="separator"/>
          <button type="button" className="secondary-button" disabled={!gitProjectPath} onClick={()=>{if(!isMainWindow){openMainSettings();return;}setProjectToolsPath(visibleGitContext?.root||gitProjectPath);setProjectToolsOpen(true);}}><GitBranch aria-hidden="true"/><span>{t("Project Git and worktrees")}</span></button>
          <button type="button" aria-label={t("Browse archived sessions")} onClick={()=>setArchiveOpen(true)}><Archive aria-hidden="true"/><span>{t("Browse archived sessions")}</span></button>
          <button type="button" onClick={()=>{setCapacityOpen(true);void scanCapacity();}}><HardDrive aria-hidden="true"/><span>{t("Manage history capacity")}</span></button>
          <div className="menu-separator" role="separator"/>
          <button type="button" className="menu-danger" disabled={stopAllBusy} onClick={()=>void stopAllAndQuit()}><LogOut aria-hidden="true"/><span>{t("Stop all tasks and quit YAM")}</span></button>
        </div></details>
        </div>
      </aside>
      <main className="main-panel">
        {starting&&<div className="session-start-progress" role="status">{t("Starting session…")}</div>}

        <header className="topbar">
          {!sidebarOpen && (
            <button
              className="icon-button"
              aria-label={t("Expand sidebar")}
              title={t("Expand sidebar")}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen />
            </button>
          )}
          {!sidebarOpen&&newSessionButton}
          <div className="breadcrumb">
            <span className="breadcrumb-project">
              {currentProject?.name || t("YAM")}
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
                data-phase={isRunning&&session.launch?.mode==="interactive"?currentAgent?.phase:undefined}
                data-integration={isRunning&&session.launch?.mode==="interactive"?currentAgent?.integration??"unavailable":undefined}
                title={session.launch?.mode==="interactive"?t("Last confirmed CLI event; missing hooks can leave this status stale."):undefined}
              >
                <span className="session-dot" />
                {isRunning&&session.launch?.mode==="interactive"?t(agentLabel(currentAgent,sessionStatus)):isRunning&&agentPhase==="waiting"?t("Waiting for input"):t(statusLabels[sessionStatus] ?? sessionStatus)}
              </span>
            )}
            <details className="toolbar-more" onKeyDown={event=>{if(event.key==="Escape"&&!event.nativeEvent?.isComposing&&event.keyCode!==229){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
              <summary className="icon-button" aria-label={t("More actions")} title={t("More actions")}><Ellipsis aria-hidden="true" /></summary>
              <div className="toolbar-more-actions">
                <strong>{t("Session actions")}</strong>
                <small>{t("Hide tab keeps the task running. Closing this GUI keeps background tasks running. Stop session affects only the current task. Stop all tasks ends every background task.")}</small>

            <button className="icon-button" aria-label={t("Export session log")} title={t("Export session log")} disabled={!session} onClick={()=>setLogExportOpen(true)}><Copy/> {t("Export session log")}</button>

            <button type="button" className="icon-button" aria-pressed={notificationsPaused} aria-label={notificationsPaused?t("Resume notifications"):t("Pause notifications")} title={notificationsPaused?t("Resume notifications"):t("Pause notifications")} onClick={()=>void toggleNotificationPause()}>{notificationsPaused?<BellOff/>:<Bell/>} {notificationsPaused?t("Resume notifications"):t("Pause notifications")}</button>
            {isRunning && session && <button type="button" title={t("Take terminal input control from another connected window")} onClick={()=>void takeTerminalControl()}>{t("Take control")}</button>}
            {historyOverview.failed_receipts>0 && <button type="button" className="icon-button" aria-label={t("Retry round notifications")} title={t("Retry round notifications")} onClick={()=>void invoke("retry_agent_notifications").catch(reason=>setError(String(reason)))}><RotateCcw/> {t("Retry round notifications")}</button>}


            <button type="button" className="icon-button" aria-label={t("Close ended view")} title={t("Close saved ended view without deleting history")} disabled={!session||isRunning||!terminalViews.current.get(session.session_id)?.persisted} onClick={closeEndedView}><X/> {t("Close ended view")}</button>
            <button
              className="icon-button"
              title={session?.ssh?t("Reconnect SSH (new connection)"):t("Run again (new task)")}
              aria-label={session?.ssh?t("Reconnect SSH"):t("Run again")}
              disabled={!recovery.canRunAgain}
              onClick={rerunSelectedSession}
            >
              <RotateCcw /> {session?.ssh?t("Reconnect SSH"):t("Run again (new task)")}
            </button>
            {session?.launch?.mode==='interactive' && <button type="button" className="icon-button" aria-label={t("Continue conversation")} title={t("Continue original Agent conversation (new process)")} disabled={!canContinue} onClick={resumeSelectedSession}><Play/> {t(recovery.chooseNative?"Choose saved conversation…":"Continue conversation")}</button>}
            <button type="button" disabled={!session||starting} onClick={()=>{if(session)void duplicateSession(session.session_id,true);}}>{t("New with these settings")}</button>
            <button type="button" disabled={!session} onClick={()=>{if(session)void duplicateSession(session.session_id);}}>{t("Duplicate session…")}</button>
            <button className="icon-button" aria-label={t("Rename session")} title={t("Rename session")} disabled={!session}
              onClick={() => {if(session)beginRename(session.session_id,titleFor(session));}}><Pencil /> {t("Rename session")}</button>

              <button
                className="icon-button small"
                title={t("Copy terminal output")}
                aria-label={t("Copy terminal output")}
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
                <Copy /> {t("Copy terminal output")}</button>
              <button
                className="icon-button small"
                title={"Keep the current line. Saved logs are not deleted."+(shortcutHint(shortcuts["clear-display"],shortcutMac)?" · "+shortcutHint(shortcuts["clear-display"],shortcutMac):"")}
                aria-label={t("Clear terminal display")}
                disabled={!canClearTerminalDisplay()}
                onClick={() => void clearTerminalDisplay()}
              >
                <Eraser /> {t("Clear terminal display")}</button>

                <strong>{t("Session tools")}</strong>
                <button type="button" aria-label={t("Previous reported prompt")} disabled={!canNavigateReportedPrompt("previous")} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void navigateReportedPrompt("previous");}}>{t("Previous reported prompt")}</button>
                <button type="button" aria-label={t("Next reported prompt")} disabled={!canNavigateReportedPrompt("next")} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void navigateReportedPrompt("next");}}>{t("Next reported prompt")}</button>
                <small>{t("Reported prompt positions may differ from the visible prompt.")}</small>
                {shortcutMac&&<button type="button" aria-label={t("Show selected file in Finder…")} disabled={fileBusy||!!filePreview} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void previewSelectedTerminalFile();}}>{t("Show selected file in Finder…")}</button>}




                <button type="button" aria-label={t("Move tab to other window")} disabled={!canMoveTerminalTab()||moveBusy} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void moveTerminalTabToOtherWindow();}}>{t("Move tab to other window")}</button>
                <button type="button" aria-label={t("Check/Continue move")} disabled={moveBusy} onClick={()=>void continueTerminalMove()}>{t("Check/Continue move")}</button>
                {movePending&&terminalMoveIncomingRef.current?.target===desktopWindow.slot&&<button type="button" disabled={moveBusy} onClick={()=>void openMovedTerminalTab()}>{t("Open moved tab")}</button>}
                <button type="button" aria-label={t("Second terminal window")} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void openSecondWindow();}}>{t("Second terminal window")}</button>
                {isMainWindow&&<button type="button" aria-label={t("Connect SSH")} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");setSshError(null);setSshOpen(true);}}>{t("Connect SSH")}</button>}
                {isMainWindow&&<button type="button" aria-label={t("Browser")} onClick={event=>{event.currentTarget.closest("details")?.removeAttribute("open");void openBrowserDialog();}}>{t("Browser")}</button>}
                <button type="button" aria-label={t("Search session logs")} onClick={event=>{const menu=event.currentTarget.closest("details");if(menu)menu.open=false;setLogSearchOpen(true);}}>{t("Search session logs")}</button>
                <button type="button" aria-label={t("Command palette")} title={shortcutHint(shortcuts.palette,shortcutMac)||undefined} onClick={event=>{const menu=event.currentTarget.closest("details");if(menu)menu.open=false;openCommandPalette();}}>{t("Command palette")}</button>
                <strong>{t("Session details")}</strong>
                {session&&<><SessionConnection launch={session.launch} agent={currentAgent}/><span className="session-directory" title={session.cwd}>{t("Directory")+": "}{session.cwd}</span><span>{t("Terminal")+": "}{t(statusLabels[sessionStatus]??sessionStatus)}</span>{session.launch?.mode==="interactive"&&<span>{t("Last event: ")}{t(agentLabel(currentAgent,sessionStatus))}</span>}</>}
          {visibleGitContext && <div className="git-context" role="status">
            <span title={gitContextLabel(visibleGitContext,t)}>{gitContextLabel(visibleGitContext,t)}</span>
            {visibleGitContext.root && <span title={visibleGitContext.root}>{t("Worktree:")+" "}{visibleGitContext.root}</span>}
            {visibleGitContext.common_dir && <span title={visibleGitContext.common_dir}>{t("Common Git directory:")+" "}{visibleGitContext.common_dir}</span>}
          </div>}
                {session&&<>
            <span aria-label={t("Terminal-reported directory")}>{t("Terminal-reported directory:")+" "}{scrollView?.ready&&!scrollView.disposed&&scrollView.live&&!scrollView.persisted&&scrollView.availability==="available"&&ownerConnectionAvailable.current.available&&terminalPaneVisible(session.session_id)?scrollView.reportedCwd??t("Not reported"):t("Not reported")}</span>
            <span aria-label={t("Shell-reported phase")}>{t("Shell-reported phase:")+" "}{scrollView?.ready&&!scrollView.disposed&&!scrollView.moving&&scrollView.live&&!scrollView.persisted&&scrollView.availability==="available"&&ownerConnectionAvailable.current.available&&terminalPaneVisible(session.session_id)?t({unknown:"Not reported",prompt:"Prompt",input:"Input",running:"Running",complete:"Complete"}[scrollView.reportedCommand?.phase??"unknown"]):t("Not reported")}</span>
            {scrollView?.reportedCommand?.last_exit!==null&&scrollView?.reportedCommand?.last_exit!==undefined&&scrollView.ready&&!scrollView.disposed&&!scrollView.moving&&scrollView.live&&!scrollView.persisted&&scrollView.availability==="available"&&ownerConnectionAvailable.current.available&&terminalPaneVisible(session.session_id)&&<span>{t("Last reported exit code:")+" "}{scrollView.reportedCommand.last_exit}</span>}
                </>}
                <details className="session-diagnostics"><summary>{t("Diagnostics")}</summary>

        <div className="engine-details">
          <span
            className={`session-dot ${health?.status === "ready" ? "status-running" : ""}`}
          />
          <span>
            {health?.status === "ready"
              ? t("Local engine ready")
              : t("Connecting...")}
          </span>
          <span className="version">{t("v")}{health?.version ?? "0.1.0"}</span>
        </div>
        <div className="diagnostics-details">
          <button type="button" aria-label={t("Export diagnostics")} title={t("Save version, connection and aggregate counts; excludes session content and paths")} disabled={diagnosticsExporting} onClick={()=>void exportDiagnostics()}>{diagnosticsExporting?t("Exporting…"):t("Export diagnostics")}</button>
          {diagnosticsMessage&&<span role="status">{t(diagnosticsMessage)}</span>}
          <button type="button" disabled={!session||notificationTestBusy.current} onClick={()=>void testNotification()}>{t("Send test notification")}</button>
          {notificationTestStatus&&<span role="status">{t(notificationTestStatus)}</span>}
            <span>{session ? session.session_id : t("No session selected")}</span>

          <span>{session ? t("Terminal") : (health?.platform ?? t("Local"))}</span>
        </div>
                {notificationError?.startsWith("Notifications are disabled.")&&<div className="notification-note"><p>{t(notificationError)}</p><button type="button" onClick={()=>{notifications.current.resetRetries();for(const event of retryNotifications.current.values())void notifySession(event);}}>{t("Retry notifications")}</button></div>}
              </details>
              </div>
            </details>
            {isRunning&&<button
              className="icon-button stop-button"
              title={t("Stop session")}
              aria-label={t("Stop session")}
              disabled={!isRunning}
              onClick={() => void stopSession()}
            >
              <Square />
            </button>}
          </div>
        </header>
        {session&&<div className="workspace-viewbar">
          <div className="terminal-tools" role="group" aria-label={t("Session view")}>
            <button type="button" aria-pressed={!conversationOpen} onClick={()=>showConversation(false)}>{t("Terminal")}</button><button type="button" aria-pressed={conversationOpen} onClick={()=>showConversation(true)}>{t("Conversation")}</button>
            <button type="button" className="icon-button small terminal-find-button" aria-label={t("Find in terminal")} title={t("Find in terminal")} disabled={conversationOpen||!scrollView?.ready||!!scrollView.disposed} onClick={openTerminalFind}><Search aria-hidden="true"/><span className="sr-only">{t("Find in terminal")}</span></button>
          </div>
          {session.launch?.mode==="interactive"&&<span className="session-agent">{session.launch.adapter}</span>}
          <div className="workspace-actions">
            {isMainWindow&&session&&!session.ssh&&<button type="button" onClick={()=>{setProjectToolsTab("files");setProjectToolsPath(visibleGitContext?.root||session.cwd);setProjectToolsOpen(true);}}>{t("Files")}</button>}
            {session&&visibleGitContext?.branch&&<button type="button" className="workspace-changes" title={gitContextLabel(visibleGitContext,t)} onClick={()=>{if(!isMainWindow){openMainSettings();return;}setProjectToolsTab("changes");setProjectToolsPath(visibleGitContext.root||gitProjectPath);setProjectToolsOpen(true);}}>{t("Changes")}{visibleGitContext.dirty&&<span className="changes-dot" aria-label={t("Uncommitted changes")}/>}</button>}
          </div>
        </div>}
        <footer className="statusbar workspace-footer" aria-label={t("Status bar")}>
          <span className="statusbar-engine" title={health?.status==="ready"?t("Local engine ready"):t("Connecting...")}><span className={`session-dot ${health?.status==="ready"?"status-running":""}`}/><span>{health?.status==="ready"?t("Local engine ready"):t("Connecting...")}</span></span>
          <span className="statusbar-directory" title={session?.cwd||currentProject?.path||t("No session selected")}><Folder aria-hidden="true"/><span>{session?.cwd||currentProject?.path||t("No session selected")}</span></span>
          {visibleGitContext?.branch&&<span className="statusbar-branch" title={visibleGitContext.branch}><GitBranch aria-hidden="true"/><span>{visibleGitContext.branch}</span></span>}
          {session&&history.filter(record=>record.summary.cwd===session.cwd&&["starting","running"].includes(record.status)).length>1&&<span className="parallel-directory-warning" title={t("Another loaded session uses this directory.")}>{t("Shared directory")}</span>}
          {showScrollControl&&<span className="terminal-scroll-status">
            {scrollView.scroll?.newOutput&&<span role="status">{t("New output")}</span>}
            <button type="button" disabled={scrollView.scrollReturnPending||scrollView.attaching||!!scrollView.parsing||scrollView.availability==="owner_unavailable"||scrollView.availability==="terminal_unavailable"||!ownerConnectionAvailable.current.available} onClick={()=>void returnTerminalToLive()}>{scrollView.live?t("Return to live"):t("Return to bottom")}</button>
          </span>}
                  <span className="memory-usage" title={memory
                    ? t("{{value0}}: YAM desktop, WebKit, background and terminal parser. Tasks: PTY/Agent processes. Per-process sum; shared pages are not deduplicated. Refreshes every 5 seconds.", {value0:memory.metric})
                    : t("Memory sampling unavailable or incomplete. Refreshes every 5 seconds while visible.")}>{memoryLabel(memory,Date.now(),t)}</span>
        </footer>

        {session?.launch?.adapter==="pi"&&<PiRoutingBar key={`${session.session_id}:${currentAgent?.generation??''}`} sessionId={session.session_id} generation={currentAgent?.generation??''} active={isRunning} available={ownerConnectionAvailable.current.available} invoke={invoke}/>}
        <section
          className={`terminal-area ${terminalLayout.panes.some(Boolean) ? "" : "terminal-empty"} ${terminalLayout.mode==="single"&&!terminalLayout.panes.some(Boolean)?"terminal-whole-empty":""}`}
          aria-label={t("Terminal")}
          hidden={conversationOpen} inert={conversationOpen}
        >
          <div className="terminal-host terminal-cache-host" ref={terminalHost} aria-hidden="true" />
          <TerminalLayout tabAttention={id=>(history.find(record=>record.summary.session_id===id)?.agent?.unread_count??0)>0} onRenameTab={renameTab} onDuplicateTab={id=>void duplicateSession(id)} canReopen={canReopenTerminalTab()} onReopen={()=>void reopenTerminalTab()} ownerVersion={ownerConnectionAvailable.current.version} onTabDragStart={beginTerminalTabDrag} onTabDragCancel={cancelTerminalTabDrag} onTabDrop={commitTerminalTabDrag} onReorderTab={reorderTerminalSession} zoomedPaneId={zoomedPaneId} zoomRevision={terminalPaneZoomIntent.current} onDirection={focusTerminalPaneDirection} onZoom={toggleTerminalPaneZoom} tabLabel={id=>titleFor(terminalViews.current.get(id)?.record?.summary??{session_id:id,cwd:"",command:null,status:"unknown"})} onTab={selectTerminalTab} onHideTab={closeTerminalTab} onMoveTab={moveTerminalSession} onSplit={splitFocusedTerminalPane} layout={terminalLayout} labels={terminalLayout.panes.map(id=>id?titleFor(terminalViews.current.get(id)?.record?.summary??{session_id:id,cwd:"",command:null,status:"unknown"}):null)} splitPercent={splitPercent} swapDisabled={target=>!canSwapTerminalPanes(target)} onMode={changeLayoutMode} onFocus={focusTerminalPane} onClose={closeTerminalPane} onHost={mountTerminalPane} onSplitChange={commitTerminalSplit} onSplitPreview={value=>previewTerminalSplit(value,paneZoomGeneration)} onNodeSplitChange={(nodeId,value)=>commitTerminalNodeSplit(nodeId,value,paneZoomGeneration)} onSwap={swapTerminalPane} onCancelFit={()=>cancelTerminalLayoutFit(paneZoomGeneration)} />
          {!terminalLayout.panes.some(Boolean) && terminalLayout.mode==="single" && (
            <div className="empty-state">
              <TerminalSquare className="empty-icon" aria-hidden="true" />
              <h1>{currentProject?.name || t("No session selected")}</h1>
              <p>{t("Choose a session from the sidebar or select New session.")}</p>
              {visibleGitContext && <div className="git-context" role="status">
                <span>{gitContextLabel(visibleGitContext,t)}</span>
                {visibleGitContext.root && <span>{t("Worktree:")+" "}{visibleGitContext.root}</span>}
                {visibleGitContext.common_dir && <span>{t("Common Git directory:")+" "}{visibleGitContext.common_dir}</span>}
              </div>}
              {currentProject && (
                <p className="empty-path">{currentProject.path}</p>
              )}
              <div className="empty-actions">
                <button className="secondary-button" onClick={addProject}>
                  <FolderPlus aria-hidden="true" />
                  {t("Add project")}</button>
              </div>
            </div>
          )}
        </section>
        <ConversationView onTerminal={()=>showConversation(false)} roundRevision={conversationRoundRevision(currentAgent)} visible={conversationOpen} available={ownerConnectionAvailable.current.available} scope={JSON.stringify([ownerConnectionAvailable.current.version,session?.session_id,currentAgent?.generation,currentAgent?.agent_session_id,session?.cwd,session?.launch])} target={session?.launch?.adapter==="codex"&&!session.ssh&&currentAgent?.generation&&currentAgent.agent_session_id?{sessionId:session.session_id,threadId:currentAgent.agent_session_id,generation:currentAgent.generation}:null} invoke={invoke}/>
        {!ownerConnectionAvailable.current.available&&<div className="terminal-notice" role="alert">{t("Background connection unavailable. Tasks were not restarted.")}<button type="button" disabled={reconnecting} onClick={()=>void reconnectBackground()}>{t("Reconnect background")}</button></div>}
        {recoveryNotice && <div className="terminal-notice" role="status"><span>{t(recoveryNotice)}</span>{session&&!isRunning&&<div className="session-ended-actions">{canContinue&&<button type="button" onClick={resumeSelectedSession}>{t(recovery.chooseNative?"Choose saved conversation…":"Continue conversation")}</button>}{recovery.canOpenTerminal&&<button type="button" onClick={openSelectedTerminal}>{t("Open new terminal")}</button>}{recovery.canRunAgain&&(session.ssh||session.command||session.launch&&session.launch.adapter!=="shell")&&<button type="button" aria-label={session.ssh?t("Reconnect SSH"):t("Run again (new task)")} title={session.ssh?t("Reconnect SSH (new connection)"):t("Run again (new task)")} disabled={!recovery.canRunAgain} onClick={rerunSelectedSession}>{session.ssh?t("Reconnect SSH"):t("Run again (new task)")}</button>}</div>}</div>}
        {directoryReportingError&&<div className="terminal-notice" role="alert">{t(directoryReportingError)}<button type="button" onClick={()=>(isMainWindow?setDirectoryReportingOpen(true):void openMainSettings("directory-reporting"))}>{t("Zsh directory reporting settings")}</button></div>}
        {commandReportingError&&<div className="terminal-notice" role="alert">{t(commandReportingError)}<button type="button" onClick={()=>(isMainWindow?setCommandReportingOpen(true):void openMainSettings("command-reporting"))}>{t("Command status reporting settings")}</button></div>}
        {pastePolicyError&&<div className="terminal-notice" role="alert">{t(pastePolicyError)}<button type="button" onClick={()=>(isMainWindow?setPasteSettingsOpen(true):void openMainSettings("paste-settings"))}>{t("Paste settings")}</button></div>}
        {notificationError && !notificationError.startsWith("Notifications are disabled.") && (
          <div className="error-banner" role="alert">
            <span>{t(notificationError)}</span>
            <button onClick={() => {
              notifications.current.resetRetries();
              for (const event of retryNotifications.current.values()) void notifySession(event);
            }}>{t("Retry notifications")}</button>
          </div>
        )}
        {error && !launchDialog.current?.open && (
          <div className="error-banner" role="alert">
            <span>{t(error)}</span>
            {desktopWindow.restore_blocked&&!desktopWindow.preference.warning&&<button type="button" disabled={layoutRestoreRetrying} onClick={()=>void retrySavedLayout()}>{t("Retry saved layout")}</button>}
            <button
              className="icon-button small"
              title={t("Dismiss error")}
              aria-label={t("Dismiss error")}
              onClick={() => setError(null)}
            >
              <X />
            </button>
          </div>
        )}
      </main>
      <ProjectWorkspace open={projectToolsOpen} onClose={closeProjectTools} onResize={requestTerminalLayoutFit}>
        <nav className="project-tools-tabs" role="tablist" aria-label={t("Project tools")} onKeyDown={event=>{
          const tabs=["files","changes","worktrees"] as const,index=tabs.indexOf(projectToolsTab);
          const next=event.key==="ArrowRight"?(index+1)%3:event.key==="ArrowLeft"?(index+2)%3:event.key==="Home"?0:event.key==="End"?2:-1;
          if(next<0)return;event.preventDefault();setProjectToolsTab(tabs[next]);event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>
          {(["files","changes","worktrees"] as const).map(tab=><button key={tab} id={`project-tools-tab-${tab}`} type="button" role="tab" tabIndex={projectToolsTab===tab?0:-1} aria-selected={projectToolsTab===tab} aria-controls={`project-tools-${tab}`} onClick={()=>setProjectToolsTab(tab)}>{t(tab==="files"?"Files":tab==="changes"?"Changes":"Worktrees")}</button>)}
        </nav>
        <div className="project-tools-body">
          <section id="project-tools-files" className="project-tools-panel" role="tabpanel" aria-labelledby="project-tools-tab-files" hidden={projectToolsTab!=="files"}>
            {isMainWindow&&<ProjectFiles sessionId={session&&!session.ssh?session.session_id:null} root={session?.cwd??""} active={projectToolsOpen&&projectToolsTab==="files"} invoke={invoke} request={projectFileRequest}/>}
          </section>
          <section id="project-tools-changes" className="project-tools-panel" role="tabpanel" aria-labelledby="project-tools-tab-changes" hidden={projectToolsTab!=="changes"}>
            <RunChanges sessionId={session&&!session.ssh?session.session_id:null} root={session?.cwd??""} active={projectToolsOpen&&projectToolsTab==="changes"} invoke={invoke} onOpenFile={openDiffFile} onReview={reviewDiffFile}/>
            <GitChanges path={projectToolsPath} owner={gitOwner} active={projectToolsOpen&&projectToolsTab==="changes"} sessionId={session&&!session.ssh?session.session_id:null} onOpenFile={openDiffFile} onReview={reviewDiffFile}/>
            {isMainWindow&&<ReviewFeedback active={projectToolsOpen&&projectToolsTab==="changes"} origin={currentReviewOrigin} ready={reviewReady(reviewRecord,currentReviewOrigin)&&ownerConnectionAvailable.current.available} location={reviewLocation} onFill={fillReviewInOriginalTerminal}/>}
          </section>
          <section id="project-tools-worktrees" className="project-tools-panel" role="tabpanel" aria-labelledby="project-tools-tab-worktrees" hidden={projectToolsTab!=="worktrees"}>
            {projectToolsOpen&&<div className="dialog-fields"><p>{projectToolsPath}</p><WorktreeControls root={projectToolsPath} owner={gitOwner} selected={selectedWorktree} onCreated={worktreeCreated} onStart={startManagedWorktree}/></div>}
          </section>
          {error&&<p role="alert">{t(error)}</p>}
        </div>
      </ProjectWorkspace>

      <dialog ref={renameDialog} className="app-dialog" aria-labelledby="rename-title">
        <form onSubmit={event => {
          event.preventDefault();saveRename();
        }}>
          <header className="dialog-header"><h2 id="rename-title">{t("Rename session")}</h2></header>
          <div className="dialog-fields"><label><span>{t("Session name")}</span><input autoFocus value={renameTitle} onChange={event => setRenameTitle(event.target.value)} maxLength={200} /></label>
          {renameError && <p className="dialog-error" role="alert">{t(renameError)}</p>}</div>
          <footer className="dialog-actions"><button type="button" onClick={()=>saveRename(true)}>{t("Use automatic name")}</button><button className="secondary-button" type="button" onClick={() => renameDialog.current?.close()}>{t("Cancel")}</button><button className="primary-button" type="submit">{t("Save")}</button></footer>
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
          cancelProjectPreview();
          if (sessionId.current&&document.activeElement===document.body) terminal.current?.focus();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void startNewSession();
          }}
        >
          <header className="dialog-header">
            <h2 id="launch-title">{t("New session")}</h2>
          </header>
          <div className="dialog-fields">
            {sessionCopy&&<><label><span>{t("Session name")}</span><input value={copyName} maxLength={200} onChange={event=>setCopyName(event.target.value)}/></label><p className="settings-help">{t("Creates an independent session with the same settings. Conversation history is not copied.")}</p>{sessionCopy.warning&&<p className="settings-help" role="status">{t(sessionCopy.warning)}</p>}</>}
            <label>
              <span className="directory-field-heading">{t("Project directory")}<button className="directory-browse" type="button" onClick={() => void chooseDirectory("launch")}>{t("Browse…")}</button></span>
              <input
                autoFocus
                value={cwd}
                onChange={(event) => {setCwd(event.target.value);setLaunchDirectoryOverride(event.target.value);}}
                placeholder={t("/path/to/project")}
              />
            </label>
            <div className="startup-program-field">
              <span>{t("Startup program")}</span>
              <div className="startup-programs" role="group" aria-label={t("Startup program")}>
                {adapters.map(adapter => <button type="button" key={adapter.id} aria-pressed={formAdapter===adapter.id||(formAdapter==="custom"&&adapter.id==="shell")} title={!adapter.available&&adapter.id!=="shell"?t("{{value0}} was not found on PATH", {value0:adapter.label}):formLaunch.provider&&!supportsProvider(adapter.id,formLaunch.provider)?t("Switch Model connection to existing CLI configuration to choose this program."):adapter.label}
                  disabled={(!adapter.available && adapter.id!=="shell") || (!!formLaunch.provider&&!supportsProvider(adapter.id,formLaunch.provider))}
                  onClick={()=>changeAdapter(adapter.id)}>{adapter.id==="shell"?t("Terminal"):adapter.id==="codex"?t("Codex"):adapter.id==="claude"?t("Claude"):adapter.id==="gemini"?t("Gemini"):adapter.label}</button>)}
              </div>
            </div>
            {formAdapter==="pi"&&<PiRoutingConfig args={formLaunch.extra_args} cwd={cwd} invoke={invoke} onChange={args=>editLaunch({extra_args:args})} onValidity={setPiValidation}/>}
            {installedTerminals.length>0&&<label><span>{t("Open in")}</span><Select aria-label={t("Open session in")} value={sessionTerminal} onChange={event=>setSessionTerminal(event.target.value)}>
              <option value="yam">{t("YAM")}</option>
              {installedTerminals.includes("terminal")&&<option value="terminal">{t("System Terminal")}</option>}
              {installedTerminals.includes("iterm2")&&<option value="iterm2">{t("iTerm2")}</option>}
            </Select></label>}
            {sessionTerminal!=="yam"&&<small>{t("YAM keeps managing the task and notifications. Closing the external window or pressing Ctrl+] detaches the view; the task continues. The external app uses its own font and theme.")}</small>}
            {formLaunch.provider&&<div className="connection-summary" role="status"><span>{t("Session connection ·")+" "}{connectionDetails(formLaunch).model}</span><small>{t("Use existing CLI configuration to select any installed program.")}</small><button type="button" onClick={()=>changeProvider("inherited")}>{t("Use existing CLI configuration")}</button></div>}
            <details className="advanced-options">
              <summary>{t("Advanced options")}</summary>
              <p>{t("Use the CLI’s existing configuration by default. An independent connection applies only to this session and its child agents.")}</p>
              {["codex","claude","gemini"].includes(formAdapter)&&<label>
                <span>{t("Model connection")}</span>
                <Select aria-label={t("Model connection")} value={formLaunch.provider?"isolated":"inherited"} onChange={event=>changeProvider(event.target.value)}>
                  <option value="inherited">{t("Use existing CLI configuration")}</option>
                  <option value="isolated">{t("Configure API / gateway for this session")}</option>
                </Select>
              </label>}
              {formLaunch.provider&&<label>
                <span>{t("Service preset")}</span>
                <Select aria-label={t("Service preset")} value={providerChoice(formAdapter,formLaunch.provider)} onChange={event=>changeProvider(event.target.value)}>
                  <option value="custom">{t("Custom API / Magpie gateway")}</option>
                  {(installedGateways.includes("cc-switch")||providerChoice(formAdapter,formLaunch.provider)==="cc-switch")&&<option value="cc-switch" disabled={!installedGateways.includes("cc-switch")}>{t("CC Switch")}{installedGateways.includes("cc-switch")?"":t(" (not detected)")}</option>}
                  {["codex","claude"].includes(formAdapter)&&(installedGateways.includes("echobird")||providerChoice(formAdapter,formLaunch.provider)==="echobird")&&<option value="echobird" disabled={!installedGateways.includes("echobird")}>{t("EchoBird")}{installedGateways.includes("echobird")?"":t(" (not detected)")}</option>}
                  {formAdapter==="codex"&&<option value="deepseek">{t("DeepSeek")}</option>}
                  {formAdapter==="claude"&&<><option value="claude-api">{t("Claude API")}</option><option value="deepseek-claude">{t("DeepSeek")}</option><option value="gemini-claude">{t("Gemini via compatible gateway")}</option></>}
                  {formAdapter==="gemini"&&<option value="gemini-api">{t("Gemini API")}</option>}
                </Select>
              </label>}
            {gatewayDiscoveryError&&formLaunch.provider&&<small role="status">{t("Installed gateway discovery is unavailable. Enter the gateway URL manually.")}</small>}
            {formLaunch.provider&&["cc-switch","echobird"].includes(providerChoice(formAdapter,formLaunch.provider))&&<small>{t("Uses the default local routing address; update the URL if your port differs. Start routing in the gateway app first. YAM does not activate routing, switch accounts or edit shared CLI settings.")}</small>}
            {formLaunch.provider&&providerChoice(formAdapter,formLaunch.provider)==="echobird"&&formAdapter==="codex"&&<small>{t("EchoBird must support the Responses API for Codex; support varies by version.")}</small>}
            <label><span>{t("Saved connections")}</span><Select aria-label={t("Saved connections")} value="" onChange={event=>{const item=launchTemplateCollection.templates.find(item=>item.id===event.target.value);if(item?.provider&&supportsProvider(formAdapter,item.provider))editLaunch({provider:{...item.provider}});}}><option value="">{t("Choose a saved connection…")}</option>{launchTemplateCollection.templates.filter(item=>item.provider&&supportsProvider(formAdapter,item.provider)).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
            {formLaunch.provider&&<fieldset><legend>{t("Provider connection")}</legend>
              <label><span>{t("API / gateway URL")}</span><input aria-label={t("Provider endpoint")} value={formLaunch.provider.base_url} onChange={event=>changeProviderFields({base_url:event.target.value})}/></label>
              {formAdapter==='codex'?<small>{t("Codex requires a Responses API endpoint. Chat Completions compatibility alone is insufficient.")}</small>:formAdapter==='claude'?<small>{t("Claude requires an Anthropic Messages API endpoint. Check that the gateway supports this protocol.")}</small>:null}
              <ProviderCatalog endpoint={formLaunch.provider.base_url} model={formLaunch.provider.model} identityCheck={!["cc-switch","echobird"].includes(providerChoice(formAdapter,formLaunch.provider))} apiKeyEnv={formLaunch.provider.api_key_env} invoke={invoke} onSelect={model=>changeProviderFields({model})}><ProviderPortCheck endpoint={formLaunch.provider.base_url}/></ProviderCatalog>
              <label><span>{t("API key environment variable")}</span><input aria-label={t("API key environment variable")} value={formLaunch.provider.api_key_env??""} placeholder={t("Environment variable name")} onChange={event=>changeProviderFields({api_key_env:event.target.value||null})}/></label>
              {isMainWindow&&<div className="connection-save"><input aria-label={t("Connection name")} value={connectionName} maxLength={80} placeholder={t("Connection name")} onChange={event=>setConnectionName(event.target.value)}/><button type="button" disabled={!connectionName.trim()||!isProviderConfig(formLaunch.provider)} onClick={saveConnection}>{t("Save connection")}</button></div>}
              {launchTemplateActionError&&<p role="alert">{t(launchTemplateActionError)}</p>}
              <small>{t("Variable name, not the key. A local gateway managing its own key can leave this empty.")}</small><details className="connection-help"><summary>{t("Connection scope and troubleshooting")}</summary><p>{t("Only this Agent and its child processes use this connection. Ordinary terminals keep their own CLI configuration. The background owner must have the selected variable; reopening a window does not reload its environment. Finish tasks before restarting the owner to load changes. Codex uses a private snapshot of its existing configuration, with a separate history directory; later global changes apply to new sessions.")}</p></details>
            </fieldset>}
              {formAdapter==="codex"&&formLaunch.provider&&<label>
                <span>{t("Image generation")}</span>
                <Select aria-label={t("Image generation")} value={formLaunch.codex?.image_mode??"native"} onChange={event=>editLaunch({codex:{image_mode:event.target.value as "native"|"gateway_api"}})}>
                  <option value="native">{t("Codex default")}</option>
                  <option value="gateway_api">{t("Gateway image API (imagegen skill)")}</option>
                </Select>
                <small>{t("Codex default preserves native tools and skills. Gateway image API uses this session’s connection.")}</small>
              </label>}
              {formAdapter==="shell"&&<small>{t("Ordinary terminals use their existing CLI configuration. To use a session gateway, choose its Agent above.")}</small>}
              {!["shell","custom"].includes(formAdapter)&&<>
                <label><span>{t("Initial message (optional)")}</span><textarea aria-label={t("Initial message")} rows={3} value={formLaunch.prompt??""} onChange={event=>editLaunch({prompt:event.target.value||null})}/></label>
                <label><span>{t("CLI arguments")}</span><input aria-label={t("CLI arguments")} value={formLaunch.extra_args} onChange={event=>editLaunch({extra_args:event.target.value})}/></label>
              </>}
              {["shell","custom"].includes(formAdapter)&&<label><span>{t("Custom command (optional)")}</span><input aria-label={t("Custom command")} value={formLaunch.command??""} onChange={event=>editLaunch({command:event.target.value||null,adapter:event.target.value?"custom":"shell"})}/></label>}
              {launchTemplateCollection.templates.length>0&&<label><span>{t("Launch template")}</span><Select aria-label={t("Launch template")} value="" onChange={event=>{const template=launchTemplateCollection.templates.find(item=>item.id===event.target.value);if(template)applyLaunchTemplate(template);}}><option value="">{t("Apply a saved template…")}</option>{launchTemplateCollection.templates.map(template=><option key={template.id} value={template.id} disabled={template.mode!=="interactive"}>{template.name}{template.mode!=="interactive"?t(" (automation only)"):""}</option>)}</Select></label>}
              {isMainWindow&&<ProjectConfigPreview preview={projectPreview} busy={projectConfigBusy} error={projectConfigError} template={projectTemplate} onTemplate={setProjectTemplate} onPreview={()=>void readProjectConfig()} onTrust={()=>void approveProjectConfig()} onCancel={cancelProjectPreview}/>}
              {projectPreview?.config&&<label className="log-checkbox"><input type="checkbox" checked={useProjectSettings} onChange={event=>setUseProjectSettings(event.target.checked)}/>{t("Use trusted project settings")}</label>}
              {useProjectSettings&&projectDefaults?.mode==="task"&&<p role="status">{t("New session opens an interactive CLI. One-shot task mode remains available through automation and historical runs.")}</p>}
            </details>
            {error && (
              <p className="dialog-error" role="alert">
                {t(error)}
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
              {t("Cancel")}</button>
            <button
              className="primary-button"
              type="submit"
              disabled={starting || (formAdapter==="pi"&&!piFormValid) || adapters.length === 0 || projectConfigBusy || (useProjectSettings&&!projectPreview?.trusted)}
            >
              <Play aria-hidden="true" />
              {starting ? t("Starting...") : t("Start session")}
            </button>
          </footer>
        </form>
      </dialog>
      <dialog ref={launchSettingsDialog} className="app-dialog settings-surface" aria-labelledby="launch-settings-title">
        <header className="dialog-header"><h2 id="launch-settings-title">{t("Launch templates and defaults")}</h2></header>{settingsNavigation("launch-settings")(false)}
        <div className="dialog-fields">
          <p>{t("Current draft:")+" "}{formAdapter} {t("· interactive")}{formLaunch.provider?` · ${formLaunch.provider.model}`:t(" · existing CLI configuration")}{t(". Saving uses the current draft; applying a template opens New session.")}</p>
          <button type="button" onClick={()=>{launchSettingsDialog.current?.close();launchDialog.current?.showModal();}}>{t("Edit current launch draft")}</button>
          <LaunchTemplates templates={launchTemplateCollection.templates} selectedId={launchTemplateCollection.selectedId} name={launchTemplateName} writeError={launchTemplateCollection.writeError} loadError={launchTemplateCollection.loadError} rawStorage={launchTemplateCollection.rawStorage} actionError={launchTemplateActionError} starting={starting} onNameChange={setLaunchTemplateName} onSelect={selectLaunchTemplate} onSave={saveLaunchTemplate} onUpdate={updateLaunchTemplate} onDuplicate={duplicateLaunchTemplate} onDelete={deleteLaunchTemplate} onApply={applyLaunchTemplate} onReset={resetLaunchTemplates} onCopyOriginal={copyOriginalLaunchTemplates}/>
          <button type="button" className="secondary-button" disabled={starting} onClick={()=>void saveLaunchDefaults()}>{t("Save current fields as application defaults")}</button>
          {launchDefaultsNotice&&<p role="status">{t(launchDefaultsNotice)}</p>}
          {error&&<p role="alert">{t(error)}</p>}
        </div><footer className="dialog-actions"><button type="button" onClick={()=>launchSettingsDialog.current?.close()}>{t("Close")}</button></footer>
      </dialog>
      <dialog ref={projectRenameDialog} className="app-dialog" aria-labelledby="rename-project-title" onCancel={closeProjectRename} onClose={()=>{if(!projectRenameDialog.current?.open)closeProjectRename();}}>
        <form onSubmit={event=>{event.preventDefault();saveProjectRename(projectRename);}}>
          <header className="dialog-header"><h2 id="rename-project-title">{t("Edit project")}</h2></header>
          <div className="dialog-fields"><label><span>{t("Directory")}</span><input readOnly value={projectRename?.path??""}/></label><label><span>{t("Name")}</span><input autoFocus value={renameProjectName} onChange={event=>setRenameProjectName(event.target.value)}/></label><label><span>{t("Color")}</span><Select aria-label={t("Project color")} value={renameProjectColor} onChange={event=>setRenameProjectColor(event.target.value)}><option value="">{t("Default")}</option>{Object.keys(PROJECT_COLORS).map(color=><option key={color} value={color}>{t(color)}</option>)}</Select></label><label><span>{t("Icon")}</span><Select aria-label={t("Project icon")} value={renameProjectIcon} onChange={event=>setRenameProjectIcon(event.target.value)}><option value="">{t("Default")}</option><option value="folder">{t("Folder")}</option><option value="terminal">{t("Terminal")}</option><option value="play">{t("Play")}</option></Select></label><button type="button" className="secondary-button" onClick={()=>{setRenameProjectColor("");setRenameProjectIcon("");}}>{t("Reset appearance")}</button>{projectRenameError&&<p className="dialog-error" role="alert">{t(projectRenameError)}</p>}</div>
          <footer className="dialog-actions"><button type="button" className="secondary-button" onClick={closeProjectRename}>{t("Cancel")}</button><button type="submit" className="primary-button">{t("Save project name")}</button></footer>
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
            <h2 id="project-title">{t("Add project")}</h2>
          </header>
          <div className="dialog-fields">
            <label>
              <span>{t("Directory")}</span>
              <button className="secondary-button" type="button" onClick={() => void chooseDirectory("project")}>{t("Browse directory")}</button>
              <input
                required
                autoFocus
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder={t("/path/to/project")}
              />
            </label>
            <label>
              <span>{t("Name")}</span>
              <input
                value={newProjectName}
                onChange={(event) => setNewProjectName(event.target.value)}
                placeholder={
                  projectPath ? projectName(projectPath) : t("Project name")
                }
              />
            </label>
            {projectError && (
              <p className="dialog-error" role="alert">
                {t(projectError)}
              </p>
            )}
          </div>
          <footer className="dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => projectDialog.current?.close()}
            >
              {t("Cancel")}</button>
            <button className="primary-button" type="submit">
              <FolderPlus aria-hidden="true" />
              {t("Add project")}</button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

export default App;
