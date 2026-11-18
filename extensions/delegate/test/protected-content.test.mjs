import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectedContentScanner } from '../protected-content.mjs';
const cache = 'build-output/external/gazelle++non_module_deps+bazel_gazelle_go_repository_cache/gocache/aa/' + 'a'.repeat(64) + '-d';
const stdlib = 'build-output/execroot/_main/bazel-out/k8-fastbuild-ST-fixture/bin/external/rules_go+/stdlib_/pkg/linux_amd64_race/crypto/internal/fips140/tls12.a';
const header = '!<arch>\n__.PKGDEF       0           0     0     644     12654     `\ngo object linux amd64 go1.27.1 GOAMD64=v1\n';
const symbol = 'RecordNonApprovedsetIndicatorcrypto/internal/fips140';
const index = 'go index v2\n\0\x01crypto/tls requires FIPS-approved settings.\nfipstls.go\nfips140tls';
function scan(path, text, step = 65536) {
  const scanner = protectedContentScanner(path), bytes = Buffer.from(text, 'latin1');
  for (let offset = 0; offset < bytes.length; offset += step) scanner.push(bytes.subarray(offset, offset + step));
  return scanner.finish();
}
test('only demonstrated Go archive/index contexts in recognized build-cache paths produce audited exceptions', () => {
  for (const step of [1, 7, 64, 65536]) {
    for (const path of [cache, stdlib]) assert.deepEqual(scan(path, header + symbol, step), [{ rule: 'go-fips140-symbol-v1', matches: 1 }]);
    assert.deepEqual(scan(cache, index, step), [{ rule: 'go-fips-tls-settings-index-v1', matches: 1 }]);
  }
});
test('real protected markers in the same cache still block, including chunk boundaries and final bytes', () => {
  for (const marker of ['Mailhub', 'approved-mail-set', 'approved set', 'Trash_journal', 'unknown-outcome']) {
    for (const step of [1, 13, 65536]) {
      assert.throws(() => scan(cache, header + symbol + '\0' + 'x'.repeat(65530) + marker, step), /protected/);
    }
  }
});
test('ordinary text, other binaries, wrong headers/paths and near-miss FIPS contexts get no whitelist', () => {
  for (const [path, text] of [
    ['build-output/plan.json', header + symbol], [cache, symbol], [stdlib, index],
    [cache.replace('/aa/', '/bb/'), header + symbol], [stdlib, header + 'RecordNonApprovedsetIndicatorcustom/package'],
    [cache, 'go index v2\nFIPS-approved set: real operational data'],
    [cache, header.replace('go object linux amd64', 'untrusted object') + symbol],
  ]) assert.throws(() => scan(path, text), /protected/);
});
test('overlap does not double count exceptions and harmless content is unchanged', () => {
  assert.deepEqual(scan(cache, header + symbol + '\0' + symbol, 11), [{ rule: 'go-fips140-symbol-v1', matches: 2 }]);
  assert.deepEqual(scan(cache, header + 'unrelated compiled bytes'), []);
});
