// Author: Jeff.Liu. Private pipe: only short-lived access credentials leave this process.
import { createYamAuth } from './yam-auth.mjs';
import {ownerAuthentication,serveAuthentication} from './auth-job.mjs';
import { execFileSync } from 'node:child_process';
process.umask(0o077);
const cancel = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => cancel.abort());
try {
    const local = createYamAuth({ root: process.argv[2] });
    const onAuth = ({ url }) => { console.log(`YAM · Continue with ChatGPT: ${url}`); execFileSync('/usr/bin/open', [url], { stdio: 'ignore', timeout: 5000 }); };
    const auth = process.env.YAM_OMP_DESKTOP === '1'
        ? {read: ({signal}) => ownerAuthentication(process.env,'read',signal), login: ({signal}) => ownerAuthentication(process.env,'login',signal)} : local;
    if (process.argv[3] === 'broker') {
        await serveAuthentication(local,{onAuth: ({url}) => execFileSync('/usr/bin/open',[url],{stdio:'ignore',timeout:5000})});
    }
    else if (process.argv[3] === 'login') {
        await auth.login({ signal: cancel.signal, onAuth });
        cancel.signal.throwIfAborted();
        console.log('YAM ChatGPT authorization saved.');
    }
    else {
        const c = await auth.read({ signal: cancel.signal });
        cancel.signal.throwIfAborted();
        process.stdout.write(JSON.stringify(c));
    }
}
catch (e) {
    console.error(JSON.stringify({ code: e.code?.startsWith('YAM_') ? e.code : 'YAM_AUTH_FAILED', message: e.code?.startsWith('YAM_') ? e.message : 'YAM ChatGPT authorization could not finish; check authorization and the system proxy.' }));
    process.exitCode = 1;
}
