package com.lukasbaxter.slopify.android.core.auth

import java.net.URI

/**
 * Typed server address handling (API.md §4.1), same rules as web/src/api/address.js.
 * Addresses are strings `scheme://host[:port][/path]`: lower-case scheme and host, no
 * default port, no trailing slash, no query or fragment.
 */
object Address {
    private val HOST = Regex("^[A-Za-z0-9.-]+$|^\\[[0-9A-Fa-f:.]+]$")

    /** Candidate URLs to try, best guess first. Empty when the input cannot be an address. */
    fun candidates(raw: String): List<String> {
        val s = raw.trim()
        if (s.isEmpty()) return emptyList()
        if ("://" in s) return listOfNotNull(normalise(s))
        val host = s.split('/').first()
        val bareHost = host.split(':').first()
        val http = isLocal(bareHost)
        val first = normalise((if (http) "http://" else "https://") + s)
        val second = normalise((if (http) "https://" else "http://") + s)
        return listOfNotNull(first, second)
    }

    fun normalise(s: String): String? {
        val u = runCatching { URI(s) }.getOrNull() ?: return null
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = u.host ?: return null
        if (host.isEmpty() || !HOST.matches(host)) return null
        if (host.startsWith(".") || host.startsWith("-") || host.endsWith(".") || host.endsWith("-")) return null
        val port = u.port.takeUnless { it == -1 || (scheme == "http" && it == 80) || (scheme == "https" && it == 443) }
        val path = (u.rawPath ?: "").trimEnd('/')
        return "$scheme://${host.lowercase()}${port?.let { ":$it" } ?: ""}$path"
    }

    /** Bare IPv4, *.local, or a one-word host: plain http by default. */
    fun isLocal(host: String): Boolean {
        val h = host.lowercase()
        if (h.endsWith(".local") || '.' !in h) return true
        val parts = h.split('.')
        return parts.size == 4 && parts.all { p -> p.toIntOrNull()?.let { it in 0..255 && p.all(Char::isDigit) } == true }
    }

    /** LAN-only addresses are pointless on cellular (§4.4 step 2). Tailscale 100.x is not LAN-only. */
    fun isLanOnly(url: String): Boolean {
        val h = host(url)?.lowercase() ?: return false
        if (h.endsWith(".local") || '.' !in h) return true
        val p = h.split('.').mapNotNull { it.toIntOrNull() }
        if (p.size != 4) return false
        return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168) || p[0] == 127 || (p[0] == 169 && p[1] == 254)
    }

    /** `scheme://host[:port]`. */
    fun origin(url: String): String {
        val u = runCatching { URI(url) }.getOrNull() ?: return url
        val port = if (u.port == -1) "" else ":${u.port}"
        return "${u.scheme}://${u.host}$port"
    }

    fun path(url: String): String = runCatching { URI(url).rawPath ?: "" }.getOrDefault("")

    fun host(url: String): String? = runCatching { URI(url).host }.getOrNull()
}
