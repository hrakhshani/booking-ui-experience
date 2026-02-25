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
  const FETCH_DELAY_MS      = 900;   // gap between background price-fetches (ms)
  const MAX_CONCURRENT      = 2;     // parallel fetch slots
  const SCRAPE_DELAY_MS     = 3000;  // wait for dynamic content before first scrape
  const DETAIL_LOAD_DELAY_MS = 1500; // pause before retrying hotel detail fetch

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

    // Inject compare buttons on search-result hotel cards
    watchForHotelCards();

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
      // Second click on a later date → user picked checkout; reset and close picker
      selectedCheckin = null;
      closeDatePicker();
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

  // ─── Date-picker close ───────────────────────────────────────────────────────

  /**
   * Close the date-picker after the checkout date is selected.
   * Uses a short delay so Booking.com can finish processing the date selection
   * before we attempt to close. Avoids Escape key which resets the selection.
   */
  function closeDatePicker () {
    setTimeout(() => {
      // 1. Dedicated close / done button
      const closeBtn = document.querySelector(
        '[data-testid="datepicker-close"], ' +
        '[data-testid="searchbox-dates-close"], ' +
        '[aria-label="Close calendar"], ' +
        '[class*="datepicker__close"], ' +
        '[class*="DatePicker__close"]'
      );
      if (closeBtn) { closeBtn.click(); return; }

      // 2. Click outside the calendar (on the backdrop / body) to dismiss
      const cal = document.querySelector(CALENDAR_SELECTOR);
      if (cal) {
        const rect = cal.getBoundingClientRect();
        // Click a point well outside the calendar bounds
        const x = rect.right + 40;
        const y = rect.top  + (rect.height / 2);
        document.elementFromPoint(x, y)?.click();
      }
    }, 150);
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

  // ─── Hotel Comparison ────────────────────────────────────────────────────────

  const COMPARE_BTN_CLASS = 'bpc-compare-btn';
  const COMPARE_BAR_ID    = 'bpc-compare-bar';
  const COMPARE_MODAL_ID  = 'bpc-compare-modal';
  const MAX_COMPARE       = 4;

  /** Cache for hotel detail page fetches (facilities + area info) keyed by URL */
  const detailsCache = new Map();

  /** Currently saved hotels for comparison */
  let compareList = [];

  // Persist compare list across page loads (local storage, not synced)
  chrome.storage.local.get({ compareList: [] }, s => {
    compareList = s.compareList || [];
    renderCompareBar();
    updateAllCompareButtons();
  });

  function saveCompareList () {
    chrome.storage.local.set({ compareList }).catch(err => {
      console.warn('[BPC] Failed to save compare list:', err);
    });
  }

  /** Return a stable hotel ID from its page URL path */
  function getHotelId (card) {
    const link = card.querySelector('[data-testid="title-link"]');
    if (!link?.href) return null;
    try { return new URL(link.href).pathname.split('?')[0]; } catch (_) { return null; }
  }

  /** Scrape the visible data from a property card element */
  function extractHotelData (card) {
    const name = card.querySelector('[data-testid="title"]')?.textContent.trim() || '';
    const url  = card.querySelector('[data-testid="title-link"]')?.href || '';
    const img  = card.querySelector(
      '[data-testid="property-card-desktop-single-image"] img, [data-testid="image"]'
    )?.src || '';

    // Stars: aria-label="4 out of 5"
    const starsMatch = card.querySelector('[aria-label*="out of 5"]')
      ?.getAttribute('aria-label')?.match(/^(\d)/);
    const stars = starsMatch ? parseInt(starsMatch[1]) : 0;

    // Review score
    const scoreEl    = card.querySelector('[data-testid="review-score"]');
    const score      = scoreEl?.querySelector('[aria-hidden="true"]')?.textContent.trim() || '';
    const scoreLabel = scoreEl?.querySelector('[aria-hidden="false"] div:first-child')?.textContent.trim() || '';
    const reviewCount= scoreEl?.querySelector('[aria-hidden="false"] div:last-child')?.textContent.trim()  || '';

    // Location & distance
    const location = card.querySelector('[data-testid="address-link"] .d823fbbeed')
      ?.textContent.trim() || '';
    const distance = card.querySelector('[data-testid="distance"]')?.textContent.trim() || '';

    // Prices
    const price     = card.querySelector('[data-testid="price-and-discounted-price"]')?.textContent.trim() || '';
    const origPrice = card.querySelector('.d68334ea31')?.textContent.trim() || '';
    const nights    = card.querySelector('[data-testid="price-for-x-nights"]')?.textContent.trim() || '';

    // Room & payment
    const room    = card.querySelector('[data-testid="recommended-units"] h4')?.textContent.trim() || '';
    const payment = card.querySelector('[data-testid="availability-single"] strong')?.textContent.trim() || '';

    return { name, url, img, stars, score, scoreLabel, reviewCount,
             location, distance, price, origPrice, nights, room, payment };
  }

  /** Toggle a hotel in/out of the compare list */
  function toggleCompare (card) {
    const id  = getHotelId(card);
    if (!id) return;

    const idx = compareList.findIndex(h => h.id === id);
    if (idx >= 0) {
      compareList.splice(idx, 1);
    } else {
      if (compareList.length >= MAX_COMPARE) {
        showCompareToast(`You can compare up to ${MAX_COMPARE} hotels at once`);
        return;
      }
      compareList.push({ id, ...extractHotelData(card) });
    }

    saveCompareList();
    renderCompareBar();
    updateAllCompareButtons();
  }

  /** Inject the "+" button into a property card (no-op if already injected) */
  function injectCompareButton (card) {
    if (card.querySelector(`.${COMPARE_BTN_CLASS}`)) return;

    const id     = getHotelId(card);
    const active = id ? compareList.some(h => h.id === id) : false;

    const btn = document.createElement('button');
    btn.className = COMPARE_BTN_CLASS + (active ? ' bpc-compare-btn--active' : '');
    btn.type      = 'button';
    btn.title     = active ? 'Remove from comparison' : 'Compare this hotel';
    btn.setAttribute('aria-label', active ? 'Remove from comparison' : 'Add to comparison');
    btn.textContent = active ? '✓' : '+';

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleCompare(card);
    });

    const imgContainer = card.querySelector('.c17271c4d7');
    if (imgContainer) {
      imgContainer.style.position = 'relative';
      imgContainer.appendChild(btn);
    } else {
      card.style.position = 'relative';
      card.appendChild(btn);
    }
  }

  /** Refresh the compare button state on a single card */
  function updateCompareButton (card) {
    const btn    = card.querySelector(`.${COMPARE_BTN_CLASS}`);
    const id     = getHotelId(card);
    const active = id ? compareList.some(h => h.id === id) : false;

    if (!btn) { injectCompareButton(card); return; }

    btn.className   = COMPARE_BTN_CLASS + (active ? ' bpc-compare-btn--active' : '');
    btn.title       = active ? 'Remove from comparison' : 'Compare this hotel';
    btn.textContent = active ? '✓' : '+';
    btn.setAttribute('aria-label', active ? 'Remove from comparison' : 'Add to comparison');
  }

  function updateAllCompareButtons () {
    document.querySelectorAll('[data-testid="property-card"]').forEach(updateCompareButton);
  }

  /** Inject compare buttons now and watch for new cards added by infinite scroll */
  function watchForHotelCards () {
    document.querySelectorAll('[data-testid="property-card"]').forEach(injectCompareButton);

    new MutationObserver(mutations => {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches('[data-testid="property-card"]')) injectCompareButton(node);
          node.querySelectorAll('[data-testid="property-card"]').forEach(injectCompareButton);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ─── Compare Bar (sticky bottom tray) ────────────────────────────────────────

  function renderCompareBar () {
    let bar = document.getElementById(COMPARE_BAR_ID);

    if (compareList.length === 0) { bar?.remove(); return; }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = COMPARE_BAR_ID;
      document.body.appendChild(bar);
    }

    const emptySlots = MAX_COMPARE - compareList.length;

    bar.innerHTML = `
      <div class="bpc-cb-inner">
        <div class="bpc-cb-slots">
          ${compareList.map(h => `
            <div class="bpc-cb-slot">
              ${h.img
                ? `<img src="${esc(h.img)}" alt="" class="bpc-cb-slot-img">`
                : '<div class="bpc-cb-slot-img bpc-cb-no-img"></div>'}
              <div class="bpc-cb-slot-info">
                <div class="bpc-cb-slot-name">${esc(h.name)}</div>
                <div class="bpc-cb-slot-price">${esc(h.price)}</div>
              </div>
              <button class="bpc-cb-remove" data-id="${esc(h.id)}" aria-label="Remove ${esc(h.name)}">×</button>
            </div>
          `).join('')}
          ${Array.from({ length: emptySlots }, () => `
            <div class="bpc-cb-slot bpc-cb-slot--empty">
              <span>+ Add hotel</span>
            </div>
          `).join('')}
        </div>
        <div class="bpc-cb-actions">
          <button class="bpc-cb-btn-compare" ${compareList.length < 2 ? 'disabled' : ''}>
            Compare (${compareList.length})
          </button>
          <button class="bpc-cb-btn-clear">Clear all</button>
        </div>
      </div>`;

    bar.querySelectorAll('.bpc-cb-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        compareList = compareList.filter(h => h.id !== btn.dataset.id);
        saveCompareList();
        renderCompareBar();
        updateAllCompareButtons();
      });
    });

    bar.querySelector('.bpc-cb-btn-compare')?.addEventListener('click', () => {
      if (compareList.length >= 2) openCompareModal();
    });

    bar.querySelector('.bpc-cb-btn-clear')?.addEventListener('click', () => {
      compareList = [];
      saveCompareList();
      renderCompareBar();
      updateAllCompareButtons();
    });
  }

  // ─── Hotel detail fetching ────────────────────────────────────────────────────

  /**
   * Load a hotel page in a hidden same-origin iframe, scroll through it to fire
   * lazy-load observers, then extract detail blocks from the live DOM.
   */
  function fetchHotelDetailsViaIframe (url) {
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');

      // Position off-screen but give real dimensions so IntersectionObserver
      // inside the iframe fires normally (it uses the iframe's own viewport).
      Object.assign(iframe.style, {
        position:      'fixed',
        top:           '-10000px',
        left:          '-10000px',
        width:         '1280px',
        height:        '900px',
        border:        'none',
        pointerEvents: 'none',
        zIndex:        '-1',
      });
      iframe.setAttribute('aria-hidden', 'true');
      iframe.src = url;

      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { iframe.remove(); } catch (_) {}
        resolve(result);
      };

      // Hard timeout so a slow/broken page never hangs the compare modal
      const timer = setTimeout(() => finish(null), 20_000);

      iframe.addEventListener('error', () => finish(null));

      iframe.addEventListener('load', async () => {
        try {
          const iWin = iframe.contentWindow;
          const iDoc = iframe.contentDocument;
          if (!iDoc || !iWin) { finish(null); return; }

          // Wait for React hydration and initial renders to settle
          await new Promise(r => setTimeout(r, 1500));

          // Scroll in multiple passes so newly inserted lazy blocks also load.
          const getScrollHeight = () => Math.max(
            iDoc.body?.scrollHeight || 0,
            iDoc.documentElement?.scrollHeight || 0
          );
          const step = 420;
          let prevHeight = 0;
          for (let pass = 0; pass < 4; pass++) {
            const maxY = getScrollHeight() + step;
            for (let y = 0; y <= maxY; y += step) {
              iWin.scrollTo(0, y);
              await sleep(90);
            }
            await sleep(700);
            const newHeight = getScrollHeight();
            if (Math.abs(newHeight - prevHeight) < 180) break;
            prevHeight = newHeight;
          }

          // Jump to known detail sections if present; some blocks request data
          // only when scrolled near the section heading.
          const sectionSelectors = [
            '[data-testid="property-most-popular-facilities-wrapper"]',
            '[data-testid="facility-group-container"]',
            '[data-testid="facilities-subtitle"]',
            '[data-testid="poi-block"]',
            '[data-testid*="surrounding"]',
          ];
          const targets = [];
          sectionSelectors.forEach(sel => {
            iDoc.querySelectorAll(sel).forEach(el => targets.push(el));
          });
          for (const el of targets.slice(0, 30)) {
            el.scrollIntoView({ block: 'center' });
            await sleep(120);
          }
          await sleep(1200);

          finish({
            popularFacilities: extractPopularFacilities(iDoc),
            facilityGroups:    extractFacilityGroups(iDoc),
            areaInfo:          extractAreaInfo(iDoc),
          });
        } catch (err) {
          console.warn('[BPC] iframe extraction error:', err);
          finish(null);
        }
      });

      document.body.appendChild(iframe);
    });
  }

  function mergeUniqueStrings (base, extra) {
    const merged = [];
    const seen = new Set();
    [base, extra].forEach(list => {
      (list || []).forEach(item => {
        const text = typeof item === 'string' ? item.trim() : '';
        if (!text) return;
        const key = text.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(text);
      });
    });
    return merged;
  }

  function mergeFacilityGroups (base, extra) {
    const mergedByName = new Map();
    const order = [];
    const ingest = (groups) => {
      (groups || []).forEach(group => {
        const name = typeof group?.name === 'string' ? group.name.trim() : '';
        if (!name) return;
        const key = name.toLowerCase();
        const desc = typeof group?.description === 'string' ? group.description.trim() : '';
        const facs = mergeUniqueStrings([], group?.facilities || []);
        if (!mergedByName.has(key)) {
          mergedByName.set(key, { name, description: desc, facilities: facs });
          order.push(key);
          return;
        }
        const existing = mergedByName.get(key);
        if (desc && desc.length > existing.description.length) {
          existing.description = desc;
        }
        existing.facilities = mergeUniqueStrings(existing.facilities, facs);
      });
    };
    ingest(base);
    ingest(extra);
    return order.map(key => mergedByName.get(key))
      .filter(group => group.facilities.length || group.description);
  }

  function mergeAreaInfo (base, extra) {
    const mergedByCategory = new Map();
    const order = [];
    const ingest = (categories) => {
      (categories || []).forEach(category => {
        const name = typeof category?.name === 'string' ? category.name.trim() : '';
        if (!name) return;
        const key = name.toLowerCase();
        const pois = Array.isArray(category?.pois) ? category.pois : [];
        if (!mergedByCategory.has(key)) {
          mergedByCategory.set(key, { name, pois: [] });
          order.push(key);
        }
        const target = mergedByCategory.get(key);
        const seenPoi = new Set(target.pois.map(p => `${(p.name || '').toLowerCase()}|${(p.distance || '').toLowerCase()}`));
        pois.forEach(poi => {
          const poiName = typeof poi?.name === 'string' ? poi.name.trim() : '';
          if (!poiName) return;
          const poiType = typeof poi?.type === 'string' ? poi.type.trim() : '';
          const poiDist = typeof poi?.distance === 'string' ? poi.distance.trim() : '';
          const poiKey = `${poiName.toLowerCase()}|${poiDist.toLowerCase()}`;
          if (seenPoi.has(poiKey)) return;
          seenPoi.add(poiKey);
          target.pois.push({ type: poiType, name: poiName, distance: poiDist });
        });
      });
    };
    ingest(base);
    ingest(extra);
    return order.map(key => mergedByCategory.get(key)).filter(cat => cat.pois.length);
  }

  /** Fetch and parse detailed info (facilities, area POIs) from a hotel page */
  async function fetchHotelDetails (url) {
    // Strip query params so we get the full hotel info page, not a booking-flow view
    let cleanUrl = url;
    try {
      const u = new URL(url);
      cleanUrl = u.origin + u.pathname;
    } catch (_) {}

    if (detailsCache.has(cleanUrl)) return detailsCache.get(cleanUrl);
    detailsCache.set(cleanUrl, null); // mark as fetched (null = failed/empty)
    try {
      const fetchPage = async (extraParams = '') => {
        const res = await fetch(cleanUrl + extraParams, {
          credentials: 'include',
          headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
        });
        if (!res.ok) return null;
        return new DOMParser().parseFromString(await res.text(), 'text/html');
      };

      let doc = await fetchPage();
      if (!doc) return null;

      let details = {
        popularFacilities: extractPopularFacilities(doc),
        facilityGroups:    extractFacilityGroups(doc),
        areaInfo:          extractAreaInfo(doc),
      };

      // If the detailed sections are missing the page may not have included the
      // lazy-loaded content in its SSR output.  Retry with ?lang=en-us so the
      // server has a fresh chance to render them.
      // NOTE: popularFacilities can be present in the initial SSR even when the
      //       full facilityGroups / areaInfo blocks are absent – so we only use
      //       those two (not popularFacilities) as the trigger for the retry.
      if (!details.facilityGroups.length || !details.areaInfo.length) {
        await sleep(DETAIL_LOAD_DELAY_MS);
        const doc2 = await fetchPage('?lang=en-us');
        if (doc2) {
          const d2 = {
            popularFacilities: extractPopularFacilities(doc2),
            facilityGroups:    extractFacilityGroups(doc2),
            areaInfo:          extractAreaInfo(doc2),
          };
          if (d2.facilityGroups.length || d2.popularFacilities.length || d2.areaInfo.length) {
            details = d2;
            doc     = doc2;
          }
        }
      }

      // Enrich from a live iframe render so lazy-loaded sections triggered by
      // scroll are captured even when the fetched HTML has only partial data.
      const iframeDetails = await fetchHotelDetailsViaIframe(cleanUrl);
      if (iframeDetails) {
        details = {
          popularFacilities: mergeUniqueStrings(details.popularFacilities, iframeDetails.popularFacilities),
          facilityGroups:    mergeFacilityGroups(details.facilityGroups, iframeDetails.facilityGroups),
          areaInfo:          mergeAreaInfo(details.areaInfo, iframeDetails.areaInfo),
        };
      }

      // Diagnostics: inspect Apollo cache for facility keys
      const inlineTexts = Array.from(doc.querySelectorAll('script:not([src])')).map(s => s.textContent);
      const apolloText  = inlineTexts.find(t => t.trim().startsWith('{"ROOT_QUERY"'));
      let apolloFacilityInfo = null;
      if (apolloText) {
        try {
          const cache   = JSON.parse(apolloText);
          const allKeys = Object.keys(cache);
          const facKeys = allKeys.filter(k => /facilit|amenity|Facility/i.test(k));
          apolloFacilityInfo = {
            totalCacheKeys:      allKeys.length,
            facilityRelatedKeys: facKeys.slice(0, 20),
            sampleEntries:       facKeys.slice(0, 3).map(k => ({ key: k, val: cache[k] })),
          };
        } catch (_) {}
      }
      console.debug('[BPC] Hotel details fetched', cleanUrl, {
        popularFacilities:            details.popularFacilities,
        facilityGroups:               details.facilityGroups,
        areaInfoCategories:           details.areaInfo.map(c => c.name),
        facilityGroupContainerCount:  doc.querySelectorAll('[data-testid="facility-group-container"]').length,
        hasApolloCache:               !!apolloText,
        apolloFacilityInfo,
      });
      detailsCache.set(cleanUrl, details);
      return details;
    } catch (_) { return null; }
  }

  /** Most-popular-facilities list: [data-testid="property-most-popular-facilities-wrapper"] */
  function extractPopularFacilities (doc) {
    // Primary: named wrapper with known child class
    const primary = Array.from(
      doc.querySelectorAll('[data-testid="property-most-popular-facilities-wrapper"] .f6b6d2a959')
    ).map(el => el.textContent.trim()).filter(Boolean);
    if (primary.length) return primary;

    // Fallback: any element whose data-testid contains "facility" and has text
    const fallback = Array.from(
      doc.querySelectorAll('[data-testid*="facility"] li, [data-testid*="facility"] span')
    ).map(el => el.textContent.trim()).filter(t => t.length > 1 && t.length < 60);
    return [...new Set(fallback)];
  }

  /** All facility groups and their items from the Facilities section */
  function extractFacilityGroups (doc) {
    const groups = [];
    doc.querySelectorAll('[data-testid="facility-group-container"]').forEach(group => {
      const titleEl = group.querySelector('h3');
      if (!titleEl) return;
      const name = titleEl.textContent.trim();
      if (!name) return;

      // Description text inside header (if exists)
      const descEl = group.querySelector('h3 + div, h3 div + div');
      const description = descEl ? descEl.textContent.trim() : '';

      // All facility list items
      const facilities = [];
      group.querySelectorAll('li').forEach(item => {
        const text = item.textContent.trim();
        if (text) {
          text.split('\n').forEach(line => {
            if (line.trim()) facilities.push(line.trim());
          });
        }
      });

      if (facilities.length || description) {
        groups.push({ name, facilities, description });
      }
    });

    // Fallback 1: facility-group-container is lazy-loaded by JS and absent from the
    // initial SSR HTML. Try extracting from the __NEXT_DATA__ embedded JSON instead.
    if (groups.length === 0) {
      const fromNextData = extractFacilityGroupsFromNextData(doc);
      if (fromNextData.length > 0) return fromNextData;
    }

    // Fallback 2: extract from Apollo GraphQL client cache embedded in the page.
    if (groups.length === 0) {
      const fromApollo = extractFacilityGroupsFromApolloCache(doc);
      if (fromApollo.length > 0) return fromApollo;
    }

    return groups;
  }

  /**
   * Extract facility groups from the Apollo Client cache that booking.com embeds
   * as an inline script starting with {"ROOT_QUERY"...}.
   * Apollo normalizes each entity to a flat key like "FacilityGroup:123".
   */
  function extractFacilityGroupsFromApolloCache (doc) {
    const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
    for (const script of scripts) {
      const text = script.textContent.trim();
      if (!text.startsWith('{"ROOT_QUERY"')) continue;
      try {
        const cache = JSON.parse(text);
        return parseApolloFacilities(cache);
      } catch (_) {}
    }
    return [];
  }

  function parseApolloFacilities (cache) {
    const groups = [];
    for (const [key, val] of Object.entries(cache)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      // Match cache keys like "FacilityGroup:1", "facilityGroup({...})", etc.
      if (!/facilit/i.test(key)) continue;

      const name       = val.name || val.title || val.groupName || '';
      const facilityRefs = val.facilities || val.amenities || val.items || [];
      const desc       = (typeof val.description === 'string') ? val.description : '';

      if (!name) continue;

      const facs = (Array.isArray(facilityRefs) ? facilityRefs : []).map(ref => {
        if (typeof ref === 'string') return ref;
        // Apollo ref: { __ref: "FacilityItem:123" }
        if (ref?.__ref && cache[ref.__ref]) return cache[ref.__ref].name || cache[ref.__ref].title || '';
        return ref?.name || ref?.title || '';
      }).filter(Boolean);

      if (facs.length || desc) {
        groups.push({ name, facilities: facs, description: desc });
      }
    }
    return groups;
  }

  /**
   * Walk the __NEXT_DATA__ Next.js SSR payload looking for facility group arrays.
   * A facility group looks like { name: string, facilities: string[] } or
   * { name: string, description: string }.
   */
  function extractFacilityGroupsFromNextData (doc) {
    const script = doc.getElementById('__NEXT_DATA__');
    if (!script) return [];
    try {
      const root = JSON.parse(script.textContent);
      const results = [];
      findFacilityGroupsInJson(root, results, 0);
      return results;
    } catch (_) { return []; }
  }

  /**
   * Return the first array property of `obj` whose items look like facility
   * entries (strings, or objects with a name/title field).
   * Tries well-known names first, then falls back to any qualifying array.
   */
  function pickFacilityArray (obj) {
    const named = obj.facilities || obj.amenities || obj.items ||
                  obj.features   || obj.featureList || obj.facilityList;
    if (Array.isArray(named) && named.length) return named;
    for (const v of Object.values(obj)) {
      if (!Array.isArray(v) || !v.length) continue;
      const ok = v.every(x =>
        typeof x === 'string' ||
        (x && typeof x === 'object' && (typeof x.name === 'string' || typeof x.title === 'string'))
      );
      if (ok) return v;
    }
    return [];
  }

  function findFacilityGroupsInJson (obj, results, depth) {
    if (depth > 16 || !obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      // Check if this array looks like a list of facility groups.
      // A group must have a name/title AND either a facility-like array or a description.
      const candidates = obj.filter(item =>
        item && typeof item === 'object' &&
        (typeof item.name === 'string' || typeof item.title === 'string') &&
        (pickFacilityArray(item).length || typeof item.description === 'string')
      );
      if (candidates.length >= 1) {
        const before = results.length;
        candidates.forEach(g => {
          const name    = g.name || g.title || '';
          const rawFacs = pickFacilityArray(g);
          const facs    = rawFacs.map(f =>
            typeof f === 'string' ? f : (f.name || f.title || f.label || '')
          ).filter(Boolean);
          const desc = typeof g.description === 'string' ? g.description : '';
          if (name && (facs.length || desc)) {
            if (!results.some(r => r.name === name)) {
              results.push({ name, facilities: facs, description: desc });
            }
          }
        });
        if (results.length - before >= 2) return;
      }
      obj.forEach(item => findFacilityGroupsInJson(item, results, depth + 1));
      return;
    }

    // Prioritise keys that are more likely to contain facility data
    const entries = Object.entries(obj).sort(([a], [b]) => {
      const aFac = /facilit|amenity|feature/i.test(a) ? -1 : 0;
      const bFac = /facilit|amenity|feature/i.test(b) ? -1 : 0;
      return aFac - bFac;
    });
    for (const [, val] of entries) {
      if (typeof val === 'object') findFacilityGroupsInJson(val, results, depth + 1);
    }
  }

  /**
   * Area info POI blocks: attractions, restaurants, transit, airports etc.
   * Each block = { name: "Top attractions", pois: [{ type, name, distance }] }
   *
   * Structure (as of 2026-02):
   *   [data-testid="poi-block"]
   *     h3 > div.cc045b173b          ← category name
   *     ul[data-testid="poi-block-list"] > li
   *       span[role="listitem"] > div   ← row stack
   *         div.d1bc97eb82              ← name (may contain span.f0595bb7c6 = type)
   *         div.d0fa02509a > div.cbf0753d0c ← distance
   */
  function extractAreaInfo (doc) {
    const fromDom = Array.from(doc.querySelectorAll('[data-testid="poi-block"]')).map(block => {
      const catName = block.querySelector('h3 .cc045b173b')?.textContent.trim()
                   || block.querySelector('h3 div')?.textContent.trim()
                   || block.querySelector('h3')?.textContent.trim()
                   || '';
      const pois = Array.from(
        block.querySelectorAll('[data-testid="poi-block-list"] li')
      ).map(li => {
        // Primary selector; fallback to first child of the listitem row stack
        const stack  = li.querySelector('span[role="listitem"] > div');
        const nameEl = li.querySelector('.d1bc97eb82')
                    || (stack?.children?.length >= 1 ? stack.children[0] : null);
        if (!nameEl) return null;

        const typeEl = nameEl.querySelector('.f0595bb7c6');
        const type   = typeEl?.textContent.trim() || '';
        const clone  = nameEl.cloneNode(true);
        clone.querySelector('.f0595bb7c6')?.remove();
        const name = clone.textContent.trim();

        const distance = li.querySelector('.cbf0753d0c')?.textContent.trim()
                      || (stack?.children?.length >= 2 ? stack.children[1]?.textContent.trim() : '')
                      || '';
        return name ? { type, name, distance } : null;
      }).filter(Boolean);
      return catName ? { name: catName, pois } : null;
    }).filter(Boolean);

    if (fromDom.length) return fromDom;

    // Fallback 1: poi-block is rendered client-side; try __NEXT_DATA__ SSR payload.
    const fromNextData = extractAreaInfoFromNextData(doc);
    if (fromNextData.length) return fromNextData;

    // Fallback 2: Apollo GraphQL client cache.
    return extractAreaInfoFromApolloCache(doc);
  }

  /** Walk __NEXT_DATA__ looking for POI-category arrays (attractions, transit, etc.) */
  function extractAreaInfoFromNextData (doc) {
    const script = doc.getElementById('__NEXT_DATA__');
    if (!script) return [];
    try {
      const root = JSON.parse(script.textContent);
      const results = [];
      findPoiCategoriesInJson(root, results, 0);
      return results;
    } catch (_) { return []; }
  }

  /**
   * Return the first array property of `obj` whose items look like POI entries
   * (objects with a name AND some distance-like field).
   * Tries well-known names first, then falls back to any qualifying array.
   */
  function pickPoiArray (obj) {
    const DIST = x => x && typeof x === 'object' &&
      typeof (x.name || x.title) === 'string' &&
      (x.distance || x.distanceText || x.distanceFormatted ||
       x.distanceInMeters || x.distanceKm || x.walkingTime || x.drivingTime);

    const named = obj.pois || obj.places || obj.items ||
                  obj.landmarks || obj.locations || obj.attractions;
    if (Array.isArray(named) && named.some(DIST)) return named;

    for (const v of Object.values(obj)) {
      if (Array.isArray(v) && v.some(DIST)) return v;
    }
    return [];
  }

  function findPoiCategoriesInJson (obj, results, depth) {
    if (depth > 16 || !obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      // A POI-category array: each element has a name + a list of POI-like entries.
      const candidates = obj.filter(item =>
        item && typeof item === 'object' &&
        typeof (item.name || item.categoryName || item.title) === 'string' &&
        pickPoiArray(item).length > 0
      );
      if (candidates.length >= 1) {
        const before = results.length;
        candidates.forEach(cat => {
          const name    = cat.name || cat.categoryName || cat.title || '';
          const rawPois = pickPoiArray(cat);
          const pois = rawPois.map(p => {
            if (typeof p === 'string') return { name: p, type: '', distance: '' };
            return {
              name:     p.name || p.title || p.label || '',
              type:     p.type || p.category || p.subCategory || '',
              distance: p.distance || p.distanceText || p.distanceFormatted ||
                        p.distanceInMeters || p.distanceKm || '',
            };
          }).filter(p => p.name);
          if (name && pois.length && !results.some(r => r.name === name)) {
            results.push({ name, pois });
          }
        });
        if (results.length - before >= 2) return;
      }
      obj.forEach(item => findPoiCategoriesInJson(item, results, depth + 1));
      return;
    }

    // Walk object keys – check POI/area-related keys first.
    const entries = Object.entries(obj).sort(([a], [b]) => {
      const aScore = /poi|attraction|area|location|nearby|surroundin|transit|transport|station|airport/i.test(a) ? -1 : 0;
      const bScore = /poi|attraction|area|location|nearby|surroundin|transit|transport|station|airport/i.test(b) ? -1 : 0;
      return aScore - bScore;
    });
    for (const [, val] of entries) {
      if (typeof val === 'object') findPoiCategoriesInJson(val, results, depth + 1);
    }
  }

  /** Extract POI categories from the Apollo GraphQL client cache. */
  function extractAreaInfoFromApolloCache (doc) {
    const scripts = Array.from(doc.querySelectorAll('script:not([src])'));
    for (const script of scripts) {
      const text = script.textContent.trim();
      if (!text.startsWith('{"ROOT_QUERY"')) continue;
      try {
        const cache = JSON.parse(text);
        return parseApolloPoiCategories(cache);
      } catch (_) {}
    }
    return [];
  }

  function parseApolloPoiCategories (cache) {
    const POI_KEY = /poi|attraction|transit|transport|station|airport|surrounding|nearby/i;
    const groups  = [];
    for (const [key, val] of Object.entries(cache)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      if (!POI_KEY.test(key)) continue;
      const name    = val.name || val.categoryName || val.title || '';
      if (!name) continue;
      const poisRef = val.pois || val.places || val.items || val.locations || [];
      const pois = (Array.isArray(poisRef) ? poisRef : []).map(ref => {
        const item = ref?.__ref ? cache[ref.__ref] : ref;
        if (!item) return null;
        return {
          name:     item.name || item.title || '',
          type:     item.type || item.category || '',
          distance: item.distance || item.distanceText || '',
        };
      }).filter(p => p?.name);
      if (pois.length) groups.push({ name, pois });
    }
    return groups;
  }

  /** Update the async detail cells for one hotel (by its column index) */
  function updateModalDetailCells (modal, idx, details) {
    const set = (field, html) =>
      modal.querySelectorAll(`[data-bpc-idx="${idx}"][data-bpc-field="${field}"]`)
        .forEach(td => { td.innerHTML = html; });

    const facs = details.popularFacilities;
    set('facilities', facs.length
      ? `<div class="bpc-facility-tags">${facs.map(f => `<span class="bpc-facility-tag">${esc(f)}</span>`).join('')}</div>`
      : '—');

    console.debug('[BPC] Rendering facilityGroups for hotel idx', idx, details.facilityGroups);
    set('facilityGroups', renderFacilityGroups(details.facilityGroups));

    const find = kw => details.areaInfo.find(c => new RegExp(kw, 'i').test(c.name))?.pois ?? [];
    set('attractions', renderPoiList(find('attraction').slice(0, 4)));
    set('transit',     renderPoiList(find('public\\s*transit|public\\s*transport|transit|transport|station|metro|subway|tram|train|bus').slice(0, 4)));
    set('airport',     renderPoiList(find('airport').slice(0, 2)));
  }

  function renderPoiList (pois) {
    if (!pois.length) return '—';
    return `<ul class="bpc-poi-list">${pois.map(p => `
      <li class="bpc-poi-item">
        ${p.type ? `<span class="bpc-poi-type">${esc(p.type)}</span>` : ''}
        <span class="bpc-poi-name">${esc(p.name)}</span>
        <span class="bpc-poi-dist">${esc(p.distance)}</span>
      </li>`).join('')}</ul>`;
  }

  function renderFacilityGroups (groups) {
    if (!groups || !groups.length) return '—';
    return `<div class="bpc-facility-groups">${
      groups.map(g => `
        <div class="bpc-fg-group">
          <div class="bpc-fg-name">${esc(g.name)}</div>
          ${g.description ? `<div class="bpc-fg-desc">${esc(g.description)}</div>` : ''}
          ${g.facilities.length ? `<div class="bpc-fg-items">${
            g.facilities.map(f => `<span class="bpc-facility-tag">${esc(f)}</span>`).join('')
          }</div>` : ''}
        </div>`).join('')
    }</div>`;
  }

  // ─── Compare Modal ────────────────────────────────────────────────────────────

  function openCompareModal () {
    document.getElementById(COMPARE_MODAL_ID)?.remove();

    const modal = document.createElement('div');
    modal.id = COMPARE_MODAL_ID;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Hotel comparison');

    const fields = [
      { label: 'Stars',    render: h => h.stars
          ? '★'.repeat(h.stars) + '<span class="bpc-star-empty">★</span>'.repeat(Math.max(0, 5 - h.stars))
          : '—' },
      { label: 'Score',    render: h => h.score
          ? `<strong class="bpc-modal-score">${esc(h.score)}</strong> <span class="bpc-score-lbl">${esc(h.scoreLabel)}</span><br><small>${esc(h.reviewCount)}</small>`
          : '—' },
      { label: 'Location', render: h => esc(h.location) || '—' },
      { label: 'Distance', render: h => esc(h.distance) || '—' },
      { label: 'Room',     render: h => esc(h.room)     || '—' },
      { label: 'Price',    render: h => h.price
          ? `<strong class="bpc-modal-price">${esc(h.price)}</strong>` : '—' },
      { label: 'Was',      render: h => h.origPrice ? `<s>${esc(h.origPrice)}</s>` : '—' },
      { label: 'Duration', render: h => esc(h.nights)   || '—' },
      { label: 'Payment',  render: h => esc(h.payment)  || '—' },
    ];

    // Async detail rows – filled in after hotel pages are fetched
    const detailRows = [
      { field: 'facilities',     label: 'Top Facilities' },
      { field: 'facilityGroups', label: 'Facilities'     },
      { field: 'attractions',    label: 'Attractions'    },
      { field: 'transit',        label: 'Public Transit' },
      { field: 'airport',        label: 'Airport'        },
    ];

    modal.innerHTML = `
      <div class="bpc-modal-backdrop"></div>
      <div class="bpc-modal-dialog">
        <div class="bpc-modal-header">
          <h2 class="bpc-modal-title">Compare Hotels</h2>
          <button class="bpc-modal-close" aria-label="Close comparison">×</button>
        </div>
        <div class="bpc-modal-body">
          <table class="bpc-compare-table">
            <thead>
              <tr>
                <th class="bpc-ct-label-col"></th>
                ${compareList.map(h => `
                  <th>
                    <a href="${esc(h.url)}" target="_blank" rel="noopener noreferrer" class="bpc-ct-hotel-link">
                      ${h.img ? `<img src="${esc(h.img)}" alt="" class="bpc-ct-hotel-img">` : ''}
                      <span class="bpc-ct-hotel-name">${esc(h.name)}</span>
                    </a>
                  </th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${fields.map(f => `
                <tr>
                  <td class="bpc-ct-label-col">${esc(f.label)}</td>
                  ${compareList.map(h => `<td>${f.render(h)}</td>`).join('')}
                </tr>`).join('')}
              <tr class="bpc-section-divider">
                <td colspan="${compareList.length + 1}">
                  More Details <span class="bpc-fetching-notice">loading…</span>
                </td>
              </tr>
              ${detailRows.map(({ field, label }) => `
                <tr>
                  <td class="bpc-ct-label-col">${esc(label)}</td>
                  ${compareList.map((_, i) => `
                    <td data-bpc-idx="${i}" data-bpc-field="${field}">
                      <div class="bpc-loading"></div>
                    </td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;

    modal.querySelector('.bpc-modal-backdrop')
      .addEventListener('click', () => modal.remove());
    modal.querySelector('.bpc-modal-close')
      .addEventListener('click', () => modal.remove());
    document.addEventListener('keydown', function onEsc (e) {
      if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onEsc); }
    });

    document.body.appendChild(modal);

    // Fetch each hotel's detail page in parallel and fill in the async rows
    let remaining = compareList.length;
    const allFields = detailRows.map(r => r.field);
    compareList.forEach((h, idx) => {
      fetchHotelDetails(h.url).then(details => {
        if (!document.getElementById(COMPARE_MODAL_ID)) return; // modal was closed
        if (details) {
          updateModalDetailCells(modal, idx, details);
        } else {
          allFields.forEach(field =>
            modal.querySelectorAll(`[data-bpc-idx="${idx}"][data-bpc-field="${field}"]`)
              .forEach(td => { td.textContent = '—'; })
          );
        }
        if (--remaining === 0) modal.querySelector('.bpc-fetching-notice')?.remove();
      });
    });
  }

  // ─── Comparison helpers ───────────────────────────────────────────────────────

  /** HTML-escape a string to prevent XSS when injecting into innerHTML */
  function esc (str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showCompareToast (msg) {
    document.querySelector('.bpc-toast')?.remove();
    const t = document.createElement('div');
    t.className   = 'bpc-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2500);
  }

  // ─── Bootstrap ───────────────────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small defer so the page JS has a head-start
    setTimeout(init, 0);
  }

})();
