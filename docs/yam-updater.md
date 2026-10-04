# GUI updater source boundary

Author: Jeff.Liu

YAM exposes **Updates** in the normal window. It shows the running version,
configuration status, a persisted automatic-check preference, and finite
check/download/cancel states. The existing locked Rust SDK is
`tauri-plugin-updater` **2.13.1**; there is no JavaScript updater dependency.
The earlier [SDK-only evidence](evidence/yam-updater-sdk-t20/README.md) remains
historical. This source slice adds conditional GUI registration and commands.

The current configuration has no updater block. This is a normal unconfigured
state: no plugin registration, updater extension lookup or network check occurs.
Activation requires an exact supplied configuration with `pubkey`, one to four
HTTPS `endpoints`, `requireSignedVersion=true`, and `allowDowngrades=false`.
Unknown keys, insecure URLs, credentials/fragments, oversized values, and
unsupported platform/package contexts refuse activation. A structurally supplied
key is not cryptographic validation. Deployment configuration is still deferred;
no example endpoint/key is installed in application configuration.

Automatic checks default enabled, but the exact versioned localStorage record
stores only one boolean. It is read before the once-only configured GUI startup
check. Opt-out and missing configuration make no SDK check. Malformed/unavailable
storage disables automatic checking with a fixed warning. Reopening settings or
React effect replay does not repeat startup checking. There is no owner timer,
automatic download or automatic installation.

The GUI controller admits one operation and keeps SDK candidates and artifact
bytes private. Status uses bounded versions/plain notes, finite reasons,
generations and observed progress, with no endpoint/key/signature/raw manifest,
headers, local paths or raw SDK error. Metadata and artifact redirects use an
HTTPS-only SDK client. Check and download acceptance deadlines are15s/120s;
downloads explicitly set the SDK Update timeout. At expiry or cancellation,
publication is fenced and the exact worker is aborted and joined. Cancelling
remains visible until join; synchronous signature work can delay that join.
These are acceptance/cancellation deadlines, not guaranteed physical deadlines.
GUI exit performs this cleanup before the detached background-client return.

Declared or observed artifact bytes above256MiB refuse verification, including
unknown/dishonest totals. This is an observed accepted-byte limit, not a hard
heap/network allocation cap. Transfer completion alone never means verified;
only SDK download success after signature and signed-version validation reaches
that state. Injected successful test adapters validate boundary mapping only.
**Install always refuses**, including forged direct commands and a verified
artifact. No installer, restart or installation-driven exit is called.

The deployment feed, verification key/key custody, release formats, signing,
publication, native SDK network/signature tests, and installation compatibility,
backup and owner/parser coordination remain pending. No real GUI/owner/Agent,
update request/download/install, permission flow, signing key or publication was
performed in this source task. Independent source reviews and executable host
checks are distinct from official provider/native acceptance.

Settings reopened while an older status RPC is pending retain at most one
500ms retry timer until a fresh status can be read;
RPCs stay single-flight, old replies remain fenced, and idle completion stops
polling. Closing/unmounting cancels UI retries without installing anything.

See [current source evidence](evidence/yam-updater-t20/README.md) for exact red,
green, frozen hashes, checks and remaining acceptance.
