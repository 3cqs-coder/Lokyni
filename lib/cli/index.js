'use strict';
// Command-line copy, loaded from the data files beside this module (help.txt, reindex-confirm.txt) so the
// entry point stays slim and the text is editable without touching code. Read lazily and cached. The port
// default is substituted from constants so it stays single-sourced and can never drift from what the server
// binds. Never throws: a missing or unreadable file degrades to a minimal built-in message rather than
// crashing a CLI command. Paths resolve against this module's directory, so it works in every packaged layout.

const fs = require('fs');
const path = require('path');

const readText = (name) => {
  try { return fs.readFileSync(path.join(__dirname, name), 'utf8'); }
  catch { return ''; }
};

let _help = null;
// The full --help text, with the port default filled in from the single source of truth.
const helpText = () => {
  if (_help == null) {
    const raw = readText('help.txt') || '\nLokyni — run `node lokyni.js` to start the server. See the LICENSE file.\n';
    let port = '';
    try { port = String(require('../constants').DEFAULT_PORT); } catch { /* constants not ready */ }
    _help = raw.replace(/\{\{DEFAULT_PORT\}\}/g, port);
  }
  return _help;
};

let _reindex = null;
// The confirmation prompt shown before a destructive --reindex. Trailing whitespace/newline is trimmed and a
// single space re-added so the cursor sits right after the colon regardless of how the file ends.
const reindexConfirm = () => {
  if (_reindex == null) {
    const raw = readText('reindex-confirm.txt')
      || 'This will WIPE and rebuild the search index. Your documents are not modified. Type "yes" to continue:';
    _reindex = raw.replace(/\s+$/, '') + ' ';
  }
  return _reindex;
};

module.exports = { helpText, reindexConfirm };
