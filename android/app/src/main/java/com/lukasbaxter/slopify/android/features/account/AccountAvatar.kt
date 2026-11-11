package com.lukasbaxter.slopify.android.features.account

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import com.lukasbaxter.slopify.android.design.image.CoverImage
import com.lukasbaxter.slopify.android.design.image.CoverPlaceholder
import com.lukasbaxter.slopify.android.design.image.CoverShape
import com.lukasbaxter.slopify.android.design.image.CoverSource
import com.lukasbaxter.slopify.android.design.image.AvatarVersion
import com.lukasbaxter.slopify.android.design.image.LocalApiClient


/**
 * A round user picture over its initial: the initial shows through while loading, on a 404 or
 * a failed load. The picture fills the circle (DECISIONS: no zoom).
 */
@Composable
internal fun AccountAvatar(
    userId: String?,
    name: String?,
    size: Dp,
    background: Color,
    initialSize: TextUnit,
    initialColor: Color,
    modifier: Modifier = Modifier,
    initialWeight: FontWeight = FontWeight.Bold,
) {
    val api = LocalApiClient.current
    val bust = AvatarVersion.bust
    val url = if (api == null || userId == null) null
        else if (bust != null) api.url("api/users/$userId/avatar", mapOf("v" to bust.toString())).toString()
        else api.avatarUrl(userId).toString()
    Box(modifier.size(size).clip(CircleShape).background(background).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
        Text(AccountProfileLogic.initial(name), fontSize = initialSize, fontWeight = initialWeight, color = initialColor)
        CoverImage(CoverSource.Url(url), size, Modifier.fillMaxSize(), shape = CoverShape.Circle, placeholder = CoverPlaceholder.None)
    }
}
