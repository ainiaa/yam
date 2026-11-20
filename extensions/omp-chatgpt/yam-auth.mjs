// Author: Jeff.Liu. YAM-owned public ChatGPT OAuth; no Pi credentials or SDK.
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
const AUTH = 'https://auth.openai.com', RESOURCE = 'https://api.openai.com/v1';
function failure(code, message) { return Object.assign(Error(message), { code }); }
const required = () => failure('YAM_AUTH_REQUIRED', 'YAM ChatGPT authorization is required. Start an interactive OMP session or run --yam-login.');
const aborted = signal => signal?.throwIfAborted();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function same(a, b) { if (typeof a !== 'string' || typeof b !== 'string')
    return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function client(value) { return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\s\p{Cc}]/u.test(value) && value !== 'dynamic_agent_client'; }
export function authorizationUrl(flow) {
    const u = new URL(AUTH + '/api/accounts/authorize');
    const params = { client_id: flow.clientId ?? 'dynamic_agent_client', ext_agent_host_id: flow.hostId, response_type: 'code', redirect_uri: flow.redirectUri, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', resource: RESOURCE, state: flow.state, nonce: flow.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(flow.verifier).digest('base64url') };
    if (!flow.clientId)
        params.agent_name_hint = 'YAM';
    for (const [k, v] of Object.entries(params))
        u.searchParams.set(k, v);
    return u;
}
export function verifyIdentity(token, jwks, clientId, nonce, now = Date.now) {
    try {
        if (typeof token !== 'string' || token.length > 65536)
            throw Error();
        const parts = token.split('.');
        if (parts.length !== 3)
            throw Error();
        const header = JSON.parse(Buffer.from(parts[0], 'base64url')), claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
        if (header.alg !== 'RS256' || typeof header.kid !== 'string')
            throw Error();
        const keys = (jwks?.keys ?? []).filter(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
        if (keys.length !== 1 || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key: keys[0], format: 'jwk' }), Buffer.from(parts[2], 'base64url')))
            throw Error();
        const seconds = now() / 1000, aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (claims.iss !== AUTH || !aud.includes(clientId) || aud.length > 1 && claims.azp !== clientId || !Number.isFinite(claims.exp) || claims.exp <= seconds || claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > seconds + 30) || claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > seconds + 30) || nonce !== undefined && claims.nonce !== nonce || typeof claims.sub !== 'string' || !claims.sub)
            throw Error();
        return { sub: claims.sub };
    }
    catch {
        throw failure('YAM_IDENTITY_INVALID', 'ChatGPT identity verification failed; authorization was not saved.');
    }
}
async function privateFile(path, create = false) {
    const f = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
    try {
        const s = await f.stat();
        if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())
            throw Error();
        return f;
    }
    catch {
        await f.close();
        throw failure('YAM_AUTH_STORAGE', 'YAM authorization files must be private regular files owned by this user.');
    }
}
async function readState(path) {
    let f;
    try {
        f = await privateFile(path);
        if ((await f.stat()).size > 262144)
            throw Error();
        const state = JSON.parse(await f.readFile('utf8'));
        if (state?.version !== 1 || typeof state.hostId !== 'string' || !/^urn:uuid:[a-f0-9-]{36}$/i.test(state.hostId) || state.registration && !client(state.registration.clientId))
            throw Error();
        return state;
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return null;
        throw failure('YAM_AUTH_STORAGE', 'Cannot read the private YAM authorization record.');
    }
    finally {
        await f?.close();
    }
}
async function saveState(path, state) {
    try {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0)
            throw Error();
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw failure('YAM_AUTH_STORAGE', 'Cannot replace the YAM authorization record safely.');
    }
    const temporary = path + '.' + randomUUID();
    let f;
    try {
        f = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await f.writeFile(JSON.stringify(state));
        await f.sync();
        await f.close();
        f = null;
        await rename(temporary, path);
    }
    catch {
        throw failure('YAM_AUTH_STORAGE', 'Cannot save YAM authorization. No credential details were logged.');
    }
    finally {
        await f?.close();
        await unlink(temporary).catch(() => { });
    }
}
export function createYamAuth({ root, fetch: request = globalThis.fetch, now = Date.now, lockTimeoutMs = 65000 } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0'))
        throw Error('YAM authorization directory must be absolute.');
    const path = join(root, 'auth.json');
    async function locked(signal, operation) {
        aborted(signal);
        await mkdir(root, { recursive: true, mode: 0o700 });
        const directory = await lstat(root);
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.())
            throw failure('YAM_AUTH_STORAGE', 'YAM authorization directory must be private and owned by this user.');
        let DatabaseSync;
        try {
            ({ DatabaseSync } = await import('node:sqlite'));
        }
        catch {
            throw failure('YAM_AUTH_CAPABILITY', 'YAM authorization requires Node SQLite support; choose Pi backup or update Node capabilities.');
        }
        const lockPath = join(root, 'auth-lock.db'), file = await privateFile(lockPath, true);
        await file.close();
        const db = new DatabaseSync(lockPath);
        let acquired = false;
        try {
            db.exec('PRAGMA busy_timeout=0');
            const deadline = Date.now() + lockTimeoutMs;
            while (!acquired) {
                aborted(signal);
                try {
                    db.exec('BEGIN IMMEDIATE');
                    acquired = true;
                }
                catch (e) {
                    if (!/locked|busy/i.test(e.message))
                        throw e;
                    if (Date.now() >= deadline)
                        throw failure('YAM_AUTH_BUSY', 'Another YAM authorization is running. Wait for it to finish.');
                    await delay(25);
                }
            }
            // SQLite releases the inter-process lock on crash; network rotation remains owned until saved.
            aborted(signal);
            return await operation(await readState(path), state => saveState(path, state));
        }
        finally {
            try {
                if (acquired)
                    db.exec('ROLLBACK');
            }
            finally {
                db.close();
            }
        }
    }
    async function json(url, init = {}) {
        if (new URL(url).origin !== AUTH)
            throw failure('YAM_AUTH_ENDPOINT', 'ChatGPT authentication endpoint rejected.');
        let response;
        try {
            response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(30000), ...init.signal ? [init.signal] : []]) });
        }
        catch {
            if (init.signal?.aborted)
                throw init.signal.reason;
            throw failure('YAM_AUTH_NETWORK', 'YAM ChatGPT authentication could not connect; check the system proxy.');
        }
        if (!response.ok) {
            let code;
            try {
                code = (await response.json()).error;
            }
            catch { }
            if (['invalid_grant', 'invalid_token'].includes(code))
                throw required();
            throw failure('YAM_AUTH_NETWORK', `YAM ChatGPT authentication failed (${response.status}); check authorization and the system proxy.`);
        }
        const body = await response.text();
        if (body.length > 262144)
            throw failure('YAM_AUTH_RESPONSE', 'Invalid ChatGPT authentication response.');
        try {
            return JSON.parse(body);
        }
        catch {
            throw failure('YAM_AUTH_RESPONSE', 'Invalid ChatGPT authentication response.');
        }
    }
    async function keys(signal) { const metadata = await json(AUTH + '/.well-known/openid-configuration', { signal }); if (metadata.issuer !== AUTH || new URL(metadata.jwks_uri).origin !== AUTH)
        throw failure('YAM_IDENTITY_INVALID', 'ChatGPT identity configuration is invalid.'); return json(metadata.jwks_uri, { signal }); }
    function credential(data, registration, previous) {
        const scopes = typeof data.scope === 'string' ? data.scope.trim().split(/\s+/) : previous?.scopes;
        if (!scopes?.includes('chatgpt.tokens.use.direct') || !scopes.includes('resource.invoke'))
            throw failure('YAM_PLAN_PERMISSION', 'ChatGPT plan usage was not granted. Authorize YAM in ChatGPT before retrying.');
        if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.earliest_refresh_at !== undefined && (!Number.isFinite(data.earliest_refresh_at) || data.earliest_refresh_at < 0))
            throw failure('YAM_AUTH_RESPONSE', 'Invalid ChatGPT token response.');
        return { type: 'oauth', clientId: registration.clientId, identity: registration.identity, access: data.access_token, refresh: data.refresh_token, expires: now() + data.expires_in * 1000, idToken: data.id_token ?? previous?.idToken, scopes, earliestRefreshAt: data.earliest_refresh_at ?? 0 };
    }
    function publicCredential(c) { return { type: 'oauth', access: c.access, expires: c.expires, clientId: c.clientId, scopes: c.scopes }; }
    async function read({ signal } = {}) {
        return locked(signal, async (state, save) => {
            let c = state?.credential;
            if (!c || !state.registration || c.clientId !== state.registration.clientId || !c.access || !c.refresh || !Number.isFinite(c.expires) || !c.scopes?.includes('chatgpt.tokens.use.direct'))
                throw required();
            if (c.expires <= now() + 60000) {
                if (c.earliestRefreshAt > now() / 1000) {
                    if (c.expires <= now())
                        throw failure('YAM_REFRESH_NOT_READY', 'ChatGPT refresh is not yet available; retry after the allowed refresh time.');
                }
                else {
                    // Resolve verification keys before consuming a rotating refresh token.
                    const jwks = await keys();
                    const data = await json(AUTH + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh, resource: RESOURCE }) });
                    if (data.id_token) {
                        const identity = verifyIdentity(data.id_token, jwks, c.clientId, undefined, now);
                        if (identity.sub !== state.registration.identity?.sub)
                            throw failure('YAM_IDENTITY_INVALID', 'Refreshed ChatGPT identity changed; reconnect YAM.');
                    }
                    c = credential(data, state.registration, c);
                    state.credential = c;
                    await save(state);
                }
            }
            return publicCredential(c);
        });
    }
    async function login({ signal, onAuth, timeoutMs = 600000 } = {}) {
        return locked(signal, async (state, save) => {
            state ??= { version: 1, hostId: 'urn:uuid:' + randomUUID() };
            await save(state);
            aborted(signal);
            const jwks = await keys(signal);
            aborted(signal);
            const flow = { clientId: state.registration?.clientId ?? null, hostId: state.hostId, state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url') };
            let listener, timer, cancel;
            let callback;
            try {
                callback = await new Promise((resolve, reject) => {
                    cancel = () => reject(signal?.reason ?? new DOMException('Authorization cancelled', 'AbortError'));
                    listener = createServer(async (req, res) => {
                        const u = new URL(req.url, 'http://127.0.0.1');
                        res.setHeader('Cache-Control', 'no-store');
                        res.setHeader('Referrer-Policy', 'no-referrer');
                        if (u.pathname === '/') {
                            res.setHeader('Content-Type', 'text/html; charset=utf-8');
                            res.end('<!doctype html><meta charset="utf-8"><title>YAM · ChatGPT</title><h1>YAM</h1><p><a href="/authorize">Continue with ChatGPT</a></p><p>Authorize YAM to use your ChatGPT plan.</p><a href="https://chatgpt.com/settings/usage">Manage usage</a>');
                            return;
                        }
                        if (u.pathname === '/authorize') {
                            res.writeHead(302, { Location: authorizationUrl(flow).href });
                            res.end();
                            return;
                        }
                        if (req.method !== 'GET' || u.pathname !== '/auth/callback' || !same(u.searchParams.get('state'), flow.state)) {
                            res.writeHead(400);
                            res.end('Invalid authorization callback.');
                            return;
                        }
                        if (u.searchParams.has('error')) {
                            res.writeHead(400);
                            res.end('Authorization declined.');
                            reject(failure('YAM_AUTH_REQUIRED', 'YAM authorization was declined.'));
                            return;
                        }
                        const code = u.searchParams.get('code'), clientId = u.searchParams.get('client_id') ?? flow.clientId;
                        if (!code || !client(clientId) || flow.clientId && flow.clientId !== clientId) {
                            res.writeHead(400);
                            res.end('Incomplete authorization callback.');
                            return;
                        }
                        await new Promise(done => res.end('YAM received authorization. Return to the terminal to see the result.', done));
                        resolve({ code, clientId });
                    });
                    listener.on('error', () => reject(failure('YAM_AUTH_LISTENER', 'Cannot start the local YAM authorization listener.')));
                    listener.listen(0, '127.0.0.1', () => {
                        flow.redirectUri = `http://127.0.0.1:${listener.address().port}/auth/callback`;
                        timer = setTimeout(() => reject(failure('YAM_AUTH_TIMEOUT', 'YAM authorization timed out.')), timeoutMs);
                        signal?.addEventListener('abort', cancel, { once: true });
                        if (signal?.aborted) {
                            cancel();
                            return;
                        }
                        Promise.resolve().then(() => onAuth?.({ url: `http://127.0.0.1:${listener.address().port}/`, authorizeUrl: authorizationUrl(flow).href })).catch(reject);
                    });
                });
            }
            finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                listener?.closeAllConnections();
                listener?.close();
            }
            state.registration = { ...state.registration, clientId: callback.clientId };
            await save(state);
            const data = await json(AUTH + '/api/accounts/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: callback.clientId, code: callback.code, code_verifier: flow.verifier, redirect_uri: flow.redirectUri, resource: RESOURCE }) });
            const identity = verifyIdentity(data.id_token, jwks, callback.clientId, flow.nonce, now);
            if (state.registration.identity && identity.sub !== state.registration.identity.sub)
                throw failure('YAM_IDENTITY_INVALID', 'This YAM registration belongs to another ChatGPT account.');
            state.registration.identity = identity;
            state.credential = credential(data, state.registration);
            await save(state);
            return publicCredential(state.credential);
        });
    }
    return { read, login };
}
