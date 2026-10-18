// The page frame: masthead, navigation, main column. Print views get the bare frame (design/DESIGN.md, "Print views").
import { escape } from './html.js';

const NAV = [['/', 'Overview'], ['/entries', 'Entries'], ['/budgets', 'Budgets'], ['/statements', 'Statements']];

/** A full page. `section` is the navigation item it belongs to; `stylesheet` the component stylesheet it loads. */
export function layout({ title, section, body, stylesheet = '/static/app.css' }) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === section ? ' aria-current="page"' : ''}>${label}</a>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} | ledgerly</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/tokens.css">
  <link rel="stylesheet" href="${stylesheet}">
</head>
<body>
  <a class="skip" href="#main">Skip to content</a>
  <header class="masthead">
    <a class="wordmark" href="/">ledgerly</a>
    <nav aria-label="Main">
      ${nav}
    </nav>
  </header>
  <main id="main" class="page">
${body}
  </main>
</body>
</html>
`;
}

/** A print view: no navigation, no colour, the print stylesheet only. */
export function printLayout({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} | ledgerly</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/print.css">
</head>
<body class="print">
${body}
</body>
</html>
`;
}
