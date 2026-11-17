import AppKit
import Darwin
import Foundation

private let usage = """
CCUH Focus Probe — a local dummy input window for Computer Use experiments.

Build:
  swiftc lab/FocusProbe.swift -o /private/tmp/ccuh-focus-probe
Run manually:
  /private/tmp/ccuh-focus-probe [--run-id ID] [--observe-only | --sample-state]

Enter test text only (테스트 문자열만 입력). JSONL events go to stdout.
The probe records its own editor text/selection and key-window/focus events.
For other apps it records only whether this probe is frontmost; it does not
record their names, windows, text, keystrokes, or screenshots. No files are saved.

Workspace Space-change notifications are counted when delivered. They do not
provide Space IDs, direction, or the cause of a switch. Zero received events do
not prove there were no changes; notification delivery must be verified in the
test environment. This tool never restores focus automatically.

With --observe-only, no application or window is created. Only workspace
foreground-change and Space-change events are logged, without app identities,
window titles, text, keystrokes, or screenshots. Stop with Ctrl+C.

The window has an explicit Toggle Full Screen test button. Nothing toggles
automatically. --sample-state adds one-second samples of this probe's own
editor text/selection, key-window, minimized/fullscreen, and foreground state.
Prepare Foreground Caret explicitly activates only this dummy window and puts
its caret at the end. It is a test-setup action, never automatic recovery.

Options:
  --run-id ID  Correlate events with a test run (maximum 128 characters).
  --observe-only  Observe workspace change events without creating a window.
  --sample-state  Sample only this dummy window's state each second (opt-in).
  --help, -h   Print this help without creating an application or window.
"""

private struct ProbeOptions {
    let runID: String
    let observeOnly: Bool
    let sampleState: Bool
}

private func parseOptions() -> ProbeOptions {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.contains("--help") || arguments.contains("-h") {
        print(usage)
        exit(0)
    }
    var runID = UUID().uuidString.lowercased()
    var observeOnly = false
    var sampleState = false
    var index = 0
    while index < arguments.count {
        switch arguments[index] {
        case "--observe-only":
            observeOnly = true
            index += 1
        case "--sample-state":
            sampleState = true
            index += 1
        case "--run-id":
            guard index + 1 < arguments.count,
                  !arguments[index + 1].isEmpty,
                  arguments[index + 1].count <= 128 else {
                FileHandle.standardError.write(Data((usage + "\nInvalid run ID.\n").utf8))
                exit(64)
            }
            runID = arguments[index + 1]
            index += 2
        default:
            FileHandle.standardError.write(Data((usage + "\nInvalid arguments.\n").utf8))
            exit(64)
        }
    }
    if observeOnly && sampleState {
        FileHandle.standardError.write(Data("--sample-state requires the dummy input window; omit --observe-only.\n".utf8))
        exit(64)
    }
    return ProbeOptions(runID: runID, observeOnly: observeOnly, sampleState: sampleState)
}

private final class EventLog {
    private let runID: String
    private var sequence = 0
    private let formatter = ISO8601DateFormatter()

    init(runID: String) {
        self.runID = runID
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    func write(_ event: String, _ fields: [String: Any] = [:]) {
        sequence += 1
        var payload: [String: Any] = [
            "source": "ccuh-focus-probe",
            "run_id": runID,
            "seq": sequence,
            "event": event,
            "timestamp_utc": formatter.string(from: Date()),
            "monotonic_ns": DispatchTime.now().uptimeNanoseconds,
        ]
        for (key, value) in fields {
            payload[key] = value
        }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            FileHandle.standardError.write(Data("Focus Probe could not encode an event.\n".utf8))
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

@MainActor
private final class ProbeTextView: NSTextView {
    var onFocusChanged: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted {
            onFocusChanged?(true)
        }
        return accepted
    }

    override func resignFirstResponder() -> Bool {
        let accepted = super.resignFirstResponder()
        if accepted {
            onFocusChanged?(false)
        }
        return accepted
    }
}

@MainActor
private final class FocusProbeDelegate: NSObject, NSApplicationDelegate, NSTextViewDelegate, NSWindowDelegate {
    private let log: EventLog
    private var window: NSWindow!
    private var editor: ProbeTextView!
    private var keyLossCount = 0
    private var foregroundLossCount = 0
    private var spaceChangeCount = 0
    private var previousFrontmost: Bool?
    private let sampleState: Bool
    private var sampleTimer: Timer?

    init(log: EventLog, sampleState: Bool) {
        self.log = log
        self.sampleState = sampleState
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        log.write("session_started", [
            "scope": "own_dummy_input_only",
            "space_detection": "change_events_only",
            "space_identity": "not_available",
            "space_causality": "not_inferred",
            "workspace_notification_delivery": "unverified",
            "counts_are": "received_notifications_only",
            "zero_count_proves_no_changes": false,
            "other_app_identity": "not_recorded",
            "automatic_focus_restore": false,
            "periodic_own_state_samples": sampleState,
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 660, height: 380),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "CCUH Focus Probe"
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.center()

        let content = NSView()
        let instruction = NSTextField(wrappingLabelWithString:
            "테스트 문자열만 입력하세요. 다른 앱·탭·Space로 이동해도 이 창은 포커스를 되찾지 않습니다. " +
            "Enter test text only. Focus and text events are written to stdout; Space changes need separate observation."
        )
        instruction.translatesAutoresizingMaskIntoConstraints = false

        let fullScreenButton = NSButton(
            title: "Toggle Full Screen", target: self, action: #selector(toggleOwnFullScreen(_:))
        )
        fullScreenButton.setAccessibilityLabel("Toggle Full Screen")
        fullScreenButton.translatesAutoresizingMaskIntoConstraints = false
        let prepareCaretButton = NSButton(
            title: "Prepare Foreground Caret", target: self, action: #selector(prepareForegroundCaret(_:))
        )
        prepareCaretButton.setAccessibilityLabel("Prepare Foreground Caret")
        prepareCaretButton.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        editor = ProbeTextView(frame: NSRect(x: 0, y: 0, width: 620, height: 260))
        editor.setAccessibilityLabel("CCUH Test Input")
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.isGrammarCheckingEnabled = false
        editor.font = NSFont.monospacedSystemFont(ofSize: 16, weight: .regular)
        editor.textContainerInset = NSSize(width: 10, height: 10)
        editor.minSize = NSSize(width: 0, height: 260)
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.textContainer?.widthTracksTextView = true
        editor.delegate = self
        editor.onFocusChanged = { [weak self] focused in
            guard let self = self else { return }
            self.log.write("editor_focus_changed", [
                "focused": focused,
                "probe_key_window": self.window.isKeyWindow,
            ])
        }
        scroll.documentView = editor
        content.addSubview(instruction)
        content.addSubview(fullScreenButton)
        content.addSubview(prepareCaretButton)
        content.addSubview(scroll)
        NSLayoutConstraint.activate([
            instruction.topAnchor.constraint(equalTo: content.topAnchor, constant: 16),
            instruction.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            instruction.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            fullScreenButton.topAnchor.constraint(equalTo: instruction.bottomAnchor, constant: 10),
            fullScreenButton.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            prepareCaretButton.centerYAnchor.constraint(equalTo: fullScreenButton.centerYAnchor),
            prepareCaretButton.leadingAnchor.constraint(equalTo: fullScreenButton.trailingAnchor, constant: 12),
            prepareCaretButton.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -16),
            scroll.topAnchor.constraint(equalTo: fullScreenButton.bottomAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            scroll.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            scroll.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
        ])
        window.contentView = content

        NotificationCenter.default.addObserver(
            self, selector: #selector(windowBecameKey(_:)),
            name: NSWindow.didBecomeKeyNotification, object: window
        )
        NotificationCenter.default.addObserver(
            self, selector: #selector(windowResignedKey(_:)),
            name: NSWindow.didResignKeyNotification, object: window
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(foregroundApplicationChanged(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil
        )
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(activeSpaceChanged(_:)),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil
        )

        // Show only our own window; do not request app activation or a key-window change.
        window.orderFront(nil)
        recordForegroundState("initial_foreground_state")
        log.write("window_ready", ["focus_manually": true])
        if sampleState {
            let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.recordOwnStateSample()
                }
            }
            sampleTimer = timer
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    @objc private func toggleOwnFullScreen(_ sender: Any?) {
        log.write("fullscreen_toggle_requested")
        window.toggleFullScreen(sender)
    }

    @objc private func prepareForegroundCaret(_ sender: Any?) {
        log.write("foreground_caret_setup_requested", ["scope": "explicit_dummy_window_setup"])
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        recordOwnStateSample()
    }

    func windowWillEnterFullScreen(_ notification: Notification) {
        log.write("will_enter_fullscreen")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        log.write("did_enter_fullscreen")
    }

    func windowWillExitFullScreen(_ notification: Notification) {
        log.write("will_exit_fullscreen")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        log.write("did_exit_fullscreen")
    }

    @objc private func windowBecameKey(_ notification: Notification) {
        log.write("window_became_key", ["key_loss_count": keyLossCount])
    }

    @objc private func windowResignedKey(_ notification: Notification) {
        keyLossCount += 1
        log.write("window_resigned_key", ["key_loss_count": keyLossCount])
    }

    @objc private func foregroundApplicationChanged(_ notification: Notification) {
        recordForegroundState("foreground_application_changed")
    }

    @objc private func activeSpaceChanged(_ notification: Notification) {
        spaceChangeCount += 1
        log.write("space_changed", [
            "space_change_count": spaceChangeCount,
            "space_identity": "not_available",
            "cause": "not_inferred",
        ])
    }

    private func recordForegroundState(_ event: String) {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            log.write(event, ["probe_is_frontmost": NSNull(), "observation_available": false])
            return
        }
        let isProbe = app.processIdentifier == ProcessInfo.processInfo.processIdentifier
        if previousFrontmost == true && !isProbe {
            foregroundLossCount += 1
        }
        previousFrontmost = isProbe
        log.write(event, [
            "probe_is_frontmost": isProbe,
            "observation_available": true,
            "foreground_loss_count": foregroundLossCount,
        ])
    }

    private func ownEditorState() -> [String: Any] {
        return [
            "text": editor.string,
            "text_utf16_length": editor.string.utf16.count,
            "selection_utf16": editor.selectedRanges.map { value in
                let range = value.rangeValue
                return ["location": range.location, "length": range.length]
            },
        ]
    }

    private func recordOwnStateSample() {
        var fields = ownEditorState()
        fields["probe_key_window"] = window.isKeyWindow
        fields["probe_window_minimized"] = window.isMiniaturized
        fields["probe_window_fullscreen"] = window.styleMask.contains(.fullScreen)
        fields["editor_is_first_responder"] = window.firstResponder === editor
        if let frontmost = NSWorkspace.shared.frontmostApplication {
            fields["foreground_observation_available"] = true
            fields["probe_is_frontmost"] = frontmost.processIdentifier == ProcessInfo.processInfo.processIdentifier
        } else {
            fields["foreground_observation_available"] = false
            fields["probe_is_frontmost"] = NSNull()
        }
        log.write("own_state_sample", fields)
    }

    func textDidChange(_ notification: Notification) {
        log.write("text_changed", ownEditorState())
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        log.write("selection_changed", ownEditorState())
    }

    func windowWillClose(_ notification: Notification) {
        log.write("window_closed", [
            "key_loss_count": keyLossCount,
            "foreground_loss_count": foregroundLossCount,
            "space_change_count": spaceChangeCount,
        ])
        NSApplication.shared.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        sampleTimer?.invalidate()
        sampleTimer = nil
        NotificationCenter.default.removeObserver(self)
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        log.write("session_ended", [
            "key_loss_count": keyLossCount,
            "foreground_loss_count": foregroundLossCount,
            "space_change_count": spaceChangeCount,
        ])
    }
}

@MainActor
private final class WorkspaceEventProbe: NSObject {
    private let log: EventLog
    private var activationEventCount = 0
    private var activationChangeCount = 0
    private var unavailableObservationCount = 0
    private var spaceChangeCount = 0
    private var anchorPID: pid_t?
    private var previousForegroundPID: pid_t?

    init(log: EventLog) {
        self.log = log
        super.init()
    }

    func start() {
        let initialPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        anchorPID = initialPID
        previousForegroundPID = initialPID
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            self, selector: #selector(foregroundChanged(_:)),
            name: NSWorkspace.didActivateApplicationNotification, object: nil
        )
        center.addObserver(
            self, selector: #selector(spaceChanged(_:)),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil
        )
        log.write("observer_started", [
            "mode": "observe_only",
            "scope": "workspace_change_events_only",
            "application_created": false,
            "window_created": false,
            "app_identity": "not_recorded",
            "text_collection": false,
            "screenshot_collection": false,
            "space_detection": "change_events_only",
            "space_identity": "not_available",
            "space_causality": "not_inferred",
            "workspace_notification_delivery": "unverified",
            "counts_are": "received_notifications_only",
            "zero_count_proves_no_changes": false,
        ])
        recordForeground("initial_foreground_state")
    }

    @objc private func foregroundChanged(_ notification: Notification) {
        activationEventCount += 1
        recordForeground("foreground_application_changed")
    }

    private func recordForeground(_ event: String) {
        let currentPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if let current = currentPID {
            if let previous = previousForegroundPID, previous != current {
                activationChangeCount += 1
            }
            previousForegroundPID = current
        } else {
            unavailableObservationCount += 1
        }
        var fields: [String: Any] = [
            "observation_available": currentPID != nil,
            "anchor_available": anchorPID != nil,
            "activation_event_count": activationEventCount,
            "activation_change_count": activationChangeCount,
            "unavailable_observation_count": unavailableObservationCount,
        ]
        if let anchor = anchorPID, let current = currentPID {
            fields["anchor_foreground_unchanged"] = anchor == current
        } else {
            fields["anchor_foreground_unchanged"] = NSNull()
        }
        log.write(event, fields)
    }

    @objc private func spaceChanged(_ notification: Notification) {
        spaceChangeCount += 1
        log.write("space_changed", [
            "space_change_count": spaceChangeCount,
            "space_identity": "not_available",
            "cause": "not_inferred",
        ])
    }

    func stop() {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        log.write("observer_stopped", [
            "activation_event_count": activationEventCount,
            "activation_change_count": activationChangeCount,
            "unavailable_observation_count": unavailableObservationCount,
            "space_change_count": spaceChangeCount,
            "workspace_notification_delivery": "unverified",
            "counts_are": "received_notifications_only",
            "zero_count_proves_no_changes": false,
        ])
    }
}

@MainActor
private func observeWorkspace(log: EventLog) {
    let observer = WorkspaceEventProbe(log: log)
    observer.start()
    var signalSources: [DispatchSourceSignal] = []
    for signalNumber in [SIGINT, SIGTERM] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler {
            MainActor.assumeIsolated {
                observer.stop()
                exit(0)
            }
        }
        source.resume()
        signalSources.append(source)
    }
    // Keep the main run loop alive to receive NSWorkspace notifications, without NSApplication.
    let keepAlive = Timer(timeInterval: 3600, repeats: true) { _ in }
    RunLoop.current.add(keepAlive, forMode: .default)
    withExtendedLifetime((observer, signalSources, keepAlive)) {
        RunLoop.current.run()
    }
}

private let options = parseOptions()
MainActor.assumeIsolated {
    let eventLog = EventLog(runID: options.runID)
    if options.observeOnly {
        observeWorkspace(log: eventLog)
        return
    }
    let application = NSApplication.shared
    let delegate = FocusProbeDelegate(log: eventLog, sampleState: options.sampleState)
    application.setActivationPolicy(.regular)
    application.delegate = delegate
    withExtendedLifetime(delegate) {
        application.run()
    }
}
