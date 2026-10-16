# extension/vendor — third-party code

**Policy: pin exact versions, keep the licence text next to the code, record the
hash, and never edit vendored files.** Everything here is loaded by the content
scripts through `chrome.runtime.getURL(...)` dynamic imports (see
`../src/content/chesscom-adapter.js`) and by the zero-dep Node unit test
(`test/tools/adapter-unit.mjs`), so the file must stay a plain ES module that
runs unchanged in both runtimes.

| File | Package | Version | Licence | sha256 |
|---|---|---|---|---|
| `chess.js` | [`chess.js`](https://github.com/jhlywa/chess.js) | **1.4.0** | BSD-2-Clause (`LICENSE.chess.js`) | `0fd3d85b712fd650987416ebdc9e85a97406dbc69cb759a2179e96cc7770f16d` |
| `LICENSE.chess.js` | licence text of the above | 1.4.0 | — | — |

## What is vendored

`chess.js` is the chess rules engine used for exactly one job: replaying
chess.com's SAN move list from the initial position to get

- the authoritative **UCI move history** (`e2e4`, `e7e8q`, `e1g1`),
- the exact **FEN of the final position** (castling rights, en-passant square,
  halfmove clock and fullmove number reconstructed by the rules engine), and
- a legality check of every SAN token seen in the DOM.

The file is the published ESM build (`dist/esm/chess.js` of the npm tarball),
unchanged except for removing the trailing `//# sourceMappingURL=chess.js.map`
comment (the map is not vendored).

Note: chess.js is **BSD-2-Clause** — the task plan said "MIT", which is the
licence of the pre-1.0 versions; since v1 the project ships BSD-2-Clause. The
licence text is vendored next to the file.

## Update procedure

```bash
cd /tmp && npm pack chess.js@<new-version>          # or curl the tarball
tar xzf chess.js-<new-version>.tgz
# keep the file byte-for-byte, minus the sourceMappingURL line:
grep -v '^//# sourceMappingURL=' package/dist/esm/chess.js > extension/vendor/chess.js
cp package/LICENSE extension/vendor/LICENSE.chess.js
sha256sum extension/vendor/chess.js                 # update the table above
node test/tools/adapter-unit.mjs                    # replay unit tests
node test/tools/adapter-proof.mjs --chrome <chrome> # end-to-end proof
```
