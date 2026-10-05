// Dashboard orchestrator: mounts feature modules into the dashboard shell.
import { $ } from './ui.js';
import { initGrid } from './grid.js';

export async function initDashboard() {
  const panel = $('#repos-panel');
  if (panel) initGrid(panel);
}
