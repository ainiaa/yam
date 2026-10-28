# Rust updater SDK provisioning

Author: Jeff.Liu

The approved SDK-only stage declares `tauri-plugin-updater = "2"` for macOS,
Windows and Linux desktop targets. Cargo resolved version **2.13.1** into the
existing lockfile. There is no JavaScript updater dependency.

This stage does not register the plugin, grant updater permissions, configure a
public key or endpoint, check for updates, install an update, or create signing
keys. Application startup and owner code are unchanged. The dependency graph is
available for a later, separately configured implementation.

Configuration tests passed5/5; host Rust402passed/2ignored and Python85passed,
with fmt, locked clippy and diff checks passing. Root and Astra independently
passed5/5 with the three frozen hashes matching; Astra also verified the locked
offline dependency graph. These are separate host checks, not native update
acceptance or official provider gates.

The metadata address, verification key and key-holder arrangement, supported
distribution formats, service deployment, signing and publication remain
pending. Host compilation and automated configuration checks do not establish
Windows/Linux packaged behavior or native update installation. This is partial
SDK provisioning, not completion of the full T20 updater feature.

After the one Cargo resolution, verification uses the committed graph:

```sh
rtk proxy python3 -m unittest discover -s scripts -p test_updater_dependency.py
rtk proxy cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -- --test-threads=1
rtk proxy cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

The [SDK evidence](evidence/yam-updater-sdk-t20/README.md) separates actual test
results, independent review, resolved dependency checksums and remaining native
acceptance. No frozen T06 package or data is used.
