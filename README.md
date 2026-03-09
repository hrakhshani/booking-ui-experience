# Booking.com Price Calendar

> **A glimpse of what's coming:** In the near future, users will be free to build their own browsing experiences on top of any website — no access to source code required, no permission needed from the platform. This extension is one example of that vision: a personal UX layer I built for myself on top of Booking.com, solving a real need I had.

The extension adds hotel price context directly into the Booking.com date-picker. Price badges appear on each calendar day so you can instantly spot the cheapest check-in window — the same idea as Google Flights' price calendar, but for hotels, built entirely from the outside.

---

## The Bigger Picture

Web extensions are proof that you don't need to wait for a platform to build the experience you want. Anyone can:

- Augment any website's UI with data it doesn't show you
- Automate workflows that the platform makes tedious
- Surface insights hidden in plain sight across pages

This project is a concrete, working example of that idea. The pattern — detect a UI element, fetch relevant data in the background, inject a richer layer on top — can be applied to almost any site. Fork it, adapt it, build your own version for the use case you actually have.

---

## Installation

### Step 1 – Generate the icons

1. Open `generate-icons.html` in Chrome/Edge/Firefox (double-click or drag into the browser).
2. Three files download automatically: `icon16.png`, `icon48.png`, `icon128.png`.
3. Move them into the `icons/` folder inside this project.

> The extension works without icons (Chrome will show a default grey puzzle-piece icon), but the toolbar button looks nicer with them.

### Step 2 – Load as an unpacked extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `booking-price-calendar/` folder (the one containing `manifest.json`).
5. The extension is now installed.

---

## How to use

1. Go to [Booking.com](https://www.booking.com) and search for hotels (any destination + dates).
2. On the results page, click the check-in or check-out date field to open the calendar.
3. Price badges appear automatically on each day.
   - The price shown is the **minimum rate** across visible hotel listings.
   - Colour: green = cheapest third · yellow = mid · red = most expensive third.
4. **Hover** any day with a price badge for a tooltip showing min / avg / max.

> **Tip:** The extension fetches prices for every day shown in the calendar.
> The first batch loads within ~2–5 seconds; further dates load as you navigate months.

---

## How it works

```
User opens calendar
        │
        ▼
content.js detects calendar via MutationObserver
        │
        ├─ Scrapes prices from current search-results page  ─► badge for current dates
        │
        └─ Queues background fetches for each calendar day
                 │
                 ▼  (rate-limited: 1 req/sec, 2 concurrent)
           fetch("/searchresults.html?checkin=...&checkout=...")
                 │
                 ▼
           Parse prices from server-rendered HTML
           (tries DOM selectors → JSON-LD → script-tag patterns)
                 │
                 ▼
           Store in in-memory cache → update badges → colour-code
```

Requests are made with your own session cookies (`credentials: 'include'`), so they look like normal browser navigations and respect your account's currency and country settings.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| No badges appear | Make sure you're on the search **results** page (`/searchresults.html`), not the home page. |
| Prices show "…" forever | Booking.com may have changed their HTML structure. Open DevTools → Console and look for `[BPC]` messages. |
| Extension grayed out | It only activates on `booking.com/searchresults*` URLs. |
| Tooltips are clipped | Scroll so the calendar is more central, or zoom out slightly. |

---

## Privacy

- No data is collected or transmitted anywhere outside Booking.com.
- All price data stays in the extension's in-memory cache (cleared on page navigation).
- The only network requests made are standard Booking.com search-results page loads using your own session.

---

## Limitations & known issues

- Prices are sourced from the **first page** of results (up to ~25 hotels by default).
  They represent what Booking.com sorts to the top, not every available hotel.
- If Booking.com detects unusual traffic it may return a CAPTCHA; the extension will stop fetching and existing badges will remain.
- Booking.com frequently changes their CSS class names. If badges stop working after a Booking.com UI update, the price selectors in `content.js` → `extractPricesFromDoc()` need to be updated.

---

## File structure

```
booking-price-calendar/
├── manifest.json          Chrome extension manifest (v3)
├── content.js             Main logic – scraping, fetching, badge injection
├── styles.css             Badge + tooltip styles injected into Booking.com
├── popup.html             Toolbar button popup
├── popup.js               Popup status logic
├── generate-icons.html    Open in browser to create PNG icons
├── icons/
│   ├── icon16.png         (generated)
│   ├── icon48.png         (generated)
│   └── icon128.png        (generated)
└── README.md              This file
```
