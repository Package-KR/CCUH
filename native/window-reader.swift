import AppKit
import ApplicationServices
import Darwin
import Foundation

@MainActor
final class NativeWindowAccess: WindowAccess {
    typealias Reference = AXUIElement

    let bundleID: String
    let originalApplication: NSRunningApplication
    let processID: pid_t
    let launchDate: Date?
    let applicationElement: AXUIElement
    private(set) var inventoryComplete = false
    private let messagingTimeout: Float = 0.3

    init(bundleID: String) throws {
        guard AXIsProcessTrusted() else { throw WindowReadFailure("permission_required") }
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard !applications.isEmpty else { throw WindowReadFailure("app_not_running") }
        guard applications.count == 1 else { throw WindowReadFailure("app_ambiguous") }
        self.bundleID = bundleID
        originalApplication = applications[0]
        processID = applications[0].processIdentifier
        launchDate = applications[0].launchDate
        applicationElement = AXUIElementCreateApplication(processID)
    }

    func validateApplication(deadline: TimeInterval) throws {
        try checkDeadline(deadline)
        guard AXIsProcessTrusted() else { throw WindowReadFailure("permission_required") }
        // AppKit refreshes varying application properties on a main-run-loop turn.
        _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.001))
        try checkDeadline(deadline)
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard !applications.isEmpty else {
            throw WindowReadFailure("app_not_running", invalidatesApplication: true)
        }
        guard applications.count == 1 else { throw WindowReadFailure("app_ambiguous") }
        let current = applications[0]
        // PID is diagnostic metadata. NSRunningApplication equality identifies the instance.
        guard current.isEqual(originalApplication), current.processIdentifier == processID else {
            throw WindowReadFailure("app_instance_changed", invalidatesApplication: true)
        }
        if let launchDate {
            guard let currentLaunchDate = current.launchDate else {
                throw WindowReadFailure("app_identity_unavailable")
            }
            guard launchDate == currentLaunchDate else {
                throw WindowReadFailure("app_instance_changed", invalidatesApplication: true)
            }
        }
    }

    func windows(deadline: TimeInterval) throws -> [AXUIElement] {
        inventoryComplete = false
        try setTimeout(applicationElement, deadline: deadline, application: true)
        let value = try read(applicationElement, kAXWindowsAttribute, deadline: deadline, application: true)
        guard let value, CFGetTypeID(value) == CFArrayGetTypeID(), let elements = value as? [AnyObject] else {
            throw WindowReadFailure("invalid_window_list")
        }
        var result: [AXUIElement] = []
        for item in elements {
            let value = item as CFTypeRef
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
                throw WindowReadFailure("invalid_window_list")
            }
            result.append(unsafeDowncast(value, to: AXUIElement.self))
        }
        if result.isEmpty {
            do {
                let main = try read(applicationElement, kAXMainWindowAttribute,
                                    deadline: deadline, application: true)
                if let main, CFGetTypeID(main) == AXUIElementGetTypeID() {
                    // A candidate for explicit selection, never a replacement for a bound reference.
                    let candidate = unsafeDowncast(main, to: AXUIElement.self)
                    try setTimeout(candidate, deadline: deadline)
                    let role = try read(candidate, kAXRoleAttribute, deadline: deadline)
                    guard role as? String == kAXWindowRole else {
                        throw WindowReadFailure("invalid_window_candidate")
                    }
                    return [candidate]
                }
            } catch let failure as WindowReadFailure {
                if !["no_value", "unsupported_attribute"].contains(failure.reason) { throw failure }
            }
        }
        // Missing inventory and main-window metadata do not prove all windows are closed.
        inventoryComplete = !result.isEmpty
        return result
    }

    func metadata(_ reference: AXUIElement, deadline: TimeInterval) throws -> WindowMetadata {
        try setTimeout(reference, deadline: deadline)
        var unavailable: [String: String] = [:]
        var title: String?
        var minimized: Bool?
        do {
            let value = try read(reference, kAXTitleAttribute, deadline: deadline)
            if let value = value as? String { title = value }
            else { unavailable["title"] = "invalid_value" }
        } catch let failure as WindowReadFailure {
            if failure.invalidatesWindow || failure.reason == "permission_required" { throw failure }
            unavailable["title"] = failure.reason
        }
        do {
            if let value = try read(reference, kAXMinimizedAttribute, deadline: deadline),
               CFGetTypeID(value) == CFBooleanGetTypeID() {
                minimized = CFBooleanGetValue(unsafeDowncast(value, to: CFBoolean.self))
            } else { unavailable["minimized"] = "invalid_value" }
        } catch let failure as WindowReadFailure {
            if failure.invalidatesWindow || failure.reason == "permission_required" { throw failure }
            unavailable["minimized"] = failure.reason
        }
        return WindowMetadata(title: title, minimized: minimized, unavailable: unavailable)
    }

    func same(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }

    private func checkDeadline(_ deadline: TimeInterval) throws {
        guard ProcessInfo.processInfo.systemUptime < deadline else {
            throw WindowReadFailure("time_budget_exhausted")
        }
    }

    private func setTimeout(_ element: AXUIElement, deadline: TimeInterval, application: Bool = false) throws {
        try checkDeadline(deadline)
        if !application {
            var owner: pid_t = 0
            let ownershipError = AXUIElementGetPid(element, &owner)
            if ownershipError != .success { throw failure(ownershipError, application: false) }
            guard owner == processID else {
                throw WindowReadFailure("window_owner_changed", invalidatesWindow: true)
            }
        }
        let error = AXUIElementSetMessagingTimeout(element, messagingTimeout)
        if error != .success { throw failure(error, application: application) }
    }

    private func read(_ element: AXUIElement, _ attribute: String, deadline: TimeInterval,
                      application: Bool = false) throws -> CFTypeRef? {
        try checkDeadline(deadline)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        if error != .success { throw failure(error, application: application) }
        return value
    }

    private func failure(_ error: AXError, application: Bool) -> WindowReadFailure {
        let reason: String
        switch error {
        case .apiDisabled: reason = "permission_required"
        case .invalidUIElement: reason = "invalid_element"
        case .cannotComplete: reason = "unavailable"
        case .attributeUnsupported: reason = "unsupported_attribute"
        case .noValue: reason = "no_value"
        case .notImplemented: reason = "not_implemented"
        default: reason = "ax_error_\(error.rawValue)"
        }
        return WindowReadFailure(reason,
                                 invalidatesApplication: application && error == .invalidUIElement,
                                 invalidatesWindow: !application && error == .invalidUIElement)
    }
}

private struct InputFrames {
    enum Frame { case data(Data), tooLong }
    private enum ReadFailure: Error { case unavailable }
    private var partial = Data()
    private var oversized = false
    private var pending: [Frame] = []

    mutating func next() throws -> Frame? {
        while pending.isEmpty {
            var chunk = [UInt8](repeating: 0, count: 4096)
            let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
            if count < 0 {
                if errno == EINTR { continue }
                throw ReadFailure.unavailable
            }
            guard count > 0 else {
                if oversized { oversized = false; return .tooLong }
                guard !partial.isEmpty else { return nil }
                let final = partial
                partial = Data()
                return .data(final)
            }
            for byte in chunk.prefix(count) {
                if byte == 10 {
                    pending.append(oversized ? .tooLong : .data(partial))
                    partial = Data()
                    oversized = false
                } else if !oversized {
                    if partial.count < 65536 { partial.append(byte) }
                    else { partial = Data(); oversized = true }
                }
            }
        }
        return pending.removeFirst()
    }
}

@main
@MainActor
struct WindowReaderCLI {
    static func write(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
            FileHandle.standardError.write(Data("Unable to encode window response.\n".utf8))
            exit(1)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }

    static func main() {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments == ["--help"] {
            write([
                "usage": "ccuh-window-reader [--session] --bundle-id <running-app-bundle-id> | --request-access",
                "modes": ["read_only_snapshot", "read_only_session"],
                "commands": ["list", "bind", "read", "unbind", "close"],
                "reads": ["window_title", "minimized"],
                "permissionsRequested": false,
            ])
            return
        }
        if arguments == ["--request-access"] {
            // Public option value; the legacy C global is imported as mutable in Swift 6.
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            let trusted = AXIsProcessTrustedWithOptions(options)
            write(["status": trusted ? "authorized" : "permission_required",
                   "promptRequested": true, "windowQueryPerformed": false])
            exit(trusted ? 0 : 1)
        }
        let persistent = arguments.first == "--session"
        let appArguments = persistent ? Array(arguments.dropFirst()) : arguments
        guard appArguments.count == 2, appArguments[0] == "--bundle-id",
              appArguments[1].utf8.count <= 255,
              appArguments[1].range(of: #"^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$"#,
                                    options: .regularExpression) != nil else {
            write(["status": "error", "reason": "invalid_arguments"])
            exit(64)
        }
        let access: NativeWindowAccess
        do { access = try NativeWindowAccess(bundleID: appArguments[1]) }
        catch let failure as WindowReadFailure {
            write(["status": "blocked", "reason": failure.reason, "targetBinding": "not_created"])
            exit(1)
        } catch {
            write(["status": "blocked", "reason": "application_unavailable", "targetBinding": "not_created"])
            exit(1)
        }
        let session = WindowSession(access: access)
        if !persistent {
            var result = session.handle(["command": "list"])
            result.removeValue(forKey: "sessionId")
            if let windows = result["windows"] as? [[String: Any]] {
                result["windows"] = windows.map { row in
                    var row = row
                    row.removeValue(forKey: "windowToken")
                    return row
                }
            }
            result["snapshotId"] = UUID().uuidString
            result["identityScope"] = "snapshot_only"
            result["targetBinding"] = "not_created"
            result["bundleId"] = access.bundleID
            result["processId"] = Int(access.processID)
            write(result)
            exit(["ok", "partial"].contains(result["status"] as? String ?? "") ? 0 : 1)
        }
        write(["status": "ready", "schemaVersion": 1, "mode": "read_only_session",
               "sessionId": session.sessionId, "bundleId": access.bundleID,
               "processId": Int(access.processID), "readOnly": true])
        // One parent owns this stdin session. EOF releases all retained references.
        var frames = InputFrames()
        do {
            while let frame = try frames.next() {
                guard case let .data(data) = frame,
                      let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    write(["status": "error", "reason": "invalid_request", "sessionId": session.sessionId])
                    continue
                }
                let result = session.handle(request)
                write(result)
                if result["sessionClosed"] as? Bool == true { return }
            }
        } catch {
            write(["status": "error", "reason": "input_unavailable", "sessionId": session.sessionId])
            exit(1)
        }
    }
}
