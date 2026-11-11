package com.lukasbaxter.slopify.android.features.signin

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.core.util.Consumer
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.app.LocalAppModel
import com.lukasbaxter.slopify.android.core.auth.Account
import com.lukasbaxter.slopify.android.core.auth.AccountState
import com.lukasbaxter.slopify.android.core.storage.SharedPrefsStore
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.launch

/**
 * Everything before the shell (UI.md 2.12): server address, demo check, sign-in / invite
 * sign-up, and the forced first password (`Account.state == PasswordChange`).
 */
@Composable
fun SignInFlow() {
    val account = LocalAppModel.current.account
    val model = rememberSignInModel(account)
    val state by account.state.collectAsStateWithLifecycle()
    val user by account.user.collectAsStateWithLifecycle()
    val s by model.state.collectAsStateWithLifecycle()
    val theme = LocalTheme.current

    SignInInviteLinks(model)
    LaunchedEffect(model) { model.start() }
    BackHandler(enabled = state != AccountState.PasswordChange && s.stage == SignInStage.Server && s.canCancelServer && !s.probing) {
        model.cancelServerEdit()
    }

    Box(Modifier.fillMaxSize().background(theme.black)) {
        if (state == AccountState.PasswordChange) {
            ChangePasswordForm(model, user?.name)
        } else when (s.stage) {
            SignInStage.Server -> ServerAddressForm(model)
            SignInStage.Starting -> StartingView()
            SignInStage.Login -> LoginForm(model)
        }
    }
}

/** "Choose a new password" on its own (the flow shows it while `Account.state == PasswordChange`). */
@Composable
fun ChangePasswordView() {
    val account = LocalAppModel.current.account
    val model = rememberSignInModel(account)
    val user by account.user.collectAsStateWithLifecycle()
    Box(Modifier.fillMaxSize().background(LocalTheme.current.black)) { ChangePasswordForm(model, user?.name) }
}

@Composable
private fun rememberSignInModel(account: Account): SignInModel {
    val context = LocalContext.current
    // TODO(lead): expose AppModel's KeyValueStore; this opens the same "slopify" prefs file.
    return remember(account) { SignInModel(SignInAccountBackend(account), SharedPrefsStore(context.applicationContext)) }
}

/**
 * Invite links (`?invite=`) that opened the activity, or arrive while sign-in shows. The link is
 * consumed so it does not reapply after a sign-out.
 * TODO(lead): needs the VIEW intent-filter for the `slopify` scheme in the manifest (Requests).
 */
@Composable
private fun SignInInviteLinks(model: SignInModel) {
    val activity = LocalActivity.current as? ComponentActivity ?: return
    LaunchedEffect(model) {
        val url = activity.intent?.dataString ?: return@LaunchedEffect
        if (model.acceptInvite(url)) activity.intent = Intent(activity.intent).setData(null)
    }
    DisposableEffect(activity, model) {
        val listener = Consumer<Intent> { intent ->
            intent.dataString?.let { if (model.acceptInvite(it)) activity.intent = Intent(intent).setData(null) }
        }
        activity.addOnNewIntentListener(listener)
        onDispose { activity.removeOnNewIntentListener(listener) }
    }
}

/** Centred `Starting Slopify...` while the demo check runs (web `.boot`). */
@Composable
private fun StartingView() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Text(L("Starting Slopify..."), style = TextStyles.body, color = LocalTheme.current.fgDim)
    }
}

/**
 * "Choose a new password" (web/src/App.jsx ChangePassword): the sign-in page style, no logo.
 * Nothing else works until it is done (API.md 3.4).
 */
@Composable
private fun ChangePasswordForm(model: SignInModel, name: String?) {
    val s by model.state.collectAsStateWithLifecycle()
    val scope = LocalAppModel.current.scope // outlives this form (the stage change removes it)
    val focus = LocalFocusManager.current
    val newFocus = remember { FocusRequester() }
    val againFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { newFocus.requestFocus() } }

    val submit = {
        if (model.state.value.canSavePassword) {
            focus.clearFocus()
            scope.launch { model.savePassword() }
        }
        Unit
    }
    LoginPage {
        LoginHeading(
            title = L("Choose a new password"),
            subtitle = L("The default password only opens this page. Pick a new one for {name}.", "name" to (name?.takeIf { it.isNotEmpty() } ?: L("this account"))),
        )
        LoginLabeled(L("New password")) {
            LoginField(s.newPassword, model::setNewPassword, SignInFieldKind.NewPassword, ImeAction.Next, { againFocus.requestFocus() }, Modifier.focusRequester(newFocus))
        }
        LoginLabeled(L("Again")) {
            LoginField(s.again, model::setAgain, SignInFieldKind.NewPassword, ImeAction.Go, submit, Modifier.focusRequester(againFocus))
        }
        s.passwordError?.let { ErrorBanner(it) }
        LoginButton(if (s.saving) L("Saving…") else L("Save and continue"), enabled = s.canSavePassword, onClick = submit)
    }
}
