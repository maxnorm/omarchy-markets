# Markets for Omarchy

A stock and crypto ticker with a watchlist for the Omarchy Quattro bar.
The tape scrolls your watchlist's symbols in the theme's green/red;
click it for a panel with sparklines, a detail chart with
range selector, key stats, and a currency switch.

Stocks and indices come from Yahoo Finance. Crypto prices use Binance spot
with Yahoo as fallback; CoinGecko provides market cap, circulating supply,
and 24h data. No API key required.

## Install

```sh
omarchy plugin add <git-url> --enable
```

The widget lands in the bar's center section. Move it with:

```sh
omarchy bar move mn.markets --section right
```

## Usage

| where | action | effect |
|-------|--------|--------|
| tape | left click | open / close the panel (Esc closes, Tab switches panels) |
| tape | middle click | refresh now |
| tape | right click / hover | pause the tape (hover pauses while pointing) |
| panel | `1H 4H 1D 5D 1M 3M 6M YTD 1Y 5Y MAX` | chart range (persisted; `1H`/`4H` slice the trailing 60/240 min) |
| panel | `/` `j` `k` `Space` `x` `r` | focus search · move selection · toggle detail · remove symbol · refresh |
| panel | `Esc` | clear search → deselect → close (one layer per press) |
| panel | hover the `☾`/`◐` marker | market session tooltip (`Closed` / `Pre-market` / `After hours`) |
| panel | `USD ⇄` chip | left click: next currency; right click: previous |
| panel | click a row | show that symbol's chart and stats |
| panel | `×` on row hover | remove symbol from watchlist |
| panel | drag the grip handle (or press and hold a row) | reorder the watchlist (bar ticker follows the new order) |
| panel | `Add symbol…` | type to search Yahoo, click a result or press Enter to add |
| panel | `Open on Binance/Yahoo ↗` | open the selected symbol on its price source (Binance for enriched crypto, Yahoo otherwise) |

IPC (for keybindings): `omarchy-shell mn.markets toggle|open|close|refresh|pause`

## Configure

Settings live on the widget's entry in `~/.config/omarchy/shell.json` and apply
instantly:

```sh
omarchy bar set mn.markets tickerWidth 260
omarchy bar set mn.markets scrollSpeed 30
omarchy bar set mn.markets currency EUR
omarchy bar set mn.markets compact true --json    # "AAPL ▲0.42%" without the price
```

| key | default | meaning |
|-----|---------|---------|
| `refreshMinutes` | `5` | quote refresh interval (minimum 1) |
| `tickerWidth` | `180` | tape width in px (minimum 80) |
| `scrollSpeed` | `20` | tape speed in px/s; `0` = static |
| `compact` | `false` | drop the price from the tape |
| `chartRange` | `1d` | one of `1h 4h 1d 5d 1mo 3mo 6mo ytd 1y 5y max` (the panel chips set this; `1h`/`4h` slice the last 60/240 min off a 1-minute intraday fetch) |
| `currency` | `""` (native) | show every price in this currency, e.g. `EUR` |
| `currencies` | `["USD","CAD","EUR","GBP","JPY","CHF"]` | what the currency chip cycles through |
| `upColor` / `downColor` | theme `green` / `red` | override the tints with a hex color |

Symbols are managed through the panel UI, persisted in
`watchlist.json` in `~/.local/state/omarchy/plugins/mn.markets/`.

Closed markets show a `☾` marker inline in the symbol (hover for the session
tooltip); closed rows and their bar-tape items dim. Crypto trades 24/7 and
never badges. A stale feed is marked `· stale` in the header and dims the tape.

### Crypto support

Type a crypto ticker like `BTC` in the add-symbol input and it auto-resolves
to `BTC-USD`. Pairs display without the implied USD quote (`BTC`, `Bitcoin`);
other quotes keep the slash (`BTC/EUR`). CoinGecko provides market cap,
circulating supply, 24h high/low, and 24h change percentage. The detail panel
shows crypto-specific stats instead of prev close / open / 52w range.

### Dependencies

Network access to Yahoo Finance, Binance, and CoinGecko (all keyless).
`python3` (atomic watchlist writes) and `xdg-open` (external links) from the
base system. No config is overwritten: settings live on the widget's
`shell.json` entry, state in `~/.local/state/omarchy/plugins/mn.markets/`.

## Develop

```sh
node --test test/model.test.js                              # Model.js unit tests (102 tests)
qmllint -I /usr/share/omarchy/shell Panel.qml
omarchy plugin validate "$PWD"
rsync -a --delete --exclude .git ./ ~/.config/omarchy/plugins/mn.markets/
omarchy restart shell                                       # QML is cached; restart to reload
```

## Remove

```sh
omarchy plugin remove mn.markets
```

## License

MIT
