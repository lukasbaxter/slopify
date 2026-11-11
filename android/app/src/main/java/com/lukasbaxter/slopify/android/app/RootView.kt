package com.lukasbaxter.slopify.android.app

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.features.signin.SignInFlow

/** Signed in: the shell. Otherwise sign-in (password change included). */
@Composable
fun RootView() {
    val app = LocalAppModel.current
    val state by app.account.state.collectAsStateWithLifecycle()
    when (state) {
        AccountState.SignedIn -> MainShell()
        AccountState.SignedOut, AccountState.PasswordChange -> SignInFlow()
    }
}
