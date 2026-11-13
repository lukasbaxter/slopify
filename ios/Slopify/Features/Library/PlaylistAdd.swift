import Foundation

/// "Add to playlist" when some songs are already there (API.md 8.2): which are duplicates,
/// what the answers keep, and the toast. No UI here; `LibraryStore.add` drives it.
enum PlaylistAdd {
    /// One answer from the dialog. `forAll`: the same for every duplicate left.
    struct Answer: Equatable, Sendable {
        var add: Bool
        var forAll: Bool = false
    }

    /// A song is a duplicate when the playlist has it, or when it came earlier in this batch.
    static func duplicates(_ ids: [String], existing: Set<String>) -> [Bool] {
        var seen = existing
        return ids.map { id in !seen.insert(id).inserted }
    }

    /// Asks about each duplicate in turn (`ask(index, duplicatesLeft)`, this one included) until
    /// an answer is for all. Every other song is kept. Kept ids stay in the order given.
    static func resolve(_ ids: [String], duplicates dup: [Bool],
                        ask: (_ index: Int, _ left: Int) async -> Answer) async -> (kept: [String], skipped: Int) {
        var left = dup.filter { $0 }.count
        var all: Bool?
        var kept: [String] = []
        var skipped = 0
        for (i, id) in ids.enumerated() {
            guard dup[i] else { kept.append(id); continue }
            let add: Bool
            if let all { add = all } else {
                let a = await ask(i, left)
                add = a.add
                if a.forAll { all = a.add }
            }
            left -= 1
            if add { kept.append(id) } else { skipped += 1 }
        }
        return (kept, skipped)
    }

    static func toast(added: Int, skipped: Int, name: String) -> String {
        if skipped == 0 { return L("Added to {name}", ["name": name]) }
        if added == 0 { return L("Already in {name}", ["name": name]) }
        return L("Added {added} to {name}, skipped {skipped} already there", ["added": added, "name": name, "skipped": skipped])
    }
}
