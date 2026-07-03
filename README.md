# Useful Userscript

A small collection of Tampermonkey userscripts.

## Scripts

- `userscripts/Curator Enhanced Filter-1.6.user.js`
- `userscripts/Steam Curator Review Visitor-2.1.user.js`
- `userscripts/Steam Review Edit-tools-0.11.user.js`
- `userscripts/steamdb-table-export.user.js`

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
