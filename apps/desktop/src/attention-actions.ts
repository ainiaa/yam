import type {AgentReceipt, AgentState} from "./agent-events";

export type AttentionSession = {summary:{session_id:string};status:string};
export type AttentionAction = {
  sessionId:string; generation:string|null; turnId:string|null;
  receipt:AgentReceipt; state:"current"|"historical"|"unknown";
  label:string; explanation:string;
};
const explanations:Record<string,{label:string;explanation:string}> = {
  needs_permission:{label:"Permission required",explanation:"Review and respond in the terminal. Opening this card does not approve or reject permission."},
  needs_attention:{label:"Response ready",explanation:"View the response and continue in the terminal when ready."},
  response_finished:{label:"Response finished",explanation:"View this round in the terminal. This does not mean the whole task completed."},
  failed:{label:"Round failed",explanation:"Inspect the failure in the terminal before deciding what to do next."},
  interrupted:{label:"Round interrupted",explanation:"Inspect the interrupted round in the terminal."},
};
function text(value:unknown):value is string { return typeof value==="string"&&value.length>0; }
function receiptValid(entry:AgentReceipt):boolean {
  return text(entry.id)&&text(entry.turn_id)&&Number.isSafeInteger(entry.revision)&&entry.revision>0&&Object.prototype.hasOwnProperty.call(explanations,entry.kind);
}
export function captureAttention(record:AttentionSession,entry:AgentReceipt,agent?:AgentState):AttentionAction {
  const copy={...entry}, explanation=(Object.prototype.hasOwnProperty.call(explanations,entry.kind)?explanations[entry.kind]:undefined)??{label:"Round status unknown",explanation:"View the recorded terminal. This card cannot confirm the current round."};
  const action:AttentionAction={sessionId:record.summary.session_id,generation:agent?.generation??null,turnId:agent?.turn_id??null,receipt:copy,state:"unknown",...explanation};
  if(receiptValid(copy)&&text(action.generation)&&text(action.turnId)&&Number.isSafeInteger(agent?.revision)&&agent!.revision!>=copy.revision){
    action.state=isCurrentAttention({...action,state:"current"},{...record,agent})?"current":"historical";
  }
  return action;
}
export function isCurrentAttention(action:AttentionAction,record:AttentionSession&{agent?:AgentState}):boolean {
  const agent=record.agent,entry=action.receipt;
  if(action.state!=="current"||record.summary.session_id!==action.sessionId||!["starting","running"].includes(record.status)||!agent||agent.integration!=="connected"||!receiptValid(entry))return false;
  if(!text(action.generation)||!text(action.turnId)||agent.generation!==action.generation||agent.turn_id!==action.turnId||entry.turn_id!==action.turnId||agent.phase!==entry.kind||!Number.isSafeInteger(agent.revision)||agent.revision!<entry.revision)return false;
  const matching=agent.inbox.filter(candidate=>candidate.id===entry.id);
  return matching.length===1&&matching[0].revision===entry.revision&&matching[0].turn_id===entry.turn_id&&matching[0].kind===entry.kind&&!matching[0].read;
}
