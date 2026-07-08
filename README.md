# Useful Userscript

A small collection of Tampermonkey userscripts.

## Scripts

| Script | Pages | Purpose |
| --- | --- | --- |
| [Curator Enhanced Filter](userscripts/curator-enhanced-filter-1.7.user.js) | Steam curator accepted games admin page | Adds status filters, reviewer filters, and accept/review date sorting. |
| [Steam Get Trading Card Info](userscripts/steam-get-trading-card-info.user.js) | Steam store app pages and SteamDB sales pages | Fetches Steam trading card counts, average prices, and estimated card income. |
| [Steam Review Edit-tools](userscripts/steam-review-edit-tools-0.12.user.js) | Steam review editor pages | Adds a compact BBCode toolbar, preview, table insertion, and Markdown to BBCode conversion. |
| [SteamDB Table Exporter](userscripts/steamdb-table-export.user.js) | SteamDB search and sales pages | Exports the visible table from the currently opened SteamDB page as CSV or JSON. |

## Installation

Install a userscript manager such as Tampermonkey, then open one of the raw script URLs:

- [Curator Enhanced Filter](https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/curator-enhanced-filter-1.7.user.js)
- [Steam Get Trading Card Info](https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steam-get-trading-card-info.user.js)
- [Steam Curator Review Visitor](https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steam-curator-review-visitor-2.1.user.js)
- [Steam Review Edit-tools](https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steam-review-edit-tools-0.12.user.js)
- [SteamDB Table Exporter](https://raw.githubusercontent.com/lmaple0/useful-userscript/main/userscripts/steamdb-table-export.user.js)

## Curator Enhanced Filter

`Curator Enhanced Filter` enhances the Steam curator accepted games admin page.

Supported pages:

- `https://store.steampowered.com/curator/*/admin/accepted*`
- `https://store.steampowered.com/curator/*/admin/accepted/*`

Main features:

- Filter accepted games by review status.
- Sort by accept date or review date.
- Filter by reviewer/receiver.
- Parses Chinese, English, and Japanese date text where supported by the page markup.

## Steam Review Edit-tools

`Steam Review Edit-tools` adds editing helpers to Steam review text areas.

Supported pages:

- `https://store.steampowered.com/app/*`
- `https://steamcommunity.com/*/recommended/*`

Main features:

- BBCode buttons for bold, italic, underline, strike, URL, lists, quote, code, table, and headings.
- Inserts a fixed 3x3 table template.
- Preview button for rendered review markup.
- Markdown to BBCode converter for common Markdown syntax.

## Steam Get Trading Card Info

`steam-get-trading-card-info.user.js` fetches trading card information from the Steam Community Market.

Supported pages:

- `https://store.steampowered.com/app/*`
- `https://steamdb.info/sales/*`

Main features:

- Shows card count, average card price, and estimated after-fee card income on Steam store app pages.
- Adds SteamDB sales table columns for card income, average price, and card count.
- Supports retry, pause/resume, median price, ignore highest price, and pure income display when SteamDB and Steam wallet countries match.
- Uses direct userscript APIs without a jQuery CDN dependency.

## SteamDB Table Exporter

`steamdb-table-export.user.js` manually exports table data from SteamDB pages you open in the browser.

Supported pages:

- Search pages: `https://steamdb.info/search/*`, table selector `#table-sortable`
- Sales pages: `https://steamdb.info/sales/*`, table selector `#DataTables_Table_0`

The script is configuration-driven. Add a new entry to `PAGE_CONFIGS` for another SteamDB page type:

- `match`: URL matcher
- `tableSelector`: page-specific table selector
- `columns`: page-specific extraction logic
- `mountButton`: where to insert export buttons
- `prepareRow`: optional async hook, useful for lazy fields such as sale time titles

This script only exports the table from the page currently open in your browser. It does not crawl SteamDB or automate bulk page fetching.

