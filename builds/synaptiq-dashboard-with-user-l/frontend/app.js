// API Integration Client
// Generated at 2026-06-09T16:30:17.596Z
const ws = new WebSocket(`ws://${location.host}`);
const statusEl = document.getElementById('status') || {};
ws.onopen = () => {
  statusEl.textContent = 'Connected';
  statusEl.style.color = 'var(--success)';
};
ws.onclose = () => {
  statusEl.textContent = 'Disconnected';
  statusEl.style.color = 'var(--danger)';
};