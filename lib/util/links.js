'use strict';
// Single source for the app's internal link paths. The citation builders in several modules
// (retrieval/search.js, socket.js, retrieval/deepresearch.js) each hand-built these URLs, so a route
// rename would silently leave some citations pointing at a dead path. These helpers mirror the Express
// routes exactly — the in-app document viewer (GET /document/view) and the figure-crop endpoint
// (GET /api/figure/:id) — and encode the single user-controlled component, so there is one place to change.
// The browser has its own tiny copy (it cannot require a Node module); a test keeps the two in step.
const viewerLink = (source) => `/document/view?path=${encodeURIComponent(source || '')}`;
const figureUrl  = (id)     => `/api/figure/${encodeURIComponent(id || '')}`;

module.exports = { viewerLink, figureUrl };
