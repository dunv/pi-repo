// Allowlisted, bounded argument previews: never dump file bodies or arbitrary args.
const fields = {
  read: ['path', 'offset', 'limit'],
  ls: ['path', 'limit'],
  find: ['pattern', 'path', 'limit'],
  grep: ['pattern', 'path', 'glob', 'ignoreCase', 'literal', 'context', 'limit'],
  write: ['path'],
  edit: ['path'],
  delegate_check: ['index'],
};
export function toolSummary(name, args) {
  const preview = {};
  for (const key of fields[name] ?? []) {
    const value = args?.[key];
    if (typeof value === 'string') preview[key] = value.length > 160 ? value.slice(0, 160) + '…' : value;
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) preview[key] = value;
  }
  if (name === 'write' && typeof args?.content === 'string') preview.bytes = Buffer.byteLength(args.content);
  if (name === 'edit' && Array.isArray(args?.edits)) preview.replacements = args.edits.length;
  // JSON escaping prevents newlines/ESC in arguments from forging log lines.
  const text = JSON.stringify(preview).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return text.length > 400 ? text.slice(0, 400) + '…' : text;
}
