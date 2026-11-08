import type {TaskRules} from './task-rules.mjs';
export type CodexConnection={billing:'subscription';native:true}|{billing:'subscription'|'paid';home:string;baseUrl?:string;apiKeyEnv?:string}|{billing:'paid';gateway:true;baseUrl:string;apiKeyEnv?:string;home?:never};
export type CodexPolicy={connections:Record<string,CodexConnection>;classifiers:string[];executionGroups:Record<string,string>[];rules?:TaskRules;model?:string;effort?:string;respectSystemProxy?:boolean};
export function readCodexPolicy(raw:string,options?:{allowIncomplete?:boolean}):CodexPolicy;
export function validateCodexPolicy(config:CodexPolicy):unknown;
