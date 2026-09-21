import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// State owner for the Markets widget: fetches quotes, chart series, and
// crypto metadata, then renders the click-to-open panel with watchlist tabs.
// BarWidget.qml loads this and mirrors `tapeItems` / `label` into the bar.
Panel {
  id: root
  moduleName: "mn.markets"
  // The bar entry (BarWidget.qml) owns the IPC target; see its IpcHandler.
  manageIpc: false

  property var anchorItem: null
  // The bar identifies a panel by the widget mounted in its slot, not by this
  // nested item, so popout switching and the open-panel indicator use it.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // ---- Settings (inline on this widget's shell.json entry).
  readonly property int refreshMinutes: Model.refreshMinutes(setting("refreshMinutes", 5))
  readonly property bool compact: setting("compact", false) === true || String(setting("compact", false)) === "true"
  readonly property string activeRange: Model.chartRange(setting("chartRange", "1d"))
  readonly property string displayCurrency: Model.normalizeCurrency(setting("currency", ""))
  readonly property var currencies: Model.normalizeCurrencies(setting("currencies", null))
  readonly property string upColorSetting: Model.normalizeColor(setting("upColor", ""))
  readonly property string downColorSetting: Model.normalizeColor(setting("downColor", ""))

  // ---- Watchlist state. Persisted in watchlist.json alongside the plugin.
  property var watchlist: Model.defaultWatchlist()
  readonly property var symbols: Model.watchlistSymbols(watchlist)
  readonly property string symbolsKey: symbols.join(",")

  // ---- CoinGecko metadata cache.
  property var coinData: ({})

  // ---- Quote state. `quotes` keeps the last good result across failures so
  //      stale-but-useful numbers stay visible; `fetchError` explains why.
  property var quotes: []
  property string fetchError: ""
  property var lastUpdated: null
  property double nowTick: 0
  readonly property bool isStale: lastUpdated ? Model.isStale(lastUpdated.getTime(), refreshMinutes, nowTick > 0 ? nowTick : Date.now()) : false
  readonly property string freshnessText: {
    if (!lastUpdated) return loading ? "Loading\u2026" : ""
    var now = nowTick > 0 ? nowTick : Date.now()
    var age = Model.ageLabel(lastUpdated.getTime(), now)
    var base = "Updated " + Qt.formatTime(lastUpdated, "HH:mm")
    if (age !== "" && age !== "just now") base += " (" + age + ")"
    if (Model.isStale(lastUpdated.getTime(), refreshMinutes, now)) base += " \u00B7 stale"
    return base
  }
  property int retries: 0
  property int selectedIndex: 0
  property bool symbolSelected: false

  // ---- Drag-and-drop reorder state. dragIndex is the picked-up row (-1 when
  //      idle); the row visuals follow dragPointerY with the other rows
  //      shifting to show the drop position (dragTarget).
  property int dragIndex: -1
  property int dragTarget: -1
  property real dragPointerY: 0
  property real dragGrabY: 0
  property real dragRowH: 1
  property bool suppressRefetch: false

  // ---- Chart-series cache for the active range when it is not 1d (the 1d
  //      series rides along with every quote fetch).
  property var chartSeries: ({})
  property string chartSeriesRange: ""
  property string chartRequestedRange: ""
  property bool chartLoading: false
  property double chartFetchedAt: 0

  // ---- FX rates ("USDEUR=X" -> 0.92) for the display currency.
  property var rates: ({})
  property var ratesRequested: []
  property int ratesRetries: 0

  readonly property string userAgent: "Mozilla/5.0 (X11; Linux x86_64) omarchy-markets/0.3.0"
  readonly property bool loading: quotes.length === 0 && fetchError === ""
  readonly property int validCount: Model.validCount(quotes)
  // Quotes as displayed: Binance spot prices override Yahoo for crypto,
  // then converted into the display currency, then enriched with CoinGecko
  // metadata for crypto symbols.
  readonly property var shownQuotes: Model.enrichQuotes(Model.convertAll(Model.enrichQuotesBinance(quotes, binanceData), displayCurrency, rates), coinData)
  readonly property var tapeItems: Model.tapeItems(shownQuotes, compact, nowTick > 0 ? nowTick : Date.now())
  readonly property var selectedQuote: selectedIndex >= 0 && selectedIndex < shownQuotes.length ? shownQuotes[selectedIndex] : null
  readonly property bool hasSelection: Model.isValid(selectedQuote)

  // Fallback pill text while the tape has nothing to show: "AAPL …" while
  // loading, "AAPL !" when every symbol failed, "Markets" when empty.
  readonly property string label: shownQuotes.length > 0
    ? Model.barLabel(shownQuotes[0], compact)
    : (symbols.length ? Model.loadingLabel(symbols[0]) : "Markets")
  readonly property string verticalText: {
    var first = Model.firstValidIndex(shownQuotes)
    if (first >= 0) return Model.verticalLabel(shownQuotes[first])
    if (shownQuotes.length > 0) return Model.verticalLabel(shownQuotes[0])
    if (symbols.length) return symbols[0] + "\n\u2026"
    return "MKT\n+"
  }

  // ---- Presentation helpers shared by every row.
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color mutedForeground: Qt.darker(barForeground, 1.5)
  readonly property color urgentForeground: bar ? bar.urgent : Color.urgent

  // Up/down tints: settings override > theme palette (colors.toml) > fallback.
  property string themeGreen: ""
  property string themeRed: ""
  readonly property color upColor: upColorSetting !== "" ? upColorSetting : (themeGreen !== "" ? themeGreen : "#5fbf6f")
  readonly property color downColor: downColorSetting !== "" ? downColorSetting : (themeRed !== "" ? themeRed : urgentForeground)

  function trendColor(quote) {
    if (Model.isDown(quote)) return downColor
    if (Model.isUp(quote)) return upColor
    return barForeground
  }

  function directionColor(series) {
    var d = Model.seriesDirection(series)
    if (d < 0) return downColor
    if (d > 0) return upColor
    return barForeground
  }

  // Chart + change text share this so the line always matches the
  // gain/loss tint (series slope alone can disagree with the live price,
  // e.g. Binance override or a cached series vs fresh quote).
  function changeColor(change) {
    var c = Number(change)
    if (isNaN(c)) return barForeground
    if (c < 0) return downColor
    if (c > 0) return upColor
    return barForeground
  }

  // Session badge: "Closed" / "Pre-market" / "After hours" or "" when
  // open/unknown/crypto. Uses the ticking clock so the label flips
  // live without waiting for the next quote refresh.
  function sessionLabel(quote) {
    return Model.marketStatusLabel(Model.marketStatus(quote, root.nowTick > 0 ? root.nowTick : Date.now()))
  }

  // Badge with icon: "☾ Closed", "◐ Pre-market", "◐ After hours" or "".
  function sessionBadge(quote) {
    var st = Model.marketStatus(quote, root.nowTick > 0 ? root.nowTick : Date.now())
    var label = Model.marketStatusLabel(st)
    if (label === "") return ""
    return (st === "closed" ? "☾ " : "◐ ") + label
  }

  // Icon glyph only for the in-row marker beside the symbol.
  function sessionIcon(quote) {
    var st = Model.marketStatus(quote, root.nowTick > 0 ? root.nowTick : Date.now())
    if (st === "closed") return "☾"
    if (st === "pre" || st === "post") return "◐"
    return ""
  }

  // ---- File views.

  FileView {
    id: themeColors
    path: Color.currentThemePath + "/colors.toml"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.themeGreen = Model.parseThemeColor(text(), "green")
      root.themeRed = Model.parseThemeColor(text(), "red")
    }
    onLoadFailed: {
      root.themeGreen = ""
      root.themeRed = ""
    }
  }

  FileView {
    id: watchlistFile
    path: root.watchlistPath()
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: {
      root.watchlist = Model.parseWatchlist(text())
    }
    onLoadFailed: {
      root.watchlist = Model.defaultWatchlist()
    }
  }

  function watchlistPath() {
    var pluginDir = Qt.resolvedUrl("watchlist.json").toString().replace("file://", "")
    var pluginDirEnd = pluginDir.lastIndexOf("/")
    var pluginBase = pluginDir.substring(0, pluginDirEnd)
    return pluginBase.replace("/.config/omarchy/", "/.local/state/omarchy/") + "/watchlist.json"
  }

  function saveWatchlist(wl) {
    if (!wl) { console.log("[mk] saveWatchlist: null wl, abort"); return }
    console.log("[mk] saveWatchlist: " + JSON.stringify(wl.symbols))
    watchlist = wl
    writeWatchlistProc.command = Model.writeWatchlistCommand(watchlistPath(), wl)
    writeWatchlistProc.running = true
  }

  function open() {
    root.controller.show()
    refresh()
    ensureChartSeries(false)
    ensureCoinData()
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) close()
    else open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // A user-driven refresh gets a fresh retry budget.
  function refresh() {
    retries = 0
    startFetch()
  }

  function startFetch() {
    if (fetchProc.running || symbols.length === 0) return
    fetchProc.command = Model.curlCommand(symbols, userAgent, "1d")
    fetchProc.running = true
  }

  function handleFetchOutput(text) {
    var raw = String(text || "")
    if (raw.replace(/\s+/g, "") === "") {
      fetchError = "No response from Yahoo Finance"
      scheduleRetry()
      return
    }

    var parsed = Model.parseQuoteLines(raw, symbols)
    if (Model.validCount(parsed) === 0) {
      fetchError = parsed.length ? parsed[0].error : "No data"
      if (quotes.length === 0) quotes = parsed
      if (Model.shouldRetry(parsed)) scheduleRetry()
      return
    }

    quotes = parsed
    lastUpdated = new Date()
    nowTick = Date.now()
    fetchError = ""
    retries = 0
    coinRetries = 0
    ensureRates()
    ensureBinancePrices()
    ensureCoinData()
    if (root.opened && Date.now() - chartFetchedAt > 60000) ensureChartSeries(true)
  }

  // ---- FX rates for the display currency.
  function ensureRates() {
    var pairs = Model.ratePairs(quotes, displayCurrency)
    if (!pairs.length || ratesProc.running) return
    ratesRequested = pairs
    ratesProc.command = Model.curlCommand(pairs, userAgent, "1d")
    ratesProc.running = true
  }

  function handleRatesOutput(text) {
    var raw = String(text || "")
    var fresh = raw.replace(/\s+/g, "") === "" ? {} : Model.parseRateLines(raw, ratesRequested)
    var missing = false
    for (var i = 0; i < ratesRequested.length; i++) if (fresh[ratesRequested[i]] === undefined) missing = true
    if (missing && ratesRetries < 3) {
      ratesRetries++
      ratesRetryTimer.restart()
    } else {
      ratesRetries = 0
    }
    var merged = {}
    for (var k in rates) merged[k] = rates[k]
    for (var f in fresh) merged[f] = fresh[f]
    rates = merged
  }

  // ---- CoinGecko metadata: market cap, supply, 24h data for crypto quotes.
  property double coinFetchedAt: 0
  property int coinRetries: 0

  function ensureCoinData() {
    // Panel-only metadata (cap/supply/24h): never fetch for the tape alone.
    if (!root.opened) return
    var ids = Model.cryptoIdsFromQuotes(quotes)
    if (!ids.length) return
    var now = Date.now()
    var cached = true
    for (var i = 0; i < ids.length; i++) { if (!coinData[ids[i]]) cached = false }
    if (cached && now - coinFetchedAt < 300000) return
    if (coinProc.running) return
    coinProc.command = Model.coingeckoCurlCommand(Model.coingeckoMarketsUrl(ids), userAgent)
    coinProc.running = true
  }

  function handleCoinOutput(text) {
    var raw = String(text || "")
    if (raw.indexOf('"error_code":429') !== -1 || raw.indexOf('"status_code":429') !== -1) {
      if (coinRetries < 3) {
        coinRetries++
        coinRetryTimer.restart()
      }
      return
    }
    var fresh = Model.parseCoinMarkets(raw)
    if (Object.keys(fresh).length > 0) {
      var merged = {}
      for (var k in coinData) merged[k] = coinData[k]
      for (var f in fresh) merged[f] = fresh[f]
      coinData = merged
      coinFetchedAt = Date.now()
      coinRetries = 0
    }
  }

  // ---- Binance spot prices: primary crypto price source, refreshed with
  //      every quote refresh. Unlike CoinGecko's 5-minute metadata cache,
  //      spot prices are cached for 60s (Binance has no practical rate limit
  //      at this volume; US users get HTTP 451 -> lines parse as invalid and
  //      Yahoo data stands).
  property var binanceData: ({})
  property var binanceRequestedPairs: []
  property double binanceFetchedAt: 0

  function ensureBinancePrices() {
    var pairs = Model.binancePairsFromQuotes(quotes)
    if (!pairs.length || binanceProc.running) return
    var same = pairs.length === binanceRequestedPairs.length
    if (same) {
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].yahoo !== binanceRequestedPairs[i].yahoo) { same = false; break }
      }
    }
    if (same && Date.now() - binanceFetchedAt < 60000) {
      var fresh = true
      for (var j = 0; j < pairs.length; j++) { if (!binanceData[pairs[j].yahoo]) fresh = false }
      if (fresh) return
    }
    binanceRequestedPairs = pairs
    binanceProc.command = Model.binanceCurlCommand(pairs, userAgent)
    binanceProc.running = true
  }

  function handleBinanceOutput(text) {
    var raw = String(text || "")
    var fresh = raw.replace(/\s+/g, "") === "" ? {} : Model.parseBinanceLines(raw, binanceRequestedPairs)
    var merged = {}
    for (var k in binanceData) merged[k] = binanceData[k]
    for (var f in fresh) merged[f] = fresh[f]
    binanceData = merged
    if (Object.keys(fresh).length > 0) binanceFetchedAt = Date.now()
  }

  // ---- Yahoo symbol search for the add-symbol input.
  property var searchResults: []
  property var coinSearchResults: []
  property bool searchLoading: false
  property bool coinSearchLoading: false

  property var yahooSearchResults: []

  function runSearch(query) {
    var q = Model.trimString(query)
    if (q === "") { searchResults = []; yahooSearchResults = []; coinSearchResults = []; return }
    searchLoading = true
    searchProc.command = Model.yahooSearchCommand(q, userAgent)
    searchProc.running = true
  }

  function handleSearchOutput(text) {
    searchLoading = false
    yahooSearchResults = Model.parseYahooSearch(String(text || ""))
    console.log("[mk] yahoo search returned " + yahooSearchResults.length + " results")
    searchResults = Model.mergeSearchResults(yahooSearchResults, coinSearchResults)
  }

  function handleCoinSearchOutput(text) {
    coinSearchLoading = false
    coinSearchResults = Model.parseCoinSearch(String(text || ""))
    searchResults = Model.mergeSearchResults(yahooSearchResults, coinSearchResults)
  }

  function addSymbol(symbol) {
    console.log("[mk] addSymbol called with: " + JSON.stringify(symbol))
    var sym = Model.normalizeSymbol(symbol)
    console.log("[mk] normalized: " + JSON.stringify(sym))
    if (sym === "") return
    var wl = Model.addSymbol(watchlist, sym)
    console.log("[mk] new watchlist: " + JSON.stringify(wl ? wl.symbols : null))
    if (wl) saveWatchlist(wl)
    searchResults = []
    addInput.text = ""
  }

  function removeSymbol(symbol) {
    var wl = Model.removeSymbol(watchlist, symbol)
    if (wl) saveWatchlist(wl)
  }

  function selectCurrency(step) {
    var next = Model.currencyCycle(displayCurrency, currencies, step)
    if (next === displayCurrency) return
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.currency = next
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function currencyLabel(quote) {
    if (!quote) return ""
    if (quote.converted) return quote.nativeCurrency + " \u2192 " + quote.currency
    return ""
  }

  // Price data source: "Binance" when Binance spot enrichment kicked in,
  // otherwise the Yahoo exchange label.
  function sourceLabel(quote) {
    if (!quote) return ""
    if (quote.priceSource === "binance") return "Binance"
    return quote.exchange
  }

  function scheduleRetry() {
    if (retries >= 3) return
    retries++
    retryTimer.restart()
  }

  // ---- Chart series for the non-1d ranges. Panel-only: the tape never
  //      needs it, so structural opened-guard here (callers check too).
  function ensureChartSeries(force) {
    if (!root.opened) return
    if (activeRange === "1d" || symbols.length === 0) return
    if (!force && chartSeriesRange === activeRange) return
    startChartFetch()
  }

  function startChartFetch() {
    if (chartProc.running || symbols.length === 0) return
    chartRequestedRange = activeRange
    chartLoading = true
    chartProc.command = Model.curlCommand(symbols, userAgent, activeRange)
    chartProc.running = true
  }

  function handleChartOutput(text) {
    chartLoading = false
    var raw = String(text || "")
    if (raw.replace(/\s+/g, "") === "") return
    chartSeries = Model.parseSeriesLines(raw, symbols, chartRequestedRange)
    chartSeriesRange = chartRequestedRange
    chartFetchedAt = Date.now()
    if (chartRequestedRange !== activeRange) Qt.callLater(root.startChartFetch)
  }

  function seriesFor(quote) {
    if (!quote) return []
    if (activeRange === "1d") return quote.series || []
    var raw = chartSeries[quote.symbol] || []
    return Model.convertSeries(raw, Model.rateFor(quote.nativeCurrency || quote.currency, displayCurrency, rates))
  }

  function selectRange(range) {
    var next = Model.chartRange(range)
    if (next === activeRange) return
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.chartRange = next
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function selectQuote(index) {
    if (index >= 0 && index < quotes.length && Model.isValid(quotes[index])) {
      if (index === selectedIndex && symbolSelected) {
        symbolSelected = false
      } else {
        selectedIndex = index
        symbolSelected = true
      }
    }
  }

  function startSymbolDrag(index, pointerY) {
    if (dragIndex >= 0) return
    var n = symbols.length
    if (n < 2 || index < 0 || index >= n) return
    var rowH = rowsColumn.height / n
    if (!(rowH > 0)) return
    dragRowH = rowH
    dragIndex = index
    dragTarget = index
    dragGrabY = pointerY - index * rowH
    dragPointerY = pointerY
  }

  function updateSymbolDrag(pointerY) {
    if (dragIndex < 0) return
    dragPointerY = pointerY
    var t = Math.floor(pointerY / dragRowH)
    if (t < 0) t = 0
    if (t > symbols.length - 1) t = symbols.length - 1
    dragTarget = t
  }

  function endSymbolDrag() {
    var from = dragIndex
    var to = dragTarget
    dragIndex = -1
    dragTarget = -1
    if (from < 0 || to < 0 || from === to) return
    var n = symbols.length
    if (from >= n || to >= n || quotes.length !== n) return
    // Keep the detail panel on the same symbol across the reorder.
    if (selectedIndex === from) selectedIndex = to
    else if (from < selectedIndex && selectedIndex <= to) selectedIndex--
    else if (to <= selectedIndex && selectedIndex < from) selectedIndex++
    // Permute quotes locally (same data, new order) and persist without a
    // refetch flash: the next scheduled refresh picks up anything new.
    var q = quotes.slice()
    var movedItem = q.splice(from, 1)[0]
    q.splice(to, 0, movedItem)
    suppressRefetch = true
    quotes = q
    saveWatchlist(Model.moveSymbol(watchlist, from, to))
  }

  // Visual offset for a row while dragging: the picked-up row follows the
  // pointer, rows between it and the drop position shift to open the gap.
  function rowDragShift(idx) {
    if (root.dragIndex < 0) return 0
    if (idx === root.dragIndex) return root.dragPointerY - root.dragGrabY - root.dragIndex * root.dragRowH
    if (root.dragIndex < root.dragTarget) {
      if (idx > root.dragIndex && idx <= root.dragTarget) return -root.dragRowH
    } else if (root.dragTarget < root.dragIndex) {
      if (idx >= root.dragTarget && idx < root.dragIndex) return root.dragRowH
    }
    return 0
  }

  function openQuotePage(symbol) {
    if (root.bar && typeof root.bar.run === "function")
      root.bar.run("xdg-open " + Model.shellQuote(Model.quoteUrl(symbol)))
  }

  // Source-aware link target: Binance trade page when Binance enrichment is
  // active and the pair maps, otherwise the Yahoo quote page.
  function sourcePageUrl(quote) {
    if (quote && quote.priceSource === "binance") {
      var binanceUrl = Model.binanceTradeUrlFor(quote.symbol)
      if (binanceUrl !== "") return binanceUrl
    }
    return quote ? Model.quoteUrl(quote.symbol) : ""
  }

  function sourcePageLabel(quote) {
    if (quote && quote.priceSource === "binance" && Model.binanceTradeUrlFor(quote.symbol) !== "")
      return "Open on Binance \u2197"
    return "Open on Yahoo Finance \u2197"
  }

  function openSourcePage(quote) {
    if (!quote) return
    var url = sourcePageUrl(quote)
    if (url !== "" && root.bar && typeof root.bar.run === "function")
      root.bar.run("xdg-open " + Model.shellQuote(url))
  }

  function rangeLabel(range) {
    return { "1h": "1H", "4h": "4H", "1d": "1D", "5d": "1W", "1mo": "1M", "3mo": "3M", "6mo": "6M", "ytd": "YTD", "1y": "1Y", "5y": "5Y", "max": "MAX" }[range] || range
  }

  function formatStamp(ts, range) {
    if (ts === null || ts === undefined) return ""
    var d = new Date(ts * 1000)
    if (range === "1h" || range === "4h" || range === "1d") return Qt.formatDateTime(d, "HH:mm")
    if (range === "5d") return Qt.formatDateTime(d, "ddd HH:mm")
    if (range === "1y" || range === "5y" || range === "max") return Qt.formatDateTime(d, "MMM yyyy")
    return Qt.formatDateTime(d, "d MMM")
  }

  function isCryptoQuote(quote) {
    return quote && (quote.assetType === "crypto")
  }

  // When the watchlist symbols change, reset fetch state but keep selection open.
  // A pure reorder (same symbols, new order) skips the refetch: quotes were
  // already permuted locally by endSymbolDrag.
  onSymbolsKeyChanged: {
    if (suppressRefetch) { suppressRefetch = false; return }
    quotes = []
    chartSeries = {}
    chartSeriesRange = ""
    fetchError = ""
    lastUpdated = null
    retries = 0
    fetchProc.running = false
    chartProc.running = false
    Qt.callLater(root.startFetch)
    if (root.opened) Qt.callLater(function() { root.ensureChartSeries(true) })
  }

  onActiveRangeChanged: if (root.opened) ensureChartSeries(false)
  onDisplayCurrencyChanged: ensureRates()

  onQuotesChanged: {
    if (!Model.isValid(selectedQuote)) {
      var first = Model.firstValidIndex(quotes)
      selectedIndex = first >= 0 ? first : 0
      if (first < 0) symbolSelected = false
    }
  }

  Component.onCompleted: { root.nowTick = Date.now(); Qt.callLater(root.startFetch) }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleFetchOutput(text)
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var message = String(text || "").split("\n")[0].replace(/^curl:\s*\(\d+\)\s*/, "").trim()
        if (message !== "" && root.fetchError !== "" && root.validCount === 0) root.fetchError = message
      }
    }
  }

  Process {
    id: chartProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleChartOutput(text)
    }
  }

  Process {
    id: ratesProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleRatesOutput(text)
    }
  }

  Process {
    id: coinProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleCoinOutput(text)
    }
  }

  Process {
    id: binanceProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleBinanceOutput(text)
    }
  }

  Process {
    id: searchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleSearchOutput(text)
    }
  }

  Process {
    id: coinSearchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.handleCoinSearchOutput(text)
    }
  }

  Process {
    id: writeWatchlistProc
  }

  Timer {
    id: retryTimer
    interval: 2500
    onTriggered: root.startFetch()
  }

  Timer {
    id: ratesRetryTimer
    interval: 2500
    onTriggered: root.ensureRates()
  }

  Timer {
    id: refreshTimer
    interval: root.refreshMinutes * 60 * 1000
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  Timer {
    id: searchDebounce
    interval: 300
    onTriggered: root.runSearch(addInput.text)
  }

  Timer {
    id: coinSearchDebounce
    interval: 600
    onTriggered: {
      var q = Model.trimString(addInput.text)
      if (q !== "") {
        root.coinSearchLoading = true
        coinSearchProc.command = Model.coingeckoCurlCommand(Model.coingeckoSearchUrl(q), root.userAgent)
        coinSearchProc.running = true
      }
    }
  }

  Timer {
    id: coinRetryTimer
    interval: 65000
    onTriggered: root.ensureCoinData()
  }

  Timer {
    id: ageTimer
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowTick = Date.now()
  }

  component SeriesCanvas: Canvas {
    id: canvas
    property var series: []
    property color lineColor: "white"
    property color mutedColor: "#9a978c"
    property real lineWidth: 1.5
    property real pad: 2
    property bool fill: false
    property var referenceValue: null
    property string referenceLabel: ""
    property bool showAxisLabels: false
    property int hoverIndex: -1

    onSeriesChanged: requestPaint()
    onLineColorChanged: requestPaint()
    onMutedColorChanged: requestPaint()
    onReferenceValueChanged: requestPaint()
    onReferenceLabelChanged: requestPaint()
    onShowAxisLabelsChanged: requestPaint()
    onHoverIndexChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var pts = Model.seriesPoints(canvas.series, canvas.width, canvas.height, canvas.pad)
      if (pts.length < 2) return

      // Subtle horizontal gridlines for scale (was: no grid).
      ctx.strokeStyle = Qt.rgba(canvas.lineColor.r, canvas.lineColor.g, canvas.lineColor.b, 0.12)
      ctx.lineWidth = 1
      for (var g = 1; g <= 3; g++) {
        var gy = canvas.pad + (canvas.height - canvas.pad * 2) * g / 4
        ctx.beginPath()
        ctx.moveTo(pts[0].x, gy)
        ctx.lineTo(pts[pts.length - 1].x, gy)
        ctx.stroke()
      }

      if (canvas.fill) {
        var gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
        gradient.addColorStop(0, Qt.rgba(canvas.lineColor.r, canvas.lineColor.g, canvas.lineColor.b, 0.28))
        gradient.addColorStop(1, Qt.rgba(canvas.lineColor.r, canvas.lineColor.g, canvas.lineColor.b, 0.0))
        ctx.fillStyle = gradient
        ctx.beginPath()
        ctx.moveTo(pts[0].x, canvas.height)
        for (var f = 0; f < pts.length; f++) ctx.lineTo(pts[f].x, pts[f].y)
        ctx.lineTo(pts[pts.length - 1].x, canvas.height)
        ctx.closePath()
        ctx.fill()
      }

      var refY = Model.valueToY(canvas.referenceValue, Model.seriesBounds(canvas.series), canvas.height, canvas.pad)
      if (refY !== null) {
        ctx.strokeStyle = Qt.rgba(canvas.lineColor.r, canvas.lineColor.g, canvas.lineColor.b, 0.35)
        ctx.lineWidth = 1
        ctx.setLineDash([3, 3])
        ctx.beginPath()
        ctx.moveTo(pts[0].x, refY)
        ctx.lineTo(pts[pts.length - 1].x, refY)
        ctx.stroke()
        ctx.setLineDash([])
        if (canvas.referenceLabel !== "") {
          ctx.font = "10px sans-serif"
          ctx.textAlign = "left"
          ctx.fillStyle = Qt.rgba(canvas.mutedColor.r, canvas.mutedColor.g, canvas.mutedColor.b, 0.9)
          ctx.fillText(canvas.referenceLabel, canvas.pad + 2, Math.max(canvas.pad + 10, refY - 4))
        }
      }

      // Left-side price labels (max / mid / min) so the scale reads
      // without leaving the chart — ported from the HTML prototype.
      if (canvas.showAxisLabels) {
        var b = Model.seriesBounds(canvas.series)
        if (b !== null) {
          ctx.font = "10px sans-serif"
          ctx.textAlign = "left"
          ctx.fillStyle = Qt.rgba(canvas.mutedColor.r, canvas.mutedColor.g, canvas.mutedColor.b, 0.9)
          ctx.fillText(Model.formatPrice(b.max), canvas.pad + 2, canvas.pad + 10)
          ctx.fillText(Model.formatPrice((b.max + b.min) / 2), canvas.pad + 2, canvas.height / 2 + 3)
          ctx.fillText(Model.formatPrice(b.min), canvas.pad + 2, canvas.height - canvas.pad - 2)
        }
      }

      ctx.strokeStyle = canvas.lineColor
      ctx.lineWidth = canvas.lineWidth
      ctx.lineJoin = "round"
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()

      // Current-price dot at the series end (was: bare line end).
      var last = pts[pts.length - 1]
      ctx.fillStyle = canvas.lineColor
      ctx.beginPath()
      ctx.arc(last.x, last.y, canvas.fill ? 3 : 2.25, 0, Math.PI * 2)
      ctx.fill()

      // Hover crosshair: vertical line + dot at hovered point.
      if (canvas.hoverIndex >= 0 && canvas.hoverIndex < pts.length) {
        var hp = pts[canvas.hoverIndex]
        ctx.strokeStyle = canvas.lineColor
        ctx.lineWidth = 1.5
        ctx.setLineDash([])
        ctx.beginPath()
        ctx.moveTo(hp.x, canvas.pad)
        ctx.lineTo(hp.x, canvas.height - canvas.pad)
        ctx.stroke()
        ctx.fillStyle = "#0e0e0c"
        ctx.beginPath()
        ctx.arc(hp.x, hp.y, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = canvas.lineColor
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(hp.x, hp.y, 5, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = canvas.lineColor
        ctx.beginPath()
        ctx.arc(hp.x, hp.y, 2.25, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(750))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      blocked: addInput.activeFocus
      onCloseRequested: {
        if (addInput.activeFocus) { addInput.text = ""; root.searchResults = []; addInput.focus = false; return }
        if (root.symbolSelected) { root.symbolSelected = false; return }
        root.close()
      }
      onReturnRequested: root.refresh()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        var step = dy !== 0 ? dy : dx
        if (step === 0) return
        if (!root.symbolSelected) {
          var first = Model.firstValidIndex(root.shownQuotes)
          if (first >= 0) { root.selectedIndex = first; root.symbolSelected = true }
          return
        }
        var next = Model.nextIndex(root.selectedIndex, root.shownQuotes, step)
        if (next >= 0) root.selectedIndex = next
      }
      onActivateRequested: {
        if (root.hasSelection) root.symbolSelected = !root.symbolSelected
      }
      onDeleteRequested: {
        if (root.hasSelection && root.symbolSelected && root.selectedQuote) root.removeSymbol(root.selectedQuote.symbol)
      }
      onTextKey: function(t) {
        if (t === "/") { addInput.forceActiveFocus() }
        else if (t === "r" || t === "R") { root.refresh() }
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.space(8)

        // ---- Header: title (left), range chips (center), freshness (right).
        Item {
          width: parent.width
          height: headerTitle.implicitHeight + Style.space(8)

          MouseArea {
            anchors.fill: parent
            onPressed: { addInput.focus = false; mouse.accepted = false }
          }

          Text {
            id: headerTitle
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "Markets"
            color: root.barForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
            font.bold: true
          }

          Row {
            id: chips
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Flickable {
              id: chipsFlick
              width: Math.min(chipsRow.implicitWidth, Style.space(340))
              height: chipsRow.implicitHeight
              anchors.verticalCenter: parent.verticalCenter
              contentWidth: chipsRow.implicitWidth
              contentHeight: chipsRow.implicitHeight
              clip: true
              boundsBehavior: Flickable.StopAtBounds
              flickableDirection: Flickable.HorizontalFlick

              Row {
                id: chipsRow
                spacing: Style.space(2)

                Repeater {
                  model: Model.CHART_RANGES

                  Rectangle {
                    id: chip
                    required property string modelData
                    readonly property bool selected: modelData === root.activeRange
                    width: chipText.implicitWidth + Style.space(8)
                    height: chipText.implicitHeight + Style.space(6)
                    radius: Style.cornerRadius
                    color: chip.selected
                      ? Style.selectedFillFor(root.barForeground, Color.accent)
                      : (chipMouse.containsMouse ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent")

                    Text {
                      id: chipText
                      anchors.centerIn: parent
                      text: root.rangeLabel(chip.modelData)
                      color: chip.selected ? root.barForeground : root.mutedForeground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      font.bold: chip.selected
                    }

                    MouseArea {
                      id: chipMouse
                      anchors.fill: parent
                      hoverEnabled: true
                      cursorShape: Qt.PointingHandCursor
                      onClicked: { addInput.focus = false; root.selectRange(chip.modelData) }
                    }
                  }
                }
              }

              MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.NoButton
                onWheel: function(wheel) {
                  var nx = chipsFlick.contentX - wheel.angleDelta.y
                  chipsFlick.contentX = Math.max(0, Math.min(chipsFlick.contentWidth - chipsFlick.width, nx))
                }
              }
            }

            Item { width: Style.space(8); height: 1 }

            Rectangle {
              id: currencyChip
              readonly property bool active: root.displayCurrency !== ""
              width: currencyText.implicitWidth + Style.space(12)
              height: currencyText.implicitHeight + Style.space(6)
              radius: Style.cornerRadius
              color: currencyChip.active
                ? Style.selectedFillFor(root.barForeground, Color.accent)
                : (currencyMouse.containsMouse ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent")

              Text {
                id: currencyText
                anchors.centerIn: parent
                text: (root.displayCurrency !== "" ? root.displayCurrency : "Native") + " \u21C4"
                color: currencyChip.active ? root.barForeground : root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: currencyChip.active
              }

              MouseArea {
                id: currencyMouse
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.LeftButton | Qt.RightButton
                cursorShape: Qt.PointingHandCursor
                onClicked: function(mouse) { addInput.focus = false; root.selectCurrency(mouse.button === Qt.RightButton ? -1 : 1) }
              }
            }
          }

          Text {
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: root.freshnessText
            color: root.isStale ? root.urgentForeground : root.mutedForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        PanelSeparator { foreground: root.barForeground }

        // ---- One row per symbol: grip . SYM . name . sparkline . price . change . [x]
        //      Drag the grip (or press and hold a row) to reorder (bar ticker follows).
        Column {
          id: rowsColumn
          width: parent.width
          spacing: 0

          Repeater {
            model: root.shownQuotes

            Rectangle {
              id: row
              required property var modelData
              required property int index
              readonly property bool valid: Model.isValid(modelData)
              readonly property bool selected: index === root.selectedIndex && root.hasSelection && root.symbolSelected
              readonly property bool crypto: root.isCryptoQuote(modelData)
              readonly property var series: root.activeRange === "1d"
                ? (modelData.series || [])
                : Model.convertSeries(root.chartSeries[modelData.symbol] || [],
                    Model.rateFor(modelData.nativeCurrency || modelData.currency, root.displayCurrency, root.rates))

              // Timeframe-aware change for the row.
              readonly property real tfChange: {
                if (!row.valid) return 0
                if (root.activeRange === "1d" || row.series.length < 2) return row.modelData.change || 0
                var start = row.series[0].c
                var end = row.modelData.price
                if (!start || !end || start === 0) return 0
                return end - start
              }
              readonly property real tfChangePct: {
                if (!row.valid) return 0
                if (root.activeRange === "1d" || row.series.length < 2) return row.modelData.changePct || 0
                var start = row.series[0].c
                var end = row.modelData.price
                if (!start || !end || start === 0) return 0
                return ((end - start) / start) * 100
              }

              readonly property bool closed: row.valid && Model.marketStatus(row.modelData, root.nowTick > 0 ? root.nowTick : Date.now()) === "closed"

              width: parent.width
              height: symbolText.implicitHeight + Style.space(14)
              radius: Style.cornerRadius
              z: root.dragIndex === index ? 60 : 0
              opacity: root.dragIndex === index ? 0.92 : (row.closed ? 0.55 : 1)
              transform: Translate { y: root.rowDragShift(index) }
              color: row.selected
                ? Style.selectedFillFor(root.barForeground, Color.accent)
                : (rowMouse.containsMouse && row.valid ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent")

              Item {
                id: gripHandle
                anchors.left: parent.left
                anchors.leftMargin: Style.space(6)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(14)
                height: gripGrid.height
                visible: rowMouse.containsMouse || gripMouse.containsMouse
                opacity: gripMouse.containsMouse ? 1 : 0.6

                Grid {
                  id: gripGrid
                  anchors.centerIn: parent
                  columns: 2
                  rows: 3
                  rowSpacing: 2
                  columnSpacing: 2

                  Repeater {
                    model: 6

                    Rectangle {
                      width: 3
                      height: 3
                      radius: 1.5
                      color: gripMouse.containsMouse ? root.barForeground : root.mutedForeground
                    }
                  }
                }
              }

              Text {
                id: symbolText
                anchors.left: gripHandle.right
                anchors.leftMargin: Style.space(8)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(88)
                text: Model.displaySymbol(row.modelData.symbol) + (row.valid && root.sessionIcon(row.modelData) !== "" ? " " + root.sessionIcon(row.modelData) : "")
                elide: Text.ElideRight
                color: row.valid ? root.barForeground : root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.bold: true
              }

              MouseArea {
                id: iconMouse
                anchors.fill: symbolText
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
              }

              Text {
                anchors.left: symbolText.right
                anchors.leftMargin: Style.space(8)
                anchors.right: spark.left
                anchors.rightMargin: Style.space(24)
                anchors.verticalCenter: parent.verticalCenter
                text: row.valid ? row.modelData.name : (row.modelData.error || "No data")
                elide: Text.ElideRight
                color: root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                font.italic: !row.valid
              }

              SeriesCanvas {
                id: spark
                anchors.right: priceText.left
                anchors.rightMargin: Style.space(16)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(64)
                height: Style.space(20)
                visible: row.valid
                series: row.series
                lineColor: root.changeColor(row.tfChange)
                lineWidth: 1.25
                pad: 1.5
              }

              Text {
                id: priceText
                anchors.right: changeText.left
                anchors.rightMargin: Style.space(20)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(90)
                horizontalAlignment: Text.AlignRight
                text: row.valid ? Model.formatPrice(row.modelData.price) : ""
                color: root.barForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              Text {
                id: changeText
                anchors.right: removeBtn.left
                anchors.rightMargin: Style.space(12)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(190)
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
                text: row.valid ? Model.formatChangeValues(row.tfChange, row.tfChangePct, row.modelData.price) : ""
                color: root.changeColor(row.tfChange)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              Text {
                id: removeBtn
                anchors.right: parent.right
                anchors.rightMargin: Style.space(14)
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(16)
                horizontalAlignment: Text.AlignHCenter
                text: "\u00D7"
                color: removeMouse.containsMouse ? root.urgentForeground : (rowMouse.containsMouse ? root.mutedForeground : "transparent")
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              MouseArea {
                id: removeMouse
                anchors.fill: removeBtn
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: { var sym = row.modelData.symbol; addInput.focus = false; root.removeSymbol(sym) }
              }

              MouseArea {
                id: rowMouse
                anchors.left: parent.left
                anchors.right: removeBtn.left
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                hoverEnabled: true
                cursorShape: row.valid ? Qt.PointingHandCursor : Qt.ArrowCursor
                pressAndHoldInterval: 350
                onClicked: { var idx = row.index; addInput.focus = false; root.selectQuote(idx) }
                onPressAndHold: function(mouse) {
                  var p = mapToItem(rowsColumn, mouse.x, mouse.y)
                  root.startSymbolDrag(row.index, p.y)
                }
                onPositionChanged: function(mouse) {
                  if (root.dragIndex < 0) return
                  var p = mapToItem(rowsColumn, mouse.x, mouse.y)
                  root.updateSymbolDrag(p.y)
                }
                onReleased: { if (root.dragIndex >= 0) root.endSymbolDrag() }
              }

              // Session tooltip: anchored to the icon, only the icon hover
              // shows it (clicks fall through to the row via NoButton).
              Rectangle {
                visible: row.valid && iconMouse.containsMouse && root.sessionLabel(row.modelData) !== ""
                x: Math.max(Style.space(4), Math.min(parent.width - width - Style.space(4), symbolText.x + Math.min(symbolText.implicitWidth, symbolText.width) + Style.space(8)))
                anchors.verticalCenter: parent.verticalCenter
                width: sessTip.implicitWidth + Style.space(16)
                height: sessTip.implicitHeight + Style.space(8)
                radius: Style.cornerRadius
                color: "#121210"
                border.color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.8)
                border.width: 1

                Text {
                  id: sessTip
                  anchors.centerIn: parent
                  text: root.sessionLabel(row.modelData)
                  color: root.barForeground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              // Dedicated drag handle: press starts a drag immediately (no
              // hold delay). A plain click is a no-op (from === to).
              MouseArea {
                id: gripMouse
                anchors.fill: gripHandle
                anchors.margins: -4
                hoverEnabled: true
                cursorShape: Qt.OpenHandCursor
                onPressed: function(mouse) {
                  if (root.dragIndex >= 0) return
                  var p = mapToItem(rowsColumn, mouse.x, mouse.y)
                  root.startSymbolDrag(row.index, p.y)
                }
                onPositionChanged: function(mouse) {
                  if (root.dragIndex < 0) return
                  var p = mapToItem(rowsColumn, mouse.x, mouse.y)
                  root.updateSymbolDrag(p.y)
                }
                onReleased: { if (root.dragIndex >= 0) root.endSymbolDrag() }
              }
            }
          }
        }

        Text {
          visible: root.loading
          leftPadding: Style.space(8)
          text: "Fetching quotes\u2026"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.italic: true
        }

        Text {
          visible: root.symbols.length === 0
          width: parent.width
          horizontalAlignment: Text.AlignHCenter
          topPadding: Style.space(16)
          bottomPadding: Style.space(16)
          text: "Add a symbol to get started"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          font.italic: true
        }

        // ---- Add symbol input with search dropdown.
        Item {
          width: parent.width
          height: Math.max(addInput.implicitHeight, addLabel.implicitHeight) + Style.space(4)

          Text {
            id: addLabel
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            text: "+"
            color: root.mutedForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.subtitle
          }

          TextInput {
            id: addInput
            anchors.left: addLabel.right
            anchors.leftMargin: Style.space(6)
            anchors.right: parent.right
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            clip: true
            color: root.barForeground
            selectionColor: Color.accent
            selectedTextColor: root.barForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            inputMethodHints: Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
            Keys.onPressed: function(event) {
              if (event.key === Qt.Key_Escape) {
                text = ""; root.searchResults = []; root.yahooSearchResults = []; root.coinSearchResults = []
                focus = false; event.accepted = true
              }
            }
            onActiveFocusChanged: if (activeFocus) root.symbolSelected = false; else { text = ""; root.searchResults = []; root.yahooSearchResults = []; root.coinSearchResults = []; searchDebounce.stop(); coinSearchDebounce.stop() }
            onTextChanged: {
              if (text.length > 0) { searchDebounce.restart(); coinSearchDebounce.restart() }
              else { root.searchResults = []; root.yahooSearchResults = []; root.coinSearchResults = []; searchDebounce.stop(); coinSearchDebounce.stop() }
            }
            onAccepted: {
              if (root.searchResults.length > 0) {
                root.addSymbol(root.searchResults[0].symbol)
              } else {
                root.addSymbol(text)
              }
            }

            Text {
              visible: !parent.text
              text: "Add symbol\u2026"
              color: root.mutedForeground
              font: parent.font
            }
          }
        }

        // ---- Search results dropdown (max 5 visible, scrollable).
        ListView {
          id: searchListView
          visible: root.searchResults.length > 0
          width: parent.width
          height: Math.min(contentHeight, Style.space(30) * 5)
          clip: true
          model: root.searchResults
          spacing: 0
          boundsBehavior: Flickable.StopAtBounds

          delegate: Rectangle {
            id: searchRow
            required property var modelData
            required property int index
            width: searchListView.width
            height: searchRowLabel.implicitHeight + Style.space(10)
            radius: Style.cornerRadius
            color: searchRowMouse.containsMouse ? Style.hoverFillFor(root.barForeground, Color.accent) : "transparent"

            Text {
              id: searchRowLabel
              anchors.left: parent.left
              anchors.leftMargin: Style.space(24)
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(64)
              text: Model.displaySymbol(searchRow.modelData.symbol)
              elide: Text.ElideRight
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            Text {
              anchors.left: searchRowLabel.right
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              text: searchRow.modelData.name + (searchRow.modelData.exchange ? " \u00B7 " + searchRow.modelData.exchange : "")
              elide: Text.ElideRight
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            MouseArea {
              id: searchRowMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: {
                var sym = searchRow.modelData.symbol
                root.addSymbol(sym)
                try { addInput.focus = false } catch (e) { console.log("[mk] defocus skipped (delegate torn down): " + e) }
              }
            }
          }
        }

        Text {
          visible: root.searchResults.length > 5
          leftPadding: Style.space(24)
          text: (root.searchResults.length - 5) + " more result" + (root.searchResults.length - 5 === 1 ? "" : "s") + "\u2026"
          color: root.mutedForeground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.italic: true
        }

        PanelSeparator {
          visible: root.hasSelection && root.symbolSelected
          foreground: root.barForeground
        }

        // ---- Detail block for the selected symbol.
        Column {
          id: detail
          visible: root.hasSelection && root.symbolSelected
          width: parent.width
          spacing: Style.space(8)

          readonly property var quote: root.selectedQuote
          readonly property bool isCrypto: root.isCryptoQuote(detail.quote)
          readonly property var series: root.hasSelection && root.symbolSelected ? root.seriesFor(root.selectedQuote) : []
          readonly property var bounds: Model.seriesBounds(series)
          readonly property real statLabelWidth: Style.space(84)
          readonly property real statValueWidth: (width - Style.space(16)) / 2 - statLabelWidth

          // Timeframe-aware change: for 1D use daily change, for others use series start.
          readonly property real tfChange: {
            if (!detail.quote || !Model.isValid(detail.quote)) return 0
            if (root.activeRange === "1d" || detail.series.length < 2) {
              return detail.quote.change || 0
            }
            var startPrice = detail.series[0].c
            var endPrice = detail.quote.price
            if (!startPrice || !endPrice || startPrice === 0) return 0
            return endPrice - startPrice
          }
          readonly property real tfChangePct: {
            if (!detail.quote || !Model.isValid(detail.quote)) return 0
            if (root.activeRange === "1d" || detail.series.length < 2) {
              return detail.quote.changePct || 0
            }
            var startPrice = detail.series[0].c
            var endPrice = detail.quote.price
            if (!startPrice || !endPrice || startPrice === 0) return 0
            return ((endPrice - startPrice) / startPrice) * 100
          }

          Item {
            width: parent.width
            height: Math.max(nameColumn.implicitHeight, priceColumn.implicitHeight)

            Column {
              id: nameColumn
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.right: priceColumn.left
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                width: parent.width
                text: detail.quote ? (detail.quote.name || Model.displaySymbol(detail.quote.symbol)) : ""
                elide: Text.ElideRight
                color: root.barForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
              }
              Text {
                width: parent.width
                text: detail.quote
                  ? [Model.displaySymbol(detail.quote.symbol), root.sourceLabel(detail.quote), root.currencyLabel(detail.quote), root.sessionBadge(detail.quote)].filter(function(p) { return !!p }).join(" \u00B7 ")
                  : ""
                elide: Text.ElideRight
                color: root.mutedForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }

            Column {
              id: priceColumn
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              spacing: 0

              Text {
                anchors.right: parent.right
                text: detail.quote ? Model.formatPrice(detail.quote.price) : ""
                color: root.barForeground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
                font.bold: true
              }
              Text {
                anchors.right: parent.right
                text: (detail.quote && Model.isValid(detail.quote))
                  ? Model.formatChangeValues(detail.tfChange, detail.tfChangePct, detail.quote.price) : ""
                color: root.changeColor(detail.tfChange)
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }
            }
          }

          Item {
            width: parent.width
            height: highLabel.implicitHeight
            Text {
              id: openLabel
              anchors.left: parent.left
              anchors.leftMargin: Style.space(10)
              text: {
                if (detail.series.length >= 2) return "Open " + Model.formatPrice(detail.series[0].c)
                if (detail.quote && Model.isValid(detail.quote) && detail.quote.open !== null && detail.quote.open !== undefined) return "Open " + Model.formatPrice(detail.quote.open)
                return ""
              }
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              id: highLabel
              anchors.right: parent.right
              anchors.rightMargin: Style.space(10)
              text: detail.bounds ? "Range " + Model.formatPrice(detail.bounds.min) + " \u2013 " + Model.formatPrice(detail.bounds.max) : ""
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }

          Item {
            id: chartBox
            width: parent.width
            height: Style.space(112)
            property int hoverIndex: -1
            property real hoverX: 0
            property real hoverY: 0
            readonly property var hoverPoint: hoverIndex >= 0 && hoverIndex < detail.series.length ? detail.series[hoverIndex] : null

            function updateHover(mx) {
              var s = detail.series
              if (!s || s.length < 2 || bigChart.width <= bigChart.pad * 2) { chartBox.hoverIndex = -1; return }
              var t0 = s[0].t
              var t1 = s[s.length - 1].t
              var frac = (mx - bigChart.pad) / (bigChart.width - bigChart.pad * 2)
              frac = Math.max(0, Math.min(1, frac))
              var target = t0 + frac * (t1 - t0)
              var best = 0
              var bd = Math.abs(s[0].t - target)
              for (var i = 1; i < s.length; i++) {
                var d = Math.abs(s[i].t - target)
                if (d < bd) { bd = d; best = i }
              }
              chartBox.hoverIndex = best
              var pts = Model.seriesPoints(s, bigChart.width, bigChart.height, bigChart.pad)
              if (pts.length === s.length) {
                chartBox.hoverX = pts[best].x
                chartBox.hoverY = pts[best].y
              }
            }

            SeriesCanvas {
              id: bigChart
              anchors.fill: parent
              anchors.leftMargin: Style.space(8)
              anchors.rightMargin: Style.space(8)
              series: detail.series
              lineColor: root.changeColor(detail.tfChange)
              mutedColor: root.mutedForeground
              lineWidth: 1.75
              pad: 4
              fill: true
              referenceValue: root.activeRange === "1d" && detail.quote && !detail.isCrypto && detail.quote.prevClose ? detail.quote.prevClose : (detail.series.length >= 2 ? detail.series[0].c : null)
              referenceLabel: ""
              showAxisLabels: false
              hoverIndex: chartBox.hoverIndex
            }

            MouseArea {
              anchors.fill: bigChart
              hoverEnabled: true
              acceptedButtons: Qt.NoButton
              onPositionChanged: function(mouse) { chartBox.updateHover(mouse.x) }
              onExited: chartBox.hoverIndex = -1
            }

            Rectangle {
              visible: chartBox.hoverPoint !== null
              opacity: 1
              x: {
                var tx = bigChart.x + chartBox.hoverX + Style.space(10)
                if (tx + width + Style.space(8) > chartBox.width) tx = bigChart.x + chartBox.hoverX - width - Style.space(10)
                return tx
              }
              y: Math.max(0, Math.min(chartBox.height - height, bigChart.y + chartBox.hoverY - height - Style.space(6)))
              width: tipCol.implicitWidth + Style.space(16)
              height: tipCol.implicitHeight + Style.space(10)
              radius: Style.cornerRadius
              color: "#121210"
              border.color: Qt.rgba(root.barForeground.r, root.barForeground.g, root.barForeground.b, 0.8)
              border.width: 1

              Column {
                id: tipCol
                anchors.centerIn: parent
                spacing: 2
                Text {
                  anchors.horizontalCenter: parent.horizontalCenter
                  text: chartBox.hoverPoint ? Model.formatPrice(chartBox.hoverPoint.c) : ""
                  color: root.barForeground
                  opacity: 1
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  font.bold: true
                }
              }
            }

            Text {
              anchors.centerIn: parent
              visible: detail.series.length < 2
              text: root.chartLoading ? "Loading chart\u2026" : "No chart data"
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.italic: true
            }
          }

          Item {
            id: xAxis
            width: parent.width
            height: firstStamp.implicitHeight
            visible: detail.series.length >= 2

            Text {
              id: firstStamp
              anchors.left: parent.left
              anchors.leftMargin: Style.space(10)
              text: detail.series.length ? root.formatStamp(detail.series[0].t, root.activeRange) : ""
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              id: midStamp
              anchors.horizontalCenter: parent.horizontalCenter
              visible: chartBox.hoverPoint === null
              text: detail.series.length >= 3 ? root.formatStamp(detail.series[Math.floor(detail.series.length / 2)].t, root.activeRange) : ""
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              anchors.right: parent.right
              anchors.rightMargin: Style.space(10)
              text: detail.series.length ? root.formatStamp(detail.series[detail.series.length - 1].t, root.activeRange) : ""
              color: root.mutedForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
            Text {
              visible: chartBox.hoverPoint !== null
              text: chartBox.hoverPoint ? root.formatStamp(chartBox.hoverPoint.t, root.activeRange) : ""
              x: {
                var hw = width
                var cx = Style.space(8) + chartBox.hoverX - hw / 2
                return Math.max(Style.space(10), Math.min(xAxis.width - hw - Style.space(10), cx))
              }
              color: root.barForeground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          // ---- Stats grid: different entries for stocks vs crypto.
          Grid {
            id: stats
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            columns: 4
            columnSpacing: 0
            rowSpacing: Style.space(4)

            readonly property var entries: {
              if (!detail.quote) return []
              if (detail.isCrypto) {
                return [
                  ["24h range", detail.quote.low24h !== null && detail.quote.low24h !== undefined && detail.quote.high24h !== null && detail.quote.high24h !== undefined
                    ? Model.formatPrice(detail.quote.low24h) + " \u2013 " + Model.formatPrice(detail.quote.high24h) : ""],
                  ["Volume", Model.formatVolume(detail.quote.totalVolume)],
                  ["Market cap", Model.formatMarketCap(detail.quote.marketCap)],
                  ["Supply", Model.formatSupply(detail.quote.circulatingSupply, detail.quote.symbol)],
                  ["Day range", detail.quote.dayLow !== null && detail.quote.dayHigh !== null
                    ? Model.formatPrice(detail.quote.dayLow) + " \u2013 " + Model.formatPrice(detail.quote.dayHigh) : ""],
                  ["Last trade", detail.quote.marketTime !== null ? Qt.formatDateTime(new Date(detail.quote.marketTime * 1000), "ddd HH:mm") : ""]
                ]
              }
              return [
                ["Prev close", Model.formatPrice(detail.quote.prevClose)],
                ["Open", Model.formatPrice(detail.quote.open)],
                ["Day range", detail.quote.dayLow !== null && detail.quote.dayHigh !== null
                  ? Model.formatPrice(detail.quote.dayLow) + " \u2013 " + Model.formatPrice(detail.quote.dayHigh) : ""],
                ["52w range", detail.quote.week52Low !== null && detail.quote.week52High !== null
                  ? Model.formatPrice(detail.quote.week52Low) + " \u2013 " + Model.formatPrice(detail.quote.week52High) : ""],
                ["Volume", Model.formatVolume(detail.quote.volume)],
                ["Last trade", detail.quote.marketTime !== null ? Qt.formatDateTime(new Date(detail.quote.marketTime * 1000), "ddd HH:mm") : ""]
              ]
            }

            Repeater {
              model: stats.entries.length * 2

              Text {
                required property int index
                readonly property bool isLabel: index % 2 === 0
                readonly property var entry: stats.entries[Math.floor(index / 2)]
                width: isLabel ? detail.statLabelWidth : detail.statValueWidth
                text: entry ? (isLabel ? entry[0] : (entry[1] || "\u2014")) : ""
                elide: Text.ElideRight
                color: isLabel ? root.mutedForeground : root.barForeground
                font.family: root.fontFamily
                font.pixelSize: isLabel ? Style.font.caption : Style.font.bodySmall
              }
            }
          }

          Text {
            id: yahooLink
            leftPadding: Style.space(8)
            text: detail.quote ? root.sourcePageLabel(detail.quote) : ""
            color: linkMouse.containsMouse ? root.barForeground : root.mutedForeground
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            font.underline: linkMouse.containsMouse

            MouseArea {
              id: linkMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: { addInput.focus = false; root.openSourcePage(detail.quote) }
            }
          }
        }

      }
    }
  }
}
