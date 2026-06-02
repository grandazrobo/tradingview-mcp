import { register } from '../router.js';
import * as core from '../../core/tab.js';

register('tab', {
  description: 'Tab management (list, new, close, switch)',
  subcommands: new Map([
    ['list', {
      description: 'List all open chart tabs',
      handler: () => core.list(),
    }],
    ['new', {
      description: 'Open a new chart tab',
      handler: () => core.newTab(),
    }],
    ['close', {
      description: 'Close the current tab',
      handler: () => core.closeTab(),
    }],
    ['switch', {
      description: 'Switch to a tab by index or --name <partial>',
      options: {
        name: { type: 'string', description: 'Switch to tab by name (partial, case-insensitive)' },
      },
      handler: (opts, positionals) => {
        if (opts.name) return core.switchTabByName({ name: opts.name });
        if (positionals[0] === undefined) throw new Error('Index or --name required. Usage: tv tab switch 0  OR  tv tab switch --name "4-pane"');
        return core.switchTab({ index: positionals[0] });
      },
    }],
  ]),
});
