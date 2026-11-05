// Wrap the cited char range in a <mark> and scroll to it. We operate on the raw
// text node of the <pre>, using the same char offsets the retrieval engine used
// against the extracted text, so the highlight lands on the exact passage.
//
// Offsets come from a data element the viewer template renders, so this script
// stays plain static JS (no server-side templating inside it).
(function () {
  var data = document.getElementById('cite-highlight-data');
  var pre = document.getElementById('doc-pre');
  if (!data || !pre) return;

  var start = parseInt(data.getAttribute('data-start'), 10);
  var end = parseInt(data.getAttribute('data-end'), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return;

  var text = pre.textContent || '';
  if (start < 0) start = 0;
  if (end > text.length) end = text.length;
  if (end <= start) return;

  var before = document.createTextNode(text.slice(0, start));
  var mark = document.createElement('mark');
  mark.className = 'cite-highlight';
  mark.textContent = text.slice(start, end);
  var after = document.createTextNode(text.slice(end));
  pre.textContent = '';
  pre.appendChild(before);
  pre.appendChild(mark);
  pre.appendChild(after);

  // Scroll the highlight into view (a little above center). Respect a reduced-motion preference:
  // the CSS scroll-behavior override does not reach the JS `behavior` option, so pick it here.
  setTimeout(function () {
    var reduce = false;
    try { reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    mark.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }, 100);
})();
