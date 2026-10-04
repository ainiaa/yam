import type {AgentReceipt,AgentState} from "./agent-events";
import {captureAttention,type AttentionSession} from "./attention-actions";

type Props={record:AttentionSession;entry:AgentReceipt;agent?:AgentState;title:string;onOpen:()=>void};
export function AttentionCard({record,entry,agent,title,onOpen}:Props) {
  const action=captureAttention(record,entry,agent);
  return <article className="attention-card">
    <strong>{title}</strong>
    <span>{action.label} · {entry.delivery}</span>
    <p>{action.explanation}</p>
    <span>{action.state==="current"?"Current round":"Historical / current round unconfirmed"}</span>
    {entry.error&&<p>{entry.error}</p>}
    <button type="button" onClick={onOpen}>{action.state==="current"?"View / handle in terminal":"View recorded terminal"}</button>
  </article>;
}
