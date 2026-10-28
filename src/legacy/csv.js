// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, BOM.
// Returns an array of objects keyed by the header row; the header itself is on `.columns`.
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header = [], ...body] = rows.filter((r) => r.some((v) => v !== ''));
  const columns = header.map((h) => h.trim());
  const result = body.map((r) => Object.fromEntries(columns.map((h, i) => [h, (r[i] ?? '').trim()])));
  result.columns = columns;
  return result;
}

module.exports = { parseCsv };
