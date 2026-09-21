import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar entry for the Markets widget: a fixed-width ticker tape that scrolls the
// panel's quotes right-to-left. Panel plumbing follows omarchy.weather /
// omarchy.clock so `omarchy-shell shell summon|hide|toggle
// mn.markets` route here through the bar's open/close/opened
// contract.
BarWidget {
  id: root
  moduleName: "mn.markets"

  // ---- Settings (inline on this widget's shell.json entry).
  readonly property int tickerWidth: Model.tickerWidth(setting("tickerWidth", 180))
  readonly property real scrollSpeed: Model.scrollSpeed(setting("scrollSpeed", 20))

  property bool pausedByUser: false

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function togglePause() {
    pausedByUser = !pausedByUser
  }

  // Shape contract for shell.summon/hide/toggle routing (the bar requires
  // open/close/opened on the bar-widget root).
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity (Bar.requestPopout prefers closeForPopoutSwitch over close).
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  readonly property var tapeItems: panelLoader.item ? panelLoader.item.tapeItems : []
  readonly property color upColor: panelLoader.item ? panelLoader.item.upColor : button.foreground
  readonly property color downColor: panelLoader.item ? panelLoader.item.downColor : button.activeColor
  readonly property bool hasTape: !root.vertical && tapeItems.length > 0
  readonly property bool quoteStale: panelLoader.item ? panelLoader.item.isStale === true : false
  // What the plain label shows when the tape has nothing: stacked SYM/arrow
  // on vertical bars, "AAPL …" / "AAPL !" otherwise.
  readonly property string fallbackText: panelLoader.item
    ? (root.vertical ? panelLoader.item.verticalText : panelLoader.item.label)
    : ""

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "mn.markets"

    function refresh(): void { root.broadcast("refresh") }
    function pause(): void { root.broadcast("togglePause") }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  // One pass over every item: colored quote text, neutral separator.
  component TapeRun: Row {
    spacing: 0
    Repeater {
      model: root.tapeItems

      Row {
        required property var modelData
        spacing: 0

        Text {
          text: modelData.text
          color: modelData.down ? root.downColor : (modelData.up ? root.upColor : button.foreground)
          opacity: modelData.closed ? 0.55 : 1.0
          font.family: button.fontFamily
          font.pixelSize: button.fontSize
          renderType: Text.NativeRendering
        }
        Text {
          text: tape.separator
          color: Qt.darker(button.foreground, 1.6)
          font.family: button.fontFamily
          font.pixelSize: button.fontSize
          renderType: Text.NativeRendering
        }
      }
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.fallbackText
    labelVisible: !root.hasTape
    hasVisualContent: true
    fixedWidth: root.hasTape ? root.tickerWidth : -1
    // The panel is the detail view, so no tooltip (as with omarchy.weather).
    tooltipText: ""

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      else if (b === Qt.RightButton) root.togglePause()
      else root.togglePanel()
    }

    // ---- Tape viewport: a run of every item, repeated enough times to cover
    //      the viewport plus one extra run, animated left by exactly one run
    //      width so the loop is seamless.
    Item {
      id: tape
      visible: root.hasTape
      anchors.fill: parent
      anchors.leftMargin: Style.space(6)
      anchors.rightMargin: Style.space(6)
      clip: true
      opacity: root.quoteStale ? 0.55 : 1.0

      readonly property string separator: "  •  "
      readonly property real runWidth: measure.implicitWidth
      readonly property int copies: runWidth > 0 ? Math.max(2, Math.ceil(width / runWidth) + 1) : 2
      readonly property bool scrolling: root.hasTape && root.scrollSpeed > 0 && runWidth > 0
        && !root.pausedByUser && !button.tooltipHovered
      property real offset: 0

      // Invisible single run used only to measure one loop's width.
      TapeRun {
        id: measure
        visible: false
      }

      Row {
        id: strip
        x: -tape.offset
        anchors.verticalCenter: parent.verticalCenter
        spacing: 0

        Repeater {
          model: tape.copies
          TapeRun {}
        }
      }

      // Advances by elapsed time so hover/pause resumes exactly where it
      // stopped, and the modulo keeps a changing run width seamless.
      FrameAnimation {
        running: tape.scrolling
        onTriggered: {
          if (tape.runWidth <= 0) return
          tape.offset = (tape.offset + frameTime * root.scrollSpeed) % tape.runWidth
        }
      }
    }
  }
}
