import {GitChanges} from "./GitChanges";
import UpdaterSettings from "./UpdaterSettings";
import {UpdaterController,loadUpdaterPreference,saveUpdaterPreference,updaterBusy,type UpdaterSnapshot} from "./updater";
import SystemEntrySettings from "./SystemEntrySettings";
import {SystemEntryController,type NotificationPauseState} from "./system-entry";
import {loadTerminalLayout,saveTerminalLayout} from "./terminal-layout-persistence";
import {TerminalLayout} from "./TerminalLayout";
import {createTerminalLayout,changeTerminalLayout,assignTerminalPane,removeTerminalPane,isTerminalProtocolResponse,clampSplitPercent,swapTerminalPanes,type TerminalLayoutMode} from "./terminal-layout";
import {GitContextPolling,gitContextLabel,type GitContext} from "./git-context";
import {historyRequest,capacityLevel,type HistoryItem,type HistoryCursor,type HistoryPage,type HistoryOverview,type InboxItem,type PendingKey,type HistoryCapacity} from "./history";
import { useEffect, useRef, useState } from "react";
import {memoryLabel, startMemoryPolling, type MemorySample} from "./memory";
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
  Bell,
  BellOff,
  LogOut,
} from "lucide-react";
import {
  groupProjects,
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
import {applyTerminalFrame,validateTerminalFrame,type TerminalFrame} from "./terminal-frame";
import {WorktreeControls} from "./WorktreeControls";
import {ProjectConfigPreview} from "./ProjectConfigPreview";
import {ProjectConfigSelection,resolveLaunchDefaults,isLaunchDefaults,type LaunchDefaults,type ProjectPreview} from "./project-config";
import {LaunchTemplateCollection,type LaunchTemplate} from "./launch-templates";
import {LaunchTemplates} from "./LaunchTemplates";
import {TerminalSettings as TerminalSettingsDialog,CommandPalette} from "./TerminalSettings";
import {loadTerminalSettings,saveTerminalSettings,terminalOptions,queueTerminalResize,type TerminalSettings} from "./terminal-settings";
import {paletteEntries,paletteShortcut,executePaletteEntry,isPinnedSessions,orderPinnedSessions,togglePinnedSession,canCloseSessionView,type PaletteEntry} from "./command-palette";
import {HistoryArchive} from "./HistoryArchive";
import { SessionLogSearch } from "./SessionLogSearch";
import { SessionLogExport } from "./SessionLogExport";
import {sessionRecovery,type SessionAvailability} from "./session-recovery";
import {AttentionCard} from "./AttentionCard";
import {captureAttention,isCurrentAttention} from "./attention-actions";
import {agentLabel,defaultShortcuts,isShortcuts,shortcutAction,isLaunchMode,type Shortcuts,type AgentState,type AgentReceipt} from "./agent-events";
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

type TerminalView = { availability?:SessionAvailability; record?:SessionRecord; attachVersion?:number; attaching?:boolean; instance: Terminal; fit: FitAddon; element: HTMLDivElement; cursor: number | null; ready: boolean; replayVersion:number; firstAttachment:boolean; parsing:Promise<void>|null; finishReplay:(()=>void)|null; live: boolean; status:string|null; notice: string | null; persisted:boolean; projection:boolean; frameRevision:number; frameInstance:string|null; dirty:boolean; updating:boolean; selecting:boolean; lifecycleRevision:number; projecting:boolean; viewportRevision:number; resizing:boolean;resizePending:{cols:number;rows:number}|null;disposed:boolean;writable:boolean; dispose(): void };

type AgentPhase = "idle" | "working" | "waiting";

const statusLabels: Record<string, string> = {
  starting: "Starting",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  needs_attention: "Needs attention",
};

function App() {
  function applyLaunchTemplate(template:LaunchTemplate){
    setSelectedAdapter(template.adapter);setLaunchMode(template.mode as "task"|"interactive");setAdapterArgs(template.extra_args);setPrompt(template.prompt??"");setCommand(template.command??"");
    setProjectLaunchEdits(previous=>({...previous,adapter:template.adapter,mode:template.mode as "task"|"interactive",extra_args:template.extra_args,prompt:template.prompt,command:template.command}));
  }
  const [updaterPreferenceLoad]=useState(()=>loadUpdaterPreference(()=>localStorage.getItem("yam.updater.v1")));
  const updaterController=useRef(new UpdaterController());
  const updaterMounted=useRef(false);
  const updaterIntent=useRef(0);
  const [updaterOpen,setUpdaterOpen]=useState(false);
  const [updaterSnapshot,setUpdaterSnapshot]=useState<UpdaterSnapshot|null>(null);
  const [updaterAutomatic,setUpdaterAutomatic]=useState(updaterPreferenceLoad.automatic);
  const updaterAutomaticRef=useRef(updaterAutomatic);updaterAutomaticRef.current=updaterAutomatic;
  const [updaterError,setUpdaterError]=useState<string|null>(updaterPreferenceLoad.error);
  const [updaterBusyAction,setUpdaterBusy]=useState(false);
  useEffect(()=>{
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
    if(!updaterOpen)return;
    let active=true;let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      let waitingForStatus=false;
      try {const next=await updaterController.current.refresh(invoke);waitingForStatus=next===null;if(active&&updaterMounted.current&&next)setUpdaterSnapshot(next);}
      catch {if(active&&updaterMounted.current)setUpdaterError("updater_unavailable");}
      // A closed predecessor can still own the single status RPC. Retry without overlap.
      if(active&&(waitingForStatus||(updaterController.current.snapshot&&updaterBusy(updaterController.current.snapshot.state))))timer=setTimeout(poll,500);
    }
    void poll();
    return ()=>{active=false;if(timer!==undefined)clearTimeout(timer);};
  },[updaterOpen,updaterSnapshot?.state]);
  async function runUpdaterAction(action:"check"|"download"|"cancel") {
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
  function closeUpdaterSettings(){updaterIntent.current++;updaterController.current.cancel();setUpdaterBusy(false);setUpdaterOpen(false);}
  // Live views stay warm; ended background-owned scenes release idle hidden renderers after selection.
  const terminalViews = useRef(new TerminalViews<TerminalView>(16));
  const [layoutPreferenceLoad]=useState(()=>{
    let present=false;
    const preference=loadTerminalLayout(()=>{const raw=localStorage.getItem("yam.terminalLayout");present=raw!==null;return raw;});
    return {...preference,present};
  });
  const layoutRestore=useRef({version:0,pending:true,ids:[] as string[],adoptable:false,queued:false});
  const [layoutRestoreReady,setLayoutRestoreReady]=useState(false);
  const [splitPercent,setSplitPercent]=useState(()=>layoutPreferenceLoad.splitPercent);
  const splitPercentRef=useRef(splitPercent);splitPercentRef.current=splitPercent;
  const terminalLayoutFitFrame=useRef<number|null>(null);
  const terminalLayoutFitIntent=useRef(0);
  const [terminalLayout,setTerminalLayout]=useState(createTerminalLayout);
  const terminalLayoutRef=useRef(terminalLayout);
  const paneHosts=useRef(new Map<number,HTMLDivElement>());
  const terminalMounted=useRef(false);
  const ownerConnectionAvailable=useRef({available:true,version:0});
  const notificationContextVersion=useRef(0);
  const notificationContextFlight=useRef<{
    sending:boolean;
    pending:{selected:string|null;paused:boolean;version:number}|null;
  }>({sending:false,pending:null});
  const [terminalPreferenceLoad]=useState(()=>loadTerminalSettings(()=>localStorage.getItem("yam.terminalSettings")));
  const [terminalSettings,setTerminalSettings]=useState<TerminalSettings>(terminalPreferenceLoad.settings);
  const terminalSettingsRef=useRef(terminalSettings);terminalSettingsRef.current=terminalSettings;
  const [terminalSettingsError,setTerminalSettingsError]=useState<string|null>(terminalPreferenceLoad.error);
  const [terminalSettingsOpen,setTerminalSettingsOpen]=useState(false);
  const terminalSettingsVersion=useRef(0);
  const [paletteOpen,setPaletteOpen]=useState(false);
  const [paletteQuery,setPaletteQuery]=useState("");
  const paletteVersion=useRef(0);
  const [pinnedSessions,setPinnedSessions]=useState<string[]>(()=>readPreference("yam.pinnedSessions",[],isPinnedSessions));
  const pinnedSessionsRef=useRef(pinnedSessions);pinnedSessionsRef.current=pinnedSessions;
  const createView = useRef<((id: string) => TerminalView) | null>(null);
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
  const [error, setError] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [prompt, setPrompt] = useState("");
  const [adapterArgs, setAdapterArgs] = useState("");
  const [launchMode, setLaunchMode] = useState<"task" | "interactive">(()=>readPreference("yam.launchMode","task",isLaunchMode));
  const [adapters, setAdapters] = useState<AgentAdapter[]>([]);
  const [selectedAdapter, setSelectedAdapter] = useState("shell");
  const [globalLaunchDefaults,setGlobalLaunchDefaults]=useState<LaunchDefaults>({adapter:"shell",mode:launchMode,extra_args:"",prompt:null,command:null});
  const projectSelection=useRef(new ProjectConfigSelection());
  const projectConfigVersion=useRef(0);
  const [projectPreview,setProjectPreview]=useState<ProjectPreview|null>(null);
  const [projectLaunchEdits,setProjectLaunchEdits]=useState<Partial<LaunchDefaults>>({});
  const [projectTemplate,setProjectTemplate]=useState("");
  const [useProjectSettings,setUseProjectSettings]=useState(false);
  const [projectConfigBusy,setProjectConfigBusy]=useState(false);
  const [projectConfigError,setProjectConfigError]=useState<string|null>(null);
  useEffect(()=>{let active=true;void invoke<Partial<LaunchDefaults>>("get_launch_defaults").then(value=>{const next={adapter:"shell",mode:launchMode,extra_args:"",prompt:null,command:null,...value};if(!isLaunchDefaults(next))throw Error("Invalid application launch defaults");if(active)setGlobalLaunchDefaults(next);}).catch(reason=>{if(active)setProjectConfigError(`Launch defaults unavailable: ${String(reason)}`);});return()=>{active=false;projectConfigVersion.current++;projectSelection.current.cancel();};},[]);
  useEffect(()=>{projectConfigVersion.current++;projectSelection.current.cancel();setProjectPreview(null);setUseProjectSettings(false);setProjectTemplate("");setProjectConfigBusy(false);},[cwd]);
  const projectDefaults=projectPreview?.config?{...projectPreview.config.defaults,...projectPreview.config.templates?.find(item=>item.name===projectTemplate)}:null;
  const formLaunch=useProjectSettings&&projectPreview?.trusted?resolveLaunchDefaults(globalLaunchDefaults,projectDefaults,projectLaunchEdits):{adapter:selectedAdapter,mode:launchMode,extra_args:adapterArgs,prompt:prompt||null,command:command||null};
  const formAdapter=formLaunch.adapter==="custom"?"shell":formLaunch.adapter;
  const [launchTemplateCollection]=useState(()=>{const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value)};const collection=new LaunchTemplateCollection(storage);collection.load();return collection;});
  const [,setLaunchTemplateRevision]=useState(0);
  const [launchTemplateName,setLaunchTemplateName]=useState("");
  const [launchTemplateActionError,setLaunchTemplateActionError]=useState<string|null>(null);
  function refreshLaunchTemplateUi(){setLaunchTemplateRevision(revision=>revision+1);}
  function handleLaunchTemplateError(reason:unknown){setLaunchTemplateActionError(launchTemplateCollection.writeError?null:String(reason));refreshLaunchTemplateUi();}
  function selectLaunchTemplate(id:string){launchTemplateCollection.select(id);refreshLaunchTemplateUi();}
  function saveLaunchTemplate(){try{launchTemplateCollection.save(launchTemplateName,formLaunch);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function updateLaunchTemplate(){const id=launchTemplateCollection.selectedId;if(!id)return;try{launchTemplateCollection.update(id,launchTemplateName,formLaunch);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function duplicateLaunchTemplate(){const id=launchTemplateCollection.selectedId;if(!id)return;try{const copy=launchTemplateCollection.duplicate(id);setLaunchTemplateName(copy.name);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
  function deleteLaunchTemplate(){const id=launchTemplateCollection.selectedId;if(!id)return;try{launchTemplateCollection.delete(id);setLaunchTemplateActionError(null);refreshLaunchTemplateUi();}catch(reason){handleLaunchTemplateError(reason);}}
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
  async function saveLaunchDefaults(){try{const defaults={adapter:command?"custom":selectedAdapter,mode:launchMode,extra_args:adapterArgs,prompt:prompt||null,command:command||null};await invoke("set_launch_defaults",{defaults});setGlobalLaunchDefaults(defaults);}catch(reason){setProjectConfigError(String(reason));}}

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
  const [shortcuts,setShortcuts]=useState<Shortcuts>(()=>readPreference("yam.shortcuts",defaultShortcuts,isShortcuts));
  const [notificationsPaused,setNotificationsPaused]=useState(()=>readPreference("yam.notificationsPaused",false,(value):value is boolean=>typeof value==="boolean"));
  const pausedRef=useRef(notificationsPaused);pausedRef.current=notificationsPaused;
  const notificationPause=useRef(new SystemEntryController());
  const notificationPauseState=useRef<NotificationPauseState|null>(null);
  const notificationPauseVersion=useRef(0);
  const systemEntryVersion=useRef(0);
  const systemEntryMutation=useRef(0);
  const [systemEntryOpen,setSystemEntryOpen]=useState(false);
  const [systemEntryBusy,setSystemEntryBusy]=useState(false);
  const [systemEntry,setSystemEntry]=useState({global_shortcut_enabled:false,global_shortcut_registered:false,shortcut_available:false,tray_available:false,warning:"",owner_instance:""});

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

  const historyContext=useRef({query:historyQuery,status:statusFilter,titles:sessionTitles,projects});
  historyContext.current={query:historyQuery,status:statusFilter,titles:sessionTitles,projects};
  const titlesRef = useRef(sessionTitles);
  titlesRef.current = sessionTitles;

  const [memory, setMemory] = useState<MemorySample | null>(null);
  useEffect(() => startMemoryPolling(
    () => invoke<MemorySample>("memory_usage"), setMemory,
    () => document.visibilityState !== "hidden",
  ), []);

  useEffect(()=>{
    try {localStorage.setItem("yam.launchMode",JSON.stringify(launchMode));localStorage.setItem("yam.shortcuts",JSON.stringify(shortcuts));}
    catch(reason){setError(`Failed to save session preferences: ${String(reason)}`);}
  },[launchMode,shortcuts]);

  useEffect(()=>{
    if(!layoutRestoreReady)return;
    const warning=saveTerminalLayout(terminalLayout,value=>localStorage.setItem("yam.terminalLayout",value),splitPercent);
    if(warning)setError(warning);
  },[terminalLayout,splitPercent,layoutRestoreReady]);

  useEffect(()=>{
    if(session?.session_id) {try{localStorage.setItem("yam.lastSession",JSON.stringify(session.session_id));}catch(reason){setError(`Failed to save last session: ${String(reason)}`);}}
  },[session?.session_id]);

  useEffect(()=>{ syncNotificationContext(); },[session?.session_id,notificationsPaused]);

  useEffect(() => {
    try {
      localStorage.setItem("yam.projects", JSON.stringify(projects));
      localStorage.setItem("yam.sidebar", JSON.stringify(sidebarOpen));
      localStorage.setItem("yam.sessionTitles", JSON.stringify(sessionTitles));
    } catch (reason) {
      setError(`Failed to save project or session preferences: ${String(reason)}`);
    }
  }, [projects, sidebarOpen, sessionTitles]);

  async function refreshHistory(valid?:()=>boolean) {
    const version=++historyRefreshVersion.current;
    // Scoped receipt refresh takes over pending responses without owning a loading indicator.
    setHistoryLoading(!valid);
    try {
      const context=historyContext.current;
      const request=historyRequest(context.query,context.status,context.titles,context.projects);
      const [page,overview]=await Promise.all([invoke<HistoryPage<HistoryItem>>("list_session_summaries",{request}),invoke<HistoryOverview>("history_overview")]);
      if(version!==historyRefreshVersion.current||(valid&&!valid()))return;
      setHistory(page.items);setHistoryCursor(page.next_cursor);setHistoryOverview(overview);
      if(overview.latest_deletion?.deleted_ids.length){
        const receipt=overview.latest_deletion;
        const key=JSON.stringify([receipt.preview_id,receipt.deleted_ids]);
        if(key!==deletionReceiptKey.current){clearDeletedSessionNames(receipt.deleted_ids,false);deletionReceiptKey.current=key;}
      }
      if(valid)await refreshInbox(false,valid);else {void refreshInbox();void refreshPendingNotifications();}
      if(version!==historyRefreshVersion.current||(valid&&!valid()))return;
      const id=selectedRecord.current?.summary.session_id;
      if(id){const record=await invoke<SessionRecord>("get_session",{sessionId:id});if(version===historyRefreshVersion.current && (!valid||valid()) && selectedRecord.current?.summary.session_id===id){selectedRecord.current=record;setSelectedAgent(record.agent);}}
    } catch (reason: unknown) {
      if(version===historyRefreshVersion.current&&(!valid||valid()))setError(reason instanceof Error?reason.message:String(reason));
    } finally {if(!valid&&version===historyRefreshVersion.current)setHistoryLoading(false);}
  }
  async function loadMoreHistory(){
    if(!historyCursor||historyLoading)return;
    const version=++historyRefreshVersion.current;setHistoryLoading(true);
    try {const page=await invoke<HistoryPage<HistoryItem>>("list_session_summaries",{request:historyRequest(historyContext.current.query,historyContext.current.status,historyContext.current.titles,historyContext.current.projects,historyCursor)});
      if(version!==historyRefreshVersion.current)return;
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
    if(pendingLoading.current)return;pendingLoading.current=true;
    try{let afterKey:PendingKey|null=null;
      do{const page:{items:SessionStateEvent[];next_key:PendingKey|null}=await invoke<{items:SessionStateEvent[];next_key:PendingKey|null}>("list_pending_notifications",{limit:100,afterKey});
        for(const event of page.items)await notifySession(event);afterKey=page.next_key;
      }while(afterKey);
    }catch(reason){setNotificationError(String(reason));}finally{pendingLoading.current=false;}
  }
  async function openSession(id:string,onAttached?:(view:TerminalView,detail:number,intent:number)=>void,valid=()=>true){
    cancelLayoutRestore();
    const version=++detailVersion.current,intent=layoutRestore.current.version;
    const current=()=>valid()&&version===detailVersion.current&&intent===layoutRestore.current.version;
    try {
      const record=await invoke<SessionRecord>("get_session",{sessionId:id});
      if(!current())return false;
      const loading=openHistory(record,false,undefined,undefined,onAttached?valid:undefined);
      const detail=detailVersion.current,attachmentIntent=layoutRestore.current.version;
      const view=terminalViews.current.get(id),attachment=view?.attachVersion;
      await loading;
      if(!valid()||detail!==detailVersion.current||attachmentIntent!==layoutRestore.current.version||sessionId.current!==id||!view||terminalViews.current.get(id)!==view||view.attachVersion!==attachment||view.disposed)return false;
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
      const saved=await invoke<boolean>("export_diagnostics");
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
    if (!terminalStatuses.has(event.status) && event.status !== "idle_attention") return;
    if (terminalStatuses.has(event.status)) {
      for (const oldKey of discardAttentionRetries(retryNotifications.current, event.session_id))
        notifications.current.clearFailure(oldKey);
    }
    const key = `${event.session_id}:${event.status}`;
    if(pausedRef.current){retryNotifications.current.set(key,event);return;}
    if (!notifications.current.canRetry(key)) return;
    if (terminalHasInputFocus(event.session_id)) {
      notifications.current.suppress(key);
      try { await invoke("acknowledge_notification", {sessionId: event.session_id, expectedStatus: event.status}); retryNotifications.current.delete(key); notifications.current.clearFailure(key); if (!retryNotifications.current.size) setNotificationError(null); }
      catch (reason) { retryNotifications.current.set(key, event); setNotificationError(notifications.current.recordFailure(key, reason)); }
      return;
    }
    retryNotifications.current.set(key, event);
    try {
      const record = await invoke<SessionRecord>("get_session",{sessionId:event.session_id});
      if (pausedRef.current || !notifications.current.canRetry(key)) return;
      const superseded = event.status === "idle_attention" && record && terminalStatuses.has(record.status);
      const delivered = superseded || await notifications.current.deliver(key, async () => {
        const taskName = titlesRef.current[event.session_id] || record?.summary.launch?.adapter || "Session";
        const title = `${projectName(record?.summary.cwd ?? "")} · ${taskName} · ${statusLabels[event.status] ?? "Needs attention"}`.slice(0, 200);
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
        if (next.some((adapter) => adapter.id === "shell"))
          setSelectedAdapter("shell");
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
    createView.current = (id) => {
      const element = document.createElement("div");
      element.className = "terminal-view";
      terminalHost.current!.append(element);
      const instance = new Terminal({
      convertEol: true,
      cursorBlink: true,
      lineHeight:1.35,
      ...terminalOptions(terminalSettingsRef.current),
    });
      const fit = new FitAddon();
      try { instance.loadAddon(fit); instance.open(element); }
      catch (reason) { instance.dispose(); element.remove(); throw reason; }
      const view: TerminalView = {
        instance, fit, element, cursor: null, ready:false, replayVersion:0, firstAttachment:false, parsing:null, finishReplay:null, live:false, status:null, notice:null,persisted:false, projection:false, frameRevision:-1, frameInstance:null,dirty:true,updating:false,selecting:false,lifecycleRevision:0,projecting:false,viewportRevision:0,resizing:false,resizePending:null,disposed:false,writable:false,
        dispose() { view.disposed=true;view.resizePending=null;if(view.attaching){view.attaching=false;if(terminalMounted.current)setRecoveryRevision(revision=>revision+1);}view.finishReplay?.(); onData.dispose(); onScroll.dispose(); instance.dispose(); element.remove(); },
      };
      const onData = instance.onData(data => {
        const protocol=isTerminalProtocolResponse(data);
        const connected=ownerConnectionAvailable.current.available&&view.availability!=="owner_unavailable";
        if (!view.disposed && connected && !(view.projection&&protocol) && view.live && (view.projection || (view.cursor !== null && (view.ready || view.firstAttachment)))
          && (terminalHasInputFocus(id) || (!view.projection && protocol))){
          const owner=view.frameInstance,attachment=view.attachVersion,connectionVersion=ownerConnectionAvailable.current.version;
          const valid=()=>!view.disposed&&ownerConnectionAvailable.current.version===connectionVersion&&view.frameInstance===owner&&view.attachVersion===attachment;
          void invoke("write_session",{sessionId:id,data}).then(()=>{
            if(valid()){view.writable=true;syncViewSize(view);}
          }).catch(reason=>{
            if(valid()){view.writable=false;if(terminalHasInputFocus(id))setError(String(reason));}
          });
        }
      });
      const onScroll=instance.onScroll(line=>{
        if(view.projection && view.live && !view.projecting){
          view.viewportRevision++;
          void invoke("set_terminal_viewport",{sessionId:id,line}).then(()=>{view.dirty=true;}).catch(reason=>setError(String(reason)));
        }
      });
      element.addEventListener("pointerdown",()=>{view.selecting=view.instance.modes.mouseTrackingMode === "none";});
      const finishSelection=()=>{view.selecting=false;};
      window.addEventListener("pointerup",finishSelection);
      const originalDispose=view.dispose;view.dispose=()=>{window.removeEventListener("pointerup",finishSelection);originalDispose();};
      element.style.visibility = "hidden";
      element.inert = true;
      return view;
    };
    const resize = () => fitTerminalViews();
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(resize);
    observer.observe(terminalHost.current);

    const frameTimer=window.setInterval(()=>pollTerminalFrames(),100);
    const focusChanged=()=>syncNotificationContext();
    document.addEventListener("focusin",focusChanged);
    document.addEventListener("focusout",focusChanged);
    window.addEventListener("focus",focusChanged);
    window.addEventListener("blur",focusChanged);
    const extraListeners: UnlistenFn[] = [];
    const retryTimer = window.setInterval(() => {
      for (const event of retryNotifications.current.values()) void notifySession(event);
    }, 15000);
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
    async function selectNotificationSession(id: string) {
      cancelLayoutRestore(true,false);
      let intent=layoutRestore.current.version;
      let version=++detailVersion.current;
      try {
        const record = await invoke<SessionRecord>("get_session",{sessionId:id});
        if (!active||intent!==layoutRestore.current.version) return;
        const pending = await invoke<string | null>("pending_notification_selection");
        if (!active || pending !== id || version!==detailVersion.current || intent!==layoutRestore.current.version) return;
        if (!record) throw new Error("Notification refers to an unknown session");
        launchDialog.current?.close();
        projectDialog.current?.close();
        renameDialog.current?.close();
        const attachment=openHistory(record);
        intent=layoutRestore.current.version;version=detailVersion.current;
        await attachment;
        if (active && intent===layoutRestore.current.version && version===detailVersion.current && sessionId.current === id && outputCursor.current !== null) {
          await invoke("acknowledge_notification_selection", { sessionId: id });
        }
      } catch (reason) { if (active&&intent===layoutRestore.current.version&&version===detailVersion.current) setError(String(reason)); }
    }
    void listen<string>("session-notification-click", event => { void selectNotificationSession(event.payload); })
      .then(async unlisten => {
        if (!active) { unlisten(); return; }
        extraListeners.push(unlisten);
        const pending = await invoke<string | null>("pending_notification_selection");
        if(!startupPending||!startupValid())return;
        if(pending){await selectNotificationSession(pending);return;}
        try{
          const preference=layoutPreferenceLoad;
          if(preference.warning){setError(preference.warning);finishLayoutRestore(startupVersion);return;}
          let layout=preference.layout;
          if(!preference.present){
            const last=readPreference<string|null>("yam.lastSession",null,(value):value is string|null=>typeof value==="string" && /^s-[a-f0-9]+-[a-f0-9]+$/.test(value));
            if(last)layout={...createTerminalLayout(),panes:[last]};
          }
          layoutRestore.current.ids=layout.panes.filter((id):id is string=>id!==null);
          const records=new Map<string,SessionRecord>();
          for(const id of layout.panes){
            if(!id)continue;
            const record=await invoke<SessionRecord|null>("get_session",{sessionId:id});
            if(!startupValid())return;
            if(!record||record.summary.session_id!==id)throw Error("invalid_saved_session");
            records.set(id,record);
          }
          if(!startupValid())return;
          terminalLayoutRef.current={...layout,panes:[...layout.panes]};setTerminalLayout(terminalLayoutRef.current);
          showTerminalLayout();
          layoutRestore.current.adoptable=true;
          const attachments:Promise<void>[]=[];
          for(let pane=0;pane<layout.panes.length;pane++){
            const id=layout.panes[pane];if(id)attachments.push(openHistory(records.get(id)!,false,pane,startupVersion));
          }
          await Promise.all(attachments);
          if(!startupValid())return;
          focusTerminalPane(layout.focused,false,true);
          finishLayoutRestore(startupVersion);
        }catch{
          if(!startupValid())return;
          terminalLayoutRef.current=createTerminalLayout();setTerminalLayout(terminalLayoutRef.current);
          showTerminalLayout();focusTerminalPane(0,false,true);
          setError("Saved terminal layout is unavailable. Using a single pane.");
          finishLayoutRestore(startupVersion);
        }
      }).catch(()=>{
        if(startupValid()){
          setError("Terminal layout preferences unavailable. Using a single pane.");
          finishLayoutRestore(startupVersion);
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
      if (view) { view.live = live; view.status = event.payload.status; view.dirty=true; view.lifecycleRevision++; }
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
      active = false;terminalMounted.current=false;
      layoutRestore.current.adoptable=false;layoutRestore.current.version++;
      document.removeEventListener("focusin",focusChanged);document.removeEventListener("focusout",focusChanged);
      window.removeEventListener("focus",focusChanged);window.removeEventListener("blur",focusChanged);
      window.clearInterval(retryTimer);
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
    await startSession(undefined, record.attempt);
  }
  async function startSession(overrides?: { cwd?: string; command?: string; launch?: AgentLaunch | null; resumeFrom?: string }, worktreeAttempt?: string) {
    cancelLayoutRestore(false,false);
    if (starting || creatingSession.current) return;
    if (!terminalViews.current.canOpen) { setError("Terminal limit reached. Hide an ended pane before starting another session."); return; }
    const projectStart=!overrides&&useProjectSettings;
    if(projectStart&&(!projectPreview?.trusted||projectConfigBusy)){setError("Preview and trust this exact project configuration before starting.");return;}
    const adapter = adapters.find((item) => item.id === selectedAdapter);
    const customCommand = (overrides?.command ?? command).trim();
    const workingDirectory = (overrides?.cwd ?? cwd).trim();
    const launchPrompt =
      !overrides && selectedAdapter !== "shell" ? prompt.trim() : "";
    const launchArgs =
      !overrides && selectedAdapter !== "shell" ? adapterArgs.trim() : "";
    if (!projectStart && !overrides && !customCommand && adapter && !adapter.available) {
      setError(`${adapter.label} was not found on PATH`);
      return;
    }
    if(!terminalViews.current.reserveAdmission()){setError("Terminal limit reached. Hide an ended pane before starting another session.");return;}
    creatingSession.current = true;
    setStarting(true);
    setError(null);
    try {
      const argumentsForStart = overrides?.resumeFrom ? {resumeFrom:overrides.resumeFrom,cwd:null,command:null,launch:null} : projectStart ? {cwd:null,command:null,launch:null,projectConfig:{root:projectPreview!.root,template:projectTemplate||null,overrides:projectLaunchEdits}} : {
        cwd: workingDirectory || null,
        command: customCommand || null,
        launch: overrides ? overrides.launch ?? null :
          !customCommand && selectedAdapter !== "shell" ? {
            adapter:selectedAdapter, mode:launchMode, extra_args:launchArgs, prompt:launchPrompt || null,
          } : null,
      };
      const next = await invoke<SessionSummary>("create_session", worktreeAttempt ? {...argumentsForStart,worktreeAttempt} : argumentsForStart);
      setActiveProject(next.cwd);
      setCollapsedProjects((previous) => {
        const copy = new Set(previous);
        copy.delete(projectKey(next.cwd));
        return copy;
      });
      setSessionTitles((previous) => ({
        ...previous,
        [next.session_id]:
          overrides?.resumeFrom ? `Continue ${next.launch?.adapter ?? "conversation"}` : next.launch?.prompt?.trim() ||
            next.command || adapters.find((item) => item.id === next.launch?.adapter)?.label ||
            (!overrides && !projectStart ? adapter?.label : null) || "Interactive shell",
      }));
      launchDialog.current?.close();
      await openHistory({summary:next, status:next.status, exit_code:null, reason:null, started_at:Date.now()/1000, ended_at:null},true);
      void refreshHistory();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
      terminal.current?.writeln(`\r\n[Failed to start] ${String(reason)}`);
    } finally {
      terminalViews.current.releaseAdmission();
      creatingSession.current = false;
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

  function finishLayoutRestore(version:number){
    if(!terminalMounted.current||layoutRestore.current.version!==version)return;
    layoutRestore.current.pending=false;layoutRestore.current.adoptable=false;
    setLayoutRestoreReady(true);
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
        const attachments:Promise<void>[]=[];
        for(let pane=0;pane<layout.panes.length;pane++){
          const id=layout.panes[pane],view=id?terminalViews.current.get(id):undefined;
          if(id&&restore.ids.includes(id)&&view?.record&&!view.ready)
            attachments.push(openHistory(view.record,false,pane,version));
        }
        void Promise.all(attachments).then(()=>{
          if(restore.version===version)restore.adoptable=false;
        });
      });
    }
    setLayoutRestoreReady(true);
  }
  function terminalPaneVisible(id:string){return terminalLayoutRef.current.panes.includes(id);}
  function terminalPaneHasSize(view:TerminalView){
    const rect=view.element.getBoundingClientRect();return rect.width>0&&rect.height>0;
  }
  function terminalHasInputFocus(id:string){
    const layout=terminalLayoutRef.current,view=terminalViews.current.get(id);
    return document.hasFocus()&&layout.panes[layout.focused]===id&&sessionId.current===id
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
    const layout=terminalLayoutRef.current;terminalViews.current.setProtected(layout.panes);
    for(const view of terminalViews.current.all){
      const index=layout.panes.indexOf(view.element.dataset.sessionId!);
      const visible=index>=0,host=visible?paneHosts.current.get(index):terminalHost.current;
      if(host&&view.element.parentElement!==host)host.append(view.element);
      if(!visible){
        view.resizePending=null;
        if(view.element.style.visibility==="visible"){
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
    if(layout.focused!==index){terminalLayoutRef.current={...layout,focused:index};setTerminalLayout(terminalLayoutRef.current);}
    const id=layout.panes[index],view=id?terminalViews.current.get(id):undefined;
    if(sessionId.current!==id)selectionVersion.current++;
    if(sessionId.current&&id&&sessionId.current!==id)previousSession.current=sessionId.current;
    sessionId.current=id;terminal.current=view?.instance??null;fitAddon.current=view?.fit??null;outputCursor.current=view?.cursor??null;
    selectedRecord.current=view?.record?{...view.record,status:view.status??view.record.status}:null;
    setSession(view?.record?.summary??null);setSelectedAgent(view?.record?.agent);setSessionStatus(view?.status??"idle");setTerminalNotice(view?.notice??null);
    if(view?.record)setActiveProject(view.record.summary.cwd);
    if(focusInput&&view?.ready&&!view.disposed)view.instance.focus();
    syncNotificationContext();
  }
  function mountTerminalPane(index:number,host:HTMLDivElement|null){
    if(host)paneHosts.current.set(index,host);else paneHosts.current.delete(index);
    showTerminalLayout();if(host)requestTerminalLayoutFit();
  }
  function changeLayoutMode(mode:TerminalLayoutMode){
    cancelLayoutRestore();
    cancelTerminalLayoutFit();
    terminalLayoutRef.current=changeTerminalLayout(terminalLayoutRef.current,mode);setTerminalLayout(terminalLayoutRef.current);
    showTerminalLayout();focusTerminalPane(terminalLayoutRef.current.focused,false);requestTerminalLayoutFit();
  }
  function closeTerminalPane(index:number){
    cancelLayoutRestore();
    cancelTerminalLayoutFit();
    terminalLayoutRef.current=removeTerminalPane(terminalLayoutRef.current,index);setTerminalLayout(terminalLayoutRef.current);
    detailVersion.current++;showTerminalLayout();focusTerminalPane(terminalLayoutRef.current.focused,false);requestTerminalLayoutFit();
  }
  function requestTerminalLayoutFit(){
    if(terminalLayoutFitFrame.current!==null)return;
    const mode=terminalLayoutRef.current.mode,revision=terminalLayoutRef.current.revision,intent=terminalLayoutFitIntent.current;
    let frame=0;
    frame=requestAnimationFrame(()=>{
      if(terminalLayoutFitFrame.current!==frame)return;
      terminalLayoutFitFrame.current=null;
      const current=terminalLayoutRef.current;
      if(intent!==terminalLayoutFitIntent.current||!terminalMounted.current||current.mode!==mode||current.revision!==revision)return;
      fitTerminalViews();
    });
    terminalLayoutFitFrame.current=frame;
  }
  function cancelTerminalLayoutFit(){
    terminalLayoutFitIntent.current++;
    const frame=terminalLayoutFitFrame.current;
    if(frame!==null){cancelAnimationFrame(frame);terminalLayoutFitFrame.current=null;}
  }
  function commitTerminalSplit(value:number){
    const next=clampSplitPercent(value);
    if(next!==splitPercentRef.current){splitPercentRef.current=next;setSplitPercent(next);}
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
  function pollTerminalFrames(){
    if(!terminalMounted.current||document.hidden)return;
    const panes=terminalLayoutRef.current.panes;
    for(let slot=0;slot<panes.length;slot++){
      const id=panes[slot],view=id?terminalViews.current.get(id):undefined;
      if(!id||!view?.projection||!view.dirty||view.updating||view.selecting||view.instance.hasSelection()||view.disposed)continue;
      view.updating=true;view.dirty=false;
      const lifecycle=view.lifecycleRevision,viewport=view.viewportRevision,owner=view.frameInstance,attachment=view.attachVersion;
      const valid=()=>terminalMounted.current&&!view.disposed&&terminalViews.current.get(id)===view&&terminalLayoutRef.current.panes[slot]===id
        &&view.attachVersion===attachment&&view.frameInstance===owner&&view.viewportRevision===viewport;
      void invoke<TerminalFrame|null>("read_terminal_frame",{sessionId:id}).then(async frame=>{
        if(!valid()){if(!view.disposed)view.dirty=true;return;}
        if(frame)await renderFrame(view,id,frame,lifecycle,valid);
      }).catch(reason=>{
         if(valid()) {
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

  function createTerminalView(id: string): TerminalView {
    if (!createView.current) throw new Error("Terminal is not ready");
    const view = createView.current(id);
    view.element.dataset.sessionId = id;
    view.availability=ownerConnectionAvailable.current.available?"available":"owner_unavailable";
    return view;
  }

  async function renderFrame(view:TerminalView,id:string,frame:TerminalFrame,lifecycleRevision:number,valid=()=>!view.disposed) {
    const attachment=view.attachVersion,connectionVersion=ownerConnectionAvailable.current.version;
    const current=()=>valid()&&terminalMounted.current&&view.attachVersion===attachment&&ownerConnectionAvailable.current.version===connectionVersion;
    if(!current())return;
    validateTerminalFrame(frame,id);
    if(view.frameInstance && view.live && frame.projection.instance!==view.frameInstance) throw Error("The terminal owner changed; the previous live state is unavailable.");
    while(view.parsing) await view.parsing;
    if(!current())return;
    if(view.frameInstance===frame.projection.instance && frame.projection.revision<view.frameRevision) return;
    if(view.frameInstance!==frame.projection.instance)view.writable=false;
    view.projection=true;
    if(frame.projection.revision!==view.frameRevision || view.frameInstance!==frame.projection.instance || !view.ready) {
      view.projecting=true;
      const parsing=view.parsing=applyTerminalFrame(view.instance,frame,id);
      try{await parsing;}finally{view.projecting=false;if(view.parsing===parsing)view.parsing=null;}
      if(!current())return;
      view.frameRevision=frame.projection.revision;view.frameInstance=frame.projection.instance;
    }
    if(view.availability!=="available") {view.availability="available";setRecoveryRevision(revision=>revision+1);}
    ownerConnectionAvailable.current.available=true;
    view.persisted=frame.persisted===true && terminalStatuses.has(frame.status);
    view.cursor=frame.end_offset;view.ready=true;view.firstAttachment=false;
    if(view.lifecycleRevision===lifecycleRevision){view.status=frame.status;view.live=["starting","running"].includes(frame.status);}
    view.element.inert=!terminalPaneVisible(id)||!view.ready;
    view.notice=view.live?null:"Saved terminal scene. The process has ended; input is disabled.";
    terminalViews.current.setRunning(id,view.live);
    if(sessionId.current===id){outputCursor.current=view.cursor;setSessionStatus(view.status??frame.status);setTerminalNotice(view.notice);}
  }
  async function openHistory(record: SessionRecord, firstAttachment=false, pane?:number, restoreVersion?:number, scopeValid?:()=>boolean) {
    if(scopeValid&&!scopeValid())return;
    if(restoreVersion===undefined)cancelLayoutRestore();
    const connectionVersion=ownerConnectionAvailable.current.version;
    const restoreValid=()=>restoreVersion===undefined||(terminalMounted.current&&layoutRestore.current.version===restoreVersion);
    if(!restoreValid())return;
    if(restoreVersion===undefined)detailVersion.current++;
    const focusOrigin = document.activeElement;
    const id = record.summary.session_id;
    let scopeDetail:number|undefined,scopeIntent:number|undefined;
    // Focus/setup changes intent synchronously; freeze it before the first read awaits.
    const scopeCurrent=()=>!scopeValid||(scopeValid()&&(scopeDetail===undefined
      ||(detailVersion.current===scopeDetail&&layoutRestore.current.version===scopeIntent&&sessionId.current===id)));
    const existing = terminalViews.current.get(id);
    if (creatingSession.current && !existing && !firstAttachment) {
      setError("A session is starting. Select an already open terminal or wait for startup to finish.");
      return;
    }
    const status = existing?.status ?? record.status;
    const currentLayout=terminalLayoutRef.current;
    const nextLayout=assignTerminalPane(currentLayout,pane??currentLayout.focused,id);
    if(restoreVersion!==undefined)nextLayout.focused=currentLayout.focused;
    const slot=nextLayout.panes.indexOf(id);
    let view: TerminalView;
    try {
      terminalViews.current.setProtected(nextLayout.panes);
      view = terminalViews.current.open(id, existing?.live ?? ["starting", "running"].includes(status), () => createTerminalView(id));
    } catch (reason) {terminalViews.current.setProtected(currentLayout.panes);setError(String(reason));return;}
    terminalLayoutRef.current=nextLayout;setTerminalLayout(nextLayout);
    const version=view.attachVersion=(view.attachVersion??0)+1;
    if(!view.attaching){view.attaching=true;setRecoveryRevision(revision=>revision+1);}
    const attached=()=>scopeCurrent()&&terminalMounted.current&&ownerConnectionAvailable.current.version===connectionVersion&&restoreValid()&&!view.disposed&&terminalViews.current.get(id)===view&&terminalLayoutRef.current.panes[slot]===id&&view.attachVersion===version;
    const focused=()=>attached()&&terminalLayoutRef.current.focused===slot;
    view.record={...record,status};view.status=status;view.live=["starting","running"].includes(status);
    showTerminalLayout();
    if(focused())focusTerminalPane(slot,false,restoreVersion!==undefined);
    scopeDetail=detailVersion.current;scopeIntent=layoutRestore.current.version;
    try {
      view.lifecycleRevision??=0;
      const lifecycleRevision=view.lifecycleRevision;
      const frame=await invoke<TerminalFrame|null>("read_terminal_frame",{sessionId:id});
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
        const snapshot = await invoke<LogSnapshot>("read_session_snapshot", { sessionId: id });
        if (!attached()) return;
        if (snapshot.status && !pendingState.current.has(id)) {
          view.live = ["starting", "running"].includes(snapshot.status);
          view.status = snapshot.status;
          terminalViews.current.setRunning(id, view.live);
          view.record={...record,status:snapshot.status};
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
        terminalPaneVisible(other.element.dataset.sessionId!) || other === view || other.live || !other.projection || !other.persisted || !!other.parsing || other.updating);
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
        if(!terminalPaneHasSize(view))return;
        view.viewportRevision++;view.fit.fit();
        if (focused() && (document.activeElement === focusOrigin || (focusOrigin?.isConnected === false && document.activeElement === document.body))) view.instance.focus();
        syncViewSize(view);

      });
    } catch (reason: unknown) {
      if (!attached()) return;
      view.cursor = null;view.writable=false;
      if(view.availability!=="terminal_unavailable") {view.availability="terminal_unavailable";setRecoveryRevision(revision=>revision+1);}
      view.firstAttachment=false;
      if(focused()){outputCursor.current=null;setSessionStatus("unavailable");setError(reason instanceof Error ? reason.message : String(reason));}
    } finally {
      if(view.attachVersion===version&&view.attaching){view.attaching=false;setRecoveryRevision(revision=>revision+1);}
    }
  }

  function selectedRecovery() {
    return sessionRecovery(selectedRecord.current, sessionId.current, session?.session_id ?? null,
      sessionStatus, starting, ownerConnectionAvailable.current.available
        ? terminalViews.current.get(sessionId.current ?? "")?.availability ?? "available" : "owner_unavailable");
  }
  function resumeSelectedSession(){if(session && selectedRecovery().canContinue)void startSession({resumeFrom:session.session_id});}

  function rerunSelectedSession() {
    if (!session || !selectedRecovery().canRunAgain) return;
    void startSession({ cwd: session.cwd, command: session.command ?? "", launch:session.launch });
  }

  const isRunning = sessionStatus === "running" || sessionStatus === "starting";
  const orderedHistory=orderPinnedSessions(history.map(record=>({id:record.summary.session_id,record})),pinnedSessions).map(item=>item.record);
  const projectGroups = groupProjects(projects, orderedHistory);
  const currentProject = projectGroups.find(
    (project) =>
      projectKey(project.path) === projectKey(session?.cwd || activeProject),
  );
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
  worktreeContextRef.current={root:visibleGitContext?.root||gitProjectPath||cwd,owner:gitOwner};
  const titleFor = (summary: SessionSummary | HistoryItem["summary"]) =>
    sessionTitles[summary.session_id] || ("title" in summary?summary.title:summary.launch?.prompt || summary.command || (summary.launch ? `${summary.launch.adapter} · ${summary.launch.mode}` : "Interactive shell"));
  const normalizedQuery = historyQuery.trim().toLowerCase();
  const visibleProjects = projectGroups;

  function clearDeletedSessionNames(ids:string[],userIntent=true) {
    const deleted=new Set(ids),restore=layoutRestore.current;
    const invalidHints=restore.pending&&(restore.ids.length?restore.ids:layoutPreferenceLoad.layout.panes).some(id=>id&&deleted.has(id));
    const affectsSelection=terminalLayoutRef.current.panes.some(id=>id&&deleted.has(id))||!!(sessionId.current&&deleted.has(sessionId.current));
    if(invalidHints){
      cancelLayoutRestore(true,false);
      focusTerminalPane(0,false,true);
      setError("Saved terminal layout is unavailable. Using a single pane.");
    }else if(userIntent||terminalLayoutRef.current.panes.some(id=>id&&deleted.has(id))){
      cancelLayoutRestore();
    }
    const layout=terminalLayoutRef.current;
    if(layout.panes.some(id=>id&&deleted.has(id))){
      terminalLayoutRef.current={...layout,panes:layout.panes.map(id=>id&&deleted.has(id)?null:id),revision:layout.revision+1};
      terminalViews.current.setProtected(terminalLayoutRef.current.panes);setTerminalLayout(terminalLayoutRef.current);
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
      localStorage.setItem("yam.pinnedSessions",JSON.stringify(nextPins));
      const stored=localStorage.getItem("yam.lastSession");
      let last=stored;try{last=stored===null?null:JSON.parse(stored);}catch{}
      if(typeof last==="string"&&deleted.has(last))localStorage.removeItem("yam.lastSession");
    }catch(reason){setError(`Failed to save session preferences: ${String(reason)}`);}
  }

  async function takeTerminalControl(){
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!id||!view||!view.live)return;
    const owner=view.frameInstance;
    try{await invoke("take_terminal_control",{sessionId:id});if(sessionId.current!==id||terminalViews.current.get(id)!==view||view.disposed||view.frameInstance!==owner)return;view.writable=true;setError(null);syncViewSize(view);terminal.current?.focus();}
    catch(reason){if(!view.disposed&&view.frameInstance===owner){view.writable=false;if(sessionId.current===id)setError(String(reason));}}
  }
  function syncViewSize(view:TerminalView){
    if(!terminalPaneVisible(view.element.dataset.sessionId!)||!terminalPaneHasSize(view)||!view.live||!view.ready||!view.writable||view.cursor===null||view.disposed)return;
    const owner=view.frameInstance,attachment=view.attachVersion,id=view.element.dataset.sessionId!;
    void queueTerminalResize(view,(cols,rows)=>invoke("resize_session",{sessionId:id,cols,rows}),reason=>{
      if(!view.disposed&&view.frameInstance===owner&&view.attachVersion===attachment){view.writable=false;if(terminalPaneVisible(id))setError(String(reason));}
    });
  }
  function fitTerminalViews(){for(const view of terminalViews.current.all){if(!terminalPaneVisible(view.element.dataset.sessionId!)||!terminalPaneHasSize(view)){view.resizePending=null;continue;}view.viewportRevision++;view.fit.fit();syncViewSize(view);}}
  useEffect(()=>{
    const version=++terminalSettingsVersion.current;
    const apply=()=>{if(version===terminalSettingsVersion.current)try{for(const view of terminalViews.current.all)Object.assign(view.instance.options,terminalOptions(terminalSettingsRef.current));fitTerminalViews();}catch(reason){setTerminalSettingsError(String(reason));}};
    apply();requestAnimationFrame(()=>{void (document.fonts?.ready??Promise.resolve()).then(apply);});
    return()=>{terminalSettingsVersion.current++;};
  },[terminalSettings]);
  function applyTerminalPreferences(next:TerminalSettings){saveTerminalSettings(next,value=>localStorage.setItem("yam.terminalSettings",value));setTerminalSettings(next);setTerminalSettingsError(null);}
  function toggleSessionPin(id:string){try{const next=togglePinnedSession(pinnedSessionsRef.current,id);localStorage.setItem("yam.pinnedSessions",JSON.stringify(next));pinnedSessionsRef.current=next;setPinnedSessions(next);}catch(reason){setError(String(reason));}}
  function closeEndedView(){
    cancelLayoutRestore();
    const id=sessionId.current,view=id?terminalViews.current.get(id):undefined;
    if(!view||view.live||view.parsing||view.updating||!view.persisted||!canCloseSessionView(view.status??""))return;
    const layout=terminalLayoutRef.current;
    terminalLayoutRef.current={...layout,panes:layout.panes.map(current=>current===id?null:current),revision:layout.revision+1};
    terminalViews.current.setProtected(terminalLayoutRef.current.panes);setTerminalLayout(terminalLayoutRef.current);
    terminalViews.current.retain(other=>other!==view);pendingOutput.current.delete(id!);pendingState.current.delete(id!);selectionVersion.current++;detailVersion.current++;
    selectedRecord.current=null;sessionId.current=null;terminal.current=null;fitAddon.current=null;outputCursor.current=null;
    setSession(null);setSessionStatus("idle");setSelectedAgent(undefined);setTerminalNotice("View closed. Select its history to reopen the saved scene.");
    try{const stored=localStorage.getItem("yam.lastSession");if(stored&&JSON.parse(stored)===id)localStorage.removeItem("yam.lastSession");}catch(reason){setError(String(reason));}
  }
  function openCommandPalette(){paletteVersion.current++;setPaletteQuery("");setPaletteOpen(true);}
  function closeCommandPalette(){paletteVersion.current++;setPaletteOpen(false);}
  const recovery=selectedRecovery();
  const canContinue=recovery.canContinue;
  const recoveryNotice=recovery.notice ?? terminalNotice;
  const commandEntries=paletteEntries(paletteQuery,orderedHistory.map(record=>({id:record.summary.session_id,title:titleFor(record.summary),status:record.status})),canContinue);
  async function choosePaletteEntry(entry:PaletteEntry){
    const version=paletteVersion.current;
    try{await executePaletteEntry(entry,{new:()=>newSession(),previous:()=>previousSession.current?openSession(previousSession.current):undefined,search:()=>{setSidebarOpen(true);requestAnimationFrame(()=>{searchInput.current?.focus();searchInput.current?.select();});},logs:()=>setLogSearchOpen(true),inbox:()=>setInboxOpen(true),resume:()=>{if(canContinue)resumeSelectedSession();},diagnostics:()=>exportDiagnostics(),settings:()=>setTerminalSettingsOpen(true),switch:id=>id?openSession(id):undefined},()=>paletteOpen&&version===paletteVersion.current);}
    catch(reason){if(version===paletteVersion.current)setError(String(reason));}
    finally{if(version===paletteVersion.current)closeCommandPalette();}
  }

  function newSession(path = activeProject || session?.cwd || "") {
    cancelLayoutRestore();
    setCwd(path);
    cancelProjectPreview();setProjectLaunchEdits({});
    setSelectedAdapter(globalLaunchDefaults.adapter==="custom"?"shell":globalLaunchDefaults.adapter);
    setLaunchMode(globalLaunchDefaults.mode as "task"|"interactive");
    setCommand(globalLaunchDefaults.command??"");
    setPrompt(globalLaunchDefaults.prompt??"");
    setAdapterArgs(globalLaunchDefaults.extra_args);
    setError(null);
    launchDialog.current?.showModal();
  }
  const currentAgent=selectedAgent;
  const unreadTotal=historyOverview.unread_receipts;
  async function openReceipt(record:HistoryItem,entry:AgentReceipt,agent?:AgentState){
    const action=captureAttention(record,entry,agent);
    const operation=++attentionOperation.current,owner=ownerConnectionAvailable.current.version;
    const valid=()=>terminalMounted.current&&operation===attentionOperation.current&&owner===ownerConnectionAvailable.current.version;
    let proof:{view:TerminalView;attachment:number|undefined;detail:number;intent:number}|null=null;
    const opened=await openSession(action.sessionId,(view,detail,intent)=>{proof={view,attachment:view.attachVersion,detail,intent};},valid);
    if(!opened||!proof)return;
    const attachment=proof as {view:TerminalView;attachment:number|undefined;detail:number;intent:number};
    const current=()=>valid()&&ownerConnectionAvailable.current.available
      &&sessionId.current===action.sessionId&&detailVersion.current===attachment.detail
      &&layoutRestore.current.version===attachment.intent
      &&terminalViews.current.get(action.sessionId)===attachment.view&&!attachment.view.disposed
      &&attachment.view.attachVersion===attachment.attachment&&attachment.view.ready
      &&attachment.view.live&&["starting","running"].includes(attachment.view.status??"")
      &&attachment.view.cursor!==null&&attachment.view.availability!=="owner_unavailable"
      &&attachment.view.availability!=="terminal_unavailable";
    if(action.state!=="current"||!current())return;
    try {
      const fresh=await invoke<SessionRecord>("get_session",{sessionId:action.sessionId});
      if(!current()||!isCurrentAttention(action,fresh))return;
      await invoke("read_agent_receipt",{sessionId:action.sessionId,receipt:action.receipt.id,revision:action.receipt.revision});
      if(current())await refreshHistory(current);
    }catch(reason){if(current())setError(String(reason));}
  }
  async function jumpToAttention(){const version=++detailVersion.current;try{const id=await invoke<string|null>("next_attention",{currentSessionId:sessionId.current});if(version===detailVersion.current&&id)await openSession(id);}catch(reason){if(version===detailVersion.current)setError(String(reason));}}
  function handleShortcut(event:KeyboardEvent){
    const target=event.target instanceof Element?event.target:null;
    const editing=!!target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')&&!target?.closest(".xterm-helper-textarea");
    const blocked=!!document.querySelector("dialog[open]")||!!target?.closest("[data-shortcuts]");
    const action=shortcutAction(event,shortcuts,blocked||editing);
    if(!action){if(paletteShortcut(event,blocked,editing)){event.preventDefault();event.stopPropagation();openCommandPalette();}return;}
    event.preventDefault();event.stopPropagation();
    if(action==='attention')jumpToAttention();
    else if(action==='previous'&&previousSession.current)void openSession(previousSession.current);
    else if(action==='search'){setSidebarOpen(true);requestAnimationFrame(()=>{searchInput.current?.focus();searchInput.current?.select();});}
    else void toggleNotificationPause();
  }
  useEffect(()=>{
    window.addEventListener("keydown",handleShortcut,true);return()=>window.removeEventListener("keydown",handleShortcut,true);
  },[history,shortcuts]);

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
      {terminalSettingsError&&<p role="alert" className="terminal-preference-error">{terminalSettingsError}</p>}
      {updaterOpen&&<div className="modal-backdrop"><UpdaterSettings snapshot={updaterSnapshot} automatic={updaterAutomatic} busy={updaterBusyAction} error={updaterError} onAutomatic={value=>void changeUpdaterAutomatic(value)} onAction={action=>void runUpdaterAction(action)} onClose={closeUpdaterSettings}/></div>}
      {systemEntryOpen&&<div className="system-entry-dialog" role="dialog" aria-modal="true" aria-label="System entry"><SystemEntrySettings enabled={systemEntry.global_shortcut_enabled} registered={systemEntry.global_shortcut_registered} available={systemEntry.shortcut_available} busy={systemEntryBusy} warning={systemEntry.warning} onChange={enabled=>void setGlobalShortcut(enabled)}/><button type="button" onClick={()=>setSystemEntryOpen(false)}>Close</button></div>}
      {terminalSettingsOpen&&<TerminalSettingsDialog settings={terminalSettings} onApply={applyTerminalPreferences} onClose={()=>setTerminalSettingsOpen(false)}/>}
      {paletteOpen&&<CommandPalette query={paletteQuery} onQuery={setPaletteQuery} entries={commandEntries} onChoose={entry=>void choosePaletteEntry(entry)} onClose={closeCommandPalette}/>}
      {archiveOpen&&<HistoryArchive titleFor={titleFor} history={history} onDeleted={clearDeletedSessionNames} onClose={()=>{setArchiveOpen(false);void refreshHistory();}} onChanged={async()=>{await refreshHistory();if(capacityOpen)await scanCapacity();}} onSelect={async id=>{if(!await openSession(id))throw Error("Session selection was superseded or unavailable");}}/>}
      {logSearchOpen&&<SessionLogSearch sessions={history.map(record=>({id:record.summary.session_id,title:titleFor(record.summary),cwd:record.summary.cwd}))} selected={session?.session_id??null} onClose={()=>setLogSearchOpen(false)} onSelect={async id=>{if(!await openSession(id))throw Error("Session selection was superseded or unavailable");}}/>}
      {logExportOpen&&session&&<SessionLogExport sessionId={session.session_id} title={titleFor(session)} onClose={()=>setLogExportOpen(false)}/>}
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
            ref={searchInput}
            onKeyDown={event=>{
              if(event.nativeEvent.isComposing)return;
              if(event.key==='Enter'){const match=visibleProjects.flatMap(project=>project.sessions)[0];if(match){event.preventDefault();void openSession(match.summary.session_id);}}
              else if(event.key==='Escape'){setHistoryQuery("");terminal.current?.focus();}
            }}
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
        <button type="button" className="secondary-button inbox-toggle" onClick={()=>setInboxOpen(value=>!value)} aria-expanded={inboxOpen}>Inbox · {unreadTotal} unread</button>
        <button type="button" className="secondary-button inbox-toggle" onClick={jumpToAttention} disabled={!historyOverview.attention_sessions} title={`Ctrl/Cmd+Shift+${shortcuts.attention}`}>Next attention</button>
        {inboxOpen && <section className="agent-inbox" aria-label="Agent round inbox">
          {inbox.map(({session:record,receipt:entry})=>{
            const agent=sessionId.current===record.summary.session_id?currentAgent:undefined;
            return <AttentionCard key={`${record.summary.session_id}:${entry.id}`} record={record} entry={entry} agent={agent} title={titleFor(record.summary)} onOpen={()=>void openReceipt(record,entry,agent)}/>;
          })}
          {inboxCursor&&<button type="button" onClick={()=>void refreshInbox(true)}>Load more unread rounds</button>}
          {!unreadTotal && <p>No unread rounds</p>}
        </section>}
        <details className="advanced-options" data-shortcuts>
          <summary>Keyboard shortcuts</summary>
          <p>Cmd on macOS / Ctrl elsewhere + Shift + key</p>
          {(Object.keys(shortcuts) as (keyof Shortcuts)[]).map(action=><label key={action}>
            <span>{{attention:"Next attention",previous:"Previous session",search:"Quick search",pause:"Pause / resume notifications"}[action]}</span>
            <input aria-label={`${action} shortcut key`} value={shortcuts[action]} maxLength={1} onChange={event=>{
              const next={...shortcuts,[action]:event.target.value};
              if(isShortcuts(next)){setShortcuts(next);setError(null);}else setError("Use different letters or [ / ] for each shortcut.");
            }}/>
          </label>)}
          <button type="button" className="secondary-button" onClick={()=>{setShortcuts(defaultShortcuts);setError(null);}}>Reset shortcuts</button>
        </details>
        <div className="history-capacity-controls">
          <p role="status">{history.length} loaded · {historyOverview.total} sessions · {historyOverview.active} active</p>
          {historyCursor&&<button type="button" disabled={historyLoading} onClick={()=>void loadMoreHistory()}>Load more sessions</button>}
          <button type="button" aria-label="Browse archived sessions" onClick={()=>setArchiveOpen(true)}>Browse archived sessions</button>
          <button type="button" onClick={()=>{setCapacityOpen(value=>!value);if(!capacityOpen)void scanCapacity();}}>Manage history capacity</button>
          {historyOverview.metadata_bytes!=null&&capacityLevel(historyOverview.metadata_bytes)!=="normal"&&<p role="status">History metadata {capacityLevel(historyOverview.metadata_bytes)==="protected"?"has reached its 32 MiB protection limit":"is near its 32 MiB limit"}. Open capacity management.</p>}
          {capacityOpen&&<section aria-label="History capacity management">
            <p>Archive and restore controls will be added in the next stage. No history is deleted automatically.</p>
            {capacity&&<><dl>{([['Metadata',capacity.metadata_bytes],['Logs',capacity.log_bytes],['Scenes',capacity.scene_bytes],['Backups',capacity.backup_bytes],['Archive',capacity.archive_bytes],['Other',capacity.other_bytes]] as const).map(([name,bytes])=><div key={name}><dt>{name}</dt><dd>{(bytes/1024/1024).toFixed(2)} MiB</dd></div>)}</dl><p>{capacity.complete?'Complete scan':'Partial scan'} · {capacity.scanned_entries} entries</p>{capacity.issues.map(issue=><p key={issue}>{issue.replace(/_/g,' ')}</p>)}</>}
            {capacityError&&<p role="alert">{capacityError}</p>}
            <button type="button" disabled={capacityBusy} onClick={()=>void scanCapacity()}>Refresh capacity</button>
            {capacityBusy&&<button type="button" onClick={()=>void cancelCapacity()}>Cancel scan</button>}
          </section>}
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
                      <div className="session-item" key={record.summary.session_id}><button
                        className={`session-row ${session?.session_id === record.summary.session_id ? "selected" : ""}`}
                        key={record.summary.session_id}
                        aria-current={
                          session?.session_id === record.summary.session_id
                            ? "page"
                            : undefined
                        }
                        title={`${titleFor(record.summary)}\n${statusLabels[record.status] ?? record.status}`}
                        onClick={() => void openSession(record.summary.session_id)}
                      >
                        <span
                          className={`session-dot status-${record.status}`}
                          aria-label={
                            statusLabels[record.status] ?? record.status
                          }
                        />
                        <span className="session-title">
                          {titleFor(record.summary)}
                          {record.summary.mode==="interactive" && <small title={record.agent?.integration}>{agentLabel({phase:record.agent.phase,integration:record.agent.integration,agent_session_id:null,inbox:[]},record.status)}{record.agent.unread_count>0?` · ${record.agent.unread_count} unread`:""}</small>}
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
                      </button><button type="button" className="session-pin" aria-pressed={pinnedSessions.includes(record.summary.session_id)} aria-label={`${pinnedSessions.includes(record.summary.session_id)?"Unpin":"Pin"} ${titleFor(record.summary)}`} onClick={()=>toggleSessionPin(record.summary.session_id)}>{pinnedSessions.includes(record.summary.session_id)?"Pinned":"Pin"}</button></div>
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
          {visibleGitContext && <div className="git-context" role="status">
            <span>{gitContextLabel(visibleGitContext)}</span>
            {visibleGitContext.root && <span>Worktree: {visibleGitContext.root}</span>}
            {visibleGitContext.common_dir && <span>Common Git directory: {visibleGitContext.common_dir}</span>}
          </div>}
          <div className="toolbar">
            <button type="button" className="icon-button" title="Stop all tasks and quit YAM" aria-label="Stop all tasks and quit YAM" onClick={()=>void invoke("stop_all_and_quit").catch(reason=>setError(String(reason)))}><LogOut/></button>
            <button className="icon-button" aria-label="Export session log" title="Export session log" disabled={!session} onClick={()=>setLogExportOpen(true)}><Copy/></button>
            <button className="icon-button" aria-label="Search session logs" title="Search session logs" onClick={()=>setLogSearchOpen(true)}><Search/></button>
            {session?.launch?.mode==="interactive" && <span className="round-status" role="status" title="Last confirmed CLI event; missing hooks can leave this status stale.">{agentLabel(currentAgent,sessionStatus)}</span>}
            <button type="button" className="secondary-button" onClick={()=>{setSystemEntryOpen(true);void refreshSystemEntry();}}>System entry</button>
            <button type="button" className="secondary-button" onClick={()=>setUpdaterOpen(true)}>Updates</button>
            <button type="button" className="icon-button" aria-pressed={notificationsPaused} aria-label={notificationsPaused?"Resume notifications":"Pause notifications"} title={notificationsPaused?"Resume notifications":"Pause notifications"} onClick={()=>void toggleNotificationPause()}>{notificationsPaused?<BellOff/>:<Bell/>}</button>
            {isRunning && session && <button type="button" title="Take terminal input control from another connected window" onClick={()=>void takeTerminalControl()}>Take control</button>}
            {historyOverview.failed_receipts>0 && <button type="button" className="icon-button" aria-label="Retry round notifications" title="Retry round notifications" onClick={()=>void invoke("retry_agent_notifications").catch(reason=>setError(String(reason)))}><RotateCcw/></button>}
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
            <button type="button" className="icon-button" aria-label="Command palette" title={Object.values(shortcuts).some(key=>key.toLowerCase()==="p")?"Command palette (shortcut assigned to another action; use this button)":"Command palette (Cmd/Ctrl+Shift+P)"} onClick={openCommandPalette}><Search/></button>
            <button type="button" className="icon-button" aria-label="Terminal settings" title="Terminal settings" onClick={()=>setTerminalSettingsOpen(true)}><TerminalSquare/></button>
            <button type="button" className="icon-button" aria-label="Close ended view" title="Close saved ended view without deleting history" disabled={!session||isRunning||!terminalViews.current.get(session.session_id)?.persisted} onClick={closeEndedView}><X/></button>
            <button
              className="icon-button"
              title="Run again (new task)"
              aria-label="Run again"
              disabled={!recovery.canRunAgain}
              onClick={rerunSelectedSession}
            >
              <RotateCcw />
            </button>
            {session?.launch?.mode==='interactive' && <button type="button" className="icon-button" aria-label="Continue conversation" title="Continue original Agent conversation (new process)" disabled={!canContinue} onClick={resumeSelectedSession}><Play/></button>}
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
              {isRunning && session.launch?.mode !== "interactive" && agentPhase !== "idle" && (
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
          className={`terminal-area ${terminalLayout.panes.some(Boolean) ? "" : "terminal-empty"}`}
          aria-label="Terminal"
        >
          <div className="terminal-host terminal-cache-host" ref={terminalHost} aria-hidden="true" />
          <TerminalLayout layout={terminalLayout} labels={terminalLayout.panes.map(id=>id?titleFor(terminalViews.current.get(id)?.record?.summary??{session_id:id,cwd:"",command:null,status:"unknown"}):null)} splitPercent={splitPercent} swapDisabled={target=>!canSwapTerminalPanes(target)} onMode={changeLayoutMode} onFocus={focusTerminalPane} onClose={closeTerminalPane} onHost={mountTerminalPane} onSplitChange={commitTerminalSplit} onSplitPreview={()=>requestTerminalLayoutFit()} onSwap={swapTerminalPane} onCancelFit={cancelTerminalLayoutFit} />
          {!session && terminalLayout.mode==="single" && (
            <div className="empty-state">
              <TerminalSquare className="empty-icon" aria-hidden="true" />
              <h1>{currentProject?.name || "YAM"}</h1>
              {visibleGitContext && <div className="git-context" role="status">
                <span>{gitContextLabel(visibleGitContext)}</span>
                {visibleGitContext.root && <span>Worktree: {visibleGitContext.root}</span>}
                {visibleGitContext.common_dir && <span>Common Git directory: {visibleGitContext.common_dir}</span>}
              </div>}
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
        {recoveryNotice && <div className="terminal-notice" role="status">{recoveryNotice}</div>}
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
          <button type="button" aria-label="Export diagnostics" title="Save version, connection and aggregate counts; excludes session content and paths" disabled={diagnosticsExporting} onClick={()=>void exportDiagnostics()}>{diagnosticsExporting?"Exporting…":"Export diagnostics"}</button>
          {diagnosticsMessage&&<span role="status">{diagnosticsMessage}</span>}
            <span>{session ? session.session_id : "No session selected"}</span>
            <span className="memory-usage" title={memory
              ? `${memory.metric}: YAM desktop, WebKit, background and terminal parser. Tasks: PTY/Agent processes. Per-process sum; shared pages are not deduplicated. Refreshes every 5 seconds.`
              : "Memory sampling unavailable or incomplete. Refreshes every 5 seconds while visible."}>
              {memoryLabel(memory)}
            </span>
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
          cancelProjectPreview();
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
                value={formAdapter}
                onChange={(event) => {setSelectedAdapter(event.target.value);setProjectLaunchEdits(previous=>({...previous,adapter:event.target.value}));}}
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
            {formAdapter !== "shell" && (
              <label>
                <span>Run mode</span>
                <select value={formLaunch.mode} onChange={(event) => {setLaunchMode(event.target.value as "task" | "interactive");setProjectLaunchEdits(previous=>({...previous,mode:event.target.value}));}}>
                  <option value="task">Run one task · reports completion</option>
                  <option value="interactive">Continuous conversation</option>
                </select>
                <small>{launchMode==='task'?"Reports when the command exits; each launch starts a new task.":selectedAdapter==='codex'?"Round reminders require supported CLI hooks and trust. If unavailable, only exit / idle reminders are supported.":selectedAdapter==='claude'?"Supported Claude hooks report reply readiness, permission requests and API failures. A ready reply may still be followed by hook continuation.":selectedAdapter==='opencode'?"Native message and session events report main conversation replies, permission requests and errors. Startup idle and subagent replies do not complete your round.":"Round integration is unavailable for this adapter; only exit / idle reminders are supported."}</small>
              </label>
            )}
            {formAdapter !== "shell" && (
              <label>
                <span>Prompt</span>
                <textarea
                  rows={4}
                  value={formLaunch.prompt??""}
                  onChange={(event) => {setPrompt(event.target.value);setProjectLaunchEdits(previous=>({...previous,prompt:event.target.value}));}}
                />
              </label>
            )}
            <details className="advanced-options">
              <summary>Advanced options</summary>
              <label>
                <span>Custom command</span>
                <input
                  value={formLaunch.command??""}
                  onChange={(event) => {setCommand(event.target.value);setProjectLaunchEdits(previous=>({...previous,command:event.target.value||null,adapter:event.target.value?"custom":formAdapter}));}}
                />
              </label>
              {formAdapter !== "shell" && (
                <label>
                  <span>CLI arguments</span>
                  <input
                    value={formLaunch.extra_args}
                    onChange={(event) => {setAdapterArgs(event.target.value);setProjectLaunchEdits(previous=>({...previous,extra_args:event.target.value}));}}
                  />
                </label>
              )}
            </details>
            <GitChanges path={gitProjectPath} owner={gitOwner}/>
            <WorktreeControls root={visibleGitContext?.root||gitProjectPath||cwd} owner={gitOwner} selected={selectedWorktree} onCreated={worktreeCreated} onStart={startManagedWorktree}/>
            <ProjectConfigPreview preview={projectPreview} busy={projectConfigBusy} error={projectConfigError} template={projectTemplate} onTemplate={setProjectTemplate} onPreview={()=>void readProjectConfig()} onTrust={()=>void approveProjectConfig()} onCancel={cancelProjectPreview}/>
            {projectPreview?.config&&<label className="log-checkbox"><input type="checkbox" checked={useProjectSettings} onChange={event=>setUseProjectSettings(event.target.checked)}/>Use trusted project settings</label>}
            <LaunchTemplates templates={launchTemplateCollection.templates} selectedId={launchTemplateCollection.selectedId} name={launchTemplateName} writeError={launchTemplateCollection.writeError} actionError={launchTemplateActionError} starting={starting} onNameChange={setLaunchTemplateName} onSelect={selectLaunchTemplate} onSave={saveLaunchTemplate} onUpdate={updateLaunchTemplate} onDuplicate={duplicateLaunchTemplate} onDelete={deleteLaunchTemplate} onApply={applyLaunchTemplate}/>
            <button type="button" className="secondary-button" disabled={starting||useProjectSettings} onClick={()=>void saveLaunchDefaults()}>Save current fields as application defaults</button>
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
              disabled={starting || adapters.length === 0 || projectConfigBusy || (useProjectSettings&&!projectPreview?.trusted)}
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
