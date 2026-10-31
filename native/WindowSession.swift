import Foundation

struct WindowReadFailure: Error {
    let reason: String
    let invalidatesApplication: Bool
    let invalidatesWindow: Bool

    init(_ reason: String, invalidatesApplication: Bool = false, invalidatesWindow: Bool = false) {
        self.reason = reason
        self.invalidatesApplication = invalidatesApplication
        self.invalidatesWindow = invalidatesWindow
    }
}

struct WindowMetadata {
    let title: String?
    let minimized: Bool?
    let unavailable: [String: String]

    init(title: String?, minimized: Bool?, unavailable: [String: String] = [:]) {
        self.title = title
        self.minimized = minimized
        self.unavailable = unavailable
    }

    func json(index: Int?) -> [String: Any] {
        var row: [String: Any] = [
            "title": title as Any? ?? NSNull(),
            "minimized": minimized as Any? ?? NSNull(),
        ]
        if let index { row["snapshotIndex"] = index }
        if !unavailable.isEmpty { row["unavailable"] = unavailable }
        return row
    }
}

@MainActor
protocol WindowAccess {
    associatedtype Reference: AnyObject
    var inventoryComplete: Bool { get }
    func validateApplication(deadline: TimeInterval) throws
    func windows(deadline: TimeInterval) throws -> [Reference]
    func metadata(_ ref: Reference, deadline: TimeInterval) throws -> WindowMetadata
    func same(_ lhs: Reference, _ rhs: Reference) -> Bool
}

extension WindowAccess {
    var inventoryComplete: Bool { true }
}

@MainActor
final class WindowSession<Access: WindowAccess> {
    private struct IssuedWindow {
        let token: String
        let reference: Access.Reference
    }
    private struct Binding {
        let token: String
        let window: IssuedWindow
        let expectedTitle: String
    }
    private let access: Access
    private let budget: TimeInterval
    private let windowLimit: Int
    private let registryLimit = 1024
    private let now: () -> TimeInterval
    private var issued: [IssuedWindow] = []
    private var binding: Binding?
    private var invalidated: (token: String, reason: String)?
    private var applicationFailure: String?
    private var closed = false
    let sessionId = UUID().uuidString

    init(access: Access, budget: TimeInterval = 3, windowLimit: Int = 32,
         now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        precondition(budget.isFinite && budget > 0 && windowLimit > 0)
        self.access = access
        self.budget = budget
        self.windowLimit = windowLimit
        self.now = now
    }

    private var bindingState: String {
        binding != nil ? "bound" : invalidated != nil ? "invalidated" : "none"
    }

    private func response(_ status: String, _ reason: String? = nil,
                          _ fields: [String: Any] = [:]) -> [String: Any] {
        var result: [String: Any] = [
            "status": status, "reason": reason as Any? ?? NSNull(),
            "sessionId": sessionId, "bindingState": bindingState,
        ]
        if let binding {
            result["bindingToken"] = binding.token
            result["windowToken"] = binding.window.token
        } else if let invalidated { result["bindingToken"] = invalidated.token }
        result.merge(fields) { _, value in value }
        return result
    }

    private func invalidate(_ reason: String) {
        guard let binding else { return }
        invalidated = (binding.token, reason)
        issued.removeAll { $0.token == binding.window.token }
        self.binding = nil
    }

    private func fail(_ error: Error, reference: Access.Reference? = nil) -> [String: Any] {
        let failure = error as? WindowReadFailure ?? WindowReadFailure("read_failed")
        if failure.invalidatesApplication {
            applicationFailure = failure.reason
            invalidate(failure.reason)
            issued.removeAll()
        } else if failure.invalidatesWindow, let reference {
            if let binding, access.same(binding.window.reference, reference) { invalidate(failure.reason) }
            issued.removeAll { access.same($0.reference, reference) }
        }
        return response(invalidated == nil ? "blocked" : "invalidated", failure.reason)
    }

    private func checkDeadline(_ deadline: TimeInterval) throws {
        if now() >= deadline { throw WindowReadFailure("time_budget_exhausted") }
    }

    private func currentWindows(deadline: TimeInterval) throws -> [Access.Reference] {
        if let applicationFailure { throw WindowReadFailure(applicationFailure, invalidatesApplication: true) }
        try checkDeadline(deadline)
        try access.validateApplication(deadline: deadline)
        try checkDeadline(deadline)
        return try access.windows(deadline: deadline)
    }

    private func list(deadline: TimeInterval) -> [String: Any] {
        let references: [Access.Reference]
        do { references = try currentWindows(deadline: deadline) }
        catch { return fail(error) }
        let inventoryComplete = access.inventoryComplete
        if inventoryComplete, let binding, !references.contains(where: { access.same($0, binding.window.reference) }) {
            invalidate("target_not_listed")
        }
        // A partial inventory adds candidates; it cannot revoke unseen references.
        let previous = issued
        var next = inventoryComplete ? [] : previous
        var candidates: [IssuedWindow] = []
        for reference in references {
            let entry = previous.first(where: { access.same($0.reference, reference) })
                ?? next.first(where: { access.same($0.reference, reference) })
                ?? IssuedWindow(token: UUID().uuidString, reference: reference)
            if !next.contains(where: { $0.token == entry.token }) { next.append(entry) }
            guard next.count <= registryLimit else { return response("blocked", "window_registry_limit") }
            candidates.append(entry)
        }
        issued = next
        var rows: [[String: Any]] = []
        var incomplete = references.count > windowLimit
        var reason: String? = incomplete ? "window_limit" : nil
        for (index, entry) in candidates.prefix(windowLimit).enumerated() {
            if now() >= deadline { incomplete = true; reason = "time_budget_exhausted"; break }
            var metadata: WindowMetadata
            do { metadata = try access.metadata(entry.reference, deadline: deadline) }
            catch {
                let failure = error as? WindowReadFailure ?? WindowReadFailure("read_failed")
                if failure.invalidatesApplication { return fail(failure) }
                if failure.invalidatesWindow {
                    if let binding, access.same(binding.window.reference, entry.reference) { invalidate(failure.reason) }
                    issued.removeAll { access.same($0.reference, entry.reference) }
                }
                metadata = WindowMetadata(title: nil, minimized: nil, unavailable: ["window": failure.reason])
            }
            var row = metadata.json(index: index)
            row["windowToken"] = entry.token
            rows.append(row)
            if !metadata.unavailable.isEmpty {
                incomplete = true
                if metadata.unavailable.values.contains("time_budget_exhausted") { reason = "time_budget_exhausted" }
                else if reason == nil { reason = "incomplete_metadata" }
            }
        }
        var fields: [String: Any] = [
            "windows": rows,
            "inventoryComplete": inventoryComplete,
            "windowsTotal": inventoryComplete ? references.count as Any : NSNull(),
            "windowsObserved": references.count,
            "truncated": rows.count < references.count,
        ]
        if !inventoryComplete, let reason { fields["metadataReason"] = reason }
        return response(!inventoryComplete || incomplete ? "partial" : "ok",
                        inventoryComplete ? reason : "window_inventory_incomplete", fields)
    }

    private func bind(_ token: String, title: String, deadline: TimeInterval) -> [String: Any] {
        guard binding == nil, invalidated == nil else { return response("blocked", "binding_active") }
        guard let entry = issued.first(where: { $0.token == token }) else { return response("blocked", "unknown_window_token") }
        do {
            let references = try currentWindows(deadline: deadline)
            let inventoryComplete = access.inventoryComplete
            let index = references.firstIndex(where: { access.same($0, entry.reference) })
            if inventoryComplete && index == nil {
                issued.removeAll { $0.token == token }
                return response("blocked", "target_not_listed")
            }
            try checkDeadline(deadline)
            let metadata = try access.metadata(entry.reference, deadline: deadline)
            guard let observedTitle = metadata.title else { return response("blocked", "target_title_unavailable") }
            guard observedTitle.precomposedStringWithCanonicalMapping == title else { return response("blocked", "target_context_mismatch") }
            binding = Binding(token: UUID().uuidString, window: entry, expectedTitle: title)
            return response(inventoryComplete && metadata.unavailable.isEmpty ? "ok" : "partial",
                            inventoryComplete ? nil : "window_inventory_incomplete", [
                                "window": metadata.json(index: index), "inventoryComplete": inventoryComplete,
                            ])
        } catch { return fail(error, reference: entry.reference) }
    }

    private func read(_ token: String, deadline: TimeInterval) -> [String: Any] {
        if let invalidated {
            return response(token == invalidated.token ? "invalidated" : "blocked",
                            token == invalidated.token ? invalidated.reason : "binding_token_mismatch")
        }
        guard let binding else { return response("blocked", "not_bound") }
        guard token == binding.token else { return response("blocked", "binding_token_mismatch") }
        do {
            let references = try currentWindows(deadline: deadline)
            let inventoryComplete = access.inventoryComplete
            let index = references.firstIndex(where: { access.same($0, binding.window.reference) })
            if inventoryComplete && index == nil {
                invalidate("target_not_listed")
                return response("invalidated", "target_not_listed")
            }
            try checkDeadline(deadline)
            let metadata = try access.metadata(binding.window.reference, deadline: deadline)
            guard let title = metadata.title else { return response("blocked", "target_title_unavailable") }
            guard title.precomposedStringWithCanonicalMapping == binding.expectedTitle else {
                invalidate("target_context_changed")
                return response("invalidated", "target_context_changed")
            }
            return response(inventoryComplete && metadata.unavailable.isEmpty ? "ok" : "partial",
                            inventoryComplete ? nil : "window_inventory_incomplete", [
                                "window": metadata.json(index: index), "retainedReferenceUsed": true,
                                "inventoryComplete": inventoryComplete,
                            ])
        } catch { return fail(error, reference: binding.window.reference) }
    }

    func handle(_ request: [String: Any]) -> [String: Any] {
        let started = now()
        let result: [String: Any]
        if closed { result = response("blocked", "session_closed") }
        else if let command = request["command"] as? String {
            let fields = Set(request.keys)
            switch command {
            case "list" where fields == ["command"]:
                result = list(deadline: started + budget)
            case "bind" where fields == ["command", "windowToken", "expectedTitle"]:
                if let token = request["windowToken"] as? String, !token.isEmpty,
                   let title = request["expectedTitle"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                   title.utf8.count <= 1024 {
                    result = bind(token, title: title.precomposedStringWithCanonicalMapping, deadline: started + budget)
                } else { result = response("error", "invalid_arguments") }
            case "read" where fields == ["command", "bindingToken"]:
                if let token = request["bindingToken"] as? String, !token.isEmpty {
                    result = read(token, deadline: started + budget)
                } else { result = response("error", "invalid_arguments") }
            case "unbind" where fields == ["command", "bindingToken"]:
                if let token = request["bindingToken"] as? String,
                   token == binding?.token || token == invalidated?.token {
                    binding = nil; invalidated = nil
                    result = response("ok")
                } else { result = response("blocked", "binding_token_mismatch") }
            case "close" where fields == ["command"]:
                binding = nil; invalidated = nil; issued.removeAll(); closed = true
                result = response("ok", nil, ["sessionClosed": true])
            default: result = response("error", "invalid_command_or_arguments")
            }
        } else { result = response("error", "invalid_command_or_arguments") }
        var timed = result
        timed["elapsedMs"] = max(0, Int((now() - started) * 1000))
        return timed
    }
}
