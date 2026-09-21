# Changelog

## 0.3.0 — 2026-09-21

Chart, session awareness, and trust fixes.

### Added
- Intraday ranges `1H` and `4H` (trailing 60/240 min sliced from a 1-minute fetch).
- Market-session awareness from Yahoo trading periods: inline `☾`/`◐` marker
  in the symbol, hover tooltip (`Closed` / `Pre-market` / `After hours`),
  dimmed rows and dimmed bar-tape items while closed. Crypto (24/7) never badges.
- Keyboard navigation: `/` focuses search, `j`/`k` move selection, `Space`
  toggles detail, `x` removes, `r` refreshes, layered `Esc`
  (clear search → deselect → close).
- Stale indicator: `Updated HH:mm (12m ago) · stale` plus tape dimming past
  twice the refresh interval.
- `CAD` display-currency support (default ring: USD, CAD, EUR, GBP, JPY, CHF).

### Changed
- Crypto pairs drop the implied USD quote (`BTC-USD` → `BTC`, `Bitcoin USD` →
  `Bitcoin`); other quotes keep the slash (`BTC-EUR` → `BTC/EUR`).
- Chart line color follows the gain/loss tint instead of series slope, so line
  and numbers always agree (incl. Binance overrides and cached series).
- In-chart price labels moved left, then removed per feedback; `Open` lives on
  the High row; hover tooltip shows price only with the timestamp on the x-axis.
- CoinGecko metadata and chart series fetch only while the panel is open;
  CoinGecko tops up on open (tape needs neither).

### Fixed
- Leading stub bars (e.g. a `0.05` first print) no longer produce +400000%
  deltas or poison Range/High/Low — dropped at parse time (`<= 0` or under 1%
  of the next bar, penny-stock safe).
- Change-column overflow into the price on long multi-range deltas (wider,
  elided column).
- `DEFAULT_CURRENCIES` drift between code, README, and tests.

### Notes
- Quote fetch stays `1d/5m` on the refresh timer (tape requirement); `1H`
  1-minute weight applies only while the panel is open on `1H`.

## 0.2.0

- Scrolling watchlist tape, detail panel with sparklines and range chart,
  Yahoo + Binance + CoinGecko sourcing, display-currency conversion,
  drag-to-reorder watchlist, Yahoo/CoinGecko symbol search.

## 0.0.1

- Original release: stock & crypto ticker with watchlist tape and detail
  panel for the Omarchy bar (Yahoo Finance quotes, no API key).
