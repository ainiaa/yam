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
# Independent R2 full-inventory approval, updated for reviewed material batch01 including supplemental mappings.
# Collection never updates this approval; future material changes require separate review.
APPROVED_MANIFEST_SHA256 = '5ac6bbac9a05d4ae000487e98abf9f5f7db1ef42f58e1bd6d481615e688b654e'
NPM_EXPECTED = [{'name': '@tauri-apps/api', 'version': '2.12.0', 'source': 'https://registry.npmjs.org/@tauri-apps/api/-/api-2.12.0.tgz', 'checksum': 'sha512-fUSxFX8VABYe9W9K5ROdEaKVkNUFRcMSRofjruvaxztXA+I0XnQHcYHF8m/a6iExRUxsUf0HsFWhPBuH9IgzJw=='}, {'name': '@tauri-apps/plugin-deep-link', 'version': '2.6.1', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-deep-link/-/plugin-deep-link-2.6.1.tgz', 'checksum': 'sha512-yomIOIoiiDwXW3Bgy/V5c4frWo9sfWM9WZQew2s7vr7hXtDdbLDCLzvytIMCjMxbnln9O0oJsTI3XdDd2T9XlA=='}, {'name': '@tauri-apps/plugin-dialog', 'version': '2.8.1', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-dialog/-/plugin-dialog-2.8.1.tgz', 'checksum': 'sha512-/DtE3B62JgpYuWFL5ATXM6KOXUq7pca7cJWOgSqULhZsgyjLk0PWKek1dbRDvhNBW6flNsOfWphsKnb+738Dmw=='}, {'name': '@tauri-apps/plugin-opener', 'version': '2.7.0', 'source': 'https://registry.npmjs.org/@tauri-apps/plugin-opener/-/plugin-opener-2.7.0.tgz', 'checksum': 'sha512-mBorYfVKh9Lt7s4ZFtKbMUTxBw+Y/sVmSlKCtkkoBgMTC/DIbt/kaPm67L/2djAUqDI1wbixy5OHHVmipjuGMw=='}, {'name': '@xterm/addon-fit', 'version': '0.11.0', 'source': 'https://registry.npmjs.org/@xterm/addon-fit/-/addon-fit-0.11.0.tgz', 'checksum': 'sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g=='}, {'name': '@xterm/addon-serialize', 'version': '0.14.0', 'source': 'https://registry.npmjs.org/@xterm/addon-serialize/-/addon-serialize-0.14.0.tgz', 'checksum': 'sha512-uteyTU1EkrQa2Ux6P/uFl2fzmXI46jy5uoQMKEOM0fKTyiW7cSn0WrFenHm5vO5uEXX/GpwW/FgILvv3r0WbkA=='}, {'name': '@xterm/headless', 'version': '6.0.0', 'source': 'https://registry.npmjs.org/@xterm/headless/-/headless-6.0.0.tgz', 'checksum': 'sha512-5Yj1QINYCyzrZtf8OFIHi47iQtI+0qYFPHmouEfG8dHNxbZ9Tb9YGSuLcsEwj9Z+OL75GJqPyJbyoFer80a2Hw=='}, {'name': '@xterm/xterm', 'version': '6.0.0', 'source': 'https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz', 'checksum': 'sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg=='}, {'name': 'lucide-react', 'version': '0.468.0', 'source': 'https://registry.npmjs.org/lucide-react/-/lucide-react-0.468.0.tgz', 'checksum': 'sha512-6koYRhnM2N0GGZIdXzSeiNwguv1gt/FAjZOiPl76roBi3xKEXa4WmfpxgQwTTL4KipXjefrnf3oV4IsYhi4JFA=='}, {'name': 'react', 'version': '19.3.0', 'source': 'https://registry.npmjs.org/react/-/react-19.3.0.tgz', 'checksum': 'sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog=='}, {'name': 'react-dom', 'version': '19.3.0', 'source': 'https://registry.npmjs.org/react-dom/-/react-dom-19.3.0.tgz', 'checksum': 'sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q=='}, {'name': 'scheduler', 'version': '0.28.0', 'source': 'https://registry.npmjs.org/scheduler/-/scheduler-0.28.0.tgz', 'checksum': 'sha512-juorfCmIkIw8tT+p5BXSm6PJjQF/ycEYmKyzURCIt/RaZIhL+PulbQ9Yu2z1HdOJDdqDTlxA1+xKBmHXJsczAw=='}]

NPM_INPUTS = {"pnpm_lock": "e17abb847e2c95b7ad8965ee8d08daa26338a74d0774369385a5498961b6b48a", "declarations": "97a26697e985746ddbfafef6c2229b71263aeddb2b622633fa6a1464f761faeb"}
# Exact identity/checksum/body qualifications from reviewed immutable preparation.
# Remaining candidate filenames and SPDX declarations do not qualify.
QUALIFIED_BODIES = {('cargo', 'alloc-stdlib', '0.3.0', '0b5c1865780388bfa186411ab5f247819487fc4864c6e9c3106611fa347586e1'): {'c0c56f26d9c051cac4d200c34c84e7ae9aaa853e01a982a1df08b09931e518ae'},
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
 ('cargo', 'atomic-waker', '1.1.2', '1505bd5d3d116872e7271a6d4e16d81d0c8570876c8de68093a09ac269d8aac0'): {'23f18e03dc49df91622fe2a76176497404e46ced8a715d9d2b67a7446571cca3',
                                                                                                          'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'autocfg', '1.5.1', 'f2032f911046de80f0a198e0901378627c33f59ea0ac00e363d481118bd70a53'): {'27995d58ad5c1145c1a8cd86244ce844886958a35eb2b78c6b772748669999ac',
                                                                                                     'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'defmt-parser', '1.0.0', '10d60334b3b2e7c9d91ef8150abfb6fa4c1c39ebbcf4a81c2e346aad939fee3e'): {'2710a622a896bba67356913d4d0492cab5465f61b2ecce6d880aeb483834fb50',
                                                                                                          '8173d5c29b4f956d532781d2b86e4e30f83e6b7878dce18c919451d6ba707c90'},
 ('cargo', 'dlopen2', '0.8.2', '5e2c5bd4158e66d1e215c49b837e11d62f3267b30c92f1d171c4d3105e3dc4d4'): {'39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2'},
 ('cargo', 'dlopen2_derive', '0.4.3', '0fbbb781877580993a8707ec48672673ec7b81eeba04cfd2310bd28c08e47c8f'): {'39fa265207450e77c62e90c5594a06c085b655d8374c7ced4bf7894b6bd95dd2'},
 ('cargo', 'gethostname', '1.1.0', '1bd49230192a3797a9a4d6abe9b3eed6f7fa4c8a8a4947977c6f80025f92cbd8'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'global-hotkey', '0.8.0', '8c386b0a4a70cb2d39fffd74480f985b6f0bfbcb934b6a6b6b7e630e448f242e'): {'2ab5537b8c0cb1d475e2145b6a7994b04e7c71e6e5bd836f7f9c47c221a5ad9a',
                                                                                                           'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2'},
 ('cargo', 'jni', '0.21.1', '1a87aa2bb7d2af34197c04845522473242e1aa17c12f4935d5856491a7fb8c97'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni', '0.22.4', '5efd9a482cf3a427f00d6b35f14332adc7902ce91efb778580e180ff90fa3498'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                  'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni-macros', '0.22.4', 'a00109accc170f0bdb141fed3e393c565b6f5e072365c3bd58f5b062591560a3'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                         'fea1d5bf3dd71605ce5d7d2ff695c1837e914c77195e523a86b5391716477960'},
 ('cargo', 'jni-sys-macros', '0.4.1', '38c0b942f458fe50cdac086d2f946512305e5631e720728f2a61aabcd47a6264'): {'1d85bd754b04ceec93e98e890edd1fa3c6a22e81bcb32135806beeccefa51cd1',
                                                                                                            'c6596eb7be8581c18be736c846fb9173b69eccf6ef94c5135893ec56bd92ba08'},
 ('cargo', 'keyboard-types', '0.7.0', 'b750dcadc39a09dbadd74e118f6dd6598df77fa01df0cfcdc52c28dece74528a'): {'31dbbab009f1b2e59a1622d5955dfafc38ebe834000215b49d954c6f85fe927c',
                                                                                                            '769f80b5bcb42ed0af4e4d2fd74e1ac9bf843cb80c5a29219d1ef3544428a6bb'},
 ('cargo', 'libappindicator-sys', '0.9.0', '6e9ec52138abedcc58dc17a7c6c0c00a2bdb4f3427c7f63fa97fd0d859155caf'): {'a60eea817514531668d7e00765731449fe14d059d3249e0bc93b36de45f759f2',
                                                                                                                 'eb227437252b2a7a9c1fc342c93ade1f3d7ce38cc6dd754f613db07d53ceff0b'},
 ('cargo', 'ndk', '0.9.0', 'c3f42e7bbe13d351b6bead8286a43aac9534b82bd3cc43e47037f012ebfd62d4'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'ndk-context', '0.1.1', '27b02d87554356db9e9a873add8782d4ea6e3e58ea071a9adb9a2e8ddb884a8b'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                         'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'ndk-sys', '0.6.0+11769913', 'ee6cda3051665f1fb8d9e08fc35c96d5a244fb1be711a03b71118828afc9a873'): {'508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1',
                                                                                                              'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'plist', '1.10.1', '2896bade328c13f7042a297ea5ac5b0951f6cf989dea5f32c2fd98da398195cb'): {'5b0ae40d1a35f7ae6591a28e44771240e6a88cb03a66c9189a45b9681639b466'},
 ('cargo', 'rustls-platform-verifier-android', '0.2.0', 'eec689c0bc40ff2458a5977b6619cb718087084a18e02a131c599b62d05e1a5f'): {'1c7cf76689c837a68ed8d704994e52a0f2940c087958f860d17f3186afbdcc0c',
                                                                                                                              'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'},
 ('cargo', 'tauri-plugin', '2.7.0', 'c9ff3ebb9fda56ceb93d46f6cbb126bae82951bf43498543a5163dde5def49a1'): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                          '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('cargo', 'tauri-plugin-global-shortcut', '2.4.0', '0bd2e1f725891a1613af8f25bf918ba3357654b0fd3f2d794c0ce76cbdd92ed2'): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                          '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('cargo', 'webview2-com', '0.39.1', '3f89fca7a704cee10dcb3654c1dbb8941d1783132f1917358af75bec37a7d7e6'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'webview2-com-macros', '0.8.1', '67a921c1b6914c367b2b823cd4cde6f96beec77d30a939c8199bb377cf9b9b54'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'webview2-com-sys', '0.39.1', 'b3a07132775117d6065853d9d1178157b8c90e228de47129d6bce2c7edebedfb'): {'0dcf41516e608bbcb6cdc5229feb7b86fe4a643b85e7df251133c93408fdac73'},
 ('cargo', 'x11rb', '0.13.2', '9993aa5be5a26815fe2c3eacfc1fde061fc1a1f094bf1ad2a18bf9c495dd7414'): {'a72561f47c1f665535930f606739d9098a6186802d5e2e8ec491faf00f4add5b',
                                                                                                    'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'x11rb-protocol', '0.13.2', 'ea6fc2961e4ef194dcbfe56bb845534d0dc8098940c7e5c012a258bfec6701bd'): {'a72561f47c1f665535930f606739d9098a6186802d5e2e8ec491faf00f4add5b',
                                                                                                             'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'},
 ('cargo', 'xkeysym', '0.2.1', 'b9cc00251562a284751c9973bace760d86c0276c471b4be569fe6b068ee97a56'): {'319736510aa7dbd6f49546f6ee57c787dbe2c7dfa0507dfbd543375f86a4416d',
                                                                                                     '875e64a5df9f892ebd29c71ad0b58a765b5789d7e9142aa70ec07fae74a67686',
                                                                                                     'd4aca2f5936fa638b062f0585df37eec086ca8620d437b2d6be2c95f01199d1a'},
 ('npm', '@tauri-apps/api', '2.12.0', 'sha512-fUSxFX8VABYe9W9K5ROdEaKVkNUFRcMSRofjruvaxztXA+I0XnQHcYHF8m/a6iExRUxsUf0HsFWhPBuH9IgzJw=='): {'0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594',
                                                                                                                                           '9dd42ea92cff2ede5cd477cbfcce051b2d0115c0ac7f368ee88cb545055dff1d'},
 ('npm', '@tauri-apps/plugin-dialog', '2.8.1', 'sha512-/DtE3B62JgpYuWFL5ATXM6KOXUq7pca7cJWOgSqULhZsgyjLk0PWKek1dbRDvhNBW6flNsOfWphsKnb+738Dmw=='): {'0cec06e0e55fbc3dc5cee4fca9b607f66cb8f4e4dbcf3b3c013594dd156732e9',
                                                                                                                                                    '89ff9689dcf9dd53968785d05a26f7898bb169dbfcada8d032b3e68cf0d55607'},
 ('npm', '@xterm/addon-fit', '0.11.0', 'sha512-jYcgT6xtVYhnhgxh3QgYDnnNMYTcf8ElbxxFzX0IZo+vabQqSPAjC3c1wJrKB5E19VwQei89QCiZZP86DCPF7g=='): {'e256f01188af527e4d06d21d06fbf785ae9c50d4b328bf03cbe0ba7f0aa4228f'},
 ('npm', '@xterm/xterm', '6.0.0', 'sha512-TQwDdQGtwwDt+2cgKDLn0IRaSxYu1tSUjgKarSDkUM0ZNiSRXFpjxEsvc/Zgc5kq5omJ+V0a8/kIM2WD3sMOYg=='): {'b569f629d00f2626a8100df2a1798210535621e42164dfd426a6fe5aac7b0ccd'},
 ('npm', 'lucide-react', '0.468.0', 'sha512-6koYRhnM2N0GGZIdXzSeiNwguv1gt/FAjZOiPl76roBi3xKEXa4WmfpxgQwTTL4KipXjefrnf3oV4IsYhi4JFA=='): {'1e7290b35280a048667bbf0ebabac1c7fd52a75300e8b2946ac165715997f2bc'},
 ('npm', 'react', '19.3.0', 'sha512-E8LUcbtBWt20bbl2YoHfx4ZDBdxVTfOKtCZn9cDSJ4l6/nuoApcpIBcj47t2wZoVX8g2ZHuMHbiShgCR1T5Sog=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'},
 ('npm', 'react-dom', '19.3.0', 'sha512-JDk8dgif51OjFoDE70+OT9ICyYr+69HlmihNwp1+Nsfbna3t5sIiCa9ZJktDmQ4/1b/rn26hIAR2uYXDMr5r0Q=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'},
 ('npm', 'scheduler', '0.28.0', 'sha512-juorfCmIkIw8tT+p5BXSm6PJjQF/ycEYmKyzURCIt/RaZIhL+PulbQ9Yu2z1HdOJDdqDTlxA1+xKBmHXJsczAw=='): {'da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93'}}
KNOWN_SOURCE_GAPS = {('cargo', 'android_system_properties', '0.1.6', 'ae221649c9976a6f6c56ae1facf410f3ddb33cc661c4b7b61020a912d4237fbc'),
 ('cargo', 'block2', '0.6.2', 'cdeb9d870516001442e364c5220d3574d2da8dc765554b4a617230d33fa58ef5'),
 ('cargo', 'cesu8', '1.1.0', '6d43a04d8753f35258c91f8ec639f792891f748a1edbd759cf1dcea3382ad83c'),
 ('cargo', 'dispatch2', '0.3.1', '1e0e367e4e7da84520dedcac1901e4da967309406d1e51017ae1abfb97adbd38'),
 ('cargo', 'objc2', '0.6.4', '3a12a8ed07aefc768292f076dc3ac8c48f3781c8f2d5851dd3d98950e8c5a89f'),
 ('cargo', 'objc2-app-kit', '0.3.2', 'd49e936b501e5c5bf01fda3a9452ff86dc3ea98ad5f283e1455153142d97518c'),
 ('cargo', 'objc2-cloud-kit', '0.3.2', '73ad74d880bb43877038da939b7427bba67e9dd42004a18b809ba7d87cee241c'),
 ('cargo', 'objc2-core-data', '0.3.2', '0b402a653efbb5e82ce4df10683b6b28027616a2715e90009947d50b8dd298fa'),
 ('cargo', 'objc2-core-foundation', '0.3.2', '2a180dd8642fa45cdb7dd721cd4c11b1cadd4929ce112ebd8b9f5803cc79d536'),
 ('cargo', 'objc2-core-graphics', '0.3.2', 'e022c9d066895efa1345f8e33e584b9f958da2fd4cd116792e15e07e4720a807'),
 ('cargo', 'objc2-core-image', '0.3.2', 'e5d563b38d2b97209f8e861173de434bd0214cf020e3423a52624cd1d989f006'),
 ('cargo', 'objc2-core-location', '0.3.2', 'ca347214e24bc973fc025fd0d36ebb179ff30536ed1f80252706db19ee452009'),
 ('cargo', 'objc2-core-text', '0.3.2', '0cde0dfb48d25d2b4862161a4d5fcc0e3c24367869ad306b0c9ec0073bfed92d'),
 ('cargo', 'objc2-encode', '4.1.0', 'ef25abbcd74fb2609453eb695bd2f860d389e457f67dc17cafc8b8cbc89d0c33'),
 ('cargo', 'objc2-exception-helper', '0.1.1', 'c7a1c5fbb72d7735b076bb47b578523aedc40f3c439bea6dfd595c089d79d98a'),
 ('cargo', 'objc2-foundation', '0.3.2', 'e3e0adef53c21f888deb4fa59fc59f7eb17404926ee8a6f59f5df0fd7f9f3272'),
 ('cargo', 'objc2-io-surface', '0.3.2', '180788110936d59bab6bd83b6060ffdfffb3b922ba1396b312ae795e1de9d81d'),
 ('cargo', 'objc2-osa-kit', '0.3.2', 'f112d1746737b0da274ef79a23aac283376f335f4095a083a267a082f21db0c0'),
 ('cargo', 'objc2-quartz-core', '0.3.2', '96c1358452b371bf9f104e21ec536d37a650eb10f7ee379fff67d2e08d537f1f'),
 ('cargo', 'objc2-ui-kit', '0.3.2', 'd87d638e33c06f577498cbcc50491496a3ed4246998a7fbba7ccb98b1e7eab22'),
 ('cargo', 'objc2-user-notifications', '0.3.2', '9df9128cbbfef73cda168416ccf7f837b62737d748333bfe9ab71c245d76613e'),
 ('cargo', 'objc2-web-kit', '0.3.2', 'b2e5aaab980c433cf470df9d7af96a7b46a9d892d521a2cbbb2f8a4c16751e7f'),
 ('cargo', 'r-efi', '5.3.0', '69cdb34c158ceb288df11e18b4bd39de994f6657d83847bdffdbd7f346754b0f'),
 ('cargo', 'r-efi', '6.0.0', 'f8dcc9c7d52a811697d2151c701e0d08956f92b0e24136cf4cf27b57a6a0d9bf'),
 ('cargo', 'selectors', '0.38.0', '8adfa1c298912827b8a28b223b3b874357397ae706e6190acd9bf28cee99114d'),
 ('cargo', 'winapi-i686-pc-windows-gnu', '0.4.0', 'ac3b87c63620426dd9b991e5ce0329eff545bccbbb34f3be09ff6fb6ab51b7b6'),
 ('cargo', 'winapi-x86_64-pc-windows-gnu', '0.4.0', '712e227841d057c1ee1cd2fb22fa7e5a5461ae8e48fa2ca79ec42cfc1931183f')}

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
    except (ValueError, UnicodeError):
        fail()
    result = []
    for item in lock.get("package", []):
        if "source" not in item:
            if item.get("name") == "yam-desktop" and item.get("version") == "0.1.0":
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
    if not isinstance(extra,list) or len(extra)!=1 or extra[0].get("name")!="Node" or extra[0].get("version")!="26.10.0" or extra[0].get("body",{}).get("sha256")!=NODE_BODY_SHA256:
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
    rows = [row for row in manifest["additional"] if row["name"] == "Node" and row["version"] == "26.10.0"]
    if len(rows) != 1 or rows[0]["body"]["sha256"] != digest(body):
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
                if relative == "package.json" or base.startswith(("LICENSE", "LICENCE", "NOTICE", "COPYING", "COPYRIGHT")):
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
