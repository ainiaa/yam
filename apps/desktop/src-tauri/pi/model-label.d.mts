import type {CodexPolicy} from './codex-route-config.mjs';
export const zhModelLabels:Record<string,string>;
export type PiCatalogSource='magpie-pi'|'magpie-direct'|'pi';
export function piModelCatalogSource(key:string):PiCatalogSource;
export function modelPresentation(key:string,model:{source?:string;billing?:string;legacy_alias?:boolean}|undefined,connections:CodexPolicy['connections']|null|undefined,translate:(key:string)=>string):{source:string;label:string};
