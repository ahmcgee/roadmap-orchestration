// Server-rendered pages. Every value from the data file goes through `esc`.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
<h1>The Oak Street shelf</h1>
<p class="tagline">Take a book, leave a book. Outside number 14.</p>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

const arrived = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function bookItem(book) {
  const state = book.reservedBy === null ? '' : ' · reserved';
  return `<li class="book">
<span class="book-title">${esc(book.title)}</span> <span class="book-author">by ${esc(book.author)}</span>
<p class="book-meta">${esc(book.condition)} · on the shelf since ${esc(arrived(book.arrived))}${state}</p>
</li>`;
}

export function shelfPage(shelf) {
  const books = shelf.books.length === 0
    ? '<p>The shelf is empty right now. New books usually arrive at the weekend.</p>'
    : `<ul class="books">\n${shelf.books.map(bookItem).join('\n')}\n</ul>`;
  return layout('The Oak Street shelf', `<h2>On the shelf now</h2>\n${books}`);
}

export function notFoundPage() {
  return layout('Not found', '<h2>That page is not here</h2>\n<p><a href="/">Back to the shelf</a></p>');
}
