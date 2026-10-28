// Author: Jeff.Liu. Isolated parent JSX fixtures retain their select token; Select itself has separate callback tests.
export function componentFunction(...args){return new Function(...args.slice(0,-1),'const Select="select",EditableCombo="input";'+args.at(-1));}
