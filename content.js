'use strict';

/**
 * Booking.com Price Calendar Extension
 *
 * Scrapes hotel prices from the current search results page, then fetches
 * prices for every other date visible in the date-picker calendar, and
 * overlays min / avg / max statistics on each calendar day cell –
 * just like Google Flights' price calendar.
 */
(function () {

  // ─── Constants ──────────────────────────────────────────────────────────────

  const BADGE_CLASS    = 'bpc-price-badge';
  const INJECTED_ATTR  = 'data-bpc-done';
  const FETCH_DELAY_MS = 900;   // gap between background price-fetches (ms)
  const MAX_CONCURRENT = 2;     // parallel fetch slots
  const SCRAPE_DELAY_MS = 2000; // wait for dynamic content before first scrape

  // ─── Runtime state ──────────────────────────────────────────────────────────

  /** Whether to sort fetched results by price (loaded from storage) */
  let sortByPrice = true;

  // Keep in sync with popup toggle changes (no page reload needed)
  chrome.storage.sync.get({ sortByPrice: true }, (s) => { sortByPrice = s.sortByPrice; });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.sortByPrice) sortByPrice = changes.sortByPrice.newValue;
  });

  /** Parsed params from the current search URL */
  let searchParams = null;

  /** { symbol, code } of the currency detected on the page */
  let currency = { symbol: '$', code: 'USD' };

  /**
   * Price cache.
   * key  = "YYYY-MM-DD/YYYY-MM-DD"  (checkin/checkout)
   * val  = { min, max, avg, count } | null (fetched but empty)
   */
  const priceCache = new Map();

  /** Pending fetch jobs */
  const fetchQueue  = [];
  let   activeFetches = 0;

  /**
   * The check-in date the user has selected on the calendar (first click).
   * While set, the 3 days after it show prices using it as checkin.
   * Reset when the user clicks a second date (checkout pick) or navigates.
   */
  let selectedCheckin = null;

  // ─── Entry point ────────────────────────────────────────────────────────────

  function init () {
    if (!isBookingPage()) return;

    searchParams = parseSearchParams();

    // Only scrape if we already have a full search context (search results page)
    if (searchParams) {
      setTimeout(scrapeCurrentPage, SCRAPE_DELAY_MS);
    }

    // Always watch for the date-picker calendar (homepage, search results, hotel pages)
    watchForCalendar();

    // Handle soft (SPA) navigations
    watchNavigation();

    console.debug('[BPC] Initialized', searchParams);
  }

  function isBookingPage () {
    return location.hostname === 'www.booking.com';
  }

  function isSearchPage () {
    return /booking\.com\/searchresults/.test(location.href);
  }

  // ─── URL / search-param parsing ─────────────────────────────────────────────

  function parseSearchParams (href) {
    try {
      const url = new URL(href || location.href);
      const sp  = url.searchParams;

      const checkin  = resolveDate(sp, 'checkin');
      const checkout = resolveDate(sp, 'checkout');
      if (!checkin || !checkout) return null;

      const nights = daysBetween(checkin, checkout);
      if (nights <= 0) return null;

      return {
        checkin,
        checkout,
        nights,
        dest:     sp.get('ss')            || '',
        destId:   sp.get('dest_id')       || '',
        destType: sp.get('dest_type')     || '',
        adults:   sp.get('group_adults')  || '2',
        children: sp.get('group_children')|| '0',
        rooms:    sp.get('no_rooms')      || '1',
      };
    } catch (_) {
      return null;
    }
  }

  /**
   * Booking.com uses two possible date formats in the URL:
   *   1. checkin=2026-02-21          (ISO, newer)
   *   2. checkin_year=2026&checkin_month=2&checkin_monthday=21  (legacy)
   */
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

  function buildSearchUrl (checkin, checkout) {
    const p = searchParams;
    const u = new URL('/searchresults.html', 'https://www.booking.com');
    const s = u.searchParams;

    // Always use the individual field format – maximally compatible
    const [cy, cm, cd] = checkin.split('-');
    const [oy, om, od] = checkout.split('-');

    if (p.dest)     s.set('ss',               p.dest);
    if (p.destId)   s.set('dest_id',          p.destId);
    if (p.destType) s.set('dest_type',        p.destType);

    s.set('checkin_year',       cy);
    s.set('checkin_month',      String(parseInt(cm, 10)));
    s.set('checkin_monthday',   String(parseInt(cd, 10)));
    s.set('checkout_year',      oy);
    s.set('checkout_month',     String(parseInt(om, 10)));
    s.set('checkout_monthday',  String(parseInt(od, 10)));

    s.set('group_adults',   p.adults);
    s.set('group_children', p.children);
    s.set('no_rooms',       p.rooms);
    if (sortByPrice) s.set('order', 'price');

    return u.toString();
  }

  // ─── Price scraping (current page DOM) ──────────────────────────────────────

  function scrapeCurrentPage () {
    const prices = extractPricesFromDoc(document);
    if (prices.length > 0) {
      const key = cacheKey(searchParams.checkin, searchParams.checkout);
      priceCache.set(key, calcStats(prices));
      updateAllBadges();
    } else {
      // Retry – dynamic content may not be loaded yet
      setTimeout(scrapeCurrentPage, 2500);
    }
  }

  /**
   * Extracts price numbers from a document (current page or a fetched HTML doc).
   * Uses a waterfall of selector strategies so it stays resilient to UI changes.
   */
  function extractPricesFromDoc (doc) {
    const prices = [];
    const seen   = new Set();

    // Ordered from most-specific to least-specific
    const selectors = [
      '[data-testid="price-and-discounted-price"]',
      '[data-testid="property-card-container"] [class*="price"]',
      '.bui-price-display__value',
      '.prco-valign-middle-helper',
      '[class*="Price__amount"]',
      '[class*="finalPrice"]',
      '[class*="sr_price"] [class*="price"]',
    ];

    for (const sel of selectors) {
      try {
        const nodes = doc.querySelectorAll(sel);
        if (!nodes.length) continue;

        nodes.forEach(el => {
          const p = parsePrice(el.textContent);
          if (p > 0 && !seen.has(p)) {
            seen.add(p);
            prices.push(p);
            if (prices.length === 1) detectCurrency(el.textContent);
          }
        });

        // If we found a reasonable number of prices, stop trying other selectors
        if (prices.length >= 3) break;
      } catch (_) {}
    }

    // Fallback: JSON-LD structured data
    if (prices.length === 0) {
      prices.push(...extractFromJsonLD(doc));
    }

    // Fallback: Next.js SSR data embedded in __NEXT_DATA__
    if (prices.length === 0) {
      prices.push(...extractFromNextData(doc));
    }

    return prices;
  }

  /** Pull prices from Next.js __NEXT_DATA__ SSR payload */
  function extractFromNextData (doc) {
    const prices = [];
    const script = doc.getElementById('__NEXT_DATA__');
    if (!script) return prices;
    try {
      const root = JSON.parse(script.textContent);
      collectPricesFromObject(root, prices, 0);
    } catch (_) {}
    return prices;
  }

  /**
   * Recursively walk a JSON object looking for keys that are price-like
   * (e.g. "price", "amount", "rate", "lowestPrice").
   */
  function collectPricesFromObject (obj, prices, depth) {
    if (depth > 12 || prices.length > 60 || obj === null) return;
    if (typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        if (/price|amount|rate|lowestPrice|minPrice/i.test(key)) {
          const n = parseFloat(val);
          if (n > 1 && n < 999_999) prices.push(n);
        }
        if (typeof val === 'object') collectPricesFromObject(val, prices, depth + 1);
      }
    }
  }

  /** Pull prices out of schema.org JSON-LD blocks */
  function extractFromJsonLD (doc) {
    const prices = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const data  = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          const offers = item.offers
            ? (Array.isArray(item.offers) ? item.offers : [item.offers])
            : [];
          offers.forEach(o => {
            const p = parseFloat(o.price || o.lowPrice || 0);
            if (p > 0) prices.push(p);
          });
        });
      } catch (_) {}
    });
    return prices;
  }

  /** Strip non-numeric characters and return a float price, or 0 */
  function parsePrice (text) {
    if (!text) return 0;
    // Handle "1,234.56" and "1.234,56" formatting
    const cleaned = text.replace(/\s/g, '');
    const match   = cleaned.match(/[\d,.]+/);
    if (!match) return 0;
    // Remove thousands separators (comma before 3+ digits) then normalise decimal
    const normalised = match[0].replace(/,(?=\d{3})/g, '').replace(',', '.');
    const n = parseFloat(normalised);
    return (n > 1 && n < 999_999) ? n : 0;
  }

  const CURRENCY_MAP = {
    '€': { symbol: '€', code: 'EUR' },
    '£': { symbol: '£', code: 'GBP' },
    '¥': { symbol: '¥', code: 'JPY' },
    '₹': { symbol: '₹', code: 'INR' },
    '₩': { symbol: '₩', code: 'KRW' },
    '฿': { symbol: '฿', code: 'THB' },
    '$': { symbol: '$', code: 'USD' },
  };

  function detectCurrency (text) {
    if (!text) return;
    for (const [sym, info] of Object.entries(CURRENCY_MAP)) {
      if (text.includes(sym)) { currency = info; return; }
    }
    const code = text.match(/\b([A-Z]{3})\b/);
    if (code) currency = { symbol: code[1] + '\u202f', code: code[1] };
  }

  // ─── Statistics ─────────────────────────────────────────────────────────────

  function calcStats (prices) {
    const sorted = [...prices].sort((a, b) => a - b);
    const sum    = sorted.reduce((acc, v) => acc + v, 0);
    return {
      min:   sorted[0],
      max:   sorted[sorted.length - 1],
      avg:   Math.round(sum / sorted.length),
      count: sorted.length,
    };
  }

  // ─── Calendar detection ──────────────────────────────────────────────────────

  const CALENDAR_SELECTOR =
    '[data-testid*="calendar"], [data-testid*="datepicker"], ' +
    '[class*="bui-calendar"], [class*="datepicker"], [class*="calendar__"]';

  function watchForCalendar () {
    // Check elements already in the DOM
    document.querySelectorAll(CALENDAR_SELECTOR).forEach(tryInject);

    // Watch for the calendar popup to appear dynamically
    new MutationObserver(mutations => {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          tryInject(node);
          node.querySelectorAll(CALENDAR_SELECTOR).forEach(tryInject);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function tryInject (el) {
    if (!el || el.getAttribute(INJECTED_ATTR)) return;
    if (!looksLikeCalendar(el)) return;
    el.setAttribute(INJECTED_ATTR, '1');
    activateCalendar(el);
  }

  function looksLikeCalendar (el) {
    const cls    = (el.className || '').toString();
    const testId = el.getAttribute('data-testid') || '';
    const combined = cls + testId;
    if (!/calendar|datepicker/i.test(combined)) return false;
    // Must contain actual day cells (at least a week's worth)
    // Modern Booking.com uses data-testid^="calendar-day-" on button/div elements
    const cells = el.querySelectorAll(
      'td, [role="gridcell"], [data-testid^="calendar-day-"]'
    );
    return cells.length >= 7;
  }

  function activateCalendar (calEl) {
    refreshBadges(calEl);

    // Detect when the user picks a check-in date so we can show prices for
    // the next 3 days (as potential checkout dates) immediately.
    calEl.addEventListener('click', e => {
      const cell = e.target.closest(
        '[data-testid^="calendar-day-"], [data-date], [data-day], td[role="gridcell"]'
      );
      if (!cell) return;
      const date = getCellDate(cell);
      if (!date) return;
      handleDateClick(date);
    });

    // Re-run whenever the calendar re-renders (e.g. month navigation)
    new MutationObserver(() => refreshBadges(calEl))
      .observe(calEl, { childList: true, subtree: true });
  }

  /** Read the destination input value from the search bar (if present) */
  function getDestinationValue () {
    const input = document.querySelector(
      'input[name="ss"], input[data-destination="1"]'
    );
    return input ? input.value.trim() : '';
  }

  /**
   * Called when the user clicks a calendar date cell.
   *
   * First click  → treat as checkin selection.
   *   • If we have a full searchParams context: queue real price fetches for
   *     the next 3 checkout dates.
   *   • If a destination is typed but no searchParams yet: inject random
   *     prices for the next 3 dates immediately so the user sees something.
   * Second click → treat as checkout selection; reset selectedCheckin so all
   *                badges revert to their normal (per-night) view.
   * Clicking the same date again or an earlier date → treat as a new checkin.
   */
  function handleDateClick (date) {
    if (!selectedCheckin || daysBetween(selectedCheckin, date) <= 0) {
      // First click, or user re-picked the same / an earlier date → set checkin
      selectedCheckin = date;

      if (searchParams) {
        // Real price fetches (search-results page)
        for (let i = 1; i <= 10; i++) {
          const co  = addDays(selectedCheckin, i);
          const key = cacheKey(selectedCheckin, co);
          if (!priceCache.has(key) && !fetchQueue.find(j => j.key === key)) {
            fetchQueue.push({ key, checkin: selectedCheckin, checkout: co });
          }
        }
        drain();
      } else if (getDestinationValue()) {
        // Destination typed but no full search context yet.
        // Mark all 3 days as loading immediately, then fire real fetches for each.
        const checkinSnap = selectedCheckin;   // capture before any re-click
        for (let i = 1; i <= 10; i++) {
          const co  = addDays(checkinSnap, i);
          const key = cacheKey(checkinSnap, co);
          if (!priceCache.has(key)) priceCache.set(key, { loading: true });
        }

        // Fire real fetches for all 3 days; update each badge as it resolves.
        for (let i = 1; i <= 10; i++) {
          const co  = addDays(checkinSnap, i);
          const key = cacheKey(checkinSnap, co);
          fetchHomepagePrice(checkinSnap, co).then(stats => {
            if (selectedCheckin === checkinSnap) {
              priceCache.set(key, stats);
              updateAllBadges();
            }
          });
        }
      }
    } else {
      // Second click on a later date → user picked checkout; reset
      selectedCheckin = null;
    }
    updateAllBadges();
  }

  // ─── Date cells ─────────────────────────────────────────────────────────────

  function refreshBadges (calEl) {
    const cells = getDateCells(calEl);
    cells.forEach(cell => {
      if (!cell.querySelector(`.${BADGE_CLASS}`)) injectBadge(cell);
    });
    queueFetchesForCells(cells);
  }

  /** Try several selector strategies to find the clickable date cells */
  function getDateCells (root) {
    const strategies = [
      // Modern Booking.com: data-testid="calendar-day-YYYY-MM-DD"
      '[data-testid^="calendar-day-"]',
      'td[data-date]',
      '[data-date]',
      '[data-day]',
      'td[aria-disabled="false"]',
      'td[role="gridcell"]:not([aria-disabled="true"])',
      'td.bui-calendar__date:not(.bui-calendar__date--disabled)',
      '[class*="CalendarDay"]:not([class*="blocked"]):not([class*="outside"])',
    ];
    for (const sel of strategies) {
      try {
        const cells = Array.from(root.querySelectorAll(sel))
          .filter(el => !el.classList.contains(BADGE_CLASS));
        if (cells.length >= 7) return cells;
      } catch (_) {}
    }
    return [];
  }

  /** Extract ISO date string (YYYY-MM-DD) from a calendar date cell */
  function getCellDate (cell) {
    // 0. Modern Booking.com: data-testid="calendar-day-YYYY-MM-DD"
    const testId = cell.getAttribute('data-testid') || '';
    const testIdMatch = testId.match(/calendar-day-(\d{4}-\d{2}-\d{2})/);
    if (testIdMatch) return testIdMatch[1];

    // 1. Direct data attributes
    for (const attr of ['data-date', 'data-day', 'data-value']) {
      const v = cell.getAttribute(attr);
      if (v) {
        const m = v.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) return m[0];
      }
    }
    // 2. aria-label text parsing (e.g. "Saturday, February 21, 2026")
    const label = cell.getAttribute('aria-label') || '';
    if (label) return parseDateText(label);

    // 3. Infer from calendar header + cell position
    return inferDateFromContext(cell);
  }

  const MONTH_INDEX = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
    sep: 9, oct: 10, nov: 11, dec: 12,
  };

  function parseDateText (text) {
    // ISO format already present?
    const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];

    // "February 21, 2026" or "21 February 2026" or "Sat Feb 21 2026"
    const words = text.toLowerCase().replace(/[,]/g, ' ').split(/\s+/);
    let day, month, year;
    for (const w of words) {
      if (!year  && /^20\d{2}$/.test(w))  year  = w;
      if (!month && MONTH_INDEX[w])        month = String(MONTH_INDEX[w]).padStart(2, '0');
      if (!day   && /^\d{1,2}$/.test(w))  day   = w.padStart(2, '0');
    }
    if (day && month && year) return `${year}-${month}-${day}`;
    return null;
  }

  /**
   * Last-resort: read the visible month/year from the calendar header and
   * derive the date from the cell's day-number text and its column (weekday).
   */
  function inferDateFromContext (cell) {
    // Walk up to find the calendar grid / month container
    let container = cell.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!container) break;
      const header = container.querySelector(
        '[class*="month"], [class*="Month"], [class*="caption"], [class*="title"]'
      );
      if (header) {
        const date = parseDateText(header.textContent + ' ' + cell.textContent.trim());
        if (date) return date;
      }
      container = container.parentElement;
    }
    return null;
  }

  // ─── Badge injection & rendering ────────────────────────────────────────────

  function injectBadge (cell) {
    const date = getCellDate(cell);
    if (!date) return;

    // Ensure the cell can act as a positioning context for the absolute badge
    if (getComputedStyle(cell).position === 'static') {
      cell.style.position = 'relative';
    }

    const badge = document.createElement('div');
    badge.className  = BADGE_CLASS;
    badge.dataset.date = date;
    cell.appendChild(badge);

    renderBadge(badge);
  }

  /**
   * Returns the { checkin, checkout } dates to use for a badge, or null if
   * this badge has nothing to display.
   *
   * • When the user has selected a checkin date and this badge is for one of
   *   the next 3 days, treat it as a potential checkout date.
   * • Otherwise fall back to the full-search-context mode (needs searchParams).
   */
  function getBadgeDates (badge) {
    const date = badge.dataset.date;
    if (selectedCheckin) {
      const diff = daysBetween(selectedCheckin, date);
      if (diff >= 1 && diff <= 10) {
        return { checkin: selectedCheckin, checkout: date };
      }
    }
    if (!searchParams) return null;   // no context to compute a checkout date
    return { checkin: date, checkout: addDays(date, searchParams.nights) };
  }

  function renderBadge (badge) {
    const date = badge.dataset.date;
    if (!date) { badge.innerHTML = ''; return; }

    const dates = getBadgeDates(badge);
    if (!dates) { badge.innerHTML = ''; badge.classList.remove('bpc-loaded'); return; }

    const { checkin, checkout } = dates;
    const key   = cacheKey(checkin, checkout);
    const stats = priceCache.get(key);

    if (stats === undefined) {
      // Not yet fetched – only show a loader when we're doing real fetches
      if (searchParams) {
        badge.innerHTML = '<div class="bpc-loading"></div>';
      } else {
        badge.innerHTML = '';
      }
      badge.classList.remove('bpc-loaded');
    } else if (stats && stats.loading) {
      // Homepage fetch in progress – show the progress bar
      badge.innerHTML = '<div class="bpc-loading"></div>';
      badge.classList.remove('bpc-loaded');
    } else if (!stats) {
      // Fetched but no prices found → hide gracefully
      badge.innerHTML = '';
      badge.classList.remove('bpc-loaded');
    } else {
      const s = currency.symbol;
      const nights = daysBetween(checkin, checkout);
      const nightLabel = nights === 1 ? '1 night' : `${nights} nights`;
      const titleSuffix = (checkin !== date) ? ` · ${nightLabel}` : '';
      badge.innerHTML = `
        <div class="bpc-min">${s}${fmt(stats.min)}</div>
        <div class="bpc-tooltip">
          <div class="bpc-tt-title">Hotels (${stats.count} found)${titleSuffix}</div>
          <div class="bpc-tt-row">
            <span class="bpc-tt-label">Min</span>
            <span class="bpc-tt-val">${s}${fmt(stats.min)}</span>
          </div>
          <div class="bpc-tt-row">
            <span class="bpc-tt-label">Avg</span>
            <span class="bpc-tt-val">${s}${fmt(stats.avg)}</span>
          </div>
          <div class="bpc-tt-row">
            <span class="bpc-tt-label">Max</span>
            <span class="bpc-tt-val">${s}${fmt(stats.max)}</span>
          </div>
        </div>`;
      badge.classList.add('bpc-loaded');
    }
  }

  function updateAllBadges () {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach(renderBadge);
    applyColorCoding();
  }

  /**
   * Color-code loaded badges green/yellow/orange based on their relative
   * position in the distribution of minimum prices across all loaded dates.
   * Works on both search-results pages (searchParams set) and the homepage
   * (selectedCheckin set after a date click).
   */
  function applyColorCoding () {
    // Need at least a search context OR a user-selected checkin to make sense
    if (!searchParams && !selectedCheckin) return;

    const loaded = Array.from(document.querySelectorAll(`.${BADGE_CLASS}.bpc-loaded`));
    if (loaded.length < 3) return;

    const mins = loaded
      .map(b => {
        const dates = getBadgeDates(b);
        if (!dates) return Infinity;
        return priceCache.get(cacheKey(dates.checkin, dates.checkout))?.min ?? Infinity;
      })
      .filter(v => isFinite(v))
      .sort((a, b) => a - b);

    if (mins.length < 3) return;

    const lo = mins[Math.floor(mins.length * 0.33)];
    const hi = mins[Math.floor(mins.length * 0.66)];

    loaded.forEach(b => {
      const dates = getBadgeDates(b);
      if (!dates) return;
      const min = priceCache.get(cacheKey(dates.checkin, dates.checkout))?.min;
      if (min === undefined) return;

      const cell = b.parentElement;
      b.classList.remove('bpc-green', 'bpc-yellow', 'bpc-orange', 'bpc-red');
      cell && cell.classList.remove('bpc-cell-green', 'bpc-cell-yellow', 'bpc-cell-orange');

      if (min <= lo) {
        b.classList.add('bpc-green');
        cell && cell.classList.add('bpc-cell-green');
      } else if (min >= hi) {
        b.classList.add('bpc-orange');
        cell && cell.classList.add('bpc-cell-orange');
      } else {
        b.classList.add('bpc-yellow');
        cell && cell.classList.add('bpc-cell-yellow');
      }
    });
  }

  // ─── Homepage real-price fetch (no full searchParams context) ───────────────

  /**
   * Build a search URL using only what's available on the homepage:
   * the destination string from the search bar input, plus any hidden
   * dest_id / dest_type inputs that booking.com populates after the user
   * selects a suggestion from the autocomplete dropdown.
   */
  function buildHomepageSearchUrl (checkin, checkout) {
    const dest = getDestinationValue();
    if (!dest) return null;

    const u = new URL('/searchresults.html', 'https://www.booking.com');
    const s = u.searchParams;

    s.set('ss',  dest);
    s.set('lang', 'en-us');
    s.set('sb',   '1');
    s.set('src_elem', 'sb');
    s.set('src',  'index');

    // booking.com adds hidden inputs after autocomplete selection
    const destIdEl   = document.querySelector('input[name="dest_id"]');
    const destTypeEl = document.querySelector('input[name="dest_type"]');
    if (destIdEl?.value)   s.set('dest_id',   destIdEl.value);
    if (destTypeEl?.value) s.set('dest_type', destTypeEl.value);

    s.set('checkin',        checkin);
    s.set('checkout',       checkout);
    s.set('group_adults',   '2');
    s.set('no_rooms',       '1');
    s.set('group_children', '0');
    if (sortByPrice) s.set('order', 'price');

    return u.toString();
  }

  /** Fetch and return real price stats for a single date pair (homepage mode). */
  async function fetchHomepagePrice (checkin, checkout) {
    const url = buildHomepageSearchUrl(checkin, checkout);
    if (!url) return null;
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept':          'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) return null;
      const html   = await res.text();
      const doc    = new DOMParser().parseFromString(html, 'text/html');
      const prices = extractPricesFromDoc(doc);
      return prices.length > 0 ? calcStats(prices) : null;
    } catch (_) {
      return null;
    }
  }

  // ─── Fetch queue ─────────────────────────────────────────────────────────────

  function queueFetchesForCells (cells) {
    if (!searchParams) return;
    cells.forEach(cell => {
      const date = getCellDate(cell);
      if (!date) return;

      const checkout = addDays(date, searchParams.nights);
      const key      = cacheKey(date, checkout);

      if (!priceCache.has(key) && !fetchQueue.find(i => i.key === key)) {
        fetchQueue.push({ key, checkin: date, checkout });
      }
    });

    // If the user has selected a checkin date, ensure we have prices for the
    // next 3 potential checkout dates (calendar may have re-rendered).
    if (selectedCheckin) {
      for (let i = 1; i <= 10; i++) {
        const co  = addDays(selectedCheckin, i);
        const key = cacheKey(selectedCheckin, co);
        if (!priceCache.has(key) && !fetchQueue.find(j => j.key === key)) {
          fetchQueue.push({ key, checkin: selectedCheckin, checkout: co });
        }
      }
    }

    drain();
  }

  async function drain () {
    while (fetchQueue.length > 0 && activeFetches < MAX_CONCURRENT) {
      const item = fetchQueue.shift();
      if (priceCache.has(item.key)) continue; // might have been populated already

      activeFetches++;
      doFetch(item).finally(() => {
        activeFetches--;
        if (fetchQueue.length > 0) setTimeout(drain, FETCH_DELAY_MS);
      });

      // Stagger concurrent fetches slightly
      if (fetchQueue.length > 0) await sleep(180);
    }
  }

  async function doFetch ({ key, checkin, checkout }) {
    const url = buildSearchUrl(checkin, checkout);
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept':          'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (res.status === 429 || res.status === 503) {
        // Rate-limited – put back in queue with a longer future delay
        setTimeout(() => {
          if (!priceCache.has(key)) fetchQueue.push({ key, checkin, checkout });
          drain();
        }, 5000);
        return;
      }

      if (!res.ok) { priceCache.set(key, null); return; }

      const html   = await res.text();
      const doc    = new DOMParser().parseFromString(html, 'text/html');
      const prices = extractPricesFromDoc(doc);

      priceCache.set(key, prices.length > 0 ? calcStats(prices) : null);
      updateAllBadges();

    } catch (_) {
      priceCache.set(key, null);
    }
  }

  // ─── SPA navigation ──────────────────────────────────────────────────────────

  function watchNavigation () {
    let lastHref = location.href;
    new MutationObserver(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (!isSearchPage()) return;

      const fresh = parseSearchParams();
      if (!fresh) return;

      // If the dates changed, reset queue (keep cache – it may still be valid)
      if (fresh.checkin !== searchParams?.checkin ||
          fresh.checkout !== searchParams?.checkout) {
        fetchQueue.length = 0;
      }

      searchParams    = fresh;
      selectedCheckin = null;   // clear date selection on navigation
      setTimeout(scrapeCurrentPage, SCRAPE_DELAY_MS);
    }).observe(document, { subtree: true, childList: true });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  function cacheKey (checkin, checkout) {
    return `${checkin}/${checkout}`;
  }

  function addDays (dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function daysBetween (a, b) {
    return Math.round(
      (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86_400_000
    );
  }

  /** Compact price formatter: 1234 → "1.2k", 85 → "85" */
  function fmt (n) {
    if (!n && n !== 0) return '?';
    if (n >= 10_000) return Math.round(n / 1000) + 'k';
    if (n >= 1_000)  return (n / 1000).toFixed(1) + 'k';
    return Math.round(n).toString();
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small defer so the page JS has a head-start
    setTimeout(init, 0);
  }

})();
