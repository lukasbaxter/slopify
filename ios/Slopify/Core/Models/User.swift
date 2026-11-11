import Foundation

struct User: Codable, Hashable, Sendable {
    var id: String
    var name: String
    var role: String
    var mustChangePassword: Bool?

    var isAdmin: Bool { role == "admin" && !isGuest }
    /// Demo guests are role admin but cannot change the server (API.md §3.7).
    var isGuest: Bool { name.hasPrefix("Guest ") }
}

struct LoginResponse: Codable, Sendable {
    var token: String
    var user: User
    var demo: Bool?
}

struct ServerAddresses: Codable, Sendable {
    var key: String
    var lan: String?
    var `public`: [String]?
}

struct ServerInfo: Codable, Sendable {
    var id: String
    var name: String?
    var version: String?
}

struct DeviceToken: Codable, Hashable, Identifiable, Sendable {
    var id: String
    var device: String
    var kind: String
    var created: Double
    var lastSeen: Double?
    var current: Bool
}
