export type TaskRule={task:'transform'|'answer'|'repository'|'coding'|'review'|'other';description:string;examples:string[];model:'small'|'medium'|'strong';effort:'medium'|'high'|'xhigh'|'max'};
export type TaskRules={v:1|2;rules:TaskRule[];fallback:{model:'medium'|'strong';effort:'high'|'xhigh'|'max'}};
export const defaultRules:TaskRules;
export const defaultTierRules:TaskRules;
export function validateRules(value:unknown):TaskRules;
export function rulesVersion(value:TaskRules):string;
export function classifierPrompt(value:TaskRules):string;
