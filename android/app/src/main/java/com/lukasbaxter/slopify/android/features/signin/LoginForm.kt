package com.lukasbaxter.slopify.android.features.signin

import com.lukasbaxter.slopify.android.app.LocalAppModel
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.components.ErrorBanner
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlinx.coroutines.launch

/**
 * Sign-in form (web/src/App.jsx Login, phone CSS app.css:1394-1406). With an invite code it is
 * the sign-up form. No logo (removed on iOS).
 */
@Composable
internal fun LoginForm(model: SignInModel) {
    val theme = LocalTheme.current
    val s by model.state.collectAsStateWithLifecycle()
    val scope = LocalAppModel.current.scope // outlives this form (the stage change removes it)
    val focus = LocalFocusManager.current
    val userFocus = remember { FocusRequester() }
    val passwordFocus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { userFocus.requestFocus() } }

    val submit = {
        if (model.state.value.canLogIn) {
            focus.clearFocus()
            scope.launch { model.logIn() }
        }
        Unit
    }
    val invite = s.invite != null
    val title = when {
        invite -> if (s.busy) L("Creating account…") else L("Create account")
        else -> if (s.busy) L("Logging in…") else L("Log in")
    }

    LoginPage {
        // "Slopify" is the product name (web h1 is not translated).
        LoginHeading(title = "Slopify", subtitle = L("Your library, on any speaker in the house."))
        LoginLabeled(L("Username")) {
            LoginField(s.username, model::setUsername, SignInFieldKind.Username, ImeAction.Next, { passwordFocus.requestFocus() }, Modifier.focusRequester(userFocus))
        }
        LoginLabeled(L("Password")) {
            LoginField(
                s.password, model::setPassword,
                if (invite) SignInFieldKind.NewPassword else SignInFieldKind.Password,
                ImeAction.Go, submit, Modifier.focusRequester(passwordFocus),
            )
        }
        s.loginError?.let { ErrorBanner(it) }
        if (invite) {
            Text(
                L("You have been invited. Pick a username and a password (8 characters or more)."),
                style = TextStyles.marginal, color = theme.fgDim, modifier = Modifier.padding(top = 2.dp),
            )
        }
        LoginButton(title, enabled = s.canLogIn, onClick = submit)
        // Native only: the web phone page has no server field; the shell reached its server
        // screen from Settings. This is the way back before signing in.
        SignInTextLink(L("Server address"), enabled = !s.busy, modifier = Modifier.fillMaxWidth().wrapContentWidth()) { model.editServer() }
    }
}
