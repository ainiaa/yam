// Author: Jeff.Liu. Exact native path selection for explicit Finder actions.
export type TerminalFilePreviewData={path:string;canonical:string};
export function selectedFilePath(value:string):string{
 if(typeof value!=="string"||!value.startsWith("/")||new TextEncoder().encode(value).length>4096||/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value)||/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g,"")))throw Error("Select one absolute file path on this Mac (up to 4096 UTF-8 bytes).");
 return value;
}
export function filePreviewReply(value:unknown,path:string):TerminalFilePreviewData{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("File preview is unavailable.");
 const row=value as TerminalFilePreviewData;if(row.path!==path)throw Error("File preview target changed.");
 return {path:selectedFilePath(row.path),canonical:selectedFilePath(row.canonical)};
}
