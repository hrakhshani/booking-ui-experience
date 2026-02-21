'use strict';

const dot    = document.getElementById('statusDot');
const text   = document.getElementById('statusText');
const detail = document.getElementById('statusDetail');

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab) return;

  const url = tab.url || '';

  if (/booking\.com\/searchresults/.test(url)) {
    // Active on a search-results page
    dot.classList.add('active');
    text.textContent = 'Active on this page';

    // Try to read params from the URL to give context
    try {
      const sp       = new URL(url).searchParams;
      const dest     = sp.get('ss') || sp.get('dest_id') || '';
      const checkin  = resolveDate(sp, 'checkin');
      const checkout = resolveDate(sp, 'checkout');

      if (dest && checkin && checkout) {
        detail.textContent =
          `Destination: ${decodeURIComponent(dest)}\n` +
          `Check-in: ${checkin}  →  Check-out: ${checkout}\n` +
          `Open the date picker to see price stats on each day.`;
      } else {
        detail.textContent = 'Open the date picker to see prices on each calendar day.';
      }
    } catch (_) {
      detail.textContent = 'Open the date picker to see prices on each calendar day.';
    }

  } else if (/booking\.com/.test(url)) {
    dot.classList.add('inactive');
    text.textContent = 'On Booking.com';
    detail.textContent = 'Navigate to a hotel search results page to activate the price calendar.';
  } else {
    dot.classList.add('inactive');
    text.textContent = 'Not on Booking.com';
    detail.textContent = 'Visit Booking.com and search for hotels to use this extension.';
  }
});

// ── Helpers (mirrors content.js) ─────────────────────────────────────────────

function resolveDate (sp, key) {
  const iso = sp.get(key);
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;

  const y = sp.get(`${key}_year`);
  const m = sp.get(`${key}_month`);
  const d = sp.get(`${key}_monthday`);
  if (y && m && d) {
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}
