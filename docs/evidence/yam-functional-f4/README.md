# F4 — Personal launch templates

Author: Jeff.Liu. Source/test review and documentation seal: 2026-10-04.

F4 adds explicit local template save, update, duplicate, delete, and apply actions. The current source and tests below match the reviewed repair1 source freeze. Applying a template populates the existing launch form; it does not start a session, trust project configuration, or take terminal control. Storage is localStorage plaintext on this device; prompt, custom command, and argument values are not encrypted. Actual GUI, Windows/Linux, and F7 provider/native acceptance are outside this evidence.

## Frozen source and tests

These seven hashes match the archived repair1 source/test freeze（原始文件已归档） (SHA-256 `deffdf4ee759bdcceb35dce645662162479bea36111e6e2898d3763e47186a1e`):

| Repository path | SHA-256 |
|---|---|
| `apps/desktop/src/launch-templates.ts` | `a8f1d99340976051d3e6348c6060fcef121a21243ca4d22709481af48633fc1b` |
| `apps/desktop/src/LaunchTemplates.tsx` | `9766582a09e054d6fc07690c14f6cd04f5171b9758f9d6a1e42ee798e33e579d` |
| `apps/desktop/src/project-config.ts` | `beca4a75a86158d2cc5fff8dedda2c7b0b38d6266687901dd5a7adf067dcdeb3` |
| `apps/desktop/src/App.tsx` | `83142292ec55487f6e44ffc8bf839cc1456600beee0c03df4860aebeefda6f54` |
| `apps/desktop/src/App.css` | `fe6aa11689996bc31c5196c54b1bd0ed8bcba32f76ea947d90d9311491e30a2b` |
| `apps/desktop/tests/launch-templates.test.mjs` | `758a827bd8149d346a6258da6c721336cd9ba30c1c50c9d3a5cdf90bc1d48643` |
| `apps/desktop/tests/project-config.test.mjs` | `49bab9b72b2fd75d3408ff13fd2de72ac5b498aac69c6e0a60f87afc16b26b61` |

The final README and capability-matrix documentation hashes after this seal are `apps/desktop/README.md` `5d291ef55da8cbf3f76cb01d5d91737570c1dcdc8cffeca3eba5a6d1c62a63ac` and `docs/yam-capability-matrix.md` `3ebc327a7a415080e0e7a1783b580cb5cd34725e8ca42bd159cf1b2e83c5920c`.

## Validation and review

- Semantic RED: `pnpm --dir apps/desktop exec node --test tests/launch-templates.test.mjs`, exit 1; 18 tests, 15 passed and 3 failed on the new malformed-data, disclosure, and initializer behavior. Archived raw log（原始文件已归档）, SHA-256 `44add54f9292548a6d2129954882e88a1d81a0201ef26cd3fd371712c88bd174`.
- Targeted tests: `pnpm --dir apps/desktop exec node --test tests/launch-templates.test.mjs tests/project-config.test.mjs`, 37/37 passed. Archived raw log（原始文件已归档）, SHA-256 `6f15d384a7e3a550c61800480a52ca0a76912a9c7fc91033ff6057aef25dc00c`.
- Full desktop Node coverage: `pnpm --dir apps/desktop test:coverage`, 423/423 passed; aggregate lines 99.77%, branches 92.34%, functions 97.32%. Archived raw log（原始文件已归档）, SHA-256 `509654e69818705ba5136d2589c63c49116a9623ba3c72316f05581c32110d76`.
- Frontend build: `pnpm --dir apps/desktop build`, exit 0. Archived raw log（原始文件已归档）, SHA-256 `b853d1860008a04e453a20f1c7a3ddd662fc82f872753e6be164736240c87537`; the build reports the existing Vite large-chunk advisory.
- `git diff --check`, exit 0. Archived empty output（原始文件已归档）, SHA-256 `01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b`.
- Independent source reviews: Root first-candidate review（原始文件已归档）, SHA-256 `ee567762f82ff68c58d5f3ee92a9717751566606bb2923df5c1f54cd86f43fde`; Root repair1 review（原始文件已归档）, SHA-256 `b15fe021eee191b549313dde2cb7445052dd343d40eb345ae1e25afcbe027350`; Astra repair1 review（原始文件已归档）, SHA-256 `7a9d7f244374e10826081491d58d193f07184fa5cf9fa4e3fa76fb56a6ead3bd`. The first candidate required changes; both repair1 reviews passed and closed F4-R1, F4-R2, and F4-R3.
- Source/test freeze diff（原始文件已归档）, SHA-256 `86b4aafff862f438c804b39b2496fff6d7906f86cc4f00f9adbedfb6ae86795b`.

The archived patch has four actual repair1 source/test paths: `launch-templates.ts`, `LaunchTemplates.tsx`, `App.tsx`, and `tests/launch-templates.test.mjs`. Its trailing README and capability-matrix `/dev/null` snapshots are present because those documents were absent from the earlier source-only freeze inputs; they are not repair1 documentation changes. Use the final documentation hashes in the evidence index as the documentation baseline. The archived patch bytes remain unchanged.

The initial pre-repair attempt produced only tool output, not a preserved raw log. A separate early harness `SyntaxError` was not semantic evidence and is not included or counted. The archived semantic RED above is the actual production-module/component/App failure log.

The App/component checks exercise actual extracted callbacks/rendering with synthetic storage, terminals, and owner calls. They are not native GUI operation. No Cargo/native build or platform acceptance is claimed.

The evidence index（原始文件已归档） maps the reviewed source, documentation, and archived artifacts to their SHA-256 digests.

> 原始开发证据已移至仓库外；保留文字结论不等于当前版本重新验收。参见[归档规则](../../development-artifacts.md)。
