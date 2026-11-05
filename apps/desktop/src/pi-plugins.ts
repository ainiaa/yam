// Author: Jeff.Liu. Accept only explicit npm package identities returned by Pi package management.
export type PiPackage={name:string;source:string};
export type PiMarketPackage=PiPackage&{version:string;description:string};
export type PiPackageState={revision:string;pi_available:boolean;packages:PiPackage[];configured_names:string[];other_count:number};
export type PiPackageSearch={packages:PiMarketPackage[]};
const namePattern=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
function validPackage(value:unknown):value is PiPackage{
 if(!value||typeof value!=='object')return false;const p=value as PiPackage;
 if(typeof p.name!=='string'||p.name.length>214||!namePattern.test(p.name)||typeof p.source!=='string')return false;
 const prefix=`npm:${p.name}`;return p.source===prefix||p.source.startsWith(prefix+'@')&&p.source.length<=350&&versionPattern.test(p.source.slice(prefix.length+1));
}
export function parsePiPackageState(value:unknown):PiPackageState{
 const v=value as PiPackageState;
 if(!v||typeof v!=='object'||typeof v.revision!=='string'||!/^[a-f0-9]{64}$/.test(v.revision)||typeof v.pi_available!=='boolean'||!Number.isSafeInteger(v.other_count)||v.other_count<0||v.other_count>512||!Array.isArray(v.packages)||v.packages.length>512||!v.packages.every(validPackage)||!Array.isArray(v.configured_names)||v.configured_names.length>512||!v.configured_names.every(n=>typeof n==='string'&&n.length<=214&&namePattern.test(n))||new Set(v.configured_names).size!==v.configured_names.length||!v.packages.every(p=>v.configured_names.includes(p.name)))throw Error('Invalid Pi package state. Refresh before continuing.');
 return v;
}
export function parsePiPackageSearch(value:unknown):PiPackageSearch{
 const v=value as PiPackageSearch;
 if(!v||typeof v!=='object'||!Array.isArray(v.packages)||v.packages.length>30||!v.packages.every(p=>validPackage(p)&&typeof p.version==='string'&&p.version.length<=128&&versionPattern.test(p.version)&&p.source===`npm:${p.name}@${p.version}`&&typeof p.description==='string'&&p.description.length<=1000)||new Set(v.packages.map(p=>p.name)).size!==v.packages.length)throw Error('Invalid Pi package search response.');
 return v;
}
