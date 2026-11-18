// Narrow, audited false-positive handling for demonstrated Go cache bytes.
// This is not a binary/cache whitelist or proof arbitrary contents are safe.
export const protectedText = /(?:mailhub|trash[-_ ]?journal|approved[-_ ]?(?:mail|message)?[-_ ]?set|unknown[-_ ]?outcome)/i;
const gazelle = /^build-output\/external\/gazelle\+\+non_module_deps\+bazel_gazelle_go_repository_cache\/gocache\/([a-f0-9]{2})\/([a-f0-9]{64})-d$/;
const stdlib = /^build-output\/execroot\/_main\/bazel-out\/[^/]+\/bin\/external\/rules_go\+\/stdlib_\/pkg\/linux_amd64(?:_race)?\/crypto\/internal\/fips140(?:\/(?:hkdf|tls12|tls13))?\.a$/;

export function protectedContentScanner(path) {
  let header = '', tail = '', bytes = 0, checkedThrough = 0;
  const counts = new Map();
  const cache = gazelle.exec(path);
  const cachePath = !!cache && cache[1] === cache[2].slice(0, 2);
  const inspect = (text, start, end) => {
    const matches = new RegExp(protectedText.source, 'ig');
    for (const match of text.matchAll(matches)) {
      const offset = start + match.index;
      if (offset < checkedThrough || offset >= end) continue;
      let rule;
      const context = text.slice(Math.max(0, match.index - 9), match.index + match[0].length + 43);
      if ((cachePath || stdlib.test(path)) && header.startsWith('!<arch>\n__.PKGDEF ')
        && /^!<arch>\n__.PKGDEF [^\n]{0,80}\ngo object linux amd64 go\d+\.\d+/.test(header)
        && context.startsWith('RecordNonApprovedsetIndicatorcrypto/internal/fips140')) rule = 'go-fips140-symbol-v1';
      const indexContext = text.slice(Math.max(0, match.index - 5), match.index + 60);
      if (cachePath && header.startsWith('go index v2\n')
        && indexContext.startsWith('FIPS-approved settings.\nfipstls.go\nfips140tls')) rule = 'go-fips-tls-settings-index-v1';
      if (!rule) throw new Error('potential-protected-operational-content');
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
    checkedThrough = end;
  };
  return {
    push(chunk) {
      const text = chunk.toString('latin1');
      if (header.length < 256) header = (header + text).slice(0, 256);
      const combined = tail + text, start = bytes - tail.length;
      bytes += chunk.length;
      // Keep context on BOTH sides, including markers split across read chunks.
      inspect(combined, start, Math.max(0, bytes - 128));
      tail = combined.slice(-256);
    },
    finish() {
      inspect(tail, bytes - tail.length, bytes);
      return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([rule, matches]) => ({ rule, matches }));
    },
  };
}
