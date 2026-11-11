package com.lukasbaxter.slopify.android.core.api

/** Every failure a REST call reports. `message` is what a toast shows (the server's text). */
sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** 401: signed out. */
    class Unauthorized : ApiError("unauthorized")
    /** 403 "password change required". */
    class PasswordChangeRequired : ApiError(PASSWORD_CHANGE)
    /** Any other non-2xx; `error` is the server's `error` text. */
    class Http(val status: Int, val error: String) : ApiError(error)
    /** No connection (or a timeout). */
    class Offline(cause: Throwable? = null) : ApiError("offline", cause)
    /** The server answered, but not in the shape we expect. */
    class Decoding(detail: String, cause: Throwable? = null) : ApiError(detail, cause)

    override fun equals(other: Any?): Boolean =
        other is ApiError && other::class == this::class && other.message == message && (other as? Http)?.status == (this as? Http)?.status
    override fun hashCode(): Int = (this::class.hashCode() * 31) + (message?.hashCode() ?: 0)

    companion object {
        const val PASSWORD_CHANGE = "password change required"
    }
}
