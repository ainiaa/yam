"""Author: Jeff.Liu. Bounded offline notice integrity; mechanical availability, not legal approval."""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
import tempfile
import threading
import time
import tomllib

LOCK_LIMIT = 16 * 1024 * 1024
BODY_LIMIT = 8 * 1024 * 1024
SELECTED_LIMIT = 128 * 1024 * 1024
ARCHIVE_LIMIT = 256 * 1024 * 1024
HEADER_LIMIT = 20000
IDENTITY_LIMIT = 4096
SCHEMA = 1
NODE_BODY_SHA256 = '6b85ee1983d01fa2cdcdd5d1a3053c6221fae41d6a54e43b416bf35969fc4128'
# Full inventory and source/body qualifications reviewed in third-party-notices/qualification-review.json.
# Collection never updates this approval; future material changes require separate review.
APPROVED_MANIFEST_SHA256 = "f9a7ded31a5287ff792373a9942211dd0908a0f3dbe3aaf465ca2311e837344c"
NPM_EXPECTED = [{'checksum': 'sha512-fUSxFX8VABYe9W9K5ROdEaKVkNUFRcMSRofjruvaxztXA+I0XnQHcYHF8m/a6iExRUxsUf0HsFWhPBuH9IgzJw==', 'name': '@tauri-apps/api', 'source': 'https://registry.npmjs.org/@tauri-apps/api/-/api-2.12.0.tgz', 'version': '2.12.0'}, {'checksum': 'sha512-yomIOIoiiDwXW3Bgy/V5c4frWo9sfWM9WZQew2s7vr7hXtDdbLDCLzvytIMCjMxbnln9O0oJsTI3XdDd2T9XlA==', 'name': '@tauri-apps/plugin-deep-link', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-deep-link/-/plugin-deep-link-2.6.1.tgz', 'version': '2.6.1'}, {'checksum': 'sha512-/DtE3B62JgpYuWFL5ATXM6KOXUq7pca7cJWOgSqULhZsgyjLk0PWKek1dbRDvhNBW6flNsOfWphsKnb+738Dmw==', 'name': '@tauri-apps/plugin-dialog', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-dialog/-/plugin-dialog-2.8.1.tgz', 'version': '2.8.1'}, {'checksum': 'sha512-mBorYfVKh9Lt7s4ZFtKbMUTxBw+Y/sVmSlKCtkkoBgMTC/DIbt/kaPm67L/2djAUqDI1wbixy5OHHVmipjuGMw==', 'name': '@tauri-apps/plugin-opener', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-opener/-/plugin-opener-2.7.0.tgz', 'version': '2.7.0'}, {'checksum': 'sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g==', 'name': '@xterm/addon-fit', 'source': 'https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz', 'version': '0.11.0'}, {'checksum': 'sha512-uteyTU1EkrQa2Ux6P/uFl2fzmXI46jy5uoQMKEOM0fKTyiW7cSn0WrFenHm5vO5uEXX/GpwW/FgILvv3r0WbkA==', 'name': '@xterm/addon-serialize', 'source': 'https://registry.npmjs.org/@xterm/addon-serialize/-/addon-serialize-0.14.0.tgz', 'version': '0.14.0'}, {'checksum': 'sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw==', 'name': '@xterm/headless', 'source': 'https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz', 'version': '6.0.0'}, {'checksum': 'sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg==', 'name': '@xterm/xterm', 'source': 'https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz', 'version': '6.0.0'}, {'checksum': 'sha512-6koYRhnM2N0GGZIdXzSeiNwguv1gt/FAjZOiPl76roBi3xKEXa4WmfpxgQwTTL4KipXjefrnf3oV4IsYhi4JFA==', 'name': 'lucide-react', 'source': 'https://registry.npmjs.org/lucide-react/-/lucide-react-0.468.0.tgz', 'version': '0.468.0'}, {'checksum': 'sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog==', 'name': 'react', 'source': 'https://registry.npmjs.org/react/-/react-19.3.0.tgz', 'version': '19.3.0'}, {'checksum': 'sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q==', 'name': 'react-dom', 'source': 'https://registry.npmjs.org/react-dom/-/react-dom-19.3.0.tgz', 'version': '19.3.0'}, {'checksum': 'sha512-juorfCmIkIw8tT+p5BXSm6PJjQF/ycEYmKyzURCIt/RaZIhL+PulbQ9Yu2z1HdOJDdqDTlxA1+xKBmHXJsczAw==', 'name': 'scheduler', 'source': 'https://registry.npmjs.org/scheduler/-/scheduler-0.28.0.tgz', 'version': '0.28.0'}, {'checksum': 'sha512-9OeuBFu0/uZJPu+9AHKY6g/w0Czyb/Ut0A5t79I4ULoU4IfU5BEpPFVGQxP4zTTMdfZEYkVIRYbHBX1xWwjeSA==', 'name': '@xterm/addon-search', 'source': 'https://registry.npmjs.org/@xterm/addon-search/-/addon-search-0.16.0.tgz', 'version': '0.16.0'}, {'name': '@babel/runtime', 'version': '7.29.10', 'source': 'https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.10.tgz', 'checksum': 'sha512-NpugTzbKgGrNe45Ui32cN8vCFFMxVtP/9rtfwv0nP5FRDAjvYBxJcLVpYA9mr1jxP6cnIT7x9LUzuDTbWYYNRA=='}, {'name': 'html-parse-stringify', 'version': '4.0.1', 'source': 'https://registry.npmjs.org/html-parse-stringify/-/html-parse-stringify-4.0.1.tgz', 'checksum': 'sha512-0zHsZJrK7S3K2aucXWL6ycoYJ/iNtIcFHC/nYQgFklPtrv5LpJctIiSCroWZWeuoXvuyFdzp6KzjJQ+OT5MfFw=='}, {'name': 'i18next', 'version': '26.5.3', 'source': 'https://registry.npmjs.org/i18next/-/i18next-26.5.3.tgz', 'checksum': 'sha512-6pRwOwJ6lBCBB66fqNZaSoUmvsALHMord7FL6GsDhubT1CrPabTMEJIqddm0nn2YEbKofdI/3VAtGrQPuztY1Q=='}, {'name': 'react-i18next', 'version': '17.1.0', 'source': 'https://registry.npmjs.org/react-i18next/-/react-i18next-17.1.0.tgz', 'checksum': 'sha512-4VouOnTDyvhvqXx6WZ+s3/cgSiaLutILdYkO3P1Ms+4qcKR7At+JP4Vi7IeHkVLyVV+DmN1l23Pn73UcwSGGPA=='}, {'name': 'typescript', 'version': '6.0.3', 'source': 'https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz', 'checksum': 'sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw=='}, {'name': 'use-sync-external-store', 'version': '1.7.0', 'source': 'https://registry.npmjs.org/use-sync-external-store/-/use-sync-external-store-1.7.0.tgz', 'checksum': 'sha512-6L+EeigHMQhdaIPNIFUKwfWJSwWFQ8gJbJ2DLOs5sDIegTwR9fRxvnM3uciHKjIZhFz+KAv2emhWMRvDmMcY8A=='}]

NPM_INPUTS = {'pnpm_lock': '01b56b4dc19d6c001665e6190bc3d1f40d68e85c8c00e12407b68d61fa86b4f1', 'declarations': 'f101de8351b12ab5d85c06559afee28dc987971814f44a3177750bc5f6c2acb4'}
# Exact identity/checksum/body qualifications from reviewed immutable preparation.
# Remaining candidate filenames and SPDX declarations do not qualify.
QUALIFIED_BODIES = {('cargo', 'adler2', '2.0.1', '320119579fcad9c21884f5c4861d16174d0e06250625266f50fe6898340abefa'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                    '861399f8c21c042b110517e76dc6b63a2b334276c8cf17412fc3c8908ca8dc17',
                                                                                                    '8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb'},
 ('cargo', 'aho-corasick', '1.1.5', 'c982642fa9e8606056828ee9a8505737230110bb1099153c79efe865c59d12ba'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'alloc-no-stdlib', '3.0.0', 'c2fb6cfd47bf496ff64095c20eaba0c201404ee38714d4142fcfa1dc334fcc7a'): {'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae'},
 ('cargo', 'alloc-stdlib', '0.3.0', '0b5c1865780388bfa186411ab5f247819487fc4864c6e9c3106611fa347586e1'): {'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae'},
 ('cargo', 'android_system_properties', '0.1.6', 'ae221649c9976a6f6c56ae1facf410f3ddb33cc661c4b7b61020a912d4237fbc'): {'80f275e90d799911ed3830a7f242a2ef5a4ade2092fe0aa07bfb2d2cf2f2b95e'},
 ('cargo', 'anyhow', '1.0.104', '330a5ed07fa54e4702c9d6c4174f74427fc0ef6e214bbd677ae50a5099946470'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'arbitrary', '1.4.2', 'c3d036a3c4ab069c7b410a2ce876bd74808d2d0888a82667669f8e783a898bf1'): {'15656cc11a8331f28c0986b8ab97220d3e76f98e60ed388b5ffad37dfac4710c',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-broadcast', '0.7.2', '435a87a52755b8f27fcf321ac4f04b2802e337c8c4872923137471ec39c37532'): {'24e5860bf589d8501643e6ea51ffb3df66db2867492b09033d486183efbfa970',
                                                                                                             'e4705ddab847449a2cdcb3c88b005ea10330aa249d9148ca2eef9c84c5d29895'},
 ('cargo', 'async-channel', '2.5.0', '924ed96dd52d1b75e9c1a3e6275715fd320f5f9439fb5a4a11fa51f4221158d2'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-executor', '1.14.0', 'c96bf972d85afc50bf5ab8fe2d54d1586b4e0b46c97c50a0c9e71e2f7bcd812a'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                             'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-io', '2.6.0', '456b8a8feb6f42d237746d4b3e9a178494627745c3c56c6ea55d92ba50d026fc'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-lock', '3.4.2', '290f7f2596bd5b78a9fec8088ccd89180d7f9f55b94b0576823bbbdc72ee8311'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-process', '2.5.0', 'fc50921ec0055cdd8a16de48773bfeec5c972598674347252c0399676be7da75'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-recursion', '1.1.1', '3b43422f69d8ff38f95f1b2bb76517c91589a924d1559a0e935d7c8ce0274c11'): {'30fefc3a7d6a0041541858293bcbea2dde4caa4c0a5802f996a7f7e8c0085652',
                                                                                                             '769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb'},
 ('cargo', 'async-signal', '0.2.14', '52b5aaafa020cf5053a01f2a60e8ff5dccf550f0f77ec54a4e47285ac2bab485'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-task', '4.7.1', '8b75356056920673b02621b35afd0f7dda9306d03c79a30f5c56c44cf256e3de'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'async-trait', '0.1.92', '82f6aeea286b8eb4dd3431a1be1b59d290ace00f5bfd8e2a159bc2a05e2c1667'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'atk', '0.18.2', '241b621213072e993be4f6f3a9e4b45f65b7e6faad43001be957184b7bb1824b'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'atk-sys', '0.18.2', 'c5e48b684b0ca77d2bbadeef17424c2ea3c897d44d566a1617e7e8f30614d086'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'atomic-waker', '1.1.2', '1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'autocfg', '1.5.1', 'f2032f911046de80f0a198e0901378627c33f59ea0ac00e363d481118bd70a53'): {'27995d58ad5c1145c1a8cd86244ce844886958a35eb2b78c6b772748669999ac',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'base64', '0.21.7', '9d297deb1925b89f2ccc13d7635fa0714f12c87adce1c75356b39ca9b7178567'): {'0dd882e53de11566d50f8e8e2d5a651bcf3fabee4987d70f306233cf39094ba7',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'base64', '0.22.1', '72b3254f16251a8381aa12e40e3c4d2f0199f8c6508fbecb9d91f575e0fbb8c6'): {'0dd882e53de11566d50f8e8e2d5a651bcf3fabee4987d70f306233cf39094ba7',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'base64', '0.23.1', 'ac07cdecf99051d9a5238b80f35af32cdeba5b336e55d957b318b50137e18da5'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                     'ab499c75a0f0da8e0fe83bf9ba3a27e5c39705310f07107c6c66b69958d2401c'},
 ('cargo', 'bit-set', '0.8.0', '08807e080ed7f9d5433fa9b275196cfc35414f66a0c79d864dc51a0d825231a3'): {'8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90',
                                                                                                     'f51ac2c59a222f7476ce507ca879960e2b64ea64bb2786eefdbeb7b0b538d1b7'},
 ('cargo', 'bit-vec', '0.8.0', '5e764a1d40d510daf35e07be9eb06e75770908c27d411ee6c92109c9840eaaf7'): {'8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90',
                                                                                                     'f51ac2c59a222f7476ce507ca879960e2b64ea64bb2786eefdbeb7b0b538d1b7'},
 ('cargo', 'bitflags', '1.3.2', 'bef38d45163c2f1dde094a7dfd33ccf595c92905c8f8f4fdc18d06fb1037718a'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'bitflags', '2.13.2', '3ded4057c258ba199e2d26386d3af3780957ecaee6c4ef4041c6b4b8b97c0b06'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'block-buffer', '0.10.4', '3078c7629b62d3f0439517fa394996acacc5cbc91c5a20d8c658e77abd503a71'): {'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5',
                                                                                                           'd5c22aa3118d240e877ad41c5d9fa232f9c77d757d4aac0c2f943afc0a95e0ef'},
 ('cargo', 'block2', '0.6.2', 'cdeb9d870516001442e364c5220d3574d2da8dc765554b4a617230d33fa58ef5'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'blocking', '1.7.0', 'a70e4329df6cb94385eed412ec92375c3cdd8a6e502493d1229b6414e4036dfa'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'brotli', '9.0.0', 'f8b851b75c23ca7873623d612fe49bd1989aeb03d08fb9432187eb253d3d4c6b'): {'3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94',
                                                                                                    'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae'},
 ('cargo', 'brotli-decompressor', '6.0.1', '941cd9bd4ddab83cb46fa5a2d428f1c857b24ac78cb876cf7beb710840934bd7'): {'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae'},
 ('cargo', 'bs58', '0.5.1', 'bf88ba1141d185c399bee5288d850d63b8369520c1eafc32a0430b5b6c287bf4'): {'42d3bf7e7d4d49d72c0555d14ed99c3ee7ce9ce3cbffbc38bbafe8c103f50969',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'bumpalo', '3.20.3', '72f5acc6cb2ba439de613abc23857ec3d78374d8ed5ac84e9d11336e87da8649'): {'65f94e99ddaf4f5d1782a6dae23f35d4293a9a01444a13135a6887017d353cee',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'bytemuck', '1.25.2', '95832e849adfb21180ccb6826a99da14e5d266ae5c2e668e1602cf234f153797'): {'84b34dd7608f7fb9b17bd588a6bf392bf7de504e2716f024a77d89f1b145a151',
                                                                                                       '9df9ba60a11af705f2e451b53762686e615d86f76b169cf075c3237730dbd7e2',
                                                                                                       'e3ba223bb1423f0aad8c3dfce0fe3148db48926d41e6fbc3afbbf5ff9e1c89cb'},
 ('cargo', 'byteorder', '1.5.0', '1fd0f2584146f6f2ef48085050886acf353beff7305ebd1ae69500e27c67f64b'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'bytes', '1.12.1', 'fc652a48c352aef3ea3aed32080501cf3ef6ed5da78602a020c991775b0aff04'): {'45f522cacecb1023856e46df79ca625dfc550c94910078bd8aec6e02880b3d42'},
 ('cargo', 'cairo-rs', '0.18.5', '8ca26ef0159422fb77631dc9d17b102f253b876fe1586b03b803e63a309b4ee2'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'cairo-sys-rs', '0.18.2', '685c9fa8e590b8b3d678873528d83411db17242a73fccaed827770ea0fedda51'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'camino', '1.2.6', 'bbbad30e4b4c14a39e3cc8aed085a12a327257c316619c93581e017bc52be591'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'cargo-platform', '0.1.9', 'e35af189006b9c0f00a064685c727031e3ed2d8020f7ba284d78cc2671bd36ea'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb'},
 ('cargo', 'cargo_metadata', '0.19.2', 'dd5eb614ed4c27c5d706420e4320fbe3216ab31fa1c33cd8246ac36dae4479ba'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'cargo_toml', '1.0.1', '82f4b26e751e711a5302649417f2da046dce6391b2ea30a4820f37462314f0b9'): {'ee874098519e956c23a3c5c7e20581f8e9b1d70aa05eb178f983be9775090a2f'},
 ('cargo', 'cc', '1.5.1', 'f360145194ee8e21db5ee7f3fcd4fe52210864c75c985dae33218202c8bbe040'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'cesu8', '1.1.0', '6d43a04d8753f35258c91f8ec639f792891f748a1edbd759cf1dcea3382ad83c'): {'5ca77347e58205d3b543c04a9c5bdd11d20a9f3108a7b246640edffa999b5f35'},
 ('cargo', 'cfb', '0.14.0', 'a347dcabdae9c31b0825fd6a8bed285ec9c2acb89c47827126d52fa4f59cece3'): {'ebaac853b53fec0ed475796f533ce676912a4df9ad9d8a621fa76d5060591e10'},
 ('cargo', 'cfg-expr', '0.15.8', 'd067ad48b8650848b989a59a86c6c36a995d02d2bf778d45c3c5d57bc2718f02'): {'090a294a492ab2f41388252312a65cf2f0e423330b721a68c6665ac64766753b',
                                                                                                       '8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90'},
 ('cargo', 'cfg-if', '1.0.5', '4e7648175b45a9a48536d676f68d918270699102aa8dab5496df06904c914600'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'cfg_aliases', '0.1.1', 'fd16c4719339c4530435d38e511904438d07cce7950afa3718a84ac36c10e89e'): {'1e2b7ade3fb228130408b9990cae6a7618eb314c75aa0b164bfe485d9d9756ee',
                                                                                                         '31b94860253d8ec7b4529f51901044d3b459d6292d996504a36b1bae3a36a812'},
 ('cargo', 'chrono', '0.4.45', '1aa79e62e7697b8e29b513a68abacf485adcd1fe8284a4316c5ae868e6633327'): {'946c9835d8034d24404f8cfec5f4654cee5dad17e944afc3d06d742cf2882831'},
 ('cargo', 'combine', '4.6.8', 'cfc320937d09e6de266b31b9afb480f197d7a861be86be7cb2ea7e5d1bfffc5e'): {'9bbc1b3dc4674a9ebb12c2a62f54fe3c08672539717f8d05828f684b6cc419a3'},
 ('cargo', 'concurrent-queue', '2.5.0', '4ca0197aee26d1ae37445ee532fefce43251d24cc7c166799f4d46817f1d3973'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                              'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'const-random', '0.1.18', '87e00182fe74b066627d63b85fd550ac2998d4b0bd86bfed477a0ae4c7c71359'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                           'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'},
 ('cargo', 'const-random-macro', '0.1.16', 'f9d839f2a20b0aee515dc581a6172f2321f96cab76c1a38a4c584a194955390e'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                                 'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'},
 ('cargo', 'cookie', '0.18.2', '1a373e3602691c3cdea496d2f0ee5935151e6168fe87739483c463db1b2f2f87'): {'2773e20df8f4c52a026b5b578c7f2457341f5aa3fb6612fd87e1d2e1bd8f48ad',
                                                                                                     'f28420c1906af38be726cd7842798f0194b27c41d6051c0d1e9ee348b8a4a0ea'},
 ('cargo', 'core-foundation', '0.10.1', 'b2a6cd9ae233e7f62ba4e9353e81a88df7fc8a5987b8d445b4d90c879bd156f6'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                              'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'core-foundation', '0.9.4', '91e195e091a93c46f7102ec7818a2aa394e1e1771c3ab4825963fa03e45afb8f'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                             'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'core-foundation-sys', '0.8.7', '773648b94d0e5d620f64f280777445740e61fe701025087ec8b57f45c791888b'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                                 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'core-graphics', '0.25.0', '064badf302c3194842cf2c5d61f56cc88e54a759313879cdf03abdd27d0c3b97'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'core-graphics-types', '0.2.0', '3d44a101f213f6c4cdc1853d4b78aef6db6bdfa3468798cc1d9912f4735013eb'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                                 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'cpufeatures', '0.2.17', '59ed5838eebb26a2bb2e58f6d5b5316989ae9d08bab10e0e6d103e656d1b0280'): {'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5',
                                                                                                          'ae9baa7beea910273c2f384c2a6b721fb7bd02bda3436074a1072e4ee689f985'},
 ('cargo', 'crc32fast', '1.5.2', '01a7799fd6b852db0e61728dde9a204c423b44d689dbd432522543614b490e78'): {'61d383b05b87d78f94d2937e2580cce47226d17823c0430fbcad09596537efcf',
                                                                                                       'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'crossbeam-channel', '0.5.17', '98b0cc327b5bc766e7fda9c9260cc0fa81b43a8e240440422dff70788e3f9ef1'): {'5734ed989dfca1f625b40281ee9f4530f91b2411ec01cb748223e7eb87e201ab',
                                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                                'b16db96b93b1d7cf7bea533f572091ec6bca3234fbe0a83038be772ff391a44c'},
 ('cargo', 'crossbeam-utils', '0.8.23', 'a31eee39dddec8330830986fcd7625edb5a24ec90ea038215273bbc3adb08ac6'): {'5734ed989dfca1f625b40281ee9f4530f91b2411ec01cb748223e7eb87e201ab',
                                                                                                              'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'crunchy', '0.2.4', '460fbee9c2c2f33933d720630a6a0bac33ba7053db5344fac858d4b8952d77d5'): {'3eab77734a181b2a2e8418af9004f960f715f04aac4d76a26cf774f63a7b13d1'},
 ('cargo', 'crypto-common', '0.1.7', '78c8292055d1c1df0cce5d180393dc8cce0abec0a7102adb6c7b1eef6016d60a'): {'3521672491a3479422d5fe1aca6645dd2984090f85da6e5205abfb18fb7a6897',
                                                                                                           'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5'},
 ('cargo', 'cssparser', '0.37.0', '8c9cdaae01d5ed7882b04d795e7f752f46ff52d2fa3b50a20d28c464510bba98'): {'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85'},
 ('cargo', 'cssparser-macros', '0.7.1', 'd045de693cb712d0b22c6a64be5b953f67b3ce00ab5ad3dd5d8b441886ab8e1a'): {'fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85'},
 ('cargo', 'ctor', '1.0.13', '914a755b7c2d4af2bdcff7ce1739e2db9a1b81a9b07123d8015786ae03c0980d'): {'a8ad31b1c3f40dca5a84119351b8fa8ddc868edd77fad8a8ebf6d8f2d16fa4ae',
                                                                                                   'bccaa8b6c09f94e81f06696e179dbe058464bbdfbc823b6d49cada1d71e84ac3'},
 ('cargo', 'darling', '0.24.1', 'ed17f5901b6630b993ca003def43f2f8ef4014fc13b047b57aad617ff32bc2ec'): {'8ea93490d74a5a1b1af3ff71d786271b3f1e5f0bea79ac16e02ec533cef040d6'},
 ('cargo', 'darling_core', '0.24.1', '6837e2cf7485aaae18f86181d2f0e9a7ed297a025e220aeabf63fdebd3a2ddff'): {'8ea93490d74a5a1b1af3ff71d786271b3f1e5f0bea79ac16e02ec533cef040d6'},
 ('cargo', 'darling_macro', '0.24.1', '2ac7135c3ef02b2f7833bbeb1be5ba7f966dcde8a87c6b87f65a778d71a02785'): {'8ea93490d74a5a1b1af3ff71d786271b3f1e5f0bea79ac16e02ec533cef040d6'},
 ('cargo', 'dbus', '0.9.12', '3ab69f03cc8c4340c9c8e315114e1658e6775a9b16a04357973aa21cec22b32e'): {'453745410e3be8cf25d56872ea2aec975a78e6c9f217443d0bf908a5bce7c8ff',
                                                                                                   'de3911c2d98c8bd2d701ee721347053d9b55995a11f9a8c955e44d3ca1b376bf'},
 ('cargo', 'defmt', '1.1.1', 'e2953bfe4f93bbd20cc71198842756f77d161884c99ebbabc41d80231ded88d1'): {'2710a622a896bba67356913d4d0492cab5465f61b2ecce6d880aeb483834fb50',
                                                                                                   '8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90'},
 ('cargo', 'defmt-macros', '1.1.1', 'bad9c72e7ca2137e0dc3813245a0d282fd6daad32fd800af018306a9169b5fe8'): {'2710a622a896bba67356913d4d0492cab5465f61b2ecce6d880aeb483834fb50',
                                                                                                          '8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90'},
 ('cargo', 'defmt-parser', '1.0.0', '10d60334b3b2e7c9d91ef8150abfb6fa4c1c39ebbcf4a81c2e346aad939fee3e'): {'2710a622a896bba67356913d4d0492cab5465f61b2ecce6d880aeb483834fb50',
                                                                                                          '8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90'},
 ('cargo', 'deranged', '0.5.8', '7cd812cc2bc1d69d4764bd80df88b4317eaef9e773c75226407d9bc0876b211c'): {'231c837c45eb53f108fb48929e488965bc4fcc14e9ea21d35f50e6b99d98685b',
                                                                                                      'edd65bdd88957a205c47d53fa499eed8865a70320f0f03f6391668cb304ea376'},
 ('cargo', 'derive_arbitrary', '1.4.2', '1e567bd82dcff979e4b03460c307b3cdc9e96fde3d73bed1496d2bc75d9dd62a'): {'15656cc11a8331f28c0986b8ab97220d3e76f98e60ed388b5ffad37dfac4710c',
                                                                                                              'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'derive_more', '2.1.1', 'd751e9e49156b02b44f9c1815bcb94b984cdcc4396ecc32521c739452808b134'): {'8a35369f3ca263b3c62fbb5032947e53b6bfebc6c8a4d1bb982de1c069f6fba5'},
 ('cargo', 'derive_more-impl', '2.1.1', '799a97264921d8623a957f6c3b9011f3b5492f557bbb7a5a19b7fa6d06ba8dcb'): {'8a35369f3ca263b3c62fbb5032947e53b6bfebc6c8a4d1bb982de1c069f6fba5'},
 ('cargo', 'digest', '0.10.7', '9ed9a281f7bc9b7576e61468ba615a66a5c8cfdff42420a70aa82701a3b1e292'): {'9e0dfd2dd4173a530e238cb6adb37aa78c34c6bc7444e0e10c1ab5d8881f63ba',
                                                                                                     'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5'},
 ('cargo', 'dirs', '7.0.0', '8d57d423b3c82e89b9a24ca3091fee61f456a26edbd28d26c65906f4bc1dcd8f'): {'6a2e0ade09a7d5f816f11566fee2b151b32235a7fad52b41d49cce96f833c1a9',
                                                                                                  'd3174ad63e721d4c9dccb8ad4320848992d314369bc46319720b5802c9153fe9'},
 ('cargo', 'dirs-sys', '0.5.0', 'e01a3366d27ee9890022452ee61b2b63a67e6f13f58900b651ff5665f0bb1fab'): {'6a2e0ade09a7d5f816f11566fee2b151b32235a7fad52b41d49cce96f833c1a9',
                                                                                                      'd3174ad63e721d4c9dccb8ad4320848992d314369bc46319720b5802c9153fe9'},
 ('cargo', 'dispatch2', '0.3.1', '1e0e367e4e7da84520dedcac1901e4da967309406d1e51017ae1abfb97adbd38'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'displaydoc', '0.2.7', 'c6232dd377dcc64799954cbd3a9bb882e9cdc1308ccd87b1c098f1fb2eaf82a8'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'dlopen2', '0.8.2', '5e2c5bd4158e66d1e215c49b837e11d62f3267b30c92f1d171c4d3105e3dc4d4'): {'39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2'},
 ('cargo', 'dlopen2_derive', '0.4.3', '0fbbb781877580993a8707ec48672673ec7b81eeba04cfd2310bd28c08e47c8f'): {'39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2'},
 ('cargo', 'dlv-list', '0.5.2', '442039f5147480ba31067cb00ada1adae6892028e40e45fc5de7b7df6dcc1b5f'): {'77adcddfe9e50acd2df63ddbb8e566bb8d34b4d02a9d92e7a5c1b9c2225eda9f',
                                                                                                      '95bd3988beee069fa2848f648dab43cc6e0b2add2ad6bcb17360caf749802bcc'},
 ('cargo', 'dom_query', '0.28.0', 'fac5fca71e65e94cc718a6e2af65d6e0f9c6027751c2aa562fbb5087fda639bc'): {'7554701d1e74fc434f68c522b1dd743c8c16d816a4b761b5213f367b898884c8'},
 ('cargo', 'downcast-rs', '1.2.1', '75b325c5dbd37f80359721ad39aca5a29fb04c89279657cffdda8736d0c0b9d2'): {'8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90',
                                                                                                         'fb252fecf98d9af8f1d9201c5860319a514f5a8a24700dc84fc6ea287a7a4958'},
 ('cargo', 'dpi', '0.1.2', 'd8b14ccef22fc6f5a8f4d7d768562a182c04ce9a3b3157b91390b52ddfdf1a76'): {'6dc0e068dcf3a5bc8e054205b85b7720e1d49265bbc64bf515d2cf79197df69a',
                                                                                                 '9eff396a99bafd208e7126602420d6864f6066c08b84485a5b032320a9c01997'},
 ('cargo', 'dtoa', '1.0.11', '4c3cf4824e2d5f025c7b531afcb2325364084a16806f6d47fbc1f5fbd9960590'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                   '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'dtoa-short', '0.3.5', 'cd1511a7b6a56299bd043a9c167a6d2bfb37bf84a6dfceaba651168adfb43c87'): {'1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5'},
 ('cargo', 'dunce', '1.0.5', '92773504d58c093f6de2459af4af33faa518c13451eb8f2b5698ed3d36e7c813'): {'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499'},
 ('cargo', 'dyn-clone', '1.0.20', 'd0881ea181b1df73ff77ffaaf9c7544ecc11e82fba9b5f27b262a3c73a332555'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'embed-resource', '3.0.11', 'fbfdaacccebec3b28e4866b8973543c7647797db5ada1bdab552e48fe665fbbd'): {'1abdbbd4e3f95e56c79d4a8af190254c23ddb14db34aadadfafef9c3af041113'},
 ('cargo', 'embed_plist', '1.2.2', '4ef6b89e5b37196644d8796de5268852ff179b44e96276cf4290264843743bb7'): {'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
                                                                                                         'daacc37f680c7dd0a758ac99a109f2f57d9f21d3683df9e9245055922842a695'},
 ('cargo', 'endi', '1.1.1', '66b7e2430c6dff6a955451e2cfc438f09cea1965a9d6f87f7e3b90decc014099'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'enumflags2', '0.7.12', '1027f7680c853e056ebcec683615fb6fbbc07dbaa13b4d5d9442b146ded4ecef'): {'2e3edd2716fb15616e867bd53f724f0906732242e9ae76bb1faad1d88f7eeebd',
                                                                                                         '41ba8a366e4129d0b7551f8b98211f59635b2e30c0a3c7845e828e2a7ce42064'},
 ('cargo', 'enumflags2_derive', '0.7.12', '67c78a4d8fdf9953a5c9d458f9efe940fd97a0cab0941c075a813ac594733827'): {'68d7c3ae5b131ec533fb33a9fd63753eb82fac77d7597bb5058a5af07adf9f06',
                                                                                                                'd13669f0eaff9b7015bff0d8637297213b53d9f239826636c07a15633acf7052'},
 ('cargo', 'equivalent', '1.0.2', '877a4ace8713b0bcf2a4e7eec82529c029f1d0619886d18145fea96c3ffe5c0f'): {'7365cc8878a1d7ce155a58c4ca09c3d7a6be413efa5334a80ea842912b669349',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'erased-serde', '0.4.10', 'd2add8a07dd6a8d93ff627029c51de145e12686fbc36ecb298ac22e74cf02dec'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                           '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'errno', '0.3.14', '39cab71617ae0d63f51a36d69f866391735b51691dbda63cf6f96d042b63efeb'): {'8764a597675778ddfd4e25f81b08a05dbcf089ac05662df7613fe67f150e3aa2',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'event-listener', '5.4.2', '5a23add41df1562121a9393cb065eab5146a1242410f23a644851e90cfd669d2'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'event-listener-strategy', '0.5.4', '8be9f3dfaaffdae2972880079a491a1a8bb7cbed0b8dd7a347f668b4150a3b93'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'fastrand', '2.5.0', 'da7c62ceae207dd37ea5b845da6a0696c799f85e97da1ab5b7910be3c1c80223'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'fdeflate', '0.3.7', '1e6853b52649d4ac5c0bd02320cddc5ba956bdb407c4b75a2c6b75bf51500f8c'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                      'c77a4cf9da729987d0fe7ccd811e3bd27393914ddf3d23467c18cc22954513b3'},
 ('cargo', 'field-offset', '0.3.6', '38e2275cc4e4fc009b0669731a1e5ab7ebf11f469eaede2bab9309a5b4d6057f'): {'9dd44491b4cf95dcfa2963943b3ae91bff9a78d13049a9e0b53e0d0b0a9c8f4e',
                                                                                                          'a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9'},
 ('cargo', 'filedescriptor', '0.8.3', 'e40758ed24c9b2eeb76c35fb0aebc66c626084edd827e07e1552279814c6682d'): {'191c46fcf52061382b1c51a70311eb9081381cc158e5899f3739473a9432185b'},
 ('cargo', 'filetime', '0.2.29', '5c287a33c7f0a620c38e641e7f60827713987b3c0f26e8ddc9462cc69cf75759'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'find-msvc-tools', '0.1.14', 'aedcfb3409746eddb02b9e19ebda1c3394f759a152e48ee875a0844d1b955484'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                              'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'flate2', '1.1.10', '6e634e2e0ebac1ee034020da1ca582e17ffe4e0f5e985823721e168928136dcb'): {'025436edff4cfcdde17a5811fdea78892d8482efd1abdec5a17872d07a4f2112',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'fnv', '1.0.7', '3f9eec918d3f24069decb9af1554cad7c880e2da24a9afd88aca000531ab82c1'): {'65fdb6c76cd61612070c066eec9ecdb30ee74fb27859d0d9af58b9f499fd0c3e',
                                                                                                 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'foldhash', '0.2.0', '77ce24cb58228fbb8aa041425bb1050850ac19177686ea6e0f41a70416f56fdb'): {'b1181a40b2a7b25cf66fd01481713bc1005df082c53ef73e851e55071b102744'},
 ('cargo', 'foreign-types', '0.5.0', 'd737d9aa519fb7b749cbc3b962edcf310a8dd1f4b67c91c4f83975dbdd17d965'): {'333ea3aaa3cadb819f4acd9f9153f9feee060a995ca8710f32bc5bd9a4b91734',
                                                                                                           'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'foreign-types-macros', '0.2.4', 'ea5190182e6915eb873ddbc16e23b711b6eb1f9c00a0d0a3a91b5f6228475225'): {'333ea3aaa3cadb819f4acd9f9153f9feee060a995ca8710f32bc5bd9a4b91734',
                                                                                                                  'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'foreign-types-shared', '0.3.1', 'aa9a19cbb55df58761df49b23516a86d432839add4af60fc256da840f66ed35b'): {'333ea3aaa3cadb819f4acd9f9153f9feee060a995ca8710f32bc5bd9a4b91734',
                                                                                                                  'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'form_urlencoded', '1.2.2', 'cb4cb245038516f5f85277875cdaa4f7d2c9a0fa0468de06ed190163b1581fcf'): {'20c7855c364d57ea4c97889a5e8d98470a9952dade37bd9248b9a54431670e5e',
                                                                                                             'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'futures-channel', '0.3.34', 'b1f9e3d69d39e4862ffed03ed071a76f9a13ba1d9109d355b0f0aa6b15e393c4'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                              '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-core', '0.3.34', '92d699e522242e69e3003b94ecc1f960f3a5e015aa7c5d7486e65ad01dd94f5e'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                           '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-executor', '0.3.34', '031b47cf1a3c6cc8bc2fc76cd437f521619387907d469316e7c0bc278f1f5432'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                               '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-io', '0.3.34', '53c0fa8157de1303bfffdaa1cc2a673bfffb60102f76b0ef4441659124373fed'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                         '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-lite', '2.6.1', 'f78e10609fe0e0b3f4157ffab1876319b5b0db102a2c60dc4626306dc46b44ad'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '6226d0632e2e1a80c23597e964da9812ae193c535fe058154afb034e94167aa5',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'futures-macro', '0.3.34', '9fb9654ba8355388abeb8dcb4fc62f511300867002afc858860463bdd9fe0c44'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                            '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-sink', '0.3.34', '1944426bf7d03f1d14f708785e4b33efd750b36d48a157b836b3efc15ede8e1d'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                           '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-task', '0.3.34', 'cd417de3d1d015fc3bfd2b1ea46dfc7bab72ef86f1cc7cc9c78e728b34a6d1fd'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                           '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'futures-util', '0.3.34', '0d50a92467f8ba5dd6e3ee5d4bd04d73ab2e4e1c44474a0674821dfce14b79bc'): {'275c491d6d1160553c32fd6127061d7f9606c3ea25abfad6ca3f6ed088785427',
                                                                                                           '6652c868f35dfe5e8ef636810a4e576b9d663f3a17fb0f5613ad73583e1b88fd'},
 ('cargo', 'gdk', '0.18.2', 'd9f245958c627ac99d8e529166f9823fb3b838d1d41fd2b297af3075093c2691'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdk-pixbuf', '0.18.5', '50e1f5f1b0bfb830d6ccc8066d18db35c487b1b2b1e8589b5dfe9f07e8defaec'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdk-pixbuf-sys', '0.18.0', '3f9839ea644ed9c97a34d129ad56d38a25e6756f99f3a88e15cd39c20629caf7'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdk-sys', '0.18.2', '5c2d13f38594ac1e66619e188c6d5a1adb98d11b2fcf7894fc416ad76aa2f3f7'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdkwayland-sys', '0.18.2', '140071d506d223f7572b9f09b5e155afbd77428cd5cc7af8f2694c41d98dfe69'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdkx11', '0.18.2', '3caa00e14351bebbc8183b3c36690327eb77c49abc2268dd4bd36b856db3fbfe'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gdkx11-sys', '0.18.2', '6e2e7445fe01ac26f11601db260dd8608fe172514eb63b3b5e261ea6b0f4428d'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'generic-array', '0.14.7', '85649ca51fd72272d7821adaf274ad91c288277713d9c18820d8499a7ff69e9a'): {'c09aae9d3c77b531f56351a9947bc7446511d6b025b3255312d3e3442a9a7583'},
 ('cargo', 'gethostname', '1.1.0', '1bd49230192a3797a9a4d6abe9b3eed6f7fa4c8a8a4947977c6f80025f92cbd8'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'getrandom', '0.2.17', 'ff2abc00be7fca6ebc474524697ae276ad847ad0a6b3faa4bcb027e9a4614ad0'): {'42fa16951ce7f24b5a467a40e5b449a1d41e662f97ca779864f053f39e097737',
                                                                                                        'aaff376532ea30a0cd5330b9502ad4a4c8bf769c539c87ffe78819d188a18ebf'},
 ('cargo', 'getrandom', '0.3.4', '899def5c37c4fd7b2664648c28120ecec138e4d395b459e5ca34f9cce2dd77fd'): {'29e9fe5074bd27e0e5d5d110394fbbcd841baee2651a3c4b4560a632702cede4',
                                                                                                       'aaff376532ea30a0cd5330b9502ad4a4c8bf769c539c87ffe78819d188a18ebf'},
 ('cargo', 'getrandom', '0.4.3', '300e883d756b2e4ec94e02791f39b04b522276138852cfc41d9fb7e904106099'): {'523a42c25d245dde9c015f882cec7f4555aad883382a6cf19b4b7d9b2cd5419b',
                                                                                                       'aaff376532ea30a0cd5330b9502ad4a4c8bf769c539c87ffe78819d188a18ebf'},
 ('cargo', 'gio', '0.18.4', 'd4fc8f532f87b79cbc51a79748f16a6828fb784be93145a322fa14d06d354c73'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gio-sys', '0.18.1', '37566df850baf5e4cb0dfb78af2e4b9898d817ed9263d1090a2df958c64737d2'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'glib', '0.18.5', '233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'glib-macros', '0.18.5', '0bb0228f477c0900c880fd78c8759b95c7636dbd7842707f49e132378aa2acdc'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'glib-sys', '0.18.1', '063ce2eb6a8d0ea93d2bf8ba1957e78dbab6be1c2220dd3daca57d5a9d869898'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'glob', '0.3.4', 'e4eba85ea1d0a966a983acd07deee566e67395d2d96b6fb39e62b5a833f1eb0b'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'global-hotkey', '0.8.0', '8c386b0a4a70cb2d39fffd74480f985b6f0bfbcb934b6a6b6b7e630e448f242e'): {'2ab5537b8c0cb1d475e2145b6a7994b04e7c71e6e5bd836f7f9c47c221a5ad9a',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'gobject-sys', '0.18.0', '0850127b514d1c4a4654ead6dedadb18198999985908e6ffe4436f53c785ce44'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gtk', '0.18.2', 'fd56fb197bfc42bd5d2751f4f017d44ff59fbb58140c6b49f9b3b2bdab08506a'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gtk-sys', '0.18.2', '8f29a1c21c59553eb7dd40e918be54dccd60c52b049b75119d5d96ce6b624414'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'gtk3-macros', '0.18.2', '52ff3c5b21f14f0736fed6dcfc0bfb4225ebf5725f3c0209edeec181e4d73e9d'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'hashbrown', '0.12.3', '8a9ee70c43aaf417c914396645a0fa852624801b24ebb7ae78fe8272889ac888'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                        'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'},
 ('cargo', 'hashbrown', '0.14.5', 'e5274423e17b7c9fc20b6e7e208532f9b19825d82dfd615708b70edd83df41f1'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                        'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'},
 ('cargo', 'hashbrown', '0.17.1', 'ed5909b6e89a2db4456e54cd5f673791d7eca6732202bbf2a9cc504fe2f9b84a'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                        'ff8f68cb076caf8cefe7a6430d4ac086ce6af2ca8ce2c4e5a2004d4552ef52a2'},
 ('cargo', 'heck', '0.4.1', '95505c38b4572b2d910cecb0281560f54b440a19336cbbcb27bf6ce6adc6f5a8'): {'7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'heck', '0.5.0', '2304e00983f87ffb38b55b444b5e3b60a884b5d30c0fca7d82fe33449bbe55ea'): {'7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'hermit-abi', '0.5.3', 'e17592d60ebacc7d5e169f4663c5f84f9161cc90328abcfe8456f41e4dfcb284'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'hex', '0.4.3', '7f24254aa9a54b5c858eaee2f5bccdb46aaf0e486a595ed5fd8f86ba55232a70'): {'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08',
                                                                                                 'f7bdb3426d045cd50efd4953026e3eb5a83d0199f458a075602611b9344da5b9'},
 ('cargo', 'html5ever', '0.39.0', '46a1761807faccc9a19e86944bbf40610014066306f96edcdedc2fb714bcb7b8'): {'86dd7f026f916daf7511e39951ad8ea8cf55a8db67ae64060dacf829761c18f3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'http', '1.5.0', '918d3568bebf352712bc2ef3d46a8bcf1a75b373be6539de198e9105cbbf9ce0'): {'8bb1b50b0e5c9399ae33bd35fab2769010fa6c14e8860c729a52295d84896b7a',
                                                                                                  'dc91f8200e4b2a1f9261035d4c18c33c246911a6c0f7b543d75347e61b249cff'},
 ('cargo', 'http-body', '1.1.0', 'ca2a8f2913ee65f60facd6a5905613afaa448497a0230cc41ce022d93290bc2c'): {'248378d0a3383c173fb925f17141b88e71580b3ba17ddc6ac3d2a344683232ab'},
 ('cargo', 'http-body-util', '0.1.5', '23169fe34a5fbcdd3f3862e78fb9b6fccd5f02a6dc6f732547005d45631ce71c'): {'248378d0a3383c173fb925f17141b88e71580b3ba17ddc6ac3d2a344683232ab'},
 ('cargo', 'httparse', '1.10.1', '6dbf3de79e51f3d586ab4cb9d5c3e2c14aa28ed23d180cf89b4df0454a69cc87'): {'391a5396cec6230bfabd4ef4eb2350eb895bc5efce377a2218f5702ed020d3e3',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'hyper', '1.11.1', '27b501faa50e7a26c3d3560ca625132f4078a17771f4810baf70475ae48cbe43'): {'2d01890414494742ba4a509fcec8efa40f6d8be22cbd72be7cff08d6fda4ec89'},
 ('cargo', 'hyper-rustls', '0.27.10', 'dfa8e654703247911e29c23fbeaa261834bd9bb74efba2f9acddc37bfb127f53'): {'709e3175b4212f7b13aa93971c9f62ff8c69ec45ad8c6532a7e0c41d7a7d6f8c',
                                                                                                            '7cfafc877eccc46c0e346ccbaa5c51bb6b894d2b818e617d970211e232785ad4',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'hyper-util', '0.1.21', 'ddc03d96684f9226b8a787cdb71488417b53ab5ea8fdb1dac946cb9431cc8bff'): {'9e0a97848ea543aef745c98e84fde696a9a3e0735538f6daefdd3cb1942effc1'},
 ('cargo', 'iana-time-zone', '0.1.65', 'e31bc9ad994ba00e440a8aa5c9ef0ec67d5cb5e5cb0cc7f8b744a35b389cc470'): {'696759d65dfe558ff7d9f031c76db19ec5c0767470fb67c4e8d990820d1e99c9',
                                                                                                             'da28ccc6b158fc2d8cccc74e99794b1cff1d29bd7bbeb019442fcf0c04c6cad9'},
 ('cargo', 'iana-time-zone-haiku', '0.1.2', 'f31827a206f56af32e590ba56d5d2d085f558508192593743f16b2306495269f'): {'696759d65dfe558ff7d9f031c76db19ec5c0767470fb67c4e8d990820d1e99c9',
                                                                                                                  'da28ccc6b158fc2d8cccc74e99794b1cff1d29bd7bbeb019442fcf0c04c6cad9'},
 ('cargo', 'ico', '0.5.0', '3e795dff5605e0f04bff85ca41b51a96b83e80b281e96231bcaaf1ac35103371'): {'41ca90213441b294e7517d5858f0cc85bc12e19ec044001b45bc213de461d33b'},
 ('cargo', 'icu_collections', '2.3.0', 'fa68d21081c4a05d5a901a1c62add574c77048b6a1c67be3b50ce0b60d4ca513'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_locale_core', '2.3.0', 'd56e28588da92eee5c3201a6eff33fabdd49b62269c8938d4ff050ce4d900deb'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_normalizer', '2.3.0', '12f9cf5f235641ed274641dd81c3f28d870e276763d0797aeeab72317b1c646f'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_normalizer_data', '2.3.0', '1563da1ed3e0b3bf3d74c9b85917ac9c56464d2f57242270c09c9e752f8021a0'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_properties', '2.3.0', '7e7ca276ad3145661a65914e6daf131ca5120cd3dcee8f8f3214b8875184a148'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_properties_data', '2.3.0', 'e590f038c1464a96894fd6d10127e90a8be4509f56ff7ecef851b15cee0b7caa'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'icu_provider', '2.3.1', 'd27bbb9d3abbefac45d55f647c9de1d44aafcd1186eb91879afef17c396c3e73'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'ident_case', '1.0.1', 'b9e0384b61958566e926dc50660321d12159025e767c18e043daf26b70104c39'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1'},
 ('cargo', 'idna', '1.1.0', '3b0875f23caa03898994f6ddc501886a45c7d3d62d04d2d90788d47be1b1e4de'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'b38f11f6096706e6de553dabe2a7ed142d59b6fa8c97e290c67496154745cdd5'},
 ('cargo', 'idna_adapter', '1.2.2', 'cb68373c0d6620ef8105e855e7745e18b0d00d3bdb07fb532e434244cdb9a714'): {'8b43ce8accd61e9d370b5ca9e9c4f953279b5c239926c62315b40e24df51b726',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'indexmap', '1.9.3', 'bd070e393353796e801d209ad339e89596eb4c8d430d18ede6a1cced8fafbd99'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                      'ecc269ef87fd38a1d98e30bfac9ba964a9dbd9315c3770fed98d4d7cb5882055'},
 ('cargo', 'indexmap', '2.14.2', 'cc4e190f5d26ca7051642629da2c52fc03bde85a03197c99408dcd291734c855'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                       'ecc269ef87fd38a1d98e30bfac9ba964a9dbd9315c3770fed98d4d7cb5882055'},
 ('cargo', 'infer', '0.22.0', 'f4200d433cbd5178df7797c9c2e75b348b728e39631cf14520d1e2fc424201f4'): {'270b0d81891aa44c7e8726cf9432dade9556a01c848bacd2f3ef839c9c1a1859'},
 ('cargo', 'ipnet', '2.12.2', '791930b43c0d5973160d90a8f3894509f2b273430f5c5c73b668636d0287c5c0'): {'47dc9ff29128ddfb4d6a0435383c9f89120bc374dbcc1dd00b933a0b28aa7865',
                                                                                                    '87d9feb9238c6bd8e0024fc4733b06cff036f89f36d93b7df1c8a0549bbb7a5b'},
 ('cargo', 'is-docker', '0.2.0', '928bae27f42bc99b60d9ac7334e3a21d10ad8f1835a4e12ec3ec0464765ed1b3'): {'7377e48a67377f0baa9ccee6425e125eb7b96d5b8e706f4c99479ca4ffa21b77'},
 ('cargo', 'is-wsl', '0.4.0', '173609498df190136aa7dea1a91db051746d339e18476eed5ca40521f02d7aa5'): {'7377e48a67377f0baa9ccee6425e125eb7b96d5b8e706f4c99479ca4ffa21b77'},
 ('cargo', 'itoa', '1.0.18', '8f42a60cbdf9a97f5d2305f08a87dc4e09308d1276d28c869c684d7777685682'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                   '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'javascriptcore-rs', '1.1.2', 'ca5671e9ffce8ffba57afc24070e906da7fc4b1ba66f2cabebf61bf2ea257fcc'): {'5444779e62a6f136892955bab2727694509b2cc1c0cd0f394d5edc7ff9203cd1'},
 ('cargo', 'javascriptcore-rs-sys', '1.1.1', 'af1be78d14ffa4b75b66df31840478fef72b51f8c2465d4ca7c194da9f7a5124'): {'7ade43ec5e1a5e43000aa871d290dff4c0e9e2e16b7f6bea2ecf091e3d056d31'},
 ('cargo', 'jiff', '0.2.37', '0ab1baf72f08796de0260609515130699b890ac25f30e610ad894bc5856cafdb'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'jiff-core', '0.1.1', '5e52fe76043ccecc9005d2305ebaadf7d7fc0cc89ca6baa10a94d6bc68c7128c'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'jiff-static', '0.2.37', '378268a1116ad67ae6228701118ac9f491d78fda38a40a1f1a9e1348de6f7212'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'jiff-tzdb', '0.1.8', '142bd39932ad231f10513df9ab62661fead8719872150b7ad02a2df79f4e141e'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'jiff-tzdb-platform', '0.1.3', '875a5a69ac2bab1a891711cf5eccbec1ce0341ea805560dcd90b7a2e925132e8'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'jni', '0.21.1', '1a87aa2bb7d2af34197c04845522473242e1aa17c12f4935d5856491a7fb8c97'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni', '0.22.4', '5efd9a482cf3a427f00d6b35f14332adc7902ce91efb778580e180ff90fa3498'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni-macros', '0.22.4', 'a00109accc170f0bdb141fed3e393c565b6f5e072365c3bd58f5b062591560a3'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                         'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni-sys', '0.3.1', '41a652e1f9b6e0275df1f15b32661cf0d4b78d4d87ddec5e0c3c20f097433258'): {'1d85bd754b04ceec93e98e890edd1fa3c6a22e81bcb32135806beeccefa51cd1',
                                                                                                     'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'jni-sys', '0.4.1', 'c6377a88cb3910bee9b0fa88d4f42e1d2da8e79915598f65fb0c7ee14c878af2'): {'1d85bd754b04ceec93e98e890edd1fa3c6a22e81bcb32135806beeccefa51cd1',
                                                                                                     'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'jni-sys-macros', '0.4.1', '38c0b942f458fe50cdac086d2f946512305e5631e720728f2a61aabcd47a6264'): {'1d85bd754b04ceec93e98e890edd1fa3c6a22e81bcb32135806beeccefa51cd1',
                                                                                                            'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'js-sys', '0.3.106', '7883d941dae510fb2d978fc3fe018c71c9e2892fd38854de3e8b92c2e5ad9cc5'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'json-patch', '4.2.0', '7421438de105a0827e44fadd05377727847d717c80ce29a229f85fd04c427b72'): {'87f7527b1066337751f7f4d717089bf514ff8f7ee7d66c4c5b891b09e744ec11',
                                                                                                        'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'},
 ('cargo', 'jsonptr', '0.7.1', 'a5a3cc660ba5d72bce0b3bb295bf20847ccbb40fd423f3f05b61273672e561fe'): {'2bc107bdc18a74263d20bdefdb8073e17bc1a01b6b374dc5835683a33ee5ba7d',
                                                                                                     '2cf31f2ae7f3feba667d50fc1d4d21ecf217703c04c3068b83c9a73b6dde723a'},
 ('cargo', 'keyboard-types', '0.7.0', 'b750dcadc39a09dbadd74e118f6dd6598df77fa01df0cfcdc52c28dece74528a'): {'31dbbab009f1b2e59a1622d5955dfafc38ebe834000215b49d954c6f85fe927c',
                                                                                                            '769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb'},
 ('cargo', 'keyboard-types', '0.8.3', '0fbe853b403ae61a04233030ae8a79d94975281ed9770a1f9e246732b534b28d'): {'31dbbab009f1b2e59a1622d5955dfafc38ebe834000215b49d954c6f85fe927c',
                                                                                                            '769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb'},
 ('cargo', 'lazy_static', '1.5.0', 'bbd2bcb4c963f2ddae06a2efc7e9f3591312473c50c6685e1f298068316e66fe'): {'0621878e61f0d0fda054bcbe02df75192c28bde1ecc8289cbd86aeba2dd72720',
                                                                                                         'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'libappindicator', '0.9.0', '03589b9607c868cc7ae54c0b2a22c8dc03dd41692d48f2d7df73615c6a95dc0a'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                             'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b'},
 ('cargo', 'libappindicator-sys', '0.9.0', '6e9ec52138abedcc58dc17a7c6c0c00a2bdb4f3427c7f63fa97fd0d859155caf'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                                 'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b'},
 ('cargo', 'libc', '0.2.189', '3eaf3ede3fee6db1a4c2ee091bf8a8b4dccdc6d17f656fb07896ee72867612f2'): {'123a331b5dbf04c30097fa43b8f858bc85df671fe776de498d01f3d6b7c1f69e',
                                                                                                    '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'libdbus-sys', '0.2.7', '328c4789d42200f1eeec05bd86c9c13c7f091d2ba9a6ea35acdf51f31bc0f043'): {'453745410e3be8cf25d56872ea2aec975a78e6c9f217443d0bf908a5bce7c8ff',
                                                                                                         'c666ec2313dba24523ccad88f4c04ea4b24fad6545263a35b1d4ab2b08efe50a',
                                                                                                         'de3911c2d98c8bd2d701ee721347053d9b55995a11f9a8c955e44d3ca1b376bf',
                                                                                                         'e61807cd1c32ff4e7bd5b4b61dd21997c6dc5642cf19316124fe38d50e1f9fa3'},
 ('cargo', 'libloading', '0.7.4', 'b67380fd3b2fbe7527a606e18729d21c6f3951633d0500574c4dc22d2d638b9f'): {'b29f8b01452350c20dd1af16ef83b598fea3053578ccc1c7a0ef40e57be2620f'},
 ('cargo', 'libredox', '0.1.25', '61ff90caf6077a803a240f62fdbe88645a890bbca49ef8174c3cb0404362171d'): {'8d073a6a80d1ef2d2fc2bc6c809aa221161bf1906c76d4aeef55fd2b999d9413'},
 ('cargo', 'linux-raw-sys', '0.12.1', '32a66949e030da00e8c7d4434b251670a91556f4144941d37452769c25d58a53'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'litemap', '0.8.3', '47d9d19d1d6efa0109d2f65ff4c85cddd50bd572e5a00127ab10987290bcefae'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'lock_api', '0.4.14', '224399e74b87b5f3557511d98dff8b14089b3dadafcab6bb93eab67d3aace965'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                       'c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5'},
 ('cargo', 'log', '0.4.34', 'f9f8bd3e56ce4dfc153cf470fffbfa98c7620958b312ca5c3a4b8d5181fd13c6'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'markup5ever', '0.39.0', '7122d987ec5f704ee56f6e5b41a7d93722e9aae27ae07cafa4036c4d3f9757de'): {'86dd7f026f916daf7511e39951ad8ea8cf55a8db67ae64060dacf829761c18f3',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'memchr', '2.8.3', 'cf8baf1c55e62ffcace7a9f06f4bd9cd3f0c4beb022d3b367256b91b87513d98'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'memoffset', '0.9.1', '488016bfae457b036d996092f6cb448677611ce4449e970ceaf42695203f218a'): {'3234ac55816264ee7b6c7ee27efd61cf0a1fe775806870e3d9b4c41ea73c5cb1'},
 ('cargo', 'mime', '0.3.17', '6877bb514081ee2a7ff5ef9de3281f14a4dd4bceac4c09388074a6b5df8a139a'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                   'df9cfd06d8a44d9a671eadd39ffd97f166481da015a30f45dfd27886209c5922'},
 ('cargo', 'minisign-verify', '0.2.5', '22f9645cb765ea72b8111f36c522475d2daa0d22c957a9826437e97534bc4e9e'): {'42c8695fbc468866d9756be99af0ba4e37d733f8daa3c8827c8d80b8bec1b2f9'},
 ('cargo', 'miniz_oxide', '0.8.9', '1fa76a2c86f704bdb222d66965fb3d63269ce38518b83cb0575fca855ebb6316'): {'0a54e647fe54104658b5e563c04c6f9edf251710e47bce692e0bd990a4ddaa39',
                                                                                                         '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                         '4108245a1f2df9d4e94df8abed5b4ba0759bb2f9b40a6b939f1be141077ae50b',
                                                                                                         '799e9ca9d179295ef372f25d3769cdda7d25bb2668add6a6a1e22d1e4c678b8d'},
 ('cargo', 'miniz_oxide', '0.9.1', 'b63fbc4a50860e98e7b2aa7804ded1db5cbc3aff9193adaff57a6931bf7c4b4c'): {'0a54e647fe54104658b5e563c04c6f9edf251710e47bce692e0bd990a4ddaa39',
                                                                                                         '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                         '4108245a1f2df9d4e94df8abed5b4ba0759bb2f9b40a6b939f1be141077ae50b',
                                                                                                         '799e9ca9d179295ef372f25d3769cdda7d25bb2668add6a6a1e22d1e4c678b8d'},
 ('cargo', 'mio', '1.2.3', '4b18443e9c262bfe8fa82f51666e2642c53393f7e5c27b3e1aeab922cff5b9d8'): {'07919255c7e04793d8ea760d6c2ce32d19f9ff02bdbdde3ce90b1e1880929a9b'},
 ('cargo', 'muda', '0.20.0', 'cca139e57da4383727f189e43e66e84fa372347027fc996f9f1a007ec0a37996'): {'2ab5537b8c0cb1d475e2145b6a7994b04e7c71e6e5bd836f7f9c47c221a5ad9a',
                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'ndk', '0.9.0', 'c3f42e7bbe13d351b6bead8286a43aac9534b82bd3cc43e47037f012ebfd62d4'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'ndk-context', '0.1.1', '27b02d87554356db9e9a873add8782d4ea6e3e58ea071a9adb9a2e8ddb884a8b'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                         'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'ndk-sys', '0.6.0+11769913', 'ee6cda3051665f1fb8d9e08fc35c96d5a244fb1be711a03b71118828afc9a873'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                              'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'new_debug_unreachable', '1.0.6', '650eef8c711430f1a879fdd01d4745a7deea475becfb90269c06775983bbf086'): {'f7715d38a3fa1b4ac97c5729740752505a39cb92ee83ab5b102aeb5eaa7cdea4'},
 ('cargo', 'nix', '0.28.0', 'ab2156c4fce2f8df6c499cc1c763e4394b7482525bf2a9701c9d79d215f519e4'): {'66e3ee1fa7f909ad3c612d556f2a0cdabcd809ad6e66f3b0605015ac64841b70'},
 ('cargo', 'num-conv', '0.2.2', '521739c6d2bac4aa25192232afe6841231376b2b26d4d9fae5ecf8ca5772e441'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                      'e2e245f2b566d0bfafb0f6a04c16b82d710c4e6e7d799e39bb4ef6e541b85b98'},
 ('cargo', 'num-traits', '0.2.19', '071dfc062690e90b734c0b2273ce72ad0ffa95f0c74596bc250dcfd960262841'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                         'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'num_enum', '0.7.6', '5d0bca838442ec211fa11de3a8b0e0e8f3a4522575b5c4c06ed722e005036f26'): {'0be96d891d00e0ae0df75d7f3289b12871c000a1f5ac744f3b570768d4bb277c',
                                                                                                      '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'num_enum_derive', '0.7.6', '680998035259dcfcafe653688bf2aa6d3e2dc05e98be6ab46afb089dc84f1df8'): {'0be96d891d00e0ae0df75d7f3289b12871c000a1f5ac744f3b570768d4bb277c',
                                                                                                             '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                             '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'objc2', '0.6.4', '3a12a8ed07aefc768292f076dc3ac8c48f3781c8f2d5851dd3d98950e8c5a89f'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-app-kit', '0.3.2', 'd49e936b501e5c5bf01fda3a9452ff86dc3ea98ad5f283e1455153142d97518c'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-cloud-kit', '0.3.2', '73ad74d880bb43877038da939b7427bba67e9dd42004a18b809ba7d87cee241c'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-data', '0.3.2', '0b402a653efbb5e82ce4df10683b6b28027616a2715e90009947d50b8dd298fa'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-foundation', '0.3.2', '2a180dd8642fa45cdb7dd721cd4c11b1cadd4929ce112ebd8b9f5803cc79d536'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-graphics', '0.3.2', 'e022c9d066895efa1345f8e33e584b9f958da2fd4cd116792e15e07e4720a807'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-image', '0.3.2', 'e5d563b38d2b97209f8e861173de434bd0214cf020e3423a52624cd1d989f006'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-location', '0.3.2', 'ca347214e24bc973fc025fd0d36ebb179ff30536ed1f80252706db19ee452009'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-core-text', '0.3.2', '0cde0dfb48d25d2b4862161a4d5fcc0e3c24367869ad306b0c9ec0073bfed92d'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-encode', '4.1.0', 'ef25abbcd74fb2609453eb695bd2f860d389e457f67dc17cafc8b8cbc89d0c33'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-exception-helper', '0.1.1', 'c7a1c5fbb72d7735b076bb47b578523aedc40f3c439bea6dfd595c089d79d98a'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-foundation', '0.3.2', 'e3e0adef53c21f888deb4fa59fc59f7eb17404926ee8a6f59f5df0fd7f9f3272'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-io-surface', '0.3.2', '180788110936d59bab6bd83b6060ffdfffb3b922ba1396b312ae795e1de9d81d'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-osa-kit', '0.3.2', 'f112d1746737b0da274ef79a23aac283376f335f4095a083a267a082f21db0c0'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-quartz-core', '0.3.2', '96c1358452b371bf9f104e21ec536d37a650eb10f7ee379fff67d2e08d537f1f'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-ui-kit', '0.3.2', 'd87d638e33c06f577498cbcc50491496a3ed4246998a7fbba7ccb98b1e7eab22'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-user-notifications', '0.3.2', '9df9128cbbfef73cda168416ccf7f837b62737d748333bfe9ab71c245d76613e'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'objc2-web-kit', '0.3.2', 'b2e5aaab980c433cf470df9d7af96a7b46a9d892d521a2cbbb2f8a4c16751e7f'): {'b05785f9f18e6716bab63424b11454513b9943a222595b70411009202fc592b5'},
 ('cargo', 'once_cell', '1.21.4', '9f7c3e4beb33f85d45ae3e3a1792185706c8e16d043238c593331cc7cd313b50'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'open', '5.4.4', 'aa576c76302b7b808eecc68061e67336c47833ef9d22caa74dda10fa9675eebc'): {'e63690624d604aa626c3c62b6ead1a9f4a916d2260ac8132022acbafe2556045'},
 ('cargo', 'openssl-probe', '0.2.1', '7c87def4c32ab89d880effc9e097653c8da5d6ef28e6b539d313baaacfbafcbe'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'option-ext', '0.2.0', '04744f49eae99ab78e0d5c0b603ab218f515ea8cfe5a456d7629ad883a3b6e7d'): {'66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172'},
 ('cargo', 'ordered-multimap', '0.7.3', '49203cdcae0030493bad186b28da2fa25645fa276a51b6fec8010d281e02ef79'): {'047c1d2f1c28c30ced89bd0740ff251d8f51512e81b142711f958a0551729ec4'},
 ('cargo', 'ordered-stream', '0.2.0', '9aa2b01e1d916879f73a53d01d1d6cee68adbb31d6d9177a8cfce093cced1d50'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'osakit', '0.3.1', '732c71caeaa72c065bb69d7ea08717bd3f4863a4f451402fc9513e29dbd5261b'): {'5fb3573f6e7198ff6c203dbbd58d1da4bec9e8c5a828edefd9e98587d0443471',
                                                                                                    '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'pango', '0.18.3', '7ca27ec1eb0457ab26f3036ea52229edbdb74dee1edd29063f5b9b010e7ebee4'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'pango-sys', '0.18.0', '436737e391a843e5933d6d9aa102cb126d501e815b83601365a948a518555dc5'): {'8cf56d10131ce201cf69ab74b111d3ebac1acca3833d7efb39ae357224b70edb'},
 ('cargo', 'parking', '2.2.1', 'f38d5652c16fde515bb1ecef450ab0f6a219d619a7274976324d5e377f7dceba'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'parking_lot', '0.12.5', '93857453250e3077bd71ff98b6a65ea6621a19bb0f559a85248955ac12c45a1a'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                          'c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5'},
 ('cargo', 'parking_lot_core', '0.9.12', '2621685985a2ebf1c516881c026032ac7deafcda1a2c9b7850dc81e3dfcb64c1'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                               'c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5'},
 ('cargo', 'percent-encoding', '2.3.2', '9b4f627cb1b25917193a259e49bdad08f671f8d9708acfd5fe0a8c1455d87220'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                              'b38f11f6096706e6de553dabe2a7ed142d59b6fa8c97e290c67496154745cdd5'},
 ('cargo', 'phf', '0.13.1', 'c1562dc717473dbaa4c1f85a36410e03c047b2e7df7f45ee938fbef64ae7fadf'): {'0ab4d106b6faac07fb6a051815fd1b4d862d730895e2d7d7358c2f13565e7a38'},
 ('cargo', 'phf_codegen', '0.13.1', '49aa7f9d80421bca176ca8dbfebe668cc7a2684708594ec9f3c0db0805d5d6e1'): {'0ab4d106b6faac07fb6a051815fd1b4d862d730895e2d7d7358c2f13565e7a38'},
 ('cargo', 'phf_generator', '0.13.1', '135ace3a761e564ec88c03a77317a7c6b80bb7f7135ef2544dbe054243b89737'): {'0ab4d106b6faac07fb6a051815fd1b4d862d730895e2d7d7358c2f13565e7a38'},
 ('cargo', 'phf_macros', '0.13.1', '812f032b54b1e759ccd5f8b6677695d5268c588701effba24601f6932f8269ef'): {'0ab4d106b6faac07fb6a051815fd1b4d862d730895e2d7d7358c2f13565e7a38'},
 ('cargo', 'phf_shared', '0.13.1', 'e57fef6bc5981e38c2ce2d63bfa546861309f875b8a75f092d1d54ae2d64f266'): {'0ab4d106b6faac07fb6a051815fd1b4d862d730895e2d7d7358c2f13565e7a38'},
 ('cargo', 'pin-project-lite', '0.2.17', 'a89322df9ebe1c1578d689c92318e070967d1042b512afbe49518723f4e6d5cd'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                               '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'piper', '0.2.5', 'c835479a4443ded371d6c535cbfd8d31ad92c5d23ae9770a61bc155e4992a3c1'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'pkg-config', '0.3.34', 'f6b464fbc74e149a392436b17d523f769e057cb6877f6a5c4618bc6f11800548'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                         'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'plist', '1.10.1', '2896bade328c13f7042a297ea5ac5b0951f6cf989dea5f32c2fd98da398195cb'): {'5b0ae40d1a35f7ae6591a28e44771240e6a88cb03a66c9189a45b9681639b466'},
 ('cargo', 'png', '0.17.16', '82151a2fc869e011c153adc57cf2789ccb8d9906ce52c0b39a6b5697749d7526'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                   'eaf40297c75da471f7cda1f3458e8d91b4b2ec866e609527a13acfa93b638652'},
 ('cargo', 'png', '0.18.1', '60769b8b31b2a9f263dae2776c37b1b28ae246943cf719eb6946a1db05128a61'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'eaf40297c75da471f7cda1f3458e8d91b4b2ec866e609527a13acfa93b638652'},
 ('cargo', 'polling', '3.11.0', '5d0e4f59085d47d8241c88ead0f274e8a0cb551f3625263c05eb8dd897c34218'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'portable-atomic', '1.15.0', '05c8b63e8d9609db387f0324918f81d68fe27748f084ef092fb35954d0539a85'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                              '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'portable-atomic-util', '0.2.8', '10ab3eb7f3becc3a1cbc4f2c6f20267996cfc1a6467a873763411b136a122715'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                                  '23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'portable-pty', '0.9.0', 'b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e'): {'191c46fcf52061382b1c51a70311eb9081381cc158e5899f3739473a9432185b'},
 ('cargo', 'potential_utf', '0.1.6', 'd83eb9bc6d8e5cf568e7a1101d60ee05e81ed50ea106026f3d18deeb046d7661'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'powerfmt', '0.2.0', '439ee305def115ba05938db6eb1644ff94165c5ab5e9420d1c1bcedbba909391'): {'070dbc7dda03a29296f2d58bdb9b7331af90f2abc9f31df22875d1eabaf29852',
                                                                                                      '155420c6403d4e0fca34105e3c03fdd6939b64c393c7ec6f95f5b72c5474eab0'},
 ('cargo', 'precomputed-hash', '0.1.1', '925383efa346730478fb4838dbe9137d2a47675ad789c546d150a6e1dd4ab31c'): {'7ca6700600dfa9c9497bf5556365067daa802c871ea78239f129309c7a2048f7'},
 ('cargo', 'proc-macro-crate', '1.3.1', '7f4c021e1093a56626774e81216a4ce732a735e5bad4868a03f3ed65ca0c3919'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                              '8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb'},
 ('cargo', 'proc-macro-crate', '2.0.2', 'b00f26d3400549137f92511a46ac1cd8ce37cb5598a96d382381458b992a5d24'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                              '8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb'},
 ('cargo', 'proc-macro-crate', '3.5.0', 'e67ba7e9b2b56446f1d419b1d807906278ffa1a658a8a5d8a39dcb1f5a78614f'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                              '8ada45cd9f843acf64e4722ae262c622a2b3b3007c7310ef36ac1061a30f6adb'},
 ('cargo', 'proc-macro-error', '1.0.4', 'da25490ff9892aab3fcf7c36f08cfb902dd3e71ca0f9f9517bea02a73a5ce38c'): {'4665f973ccb9393807a7fb1264add6b3513d19abc6b357e4cb52c6fe59cc6a3b',
                                                                                                              '544b3aed1fd723d0cadea567affdcfe0431e43e18d997a718f9d67256b814fde'},
 ('cargo', 'proc-macro-error-attr', '1.0.4', 'a1be40180e52ecc98ad80b184934baf3d0d29f979574e439af5a55274b35f869'): {'544b3aed1fd723d0cadea567affdcfe0431e43e18d997a718f9d67256b814fde',
                                                                                                                   '6fd0f3522047150ca7c1939f02bc4a15662a4741a89bc03ae784eefa18caa299'},
 ('cargo', 'proc-macro2', '1.0.107', '985e7ec9bb745e6ce6535b544d84d6cd6f7ad8bd711c398938ae983b91a766d9'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                           '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'quick-xml', '0.42.0', '41b1177fdf999d2321d3fb46ff47159d9c1fb9ad66a4879f8c50a0b504615e9b'): {'f0cf9b1c62bbe3bd3a69f5f79c7158f513f612b4940a0a812d1db39d605318bc'},
 ('cargo', 'quote', '1.0.47', '1fbf4db142a473a8d80c26bbf18454ed458bf8d26c8219c331daecfdbd079001'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                    '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'r-efi', '5.3.0', '69cdb34c158ceb288df11e18b4bd39de994f6657d83847bdffdbd7f346754b0f'): {'ff92bed461f50338dd703a9ba9aee496a425957873df1d91192776e4bdf5dda7'},
 ('cargo', 'r-efi', '6.0.0', 'f8dcc9c7d52a811697d2151c701e0d08956f92b0e24136cf4cf27b57a6a0d9bf'): {'d027e91dbc9cdbb2f1190068e498bd6b61cff022b6a032b191021ba658d96111'},
 ('cargo', 'raw-window-handle', '0.6.2', '20675572f6f24e9e76ef639bc5552774ed45f1c30e2951e1e99c59888861c539'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                               '9c5a80639a57c1c945570e7ebbca0706305849ce3c098021325cca9db2f7acc4',
                                                                                                               'ae895c8576e682f310fb70d93d9f99b1dd82872094c54a8f6cdfe2ca5c2d6ecb'},
 ('cargo', 'redox_syscall', '0.5.18', 'ed2bf2547551a7053d6fdfafda3f938979645c44812fbfcda098faae3f1a362d'): {'efcfee7981ff72431fffb06925cad00a23dce079ed4354f61030ad5abdb78829'},
 ('cargo', 'redox_users', '0.5.3', '60dc65c0ff1a7ae1294b0c67b9f14baf70b644404010370171787bfac1038fc0'): {'e6a8ae2d796083783efc94b1e66271aa2929dc4dfb231d34239aa9c7db8396db'},
 ('cargo', 'ref-cast', '1.0.27', '7e440fb4e4b4147295338efb76001ab9e4efc0e5839df2c47fc5ac2381d365c3'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                       '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'ref-cast-impl', '1.0.27', '92ecd8964f8453721699a1ed72037b0db49ce2f5a5138486ee89bed6f67cdf3a'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'regex', '1.13.1', 'f020237b6c8eed93db2e2cb53c00c60a8e1bc73da7d073199a1180401450218d'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'regex-automata', '0.4.18', 'ad8553b9b26413251cbf30e620595c7a41b3887f03da04579c0e6b0d6a06b4b2'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                             'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'regex-syntax', '0.8.11', 'd6f6ff9a378485b298a5286656da665ba74413d36db0979633275d2e708145d4'): {'6485b8ed310d3f0340bf1ad1f47645069ce4069dcc6bb46c7d5c6faf41de1fdb',
                                                                                                           '74db5baf44a41b1000312c673544b3374e4198af5605c7f9080a402cec42cfa3',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'reqwest', '0.13.5', '16a1cfa75cc186dd73d5818e510e042e40927bccc9c236b061cea97e1eb08029'): {'751963a8b88c0e3a9f27e98933079fbcf09b9998b2c13ac49c2e4d58444520d6',
                                                                                                      'dd87e27dfbaa888cb77ea34592648a7743636b8dce07e49543bddda0fcfc73bc'},
 ('cargo', 'rfd', '0.16.0', 'a15ad77d9e70a92437d8f74c35d99b4e4691128df018833e99f90bcd36152672'): {'65fc947f4bac882a2cd104ef73c246b1b037059df9f2b3a58b7f77f0b9e56071'},
 ('cargo', 'ring', '0.17.14', 'a4689e6c2294d81e88dc6261c768b63bc4fcdb852be6d1352498b114f61383b7'): {'005fc765ddc5115da796cca915baa9557abae13ff35e0a47c47affc56f6c414d',
                                                                                                    '6ee2ed6c77710de911761acd5fc1ad1da00f476beb1a7ef27e78c2d1858deafc',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                    'f025ccfb7dfb6bdfedc75ca0f67acc69e6fb4998143d834f7c2f38a29989680f'},
 ('cargo', 'rust-ini', '0.21.3', '796e8d2b6696392a43bea58116b667fb4c29727dc5abd27d6acf338bb4f688c7'): {'ccf6244964385d34fef3799aa7792e9f8d35517de026f39a4f43f0e89b2079eb'},
 ('cargo', 'rustc-hash', '2.1.3', '6b1e7f9a428571be2dc5bc0505c13fb6bf936822b894ec87abf8a08a4e51742d'): {'30fefc3a7d6a0041541858293bcbea2dde4caa4c0a5802f996a7f7e8c0085652',
                                                                                                        '95bd3988beee069fa2848f648dab43cc6e0b2add2ad6bcb17360caf749802bcc'},
 ('cargo', 'rustc_version', '0.4.1', 'cfcb3a22ef46e85b45de6ee7e79d063319ebb6594faafcf1c225ea92ab6e9b92'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                           'c9a75f18b9ab2927829a208fc6aa2cf4e63b8420887ba29cdb265d6619ae82d5'},
 ('cargo', 'rustix', '1.1.5', '891efababe418670775f199f0d233d84843c227a0949a883ce15b37c78d6629d'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                    '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                                                    'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'rustls', '0.23.45', '0d41d731c7d2f962d1ccc364cec258de3c0e93b38c2fb3ba97ac74513048d634'): {'709e3175b4212f7b13aa93971c9f62ff8c69ec45ad8c6532a7e0c41d7a7d6f8c',
                                                                                                      '7cfafc877eccc46c0e346ccbaa5c51bb6b894d2b818e617d970211e232785ad4',
                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'rustls-native-certs', '0.8.4', 'dab5152771c58876a2146916e53e35057e1a4dfa2b9df0f0305b07f611fdea4d'): {'709e3175b4212f7b13aa93971c9f62ff8c69ec45ad8c6532a7e0c41d7a7d6f8c',
                                                                                                                 '7cfafc877eccc46c0e346ccbaa5c51bb6b894d2b818e617d970211e232785ad4',
                                                                                                                 'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'rustls-pki-types', '1.15.1', '2f4925028c7eb5d1fcdaf196971378ed9d2c1c4efc7dc5d011256f76c99c0a96'): {'45fd05c4865e7c350b98ad7ac50e1b15462d49af4a91e9b0c9dd933dc9a69742',
                                                                                                               '9117d922e667125508dde62b02c1f57ed22f5ad21eb536aa2e2d99e1c796e639'},
 ('cargo', 'rustls-platform-verifier', '0.7.1', '1167586491e2b18b8bfbb293e8180ec17c201c4f076d7cb3070ca964e7598f98'): {'1c7cf76689c837a68ed8d704994e52a0f2940c087958f860d17f3186afbdcc0c',
                                                                                                                      'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'rustls-platform-verifier-android', '0.2.0', 'eec689c0bc40ff2458a5977b6619cb718087084a18e02a131c599b62d05e1a5f'): {'1c7cf76689c837a68ed8d704994e52a0f2940c087958f860d17f3186afbdcc0c',
                                                                                                                              'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'rustls-webpki', '0.103.15', 'f3c3cf1d8b1e7d4927e2d154c3fcb02979afb9939629c62cd9048d4f07b60ac2'): {'5b698ca13897be3afdb7174256fa1574f8c6892b8bea1a66dd6469d3fe27885a'},
 ('cargo', 'rustversion', '1.0.23', 'cf54715a573b99ac80df0bc206da022bcd442c974952c7b9720069370852e21f'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'same-file', '1.0.6', '93fc1dc3aaa9bfed95e02e6eadabb4baf7e3078b0bd1b4d7b6b0b68378900502'): {'cb3c929a05e6cbc9de9ab06a4c57eeb60ca8c724bef6c138c87d3a577e27aa14'},
 ('cargo', 'schannel', '0.1.29', '91c1b7e4904c873ef0710c1f407dde2e6287de2bebc1bbbf7d430bb7cbffd939'): {'aa72991ac35b4de0034da0afe943e62b48c4092fc2ba13ae47806d8e9a4ad551'},
 ('cargo', 'schemars', '0.8.22', '3fbf2ae1b8bc8e02df939598064d22402220cd5bbcca1c76f7d6a310974d5615'): {'1954992a2b32e8a2af24a4c11b726902e344c1934b947a77f04d404908f8db30'},
 ('cargo', 'schemars', '0.9.0', '4cd191f9397d57d581cddd31014772520aa448f65ef991055d7f61582c65165f'): {'1954992a2b32e8a2af24a4c11b726902e344c1934b947a77f04d404908f8db30'},
 ('cargo', 'schemars', '1.2.2', '687274d293b6cdc6e73e0fee520bf2049650090d7164f87672d212a3c530cf4a'): {'1954992a2b32e8a2af24a4c11b726902e344c1934b947a77f04d404908f8db30'},
 ('cargo', 'schemars_derive', '0.8.22', '32e265784ad618884abaea0600a9adf15393368d840e0222d101a072f3f7534d'): {'1954992a2b32e8a2af24a4c11b726902e344c1934b947a77f04d404908f8db30'},
 ('cargo', 'scopeguard', '1.2.0', '94143f37725109f92c262ed2cf5e59bce7498c01bcc1502d7b9afe439a4e9f49'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                        'fb77f0a9c53e473abe5103c8632ef9f0f2874d4fb3f17cb2d8c661aab9cee9d7'},
 ('cargo', 'security-framework', '3.7.0', 'b7f4bc775c73d9a02cde8bf7b2ec4c9d12743edf609006c7facc23998404cd1d'): {'91e934255ba3b2f21103d68c5581c23ef34aa95c4628e4405b8c901935e11c69',
                                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'security-framework-sys', '2.17.0', '6ce2691df843ecc5d231c0b14ece2acc3efb62c0a398c7e1d875f3983ce020e3'): {'91e934255ba3b2f21103d68c5581c23ef34aa95c4628e4405b8c901935e11c69',
                                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'selectors', '0.38.0', '8adfa1c298912827b8a28b223b3b874357397ae706e6190acd9bf28cee99114d'): {'3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04'},
 ('cargo', 'semver', '1.0.28', '8a7852d02fc848982e0c167ef163aaff9cd91dc640ba85e263cb1ce46fae51cd'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                     '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde', '1.0.229', '4148590afebada386688f18773da617792bf2ef03ffc1e4cbd2b1d45b023e0ba'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                     '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde-untagged', '0.1.9', 'f9faf48a4a2d2693be24c6289dbe26552776eb7737074e6722891fadbe6c5058'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_core', '1.0.229', '67dca2c9c51e58a4791a4b1ed58308b39c64224d349a935ab5039aa360942a48'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_derive', '1.0.229', 'e7a5d71263a5a7d47b41f6b3f06ba276f10cc18b0931f1799f710578e2309348'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_derive_internals', '0.29.1', '18d26a20a969b9e3fdf2fc2d9f21eda6c40e2de84c9408bb5d3b05d499aae711'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                                     '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_json', '1.0.151', 'c841b55ecdae098c80dcae9cf767f6f8a0c2cdb3416bbef72181df4d0fe73f14'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_repr', '0.1.21', '8d3b1629de253c70a0508c3899572da79ca359fdab27c7920ff00406df418906'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                         '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'serde_spanned', '0.6.9', 'bf41e0cfaf7226dca15e8197172c295a782857fcb97fad1808a166870dee75a3'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                           'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'serde_spanned', '1.1.1', '6662b5879511e06e8999a8a235d848113e942c9124f211511b16466ee2995f26'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                           'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'serde_with', '3.24.0', 'df9adc193c780ef8f159aee8b61e2d5801aaa555e6eb0947fe45530ec506296f'): {'7576269ea71f767b99297934c0b2367532690f8c4badc695edf8e04ab6a1e545',
                                                                                                         'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'serde_with_macros', '3.24.0', '3e17bbc68e28663bbbb90df47e058aa7eda4fb445b89fe70457bb94fbccf6e49'): {'7576269ea71f767b99297934c0b2367532690f8c4badc695edf8e04ab6a1e545',
                                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'serial2', '0.2.38', 'b16809bc35793b19ce4e0c53924bc0dce3937f15487997cfdaed936004180730'): {'8db3a8bca21e298fa56df51250b723d4253755966a5c7a92f8027cdd3aaf5972'},
 ('cargo', 'serialize-to-javascript', '0.1.2', '04f3666a07a197cdb77cdf306c32be9b7f598d7060d50cfd4d5aa04bfd92f6c5'): {'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
                                                                                                                     'e53a7165e8bc3ced5e5628404b3d2d28ecc14ad720f1c09ba28385d5151ecf93'},
 ('cargo', 'serialize-to-javascript-impl', '0.1.2', '772ee033c0916d670af7860b6e1ef7d658a4629a6d0b4c8c3e67f09b3765b75d'): {'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
                                                                                                                          'e53a7165e8bc3ced5e5628404b3d2d28ecc14ad720f1c09ba28385d5151ecf93'},
 ('cargo', 'servo_arc', '0.4.3', '170fb83ab34de17dc69aa7c67482b22218ddb85da56546f9bd6b929e32a05930'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'sha2', '0.10.9', 'a7507d819769d01a365ab707794a4084392c824f54a7a6a7862f8c3d0892b283'): {'a9040321c3712d8fd0b09cf52b17445de04a23a10165049ae187cd39e5c86be5',
                                                                                                   'b4eb00df6e2a4d22518fcaa6a2b4646f249b3a3c9814509b22bd2091f1392ff1'},
 ('cargo', 'shared_library', '0.1.9', '5a9e7e0f2bfae24d8a5b5a66c5b257a83c7412304311512a0c054cd5e619da11'): {'1c07d19ccbe2578665ab7d8c63f71559f890eb8d2a82fa39d0206b7a3414064f',
                                                                                                            'c144680885b29e4719e2a51f0aab5439a1e02d980692b5aaf086cae12727f28b'},
 ('cargo', 'shell-words', '1.1.1', 'dc6fe69c597f9c37bfeeeeeb33da3530379845f10be461a66d16d03eca2ded77'): {'848d7bf14c618c39f1e29fcac2318a2fcc4254045ba7e2f6f5fa799e057225cb',
                                                                                                         'f76b7831ee8f42d3ac38919101e4ceb9f56aeb7796cdfe8a5ef52e26acedcbbf'},
 ('cargo', 'shlex', '2.0.1', 'f8fadd59c855ef2080decdef8ff161eb6661b86933c9d82e5ba29dc602a55aba'): {'4455bf75a91154108304cb283e0fea9948c14f13e20d60887cf2552449dea3b1'},
 ('cargo', 'signal-hook-registry', '1.4.8', 'c4db69cba1110affc0e9f7bcd48bbf87b3f4fc7c61fc9155afd4c469eb3d6c1b'): {'503558bfefe66ca15e4e3f7955b3cb0ec87fd52f29bf24b336af7bd00e946d5c',
                                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'simd-adler32', '0.3.10', '3a219298ac11a56ea9a6d2120044824d6f01aeb034955e7af7bc16858527deea'): {'42a35170233e83e18856792e748de4c1ce4a63b2afce9a370c89ef3fe23f9f2d'},
 ('cargo', 'simd_cesu8', '1.2.0', '11031e251abf8611c80f460e19dbdeb54a66db918e49c65a7065b46ac7aec520'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'simdutf8', '0.1.5', 'e3a9fe34e3e7a50316060351f37187a3f546bce95496156754b601a5fa71b76e'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                      '1847e0e0698142ed4347c1441a9fa81c8fbddd44b1d8bbcd5e3647f991759d7f'},
 ('cargo', 'siphasher', '1.0.4', '33f4fe9184a62d842c9ef383018f3306d8ba224fd9d836f56d7288308847c256'): {'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
                                                                                                       'f9c4c77baa3828004ee54b8a4f2db2e88ed44a6237a493965bf551fac0fcb62d'},
 ('cargo', 'slab', '0.4.12', '0c790de23124f9ab44544d7ac05d60440adc586479ce501c1d6d7da3cd8c9cf5'): {'8ce0830173fdac609dfb4ea603fdc002c2f4af0dc9b1a005653f5da9cf534b18'},
 ('cargo', 'smallvec', '1.16.2', 'f9395f0f0eee849a9b707b2f06bb92a6a422090e2123bb2ef8e87a0e61892a8e'): {'0b28172679e0009b655da42797c03fd163a3379d5cfa67ba1f1655e974a2a1a9',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'socket2', '0.6.5', 'c3d1e2c7f27f8d4cb10542a02c49005dbd6e93095799d6f3be745fae9f8fedd4'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'softbuffer', '0.4.8', 'aac18da81ebbf05109ab275b157c22a653bb3c12cf884450179942f81bcbf6c3'): {'0463bfa47d6d763d8c824333efb0e6d6df3946c13c3b077c78ed9f23ca50d0f2',
                                                                                                        'a4445427440043e8ce6fadf7a43fb906cb0d7f6c573a560a9f142cf9f9bf8ff4'},
 ('cargo', 'soup3', '0.5.0', '471f924a40f31251afc77450e781cb26d55c0b650842efafc9c6cbd2f7cc4f9f'): {'7ade43ec5e1a5e43000aa871d290dff4c0e9e2e16b7f6bea2ecf091e3d056d31'},
 ('cargo', 'soup3-sys', '0.5.0', '7ebe8950a680a12f24f15ebe1bf70db7af98ad242d9db43596ad3108aab86c27'): {'7ade43ec5e1a5e43000aa871d290dff4c0e9e2e16b7f6bea2ecf091e3d056d31'},
 ('cargo', 'stable_deref_trait', '1.2.1', '6ce2be8dc25455e1f91df71bfa12ad37d7af1092ae736f3a6cd0e37bc7810596'): {'5e05b024f653a5ce199e77cbbbd42fb5553562ec714b819421ed0c3e552a75d7',
                                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'string_cache', '0.9.0', 'a18596f8c785a729f2819c0f6a7eae6ebeebdfffbfe4214ae6b087f690e31901'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'string_cache_codegen', '0.6.1', '585635e46db231059f76c5849798146164652513eb9e8ab2685939dd90f29b69'): {'62065228e42caebca7e7d7db1204cbb867033de5982ca4009928915e4095f3a3',
                                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'strsim', '0.11.1', '7da8b5736845d9f2fcb837ea5d9e2628564b3b043a70948a3f0b778838c5fb4f'): {'1e697ce8d21401fbf1bddd9b5c3fd4c4c79ae1e3bdf51f81761c85e11d5a89cd'},
 ('cargo', 'subtle', '2.6.1', '13c2bddecc57b384dee18652358fb23172facb8a2c51ccc10d74c157bdea3292'): {'d1fc1bc0d155df60b2e7705b6b2ae02a05c96f948e1cec6e2fb86360b09f346b'},
 ('cargo', 'swift-rs', '1.0.8', 'e45c444e496845d3f2a351146bff59aae4975b2280238df1dfaa0c7d1846f38e'): {'908a661cf763bddfa04f2739bea561be62a246f03ad53fcb2272d3ddbd1d943f',
                                                                                                      'f3c3e9f4febe81ff14ccc233c344e6e60051290d1c1e5a2c670d63cc3608a5bb'},
 ('cargo', 'syn', '1.0.109', '72b64191b275b66ffe2469e8af2c1cfe3bafa67b529ead792a6d0160888b4237'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'syn', '2.0.119', '872831b642d1a07999a962a351ed35b955ea2cfc8f3862091e2a240a84f17297'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                   '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'syn', '3.0.6', '8593e8e72159ed2257d083c7a454a85cbf854f37a0966d8d483aff8c8a3ebcee'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                 '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'sync_wrapper', '1.0.2', '0bf256ce5efdfa370213c1dabab5935a12e49f2c58d15e9eac2870d3b4f27263'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594'},
 ('cargo', 'synstructure', '0.14.0', '901704edd0dfe137f1987838ee4f259e4e063c31371bdb423f7ae38ec6f77f02'): {'219920e865eee70b7dcfc948a86b099e7f4fe2de01bcca2ca9a20c0a033f2b59'},
 ('cargo', 'system-configuration', '0.7.0', 'a13f3d0daba03132c0aa9767f98351b3488edc2c100cda2d2ec2b04f3d8d3c8b'): {'000cbb5bea6f21829c8f0d9e1fe87410bd5ef0453412ffc017845982a3e19824',
                                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'system-configuration-sys', '0.6.0', '8e1d1b10ced5ca923a1fcb8d03e96b8d3268065d724548c0211415ff6ac6bac4'): {'000cbb5bea6f21829c8f0d9e1fe87410bd5ef0453412ffc017845982a3e19824',
                                                                                                                      'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'system-deps', '6.2.2', 'a3e535eb8dded36d55ec13eddacd30dec501792ff23a0b1682c38601b8cf2349'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                         'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'tao', '0.37.1', 'f37f381f4e048e6cdf038b5705f8cf14ad108279d46eb968140a7b291aba9400'): {'6dc0e068dcf3a5bc8e054205b85b7720e1d49265bbc64bf515d2cf79197df69a'},
 ('cargo', 'tao-macros', '0.1.4', '5f7eeb6d99155545da6150a1795945f16ac9c178deb2a5f2e74d776107bd5849'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                        'ca52f53b2ee0b6a96d77d8ae0cb1b4624080dd0274c97f1cece24efaf4e145f2'},
 ('cargo', 'tar', '0.4.46', '3f6221d9a6003c78398e3b239969f352578258df48c8eb051caadae0015bc840'): {'8ca6b96cea9e67c6c5c63f452c31bd396db8bd2406231fdea5d48ef462b48077',
                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'target-lexicon', '0.12.16', '61c41af27dd6d1e27b1b16b489db798443478cef1f06a660c96db617ba5de3b1'): {'268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5'},
 ('cargo', 'tauri', '2.12.0', 'cb20ef8e6f97d6fe03039666cd82861f09a38b56291fa2f0f9fe140023f61c1a'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                    '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-build', '2.7.0', '5b5ae674f48836f5dd2eeaf9e221c095bd3e78a8d0439c77ca93b48740a1b644'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                         '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-codegen', '2.7.0', '3926b73ac01df7c14f19ff872cd56e67213a87acc0000ea37ddb300f3d11a3e3'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                           '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-macros', '2.7.0', 'd21d0fa2c0529972ea6ecaf7404fcf40efac098eda0beb06ca682f41e33a6aa5'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                          '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-plugin', '2.7.0', 'c9ff3ebb9fda56ceb93d46f6cbb126bae82951bf43498543a5163dde5def49a1'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                          '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-plugin-deep-link', '2.6.0', '84d6b3bf88f2ec8b97c852c2fa1464dc13c0ba3fbfb24af4144f23fbd54c0f14'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                    '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-plugin-dialog', '2.8.0', '7527c5fd1678032d116c1a82e5d609c67370e56f858ae6cfd376bbca37fe0490'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                 '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-plugin-fs', '2.6.0', '466eb32466fe5021b6728b06862f9ff14a9f7e1af890047654e03a96d7c0e1bb'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                             '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-plugin-global-shortcut', '2.4.0', '0bd2e1f725891a1613af8f25bf918ba3357654b0fd3f2d794c0ce76cbdd92ed2'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                          '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-plugin-opener', '2.7.0', 'd39404b2572927e0d3ed30a7ca226037f7508d22e79c96ee6ef0d42b6a4b3345'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                 '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-plugin-single-instance', '2.5.1', '91baf4f5db4b008fc2bcada0f7d3a49b45d911f94575ac236f225ed67554f5c0'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                          'b7f455413bfe5f9d7da501a4468d4c5f866a432c325947e98cc9535e8b26cd6d'},
 ('cargo', 'tauri-plugin-updater', '2.13.1', '3cb0b2ea3e85ca287990d3859a29cc5cb18024240fd78f62e027fb7963670f18'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                   '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'tauri-runtime', '2.12.0', 'c9e6d5ef76985b32ff012a43b58df205d25a285e400ca878afcacddc5d5f3238'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                            '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-runtime-wry', '2.12.0', 'fa829eb69860cf1fb0bedb21d2d5f1effce3527d054a68ca1cd7355c654400a3'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                                '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-utils', '2.10.0', '4dd257082deff79550de3409ed146104aeaf86fe38649615b04a304144939677'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                          '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-winres', '0.3.6', 'cc65d45c68858bfe420dd29e834b5d15dbecf8a07a8a16cf4d532c7b1f69d4b6'): {'d9fa6b0e6fed50d4961b9c931587af6bd127df13e9473418d3e324f427db4f06'},
 ('cargo', 'tempfile', '3.27.0', '32497e9a4c7b38532efcdebeef879707aa9f794296a4f0244f6f69e9bc8574bd'): {'8b427f5bc501764575e52ba4f9d95673cf8f6d80a86d0d06599852e1a9a20a36',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'tendril', '0.5.1', '5fed54709c5b3a53d09bb1c113ea4f5ceafd1e772ddcb0030a82e1d56c087b08'): {'60a7062291b01ba068f300612cdbdc20382ac1d4934f07bcdd7167c15299f309',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'thiserror', '1.0.69', 'b6aaf5339b578ea85b50e080feb250a3e8ae8cfcdff9a461c9ec2904bc923f52'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'thiserror', '2.0.21', '09e52cb86a36cede5cb101bf8908837b3e4c6e5e59fe7fd85c23fb56200d189e'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                        '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'thiserror-impl', '1.0.69', '4fee6c4efc90059e10f81e6d42c60a18f76588c3d74cb83a0b242a2b6c7504c1'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                             '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'thiserror-impl', '2.0.21', 'fe5197923287db20a58125f0bc85c062f7f2c892de97b18c356f9efb14b28524'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                             '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'time', '0.3.55', 'cdb87b95ec50ddfa440816d227a17b2ccbdda963a316a727fda0fc4334f7d134'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                   '2537228d9a1b44a5dc595241349cae7090b326c8de165aaf89bfddef4a00d0fc'},
 ('cargo', 'time-core', '0.1.9', '9e1c906769ad99c88eaa54e728060edef082f8e358ff32030cb7c7d315e81109'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                       '2537228d9a1b44a5dc595241349cae7090b326c8de165aaf89bfddef4a00d0fc'},
 ('cargo', 'time-macros', '0.2.32', '7e689342a48d2ea927c87ea50cabf8594854bf940e9310208848d680d668ed85'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                          '2537228d9a1b44a5dc595241349cae7090b326c8de165aaf89bfddef4a00d0fc'},
 ('cargo', 'tiny-keccak', '2.0.2', '2c9d3793400a45f954c52e73d068316d76b6f4e36977e3fcebb13a2721e80237'): {'a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499'},
 ('cargo', 'tinystr', '0.8.4', 'b1e27c91459209c2986af3dcf603a5a74a4368754ce37414f59acc971167f643'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'tinyvec', '1.13.3', 'fd3ca314f692efd6c868f8408f53fe444634a845f96c028b97d35f6a1f79f0ee'): {'84b34dd7608f7fb9b17bd588a6bf392bf7de504e2716f024a77d89f1b145a151',
                                                                                                      'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30',
                                                                                                      'fd80a26fbb3f644af1fa994134446702932968519797227e07a1368dea80f0bc'},
 ('cargo', 'tokio', '1.53.1', '202caea871b69668250d242070849eb495be178ed697a3e98aebce5bc81a0bed'): {'253cd04c6714889df2d32f3f64d669179a1c95c76ac43c40882c52eb06bc3552'},
 ('cargo', 'tokio-rustls', '0.26.6', 'c9cc2678c2cdd569ef8215e2afd7954ada2ae20b4fdd2c5fe6139a3b02d105db'): {'cc117d90b498b32b11a886f279b359da16a73c3b01efbb2f5cc004b20262334e',
                                                                                                           'e20fa2b8e0a2565f24a792b94b4bf4b6c2b9d36f781d8a9516e218a036e6677a'},
 ('cargo', 'tokio-util', '0.7.19', '494815d09bf52b5548659851081238f0ca39ff638363907596da739561c62c52'): {'253cd04c6714889df2d32f3f64d669179a1c95c76ac43c40882c52eb06bc3552'},
 ('cargo', 'toml', '0.8.2', '185d8ab0dfbb35cf1399a6344d8484209c088f75f8f68230da55d48d95d43e3d'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                  'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml', '1.1.6+spec-1.1.0', '920602543f0911ab71da12c50d59701da54c196d1a2bf5cb4b75667f137a406a'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                             'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_datetime', '0.6.3', '7cda73e2f1397b1262d6dfdcef8aafae14d1de7748d66822d3bfeeb6d03e5e4b'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'toml_datetime', '1.1.1+spec-1.1.0', '3165f65f62e28e0115a00b2ebdd37eb6f3b641855f9d636d3cd4103767159ad7'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                                      'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_edit', '0.19.15', '1b5bb770da30e5cbfde35a2d7b9b8a2c4b8ef89548a7a6aeab5c9a576e3e7421'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                         'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_edit', '0.20.2', '396e4d48bbb2b7554c944bde63101b5ae446cff6ec4a24227428f15eb72ef338'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                        'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_edit', '0.25.15+spec-1.1.0', '1340ea94a5856333492c9064b02c778b191dd2c853778d9609debdcdfea3a614'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                                    'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_parser', '1.1.3+spec-1.1.0', '1d38ac1cf9b95face32296c0a3ede1fdc270627c9d9c02a7274dd6d960dc4d56'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                                    'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'toml_writer', '1.1.2+spec-1.1.0', '7d56353a2a665ad0f41a421187180aab746c8c325620617ad883a99a1cbe66d2'): {'6efb0476a1cc085077ed49357026d8c173bf33017278ef440f222fb9cbcb66e6',
                                                                                                                    'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'tower', '0.5.3', 'ebe5ef63511595f1344e2d5cfa636d973292adc0eec1f0ad45fae9f0851ab1d4'): {'4249c8e6c5ebb85f97c77e6457c6fafc1066406eb8f1ef61e796fbdc5ff18482'},
 ('cargo', 'tower-http', '0.6.11', '4cfcf7e2740e6fc6d4d688b4ef00650406bb94adf4731e43c096c3a19fe40840'): {'5049cf464977eff4b4fcfa7988d84e74116956a3eb9d5f1d451b3f828f945233'},
 ('cargo', 'tower-layer', '0.3.3', '121c2a6cda46980bb0fcd1647ffaf6cd3fc79a013de288782836f6df9c48780e'): {'4249c8e6c5ebb85f97c77e6457c6fafc1066406eb8f1ef61e796fbdc5ff18482'},
 ('cargo', 'tower-service', '0.3.3', '8df9b6e13f2d32c91b9bd719c00d1958837bc7dec474d94952798cc8e69eeec3'): {'4249c8e6c5ebb85f97c77e6457c6fafc1066406eb8f1ef61e796fbdc5ff18482'},
 ('cargo', 'tracing', '0.1.44', '63e71662fa4b2a2c3a26f570f037eb95bb1f85397f3cd8076caed2f026a6d100'): {'898b1ae9821e98daf8964c8d6c7f61641f5f5aa78ad500020771c0939ee0dea1'},
 ('cargo', 'tracing-attributes', '0.1.31', '7490cfa5ec963746568740651ac6781f701c9c5ea257c58e057f3ba8cf69e8da'): {'898b1ae9821e98daf8964c8d6c7f61641f5f5aa78ad500020771c0939ee0dea1'},
 ('cargo', 'tracing-core', '0.1.36', 'db97caf9d906fbde555dd62fa95ddba9eecfd14cb388e4f491a66d74cd5fb79a'): {'58545fed1565e42d687aecec6897d35c6d37ccb71479a137c0deb2203e125c79',
                                                                                                           '898b1ae9821e98daf8964c8d6c7f61641f5f5aa78ad500020771c0939ee0dea1'},
 ('cargo', 'tray-icon', '0.25.1', 'b2b9c52859a94554803ccd4a24b98f74148ebc73b90676d783f3490b1bff9d72'): {'2ab5537b8c0cb1d475e2145b6a7994b04e7c71e6e5bd836f7f9c47c221a5ad9a',
                                                                                                        'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'try-lock', '0.2.5', 'e421abadd41a4225275504ea4d6566923418b7f05506fbc9c0fe86ba7396114b'): {'c816a0749cdc6bf062a5111c159723de51b2bfac66a1dac2655abd9e6b1583eb'},
 ('cargo', 'typeid', '1.0.3', 'bc7d623258602320d5c55d1bc22793b57daff0ec7efc270ea7d55ce1d5f5471c'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                    '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'typenum', '1.20.1', 'b6f5e870be6c3b371b77fe0ee0bafb859fa4964b4404c27de1d380043c4dda20'): {'516b24e051bf5630880ebbd55c40a25ce9552ebaf8970a53e8976eb70e522406',
                                                                                                      'a825bd853ab71619a4923d7b4311221427848070ff44d990da39b0b274c1683f'},
 ('cargo', 'uds_windows', '1.2.1', 'f2f6fb2847f6742cd76af783a2a2c49e9375d0a111c7bef6f71cd9e738c72d6e'): {'27ebda9d51f0a56b7e281ccd8230a27236dcb51c05f64b07869ecf6e965d68b0'},
 ('cargo', 'unicode-ident', '1.0.26', 'd245f478577f809a851594d02313b640fb437e0bb33866753cff937863096954'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                            '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a',
                                                                                                            'f7db81051789b729fea528a63ec4c938fdcb93d9d61d97dc8cc2e9df6d47f2a1'},
 ('cargo', 'unicode-segmentation', '1.13.3', 'c6f5d3c3b1bf09027a88a6bc961fc00497d651009560b5463668dc81b0fa87a8'): {'7b63ecd5f1902af1b63729947373683c32745c16a10e8e6292e2e2dcd7e90ae0',
                                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'untrusted', '0.9.0', '8ecb6da28b8a351d773b68d5825ac39017e680750f980f3a1a85cd8dd28a47c1'): {'7abd9b6960dcf7d4d0a48606a5b71bfe37d472db68d70637f3a58a56785f1621'},
 ('cargo', 'url', '2.5.8', 'ff67a8a4397373c3ef660812acab3268222035010ab8680ec4215f38ba3d0eed'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                 'b38f11f6096706e6de553dabe2a7ed142d59b6fa8c97e290c67496154745cdd5'},
 ('cargo', 'urlpattern', '0.6.0', 'df16f50ef4cc145211879a3867ba757076b25dfee812040dcb0658bd9ae7904b'): {'5cf1c9dc617e4cad7fa03181ff893601ad5243aa3be527ef39034e1cd6377676'},
 ('cargo', 'utf8_iter', '1.0.4', 'b6c140620e7ffbb22c2dee59cafe6084a59b5ffc27a8859a5f0d494b5d52b6be'): {'3fa4ca83dcc9237839b1bdeb2e6d16bdfb5ec0c5ce42b24694d8bbf0dcbef72c',
                                                                                                       'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'uuid', '1.26.1', '2ef6dac1e96601b4fb3acccccff2139741fcb757cb9a36089bf5be91cfb285ce'): {'436bc5a105d8e57dcd8778730f3754f7bf39c14d2f530e4cde4bd2d17a83ec3d',
                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'version-compare', '0.2.1', '03c2856837ef78f57382f06b2b8563a2f512f7185d732608fd9176cb3b8edf0e'): {'cedfcc7ace1639adb054bd4a19b6f8585ccb2429a60b4bf51bfeb0601058c22c'},
 ('cargo', 'version_check', '0.9.5', '0b928f33d975fc6ad9f86c8f283853ad26bdd5b10b7f1542aa2fa15e2289105a'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                           'b7e650f3fce5c53249d1cdc608b54df156a97edd636cf9d23498d0cfe7aec63e'},
 ('cargo', 'vswhom', '0.1.0', 'be979b7f07507105799e854203b470ff7c78a1639e330a58f183b5fea574608b'): {'b9b7e5d4bf8857061fbecab39ef1923644eba639337af22d7ad0bb9b3ce59c49'},
 ('cargo', 'vswhom-sys', '0.1.3', 'fb067e4cbd1ff067d1df46c9194b5de0e98efd2810bbc95c5d5e5f25a3231150'): {'b9b7e5d4bf8857061fbecab39ef1923644eba639337af22d7ad0bb9b3ce59c49'},
 ('cargo', 'walkdir', '2.5.0', '29790946404f91d9c5d06f9874efddea1dc06c5efe94541a7d6863108e3a5e4b'): {'0f96a83840e146e43c0ec96a22ec1f392e0680e6c1226e6f3ba87e0740af850f'},
 ('cargo', 'want', '0.3.1', 'bfa7760aed19e106de2c7c0b581b509f2f25d3dacaf737cb82ac61bc6d760b0e'): {'a65f5d0a945d267751344c95665945b90c030ea107faf5c85d518929886187da'},
 ('cargo', 'wasi', '0.11.1+wasi-snapshot-preview1', 'ccf3ec651a847eb01de73ccad15eb7d99f80485de043efb2f370cd654f4ea44b'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                                          '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasip2', '1.0.4+wasi-0.2.12', 'b67efb37e106e55ce722a510d6b5f9c17f083e5fc79afc2badeb12cc313d9487'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                                '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                                                                'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-bindgen', '0.2.129', '9bb54f33acc68fd454578d9820b0bde1a1a3d17aa17bb7b6595806d02886d409'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                            'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-bindgen-futures', '0.4.79', '3cbab34de2d982e9b48e18d216d04c4a6f641066ff19ffb699980f591ee3610e'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-bindgen-macro', '0.2.129', '2e29d0c35b16e224a7eeb5cd2d25e3e1968fbd65604117b44d3b789d00ee8535'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                                  'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-bindgen-macro-support', '0.2.129', '6f501a8bc3719dba86ef8ae4728879c08001bea749eb1333ac5b91e040e2a6b7'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-bindgen-shared', '0.2.129', '23f0c9c52aa7cd7d77769a4cfe2a9adb1b331f489a41d912ce14513d5ab995c6'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'wasm-streams', '0.5.0', '9d1ec4f6517c9e11ae630e200b2b65d193279042e28edd4a2cda233e46670bbb'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '62c7a1e35f56406896d7aa7ca52d0cc0d272ac022b5d2796e7d6905db8a3636a'},
 ('cargo', 'web-sys', '0.3.106', '88261b9deccee56594c11a3460c462c41f58d148598fe70ad77070126a68aba4'): {'378f5840b258e2779c39418f3f2d7b2ba96f1c7917dd6be0713f88305dbda397',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'web-time', '1.1.0', '5a6580f308b1fad9207618087a65c04e7a10bc77e02c8e84e9b00dd4b12fa0bb'): {'54a744942eb3fa63a74d8d359989ed6962c04f3f10ff20cfa08ff8aa7efbe4e6',
                                                                                                      'f428305bbf2e70fbd807af0f3c7ac1b7acfb95311640f451e9d2e48db6d7e96b'},
 ('cargo', 'web_atoms', '0.2.6', 'ba8b815c1b593dc0baf78dd0f4fc8fdb2de53198fb1163738093e9a311c33fb3'): {'86dd7f026f916daf7511e39951ad8ea8cf55a8db67ae64060dacf829761c18f3',
                                                                                                       'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'webkit2gtk', '2.0.2', 'a1027150013530fb2eaf806408df88461ae4815a45c541c8975e61d6f2fc4793'): {'3f39c032be4639be635da96d77c4d0f4393c3595a164450ffd86f3d17701ec10'},
 ('cargo', 'webkit2gtk-sys', '2.0.2', '916a5f65c2ef0dfe12fff695960a2ec3d4565359fdbb2e9943c974e06c734ea5'): {'281b72cb008466810da31680e72005b9899c7e9d7705b909c86098260e12aa7d'},
 ('cargo', 'webpki-root-certs', '1.0.9', 'b96554aa2acc8ccdb7e1c9a58a7a68dd5d13bccc69cd124cb09406db612a1c9b'): {'e271993808fec50ab29350b39539cdec611a9103f827e0aa26d61da70e2d33f8'},
 ('cargo', 'webview2-com', '0.39.1', '3f89fca7a704cee10dcb3654c1dbb8941d1783132f1917358af75bec37a7d7e6'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'webview2-com-macros', '0.8.1', '67a921c1b6914c367b2b823cd4cde6f96beec77d30a939c8199bb377cf9b9b54'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'webview2-com-sys', '0.39.1', 'b3a07132775117d6065853d9d1178157b8c90e228de47129d6bce2c7edebedfb'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'winapi', '0.3.9', '5c839a674fcd7a98952e593242ea400abe93992746761e38641405d28b00f419'): {'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1',
                                                                                                    'ce7bc3499fee93d5022ef430d5e4201e79a6d9154f3974e42f41349f0569e09b'},
 ('cargo', 'winapi-i686-pc-windows-gnu', '0.4.0', 'ac3b87c63620426dd9b991e5ce0329eff545bccbbb34f3be09ff6fb6ab51b7b6'): {'5b19674a1db628a475850a131956ed49521b744e3dda8f5a94141f9aba681219',
                                                                                                                        'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'},
 ('cargo', 'winapi-util', '0.1.11', 'c2a7b1c03c876122aa43f3020e6c3c3ee5c05081c9a00739faf7503aeba10d22'): {'cb3c929a05e6cbc9de9ab06a4c57eeb60ca8c724bef6c138c87d3a577e27aa14'},
 ('cargo', 'winapi-x86_64-pc-windows-gnu', '0.4.0', '712e227841d057c1ee1cd2fb22fa7e5a5461ae8e48fa2ca79ec42cfc1931183f'): {'5b19674a1db628a475850a131956ed49521b744e3dda8f5a94141f9aba681219',
                                                                                                                          'b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1'},
 ('cargo', 'window-vibrancy', '0.8.1', '111e51caca442cafd9bab396628ac4d814880eaea4e63dfd76a12e9f342b5580'): {'617b85f62a4f1b6a62d3d9f28f6d7003b7f68a70b7675a8174bbcc68401ac62d',
                                                                                                             'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'windows', '0.62.2', '527fadee13e0c05939a6a05d5bd6eec6cd2e3dbd648b9f8e447c6518133d8580'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                      'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-collections', '0.3.2', '23b2d95af1a8a14a3c7367e1ed4fc9c20e0a26e79551b1454d72583c97cc6610'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-core', '0.62.2', 'b8e83a14d34d0623b51dce9581199302a221863196a1dde71a7663a4c2be9deb'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                           'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-future', '0.3.2', 'e1d6f90251fe18a279739e78025bd6ddc52a7e22f921070ccdc67dde84c605cb'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                            'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-implement', '0.60.2', '053e2e040ab57b9dc951b72c264860db7eb3b0200ba345b4e4c3b14f67855ddf'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-interface', '0.59.3', '3f316c4a2570ba26bbec722032c4099d8c8bc095efccdc15688708623367e358'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-link', '0.2.1', 'f0805222e57f7521d6a62e36fa9163bc891acd422f971defe97d64e70d0a4fe5'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-numerics', '0.3.1', '6e2e40844ac143cdb44aead537bbf727de9b044e107a0f1220392177d15b0f26'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                              'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-registry', '0.6.1', '02752bf7fbdcce7f2a27a742f798510f3e5ad88dbe84871e5168e2120c3d5720'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                              'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-result', '0.4.1', '7781fa89eaf60850ac3d2da7af8e5242a5ea78d1a11c49bf2910bb5a73853eb5'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                            'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-strings', '0.5.1', '7837d08f69c77cf6b07689544538e017c1bfcf57e34b4c0ff58e6c2cd3b37091'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                             'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-sys', '0.45.0', '75283be5efb2831d37ea142365f009c02ec203cd29a3ebecbc093d52315b66d0'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-sys', '0.52.0', '282be5f36a8ce781fad8c8ae18fa3f9beff57ec1b52cb3de0789201425d9a33d'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-sys', '0.59.0', '1e38bc4d79ed67fd075bcc251a1c39b32a1776bbe92e5bef1f0bf1f8c531853b'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-sys', '0.60.2', 'f2f500e4d28234f72040990ec9d39e3a6b950f9f22d3dba18416c35882612bcb'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-sys', '0.61.2', 'ae137229bcbd6cdf0f7b80a31df61766145077ddf49416a728b02cb3921ff3fc'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                          'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-targets', '0.42.2', '8e5180c00cd44c9b1c88adb3693291f1cd93605ded80c250a75d472756b4d071'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                              'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-targets', '0.52.6', '9b724f72796e036ab90c1021d4780d4d3d648aca59e491e6b98e725b84e99973'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                              'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-targets', '0.53.5', '4945f9f551b88e0d65f3db0bc25c33b8acea4d9e41163edf90dcd0b19f9069f3'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                              'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-threading', '0.2.1', '3949bd5b99cafdf1c7ca86b43ca564028dfe27d66958f2470940f73d86d75b37'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                               'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows-version', '0.1.7', 'e4060a1da109b9d0326b7262c8e12c84df67cc0dbc9e33cf49e01ccc2eb63631'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                             'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_gnullvm', '0.42.2', '597a5118570b68bc08d8d59125332c54f1ba9d9adeedeef5b99b02ba2b0698f8'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                      'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_gnullvm', '0.52.6', '32a4622180e7a0ec044bb555404c800bc9fd9ec262ec147edd5989ccd0c02cd3'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                      'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_gnullvm', '0.53.1', 'a9d8416fa8b42f5c947f8482c43e7d89e73a173cead56d044f6a56104a6d1b53'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                      'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_msvc', '0.42.2', 'e08e8864a60f06ef0d0ff4ba04124db8b0fb3be5776a5cd47641e942e58c4d43'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                   'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_msvc', '0.52.6', '09ec2a7bb152e2252b53fa7803150007879548bc709c039df7627cabbd05d469'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                   'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_aarch64_msvc', '0.53.1', 'b9d782e804c2f632e395708e99a94275910eb9100b2114651e04744e9b125006'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                   'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_gnu', '0.42.2', 'c61d927d8da41da96a81f029489353e68739737d3beca43145c8afec9a31a84f'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                               'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_gnu', '0.52.6', '8e9b5ad5ab802e97eb8e295ac6720e509ee4c243f69d781394014ebfe8bbfa0b'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                               'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_gnu', '0.53.1', '960e6da069d81e09becb0ca57a65220ddff016ff2d6af6a223cf372a506593a3'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                               'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_gnullvm', '0.52.6', '0eee52d38c090b3caa76c563b86c3a4bd71ef1a819287c19d586d7334ae8ed66'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                   'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_gnullvm', '0.53.1', 'fa7359d10048f68ab8b09fa71c3daccfb0e9b559aed648a8f95469c27057180c'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                   'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_msvc', '0.42.2', '44d840b6ec649f480a41c8d80f9c65108b92d89345dd94027bfe06ac444d1060'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_msvc', '0.52.6', '240948bc05c5e7c6dabba28bf89d89ffce3e303022809e73deaefe4f6ec56c66'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_i686_msvc', '0.53.1', '1e7ac75179f18232fe9c285163565a57ef8d3c89254a30685b57d83a38d326c2'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnu', '0.42.2', '8de912b8b8feb55c064867cf047dda097f92d51efad5b491dfb98f6bbb70cb36'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnu', '0.52.6', '147a5c80aabfbf0c7d901cb5895d1de30ef2907eb21fbbab29ca94c5b08b1a78'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnu', '0.53.1', '9c3842cdd74a865a8066ab39c8a7a473c0778a3f29370b5fd6b4b9aa7df4a499'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnullvm', '0.42.2', '26d41b46a36d453748aedef1486d5c7a85db22e56aff34643984ea85514e94a3'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                     'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnullvm', '0.52.6', '24d5b23dc417412679681396f2b49f3de8c1473deb516bd34410872eff51ed0d'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                     'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_gnullvm', '0.53.1', '0ffa179e2d07eee8ad8f57493436566c7cc30ac536a3379fdf008f47f6bb7ae1'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                     'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_msvc', '0.42.2', '9aec5da331524158c6d1a4ac0ab1541149c0b9505fde06423b02f5ef0106b9f0'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                  'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_msvc', '0.52.6', '589f6da84c646204747d1270a2a5661ea66ed1cced2631d546fdfb155959f9ec'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                  'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'windows_x86_64_msvc', '0.53.1', 'd6bbff5f0aada427a1e5a6da5f1f98158182f26556f345ac9e04d36d0ebed650'): {'c16f8dcf1a368b83be78d826ea23de4079fe1b4469a0ab9ee20563f37ff3d44b',
                                                                                                                  'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383'},
 ('cargo', 'winnow', '0.5.40', 'f593a95398737aeed53e489c785df13f3618e41dbcd6718c6addbf1395aa6876'): {'cb5aedb296c5246d1f22e9099f925a65146f9f0d6b4eebba97fd27a6cdbbab2d'},
 ('cargo', 'winnow', '1.0.4', '23b97319f7b8343df12cc98938e5c3eb436064524c8d2b4e30a1d3a36eecdf81'): {'cb5aedb296c5246d1f22e9099f925a65146f9f0d6b4eebba97fd27a6cdbbab2d'},
 ('cargo', 'winreg', '0.10.1', '80d0f4e272c85def139476380b12f9ac60926689dd2e01d4923222f40580869d'): {'ea021d8c6383c84d19c15ce90d3b1602cf448fdcc0bf3772c98e43c7bf1bf1d1'},
 ('cargo', 'winreg', '0.55.0', 'cb5a765337c50e9ec252c2069be9bf91c7df47afb103b642ba3a53bf8101be97'): {'ea021d8c6383c84d19c15ce90d3b1602cf448fdcc0bf3772c98e43c7bf1bf1d1'},
 ('cargo', 'wit-bindgen', '0.57.1', '1ebf944e87a7c253233ad6766e082e3cd714b5d03812acc24c318f549614536e'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          '268872b9816f90fd8e85db5a28d33f8150ebb8dd016653fb39ef1f94f2686bc5',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'writeable', '0.6.4', '3ad82d2a33cdc9674dc7465672f271e096168fcdbe0f799d9e6db8c5892679dc'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'wry', '0.57.0', 'a819957a01b3119af85e638a38d242af76dbc87d130dca67bfd0441072e21ff0'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'ef88893533af22ffbb68ceef0724ba1389518df26165a34f3c99ad30b884df4f'},
 ('cargo', 'x11', '2.21.0', '502da5464ccd04011667b11c435cb992822c2c0dbde1770c988480d312a0db2e'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'x11-dl', '2.21.0', '38735924fedd5314a6e548792904ed8c6de6636285cb9fec04d5b1db85c1516f'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'x11rb', '0.13.2', '9993aa5be5a26815fe2c3eacfc1fde061fc1a1f094bf1ad2a18bf9c495dd7414'): {'a72561f47c1f665535930f606739d9098a6186802d5e2e8ec491faf00f4add5b',
                                                                                                    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'x11rb-protocol', '0.13.2', 'ea6fc2961e4ef194dcbfe56bb845534d0dc8098940c7e5c012a258bfec6701bd'): {'a72561f47c1f665535930f606739d9098a6186802d5e2e8ec491faf00f4add5b',
                                                                                                             'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'xattr', '1.6.1', '32e45ad4206f6d2479085147f02bc2ef834ac85886624a23575ae137c8aa8156'): {'8b427f5bc501764575e52ba4f9d95673cf8f6d80a86d0d06599852e1a9a20a36',
                                                                                                   'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'xkeysym', '0.2.1', 'b9cc00251562a284751c9973bace760d86c0276c471b4be569fe6b068ee97a56'): {'319736510aa7dbd6f49546f6ee57c787dbe2c7dfa0507dfbd543375f86a4416d',
                                                                                                     '875e64a5df9f892ebd29c71ad0b58a765b5789d7e9142aa70ec07fae74a67686',
                                                                                                     'd4aca2f5936fa638b062f0585df37eec086ca8620d437b2d6be2c95f01199d1a'},
 ('cargo', 'yoke', '0.8.3', '709fe23a0424b6a435d82152b1bd3fdfb0833487d5fa90d05d42762a9891fef5'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'yoke-derive', '0.8.4', 'ec8ebde2db3681e8c9980cc27822030e68752690ddfa9473e739aeb4dbde6d71'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zbus', '5.19.0', '5db4be7c075cb421e4b7ee645541604239bd243ba7c357511f4ff3a74b555907'): {'260e4ff3fc493695880c90774283eb1e3d018f898fabe655bbd52dd2cbd2fcad'},
 ('cargo', 'zbus_macros', '5.19.0', '2990635d09ade6df1868f72f8cac69a876a90981e8bd3c40b1be413f8dc88f40'): {'260e4ff3fc493695880c90774283eb1e3d018f898fabe655bbd52dd2cbd2fcad'},
 ('cargo', 'zbus_names', '4.3.4', 'd8bf88b4a3ff53e883001e0e0115b297a9d53c31b9c1edd2bfdd853e3428624e'): {'260e4ff3fc493695880c90774283eb1e3d018f898fabe655bbd52dd2cbd2fcad'},
 ('cargo', 'zcheapstr', '1.1.0', 'd1afec51604565183aeb5c54c20aeab286120d4e4460f7f76e3e8bb8c0d99473'): {'59871bb1612f8a0569655c10b995636827eceab42c6578cebdc45ad2922e0142'},
 ('cargo', 'zerofrom', '0.1.8', '0ec05a11813ea801ff6d75110ad09cd0824ddba17dfe17128ea0d5f68e6c5272'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zerofrom-derive', '0.1.8', 'f75b4683f6c7f45248d4d64056a24298c6281e0993356d7d1b4a1a962ef10d4a'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zeroize', '1.9.0', 'e13c156562582aa81c60cb29407084cdb54c4164760106ab78e6c5b0858cf64e'): {'8c7516d4b27b1e495be5e38b612298b63de48d05f49cdac94f70f3cd70f8864b',
                                                                                                     'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'zerotrie', '0.2.5', '4ea269c3bd32f0a32c321907a2ae912ba6f4649bb0fc764a15627e99a7095a3f'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zerovec', '0.11.8', 'bb0464e17806c1d976d5cba29399c7f08e516e279e2ba493f63123b5fca67dd8'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zerovec-derive', '0.11.6', '34df6fc39dbd26ddc9c10e6a2984476e13acce22e64e4487636ef494369225da'): {'f367c1b8e1aa262435251e442901da4607b4650e0e63a026f5044473ecfb90f2'},
 ('cargo', 'zip', '4.6.1', 'caa8cd6af31c3b31c6631b8f483848b91589021b28fffe50adada48d4f4d2ed1'): {'04dc52136d82400b11df5f474949863a70a5d05d2278dec45b99c479494450a6'},
 ('cargo', 'zlib-rs', '0.6.8', 'b268e58e7c693d7c271f93ffc4ba3b380412554231c85bf61ca7af91042a4112'): {'e72111c52b7d96ebe25348dee19f0744f444d3c95ae6b1ecb6ccaecc5bce05ba'},
 ('cargo', 'zmij', '1.0.23', '29666d0abbfad1e3dc4dcf6144730dd3a3ab225bbbdac83319345b1b44ccfc1b'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('cargo', 'zvariant', '5.15.0', 'c1d34c27cc6cdd1f458427519dd6b8612f7b7e3f7b9a0b2355d041dda9869147'): {'260e4ff3fc493695880c90774283eb1e3d018f898fabe655bbd52dd2cbd2fcad'},
 ('cargo', 'zvariant_derive', '5.15.0', '864155e69b4352db0c7f374917bf45d1e0c8d17659c8b3dbf9795f3673f8c497'): {'260e4ff3fc493695880c90774283eb1e3d018f898fabe655bbd52dd2cbd2fcad'},
 ('cargo', 'zvariant_utils', '4.2.0', 'bad0294361a320b694a328460dc73add56c306150f5cb6bfafc44446120008a3'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3'},
 ('npm', '@tauri-apps/api', '2.12.0', 'sha512-fUSxFX8VABYe9W9K5ROdEaKVkNUFRcMSRofjruvaxztXA+I0XnQHcYHF8m/a6iExRUxsUf0HsFWhPBuH9IgzJw=='): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                                                           '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('npm', '@tauri-apps/plugin-deep-link', '2.6.1', 'sha512-yomIOIoiiDwXW3Bgy/V5c4frWo9sfWM9WZQew2s7vr7hXtDdbLDCLzvytIMCjMxbnln9O0oJsTI3XdDd2T9XlA=='): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                                                       '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('npm', '@tauri-apps/plugin-dialog', '2.8.1', 'sha512-/DtE3B62JgpYuWFL5ATXM6KOXUq7pca7cJWOgSqULhZsgyjLk0PWKek1dbRDvhNBW6flNsOfWphsKnb+738Dmw=='): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                                                    '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('npm', '@tauri-apps/plugin-opener', '2.7.0', 'sha512-mBorYfVKh9Lt7s4ZFtKbMUTxBw+Y/sVmSlKCtkkoBgMTC/DIbt/kaPm67L/2djAUqDI1wbixy5OHHVmipjuGMw=='): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                                                    '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('npm', '@xterm/addon-fit', '0.11.0', 'sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g=='): {'e256f01188af527e4d06d21d06fbf785ae9c50d4b328bf03cbe0ba7f0aa4228f'},
 ('npm', '@xterm/addon-search', '0.16.0', 'sha512-9OeuBFu0/uZJPu+9AHKY6g/w0Czyb/Ut0A5t79I4ULoU4IfU5BEpPFVGQxP4zTTMdfZEYkVIRYbHBX1xWwjeSA=='): {'689ceb10716bd7a87a804c14951d7c2b818cbd60aab83d540902470ce3b13444'},
 ('npm', '@xterm/addon-serialize', '0.14.0', 'sha512-uteyTU1EkrQa2Ux6P/uFl2fzmXI46jy5uoQMKEOM0fKTyiW7cSn0WrFenHm5vO5uEXX/GpwW/FgILvv3r0WbkA=='): {'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd'},
 ('npm', '@xterm/headless', '6.0.0', 'sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw=='): {'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd'},
 ('npm', '@xterm/xterm', '6.0.0', 'sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg=='): {'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd'},
 ('npm', 'lucide-react', '0.468.0', 'sha512-6koYRhnM2N0GGZIdXzSeiNwguv1gt/FAjZOiPl76roBi3xKEXa4WmfpxgQwTTL4KipXjefrnf3oV4IsYhi4JFA=='): {'1e7290b35280a048667bbf0ebabac1c7fd52a75300e8b2946ac165715997f2bc'},
 ('npm', 'react', '19.3.0', 'sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'},
 ('npm', 'react-dom', '19.3.0', 'sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'},
 ('npm', 'scheduler', '0.28.0', 'sha512-juorfCmIkIw8tT+p5BXSm6PJjQF/ycEYmKyzURCIt/RaZIhL+PulbQ9Yu2z1HdOJDdqDTlxA1+xKBmHXJsczAw=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'}}
KNOWN_SOURCE_GAPS = set()


# Exact npm archive bodies reviewed for the approved i18n dependencies.
QUALIFIED_BODIES.update({('npm', '@babel/runtime', '7.29.10', 'sha512-NpugTzbKgGrNe45Ui32cN8vCFFMxVtP/9rtfwv0nP5FRDAjvYBxJcLVpYA9mr1jxP6cnIT7x9LUzuDTbWYYNRA=='): {'117da2af0d4ce0fe1c8e19b5cff9dcd806adf973d328d27b11d4448c4ff24f76'}, ('npm', 'html-parse-stringify', '4.0.1', 'sha512-0zHsZJrK7S3K2aucXWL6ycoYJ/iNtIcFHC/nYQgFklPtrv5LpJctIiSCroWZWeuoXvuyFdzp6KzjJQ+OT5MfFw=='): {'3eb2802a4d0ea79f80977817451b056571dccd8373c9bf4e9be4b05f86afbf90'}, ('npm', 'i18next', '26.5.3', 'sha512-6pRwOwJ6lBCBB66fqNZaSoUmvsALHMord7FL6GsDhubT1CrPabTMEJIqddm0nn2YEbKofdI/3VAtGrQPuztY1Q=='): {'1cd0a2b02a6cc40ef8ee16310d13eeffdd7b5de4a562fd3ee7c921d8eb54f60a'}, ('npm', 'react-i18next', '17.1.0', 'sha512-4VouOnTDyvhvqXx6WZ+s3/cgSiaLutILdYkO3P1Ms+4qcKR7At+JP4Vi7IeHkVLyVV+DmN1l23Pn73UcwSGGPA=='): {'29b8ae456ef442e53a98df183ad088cf98c2ece73aa84c462330c43e665b8ab2'}, ('npm', 'typescript', '6.0.3', 'sha512-y2TvuxSZPDyQakkFRPZHKFm+KKVqIisdg9/CZwm9ftvKXLP8NRWj38/ODjNbr43SsoXqNuAisEf1GdCxqWcdBw=='): {'1af3c68039c57e539422da82a4faada506ce6d0ea6f90e0b699d02dbcdb7a90c', 'a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47'}, ('npm', 'use-sync-external-store', '1.7.0', 'sha512-6L+EeigHMQhdaIPNIFUKwfWJSwWFQ8gJbJ2DLOs5sDIegTwR9fRxvnM3uciHKjIZhFz+KAv2emhWMRvDmMcY8A=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'}})

def fail():
    raise ValueError("Invalid notice evidence") from None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def read_regular(path, limit):
    path = Path(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            fail()
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            fail()
        return data
    except (OSError, UnicodeError):
        fail()


def read_json(path):
    try:
        return json.loads(read_regular(path, LOCK_LIMIT).decode("utf-8"))
    except (ValueError, UnicodeError):
        fail()


def inputs(root):
    root = Path(root)
    package = read_json(root / "apps/desktop/package.json")
    declarations = {"dependencies": package.get("dependencies", {}), "optionalDependencies": package.get("optionalDependencies", {})}
    return {"cargo_lock": digest(read_regular(root / "apps/desktop/src-tauri/Cargo.lock", LOCK_LIMIT)),
            "pnpm_lock": digest(read_regular(root / "apps/desktop/pnpm-lock.yaml", LOCK_LIMIT)),
            "declarations": digest(canonical(declarations)),
            "production_graph": digest(canonical(sorted(NPM_EXPECTED,key=lambda item:(item["name"],item["version"]))))}


def cargo_expected(root):
    try:
        lock = tomllib.loads(read_regular(Path(root) / "apps/desktop/src-tauri/Cargo.lock", LOCK_LIMIT).decode("utf-8"))
        package = tomllib.loads(read_regular(Path(root) / "apps/desktop/src-tauri/Cargo.toml", LOCK_LIMIT).decode("utf-8"))["package"]
    except (ValueError, UnicodeError):
        fail()
    result = []
    for item in lock.get("package", []):
        if "source" not in item:
            if item.get("name") == package.get("name") == "yam-desktop" and item.get("version") == package.get("version"):
                continue
            fail()
        if not item["source"].startswith("registry+") or len(item.get("checksum", "")) != 64:
            fail()
        result.append({"ecosystem": "cargo", "name": item["name"], "version": item["version"], "source": item["source"], "checksum": item["checksum"]})
    if len(result) > IDENTITY_LIMIT:
        fail()
    return result


def identity(record):
    return tuple(record[key] for key in ["ecosystem", "name", "version", "source", "checksum"])


def expected(root):
    current = inputs(root)
    if any(current[key] != value for key, value in NPM_INPUTS.items()):
        fail()
    return cargo_expected(root) + [{"ecosystem": "npm", **entry} for entry in NPM_EXPECTED]


def body_path(root, sha):
    root = Path(root).resolve()
    for relative in ["scripts", "scripts/third-party-notices", "scripts/third-party-notices/bodies"]:
        if (root / relative).is_symlink():
            fail()
    if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        fail()
    return Path(root) / "scripts/third-party-notices/bodies" / sha


def atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".yam-notice-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def store_body(root, data, provenance):
    if not isinstance(data, bytes) or not data or len(data) > BODY_LIMIT:
        fail()
    try:
        text = data.decode("utf-8")
    except UnicodeError:
        fail()
    if not text.strip():
        fail()
    sha = digest(data)
    destination = body_path(root, sha)
    if destination.exists():
        if read_regular(destination, BODY_LIMIT) != data:
            fail()
    else:
        atomic_write(destination, data)
    return {"sha256": sha, "bytes": len(data), "provenance": provenance}


def charge(budget, size):
    # Accepted selected/extracted bytes; collection also conservatively charges metadata.
    if type(size) is not int or size < 0 or budget[0] + size > SELECTED_LIMIT:
        fail()
    budget[0] += size


def material_read(path, budget):
    try:
        info = Path(path).lstat()
    except OSError:
        fail()
    if not stat.S_ISREG(info.st_mode) or info.st_size > BODY_LIMIT:
        fail()
    charge(budget, info.st_size)
    data = read_regular(path, info.st_size)
    if len(data) != info.st_size:
        fail()
    return data


def member_read(archive, member, budget):
    if not member.isfile() or member.size > BODY_LIMIT:
        fail()
    charge(budget, member.size)
    with archive.extractfile(member) as stream:
        data = stream.read(member.size + 1)
    if len(data) != member.size:
        fail()
    return data


def make_manifest(root, records, *, additional):
    # Content-checked candidate only; collect/render/package must pass independent approval.
    if len(records) > IDENTITY_LIMIT:
        fail()
    total = 0
    result = []
    for raw in records:
        entry = {key: raw[key] for key in ["ecosystem", "name", "version", "source", "checksum", "license", "gap"]}
        for kind in ["bodies", "supplemental"]:
            entry[kind] = []
            for index, data in enumerate(raw.get(kind, [])):
                total += len(data)
                if total > SELECTED_LIMIT:
                    fail()
                provenance = raw.get("provenance", {}).get(kind, [])
                source = provenance[index] if index < len(provenance) else {"kind": "explicit_source_bytes"}
                entry[kind].append(store_body(root, data, source))
        result.append(entry)
    extra = []
    for raw in additional:
        total += len(raw["body"])
        if total > SELECTED_LIMIT:
            fail()
        extra.append({"name": raw["name"], "version": raw["version"], "body": store_body(root, raw["body"], raw["provenance"])})
    manifest = {"schema": SCHEMA, "inputs": inputs(root), "records": sorted(result, key=identity), "additional": extra}
    _validate_contents(root, manifest)
    return manifest


def validate(root, manifest):
    try:
        inventory = canonical(manifest)
    except (TypeError, ValueError):
        fail()
    if len(inventory) > LOCK_LIMIT or digest(inventory) != APPROVED_MANIFEST_SHA256:
        fail()
    _validate_contents(root, manifest)


def _validate_contents(root, manifest):
    if not isinstance(manifest, dict) or set(manifest) != {"schema", "inputs", "records", "additional"} or type(manifest["schema"]) is not int or manifest["schema"] != SCHEMA:
        fail()
    if manifest["inputs"] != inputs(root):
        fail()
    wanted = {identity(entry) for entry in expected(root)}
    records = manifest["records"]
    if not isinstance(records, list) or len(records) > IDENTITY_LIMIT:
        fail()
    try:
        observed = [identity(entry) for entry in records]
    except (KeyError, TypeError):
        fail()
    if len(set(observed)) != len(observed) or set(observed) != wanted:
        fail()
    descriptors = []
    budget = [0]
    for entry in records:
        if set(entry) != {"ecosystem", "name", "version", "source", "checksum", "license", "gap", "bodies", "supplemental"}:
            fail()
        if not isinstance(entry["license"], str) or not entry["license"].strip():
            fail()
        if entry["gap"] is not None and (not isinstance(entry["gap"], str) or not entry["gap"] or len(entry["gap"]) > 256):
            fail()
        if not isinstance(entry["bodies"],list) or not isinstance(entry["supplemental"],list):
            fail()
        qualified=QUALIFIED_BODIES.get((entry["ecosystem"],entry["name"],entry["version"],entry["checksum"]),set())
        try:
            observed_full={body["sha256"] for body in entry["bodies"]}
        except (KeyError,TypeError):
            fail()
        if observed_full - qualified or (entry["gap"] is None and (not qualified or not qualified.issubset(observed_full))):
            fail()
        for descriptor in entry["bodies"] + entry["supplemental"]:
            charge(budget, descriptor_size(root, descriptor))
            descriptors.append(descriptor)
    if not isinstance(manifest["additional"],list) or len(manifest["additional"]) > 16:
        fail()
    for entry in manifest["additional"]:
        if set(entry) != {"name", "version", "body"}:
            fail()
        charge(budget, descriptor_size(root, entry["body"]))
        descriptors.append(entry["body"])
    # Preflight all repeated mappings before any body content is read.
    for descriptor in descriptors:
        validate_body(root, descriptor)


def descriptor_size(root, descriptor):
    if not isinstance(descriptor, dict) or set(descriptor) != {"sha256", "bytes", "provenance"} or not isinstance(descriptor["provenance"], dict) or type(descriptor["bytes"]) is not int or descriptor["bytes"] <= 0:
        fail()
    if len(canonical(descriptor["provenance"])) > 16384:
        fail()
    if descriptor["bytes"] > BODY_LIMIT:
        fail()
    body_path(root, descriptor["sha256"])
    return descriptor["bytes"]


def validate_body(root, descriptor):
    descriptor_size(root, descriptor)
    content = read_regular(body_path(root, descriptor["sha256"]), BODY_LIMIT)
    if len(content) != descriptor["bytes"] or digest(content) != descriptor["sha256"]:
        fail()
    try:
        if not content.decode("utf-8").strip():
            fail()
    except UnicodeError:
        fail()
    return len(content)


def render(root, manifest, *, mode):
    if mode not in {"developer", "release"}:
        fail()
    validate(root, manifest)
    gaps = sorted(entry["ecosystem"] + ":" + entry["name"] + "@" + entry["version"] + ": " + entry["gap"] for entry in manifest["records"] if entry["gap"] is not None)
    if mode == "release" and gaps:
        fail()
    title = b"DEVELOPER-INCOMPLETE NOTICES - NOT A FORMAL RELEASE ARTIFACT\n" if mode == "developer" else b"THIRD-PARTY NOTICES - mechanical source/body integrity only\n"
    chunks = []
    budget = [0]
    def append(chunk):
        charge(budget, len(chunk))
        chunks.append(chunk)
    def append_body(descriptor):
        charge(budget, descriptor["bytes"])
        data = read_regular(body_path(root, descriptor["sha256"]), descriptor["bytes"])
        if len(data) != descriptor["bytes"] or digest(data) != descriptor["sha256"]:
            fail()
        chunks.append(data)
    append(title)
    append(("Selected: %d; covered: %d\n" % (len(manifest["records"]), len(manifest["records"]) - len(gaps))).encode())
    if gaps:
        append(("GAPS\n" + "\n".join(gaps) + "\n").encode("utf-8"))
    for entry in sorted(manifest["records"], key=identity):
        append(("\n" + entry["name"] + " " + entry["version"] + "\n").encode("utf-8"))
        for body in entry["bodies"] + entry["supplemental"]:
            append_body(body)
            append(b"\n")
    for entry in manifest["additional"]:
        append(("\n" + entry["name"] + " " + entry["version"] + "\n").encode("utf-8"))
        append_body(entry["body"])
        append(b"\n")
    result = b"".join(chunks)
    report = {"schema": SCHEMA, "mode": mode, "complete": not gaps, "release_eligible": mode == "release" and not gaps, "selected": len(manifest["records"]), "covered": len(manifest["records"]) - len(gaps), "gaps": gaps, "inputs": manifest["inputs"], "manifest_sha256": digest(canonical(manifest)), "notices_sha256": digest(result), "implementation_sha256": digest(read_regular(__file__, BODY_LIMIT))}
    return result, report


def archive_record(path, *, name, version, checksum, budget=None):
    budget = [0] if budget is None else budget
    data = read_regular(path, ARCHIVE_LIMIT)
    if digest(data) != checksum:
        fail()
    selected = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            count = 0
            names = set()
            for member in archive:
                count += 1
                parts = member.name.rstrip("/").split("/") if member.isdir() else member.name.split("/")
                if count > HEADER_LIMIT or not parts or parts[0] != name + "-" + version or any(p in {"..", ".", ""} for p in parts) or member.name.startswith("/") or "\\" in member.name or member.name in names:
                    fail()
                names.add(member.name)
                if not (member.isfile() or member.isdir()):
                    fail()
                relative = "/".join(parts[1:])
                base = parts[-1].upper()
                if relative == "Cargo.toml" or base.startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE", "COPYRIGHT")):
                    selected[relative] = member_read(archive, member, budget)
    except (tarfile.TarError, OSError):
        fail()
    try:
        metadata = tomllib.loads(selected["Cargo.toml"].decode("utf-8"))["package"]
        if metadata["name"] != name or metadata["version"] != version:
            fail()
    except (ValueError, KeyError, UnicodeError):
        fail()
    declared = metadata.get("license", "publisher-license-file" if metadata.get("license-file") else "undeclared")
    bodies, supplemental, provenance = [], [], {"bodies": [], "supplemental": []}
    license_file = metadata.get("license-file")
    for member, content in sorted(selected.items()):
        if member == "Cargo.toml":
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeError:
            fail()
        if not text.strip():
            continue
        # A named candidate is not automatically complete text. Explicit publisher license-file
        # is a source qualification; declaration-only SPDX candidates remain supplemental.
        full = member == license_file and not member.lower().endswith(".spdx") and not text.lstrip().startswith("SPDX-License-Identifier:")
        kind = "bodies" if full else "supplemental"
        (bodies if full else supplemental).append(content)
        provenance[kind].append({"kind": "checksum_verified_crate_member", "archive_sha256": checksum, "member": name + "-" + version + "/" + member})
    return {"ecosystem": "cargo", "name": name, "version": version, "source": "registry+https://github.com/rust-lang/crates.io-index", "checksum": checksum, "license": declared, "bodies": bodies, "supplemental": supplemental, "provenance": provenance, "gap": None if bodies else "full_text_source_classification_unresolved"}


def prepare(root, mode):
    manifest = read_json(Path(root) / "scripts/third-party-notices/manifest.json")
    extra=manifest.get("additional")
    expected = [("Node", "26.10.0", NODE_BODY_SHA256)]
    # The approved inventory binds all target/vendor additions; the one-row form
    # remains available to existing isolated collection fixtures.
    if isinstance(extra, list) and len(extra) == 3:
        expected.extend([
            ("Node Windows x64", "26.10.0", "168f764dbef057a171bca4f00e11c4714e8e532e7ed63c0289bee35649b9c395"),
            ("VS Code portions in xterm", "vendored-at-f447274f430fd22513f6adbf9862d19524471c04", "9480271317925265e806a9a196aaa33410a962fa9d4d1e248a4a5187bc8c9df9"),
        ])
    if not isinstance(extra, list) or [(row.get("name"), row.get("version"), row.get("body", {}).get("sha256")) for row in extra] != expected:
        fail()
    content, report = render(root, manifest, mode=mode)
    return content, report


def report_for_binary(report, binary):
    return {**report, "runtime_sha256": digest(read_regular(binary, ARCHIVE_LIMIT))}


def validate_packaged(root, resources):
    resources = Path(resources)
    content, expected_report = prepare(root, "release")
    report = read_json(resources / "THIRD-PARTY-NOTICES.report.json")
    if not isinstance(report, dict) or set(report) != set(expected_report) | {"runtime_sha256"}:
        fail()
    binary = resources / ("yam-terminal.exe" if (resources / "yam-terminal.exe").exists() else "yam-terminal")
    if report != report_for_binary(expected_report, binary) or read_regular(resources / "THIRD-PARTY-NOTICES.txt", SELECTED_LIMIT) != content:
        fail()
    return report


def graph_output(argv, *, limit=LOCK_LIMIT, timeout=30, cwd=None):
    # Drain both pipes incrementally. Do not communicate/capture an unbounded graph first.
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd)
    stopped = threading.Event()
    guard = threading.Lock()
    length = 0
    output = bytearray()
    errors = []
    def consume(pipe, keep):
        nonlocal length
        try:
            while not stopped.is_set():
                chunk = pipe.read(65536)
                if not chunk:
                    return
                with guard:
                    length += len(chunk)
                    if length > limit:
                        errors.append(True)
                        stopped.set()
                    elif keep:
                        output.extend(chunk)
                if stopped.is_set():
                    process.kill()
        except OSError:
            errors.append(True)
            stopped.set()
        finally:
            pipe.close()
    readers = [threading.Thread(target=consume, args=(process.stdout, True), daemon=True),
               threading.Thread(target=consume, args=(process.stderr, False), daemon=True)]
    deadline = time.monotonic() + timeout
    for reader in readers:
        reader.start()
    try:
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        stopped.set()
        process.kill()
        process.wait(timeout=1)
        errors.append(True)
    for reader in readers:
        reader.join(max(0, deadline - time.monotonic()))
    if errors or any(reader.is_alive() for reader in readers) or process.returncode != 0:
        stopped.set()
        if process.poll() is None:
            process.kill()
        fail()
    try:
        return bytes(output).decode("utf-8")
    except UnicodeError:
        fail()


def verify_build_sources(root, frontend_licenses):
    manifest = read_json(Path(root) / "scripts/third-party-notices/manifest.json")
    for text in frontend_licenses:
        header, body = text.split("\n", 1)
        name, version = header.rsplit(" ", 1)
        rows = [row for row in manifest["records"] if row["ecosystem"] == "npm" and row["name"] == name and row["version"] == version]
        if len(rows) != 1 or digest(body.encode("utf-8")) not in [b["sha256"] for b in rows[0]["bodies"] + rows[0]["supplemental"]]:
            fail()


def verify_additional_source(root, body):
    manifest = read_json(Path(root) / "scripts/third-party-notices/manifest.json")
    rows = [row for row in manifest["additional"] if row["name"] in {"Node", "Node Windows x64"} and row["version"] == "26.10.0" and row["body"]["sha256"] == digest(body)]
    if len(rows) != 1:
        fail()


def npm_archive_record(path, entry, *, budget=None):
    budget = [0] if budget is None else budget
    data = read_regular(path, ARCHIVE_LIMIT)
    actual_sri = "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode("ascii")
    if actual_sri != entry["checksum"]:
        fail()
    selected = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            seen = set()
            for index, member in enumerate(archive):
                parts = member.name.rstrip("/").split("/") if member.isdir() else member.name.split("/")
                if index >= HEADER_LIMIT or parts[0] != "package" or any(part in {".", "..", ""} for part in parts) or "\\" in member.name or member.name in seen or not (member.isfile() or member.isdir()):
                    fail()
                seen.add(member.name)
                relative = "/".join(parts[1:])
                base = parts[-1].upper()
                # Verified Lucide icon implementation/source map are code, not notices.
                if relative in {"dist/esm/icons/copyright.js", "dist/esm/icons/copyright.js.map"}:
                    continue
                if relative == "package.json" or base == "THIRDPARTYNOTICETEXT.TXT" or base.startswith(("LICENSE", "LICENCE", "NOTICE", "COPYING", "COPYRIGHT")):
                    selected[relative] = member_read(archive, member, budget)
    except (tarfile.TarError, OSError):
        fail()
    try:
        metadata_bytes = selected.pop("package.json")
        metadata = json.loads(metadata_bytes.decode("utf-8"))
        if metadata.get("name") != entry["name"] or metadata.get("version") != entry["version"] or not isinstance(metadata.get("license"), str) or not metadata["license"].strip():
            fail()
    except (KeyError, ValueError, UnicodeError):
        fail()
    record = {"ecosystem":"npm", **entry, "_metadata_sha256":digest(metadata_bytes), "license":metadata["license"], "bodies":[], "supplemental":[], "provenance":{"bodies":[], "supplemental":[]}, "gap":None}
    for member, content in sorted(selected.items()):
        try:
            text = content.decode("utf-8")
        except UnicodeError:
            fail()
        if not text.strip():
            continue
        lower = text.lower()
        full = not member.lower().endswith(".spdx") and any(marker in lower for marker in ["permission is hereby granted", "apache license", "redistribution and use in source and binary forms", "permission to use, copy, modify"])
        kind = "bodies" if full else "supplemental"
        record[kind].append(content)
        record["provenance"][kind].append({"kind":"sri_verified_npm_member", "sri":actual_sri, "archive_sha256":digest(data), "source":entry["source"], "member":"package/"+member})
    if not record["bodies"]:
        record["gap"] = "package_specific_full_text_unavailable"
    return record



def qualify_record(record):
    key = (record["ecosystem"], record["name"], record["version"], record["checksum"])
    qualified = QUALIFIED_BODIES.get(key, set())
    available = {digest(body) for body in record["bodies"] + record["supplemental"]}
    if qualified and not qualified.issubset(available):
        fail()
    original = list(zip(record["supplemental"], record["provenance"]["supplemental"]))
    record["supplemental"] = []
    record["provenance"]["supplemental"] = []
    for body, source in original:
        kind = "bodies" if digest(body) in qualified else "supplemental"
        record[kind].append(body)
        record["provenance"][kind].append(source)
    if qualified:
        record["gap"] = None


def collect(root, bridge, npm_receipt, additional):
    root = Path(root).resolve()
    wanted = expected(root)
    cargo_rows = bridge["cargo"]["identities"]
    npm_rows = bridge["npm"]["identities"]
    if {(row["identity"]["name"], row["identity"]["version"], row["identity"]["source"], row["identity"]["checksum"]) for row in cargo_rows} != {(row["name"], row["version"], row["source"], row["checksum"]) for row in wanted if row["ecosystem"] == "cargo"}:
        fail()
    npm_keys = {(row["name"], row["version"]) for row in NPM_EXPECTED}
    if len(npm_rows) != len(npm_keys) or {(row["identity"]["name"], row["identity"]["version"]) for row in npm_rows} != npm_keys:
        fail()
    try:
        graph = json.loads(graph_output(["pnpm", "list", "--prod", "--depth", "Infinity", "--json"], cwd=root / "apps/desktop"))
    except (ValueError, OSError):
        fail()
    installed = set()
    installed_paths = {}
    def walk(node, depth=0):
        if depth > 64 or not isinstance(node, dict):
            fail()
        for group in ["dependencies", "optionalDependencies"]:
            for name, entry in node.get(group, {}).items():
                if not isinstance(entry, dict) or not isinstance(entry.get("version"), str):
                    fail()
                installed.add((name, entry["version"]))
                frozen_source = next((item["source"] for item in NPM_EXPECTED if item["name"] == name and item["version"] == entry["version"]), None)
                if "resolved" in entry and entry["resolved"] != frozen_source:
                    fail()
                installed_paths[(name, entry["version"])] = entry.get("path", str(root / "apps/desktop/node_modules" / name))
                if len(installed) > IDENTITY_LIMIT:
                    fail()
                walk(entry, depth + 1)
    if not isinstance(graph, list) or len(graph) != 1:
        fail()
    walk(graph[0])
    if installed != npm_keys:
        fail()
    budget = [0]
    for extra in additional:
        charge(budget, len(extra["body"]))
    records = []
    for row in cargo_rows:
        entry = row["identity"]
        record = archive_record(row["archive"]["path"], name=entry["name"], version=entry["version"], checksum=entry["checksum"], budget=budget)
        # Unclassified historical upstream candidates remain supplemental, even when exact.
        for hint in row.get("body_candidates", []) + row.get("follow_up_candidate_bodies", []):
            path = hint.get("source_path")
            if not path or not hint.get("upstream_url"):
                continue
            body = material_read(path, budget)
            if digest(body) != hint["sha256"] or len(body) != hint["bytes"]:
                fail()
            if body not in record["bodies"] + record["supplemental"]:
                record["supplemental"].append(body)
                record["provenance"]["supplemental"].append({"kind":"exact_revision_unqualified_candidate", "url":hint["upstream_url"], "revision":hint.get("revision"), "sha256":hint["sha256"]})
        qualify_record(record)
        if record["gap"] is not None:
            key=("cargo",record["name"],record["version"],record["checksum"])
            record["gap"]="known_exact_source_or_full_text_gap" if key in KNOWN_SOURCE_GAPS else "archive_body_classification_unreviewed"
        records.append(record)
    receipts = {(row["name"], row["version"]):row for row in npm_receipt["records"]}
    if set(receipts) != npm_keys:
        fail()
    hints = {(row["identity"]["name"], row["identity"]["version"]):row for row in npm_rows}
    for entry in NPM_EXPECTED:
        key = (entry["name"], entry["version"])
        receipt = receipts[key]
        if receipt.get("source_url", entry["source"]) != entry["source"] or receipt.get("lock_sri", entry["checksum"]) != entry["checksum"]:
            fail()
        record = npm_archive_record(receipt["archive"], entry, budget=budget)
        installed_path = Path(installed_paths[key]).resolve()
        if not installed_path.is_relative_to((root / "apps/desktop/node_modules").resolve()):
            fail()
        metadata_bytes = read_regular(installed_path / "package.json", BODY_LIMIT)
        if digest(metadata_bytes) != record["_metadata_sha256"]:
            fail()
        try:
            metadata = json.loads(metadata_bytes.decode("utf-8"))
        except (ValueError, UnicodeError):
            fail()
        if metadata.get("name") != entry["name"] or metadata.get("version") != entry["version"]:
            fail()
        for hint in hints[key].get("body_sources", []):
            path = Path(hint["path"])
            if not path.is_absolute():
                path = root / path
            body = material_read(path, budget)
            if digest(body) != hint["sha256"]:
                fail()
            if body not in record["bodies"] + record["supplemental"]:
                record["supplemental"].append(body)
                record["provenance"]["supplemental"].append({"kind":"prepared_source_attribution", "sha256":hint["sha256"], "revision":hint.get("immutable_revision"), "source":hint.get("source_url")})
        qualify_record(record)
        if record["gap"] is not None:
            record["gap"]="package_specific_source_applicability_unproven" if entry["name"] in {"@xterm/headless","@xterm/addon-serialize"} else "spdx_declaration_only_no_full_text"
        records.append(record)
    candidate = make_manifest(root, records, additional=additional)
    validate(root, candidate)
    return candidate



def node_additional(root, archive):
    archive = Path(archive)
    checksums = read_json(Path(root) / "scripts/node-runtime-checksums.json")
    data = read_regular(archive, ARCHIVE_LIMIT)
    if archive.name not in checksums or digest(data) != checksums[archive.name] or not archive.name.startswith("node-v26.10.0-"):
        fail()
    prefix = archive.name.removesuffix(".tar.gz")
    try:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as bundle:
            member = bundle.getmember(prefix + "/LICENSE")
            body = member_read(bundle, member, [0])
    except (tarfile.TarError, OSError, KeyError):
        fail()
    return {"name":"Node", "version":"26.10.0", "body":body, "provenance":{"kind":"official_node_checksum_verified_archive", "archive_sha256":digest(data), "member":prefix+"/LICENSE", "url":"https://nodejs.org/dist/v26.10.0/"+archive.name}}


def main():
    parser = argparse.ArgumentParser(description="Offline mechanical notice provenance; not legal approval")
    commands = parser.add_subparsers(dest="operation", required=True)
    collection = commands.add_parser("collect")
    collection.add_argument("--bridge", type=Path, required=True)
    collection.add_argument("--npm-receipt", type=Path, required=True)
    collection.add_argument("--node-archive", type=Path, required=True)
    rendering = commands.add_parser("render")
    rendering.add_argument("--notice-mode", choices=["developer", "release"], required=True)
    rendering.add_argument("--output", type=Path, required=True)
    checking = commands.add_parser("validate-packaged")
    checking.add_argument("--resources", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if args.operation == "collect":
        manifest = collect(root, read_json(args.bridge), read_json(args.npm_receipt), [node_additional(root,args.node_archive)])
        atomic_write(root / "scripts/third-party-notices/manifest.json", canonical(manifest))
    elif args.operation == "render":
        content, report = prepare(root, args.notice_mode)
        atomic_write(args.output, content)
        atomic_write(args.output.with_suffix(".report.json"), canonical(report))
    else:
        validate_packaged(root, args.resources)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError):
        raise SystemExit("Invalid notice evidence") from None
