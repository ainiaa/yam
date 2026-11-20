import {t} from "./i18n";
import {groupInbox,type InboxItem} from "./history";
import type {AgentState,AgentReceipt} from "./agent-events";
import {projectKey} from "./workspaces";
import {AttentionCard} from "./AttentionCard";

type Props={project?:string|null;projectOnly?:boolean;actionableOnly?:boolean;items:InboxItem[];titleFor:(summary:InboxItem["session"]["summary"])=>string;selectedId:string|null;currentAgent?:AgentState;onOpen:(record:InboxItem["session"],entry:AgentReceipt,agent?:AgentState,ownerCurrent?:boolean)=>void;onMarkRead:(record:InboxItem["session"],entry:AgentReceipt)=>void};
export function SessionInbox({items,titleFor,selectedId,currentAgent,onOpen,onMarkRead,project=null,projectOnly=false,actionableOnly=false}:Props){
 const groups=groupInbox(items,selectedId,currentAgent).filter(group=>(!projectOnly||!!project&&projectKey(group.session.summary.cwd)===projectKey(project))&&(!actionableOnly||group.actionable));
 return <>{groups.length?groups.map(({session,receipts,unreadCount,agent,priority,ownerCurrentIds},index)=>{
  const title=titleFor(session.summary),needsAction=priority<2;
  const card=(entry:AgentReceipt)=><AttentionCard key={entry.id} record={session} entry={entry} agent={agent} title={title} hideTitle compact onOpen={()=>onOpen(session,entry,agent,ownerCurrentIds?.has(entry.id))} onMarkRead={()=>onMarkRead(session,entry)}/>;
  return <section key={session.summary.session_id} className="inbox-session-group" aria-label={title}>
   <header>
    {(index===0||(groups[index-1].priority<2)!==needsAction)&&<h3 className="inbox-priority-heading">{t(needsAction?"Needs your attention":"Other unread rounds")}</h3>}
    <strong title={title}>{title}</strong><span>{t("{{value0}} unread",{value0:unreadCount})}</span>
   </header>
   {card(receipts[0])}
   {receipts.length>1&&<details className="inbox-older-notices"><summary>{t("{{count}} other notices",{count:receipts.length-1})}</summary>{receipts.slice(1).map(card)}</details>}
   {unreadCount>receipts.length&&<p className="inbox-loaded-note">{t("{{count}} notices loaded. Load more below to see the rest.",{count:receipts.length})}</p>}
  </section>;
 }):<p>{t("No matching loaded notices")}</p>}</>;
}
