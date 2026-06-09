// Page views
// Generated at 2026-06-09T16:32:51.701Z
const Pages = {
  renderDashboard(container) {
    container.innerHTML = \`
      <header class="app-header">
        <h1>Dashboard</h1>
        <span class="status-badge" id="status">Connecting...</span>
      </header>
      <main class="dashboard-grid" id="dashboard">
        <div id="status-card"></div>
        <div id="stats-card"></div>
      </main>
    \`;
  }
};
window.Pages = Pages;