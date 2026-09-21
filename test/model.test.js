const test = require("node:test")
const assert = require("node:assert/strict")
const Model = require("../Model.js")

test("normalizeSymbols: arrays are trimmed, upper-cased, de-duplicated", () => {
  assert.deepEqual(Model.normalizeSymbols([" aapl", "NVDA", "aapl", "", null]), ["AAPL", "NVDA"])
})

test("normalizeSymbols: comma/space separated strings work (omarchy bar set without --json)", () => {
  assert.deepEqual(Model.normalizeSymbols("aapl, nvda spcx;googl"), ["AAPL", "NVDA", "SPCX", "GOOGL"])
})

test("normalizeSymbols: empty or junk input falls back to the defaults", () => {
  assert.deepEqual(Model.normalizeSymbols(null), Model.DEFAULT_SYMBOLS)
  assert.deepEqual(Model.normalizeSymbols([]), Model.DEFAULT_SYMBOLS)
  assert.deepEqual(Model.normalizeSymbols("   "), Model.DEFAULT_SYMBOLS)
  assert.deepEqual(Model.normalizeSymbols(42), Model.DEFAULT_SYMBOLS)
  assert.deepEqual(Model.normalizeSymbols(null, ["SPY"]), ["SPY"])
})

test("normalizeSymbols: returns a copy, never the shared default array", () => {
  const a = Model.normalizeSymbols(null)
  a.push("X")
  assert.deepEqual(Model.normalizeSymbols(null), Model.DEFAULT_SYMBOLS)
})

test("refreshMinutes: clamps to >= 1, non-numeric falls back", () => {
  assert.equal(Model.refreshMinutes(15), 15)
  assert.equal(Model.refreshMinutes("3"), 3)
  assert.equal(Model.refreshMinutes(0), 1)
  assert.equal(Model.refreshMinutes(-4), 1)
  assert.equal(Model.refreshMinutes("abc"), 5)
  assert.equal(Model.refreshMinutes(undefined), 5)
  assert.equal(Model.refreshMinutes(null, 7), 7)
})

test("cycleSeconds: 0 is allowed (pinned), negatives and junk fall back", () => {
  assert.equal(Model.cycleSeconds(30), 30)
  assert.equal(Model.cycleSeconds("0"), 0)
  assert.equal(Model.cycleSeconds(-1), 10)
  assert.equal(Model.cycleSeconds("nope"), 10)
  assert.equal(Model.cycleSeconds(undefined, 4), 4)
})

// Trimmed real responses from query1.finance.yahoo.com/v8/finance/chart/<SYM>?range=1d&interval=1d
const AAPL_LINE = JSON.stringify({ chart: { result: [{ meta: {
  currency: "USD", symbol: "AAPL", exchangeName: "NMS", fullExchangeName: "NasdaqGS",
  regularMarketTime: 1786996801, regularMarketPrice: 305.59, fiftyTwoWeekHigh: 344.57,
  fiftyTwoWeekLow: 223.78, regularMarketDayHigh: 307.66, regularMarketDayLow: 302.939,
  regularMarketVolume: 32743947, longName: "Apple Inc.", shortName: "Apple Inc.",
  chartPreviousClose: 305.93, priceHint: 2
}, timestamp: [1786996800], indicators: { quote: [{ close: [305.59] }] } }], error: null } })

const GOOGL_LINE = JSON.stringify({ chart: { result: [{ meta: {
  currency: "USD", symbol: "GOOGL", fullExchangeName: "NasdaqGS", regularMarketPrice: 344.0,
  chartPreviousClose: 345.9, shortName: "Alphabet Inc.", regularMarketTime: 1786996801
} }], error: null } })

const NOT_FOUND_LINE = JSON.stringify({ chart: { result: null,
  error: { code: "Not Found", description: "No data found, symbol may be delisted" } } })

test("chartUrl: encodes the symbol into the v8 chart endpoint", () => {
  assert.equal(Model.chartUrl("AAPL"), "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m")
  assert.equal(Model.chartUrl("^GSPC"), "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=1d&interval=5m")
  assert.equal(Model.chartUrl("AAPL", "1mo"), "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d")
})

test("curlCommand: one curl, one URL per symbol, newline write-out, custom UA", () => {
  const cmd = Model.curlCommand(["AAPL", "BTC-USD"], "test-agent/1.0")
  assert.deepEqual(cmd.slice(0, 8), ["curl", "-sS", "--max-time", "10", "-A", "test-agent/1.0", "-w", "\n"])
  assert.deepEqual(cmd.slice(8), [Model.chartUrl("AAPL"), Model.chartUrl("BTC-USD")])
  assert.deepEqual(Model.curlCommand(["AAPL"], "ua", "6mo").slice(8), [Model.chartUrl("AAPL", "6mo")])
})

test("quoteUrl / shellQuote", () => {
  assert.equal(Model.quoteUrl("BTC-USD"), "https://finance.yahoo.com/quote/BTC-USD")
  assert.equal(Model.shellQuote("it's"), "'it'\\''s'")
})

test("parseChartResponse: successful line", () => {
  const q = Model.parseChartResponse(AAPL_LINE)
  assert.equal(q.error, "")
  assert.equal(q.symbol, "AAPL")
  assert.equal(q.name, "Apple Inc.")
  assert.equal(q.currency, "USD")
  assert.equal(q.exchange, "NasdaqGS")
  assert.equal(q.price, 305.59)
  assert.equal(q.prevClose, 305.93)
  assert.ok(Math.abs(q.change - -0.34) < 1e-9)
  assert.ok(Math.abs(q.changePct - (-0.34 / 305.93 * 100)) < 1e-9)
  assert.equal(q.dayLow, 302.939)
  assert.equal(q.dayHigh, 307.66)
  assert.equal(q.week52Low, 223.78)
  assert.equal(q.week52High, 344.57)
  assert.equal(q.marketTime, 1786996801)
})

test("parseChartResponse: missing optional fields become null, name falls back to symbol", () => {
  const q = Model.parseChartResponse(JSON.stringify({ chart: { result: [{ meta: { symbol: "X", regularMarketPrice: 2 } }] } }))
  assert.equal(q.error, "")
  assert.equal(q.name, "X")
  assert.equal(q.prevClose, null)
  assert.equal(q.change, null)
  assert.equal(q.changePct, null)
  assert.equal(q.dayLow, null)
})

test("parseChartResponse: error, empty and garbage lines", () => {
  assert.equal(Model.parseChartResponse(NOT_FOUND_LINE).error, "Not Found")
  assert.equal(Model.parseChartResponse("").error, "No data")
  assert.equal(Model.parseChartResponse("<html>429</html>").error, "Bad response")
  assert.equal(Model.parseChartResponse(JSON.stringify({ chart: { result: [{ meta: { symbol: "Y" } }] } })).error, "No data")
})

test("parseQuoteLines: one Quote per requested symbol, in request order, matched by symbol", () => {
  const quotes = Model.parseQuoteLines(GOOGL_LINE + "\n" + AAPL_LINE + "\n", ["AAPL", "GOOGL"])
  assert.deepEqual(quotes.map(q => q.symbol), ["AAPL", "GOOGL"])
  assert.equal(quotes[0].price, 305.59)
  assert.equal(quotes[1].price, 344.0)
})

test("parseQuoteLines: error lines are attributed positionally when the line count matches", () => {
  const quotes = Model.parseQuoteLines([AAPL_LINE, NOT_FOUND_LINE, GOOGL_LINE].join("\n") + "\n", ["AAPL", "NOPE", "GOOGL"])
  assert.equal(quotes[1].symbol, "NOPE")
  assert.equal(quotes[1].error, "Not Found")
  assert.equal(quotes[2].symbol, "GOOGL")
  assert.equal(quotes[2].error, "")
})

test("parseQuoteLines: missing lines yield 'No data' for the unmatched symbols", () => {
  const quotes = Model.parseQuoteLines(AAPL_LINE + "\n", ["AAPL", "GOOGL", "NVDA"])
  assert.equal(quotes[0].error, "")
  assert.equal(quotes[1].error, "No data")
  assert.equal(quotes[2].error, "No data")
  assert.equal(quotes[2].symbol, "NVDA")
})

test("parseQuoteLines: the requested symbol wins over Yahoo's casing", () => {
  const quotes = Model.parseQuoteLines(AAPL_LINE + "\n", ["AAPL"])
  assert.equal(quotes[0].symbol, "AAPL")
  assert.deepEqual(Model.parseQuoteLines("", []), [])
})

function quote(symbol, price, prev, error) {
  const q = Model.emptyQuote(symbol, error || "")
  q.price = price === undefined ? null : price
  q.prevClose = prev === undefined ? null : prev
  q.change = q.price !== null && q.prevClose !== null ? q.price - q.prevClose : null
  q.changePct = q.change !== null && q.prevClose ? q.change / q.prevClose * 100 : null
  return q
}

test("isValid / isDown / validCount", () => {
  assert.equal(Model.isValid(quote("AAPL", 305.59, 305.93)), true)
  assert.equal(Model.isValid(quote("NOPE", null, null, "Not Found")), false)
  assert.equal(Model.isValid(null), false)
  assert.equal(Model.isDown(quote("AAPL", 305.59, 305.93)), true)
  assert.equal(Model.isDown(quote("GOOGL", 346, 345.9)), false)
  assert.equal(Model.isDown(quote("FLAT", 10, 10)), false)
  assert.equal(Model.isDown(null), false)
  assert.equal(Model.validCount([quote("A", 1, 1), quote("B", null, null, "Not Found"), quote("C", 2, 1)]), 2)
  assert.equal(Model.validCount(null), 0)
})

test("firstValidIndex / nextIndex skip invalid quotes and wrap", () => {
  const list = [quote("A", null, null, "Not Found"), quote("B", 1, 1), quote("C", 2, 1), quote("D", null, null, "No data")]
  assert.equal(Model.firstValidIndex(list), 1)
  assert.equal(Model.firstValidIndex([quote("X", null, null, "Not Found")]), -1)
  assert.equal(Model.firstValidIndex([]), -1)
  assert.equal(Model.nextIndex(1, list, 1), 2)
  assert.equal(Model.nextIndex(2, list, 1), 1)      // wraps past D and A
  assert.equal(Model.nextIndex(1, list, -1), 2)     // backwards wraps past A and D
  assert.equal(Model.nextIndex(-1, list, 1), 1)     // no current -> first valid
  assert.equal(Model.nextIndex(0, [quote("B", 1, 1)], 1), 0)
  assert.equal(Model.nextIndex(0, [quote("X", null, null, "Not Found")], 1), -1)
  assert.equal(Model.nextIndex(0, [], 1), -1)
})

test("shouldRetry: only when some failure is not a plain 'Not Found'", () => {
  assert.equal(Model.shouldRetry([quote("A", null, null, "Not Found")]), false)
  assert.equal(Model.shouldRetry([quote("A", null, null, "Not Found"), quote("B", null, null, "No data")]), true)
  assert.equal(Model.shouldRetry([quote("A", null, null, "Bad response")]), true)
  assert.equal(Model.shouldRetry([]), true)
})

test("formatPrice: 2 decimals, 4 below 1, thousands separators", () => {
  assert.equal(Model.formatPrice(305.59), "305.59")
  assert.equal(Model.formatPrice(344), "344.00")
  assert.equal(Model.formatPrice(65432.1), "65,432.10")
  assert.equal(Model.formatPrice(1234567.891), "1,234,567.89")
  assert.equal(Model.formatPrice(0.12345), "0.1235")
  assert.equal(Model.formatPrice(-2.5), "-2.50")
  assert.equal(Model.formatPrice(null), "")
  assert.equal(Model.formatPrice(NaN), "")
})

test("formatChange: arrow, signed absolute change, percent", () => {
  assert.equal(Model.formatChange(quote("A", 306.87, 305.59)), "▲ +1.28 (+0.42%)")
  assert.equal(Model.formatChange(quote("B", 410.05, 412.10)), "▼ -2.05 (-0.50%)")
  assert.equal(Model.formatChange(quote("C", 10, 10)), "• +0.00 (+0.00%)")
  assert.equal(Model.formatChange(quote("D", 0.5, 0.4)), "▲ +0.1000 (+25.00%)")
  assert.equal(Model.formatChange(quote("E", 5, null)), "")
  assert.equal(Model.formatChange(null), "")
  assert.equal(Model.formatChange(quote("F", 81248.67, 115306.09)), "▼ -34,057.42 (-29.54%)")
  assert.equal(Model.formatChangeValues(-34057.42, -29.5365, 81248.67), "▼ -34,057.42 (-29.54%)")
})

test("barLabel: full, compact, error, no-change", () => {
  assert.equal(Model.barLabel(quote("AAPL", 306.87, 305.59), false), "AAPL 306.87 ▲ 0.42%")
  assert.equal(Model.barLabel(quote("AAPL", 306.87, 305.59), true), "AAPL ▲ 0.42%")
  assert.equal(Model.barLabel(quote("MSFT", 410.05, 412.10), false), "MSFT 410.05 ▼ 0.50%")
  assert.equal(Model.barLabel(quote("X", 5, null), false), "X 5.00")
  assert.equal(Model.barLabel(quote("NOPE", null, null, "Not Found"), false), "NOPE !")
  assert.equal(Model.barLabel(null, false), "")
})

test("verticalLabel / loadingLabel", () => {
  assert.equal(Model.verticalLabel(quote("AAPL", 306.87, 305.59)), "AAPL\n▲")
  assert.equal(Model.verticalLabel(quote("NOPE", null, null, "Not Found")), "NOPE\n!")
  assert.equal(Model.verticalLabel(null), "")
  assert.equal(Model.loadingLabel("AAPL"), "AAPL …")
  assert.equal(Model.loadingLabel(""), "…")
})

// ---- Revision 2: ranges, series, tape, chart geometry

test("chartRange / chartInterval: validated ranges map to Yahoo intervals", () => {
  assert.deepEqual(Model.CHART_RANGES, ["1h", "4h", "1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "5y", "max"])
  assert.equal(Model.chartRange("1H"), "1h")
  assert.equal(Model.chartRange("4h"), "4h")
  assert.equal(Model.chartRange("1mo"), "1mo")
  assert.equal(Model.chartRange(" 6MO "), "6mo")
  assert.equal(Model.chartRange("max"), "max")
  assert.equal(Model.chartRange("YTD"), "ytd")
  assert.equal(Model.chartRange("2y"), "1d")
  assert.equal(Model.chartRange(null), "1d")
  assert.equal(Model.chartRange(null, "5d"), "5d")
  assert.equal(Model.chartInterval("1h"), "1m")
  assert.equal(Model.chartInterval("4h"), "5m")
  assert.equal(Model.chartInterval("1d"), "5m")
  assert.equal(Model.chartInterval("5d"), "15m")
  assert.equal(Model.chartInterval("1mo"), "1d")
  assert.equal(Model.chartInterval("3mo"), "1d")
  assert.equal(Model.chartInterval("6mo"), "1d")
  assert.equal(Model.chartInterval("ytd"), "1d")
  assert.equal(Model.chartInterval("1y"), "1wk")
  assert.equal(Model.chartInterval("5y"), "1wk")
  assert.equal(Model.chartInterval("max"), "1mo")
  assert.equal(Model.chartInterval("bogus"), "1d")
})

test("fetchRange / windowMinutes / trimSeries: intraday windows slice a 1d fetch", () => {
  assert.equal(Model.fetchRange("1h"), "1d")
  assert.equal(Model.fetchRange("4h"), "1d")
  assert.equal(Model.fetchRange("1d"), "1d")
  assert.equal(Model.fetchRange("5d"), "5d")
  assert.equal(Model.windowMinutes("1h"), 60)
  assert.equal(Model.windowMinutes("4h"), 240)
  assert.equal(Model.windowMinutes("1d"), 0)
  assert.equal(Model.windowMinutes("bogus"), 0)
  assert.equal(Model.chartUrl("AAPL", "1h"), "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1m")
  assert.equal(Model.chartUrl("AAPL", "4h"), "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=5m")
  const s = [{ t: 0, c: 10 }, { t: 3600, c: 11 }, { t: 7200, c: 12 }, { t: 10800, c: 13 }]
  assert.deepEqual(Model.trimSeries(s, 60), [{ t: 7200, c: 12 }, { t: 10800, c: 13 }])
  assert.deepEqual(Model.trimSeries(s, 0), s)
  assert.deepEqual(Model.trimSeries([{ t: 0, c: 1 }], 60), [{ t: 0, c: 1 }])
})

test("tickerWidth / scrollSpeed clamps", () => {
  assert.equal(Model.tickerWidth(500), 500)
  assert.equal(Model.tickerWidth("240"), 240)
  assert.equal(Model.tickerWidth(10), 80)
  assert.equal(Model.tickerWidth("x"), 180)
  assert.equal(Model.tickerWidth(undefined, 300), 300)
  assert.equal(Model.scrollSpeed(60), 60)
  assert.equal(Model.scrollSpeed("12.5"), 12.5)
  assert.equal(Model.scrollSpeed(0), 0)
  assert.equal(Model.scrollSpeed(-3), 20)
  assert.equal(Model.scrollSpeed("fast"), 20)
  assert.equal(Model.scrollSpeed(null, 25), 25)
})

const SERIES_LINE = JSON.stringify({ chart: { result: [{ meta: {
  currency: "USD", symbol: "AAPL", regularMarketPrice: 305.59, previousClose: 305.93,
  chartPreviousClose: 333.74, regularMarketVolume: 32743947, shortName: "Apple Inc.", regularMarketTime: 1786996801
}, timestamp: [100, 200, 300, 400], indicators: { quote: [{
  close: [305.76, null, 305.69, 305.59], open: [null, 305.8, 305.7, 305.6]
}] } }], error: null } })

test("parseChartResponse: series skips nulls, reads open/volume, prefers previousClose", () => {
  const q = Model.parseChartResponse(SERIES_LINE)
  assert.deepEqual(q.series, [{ t: 100, c: 305.76 }, { t: 300, c: 305.69 }, { t: 400, c: 305.59 }])
  assert.equal(q.open, 305.8)
  assert.equal(q.volume, 32743947)
  assert.equal(q.prevClose, 305.93)
  const bare = Model.parseChartResponse(JSON.stringify({ chart: { result: [{ meta: { symbol: "X", regularMarketPrice: 2 } }] } }))
  assert.deepEqual(bare.series, [])
  assert.equal(bare.open, null)
  assert.equal(bare.volume, null)
  assert.deepEqual(Model.emptyQuote("Z", "No data").series, [])
})

test("dropLeadingStubs: kills the artifact first bar, keeps real data", () => {
  // The NVDA artifact: 0.05 stub before a 222 stock (+486235% without the fix).
  assert.deepEqual(
    Model.dropLeadingStubs([{ t: 1, c: 0.05 }, { t: 2, c: 221.9 }, { t: 3, c: 222.27 }]),
    [{ t: 2, c: 221.9 }, { t: 3, c: 222.27 }]
  )
  // Non-positive leading prints go too.
  assert.deepEqual(
    Model.dropLeadingStubs([{ t: 1, c: 0 }, { t: 2, c: -4 }, { t: 3, c: 10 }]),
    [{ t: 3, c: 10 }]
  )
  // A legit penny stock has neighbors near its own price: untouched.
  const penny = [{ t: 1, c: 0.05 }, { t: 2, c: 0.06 }, { t: 3, c: 0.055 }]
  assert.deepEqual(Model.dropLeadingStubs(penny), penny)
  // Real gaps (halts, earnings) are far below the 100x tripwire.
  const gap = [{ t: 1, c: 100 }, { t: 2, c: 60 }]
  assert.deepEqual(Model.dropLeadingStubs(gap), gap)
  // Never drops below 1 point; empty in, empty out.
  assert.deepEqual(Model.dropLeadingStubs([{ t: 1, c: 0 }]), [])
  assert.deepEqual(Model.dropLeadingStubs([]), [])
  // Multiple stubs in a row.
  assert.deepEqual(
    Model.dropLeadingStubs([{ t: 1, c: 0 }, { t: 2, c: 0.01 }, { t: 3, c: 50 }]),
    [{ t: 3, c: 50 }]
  )
})

test("parseChartResponse: stub first bar no longer poisons change and bounds", () => {
  const line = JSON.stringify({ chart: { result: [{ meta: {
    currency: "USD", symbol: "NVDA", regularMarketPrice: 222.27, previousClose: 219.34,
    shortName: "NVIDIA Corporation", regularMarketTime: 1789761600
  }, timestamp: [100, 200, 300], indicators: { quote: [{
    close: [0.05, 221.9, 222.27], open: [0, 221.5, 222.0]
  }] } }], error: null } })
  const q = Model.parseChartResponse(line)
  assert.deepEqual(q.series, [{ t: 200, c: 221.9 }, { t: 300, c: 222.27 }])
  assert.equal(q.open, 221.5)
})

test("parseSeriesLines: symbol -> series map, missing symbols get []", () => {
  const map = Model.parseSeriesLines(SERIES_LINE + "\n" + NOT_FOUND_LINE + "\n", ["AAPL", "NOPE"])
  assert.equal(map.AAPL.length, 3)
  assert.deepEqual(map.NOPE, [])
})

test("seriesBounds / seriesDirection", () => {
  const s = [{ t: 0, c: 10 }, { t: 5, c: 14 }, { t: 10, c: 12 }]
  assert.deepEqual(Model.seriesBounds(s), { min: 10, max: 14 })
  assert.equal(Model.seriesBounds([]), null)
  assert.equal(Model.seriesBounds(null), null)
  assert.equal(Model.seriesDirection(s), 2)
  assert.equal(Model.seriesDirection([{ t: 0, c: 3 }, { t: 1, c: 1 }]), -2)
  assert.equal(Model.seriesDirection([{ t: 0, c: 3 }]), 0)
  assert.equal(Model.seriesDirection([]), 0)
})

test("seriesPoints: time-proportional x, value-scaled y within padding", () => {
  const s = [{ t: 0, c: 10 }, { t: 5, c: 14 }, { t: 10, c: 12 }]
  const pts = Model.seriesPoints(s, 100, 40, 2)
  assert.equal(pts.length, 3)
  assert.deepEqual(pts[0], { x: 2, y: 38 })     // min value -> bottom
  assert.deepEqual(pts[1], { x: 50, y: 2 })     // max value -> top
  assert.deepEqual(pts[2], { x: 98, y: 20 })    // midway value -> middle
  assert.deepEqual(Model.seriesPoints([{ t: 3, c: 7 }], 100, 40, 2), [{ x: 2, y: 20 }])
  assert.deepEqual(Model.seriesPoints([{ t: 3, c: 7 }, { t: 9, c: 7 }], 100, 40, 2), [{ x: 2, y: 20 }, { x: 98, y: 20 }])
  assert.deepEqual(Model.seriesPoints([], 100, 40, 2), [])
})

test("valueToY: inside the bounds maps like seriesPoints, outside is null", () => {
  const b = { min: 10, max: 14 }
  assert.equal(Model.valueToY(10, b, 40, 2), 38)
  assert.equal(Model.valueToY(14, b, 40, 2), 2)
  assert.equal(Model.valueToY(12, b, 40, 2), 20)
  assert.equal(Model.valueToY(9, b, 40, 2), null)
  assert.equal(Model.valueToY(null, b, 40, 2), null)
  assert.equal(Model.valueToY(12, null, 40, 2), null)
})

test("tapeItems: valid quotes only, compact form, down flag", () => {
  const list = [quote("AAPL", 306.87, 305.59), quote("NOPE", null, null, "Not Found"), quote("MSFT", 410.05, 412.10)]
  assert.deepEqual(Model.tapeItems(list, false), [
    { symbol: "AAPL", text: "AAPL 306.87 ▲ 0.42%", up: true, down: false, closed: false },
    { symbol: "MSFT", text: "MSFT 410.05 ▼ 0.50%", up: false, down: true, closed: false }
  ])
  assert.deepEqual(Model.tapeItems([quote("FLAT", 10, 10)], false), [{ symbol: "FLAT", text: "FLAT 10.00 • 0.00%", up: false, down: false, closed: false }])
  assert.deepEqual(Model.tapeItems(list, true).map(i => i.text), ["AAPL ▲ 0.42%", "MSFT ▼ 0.50%"])
  assert.deepEqual(Model.tapeItems([], false), [])
  assert.deepEqual(Model.tapeItems(null, false), [])
})

test("tapeItems: flags closed markets", () => {
  const open = quote("AAPL", 306.87, 305.59)
  open.assetType = "stock"
  open.regularStart = 2000; open.regularEnd = 3000; open.preStart = 1000; open.postEnd = 4000
  const shut = quote("MSFT", 410.05, 412.10)
  shut.assetType = "stock"
  shut.regularStart = 2000; shut.regularEnd = 3000; shut.preStart = 1000; shut.postEnd = 4000
  const items = Model.tapeItems([open, shut], false, 2500 * 1000)
  assert.equal(items[0].closed, false)
  const items2 = Model.tapeItems([open, shut], false, 5000 * 1000)
  assert.equal(items2[0].closed, true)
  assert.equal(items2[1].closed, true)
})

test("formatVolume", () => {
  assert.equal(Model.formatVolume(950), "950")
  assert.equal(Model.formatVolume(114897), "114.9K")
  assert.equal(Model.formatVolume(32743947), "32.7M")
  assert.equal(Model.formatVolume(1234567890), "1.23B")
  assert.equal(Model.formatVolume(0), "0")
  assert.equal(Model.formatVolume(null), "")
})

test("normalizeColor: accepts #rgb/#rrggbb/#aarrggbb, rejects junk", () => {
  assert.equal(Model.normalizeColor("#a9b665"), "#a9b665")
  assert.equal(Model.normalizeColor(" #A9B665 "), "#a9b665")
  assert.equal(Model.normalizeColor("#fff"), "#fff")
  assert.equal(Model.normalizeColor("#80a9b665"), "#80a9b665")
  assert.equal(Model.normalizeColor("green"), "")
  assert.equal(Model.normalizeColor("#12345"), "")
  assert.equal(Model.normalizeColor(null), "")
})

test("parseThemeColor: reads a key from Omarchy's colors.toml", () => {
  const toml = 'mode = "dark"\n\naccent = "#7daea3"\n\nred = "#ea6962"\ngreen = "#a9b665"\nbright_green = "#a9b665"\n'
  assert.equal(Model.parseThemeColor(toml, "green"), "#a9b665")
  assert.equal(Model.parseThemeColor(toml, "red"), "#ea6962")
  assert.equal(Model.parseThemeColor(toml, "bright_green"), "#a9b665")
  assert.equal(Model.parseThemeColor(toml, "purple"), "")
  assert.equal(Model.parseThemeColor("green = 'not-a-color'", "green"), "")
  assert.equal(Model.parseThemeColor("", "green"), "")
  assert.equal(Model.parseThemeColor(null, "green"), "")
})

// ---- Revision 3: display currency

test("normalizeCurrency / normalizeCurrencies", () => {
  assert.equal(Model.normalizeCurrency(" eur "), "EUR")
  assert.equal(Model.normalizeCurrency("USD"), "USD")
  assert.equal(Model.normalizeCurrency("euro"), "")
  assert.equal(Model.normalizeCurrency(""), "")
  assert.equal(Model.normalizeCurrency(null), "")
  assert.deepEqual(Model.normalizeCurrencies(null), ["USD", "CAD", "EUR", "GBP", "JPY", "CHF"])
  assert.deepEqual(Model.normalizeCurrencies(["eur", "usd", "EUR", "x"]), ["EUR", "USD"])
  assert.deepEqual(Model.normalizeCurrencies("gbp, jpy"), ["GBP", "JPY"])
  assert.deepEqual(Model.normalizeCurrencies([]), ["USD", "CAD", "EUR", "GBP", "JPY", "CHF"])
})

test("currencyCycle: '' (native) sits before the list and wraps both ways", () => {
  const list = ["USD", "EUR"]
  assert.equal(Model.currencyCycle("", list, 1), "USD")
  assert.equal(Model.currencyCycle("USD", list, 1), "EUR")
  assert.equal(Model.currencyCycle("EUR", list, 1), "")
  assert.equal(Model.currencyCycle("", list, -1), "EUR")
  assert.equal(Model.currencyCycle("USD", list, -1), "")
  assert.equal(Model.currencyCycle("XXX", list, 1), "USD")   // unknown current -> first
  assert.equal(Model.currencyCycle("", [], 1), "")
})

test("quoteCurrency: minor units (GBp, ZAc) map to the major code with a factor", () => {
  assert.deepEqual(Model.quoteCurrency("USD"), { code: "USD", factor: 1 })
  assert.deepEqual(Model.quoteCurrency("GBp"), { code: "GBP", factor: 0.01 })
  assert.deepEqual(Model.quoteCurrency("ZAc"), { code: "ZAR", factor: 0.01 })
  assert.deepEqual(Model.quoteCurrency(""), { code: "", factor: 1 })
})

test("ratePairs: one Yahoo FX symbol per distinct quote currency that differs from the display one", () => {
  const list = [quote("AAPL", 1, 1), quote("SAP.DE", 2, 2), quote("VOD.L", 3, 3), quote("BAD", null, null, "Not Found")]
  list[0].currency = "USD"; list[1].currency = "EUR"; list[2].currency = "GBp"; list[3].currency = "USD"
  assert.deepEqual(Model.ratePairs(list, "EUR"), ["USDEUR=X", "GBPEUR=X"])
  assert.deepEqual(Model.ratePairs(list, "USD"), ["EURUSD=X", "GBPUSD=X"])
  assert.deepEqual(Model.ratePairs(list, ""), [])
  assert.deepEqual(Model.ratePairs([], "EUR"), [])
})

const RATE_LINE = JSON.stringify({ chart: { result: [{ meta: { currency: "EUR", symbol: "USDEUR=X", regularMarketPrice: 0.92, chartPreviousClose: 0.91 } }], error: null } })

test("parseRateLines / rateFor", () => {
  const rates = Model.parseRateLines(RATE_LINE + "\n" + NOT_FOUND_LINE + "\n", ["USDEUR=X", "XXXEUR=X"])
  assert.deepEqual(rates, { "USDEUR=X": 0.92 })
  assert.equal(Model.rateFor("USD", "EUR", rates), 0.92)
  assert.equal(Model.rateFor("EUR", "EUR", rates), 1)
  assert.equal(Model.rateFor("USD", "", rates), 1)
  assert.equal(Model.rateFor("GBp", "EUR", { "GBPEUR=X": 1.2 }), 0.012)
  assert.equal(Model.rateFor("USD", "JPY", rates), null)
  assert.equal(Model.rateFor("", "EUR", rates), null)
})

test("convertQuote: scales money fields and series, keeps percentages, tags the display currency", () => {
  const q = quote("AAPL", 305.59, 305.93)
  q.currency = "USD"; q.dayLow = 302.94; q.dayHigh = 307.66; q.week52Low = 223.78; q.week52High = 344.57; q.open = 306.21
  q.series = [{ t: 1, c: 300 }, { t: 2, c: 310 }]
  const c = Model.convertQuote(q, "EUR", { "USDEUR=X": 0.5 })
  assert.equal(c.price, 152.795)
  assert.equal(c.prevClose, 152.965)
  assert.ok(Math.abs(c.change - (152.795 - 152.965)) < 1e-9)
  assert.equal(c.changePct, q.changePct)
  assert.equal(c.dayLow, 151.47)
  assert.equal(c.week52High, 172.285)
  assert.equal(c.open, 153.105)
  assert.deepEqual(c.series, [{ t: 1, c: 150 }, { t: 2, c: 155 }])
  assert.equal(c.currency, "EUR")
  assert.equal(c.nativeCurrency, "USD")
  assert.equal(c.converted, true)
  assert.equal(q.price, 305.59)                       // original untouched
  const same = Model.convertQuote(q, "USD", {})
  assert.equal(same.converted, false)
  assert.equal(same.price, 305.59)
  const missing = Model.convertQuote(q, "JPY", {})
  assert.equal(missing.converted, false)
  assert.equal(missing.price, 305.59)
  assert.equal(Model.convertQuote(quote("BAD", null, null, "Not Found"), "EUR", {}).error, "Not Found")
  assert.deepEqual(Model.convertSeries([{ t: 1, c: 2 }], 3), [{ t: 1, c: 6 }])
  assert.deepEqual(Model.convertSeries([{ t: 1, c: 2 }], null), [{ t: 1, c: 2 }])
  assert.equal(Model.convertAll([q], "EUR", { "USDEUR=X": 0.5 })[0].price, 152.795)
})

// ---- Markets fork: crypto detection

test("isCryptoSymbol: known tickers, suffixed pairs, and stocks", () => {
  assert.equal(Model.isCryptoSymbol("BTC"), true)
  assert.equal(Model.isCryptoSymbol("btc"), true)
  assert.equal(Model.isCryptoSymbol("BTC-USD"), true)
  assert.equal(Model.isCryptoSymbol("ETH-USD"), true)
  assert.equal(Model.isCryptoSymbol("ETH-EUR"), true)
  assert.equal(Model.isCryptoSymbol("SOL-BTC"), true)
  assert.equal(Model.isCryptoSymbol("AAPL"), false)
  assert.equal(Model.isCryptoSymbol("MSFT"), false)
  assert.equal(Model.isCryptoSymbol("^GSPC"), false)
  assert.equal(Model.isCryptoSymbol(""), false)
  assert.equal(Model.isCryptoSymbol(null), false)
})

test("normalizeSymbol: appends -USD to known crypto tickers", () => {
  assert.equal(Model.normalizeSymbol("btc"), "BTC-USD")
  assert.equal(Model.normalizeSymbol("ETH"), "ETH-USD")
  assert.equal(Model.normalizeSymbol("BTC-USD"), "BTC-USD")
  assert.equal(Model.normalizeSymbol("AAPL"), "AAPL")
  assert.equal(Model.normalizeSymbol(" aapl "), "AAPL")
  assert.equal(Model.normalizeSymbol(""), "")
})

test("cryptoIdFromSymbol: maps Yahoo symbols to CoinGecko IDs", () => {
  assert.equal(Model.cryptoIdFromSymbol("BTC-USD"), "bitcoin")
  assert.equal(Model.cryptoIdFromSymbol("ETH-USD"), "ethereum")
  assert.equal(Model.cryptoIdFromSymbol("SOL-USD"), "solana")
  assert.equal(Model.cryptoIdFromSymbol("BTC"), "bitcoin")
  assert.equal(Model.cryptoIdFromSymbol("AAPL"), "")
  assert.equal(Model.cryptoIdFromSymbol("XYZ-USD"), "")
})

test("assetType: classifies stocks, crypto, and indices", () => {
  assert.equal(Model.assetType("AAPL"), "stock")
  assert.equal(Model.assetType("BTC-USD"), "crypto")
  assert.equal(Model.assetType("ETH"), "crypto")
  assert.equal(Model.assetType("^GSPC"), "index")
  assert.equal(Model.assetType("^DJI"), "index")
})

test("emptyQuote: includes assetType and crypto fields", () => {
  const q = Model.emptyQuote("BTC-USD", "")
  assert.equal(q.assetType, "crypto")
  assert.equal(q.marketCap, null)
  assert.equal(q.circulatingSupply, null)
  assert.equal(q.coingeckoId, "")
  const s = Model.emptyQuote("AAPL", "")
  assert.equal(s.assetType, "stock")
})

// ---- Markets fork: CoinGecko

test("coingeckoSearchUrl / coingeckoMarketsUrl", () => {
  assert.equal(Model.coingeckoSearchUrl("bitcoin"), Model.COINGECKO_BASE + "/search?query=bitcoin")
  assert.equal(Model.coingeckoMarketsUrl(["bitcoin", "ethereum"]),
    Model.COINGECKO_BASE + "/coins/markets?vs_currency=usd&ids=bitcoin%2Cethereum&order=market_cap_desc&per_page=250&page=1&sparkline=false")
})

test("coingeckoCurlCommand: includes Accept header and custom UA", () => {
  const cmd = Model.coingeckoCurlCommand("https://example.com", "test/1.0")
  assert.deepEqual(cmd, ["curl", "-sS", "--max-time", "15", "-A", "test/1.0", "-H", "Accept: application/json", "https://example.com"])
})

const COIN_SEARCH_RESPONSE = JSON.stringify({
  coins: [
    { id: "bitcoin", name: "Bitcoin", symbol: "BTC", market_cap_rank: 1 },
    { id: "bitcoin-cash", name: "Bitcoin Cash", symbol: "BCH", market_cap_rank: 19 }
  ]
})

test("parseCoinSearch: extracts coins from CoinGecko search response", () => {
  const coins = Model.parseCoinSearch(COIN_SEARCH_RESPONSE)
  assert.equal(coins.length, 2)
  assert.equal(coins[0].id, "bitcoin")
  assert.equal(coins[0].symbol, "BTC")
  assert.equal(coins[0].name, "Bitcoin")
  assert.equal(coins[0].rank, 1)
  assert.equal(coins[1].id, "bitcoin-cash")
})

test("parseCoinSearch: handles empty and malformed responses", () => {
  assert.deepEqual(Model.parseCoinSearch(""), [])
  assert.deepEqual(Model.parseCoinSearch("<html>"), [])
  assert.deepEqual(Model.parseCoinSearch("{}"), [])
  assert.deepEqual(Model.parseCoinSearch(JSON.stringify({ coins: [] })), [])
})

test("mergeSearchResults: Yahoo results come first", () => {
  const yahoo = [{ symbol: "AAPL", name: "Apple Inc.", type: "EQUITY", exchange: "NasdaqGS" }]
  const coins = [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1 }]
  const merged = Model.mergeSearchResults(yahoo, coins)
  assert.equal(merged.length, 2)
  assert.equal(merged[0].symbol, "AAPL")
  assert.equal(merged[0].type, "EQUITY")
  assert.equal(merged[1].symbol, "BTC")
  assert.equal(merged[1].type, "CRYPTO")
  assert.equal(merged[1].exchange, "Binance")
  assert.equal(merged[1].rank, 1)
  assert.equal(merged[1].coingeckoId, "bitcoin")
})

test("mergeSearchResults: deduplicates CoinGecko results already in Yahoo", () => {
  const yahoo = [{ symbol: "BTC-USD", name: "Bitcoin USD", type: "CRYPTOCURRENCY", exchange: "CCC" }]
  const coins = [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1 }]
  const merged = Model.mergeSearchResults(yahoo, coins)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].symbol, "BTC-USD")
})

test("mergeSearchResults: handles null/empty inputs", () => {
  assert.deepEqual(Model.mergeSearchResults(null, null), [])
  assert.deepEqual(Model.mergeSearchResults([], []), [])
  assert.deepEqual(Model.mergeSearchResults([{ symbol: "AAPL", name: "A", type: "EQUITY", exchange: "X" }], null).length, 1)
  assert.deepEqual(Model.mergeSearchResults(null, [{ id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1 }]).length, 1)
})

test("mergeSearchResults: keeps unique CoinGecko results not in Yahoo", () => {
  const yahoo = [{ symbol: "AAPL", name: "Apple Inc.", type: "EQUITY", exchange: "NasdaqGS" }]
  const coins = [
    { id: "bitcoin", symbol: "BTC", name: "Bitcoin", rank: 1 },
    { id: "ethereum", symbol: "ETH", name: "Ethereum", rank: 2 }
  ]
  const merged = Model.mergeSearchResults(yahoo, coins)
  assert.equal(merged.length, 3)
  assert.equal(merged[1].symbol, "BTC")
  assert.equal(merged[2].symbol, "ETH")
})

test("mergeSearchResults: crypto entries show Binance as source, others untouched", () => {
  const yahoo = [
    { symbol: "BTC-USD", name: "Bitcoin USD", type: "CRYPTOCURRENCY", exchange: "CCC" },
    { symbol: "AAPL", name: "Apple Inc.", type: "EQUITY", exchange: "NasdaqGS" }
  ]
  const merged = Model.mergeSearchResults(yahoo, [])
  assert.equal(merged[0].exchange, "Binance")
  assert.equal(merged[0].symbol, "BTC-USD")
  assert.equal(merged[1].exchange, "NasdaqGS")
})

test("mergeSearchResults: unmapped coins keep CoinGecko as source", () => {
  const coins = [{ id: "some-new-coin", symbol: "XYZ", name: "Some Coin", rank: 999 }]
  const merged = Model.mergeSearchResults([], coins)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].exchange, "CoinGecko")
})

test("priceSourceFor: Binance for mapped crypto, empty otherwise", () => {
  assert.equal(Model.priceSourceFor("BTC-USD"), "Binance")
  assert.equal(Model.priceSourceFor("ETH"), "Binance")
  assert.equal(Model.priceSourceFor("AAPL"), "")
  assert.equal(Model.priceSourceFor("^GSPC"), "")
  assert.equal(Model.priceSourceFor(""), "")
  assert.equal(Model.priceSourceFor(null), "")
})

const COIN_MARKETS_RESPONSE = JSON.stringify([
  {
    id: "bitcoin", symbol: "btc", current_price: 67432.18, market_cap: 1328000000000,
    circulating_supply: 19700000, total_volume: 28500000000,
    price_change_percentage_24h: 2.34, high_24h: 68100, low_24h: 65800,
    ath: 73750, ath_date: "2024-03-14T07:20:36.635Z",
    atl: 67.81, atl_date: "2013-07-06T00:00:00.000Z"
  },
  {
    id: "ethereum", symbol: "eth", current_price: 3456.78, market_cap: 415000000000,
    circulating_supply: 120200000, total_volume: 12000000000,
    price_change_percentage_24h: -1.2, high_24h: 3520, low_24h: 3400
  }
])

test("parseCoinMarkets: extracts market data keyed by coin ID", () => {
  const data = Model.parseCoinMarkets(COIN_MARKETS_RESPONSE)
  assert.equal(data.bitcoin.marketCap, 1328000000000)
  assert.equal(data.bitcoin.circulatingSupply, 19700000)
  assert.equal(data.bitcoin.totalVolume, 28500000000)
  assert.equal(data.bitcoin.price, 67432.18)
  assert.equal(data.bitcoin.priceChangePct24h, 2.34)
  assert.equal(data.bitcoin.high24h, 68100)
  assert.equal(data.bitcoin.low24h, 65800)
  assert.equal(data.bitcoin.ath, 73750)
  assert.equal(data.ethereum.marketCap, 415000000000)
  assert.equal(data.ethereum.priceChangePct24h, -1.2)
})

test("parseCoinMarkets: handles empty and malformed responses", () => {
  assert.deepEqual(Model.parseCoinMarkets(""), {})
  assert.deepEqual(Model.parseCoinMarkets("<html>"), {})
  assert.deepEqual(Model.parseCoinMarkets("{}"), {})
  assert.deepEqual(Model.parseCoinMarkets("[]"), {})
})

test("enrichQuotes: merges CoinGecko data into crypto quotes only", () => {
  const btc = quote("BTC-USD", 67432, 65800)
  btc.assetType = "crypto"; btc.coingeckoId = "bitcoin"
  const aapl = quote("AAPL", 305.59, 305.93)
  const coinData = { bitcoin: { marketCap: 1.3e12, circulatingSupply: 19700000, totalVolume: 28e9,
    high24h: 68100, low24h: 65800 } }
  const enriched = Model.enrichQuotes([btc, aapl], coinData)
  assert.equal(enriched[0].marketCap, 1.3e12)
  assert.equal(enriched[0].circulatingSupply, 19700000)
  assert.equal(enriched[0].high24h, 68100)
  assert.equal(enriched[1].marketCap, null)
  assert.equal(enriched[1].price, 305.59)
})

test("enrichQuotes: skips crypto quotes without matching CoinGecko data", () => {
  const btc = quote("BTC-USD", 67432, 65800)
  btc.assetType = "crypto"; btc.coingeckoId = "bitcoin"
  const enriched = Model.enrichQuotes([btc], {})
  assert.equal(enriched[0].marketCap, null)
  assert.equal(enriched[0].price, 67432)
})

test("cryptoIdsFromQuotes: deduped CoinGecko IDs from crypto quotes", () => {
  const btc = quote("BTC-USD", 1, 1)
  btc.assetType = "crypto"; btc.coingeckoId = "bitcoin"
  const eth = quote("ETH-USD", 2, 2)
  eth.assetType = "crypto"; eth.coingeckoId = "ethereum"
  const aapl = quote("AAPL", 3, 3)
  const auto = quote("SOL-USD", 4, 4)
  auto.assetType = "crypto"
  assert.deepEqual(Model.cryptoIdsFromQuotes([btc, eth, aapl, auto]), ["bitcoin", "ethereum", "solana"])
  assert.deepEqual(Model.cryptoIdsFromQuotes([aapl]), [])
  assert.deepEqual(Model.cryptoIdsFromQuotes([]), [])
})

// ---- Multi-source: Binance spot prices (primary crypto price source)

test("binancePairFor: maps Yahoo crypto pairs to Binance spot pairs", () => {
  assert.equal(Model.binancePairFor("BTC-USD"), "BTCUSDT")
  assert.equal(Model.binancePairFor("ETH-USD"), "ETHUSDT")
  assert.equal(Model.binancePairFor("btc-usd"), "BTCUSDT")
  assert.equal(Model.binancePairFor("BTC-USDT"), "BTCUSDT")
  assert.equal(Model.binancePairFor("BTC"), "BTCUSDT")
  assert.equal(Model.binancePairFor("AAPL"), "")
  assert.equal(Model.binancePairFor("^GSPC"), "")
  assert.equal(Model.binancePairFor(""), "")
  assert.equal(Model.binancePairFor(null), "")
})

test("binanceTickerUrl: builds the 24hr ticker endpoint", () => {
  assert.equal(Model.binanceTickerUrl("BTCUSDT"),
    "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT")
})

test("binanceTradeUrl: builds the spot trade page URL", () => {
  assert.equal(Model.binanceTradeUrl("BTCUSDT"), "https://www.binance.com/en/trade/BTC_USDT")
  assert.equal(Model.binanceTradeUrl("ethusdt"), "https://www.binance.com/en/trade/ETH_USDT")
  assert.equal(Model.binanceTradeUrl("BTCUSDC"), "https://www.binance.com/en/trade/BTC_USDC")
  assert.equal(Model.binanceTradeUrl(""), "")
  assert.equal(Model.binanceTradeUrl("USDT"), "")
  assert.equal(Model.binanceTradeUrl(null), "")
})

test("binanceTradeUrlFor: maps Yahoo symbols to trade pages", () => {
  assert.equal(Model.binanceTradeUrlFor("BTC-USD"), "https://www.binance.com/en/trade/BTC_USDT")
  assert.equal(Model.binanceTradeUrlFor("ETH-USD"), "https://www.binance.com/en/trade/ETH_USDT")
  assert.equal(Model.binanceTradeUrlFor("AAPL"), "")
  assert.equal(Model.binanceTradeUrlFor(""), "")
})

test("binanceCurlCommand: one URL per pair, newline write-out, custom UA", () => {
  const pairs = [{ yahoo: "BTC-USD", binance: "BTCUSDT" }, { yahoo: "ETH-USD", binance: "ETHUSDT" }]
  const cmd = Model.binanceCurlCommand(pairs, "test-agent/1.0")
  assert.deepEqual(cmd.slice(0, 8), ["curl", "-sS", "--max-time", "10", "-A", "test-agent/1.0", "-w", "\n"])
  assert.deepEqual(cmd.slice(8), [Model.binanceTickerUrl("BTCUSDT"), Model.binanceTickerUrl("ETHUSDT")])
})

const BINANCE_BTC_LINE = JSON.stringify({
  symbol: "BTCUSDT", priceChange: "-202.16", priceChangePercent: "-0.249",
  prevClosePrice: "81046.01", lastPrice: "80843.85",
  openPrice: "81046.01", highPrice: "81497.33", lowPrice: "80126.04",
  volume: "11527.41", quoteVolume: "931152990.36"
})

const BINANCE_ERROR_LINE = JSON.stringify({ code: -1121, msg: "Invalid symbol." })
const BINANCE_GEO_LINE = JSON.stringify({ code: 0, msg: "Service unavailable from a restricted location." })

test("parseBinanceTicker: valid 24hr ticker line", () => {
  const t = Model.parseBinanceTicker(BINANCE_BTC_LINE)
  assert.equal(t.binanceSymbol, "BTCUSDT")
  assert.equal(t.price, 80843.85)
  assert.equal(t.prevClose, 81046.01)
  assert.ok(Math.abs(t.change - -202.16) < 1e-9)
  assert.ok(Math.abs(t.changePct - (-202.16 / 81046.01 * 100)) < 1e-9)
  assert.equal(t.open, 81046.01)
  assert.equal(t.dayHigh, 81497.33)
  assert.equal(t.dayLow, 80126.04)
  assert.equal(t.volume, 931152990.36)
})

test("parseBinanceTicker: error, geo-block, empty and garbage lines", () => {
  assert.equal(Model.parseBinanceTicker(BINANCE_ERROR_LINE), null)
  assert.equal(Model.parseBinanceTicker(BINANCE_GEO_LINE), null)
  assert.equal(Model.parseBinanceTicker(""), null)
  assert.equal(Model.parseBinanceTicker("<html>429</html>"), null)
  assert.equal(Model.parseBinanceTicker("{}"), null)
  assert.equal(Model.parseBinanceTicker(JSON.stringify({ symbol: "X" })), null)
})

test("parseBinanceLines: Yahoo-symbol keyed map, error lines skipped", () => {
  const pairs = [{ yahoo: "BTC-USD", binance: "BTCUSDT" }, { yahoo: "ETH-USD", binance: "ETHUSDT" }]
  const map = Model.parseBinanceLines(BINANCE_BTC_LINE + "\n" + BINANCE_ERROR_LINE + "\n", pairs)
  assert.equal(map["BTC-USD"].price, 80843.85)
  assert.equal(map["ETH-USD"], undefined)
  assert.deepEqual(Model.parseBinanceLines("", pairs), {})
  assert.deepEqual(Model.parseBinanceLines("junk", []), {})
})

test("binancePairsFromQuotes: valid crypto quotes only, deduped", () => {
  const btc = quote("BTC-USD", 80000, 81000)
  const eth = quote("ETH-USD", 2600, 2600)
  const aapl = quote("AAPL", 300, 300)
  const bad = quote("NOPE", null, null, "Not Found")
  bad.assetType = "crypto"
  assert.deepEqual(Model.binancePairsFromQuotes([btc, eth, aapl, bad, btc]), [
    { yahoo: "BTC-USD", binance: "BTCUSDT" },
    { yahoo: "ETH-USD", binance: "ETHUSDT" }
  ])
  assert.deepEqual(Model.binancePairsFromQuotes([]), [])
})

test("enrichQuotesBinance: overrides crypto price fields, tags priceSource", () => {
  const btc = quote("BTC-USD", 80000, 81000)
  const aapl = quote("AAPL", 300, 300)
  const data = { "BTC-USD": Model.parseBinanceTicker(BINANCE_BTC_LINE) }
  const enriched = Model.enrichQuotesBinance([btc, aapl], data)
  assert.equal(enriched[0].price, 80843.85)
  assert.equal(enriched[0].prevClose, 81046.01)
  assert.equal(enriched[0].dayHigh, 81497.33)
  assert.equal(enriched[0].dayLow, 80126.04)
  assert.equal(enriched[0].volume, 931152990.36)
  assert.equal(enriched[0].priceSource, "binance")
  assert.equal(enriched[1].price, 300)
  assert.equal(enriched[1].priceSource, undefined)
  assert.equal(btc.price, 80000)
})

test("enrichQuotesBinance: skips missing data and invalid quotes", () => {
  const btc = quote("BTC-USD", 80000, 81000)
  const bad = quote("ETH-USD", null, null, "No data")
  const enriched = Model.enrichQuotesBinance([btc, bad], {})
  assert.equal(enriched[0].price, 80000)
  assert.equal(enriched[0].priceSource, undefined)
  assert.equal(enriched[1].error, "No data")
})

// ---- Markets fork: formatters

test("formatMarketCap: trillions, billions, millions", () => {
  assert.equal(Model.formatMarketCap(1328000000000), "$1.33T")
  assert.equal(Model.formatMarketCap(415000000000), "$415.00B")
  assert.equal(Model.formatMarketCap(500000000), "$500.0M")
  assert.equal(Model.formatMarketCap(950000), "$950.0K")
  assert.equal(Model.formatMarketCap(500), "$500")
  assert.equal(Model.formatMarketCap(null), "")
})

test("formatSupply: with symbol suffix", () => {
  assert.equal(Model.formatSupply(19700000, "BTC-USD"), "19.7M BTC")
  assert.equal(Model.formatSupply(120200000, "ETH-USD"), "120.2M ETH")
  assert.equal(Model.formatSupply(500, "SOL-USD"), "500 SOL")
  assert.equal(Model.formatSupply(null, "BTC-USD"), "")
  assert.equal(Model.formatSupply(100, null), "100")
})

// ---- Markets fork: watchlist (single list)

test("parseWatchlist: simple format { symbols: [...] }", () => {
  const wl = Model.parseWatchlist(JSON.stringify({ symbols: ["BTC-USD", "ETH-USD"] }))
  assert.deepEqual(wl.symbols, ["BTC-USD", "ETH-USD"])
})

test("parseWatchlist: falls back to default for junk input, allows empty symbols", () => {
  assert.deepEqual(Model.parseWatchlist(""), Model.defaultWatchlist())
  assert.deepEqual(Model.parseWatchlist(null), Model.defaultWatchlist())
  assert.deepEqual(Model.parseWatchlist("not json"), Model.defaultWatchlist())
  assert.deepEqual(Model.parseWatchlist("{}"), Model.defaultWatchlist())
  assert.deepEqual(Model.parseWatchlist(42), Model.defaultWatchlist())
  assert.deepEqual(Model.parseWatchlist({ symbols: [] }), { symbols: [] })
})

test("parseWatchlist: accepts object input directly", () => {
  const wl = Model.parseWatchlist({ symbols: ["AAPL"] })
  assert.deepEqual(wl.symbols, ["AAPL"])
})

test("parseWatchlist: migrates legacy multi-list format", () => {
  const wl = Model.parseWatchlist(JSON.stringify({
    active: "Crypto",
    lists: {
      "Default": { name: "Default", symbols: ["AAPL"] },
      "Crypto": { name: "Crypto", symbols: ["BTC-USD", "ETH-USD"] }
    }
  }))
  assert.deepEqual(wl.symbols, ["BTC-USD", "ETH-USD"])
})

test("parseWatchlist: migrates legacy format, uses first list if active missing", () => {
  const wl = Model.parseWatchlist(JSON.stringify({
    active: "Nonexistent",
    lists: { "Default": { name: "Default", symbols: ["AAPL"] } }
  }))
  assert.deepEqual(wl.symbols, ["AAPL"])
})

test("watchlistSymbols: returns a copy of the symbols array", () => {
  const wl = Model.parseWatchlist({ symbols: ["BTC-USD", "ETH-USD"] })
  const syms = Model.watchlistSymbols(wl)
  assert.deepEqual(syms, ["BTC-USD", "ETH-USD"])
  syms.push("XRP")
  assert.deepEqual(wl.symbols, ["BTC-USD", "ETH-USD"])
})

test("addSymbol: appends a symbol, auto-normalizes crypto", () => {
  const wl = Model.defaultWatchlist()
  const result = Model.addSymbol(wl, "msft")
  assert.deepEqual(result.symbols, ["AAPL", "NVDA", "GOOGL", "MSFT"])
})

test("addSymbol: crypto tickers get -USD appended", () => {
  const wl = Model.defaultWatchlist()
  const result = Model.addSymbol(wl, "btc")
  assert.ok(result.symbols.indexOf("BTC-USD") !== -1)
})

test("addSymbol: skips duplicates (case insensitive)", () => {
  const wl = Model.defaultWatchlist()
  const result = Model.addSymbol(wl, "aapl")
  assert.deepEqual(result.symbols, Model.DEFAULT_SYMBOLS)
})

test("removeSymbol: removes a symbol by name (case insensitive)", () => {
  const wl = Model.defaultWatchlist()
  const result = Model.removeSymbol(wl, "nvda")
  assert.deepEqual(result.symbols, ["AAPL", "GOOGL"])
})

test("removeSymbol: handles unknown symbols gracefully", () => {
  const wl = Model.defaultWatchlist()
  const result = Model.removeSymbol(wl, "NONEXISTENT")
  assert.deepEqual(result.symbols, Model.DEFAULT_SYMBOLS)
})

test("moveSymbol: moves forward and backward", () => {
  const wl = { symbols: ["AAPL", "NVDA", "GOOGL", "MSFT"] }
  assert.deepEqual(Model.moveSymbol(wl, 0, 2).symbols, ["NVDA", "GOOGL", "AAPL", "MSFT"])
  assert.deepEqual(Model.moveSymbol(wl, 3, 0).symbols, ["MSFT", "AAPL", "NVDA", "GOOGL"])
  assert.deepEqual(Model.moveSymbol(wl, 1, 2).symbols, ["AAPL", "GOOGL", "NVDA", "MSFT"])
})

test("moveSymbol: no-op and out-of-range indices leave the list unchanged", () => {
  const wl = { symbols: ["AAPL", "NVDA", "GOOGL"] }
  assert.deepEqual(Model.moveSymbol(wl, 1, 1).symbols, ["AAPL", "NVDA", "GOOGL"])
  assert.deepEqual(Model.moveSymbol(wl, -1, 1).symbols, ["AAPL", "NVDA", "GOOGL"])
  assert.deepEqual(Model.moveSymbol(wl, 0, 5).symbols, ["AAPL", "NVDA", "GOOGL"])
  assert.deepEqual(Model.moveSymbol(wl, 5, 0).symbols, ["AAPL", "NVDA", "GOOGL"])
  assert.deepEqual(Model.moveSymbol({ symbols: [] }, 0, 0).symbols, [])
  assert.deepEqual(Model.moveSymbol(wl, "x", 1).symbols, ["AAPL", "NVDA", "GOOGL"])
})

test("moveSymbol: does not mutate the input watchlist", () => {
  const wl = { symbols: ["AAPL", "NVDA", "GOOGL"] }
  Model.moveSymbol(wl, 0, 2)
  assert.deepEqual(wl.symbols, ["AAPL", "NVDA", "GOOGL"])
})

test("serializeWatchlist / parseWatchlist round-trip", () => {
  const wl = Model.addSymbol(Model.defaultWatchlist(), "BTC-USD")
  const json = Model.serializeWatchlist(wl)
  const parsed = Model.parseWatchlist(json)
  assert.deepEqual(parsed.symbols, wl.symbols)
})

test("writeWatchlistCommand: produces a python3 command with the JSON payload", () => {
  const wl = Model.defaultWatchlist()
  const cmd = Model.writeWatchlistCommand("/tmp/test.json", wl)
  assert.equal(cmd[0], "python3")
  assert.equal(cmd[1], "-c")
  assert.equal(cmd[3], "/tmp/test.json")
  const parsed = JSON.parse(cmd[4])
  assert.deepEqual(parsed.symbols, Model.DEFAULT_SYMBOLS)
})

// ---- Markets fork: Yahoo search

test("yahooSearchUrl: builds the search endpoint", () => {
  const url = Model.yahooSearchUrl("apple")
  assert.ok(url.indexOf("query2.finance.yahoo.com") !== -1)
  assert.ok(url.indexOf("q=apple") !== -1)
  assert.ok(url.indexOf("quotesCount=8") !== -1)
})

const YAHOO_SEARCH_RESPONSE = JSON.stringify({
  quotes: [
    { symbol: "AAPL", shortname: "Apple Inc.", quoteType: "EQUITY", exchDisp: "NasdaqGS" },
    { symbol: "AAPL.L", shortname: "Apple Inc.", quoteType: "EQUITY", exchDisp: "London" },
    { symbol: "BTC-USD", shortname: "Bitcoin USD", quoteType: "CRYPTOCURRENCY", exchDisp: "CCC" }
  ]
})

test("parseYahooSearch: extracts search results", () => {
  const results = Model.parseYahooSearch(YAHOO_SEARCH_RESPONSE)
  assert.equal(results.length, 3)
  assert.equal(results[0].symbol, "AAPL")
  assert.equal(results[0].name, "Apple Inc.")
  assert.equal(results[0].type, "EQUITY")
  assert.equal(results[0].exchange, "NasdaqGS")
  assert.equal(results[2].symbol, "BTC-USD")
})

test("parseYahooSearch: handles empty and malformed responses", () => {
  assert.deepEqual(Model.parseYahooSearch(""), [])
  assert.deepEqual(Model.parseYahooSearch("<html>"), [])
  assert.deepEqual(Model.parseYahooSearch("{}"), [])
  assert.deepEqual(Model.parseYahooSearch(JSON.stringify({ quotes: [] })), [])
})

test("parseChartResponse: captures trading-period hours", () => {
  const line = JSON.stringify({ chart: { result: [{ meta: {
    symbol: "AAPL", regularMarketPrice: 100, previousClose: 99,
    currentTradingPeriod: {
      pre: { start: 1000, end: 2000 },
      regular: { start: 2000, end: 3000 },
      post: { start: 3000, end: 4000 }
    }
  } }], error: null } })
  const q = Model.parseChartResponse(line)
  assert.equal(q.regularStart, 2000)
  assert.equal(q.regularEnd, 3000)
  assert.equal(q.preStart, 1000)
  assert.equal(q.postEnd, 4000)
})

test("marketStatus: open / pre / post / closed / unknown / crypto", () => {
  const base = { assetType: "stock", regularStart: 2000, regularEnd: 3000, preStart: 1000, postEnd: 4000 }
  assert.equal(Model.marketStatus({ ...base }, 2500 * 1000), "open")
  assert.equal(Model.marketStatus({ ...base }, 1500 * 1000), "pre")
  assert.equal(Model.marketStatus({ ...base }, 3500 * 1000), "post")
  assert.equal(Model.marketStatus({ ...base }, 5000 * 1000), "closed")
  assert.equal(Model.marketStatus({ ...base }, 500 * 1000), "closed")
  assert.equal(Model.marketStatus({ assetType: "stock" }, Date.now()), "")
  assert.equal(Model.marketStatus({ assetType: "crypto", regularStart: 2000, regularEnd: 3000 }, 5000 * 1000), "")
  assert.equal(Model.marketStatus(null, Date.now()), "")
})

test("marketStatusLabel: human labels", () => {
  assert.equal(Model.marketStatusLabel("closed"), "Closed")
  assert.equal(Model.marketStatusLabel("pre"), "Pre-market")
  assert.equal(Model.marketStatusLabel("post"), "After hours")
  assert.equal(Model.marketStatusLabel("open"), "")
  assert.equal(Model.marketStatusLabel(""), "")
  assert.equal(Model.marketStatusLabel(null), "")
})

test("displaySymbol: USD quote is implied for crypto", () => {
  assert.equal(Model.displaySymbol("BTC-USD"), "BTC")
  assert.equal(Model.displaySymbol("ETH-USD"), "ETH")
  assert.equal(Model.displaySymbol("BTC-USDT"), "BTC")
  assert.equal(Model.displaySymbol("BTC-EUR"), "BTC/EUR")
  assert.equal(Model.displaySymbol("SOL-BTC"), "SOL/BTC")
  assert.equal(Model.displaySymbol("AAPL"), "AAPL")
  assert.equal(Model.displaySymbol("^GSPC"), "^GSPC")
})

test("cleanAssetName: drops the quote suffix from crypto names only", () => {
  assert.equal(Model.cleanAssetName("Bitcoin USD", "BTC-USD"), "Bitcoin")
  assert.equal(Model.cleanAssetName("Ethereum USD", "ETH-USD"), "Ethereum")
  assert.equal(Model.cleanAssetName("Bitcoin EUR", "BTC-EUR"), "Bitcoin")
  assert.equal(Model.cleanAssetName("Bitcoin", "BTC-USD"), "Bitcoin")
  assert.equal(Model.cleanAssetName("Apple Inc.", "AAPL"), "Apple Inc.")
  assert.equal(Model.cleanAssetName("", "BTC-USD"), "")
})
