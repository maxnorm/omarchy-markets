// Pure logic for the Markets bar widget. No QML imports: this file is loaded
// by Panel.qml/BarWidget.qml through `import "Model.js" as Model` and by the
// node test-suite through require(), so it stays ES5-style and ends with a
// module.exports guard (same convention as omarchy.weather's Model.js).

var DEFAULT_SYMBOLS = ["AAPL", "NVDA", "GOOGL"]

function trimString(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

// Accepts a JSON array (the documented form) or a comma/space/semicolon
// separated string (what `omarchy bar set ... symbols AAPL,NVDA` stores when
// --json is forgotten). Anything else, or an empty result, means the defaults.
function normalizeSymbols(value, fallback) {
  var defaults = fallback || DEFAULT_SYMBOLS
  var list = []
  if (Array.isArray(value)) {
    list = value
  } else if (typeof value === "string") {
    list = value.split(/[\s,;]+/)
  } else if (value && typeof value === "object" && typeof value.length === "number") {
    for (var k = 0; k < value.length; k++) list.push(value[k])
  }

  var out = []
  for (var i = 0; i < list.length; i++) {
    var symbol = trimString(list[i]).toUpperCase()
    if (symbol === "" || out.indexOf(symbol) !== -1) continue
    out.push(symbol)
  }
  return out.length ? out : defaults.slice()
}

function refreshMinutes(value, fallback) {
  var d = fallback === undefined || fallback === null ? 5 : fallback
  var n = parseInt(String(value), 10)
  if (isNaN(n)) return d
  return n < 1 ? 1 : n
}

function cycleSeconds(value, fallback) {
  var d = fallback === undefined || fallback === null ? 10 : fallback
  var n = parseInt(String(value), 10)
  if (isNaN(n) || n < 0) return d
  return n
}

var CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"
var QUOTE_PAGE_URL = "https://finance.yahoo.com/quote/"

// Panel chart ranges and the Yahoo bar interval that keeps each one at a
// sensible point count (60 / 48 / 78 / 130 / 22 / 65 / 125 / ~200 / 52 / ~260 / capped).
// "1h"/"4h" are intraday windows sliced client-side from a 1d/1m fetch
// (Yahoo has no sub-day range parameter).
var CHART_RANGES = ["1h", "4h", "1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "5y", "max"]
var CHART_INTERVALS = { "1h": "1m", "4h": "5m", "1d": "5m", "5d": "15m", "1mo": "1d", "3mo": "1d", "6mo": "1d", "ytd": "1d", "1y": "1wk", "5y": "1wk", "max": "1mo" }

function chartRange(value, fallback) {
  var d = fallback === undefined || fallback === null ? "1d" : fallback
  var r = trimString(value).toLowerCase()
  return CHART_RANGES.indexOf(r) === -1 ? d : r
}

function chartInterval(range) {
  return CHART_INTERVALS[range] || "1d"
}

// Yahoo range parameter for a panel range. Intraday windows reuse the 1d
// fetch and are trimmed client-side (see windowMinutes/trimSeries).
function fetchRange(range) {
  var r = chartRange(range)
  if (r === "1h" || r === "4h") return "1d"
  return r
}

// Trailing window in minutes the series is trimmed to, or 0 for no trim.
function windowMinutes(range) {
  if (chartRange(range) === "1h") return 60
  if (chartRange(range) === "4h") return 240
  return 0
}

// Keep points within the trailing `minutes` of the last point.
function trimSeries(series, minutes) {
  var list = series || []
  var m = toNumber(minutes)
  if (m === null || m <= 0 || list.length < 2) return list
  var cutoff = list[list.length - 1].t - m * 60
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].t >= cutoff) out.push(list[i])
  }
  return out.length >= 2 ? out : list
}

// The quote fetch always uses range=1d (previousClose there is the prior
// session's close); other ranges are only used for chart series.
function chartUrl(symbol, range) {
  var r = chartRange(range)
  return CHART_URL + encodeURIComponent(String(symbol)) + "?range=" + fetchRange(r) + "&interval=" + chartInterval(r)
}

function tickerWidth(value, fallback) {
  var d = fallback === undefined || fallback === null ? 180 : fallback
  var n = parseInt(String(value), 10)
  if (isNaN(n)) return d
  return n < 80 ? 80 : n
}

function scrollSpeed(value, fallback) {
  var d = fallback === undefined || fallback === null ? 20 : fallback
  var n = parseFloat(String(value))
  if (isNaN(n) || n < 0) return d
  return n
}

// One curl invocation for every symbol so the shell owns a single child
// process per refresh. `-w "\n"` terminates each response, so stdout is one
// JSON document per line in request order. Deliberately no `-f`: a 404 for an
// unknown symbol then still yields Yahoo's error JSON on its own line instead
// of an empty line, which keeps the other symbols' lines aligned.
function curlCommand(symbols, userAgent, range) {
  var cmd = ["curl", "-sS", "--max-time", "10", "--max-filesize", "5242880", "-A", String(userAgent || "omarchy-markets"), "-w", "\n"]
  for (var i = 0; i < symbols.length; i++) cmd.push(chartUrl(symbols[i], range))
  return cmd
}

function quoteUrl(symbol) {
  return QUOTE_PAGE_URL + encodeURIComponent(String(symbol))
}

function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'"
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null
  var n = Number(value)
  return isNaN(n) ? null : n
}

// ---- Crypto detection. Yahoo serves crypto via pairs like "BTC-USD", but
//      users may type just "BTC" or "bitcoin". Known tickers get the suffix
//      appended; anything else is left alone (it could be a stock symbol).

var KNOWN_CRYPTOS = {
  "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "ripple",
  "ADA": "cardano", "DOGE": "dogecoin", "AVAX": "avalanche-2",
  "DOT": "polkadot", "MATIC": "matic-network", "LINK": "chainlink",
  "UNI": "uniswap", "ATOM": "cosmos", "LTC": "litecoin", "FIL": "filecoin",
  "APT": "aptos", "ARB": "arbitrum", "OP": "optimism", "NEAR": "near",
  "ICP": "internet-computer", "VET": "vechain", "HBAR": "hedera-hashgraph",
  "ALGO": "algorand", "FTM": "fantom", "AAVE": "aave", "MKR": "maker",
  "GRT": "the-graph", "SAND": "the-sandbox", "MANA": "decentraland",
  "AXS": "axie-infinity", "SHIB": "shiba-inu", "PEPE": "pepe",
  "WIF": "dogwifcoin", "BONK": "bonk", "RENDER": "render-token",
  "INJ": "injective-protocol", "SUI": "sui", "SEI": "sei-network",
  "TIA": "celestia", "JUP": "jupiter-exchange-solana", "PYTH": "pyth-network",
  "TRX": "tron", "BCH": "bitcoin-cash", "ETC": "ethereum-classic",
  "XLM": "stellar", "BNB": "binancecoin"
}

var CRYPTO_SUFFIXES = ["-USDT", "-USD", "-EUR", "-GBP", "-JPY", "-BTC", "-ETH"]

function isCryptoSymbol(symbol) {
  var s = trimString(symbol).toUpperCase()
  if (s === "") return false
  for (var i = 0; i < CRYPTO_SUFFIXES.length; i++) {
    if (s.length > CRYPTO_SUFFIXES[i].length && s.indexOf(CRYPTO_SUFFIXES[i]) === s.length - CRYPTO_SUFFIXES[i].length) return true
  }
  return KNOWN_CRYPTOS.hasOwnProperty(s)
}

// Display format: BTC-USD -> BTC (USD quote is implied), BTC-EUR -> BTC/EUR,
// AAPL stays AAPL.
function displaySymbol(symbol) {
  var s = trimString(symbol)
  if (isCryptoSymbol(s)) {
    var u = s.toUpperCase()
    if (u.length > 5 && u.indexOf("-USDT") === u.length - 5) {
      return s.substring(0, s.length - 5)
    }
    if (u.length > 4 && u.indexOf("-USD") === u.length - 4) {
      return s.substring(0, s.length - 4)
    }
    for (var i = 0; i < CRYPTO_SUFFIXES.length; i++) {
      var suffix = CRYPTO_SUFFIXES[i]
      if (s.length > suffix.length && u.indexOf(suffix) === s.length - suffix.length) {
        return s.substring(0, s.length - suffix.length) + "/" + s.substring(s.length - suffix.length + 1)
      }
    }
  }
  return s
}

function normalizeSymbol(input) {
  var s = trimString(input).toUpperCase()
  if (s === "") return ""
  if (KNOWN_CRYPTOS.hasOwnProperty(s)) return s + "-USD"
  return s
}

function cryptoIdFromSymbol(symbol) {
  var s = trimString(symbol).toUpperCase()
  var base = s.replace(/-[A-Z]+$/, "")
  return KNOWN_CRYPTOS[base] || ""
}

function isIndexSymbol(symbol) {
  var s = trimString(symbol)
  return s.charAt(0) === "^"
}

function assetType(symbol) {
  if (isIndexSymbol(symbol)) return "index"
  if (isCryptoSymbol(symbol)) return "crypto"
  return "stock"
}

// Yahoo appends the quote currency to crypto names ("Bitcoin USD").
// The quote is already implied by the pair, so drop it for crypto only.
function cleanAssetName(name, symbol) {
  var n = trimString(name)
  if (n === "" || !isCryptoSymbol(symbol)) return n
  var u = String(symbol).toUpperCase()
  var quotes = ["USD", "USDT"]
  var dash = u.lastIndexOf("-")
  if (dash !== -1) {
    var q = u.substring(dash + 1)
    if (quotes.indexOf(q) === -1) quotes.unshift(q)
  }
  for (var i = 0; i < quotes.length; i++) {
    var tail = " " + quotes[i]
    if (n.length > tail.length && n.toUpperCase().indexOf(tail) === n.length - tail.length) {
      return n.substring(0, n.length - tail.length)
    }
  }
  return n
}

function emptyQuote(symbol, error) {
  var sym = String(symbol || "")
  return {
    symbol: sym,
    name: "",
    currency: "",
    exchange: "",
    price: null,
    prevClose: null,
    change: null,
    changePct: null,
    dayLow: null,
    dayHigh: null,
    week52Low: null,
    week52High: null,
    marketTime: null,
    open: null,
    volume: null,
    series: [],
    error: String(error || ""),
    assetType: assetType(sym),
    marketCap: null,
    circulatingSupply: null,
    totalVolume: null,
    coingeckoId: "",
    regularStart: null,
    regularEnd: null,
    preStart: null,
    postEnd: null
  }
}

// timestamp[] + indicators.quote[0].close[] -> [{t, c}], nulls and stub
// bars skipped (Yahoo occasionally emits a bad first bar, e.g. a 0.05
// print before a 222 stock, which then poisons tfChange and bounds).
function parseSeries(result) {
  var stamps = result && result.timestamp ? result.timestamp : []
  var quoteBlock = result && result.indicators && result.indicators.quote ? result.indicators.quote[0] : null
  var closes = quoteBlock && quoteBlock.close ? quoteBlock.close : []
  var out = []
  for (var i = 0; i < stamps.length && i < closes.length; i++) {
    var t = toNumber(stamps[i])
    var c = toNumber(closes[i])
    if (t === null || c === null) continue
    out.push({ t: t, c: c })
  }
  return dropLeadingStubs(out)
}

// Drop leading stub bars: non-positive/non-finite prints, then any leading
// bar under 1% of the next one. Leading-only is the safety property — a
// legit penny stock has neighbors near its own price, and real gaps are
// far below the 100x tripwire. Never drops below 1 point.
function dropLeadingStubs(series) {
  var list = series || []
  var out = list.slice()
  while (out.length > 1) {
    var first = toNumber(out[0].c)
    if (first === null || !(first > 0)) { out.shift(); continue }
    var second = toNumber(out[1].c)
    if (second === null || !(second > 0)) break
    if (first * 100 < second) { out.shift(); continue }
    break
  }
  if (out.length && !(toNumber(out[0].c) > 0)) return []
  return out
}

function firstOpen(result) {
  var quoteBlock = result && result.indicators && result.indicators.quote ? result.indicators.quote[0] : null
  var opens = quoteBlock && quoteBlock.open ? quoteBlock.open : []
  for (var i = 0; i < opens.length; i++) {
    var o = toNumber(opens[i])
    if (o !== null && o > 0) return o
  }
  return null
}

// One line of curl output -> Quote. Never throws.
function parseChartResponse(line) {
  var raw = trimString(line)
  if (raw === "") return emptyQuote("", "No data")

  var data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return emptyQuote("", "Bad response")
  }

  var chart = data && data.chart
  if (!chart) return emptyQuote("", "Bad response")

  var result = chart.result && chart.result[0]
  if (!result || !result.meta) {
    var code = chart.error && (chart.error.code || chart.error.description)
    return emptyQuote("", code ? String(code) : "No data")
  }

  var meta = result.meta
  var price = toNumber(meta.regularMarketPrice)
  // previousClose is the prior session's close whenever Yahoo sends it
  // (intraday ranges); chartPreviousClose is the close before the *range*,
  // which only coincides with it for range=1d.
  var prev = toNumber(meta.previousClose)
  if (prev === null) prev = toNumber(meta.chartPreviousClose)
  var change = price !== null && prev !== null ? price - prev : null
  var changePct = change !== null && prev ? (change / prev) * 100 : null

  var quote = emptyQuote(meta.symbol, price === null ? "No data" : "")
  quote.name = cleanAssetName(trimString(meta.shortName || meta.longName || meta.symbol), meta.symbol)
  quote.currency = String(meta.currency || "")
  quote.exchange = String(meta.fullExchangeName || meta.exchangeName || "")
  quote.price = price
  quote.prevClose = prev
  quote.change = change
  quote.changePct = changePct
  quote.dayLow = toNumber(meta.regularMarketDayLow)
  quote.dayHigh = toNumber(meta.regularMarketDayHigh)
  quote.week52Low = toNumber(meta.fiftyTwoWeekLow)
  quote.week52High = toNumber(meta.fiftyTwoWeekHigh)
  quote.marketTime = toNumber(meta.regularMarketTime)
  quote.open = firstOpen(result)
  quote.volume = toNumber(meta.regularMarketVolume)
  quote.series = parseSeries(result)
  var ctp = meta.currentTradingPeriod || {}
  quote.preStart = toNumber(ctp.pre && ctp.pre.start)
  quote.regularStart = toNumber(ctp.regular && ctp.regular.start)
  quote.regularEnd = toNumber(ctp.regular && ctp.regular.end)
  quote.postEnd = toNumber(ctp.post && ctp.post.end)
  return quote
}

// Chart-range fetch -> { SYM: series }. Reuses parseQuoteLines for the
// symbol/position matching; only the series is kept. Intraday windows
// ("1h"/"4h") are trimmed to their trailing minutes, then re-cleaned —
// a window cut can expose a new leading stub.
function parseSeriesLines(text, symbols, range) {
  var quotes = parseQuoteLines(text, symbols)
  var win = windowMinutes(range)
  var out = {}
  for (var i = 0; i < quotes.length; i++) {
    var s = quotes[i].series || []
    if (win > 0) s = dropLeadingStubs(trimSeries(s, win))
    out[quotes[i].symbol] = s
  }
  return out
}

// Whole curl stdout -> one Quote per requested symbol, in request order.
// Successful lines are matched by symbol; error lines carry no symbol, so
// they are attributed by position when curl produced exactly one line per
// symbol. Anything unmatched becomes a "No data" quote.
function parseQuoteLines(text, symbols) {
  var lines = String(text || "").split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()

  var positional = lines.length === symbols.length
  var bySymbol = {}
  var byIndex = []
  for (var i = 0; i < lines.length; i++) {
    var parsed = parseChartResponse(lines[i])
    byIndex.push(parsed)
    if (!parsed.error && parsed.symbol) bySymbol[parsed.symbol.toUpperCase()] = parsed
  }

  var out = []
  for (var j = 0; j < symbols.length; j++) {
    var symbol = String(symbols[j]).toUpperCase()
    var quote = bySymbol[symbol]
    if (!quote && positional && byIndex[j] && byIndex[j].error) quote = byIndex[j]
    if (!quote) quote = emptyQuote(symbol, "No data")
    quote.symbol = symbol
    out.push(quote)
  }
  return out
}

function isValid(quote) {
  return !!quote && !quote.error && quote.price !== null && quote.price !== undefined
}

function isDown(quote) {
  return isValid(quote) && quote.change !== null && quote.change !== undefined && quote.change < 0
}

function isUp(quote) {
  return isValid(quote) && quote.change !== null && quote.change !== undefined && quote.change > 0
}

function validCount(quotes) {
  var list = quotes || []
  var n = 0
  for (var i = 0; i < list.length; i++) if (isValid(list[i])) n++
  return n
}

function firstValidIndex(quotes) {
  var list = quotes || []
  for (var i = 0; i < list.length; i++) if (isValid(list[i])) return i
  return -1
}

// Next valid quote index in `step` direction (+1 forward, -1 back), wrapping
// around and skipping failed symbols. -1 when nothing is valid.
function nextIndex(current, quotes, step) {
  var list = quotes || []
  var n = list.length
  if (!n) return -1
  var dir = step < 0 ? -1 : 1
  var hasCurrent = typeof current === "number" && current >= 0 && current < n
  var start = hasCurrent ? current : (dir > 0 ? -1 : 0)
  for (var k = 1; k <= n; k++) {
    var idx = (((start + dir * k) % n) + n) % n
    if (isValid(list[idx])) return idx
  }
  return -1
}

// "Not Found" is permanent (typo or delisted); everything else may be a
// transient network/rate-limit failure worth a quick retry.
function shouldRetry(quotes) {
  var list = quotes || []
  if (!list.length) return true
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].error && list[i].error !== "Not Found") return true
  }
  return false
}

// ---- Market session. Derived from Yahoo's currentTradingPeriod
//      (regular start/end, pre start, post end — epoch seconds).
//      Returns "open" | "pre" | "post" | "closed" | "" (unknown).
//      Crypto trades 24/7 so it never badges.

function marketStatus(quote, nowMs) {
  if (!quote || quote.assetType === "crypto") return ""
  var rs = toNumber(quote.regularStart)
  var re = toNumber(quote.regularEnd)
  if (rs === null || re === null) return ""
  var now = toNumber(nowMs)
  if (now === null) now = Date.now()
  var nowS = Math.floor(now / 1000)
  var preS = toNumber(quote.preStart)
  var postE = toNumber(quote.postEnd)
  if (nowS >= rs && nowS <= re) return "open"
  if (preS !== null && nowS >= preS && nowS < rs) return "pre"
  if (postE !== null && nowS > re && nowS <= postE) return "post"
  return "closed"
}

function marketStatusLabel(status) {
  if (status === "closed") return "Closed"
  if (status === "pre") return "Pre-market"
  if (status === "post") return "After hours"
  return ""
}

function priceDecimals(price) {
  return Math.abs(price) < 1 ? 4 : 2
}

function withThousands(fixed) {
  var parts = fixed.split(".")
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return parts.join(".")
}

function formatPrice(price) {
  var n = toNumber(price)
  if (n === null) return ""
  return withThousands(n.toFixed(priceDecimals(n)))
}

function arrowFor(change) {
  if (change < 0) return "\u25bc"
  if (change > 0) return "\u25b2"
  return "\u2022"
}

function formatPercent(changePct) {
  var n = toNumber(changePct)
  return n === null ? "" : Math.abs(n).toFixed(2) + "%"
}

// "▲ +1.28 (+0.42%)" for the panel's change column; "" when unknown.
function formatChangeValues(change, changePct, price) {
  var c = toNumber(change)
  if (c === null) return ""
  var decimals = price !== null && price !== undefined ? priceDecimals(price) : 2
  var signed = (c < 0 ? "-" : "+") + withThousands(Math.abs(c).toFixed(decimals))
  var p = toNumber(changePct)
  var pct = p === null ? "" : (p < 0 ? "-" : "+") + Math.abs(p).toFixed(2) + "%"
  return arrowFor(c) + " " + signed + (pct ? " (" + pct + ")" : "")
}

function formatChange(quote) {
  if (!quote) return ""
  return formatChangeValues(quote.change, quote.changePct, quote.price)
}

// Bar pill text: "AAPL 305.59 ▲0.42%", or "AAPL ▲0.42%" when compact.
function barLabel(quote, compact) {
  if (!quote) return ""
  var symbol = displaySymbol(String(quote.symbol || ""))
  if (!isValid(quote)) return symbol + " !"
  var parts = [symbol]
  if (!compact) parts.push(formatPrice(quote.price))
  var change = toNumber(quote.change)
  var pct = formatPercent(quote.changePct)
  if (change !== null && pct) parts.push(arrowFor(change) + " " + pct)
  return parts.join(" ")
}

// Vertical bars are only ~28px wide: symbol on one line, direction on the next.
function verticalLabel(quote) {
  if (!quote) return ""
  var symbol = displaySymbol(String(quote.symbol || ""))
  if (!isValid(quote)) return symbol + "\n!"
  var change = toNumber(quote.change)
  return symbol + "\n" + (change === null ? "\u2022" : arrowFor(change))
}

function loadingLabel(symbol) {
  var s = displaySymbol(trimString(symbol))
  return (s ? s + " " : "") + "\u2026"
}

// ---- Chart geometry (pure so Canvas painting stays trivial and testable).

function seriesBounds(series) {
  var list = series || []
  if (!list.length) return null
  var min = list[0].c
  var max = list[0].c
  for (var i = 1; i < list.length; i++) {
    if (list[i].c < min) min = list[i].c
    if (list[i].c > max) max = list[i].c
  }
  return { min: min, max: max }
}

function seriesDirection(series) {
  var list = series || []
  if (list.length < 2) return 0
  return list[list.length - 1].c - list[0].c
}

function scaleY(value, bounds, height, padding) {
  var span = bounds.max - bounds.min
  var inner = height - padding * 2
  if (span <= 0) return padding + inner / 2
  return padding + ((bounds.max - value) / span) * inner
}

// x is proportional to time (so weekend gaps in a 5d series read correctly),
// y is scaled between the series' min (bottom) and max (top).
function seriesPoints(series, width, height, padding) {
  var list = series || []
  var bounds = seriesBounds(list)
  if (!bounds) return []
  var pad = padding || 0
  var t0 = list[0].t
  var t1 = list[list.length - 1].t
  var span = t1 - t0
  var innerW = width - pad * 2
  var out = []
  for (var i = 0; i < list.length; i++) {
    var x = span > 0 ? pad + ((list[i].t - t0) / span) * innerW : pad
    out.push({ x: x, y: scaleY(list[i].c, bounds, height, pad) })
  }
  return out
}

// y for a reference value (e.g. previous close) or null when it would fall
// outside the plotted bounds.
function valueToY(value, bounds, height, padding) {
  var v = toNumber(value)
  if (v === null || !bounds) return null
  if (v < bounds.min || v > bounds.max) return null
  return scaleY(v, bounds, height, padding || 0)
}

// ---- Ticker tape.

function tapeItems(quotes, compact, nowMs) {
  var list = quotes || []
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (!isValid(list[i])) continue
    out.push({
      symbol: displaySymbol(String(list[i].symbol || "")),
      text: barLabel(list[i], compact),
      up: isUp(list[i]),
      down: isDown(list[i]),
      closed: marketStatus(list[i], nowMs) === "closed"
    })
  }
  return out
}

// ---- Colors. Omarchy themes expose their palette in
//      ~/.local/state/omarchy/current/theme/colors.toml (`green = "#a9b665"`);
//      the shell's Color singleton only carries foreground/accent/urgent/muted,
//      so up/down tints are read from that file, with settings overrides.

function normalizeColor(value) {
  var s = trimString(value).toLowerCase()
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s) ? s : ""
}

function parseThemeColor(tomlText, key) {
  var lines = String(tomlText || "").split("\n")
  var pattern = new RegExp("^\\s*" + key + "\\s*=\\s*[\"']([^\"']*)[\"']")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(pattern)
    if (m) return normalizeColor(m[1])
  }
  return ""
}

function formatVolume(value) {
  var n = toNumber(value)
  if (n === null) return ""
  var abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M"
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K"
  return String(Math.round(n))
}

function formatMarketCap(value) {
  var n = toNumber(value)
  if (n === null) return ""
  var abs = Math.abs(n)
  if (abs >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T"
  if (abs >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B"
  if (abs >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M"
  if (abs >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K"
  return "$" + Math.round(n)
}

function formatSupply(value, symbol) {
  var n = toNumber(value)
  if (n === null) return ""
  var suffix = symbol ? " " + trimString(symbol).replace(/-[A-Z]+$/, "") : ""
  var abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B" + suffix
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M" + suffix
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K" + suffix
  return String(Math.round(n)) + suffix
}

// ---- Freshness / staleness. lastUpdated is ms epoch (or Date-able);
//      stale when age exceeds 2x the refresh interval (minimum 2 min).

function ageMs(lastUpdatedMs, nowMs) {
  var t = toNumber(lastUpdatedMs)
  var now = toNumber(nowMs)
  if (t === null || now === null) return null
  var age = now - t
  return age < 0 ? 0 : age
}

function ageLabel(lastUpdatedMs, nowMs) {
  var age = ageMs(lastUpdatedMs, nowMs)
  if (age === null) return ""
  var s = Math.floor(age / 1000)
  if (s < 45) return "just now"
  var m = Math.floor(s / 60)
  if (m < 60) return m + "m ago"
  var h = Math.floor(m / 60)
  if (h < 24) return h + "h " + (m % 60) + "m ago"
  return Math.floor(h / 24) + "d ago"
}

function isStale(lastUpdatedMs, refreshMin, nowMs) {
  var age = ageMs(lastUpdatedMs, nowMs)
  if (age === null) return false
  var minutes = parseInt(String(refreshMin), 10)
  if (isNaN(minutes) || minutes < 1) minutes = 5
  return age > minutes * 2 * 60 * 1000
}

// ---- Display currency. Yahoo serves FX pairs through the same chart
//      endpoint ("USDEUR=X" -> 1 USD in EUR), so every quote can be shown in
//      one chosen currency without another data source.

var DEFAULT_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "JPY", "CHF"]

function normalizeCurrency(value) {
  var s = trimString(value).toUpperCase()
  return /^[A-Z]{3}$/.test(s) ? s : ""
}

function normalizeCurrencies(value, fallback) {
  var defaults = fallback || DEFAULT_CURRENCIES
  var list = []
  if (Array.isArray(value)) list = value
  else if (typeof value === "string") list = value.split(/[\s,;]+/)
  else if (value && typeof value === "object" && typeof value.length === "number") {
    for (var k = 0; k < value.length; k++) list.push(value[k])
  }
  var out = []
  for (var i = 0; i < list.length; i++) {
    var code = normalizeCurrency(list[i])
    if (code === "" || out.indexOf(code) !== -1) continue
    out.push(code)
  }
  return out.length ? out : defaults.slice()
}

// Cycle "" (native, each quote in its own currency) -> list[0] -> ... -> "".
function currencyCycle(current, list, step) {
  var ring = [""].concat(list || [])
  var idx = ring.indexOf(normalizeCurrency(current))
  if (idx === -1) idx = 0
  var dir = step < 0 ? -1 : 1
  return ring[(((idx + dir) % ring.length) + ring.length) % ring.length]
}

// Yahoo reports some markets in minor units: London in pence ("GBp"/"GBX"),
// Johannesburg in cents ("ZAc"), Tel Aviv in agorot ("ILA"). Map those to the
// major code plus a factor.
var MINOR_UNITS = { "GBp": "GBP", "GBX": "GBP", "ZAc": "ZAR", "ILA": "ILS" }

function quoteCurrency(currency) {
  var raw = trimString(currency)
  if (raw === "") return { code: "", factor: 1 }
  if (MINOR_UNITS[raw]) return { code: MINOR_UNITS[raw], factor: 0.01 }
  return { code: raw.toUpperCase(), factor: 1 }
}

function ratePairs(quotes, display) {
  var target = normalizeCurrency(display)
  if (target === "") return []
  var list = quotes || []
  var out = []
  for (var i = 0; i < list.length; i++) {
    if (!isValid(list[i])) continue
    var from = quoteCurrency(list[i].currency).code
    if (from === "" || from === target) continue
    var pair = from + target + "=X"
    if (out.indexOf(pair) === -1) out.push(pair)
  }
  return out
}

function parseRateLines(text, pairs) {
  var quotes = parseQuoteLines(text, pairs)
  var out = {}
  for (var i = 0; i < quotes.length; i++) {
    if (isValid(quotes[i])) out[quotes[i].symbol] = quotes[i].price
  }
  return out
}

// Multiplier turning a price in `currency` into `display`; 1 when no
// conversion applies, null when the needed rate is not (yet) known.
function rateFor(currency, display, rates) {
  var target = normalizeCurrency(display)
  var from = quoteCurrency(currency)
  if (target === "") return 1
  if (from.code === "") return null
  if (from.code === target) return from.factor
  var rate = rates ? toNumber(rates[from.code + target + "=X"]) : null
  return rate === null ? null : rate * from.factor
}

function convertSeries(series, rate) {
  var list = series || []
  var r = toNumber(rate)
  if (r === null || r === 1) return list
  var out = []
  for (var i = 0; i < list.length; i++) out.push({ t: list[i].t, c: list[i].c * r })
  return out
}

function scaled(value, rate) {
  var n = toNumber(value)
  return n === null ? null : n * rate
}

// Copy of `quote` with money fields and series in `display`. Percentages are
// currency-independent. Falls back to the untouched quote (converted: false)
// when the rate is unknown or no conversion applies.
function convertQuote(quote, display, rates) {
  if (!quote) return quote
  var out = {}
  for (var key in quote) out[key] = quote[key]
  out.nativeCurrency = quote.currency
  out.converted = false
  if (!isValid(quote)) return out
  var target = normalizeCurrency(display)
  var from = quoteCurrency(quote.currency)
  if (target === "" || from.code === target || from.code === "") return out
  var rate = rateFor(quote.currency, display, rates)
  if (rate === null) return out
  out.price = scaled(quote.price, rate)
  out.prevClose = scaled(quote.prevClose, rate)
  out.change = out.price !== null && out.prevClose !== null ? out.price - out.prevClose : null
  out.dayLow = scaled(quote.dayLow, rate)
  out.dayHigh = scaled(quote.dayHigh, rate)
  out.week52Low = scaled(quote.week52Low, rate)
  out.week52High = scaled(quote.week52High, rate)
  out.open = scaled(quote.open, rate)
  out.series = convertSeries(quote.series, rate)
  out.currency = target
  out.converted = true
  return out
}

function convertAll(quotes, display, rates) {
  var list = quotes || []
  var out = []
  for (var i = 0; i < list.length; i++) out.push(convertQuote(list[i], display, rates))
  return out
}

// ---- CoinGecko API. Free tier, no API key, rate-limited to ~30 req/min.
//      Used for market cap, circulating supply, and 24h volume that Yahoo
//      does not provide for crypto pairs.

var COINGECKO_BASE = "https://api.coingecko.com/api/v3"

function coingeckoSearchUrl(query) {
  return COINGECKO_BASE + "/search?query=" + encodeURIComponent(trimString(query))
}

function coingeckoMarketsUrl(ids) {
  var list = []
  for (var i = 0; i < ids.length; i++) {
    var id = trimString(ids[i])
    if (id !== "" && list.indexOf(id) === -1) list.push(id)
  }
  return COINGECKO_BASE + "/coins/markets?vs_currency=usd&ids=" + encodeURIComponent(list.join(","))
    + "&order=market_cap_desc&per_page=250&page=1&sparkline=false"
}

function coingeckoCurlCommand(url, userAgent) {
  return ["curl", "-sS", "--max-time", "15", "--max-filesize", "2097152", "-A", String(userAgent || "omarchy-markets"),
    "-H", "Accept: application/json", url]
}

// CoinGecko /search response -> [{id, symbol, name, market_cap_rank}, ...]
function parseCoinSearch(text) {
  var raw = trimString(text)
  if (raw === "") return []
  var data
  try { data = JSON.parse(raw) } catch (e) { return [] }
  var coins = data && data.coins ? data.coins : []
  var out = []
  for (var i = 0; i < coins.length; i++) {
    var c = coins[i]
    if (!c || !c.id) continue
    out.push({
      id: String(c.id),
      symbol: trimString(c.symbol).toUpperCase(),
      name: trimString(c.name),
      rank: toNumber(c.market_cap_rank)
    })
  }
  return out
}

// Merge Yahoo and CoinGecko search results, deduplicating by normalized symbol.
// Yahoo results come first (stocks, indices), then crypto-only CoinGecko results
// that don't already appear in the Yahoo set. Entries priced by Binance show
// it as their source instead of the quote venue (e.g. Yahoo's "CCC").
function mergeSearchResults(yahooResults, coinResults) {
  var yahoo = yahooResults || []
  var coins = coinResults || []
  var yahooNorm = []
  for (var i = 0; i < yahoo.length; i++) yahooNorm.push(normalizeSymbol(yahoo[i].symbol))
  var out = []
  for (var n = 0; n < yahoo.length; n++) {
    var entry = yahoo[n]
    var src = priceSourceFor(entry.symbol)
    if (src === "") {
      out.push(entry)
      continue
    }
    var labeled = {}
    for (var key in entry) labeled[key] = entry[key]
    labeled.exchange = src
    out.push(labeled)
  }
  for (var j = 0; j < coins.length; j++) {
    var c = coins[j]
    var norm = normalizeSymbol(c.symbol)
    var dup = false
    for (var k = 0; k < yahooNorm.length; k++) {
      if (yahooNorm[k] === norm) { dup = true; break }
    }
    if (!dup) {
      out.push({
        symbol: c.symbol,
        name: c.name,
        type: "CRYPTO",
        exchange: priceSourceFor(c.symbol) || "CoinGecko",
        rank: c.rank,
        coingeckoId: c.id
      })
    }
  }
  return out
}

// CoinGecko /coins/markets response -> { coinId: { marketCap, supply, volume, price } }
function parseCoinMarkets(text) {
  var raw = trimString(text)
  if (raw === "") return {}
  var data
  try { data = JSON.parse(raw) } catch (e) { return {} }
  if (!Array.isArray(data)) return {}
  var out = {}
  for (var i = 0; i < data.length; i++) {
    var c = data[i]
    if (!c || !c.id) continue
    out[c.id] = {
      marketCap: toNumber(c.market_cap),
      circulatingSupply: toNumber(c.circulating_supply),
      totalVolume: toNumber(c.total_volume),
      price: toNumber(c.current_price),
      priceChangePct24h: toNumber(c.price_change_percentage_24h),
      high24h: toNumber(c.high_24h),
      low24h: toNumber(c.low_24h),
      ath: toNumber(c.ath),
      athDate: c.ath_date ? String(c.ath_date) : "",
      atl: toNumber(c.atl),
      atlDate: c.atl_date ? String(c.atl_date) : ""
    }
  }
  return out
}

// Merge CoinGecko data into Yahoo quotes. Only touches crypto quotes that
// have a matching coingeckoId; everything else passes through untouched.
function enrichQuotes(quotes, coinData) {
  var list = quotes || []
  var data = coinData || {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var q = list[i]
    if (!q || q.assetType !== "crypto") {
      out.push(q)
      continue
    }
    var id = q.coingeckoId || cryptoIdFromSymbol(q.symbol)
    if (id === "" || !data[id]) {
      out.push(q)
      continue
    }
    var enriched = {}
    for (var key in q) enriched[key] = q[key]
    var cd = data[id]
    enriched.coingeckoId = id
    enriched.marketCap = cd.marketCap
    enriched.circulatingSupply = cd.circulatingSupply
    enriched.totalVolume = cd.totalVolume
    enriched.ath = cd.ath
    enriched.athDate = cd.athDate
    enriched.atl = cd.atl
    enriched.atlDate = cd.atlDate
    enriched.high24h = cd.high24h
    enriched.low24h = cd.low24h
    out.push(enriched)
  }
  return out
}

// Extract CoinGecko IDs from a list of quotes (deduped, nulls skipped).
function cryptoIdsFromQuotes(quotes) {
  var list = quotes || []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var q = list[i]
    if (!q || q.assetType !== "crypto") continue
    var id = q.coingeckoId || cryptoIdFromSymbol(q.symbol)
    if (id !== "" && out.indexOf(id) === -1) out.push(id)
  }
  return out
}

// ---- Binance spot API. Free tier, no API key, ~6000 weight/min (no
//      practical limit for a handful of symbols). Primary price source for
//      crypto: real-time spot data vs Yahoo's delayed CCC aggregation.
//      Note: Binance.com geo-blocks US users (HTTP 451); those responses
//      parse as invalid and Yahoo data stands (graceful degradation).

var BINANCE_BASE = "https://api.binance.com/api/v3"

// Yahoo "BTC-USD" style symbol -> Binance spot pair ("BTCUSDT").
// Only USD-quote pairs map; anything else (stocks, indices, odd quotes)
// returns "" and is skipped by the fetcher.
function binancePairFor(symbol) {
  var s = trimString(symbol).toUpperCase()
  if (s === "") return ""
  var base = s
  if (s.length > 4 && s.indexOf("-USD") === s.length - 4) base = s.substring(0, s.length - 4)
  else if (s.length > 5 && s.indexOf("-USDT") === s.length - 5) base = s.substring(0, s.length - 5)
  else if (!KNOWN_CRYPTOS.hasOwnProperty(s)) return ""
  if (!/^[A-Z0-9]+$/.test(base)) return ""
  return base + "USDT"
}

function binanceTickerUrl(binanceSymbol) {
  return BINANCE_BASE + "/ticker/24hr?symbol=" + encodeURIComponent(trimString(binanceSymbol).toUpperCase())
}

// Binance spot trade page for a pair ("BTCUSDT" -> ".../trade/BTC_USDT").
// Returns "" when the quote asset cannot be determined.
var BINANCE_QUOTE_ASSETS = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"]

function binanceTradeUrl(binanceSymbol) {
  var s = trimString(binanceSymbol).toUpperCase()
  if (s === "") return ""
  for (var i = 0; i < BINANCE_QUOTE_ASSETS.length; i++) {
    var q = BINANCE_QUOTE_ASSETS[i]
    if (s.length > q.length && s.indexOf(q) === s.length - q.length) {
      var base = s.substring(0, s.length - q.length)
      if (!/^[A-Z0-9]+$/.test(base)) return ""
      return "https://www.binance.com/en/trade/" + base + "_" + q
    }
  }
  return ""
}

// Yahoo "BTC-USD" style symbol -> Binance trade page URL, or "" when the
// symbol does not map to a Binance pair.
function binanceTradeUrlFor(symbol) {
  var pair = binancePairFor(symbol)
  if (pair === "") return ""
  return binanceTradeUrl(pair)
}

// Valid crypto quotes -> [{ yahoo: "BTC-USD", binance: "BTCUSDT" }, ...].
// Invalid quotes are skipped (their Yahoo data is unusable, so there is
// nothing coherent to enrich).
function binancePairsFromQuotes(quotes) {
  var list = quotes || []
  var out = []
  for (var i = 0; i < list.length; i++) {
    var q = list[i]
    if (!q || q.assetType !== "crypto" || !isValid(q)) continue
    var pair = binancePairFor(q.symbol)
    if (pair === "") continue
    var dup = false
    for (var j = 0; j < out.length; j++) {
      if (out[j].binance === pair) { dup = true; break }
    }
    if (!dup) out.push({ yahoo: String(q.symbol).toUpperCase(), binance: pair })
  }
  return out
}

function binanceCurlCommand(pairs, userAgent) {
  var cmd = ["curl", "-sS", "--max-time", "10", "--max-filesize", "2097152", "-A", String(userAgent || "omarchy-markets"), "-w", "\n"]
  for (var i = 0; i < pairs.length; i++) cmd.push(binanceTickerUrl(pairs[i].binance))
  return cmd
}

// One Binance 24hr-ticker body -> quote-shaped object, or null when the
// line is an error (invalid symbol, geo-block, garbage). Never throws.
function parseBinanceTicker(line) {
  var raw = trimString(line)
  if (raw === "") return null
  var data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  if (data.code !== undefined && data.code !== 0) return null
  var price = toNumber(data.lastPrice)
  if (price === null) return null
  var prev = toNumber(data.prevClosePrice)
  var change = prev !== null ? price - prev : toNumber(data.priceChange)
  var changePct = null
  if (change !== null && prev) changePct = (change / prev) * 100
  else changePct = toNumber(data.priceChangePercent)
  return {
    binanceSymbol: String(data.symbol || ""),
    price: price,
    prevClose: prev,
    change: change,
    changePct: changePct,
    open: toNumber(data.openPrice),
    dayHigh: toNumber(data.highPrice),
    dayLow: toNumber(data.lowPrice),
    volume: toNumber(data.quoteVolume)
  }
}

// Whole curl stdout -> { "BTC-USD": {...}, ... }, keyed by Yahoo symbol.
// Positional matching by request order (same contract as the Yahoo fetch);
// error lines leave their symbol absent, so Yahoo data stands.
function parseBinanceLines(text, pairs) {
  var out = {}
  var list = pairs || []
  if (!list.length) return out
  var lines = String(text || "").split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  for (var i = 0; i < list.length && i < lines.length; i++) {
    var parsed = parseBinanceTicker(lines[i])
    if (parsed) out[list[i].yahoo] = parsed
  }
  return out
}

// Override crypto quote price fields with Binance spot data. Only touches
// valid crypto quotes that have Binance data; everything else passes
// through untouched (Yahoo stays the fallback).
function enrichQuotesBinance(quotes, binanceData) {
  var list = quotes || []
  var data = binanceData || {}
  var out = []
  for (var i = 0; i < list.length; i++) {
    var q = list[i]
    if (!q || q.assetType !== "crypto" || !isValid(q)) {
      out.push(q)
      continue
    }
    var key = String(q.symbol || "").toUpperCase()
    var bd = data[key]
    if (!bd || bd.price === null || bd.price === undefined) {
      out.push(q)
      continue
    }
    var enriched = {}
    for (var k in q) enriched[k] = q[k]
    enriched.price = bd.price
    enriched.prevClose = bd.prevClose
    enriched.change = bd.change
    enriched.changePct = bd.changePct
    enriched.open = bd.open !== null && bd.open !== undefined ? bd.open : q.open
    enriched.dayHigh = bd.dayHigh !== null && bd.dayHigh !== undefined ? bd.dayHigh : q.dayHigh
    enriched.dayLow = bd.dayLow !== null && bd.dayLow !== undefined ? bd.dayLow : q.dayLow
    enriched.volume = bd.volume !== null && bd.volume !== undefined ? bd.volume : q.volume
    enriched.priceSource = "binance"
    out.push(enriched)
  }
  return out
}

// Display label for a symbol's price data source: "Binance" when the symbol
// maps to a Binance spot pair (Binance enriches its price), "" otherwise
// (Yahoo Finance is the source).
function priceSourceFor(symbol) {
  return binancePairFor(symbol) !== "" ? "Binance" : ""
}

// ---- Watchlist. Persisted in watchlist.json as a simple { symbols: [...] }.

function defaultWatchlist() {
  return { symbols: DEFAULT_SYMBOLS.slice() }
}

// Parse a JSON string or object into a watchlist. Never throws on junk:
// returns a default watchlist when the input is unusable.
function parseWatchlist(value) {
  var raw = value
  if (typeof value === "string") {
    var trimmed = trimString(value)
    if (trimmed === "") return defaultWatchlist()
    try { raw = JSON.parse(trimmed) } catch (e) { return defaultWatchlist() }
  }
  if (!raw || typeof raw !== "object") return defaultWatchlist()

  // New simple format: { symbols: [...] }
  if (raw.symbols !== undefined) {
    var syms = normalizeSymbols(raw.symbols, [])
    return { symbols: syms }
  }

  // Legacy multi-list format: { active: "name", lists: { name: { symbols } } }
  if (raw.lists && typeof raw.lists === "object") {
    var active = trimString(raw.active)
    var entry = null
    if (active !== "" && raw.lists[active]) entry = raw.lists[active]
    if (!entry) {
      for (var k in raw.lists) { if (raw.lists.hasOwnProperty(k)) { entry = raw.lists[k]; break } }
    }
    if (entry && entry.symbols) {
      var migrated = normalizeSymbols(entry.symbols, [])
      return { symbols: migrated }
    }
  }

  return defaultWatchlist()
}

function watchlistSymbols(watchlist) {
  var wl = watchlist || defaultWatchlist()
  return (wl.symbols || []).slice()
}

function addSymbol(watchlist, symbol) {
  var wl = watchlist || defaultWatchlist()
  var sym = normalizeSymbol(symbol)
  if (sym === "") return wl
  var syms = (wl.symbols || []).slice()
  var upper = sym.toUpperCase()
  for (var i = 0; i < syms.length; i++) {
    if (syms[i].toUpperCase() === upper) return { symbols: syms }
  }
  syms.push(sym)
  return { symbols: syms }
}

function removeSymbol(watchlist, symbol) {
  var wl = watchlist || defaultWatchlist()
  var sym = trimString(symbol).toUpperCase()
  if (sym === "") return wl
  var syms = wl.symbols || []
  var out = []
  for (var i = 0; i < syms.length; i++) {
    if (syms[i].toUpperCase() !== sym) out.push(syms[i])
  }
  return { symbols: out }
}

// Move the symbol at fromIndex to toIndex (drag-and-drop reorder). Out of
// range indices or a no-op move return the watchlist unchanged.
function moveSymbol(watchlist, fromIndex, toIndex) {
  var wl = watchlist || defaultWatchlist()
  var syms = (wl.symbols || []).slice()
  var from = parseInt(fromIndex, 10)
  var to = parseInt(toIndex, 10)
  if (isNaN(from) || isNaN(to)) return wl
  if (from < 0 || from >= syms.length || to < 0 || to >= syms.length || from === to) return wl
  var moved = syms.splice(from, 1)[0]
  syms.splice(to, 0, moved)
  return { symbols: syms }
}

function serializeWatchlist(watchlist) {
  var wl = watchlist || defaultWatchlist()
  return JSON.stringify(wl, null, 2) + "\n"
}

// Write command for the QML side: uses python3 (always available on Omarchy)
// to write the JSON atomically (write to temp, rename).
function writeWatchlistCommand(watchlistPath, watchlist) {
  var json = serializeWatchlist(watchlist)
  return ["python3", "-c",
    "import sys,json,tempfile,os\n"
    + "p=sys.argv[1]\n"
    + "d=sys.argv[2]\n"
    + "os.makedirs(os.path.dirname(p),exist_ok=True)\n"
    + "t=p+'.tmp'\n"
    + "open(t,'w').write(d)\n"
    + "os.rename(t,p)",
    String(watchlistPath), json]
}

// ---- Yahoo search for the add-symbol autocomplete.

var YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"

function yahooSearchUrl(query) {
  return YAHOO_SEARCH_URL + "?q=" + encodeURIComponent(trimString(query))
    + "&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=true"
}

function yahooSearchCommand(query, userAgent) {
  return ["curl", "-sS", "--max-time", "8", "--max-filesize", "1048576", "-A", String(userAgent || "omarchy-markets"),
    yahooSearchUrl(query)]
}

// Yahoo search response -> [{symbol, name, type, exchange}, ...]
function parseYahooSearch(text) {
  var raw = trimString(text)
  if (raw === "") return []
  var data
  try { data = JSON.parse(raw) } catch (e) { return [] }
  var quotes = data && data.quotes ? data.quotes : []
  var out = []
  for (var i = 0; i < quotes.length; i++) {
    var q = quotes[i]
    if (!q || !q.symbol) continue
    out.push({
      symbol: trimString(q.symbol).toUpperCase(),
      name: cleanAssetName(trimString(q.shortname || q.longname || q.symbol), q.symbol),
      type: trimString(q.quoteType || q.typeDisp || ""),
      exchange: trimString(q.exchDisp || q.exchange || "")
    })
  }
  return out
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_SYMBOLS: DEFAULT_SYMBOLS,
    normalizeSymbols: normalizeSymbols,
    normalizeSymbol: normalizeSymbol,
    refreshMinutes: refreshMinutes,
    cycleSeconds: cycleSeconds,
    chartUrl: chartUrl,
    curlCommand: curlCommand,
    quoteUrl: quoteUrl,
    shellQuote: shellQuote,
    emptyQuote: emptyQuote,
    parseChartResponse: parseChartResponse,
    parseQuoteLines: parseQuoteLines,
    isValid: isValid,
    isDown: isDown,
    isUp: isUp,
    validCount: validCount,
    firstValidIndex: firstValidIndex,
    nextIndex: nextIndex,
    shouldRetry: shouldRetry,
    marketStatus: marketStatus,
    marketStatusLabel: marketStatusLabel,
    formatPrice: formatPrice,
    withThousands: withThousands,
    formatChange: formatChange,
    formatChangeValues: formatChangeValues,
    barLabel: barLabel,
    verticalLabel: verticalLabel,
    loadingLabel: loadingLabel,
    CHART_RANGES: CHART_RANGES,
    chartRange: chartRange,
    chartInterval: chartInterval,
    fetchRange: fetchRange,
    windowMinutes: windowMinutes,
    trimSeries: trimSeries,
    tickerWidth: tickerWidth,
    scrollSpeed: scrollSpeed,
    parseSeriesLines: parseSeriesLines,
    dropLeadingStubs: dropLeadingStubs,
    seriesBounds: seriesBounds,
    seriesDirection: seriesDirection,
    seriesPoints: seriesPoints,
    valueToY: valueToY,
    tapeItems: tapeItems,
    normalizeColor: normalizeColor,
    parseThemeColor: parseThemeColor,
    formatVolume: formatVolume,
    formatMarketCap: formatMarketCap,
    formatSupply: formatSupply,
    ageMs: ageMs,
    ageLabel: ageLabel,
    isStale: isStale,
    DEFAULT_CURRENCIES: DEFAULT_CURRENCIES,
    normalizeCurrency: normalizeCurrency,
    normalizeCurrencies: normalizeCurrencies,
    currencyCycle: currencyCycle,
    quoteCurrency: quoteCurrency,
    ratePairs: ratePairs,
    parseRateLines: parseRateLines,
    rateFor: rateFor,
    convertSeries: convertSeries,
    convertQuote: convertQuote,
    convertAll: convertAll,
    KNOWN_CRYPTOS: KNOWN_CRYPTOS,
    isCryptoSymbol: isCryptoSymbol,
    displaySymbol: displaySymbol,
    cryptoIdFromSymbol: cryptoIdFromSymbol,
    cleanAssetName: cleanAssetName,
    isIndexSymbol: isIndexSymbol,
    assetType: assetType,
    COINGECKO_BASE: COINGECKO_BASE,
    coingeckoSearchUrl: coingeckoSearchUrl,
    coingeckoMarketsUrl: coingeckoMarketsUrl,
    coingeckoCurlCommand: coingeckoCurlCommand,
    parseCoinSearch: parseCoinSearch,
    mergeSearchResults: mergeSearchResults,
    parseCoinMarkets: parseCoinMarkets,
    enrichQuotes: enrichQuotes,
    cryptoIdsFromQuotes: cryptoIdsFromQuotes,
    BINANCE_BASE: BINANCE_BASE,
    binancePairFor: binancePairFor,
    binanceTickerUrl: binanceTickerUrl,
    binanceTradeUrl: binanceTradeUrl,
    binanceTradeUrlFor: binanceTradeUrlFor,
    binancePairsFromQuotes: binancePairsFromQuotes,
    binanceCurlCommand: binanceCurlCommand,
    parseBinanceTicker: parseBinanceTicker,
    parseBinanceLines: parseBinanceLines,
    enrichQuotesBinance: enrichQuotesBinance,
    priceSourceFor: priceSourceFor,
    defaultWatchlist: defaultWatchlist,
    parseWatchlist: parseWatchlist,
    watchlistSymbols: watchlistSymbols,
    addSymbol: addSymbol,
    removeSymbol: removeSymbol,
    moveSymbol: moveSymbol,
    serializeWatchlist: serializeWatchlist,
    writeWatchlistCommand: writeWatchlistCommand,
    YAHOO_SEARCH_URL: YAHOO_SEARCH_URL,
    yahooSearchUrl: yahooSearchUrl,
    yahooSearchCommand: yahooSearchCommand,
    parseYahooSearch: parseYahooSearch
  }
}
