'use strict';
// Tiny shared hashing helper. sha256Hex(value) returns the SHA-256 of a string or Buffer as a hex digest —
// the same one-liner that was open-coded in several auth modules (session-id hashing, API-key hashing, the
// principal namespace key). Single-sourced so they can't drift, and so there is one place to revisit if the
// digest ever needs to change.
const crypto = require('crypto');

const sha256Hex = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : String(value)).digest('hex');

module.exports = { sha256Hex };
