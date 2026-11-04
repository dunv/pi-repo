// Visual-only development extension. Explicitly load with --no-extensions -e.
// It installs real renderers, but discards ALL backend hooks, tools and commands.
import { Box, MouseRegion, Text } from '@earendil-works/pi-tui';
import { extension } from '../index.ts';
import { NOTICE } from '../state.ts';

const TOOL = 'pi-repo.pueue.preview.tool';
const nonce = '00000000-0000-4000-8000-000000000001';
const input = { argv: ['/bin/echo', 'Synthetic preview — no job was submitted'], cwd: '/example/checkout' };
const content = data => [{ type: 'text', text: JSON.stringify(data) }];
const states = [
  { id: 89, phase: 'EXITED', exitCode: 0 },
  { id: 90, phase: 'EXITED', exitCode: 7 },
  { id: 91, phase: 'UNKNOWN' },
  { id: 92, phase: 'ADMISSION_UNKNOWN' },
  { id: 93, phase: 'KILLED' },
  { id: 94, phase: 'EXITED', exitCode: 0, cancellationRequested: true },
  { id: 95, phase: 'UNKNOWN', cancellationRequested: true },
  { id: 96, phase: 'KILLED', cancellationRequested: true },
];

export function samples(section = 'all') {
  const notices = states.map(state => ({ customType: NOTICE, content: JSON.stringify({ ...state, nonce }), display: true }));
  const tool = (name, label, data, flags = {}) => ({ customType: TOOL, display: true,
    content: JSON.stringify({ name, label, reply: { content: content(data) }, ...flags }) });
  const submits = [
    ...['STASHED', 'QUEUED', 'RUNNING', 'PAUSED', 'UNKNOWN', 'ADMISSION_UNKNOWN'].map((phase, i) =>
      tool('pueue_submit', `Submission · ${phase}`, { id: 100 + i, nonce, phase })),
    tool('pueue_submit', 'Submission · loading', {}, { isPartial: true }),
    { customType: TOOL, display: true, content: JSON.stringify({ name: 'pueue_submit', label: 'Submission · error', isError: true,
      reply: { content: [{ type: 'text', text: 'Synthetic admission error. State UNKNOWN; do not retry automatically.' }] } }) },
  ];
  const log = (state, text = 'Synthetic workload output\nBuild finished.\nNo real job ran.') => ({
    status: { ...state, nonce }, log: { path: '/example/logs/89.log', start: 0, end: Buffer.byteLength(text), size: Buffer.byteLength(text), text },
  });
  const logs = [
    ...states.slice(0, 5).map(state => tool('pueue_result', `Log · ${state.phase}${state.exitCode === undefined ? '' : ` ${state.exitCode}`}`, log(state))),
    tool('pueue_result', 'Log · empty', log(states[0], '')),
    tool('pueue_result', 'Log · loading', {}, { isPartial: true }),
    tool('pueue_result', 'Log · malformed payload', {}),
    { customType: TOOL, display: true, content: JSON.stringify({ name: 'pueue_result', label: 'Log · error', isError: true,
      reply: { content: [{ type: 'text', text: 'Synthetic log error: ownership UNKNOWN; result withheld.' }] } }) },
  ];
  return section === 'notices' ? notices : section === 'submit' ? submits : section === 'logs' ? logs : [...notices, ...submits, ...logs];
}

export default function preview(pi) {
  const tools = new Map();
  extension({
    registerMessageRenderer: (name, renderer) => pi.registerMessageRenderer(name, renderer),
    registerTool: tool => tools.set(tool.name, tool),
    on() {}, registerCommand() {},
  });
  pi.registerMessageRenderer(TOOL, (message, options, theme) => {
    const sample = JSON.parse(message.content);
    const tool = tools.get(sample.name);
    let expanded = options.expanded;
    return new MouseRegion({
      render(width) {
        // Reproduce Pi's default tool shell around the actual call/result renderers.
        const box = new Box(options.outputPad, 1, line => theme.bg(sample.isPartial ? 'toolPendingBg' : sample.isError ? 'toolErrorBg' : 'toolSuccessBg', line));
        const context = { args: input, outputPad: options.outputPad, isError: !!sample.isError };
        box.addChild(new Text(theme.fg('muted', `[Preview: ${sample.label}]`), 0, 0));
        box.addChild(tool.renderCall(input, theme, context));
        box.addChild(tool.renderResult(sample.reply, { expanded, isPartial: !!sample.isPartial }, theme, context));
        return box.render(width);
      },
      invalidate() {},
    }, event => {
      if (event.type !== 'click' || event.button !== 'left' || event.y < 1) return;
      expanded = !expanded;
      return { handled: true, render: true };
    });
  });
  pi.registerCommand('pueue-preview', {
    description: 'Synthetic Pueue UI gallery: /pueue-preview [all|notices|submit|logs]. No backend work/model turns.',
    async handler(args, ctx) {
      const section = args.trim() || 'all';
      if (!['all', 'notices', 'submit', 'logs'].includes(section)) {
        ctx.ui.notify('Usage: /pueue-preview [all|notices|submit|logs]', 'info');
        return;
      }
      for (const message of samples(section)) pi.sendMessage(message, { triggerTurn: false });
    },
  });
}
