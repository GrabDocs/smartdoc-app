export const AI_FM_HELP_INTRO =
  'One clear action per message. Narrow scope with a folder or file name when possible. Mutating plans need Run to apply.';

export const AI_FM_HELP_ACTIONS: { title: string; description: string }[] = [
  {
    title: 'Move',
    description: 'Move selected files to another folder or workspace root.',
  },
  {
    title: 'Copy',
    description: 'Duplicate files into the same folder or a folder you name.',
  },
  {
    title: 'Rename',
    description: 'Rename one or more files (patterns or a single new name).',
  },
  {
    title: 'Trash (soft delete)',
    description: 'Move files to trash. Recoverable from Deleted for a limited time.',
  },
  {
    title: 'Restore',
    description: 'Bring files back from trash when they match your request.',
  },
  {
    title: 'Organize',
    description: 'AI suggests folders and moves; review the plan before Run.',
  },
  {
    title: 'Folders',
    description: 'Create folder or rename folder (workspace scope).',
  },
  {
    title: 'Bookmarks',
    description:
      'Add/remove files on bookmarks; create, rename, delete, lock, or recolor bookmarks.',
  },
  {
    title: 'Schedule',
    description: 'Defer very large batches to a scheduled run when prompted.',
  },
  {
    title: 'Undo',
    description:
      'Say "undo" or "undo last" to reverse your last completed run (same as History → Undo, within the undo window).',
  },
];

export const AI_FM_COMMAND_HINT =
  'Ask AI to organize your files and folders — move, rename, and more.';

export const AI_FM_DISCLAIMER =
  'AI File Manager will NOT: permanently delete · modify contents · share externally · cross companies · override permissions · auto-execute';

/** Tailwind emerald-600 — web AI FM Run / Approve and run */
export const AI_FM_RUN_BUTTON_COLOR = '#059669';

/** Tailwind orange-600 — web "Run now anyway" override */
export const AI_FM_RUN_NOW_ANYWAY_COLOR = '#ea580c';

/** AI File Manager header / Files tab folder-cog icon */
export const AI_FM_ICON_COLOR = '#7C3AED';
