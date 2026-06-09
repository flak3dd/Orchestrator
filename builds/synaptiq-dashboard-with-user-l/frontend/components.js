// Reusable UI Components
// Generated at 2026-06-09T16:29:53.969Z
const UI = {
  createCard(title, content) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `<h3>\${title}</h3><p>\${content}</p>`;
    return card;
  },
  createBadge(text, statusClass) {
    const badge = document.createElement('span');
    badge.className = `badge \${statusClass}`;
    badge.textContent = text;
    return badge;
  }
};
window.UI = UI;