// Small, safe subset of Markdown for chat. Escape source text before adding tags.
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(\S(?:.*?\S)?)__/g, '<strong>$1</strong>')
    .replace(/\*(\S(?:.*?\S)?)\*/g, '<em>$1</em>')
    .replace(/_(\S(?:.*?\S)?)_/g, '<em>$1</em>');
}

export function renderChatText(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [], bullets = [];
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const flushBullets = () => { if (bullets.length) { out.push(`<ul>${bullets.map(x => `<li>${inline(x)}</li>`).join('')}</ul>`); bullets = []; } };
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (bullet) { flushParagraph(); bullets.push(bullet[1]); }
    else if (!line.trim()) { flushParagraph(); flushBullets(); }
    else { flushBullets(); paragraph.push(line); }
  }
  flushParagraph(); flushBullets();
  return out.join('');
}
