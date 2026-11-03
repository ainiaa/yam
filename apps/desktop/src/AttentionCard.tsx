import {t} from "./i18n";
import type {AgentReceipt,AgentState} from "./agent-events";
import {captureAttention,type AttentionSession} from "./attention-actions";

type Props={record:AttentionSession;entry:AgentReceipt;agent?:AgentState;title:string;hideTitle?:boolean;compact?:boolean;onOpen:()=>void;onMarkRead?:()=>void};
export function AttentionCard({record,entry,agent,title,hideTitle=false,compact=false,onOpen,onMarkRead}:Props) {
  const action=captureAttention(record,entry,agent);
  const explanation=<><p>{t(action.explanation)}</p><span>{action.state==="current"?t("Current round"):t("Historical / current round unconfirmed")}</span>{entry.error&&<p>{t(entry.error)}</p>}</>;
  return <article className="attention-card">
    {!hideTitle&&<strong>{title}</strong>}
    <span>{t(action.label)}</span>
    {compact?<details className="attention-notice-details"><summary>{t("Notice details")}</summary>{explanation}</details>:explanation}
    <button type="button" onClick={onOpen}>{action.state==="current"?t("View / handle in terminal"):t("View recorded terminal")}</button>
    {action.state!=="current"&&onMarkRead&&<button type="button" onClick={onMarkRead}>{t("Mark as read")}</button>}
  </article>;
}
