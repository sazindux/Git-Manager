// Dashboard orchestrator: loads repos and mounts feature modules (filled in T4+).
import { $ } from './ui.js';

export async function initDashboard() {
  const panel = $('#repos-panel');
  if (panel) panel.firstElementChild.textContent = 'Signed in. Repository dashboard arrives in the next step.';
}
