import * as edit from './actions/edit';
import * as project from './actions/project';
import { programEngine } from './playback/engine';
import { sourcePlayer } from './playback/source';
import { useUi } from './state/ui';

/** Shown in the hold-? overlay. Matches Premiere Pro's defaults wherever a feature overlaps. */
export const SHORTCUT_GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: 'Playback',
    items: [
      ['Play / pause', ['Space']],
      ['Reverse · pause · forward (repeat for 2×, 4×)', ['J', 'K', 'L']],
      ['Step one frame', ['←', '→']],
      ['Step five frames', ['Shift+←', 'Shift+→']],
      ['Previous / next edit point', ['↑', '↓']],
      ['Go to start / end', ['Home', 'End']],
    ],
  },
  {
    title: 'Marking',
    items: [
      ['Mark In / Out (focused monitor)', ['I', 'O']],
      ['Clear In and Out', ['Alt+X']],
      ['Add marker', ['M']],
    ],
  },
  {
    title: 'Editing',
    items: [
      ['Insert source at playhead (ripples)', [',']],
      ['Overwrite source at playhead', ['.']],
      ['Lift marked range (leave gap)', [';']],
      ["Extract marked range (close gap)", ["'"]],
      ['Cut all unlocked tracks at playhead', ['Ctrl+K']],
      ['Ripple trim clip start to playhead', ['Q']],
      ['Ripple trim clip end to playhead', ['W']],
      ['Ripple delete (default)', ['Delete', 'Backspace']],
      ['Delete, leaving a gap', ['Shift+Delete']],
    ],
  },
  {
    title: 'Tools & clips',
    items: [
      ['Selection tool', ['V']],
      ['Razor tool', ['C']],
      ['Select only video or audio of a linked clip', ['Alt+click']],
      ['Duplicate clip', ['Alt+drag']],
      ['Insert-move (push clips aside)', ['Ctrl+drag']],
      ['Ripple trim an edge', ['Ctrl+drag edge']],
      ['Link / unlink audio & video', ['Ctrl+L']],
      ['Group / ungroup', ['Ctrl+G']],
      ['Copy / paste clips', ['Ctrl+C', 'Ctrl+V']],
      ['Select all', ['Ctrl+A']],
    ],
  },
  {
    title: 'Timeline',
    items: [
      ['Toggle snapping', ['S']],
      ['Zoom in / out', ['+', '−']],
      ['Zoom to fit', ['\\']],
    ],
  },
  {
    title: 'Project',
    items: [
      ['Undo / redo', ['Ctrl+Z', 'Shift+Ctrl+Z']],
      ['Import media', ['Ctrl+I']],
      ['Export for YouTube', ['Ctrl+M']],
      ['Save / save as', ['Ctrl+S', 'Shift+Ctrl+S']],
      ['Open / new project', ['Ctrl+O', 'Ctrl+N']],
      ['Show shortcuts', ['Hold ?']],
    ],
  },
];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button'].includes(type);
  }
  return false;
}

/** The monitor that transport keys (Space, J/K/L, arrows, I/O) act on. */
function monitor() {
  const focus = useUi.getState().focus;
  if (focus === 'source') return { kind: 'source' as const, ...transport(sourcePlayer) };
  const engine = programEngine();
  return { kind: 'program' as const, ...(engine ? transport(engine) : transport(null)) };
}

function transport(t: { toggle(): void; jkl(k: 'j' | 'k' | 'l'): void; step(n: number): void } | null) {
  return {
    toggle: () => t?.toggle(),
    jkl: (k: 'j' | 'k' | 'l') => t?.jkl(k),
    step: (n: number) => t?.step(n),
  };
}

export function handleKeyDown(e: KeyboardEvent): void {
  const ui = useUi.getState();
  if (e.key === 'Escape') {
    if (ui.shortcutsVisible) ui.set({ shortcutsVisible: false });
    else if (!ui.dialog) ui.select({});
    return;
  }
  if (ui.dialog || isTyping(e.target)) return;

  const ctrl = e.ctrlKey || e.metaKey;
  const { shiftKey: shift, altKey: alt } = e;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Only navigation, zoom and undo/redo auto-repeat when held.
  if (e.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '=', '+', '-', '_'].includes(key) && !(ctrl && (key === 'z' || key === 'y'))) {
    e.preventDefault();
    return;
  }
  let handled = true;

  if (ctrl) {
    switch (key) {
      case 'z':
        if (shift) edit.redoCmd();
        else edit.undoCmd();
        break;
      case 'y':
        edit.redoCmd();
        break;
      case 'k':
        edit.cutAtPlayhead();
        break;
      case 'l':
        edit.toggleLinkSelection();
        break;
      case 'g':
        edit.toggleGroupSelection();
        break;
      case 'c':
        edit.copySelection();
        break;
      case 'v':
        if (alt) ui.toast('Paste attributes arrives with clip effects in Phase 3.');
        else edit.pasteAtPlayhead();
        break;
      case 'a':
        edit.selectAll();
        break;
      case 'm':
        ui.set({ dialog: 'export' });
        break;
      case 's':
        if (shift) void project.saveProjectAs();
        else void project.saveProject();
        break;
      case 'o':
        void project.openProjectDialog();
        break;
      case 'n':
        void project.newProject();
        break;
      case 'i':
        void project.importDialog();
        break;
      default:
        handled = false;
    }
  } else if (alt && key === 'x') {
    if (ui.focus === 'source') sourcePlayer.clearMarks();
    else edit.clearTimelineMarks();
  } else {
    const m = monitor();
    switch (key) {
      case ' ':
        m.toggle();
        break;
      case 'j':
      case 'k':
      case 'l':
        m.jkl(key);
        break;
      case 'ArrowLeft':
        m.step(shift ? -5 : -1);
        break;
      case 'ArrowRight':
        m.step(shift ? 5 : 1);
        break;
      case 'ArrowUp':
        edit.goToEdit(-1);
        break;
      case 'ArrowDown':
        edit.goToEdit(1);
        break;
      case 'Home':
        if (m.kind === 'source') sourcePlayer.seekFrame(0);
        else edit.goToEnd('start');
        break;
      case 'End':
        if (m.kind === 'source') sourcePlayer.seekFrame(sourcePlayer.lastFrame());
        else edit.goToEnd('end');
        break;
      case 'i':
        if (m.kind === 'source') sourcePlayer.markIn();
        else edit.markTimeline('in');
        break;
      case 'o':
        if (m.kind === 'source') sourcePlayer.markOut();
        else edit.markTimeline('out');
        break;
      case ',':
        edit.placeFromSource('insert');
        break;
      case '.':
        edit.placeFromSource('overwrite');
        break;
      case ';':
        edit.liftMarked();
        break;
      case "'":
        edit.extractMarked();
        break;
      case 'v':
        edit.setTool('select');
        break;
      case 'c':
        edit.setTool('razor');
        break;
      case 'q':
        edit.rippleTrimToPlayheadCmd('start');
        break;
      case 'w':
        edit.rippleTrimToPlayheadCmd('end');
        break;
      case 'Delete':
      case 'Backspace':
        edit.deleteSelection(shift);
        break;
      case 'm':
        edit.addMarkerAtPlayhead();
        break;
      case 's':
        edit.toggleSnapping();
        break;
      case '=':
      case '+':
        edit.zoom('in');
        break;
      case '-':
      case '_':
        edit.zoom('out');
        break;
      case '\\':
        edit.zoom('fit');
        break;
      case '?':
        ui.set({ shortcutsVisible: true });
        break;
      default:
        handled = false;
    }
  }
  if (handled) e.preventDefault();
}

export function handleKeyUp(e: KeyboardEvent): void {
  // Hold ? to show the sheet; it hides when the key is released.
  if ((e.key === '?' || e.key === '/' || e.key === 'Shift') && useUi.getState().shortcutsVisible) {
    useUi.getState().set({ shortcutsVisible: false });
  }
}
