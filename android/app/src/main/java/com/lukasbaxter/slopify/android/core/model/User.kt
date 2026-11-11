package com.lukasbaxter.slopify.android.core.model

import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String,
    val name: String,
    val role: String,
    val mustChangePassword: Boolean? = null,
) {
    val isAdmin: Boolean get() = role == "admin" && !isGuest

    /** Demo guests are role admin but cannot change the server (API.md §3.7). */
    val isGuest: Boolean get() = name.startsWith("Guest ")
}

@Serializable
data class LoginResponse(val token: String, val user: User, val demo: Boolean? = null)

@Serializable
data class ServerAddresses(val key: String, val lan: String? = null, val public: List<String>? = null)

@Serializable
data class ServerInfo(val id: String, val name: String? = null, val version: String? = null)

@Serializable
data class DeviceToken(
    val id: String,
    val device: String,
    val kind: String,
    val created: Double,
    val lastSeen: Double? = null,
    val current: Boolean,
)
