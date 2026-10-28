# T18 selected-byte boundary review

Author: Jeff.Liu

Source snapshot: first candidate `ea4905`, freeze `b57` (Root-provided labels; no later source reread).

Scope: read-only inspection of `scripts/third_party_notices.py` archive and `validate` byte-budget ordering. Tests used bounded synthetic archives in temporary directories and temporarily reduced module constants. No repository files were written; no real archives, network, package-manager, build, SEA, signing, or native actions were used.

## Reproduction

- Cargo archive: five 65,536-byte selected LICENSE members (327,680 selected bytes) plus `Cargo.toml` in a gzip tar of 767 bytes. Each member was below the mocked 128 KiB per-body cap; mocked cumulative `SELECTED_LIMIT` was 100 KiB. `archive_record` returned all 327,680 selected text bytes before cumulative accounting.
- npm archive: five selected LICENSE members totaling 327825 bytes in a gzip tar of 883 bytes, again exceeding mocked 100 KiB total while each member remained below 128 KiB. `npm_archive_record` returned the full selected set before cumulative accounting.
- Validator: with mocked `SELECTED_LIMIT=5`, eight references to the same four-byte body caused eight `validate_body` reads (32 bytes total) before `validate` raised `Invalid notice evidence`.

## Source ordering

`archive_record` and `npm_archive_record` first gather selected member bytes into per-archive dictionaries and records. `collect` invokes those functions for all cargo/npm records before `make_manifest`. `make_manifest` checks cumulative bytes only while later consuming already-materialized records. `validate` reads each descriptor via `validate_body`, increments the total after each return, then compares the total with the budget only after all descriptors have been processed.

## Conclusion

The cumulative 128 MiB limit is a post-materialization/post-read acceptance check, not a bound on selected bytes read into memory. A compressed archive with many individually legal selected members can exceed the cumulative cap before rejection; repeated manifest references likewise cause all referenced bytes to be reread before rejection. This conclusion is limited to the archive/manifest byte-budget boundary.
