// Dashboard orchestrator: mounts feature modules into the dashboard shell.
import { $ } from './ui.js';
import { initGrid } from './grid.js';
import { BulkPanel } from './bulk.js';
import { initActions } from './actions.js';

export const bulkPanel = { instance: null };

export async function initDashboard() {
  const host = $('#bulk-panel');
  if (host) bulkPanel.instance = new BulkPanel(host);
  const panel = $('#repos-panel');
  if (panel) initGrid(panel);
  if (bulkPanel.instance) initActions(bulkPanel.instance);
}
