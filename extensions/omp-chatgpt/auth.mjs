// Author: Jeff.Liu
// Private pipe protocol: stdout is consumed only by the extension, never forwarded to its UI.
import {loadPiCredentialReader} from './runtime.mjs';
try {
  const read=await loadPiCredentialReader(process.argv[2],process.argv[3]);
  process.stdout.write(JSON.stringify(await read()));
}catch{
  process.stderr.write('Pi ChatGPT credential unavailable.\n');
  process.exitCode=1;
}
