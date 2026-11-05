import {t} from "./i18n";
import {groupInbox,type InboxItem} from "./history";
import type {AgentState,AgentReceipt} from "./agent-events";
import {AttentionCard} from "./AttentionCard";

type Props={items:InboxItem[];titleFor:(summary:InboxItem["session"]["summary"])=>string;selectedId:string|null;currentAgent?:AgentState;onOpen:(record:InboxItem["session"],entry:AgentReceipt,agent?:AgentState)=>void;onMarkRead:(record:InboxItem["session"],entry:AgentReceipt)=>void};
export function SessionInbox({items,titleFor,selectedId,currentAgent,onOpen,onMarkRead}:Props){
 return <>{groupInbox(items).map(({session,receipts,unreadCount})=>{
  const title=titleFor(session.summary),agent=selectedId===session.summary.session_id?currentAgent:undefined;
  const card=(entry:AgentReceipt)=><AttentionCard key={entry.id} record={session} entry={entry} agent={agent} title={title} hideTitle compact onOpen={()=>onOpen(session,entry,agent)} onMarkRead={()=>onMarkRead(session,entry)}/>;
  return <section key={session.summary.session_id} className="inbox-session-group" aria-label={title}>
   <header><strong title={title}>{title}</strong><span>{t("{{value0}} unread",{value0:unreadCount})}</span></header>
   {card(receipts[0])}
   {receipts.length>1&&<details className="inbox-older-notices"><summary>{t("{{count}} earlier notices",{count:receipts.length-1})}</summary>{receipts.slice(1).map(card)}</details>}
   {unreadCount>receipts.length&&<p className="inbox-loaded-note">{t("{{count}} notices loaded. Load more below to see the rest.",{count:receipts.length})}</p>}
  </section>;
 })}</>;
}
