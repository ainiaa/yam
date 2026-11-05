// Author: Jeff.Liu. Fixed official installers; execution requires an explicit user action.
const installers:Record<string,{name:string;command:string;requiresNode?:boolean}>={
 codex:{name:'Codex CLI',command:"/bin/bash -o pipefail -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'"},
 claude:{name:'Claude Code',command:"/bin/bash -o pipefail -c 'curl -fsSL https://claude.ai/install.sh | bash'"},
 gemini:{name:'Gemini CLI',command:'npm install -g @google/gemini-cli',requiresNode:true},
 opencode:{name:'OpenCode',command:'npm install -g opencode-ai',requiresNode:true},
 pi:{name:'Pi',command:"/bin/bash -o pipefail -c 'curl -fsSL https://pi.dev/install.sh | sh'"},
};
export function cliInstaller(id:string){return Object.prototype.hasOwnProperty.call(installers,id)?installers[id]:undefined;}
