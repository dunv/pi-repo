export function environmentFixture(runtime, launcher) {
  return { environmentProtocol: 1, environments: Object.fromEntries([
    ['source-review', 'read-only', false], ['implementation', 'writable-worktree', false],
    ['implementation-checked', 'writable-worktree', true],
  ].map(([id, source, checks]) => [id, { capabilities: { source, checks },
    verificationProfiles: checks ? Object.keys(runtime.profiles) : [],
    isolation: { filesystem: 'tool-boundary', network: 'host', credentials: 'host-home' },
    launcher, path: runtime.path }])) };
}
