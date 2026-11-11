import Foundation

enum APIError: Error, LocalizedError, Equatable {
    case unauthorized              // 401: signed out
    case passwordChangeRequired    // 403 "password change required"
    case http(Int, String)         // other status, server's `error` text
    case offline                   // no connection
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "unauthorized"
        case .passwordChangeRequired: return "password change required"
        case .http(_, let m): return m
        case .offline: return "offline"
        case .decoding(let m): return m
        }
    }
}
