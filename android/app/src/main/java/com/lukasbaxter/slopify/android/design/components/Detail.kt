package com.lukasbaxter.slopify.android.design.components

import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableIntState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.lukasbaxter.slopify.android.design.L
import com.lukasbaxter.slopify.android.design.icons.Icon
import com.lukasbaxter.slopify.android.design.icons.IconView
import com.lukasbaxter.slopify.android.design.theme.HeroIsland
import com.lukasbaxter.slopify.android.design.theme.LocalTheme
import com.lukasbaxter.slopify.android.design.theme.RGB
import com.lukasbaxter.slopify.android.design.theme.Radius
import com.lukasbaxter.slopify.android.design.theme.Shell
import com.lukasbaxter.slopify.android.design.theme.Spacing
import com.lukasbaxter.slopify.android.design.theme.TextStyles
import kotlin.math.max
import kotlin.math.min

/** Top bar variants of [DetailScaffold]. */
enum class DetailBarStyle {
    Standard,
    /** The back disc (black 50 %) until fully scrolled. */
    Artist,
    /** Never a bar or title. */
    Liked,
    /** Settings: bar `--bg-base` and title always on. */
    Solid,
    /** No bar. */
    Hidden,
}

/** The fade maths, pure for tests. */
object DetailScaffoldMath {
    /** `clamp((scrollTop - 40) / span, 0, 1)`, `span = max(120, heroHeight - 60)`, 160 without a hero. */
    fun progress(scrollTop: Float, heroHeight: Float?): Float {
        val span = heroHeight?.let { max(120f, it - 60) } ?: 160f
        return min(1f, max(0f, (scrollTop - 40) / span))
    }

    fun titleOpacity(p: Float): Float = min(1f, max(0f, p * 2 - 1))
}

/** Inside a [DetailScaffold]: the top inset (heroes pad by `56 + inset`). */
val LocalDetailTopInset = compositionLocalOf { 0.dp }
private val LocalHeroHeight = compositionLocalOf<MutableIntState?> { null }

/** Mark the page's hero so the top bar's fade span follows its height. */
@Composable
fun Modifier.reportsHeroHeight(): Modifier {
    val sink = LocalHeroHeight.current ?: return this
    return onSizeChanged { sink.intValue = it.height }
}

/** Bottom padding of root lists so the last row clears the mini player and tab bar. */
@Composable
fun shellContentPadding(): PaddingValues =
    PaddingValues(bottom = Shell.contentBottom + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding())

/**
 * Detail-page chrome (UI.md 2.6, 6.0.14; ios DetailScaffold.swift): a list under a floating top
 * bar whose colour and centred title fade in with scroll. Put a [HeroHeader] (or any item
 * marked [reportsHeroHeight]) first so the fade span follows the hero.
 *
 *     DetailScaffold(album.name, hero, onBack = nav::pop) {
 *         item { HeroHeader(hero, album.name, cover = { ... }) { ... } }
 *         item { ActionRow(hero, leading = { ... }) { ... } }
 *         items(tracks) { TrackRow(it, ...) }
 *     }
 *
 * Bar = `color-mix(hero 55%, page)` at `progress`; title at `2p - 1`. Back runs `onBack`, else
 * the system back (the shell's navigator).
 */
@Composable
fun DetailScaffold(
    title: String,
    modifier: Modifier = Modifier,
    heroColor: RGB? = null,
    barStyle: DetailBarStyle = DetailBarStyle.Standard,
    state: LazyListState = rememberLazyListState(),
    onBack: (() -> Unit)? = null,
    content: LazyListScope.() -> Unit,
) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val heroHeight = remember { mutableIntStateOf(0) }
    val sizes = remember { HashMap<Int, Int>() }
    val scrollTopPx by remember(state) {
        derivedStateOf {
            for (i in state.layoutInfo.visibleItemsInfo) sizes[i.index] = i.size
            val first = state.firstVisibleItemIndex
            (0 until first).sumOf { sizes[it] ?: 0 } + state.firstVisibleItemScrollOffset
        }
    }
    val hasHero = heroColor != null && heroHeight.intValue > 0
    val p = if (barStyle == DetailBarStyle.Solid) 1f else with(density) {
        DetailScaffoldMath.progress(scrollTopPx.toDp().value, if (hasHero) heroHeight.intValue.toDp().value else null)
    }
    val back = LocalOnBackPressedDispatcherOwner.current
    val goBack = onBack ?: { back?.onBackPressedDispatcher?.onBackPressed(); Unit }
    Box(modifier.fillMaxSize().background(theme.page)) {
        CompositionLocalProvider(LocalDetailTopInset provides topInset, LocalHeroHeight provides heroHeight) {
            LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = shellContentPadding()) {
                if (heroColor == null) item(key = "detail-top-space") { Spacer(Modifier.height(Shell.topBar + topInset)) }
                content()
            }
        }
        if (barStyle != DetailBarStyle.Hidden) {
            val bar: @Composable () -> Unit = { DetailTopBar(title, heroColor, barStyle, p, topInset, goBack) }
            if (hasHero) HeroIsland(bar) else bar()
        }
    }
}

@Composable
private fun DetailTopBar(title: String, heroColor: RGB?, barStyle: DetailBarStyle, p: Float, topInset: Dp, onBack: () -> Unit) {
    val theme = LocalTheme.current
    val barColor = when {
        barStyle == DetailBarStyle.Solid -> theme.bgBase
        heroColor != null -> heroColor.colorMix(0.55, theme.rgb.page).color
        else -> theme.page
    }
    val showBar = barStyle != DetailBarStyle.Liked
    val disc by animateFloatAsState(if (barStyle == DetailBarStyle.Artist && p < 1f) 0.5f else 0f, tween(150), label = "disc")
    Box(Modifier.fillMaxWidth().height(Shell.topBar + topInset)) {
        if (showBar) Box(Modifier.matchParentSize().alpha(p).background(barColor))
        Row(Modifier.fillMaxWidth().padding(top = topInset).height(Shell.topBar), verticalAlignment = Alignment.CenterVertically) {
            val label = L("Go back")
            Box(
                Modifier.padding(start = Spacing.gutter - 8.dp).size(48.dp, Shell.topBar)
                    .pressable(PressFeedback.Fade, onTap = onBack).semantics { contentDescription = label },
                contentAlignment = Alignment.Center,
            ) {
                Box(Modifier.size(32.dp).background(Color.Black.copy(alpha = disc), CircleShape), contentAlignment = Alignment.Center) {
                    IconView(Icon.BackChevron, size = 18.dp, tint = theme.fg)
                }
            }
            Text(
                title, style = TextStyles.barTitle, color = theme.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f).alpha(if (!showBar) 0f else if (barStyle == DetailBarStyle.Solid) 1f else DetailScaffoldMath.titleOpacity(p)),
            )
            Spacer(Modifier.width(48.dp + Spacing.gutter - 8.dp))
        }
    }
}

/**
 * Album / playlist / Liked / mix header (UI.md 6.3.2; ios HeroHeader.swift): `--hero`
 * background with a `rgba(page,0) -> rgba(18,18,18,.3)` wash, padding `56 + inset` 16 4, centred
 * cover 250 (220 at <= 380 wide, capped at width - 64) radius 4 with a deep shadow, then the
 * 24/700 title (skeleton while null) and a meta column (13 `--fg-sub`, gap 6). Dark tokens on
 * light themes.
 */
@Composable
fun HeroHeader(
    color: RGB,
    title: String?,
    modifier: Modifier = Modifier,
    /** Liked Songs uses a 180 cover. */
    coverSize: Dp? = null,
    onTitleTap: (() -> Unit)? = null,
    cover: @Composable () -> Unit,
    meta: @Composable ColumnScope.() -> Unit,
) {
    val topInset = LocalDetailTopInset.current
    HeroIsland {
        val theme = LocalTheme.current
        BoxWithConstraints(
            modifier.fillMaxWidth().reportsHeroHeight()
                .background(color.color)
                .background(Brush.verticalGradient(listOf(theme.page(0.0), com.lukasbaxter.slopify.android.design.theme.Theme.Fixed.heroWash))),
        ) {
            val side = coverSize ?: heroCoverSide(maxWidth)
            Column(Modifier.fillMaxWidth().padding(top = Shell.topBar + topInset, start = Spacing.gutter, end = Spacing.gutter, bottom = 4.dp)) {
                Box(Modifier.fillMaxWidth().padding(bottom = 16.dp), contentAlignment = Alignment.Center) {
                    Box(
                        Modifier.size(side)
                            .shadow(18.dp, RoundedCornerShape(Radius.art), ambientColor = Color.Black, spotColor = Color.Black)
                            .clip(RoundedCornerShape(Radius.art)),
                    ) { cover() }
                }
                Box(Modifier.padding(bottom = 6.dp)) {
                    if (title != null) {
                        Text(title, style = TextStyles.pageTitle, color = Color.White,
                            modifier = if (onTitleTap != null) Modifier.pressable(PressFeedback.None, onTap = onTitleTap) else Modifier)
                    } else SkeletonTitle()
                }
                CompositionLocalProvider(LocalTextStyle provides TextStyle(fontSize = 13.sp), LocalContentColor provides theme.fgSub) {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp), content = meta)
                }
            }
        }
    }
}

/** 250, 220 on narrow screens, never wider than `width - 64`. */
fun heroCoverSide(width: Dp): Dp = minOf(if (width <= 380.dp) 220.dp else 250.dp, width - 64.dp)

/** The owner line in a hero (`.hero-owner`): 20 avatar + bold white 13 name. */
@Composable
fun HeroOwner(name: String, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, avatar: @Composable () -> Unit) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(20.dp).clip(CircleShape)) { avatar() }
        Text(name, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = Color.White,
            modifier = if (onClick != null) Modifier.pressable(PressFeedback.None, onTap = onClick) else Modifier)
    }
}

/**
 * The colour band and action row under a hero (UI.md 6.3.3; ios ActionRow): the band starts at
 * the row's top and runs 230 below it, `color-mix(hero 70%, page) -> page` (artist pages 80 %),
 * behind the first rows. Row: padding 8/16 (12 trailing), min height 64, gap 4; leading group,
 * then the trailing group pushed right (shuffle, then play).
 */
@Composable
fun ActionRow(
    heroColor: RGB,
    modifier: Modifier = Modifier,
    artist: Boolean = false,
    leading: @Composable RowScope.() -> Unit,
    trailing: @Composable RowScope.() -> Unit,
) {
    val theme = LocalTheme.current
    val top = heroColor.colorMix(if (artist) 0.8 else 0.7, theme.rgb.page).color
    val page = theme.page
    Row(
        modifier.fillMaxWidth()
            .drawBehind {
                val h = size.height + 230.dp.toPx()
                drawRect(Brush.verticalGradient(listOf(top, page), startY = 0f, endY = h), size = Size(size.width, h))
            }
            .heightIn(min = 64.dp)
            .padding(vertical = 8.dp)
            .padding(start = Spacing.gutter, end = Spacing.gutter - 4.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.weight(1f))
        trailing()
    }
}
