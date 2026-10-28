// Author: Jeff.Liu. Tauri's prehashed Minisign framing; crypto primitives stay in Node/OpenSSL.
import {createHash, createPublicKey, verify} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';

function decode(value) {
  const bytes=Buffer.from(value,'base64');
  if(bytes.toString('base64')!==value)throw Error('Invalid signature encoding');
  return bytes;
}
try {
  const [publicKey,artifact,signaturePath,version]=process.argv.slice(2);
  if(!publicKey||!artifact||!signaturePath||!version)throw Error('Missing verification input');
  const size=statSync(artifact).size;
  if(size<=0||size>256*1024*1024||statSync(signaturePath).size>8192||publicKey.length>8192)throw Error('Invalid verification input size');
  const keyLines=decode(publicKey).toString('utf8').trim().split(/\r?\n/);
  const lines=decode(readFileSync(signaturePath,'utf8').trim()).toString('utf8').trim().split(/\r?\n/);
  if(keyLines.length!==2||!keyLines[0].startsWith('untrusted comment: ')||lines.length!==4||!lines[0].startsWith('untrusted comment: ')||!lines[2].startsWith('trusted comment: '))throw Error('Invalid signature framing');
  const key=decode(keyLines[1]),packet=decode(lines[1]),globalSignature=decode(lines[3]);
  if(key.length!==42||packet.length!==74||globalSignature.length!==64||key.subarray(0,2).toString()!=='Ed'||packet.subarray(0,2).toString()!=='ED'||!key.subarray(2,10).equals(packet.subarray(2,10)))throw Error('Invalid key or algorithm');
  const publicObject=createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:key.subarray(10).toString('base64url')},format:'jwk'});
  const signature=packet.subarray(10),comment=lines[2].slice('trusted comment: '.length);
  const digest=createHash('blake2b512').update(readFileSync(artifact)).digest();
  if(!verify(null,digest,publicObject,signature)||!verify(null,Buffer.concat([signature,Buffer.from(comment)]),publicObject,globalSignature)||!comment.split('\t').includes(`version:${version}`))throw Error('Invalid artifact signature or signed version');
} catch {
  process.stderr.write('Updater artifact signature, public key or signed version is invalid.\n');
  process.exitCode=1;
}
