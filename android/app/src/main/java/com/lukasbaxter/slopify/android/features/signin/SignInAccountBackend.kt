package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.core.api.ApiClient
import com.lukasbaxter.slopify.android.core.api.healthzOK
import com.lukasbaxter.slopify.android.core.auth.Account

/** The real backend: `Account` for sign-in state, throwaway `ApiClient`s for probes. */
internal class SignInAccountBackend(private val account: Account) : SignInBackend {
    override suspend fun probe(url: String, timeout: Double): Boolean =
        ApiClient(url, http = account.api.http).healthzOK(timeout)

    override suspend fun tryDemo(base: String): Boolean = account.tryDemo(base)

    override suspend fun signIn(base: String, main: String?, username: String, password: String) =
        account.signIn(base, main, username, password)

    /** Web Login: register, then the normal sign-in (so the token carries this device's name). */
    override suspend fun register(base: String, main: String?, invite: String, username: String, password: String) =
        account.register(base, main, invite, username, password)

    override suspend fun changePassword(new: String) = account.changePassword(null, new)

    override fun setHome(url: String) = account.setHome(url, off = false)
}
