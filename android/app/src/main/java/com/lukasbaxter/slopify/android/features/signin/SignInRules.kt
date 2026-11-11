package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.core.api.ApiError
import com.lukasbaxter.slopify.android.core.auth.Address
import com.lukasbaxter.slopify.android.design.L
import java.net.URI
import java.net.URLDecoder

/** An invite link: the server it came from and the code. */
internal data class SignInInvite(val base: String, val code: String)

/** Pure rules of the sign-in flow (validation, messages, invite links). No UI, no network. */
internal object SignInRules {
    /** What the server form found wrong (mobile/App.js ServerForm.submit), null when it may probe. */
    fun serverFormError(main: String, home: String): String? {
        val m = main.trim()
        if (m.isEmpty()) return L("Enter the address of your Slopify server.")
        if (Address.candidates(m).isEmpty()) return L("That server address doesn’t look right. Try something like music.example.com.")
        val h = home.trim()
        if (h.isNotEmpty() && Address.candidates(h).isEmpty()) return L("That home address doesn’t look right. Try something like 192.168.1.10:8080.")
        return null
    }

    fun noServerMessage(typed: String): String {
        val host = Address.candidates(typed).firstOrNull()?.let(::hostLabel) ?: typed
        return L("No Slopify server answered at {host}. Check the address, and that the phone can reach it.", "host" to host)
    }

    /** `hostLabel` in web/src/api/address.js: no scheme, no path. */
    fun hostLabel(url: String): String {
        val s = url.substringAfter("://", url)
        return s.substringBefore('/')
    }

    /** ChangePassword.submit in web/src/App.jsx. */
    fun newPasswordError(pw: String, again: String): String? {
        if (pw.length < 8) return L("Use 8 characters or more.")
        if (pw != again) return L("The two passwords differ.")
        return null
    }

    /** The text the web shows for a failed call (`${status}: ${error}`, or "You’re offline"). */
    fun message(error: Throwable): String = when (error) {
        is ApiError.Offline -> L("You’re offline")
        is ApiError.Http -> if (error.error.isEmpty()) "${error.status}" else "${error.status}: ${error.error.take(180)}"
        is ApiError.Unauthorized -> "401: unauthorized"
        is ApiError.PasswordChangeRequired -> "403: ${ApiError.PASSWORD_CHANGE}"
        else -> error.message ?: error.toString()
    }

    /**
     * An invite link (`<base>/?invite=<code>`). `slopify://host[:port]/?invite=` (the app's own
     * scheme, for links that should open the app) picks http or https by the address rules.
     */
    fun invite(url: String): SignInInvite? {
        val u = runCatching { URI(url.trim()) }.getOrNull() ?: return null
        val code = u.rawQuery?.split('&')
            ?.firstOrNull { it.substringBefore('=') == "invite" }
            ?.substringAfter('=', "")
            ?.let { runCatching { URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            ?.takeIf { it.isNotEmpty() } ?: return null
        val host = u.host ?: return null
        val hostPort = host + if (u.port == -1) "" else ":${u.port}"
        val base = when (u.scheme?.lowercase()) {
            "http", "https" -> Address.normalise("${u.scheme}://$hostPort")
            SCHEME -> Address.candidates(hostPort).firstOrNull()
            else -> null
        } ?: return null
        return SignInInvite(base, code)
    }

    /** The app's own link scheme (see Requests: manifest intent-filter). */
    const val SCHEME = "slopify"
}
