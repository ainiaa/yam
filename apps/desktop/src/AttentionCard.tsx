import {t} from "./i18n";
import type {AgentReceipt,AgentState} from "./agent-events";
import {captureAttention,type AttentionSession} from "./attention-actions";

type Props={record:AttentionSession;entry:AgentReceipt;agent?:AgentState;title:string;onOpen:()=>void};
export function AttentionCard({record,entry,agent,title,onOpen}:Props) {
  const action=captureAttention(record,entry,agent);
  return <article className="attention-card">
    <strong>{title}</strong>
    <span>{t(action.label)} · {t(entry.delivery)}</span>
    <p>{t(action.explanation)}</p>
    <span>{action.state==="current"?t("Current round"):t("Historical / current round unconfirmed")}</span>
    {entry.error&&<p>{t(entry.error)}</p>}
    <button type="button" onClick={onOpen}>{action.state==="current"?t("View / handle in terminal"):t("View recorded terminal")}</button>
  </article>;
}
